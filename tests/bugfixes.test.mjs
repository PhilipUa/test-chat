import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  freshConversation,
  get,
  instanceFingerprints,
  post,
  seedMessages,
  sleep,
  unique,
  waitForApi,
  wsClient,
} from './helpers.mjs';

/** Regression tests for the bugs in docs/01-investigation.md. Each test names its finding. */

before(async () => {
  await waitForApi();
});

describe('finding A — a failing request must not kill the process', () => {
  it('returns 400 for duplicate participant ids instead of crashing', async () => {
    // This exact request used to trip ER_DUP_ENTRY inside an async handler with no error
    // handling, which became an unhandledRejection and terminated Node.
    const before = await instanceFingerprints();
    assert.ok(before.size > 0, 'expected at least one healthy instance');

    const res = await post('/api/conversations', {
      title: unique('dup'),
      participantIds: [1, 1, 2],
    });
    // Duplicates are now collapsed by the validator, so this is a valid request.
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.participantIds, [1, 2]);

    // Nothing restarted. Comparing instance ids alone would be wrong behind a round-robin
    // proxy — a different id just means a different replica answered — so compare each
    // instance's start time instead.
    const after = await instanceFingerprints();
    for (const [instanceId, startedAt] of before) {
      assert.equal(
        after.get(instanceId),
        startedAt,
        `instance ${instanceId} restarted — the request killed the process`,
      );
    }
  });

  it('rejects unknown participants with 400, and leaves no half-created conversation', async () => {
    const title = unique('orphan');
    const res = await post('/api/conversations', { title, participantIds: [1, 999999] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /unknown participant/i);

    // The conversation insert was rolled back, so user 1 has no conversation with this title.
    const list = await get('/api/conversations?userId=1');
    assert.equal(list.body.some((c) => c.title === title), false);
  });

  it('returns 400 for malformed JSON rather than dropping the connection', async () => {
    const res = await fetch(process.env.RELAY_URL || 'http://localhost:3000' + '/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"conversationId": ',
    });
    assert.equal(res.status, 400);
  });

  it('reports client errors from the body parser with their own status', async () => {
    const base = process.env.RELAY_URL || 'http://localhost:3000';
    // A body over the parser limit carries status 413. Before the error handler honoured that,
    // it fell through to the generic branch and came back as a 500 — which tells the caller
    // nothing about what to change.
    const tooLarge = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 1, senderId: 1, body: 'a'.repeat(5_000_000) }),
    });
    assert.equal(tooLarge.status, 413);

    // A body within the parser limit but over the message length limit is our own 400.
    const conv = await freshConversation();
    const tooLong = await post('/api/messages', {
      conversationId: conv.id, senderId: 1, body: 'a'.repeat(10_000),
    });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error, /at most/);
  });

  it('returns 404 JSON for an unknown API route', async () => {
    const res = await get('/api/nope');
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });
});

describe('finding D — sends are idempotent on clientId', () => {
  it('a replayed send returns the original message, not a duplicate', async () => {
    const conv = await freshConversation();
    const clientId = unique('idem');
    const payload = { conversationId: conv.id, senderId: 1, body: 'only once', clientId };

    const first = await post('/api/messages', payload);
    const second = await post('/api/messages', payload);

    assert.equal(first.status, 201);
    assert.equal(second.status, 200, 'a deduplicated send should report 200, not 201');
    assert.equal(second.body.id, first.body.id, 'both calls must resolve to the same message');

    const page = await get(`/api/messages?conversationId=${conv.id}`);
    const matching = page.body.messages.filter((m) => m.clientId === clientId);
    assert.equal(matching.length, 1, 'exactly one row should exist for a given clientId');
  });

  it('concurrent identical sends collapse to one message', async () => {
    const conv = await freshConversation();
    const clientId = unique('race');
    const payload = { conversationId: conv.id, senderId: 1, body: 'racing', clientId };

    // Fired together, so they race on the unique index rather than hitting the pre-check.
    const results = await Promise.all([
      post('/api/messages', payload),
      post('/api/messages', payload),
      post('/api/messages', payload),
    ]);

    const ids = new Set(results.map((r) => r.body.id));
    assert.equal(ids.size, 1, `expected one message id, got ${[...ids].join(', ')}`);

    const page = await get(`/api/messages?conversationId=${conv.id}`);
    assert.equal(page.body.messages.filter((m) => m.clientId === clientId).length, 1);
  });

  it('messages without a clientId are still allowed to repeat', async () => {
    const conv = await freshConversation();
    await post('/api/messages', { conversationId: conv.id, senderId: 1, body: 'same text' });
    await post('/api/messages', { conversationId: conv.id, senderId: 1, body: 'same text' });
    const page = await get(`/api/messages?conversationId=${conv.id}`);
    assert.equal(page.body.messages.length, 2, 'NULL client_id must not collide in the unique index');
  });
});

describe('finding E — authorization', () => {
  it('refuses a send into a conversation the sender is not part of', async () => {
    const conv = await freshConversation([1, 2]);
    const res = await post('/api/messages', { conversationId: conv.id, senderId: 3, body: 'gatecrash' });
    assert.equal(res.status, 403);
  });

  it('refuses a send to a conversation that does not exist', async () => {
    const res = await post('/api/messages', { conversationId: 999999, senderId: 1, body: 'orphan' });
    assert.equal(res.status, 404);
  });

  it('will not subscribe a socket to a conversation the user is not in', async () => {
    const conv = await freshConversation([1, 2]);
    // Carol (3) asks for a conversation she isn't in.
    const carol = await wsClient(3, [conv.id]);
    try {
      const ack = await carol.waitFor((e) => e.type === 'subscribed');
      assert.ok(ack, 'expected a subscribe acknowledgement');
      assert.equal(
        ack.conversationIds.includes(conv.id),
        false,
        'server must filter out conversations the user is not a participant in',
      );

      await post('/api/messages', {
        conversationId: conv.id,
        senderId: 1,
        body: 'private',
        clientId: unique('private'),
      });
      const leaked = await carol.waitFor(
        (e) => e.type === 'message' && e.body === 'private',
        1_500,
      );
      assert.equal(leaked, undefined, 'a non-participant must not receive the message');
    } finally {
      await carol.close();
    }
  });
});

describe('finding I/M — message shape and consistency', () => {
  it('POST and GET agree on createdAt to the millisecond', async () => {
    const conv = await freshConversation();
    const created = await post('/api/messages', {
      conversationId: conv.id,
      senderId: 1,
      body: 'timestamp check',
      clientId: unique('ts'),
    });
    const page = await get(`/api/messages?conversationId=${conv.id}`);
    const fetched = page.body.messages.find((m) => m.id === created.body.id);
    assert.equal(fetched.createdAt, created.body.createdAt);
  });

  it('every stored message has its body (no bodyless rows)', async () => {
    const conv = await freshConversation();
    for (let i = 0; i < 3; i++) {
      await post('/api/messages', {
        conversationId: conv.id,
        senderId: 1,
        body: `body ${i}`,
        clientId: unique('body'),
      });
    }
    const page = await get(`/api/messages?conversationId=${conv.id}`);
    assert.equal(page.body.messages.length, 3);
    for (const m of page.body.messages) {
      assert.notEqual(m.body, '', `message ${m.id} came back with an empty body`);
    }
  });
});

describe('finding J — pagination', () => {
  it('returns the newest page and walks backwards with the cursor', async () => {
    // All three users participate so seedMessages can spread the sends and stay under the
    // per-user rate limit.
    const conv = await freshConversation([1, 2, 3]);
    const total = 12;
    await seedMessages(conv.id, total);

    const firstPage = await get(`/api/messages?conversationId=${conv.id}&limit=5`);
    assert.equal(firstPage.body.messages.length, 5);
    assert.equal(firstPage.body.hasMore, true);
    // Newest page, returned oldest-to-newest for rendering.
    assert.equal(firstPage.body.messages.at(-1).body, `page-msg-${total - 1}`);
    assert.equal(firstPage.body.messages[0].body, `page-msg-${total - 5}`);

    const older = await get(
      `/api/messages?conversationId=${conv.id}&limit=5&before=${firstPage.body.nextBefore}`,
    );
    assert.equal(older.body.messages.length, 5);
    assert.equal(older.body.messages.at(-1).body, `page-msg-${total - 6}`);

    // Pages must not overlap.
    const firstIds = new Set(firstPage.body.messages.map((m) => m.id));
    assert.equal(older.body.messages.some((m) => firstIds.has(m.id)), false);
  });

  it('caps an oversized limit rather than dumping the conversation', async () => {
    const conv = await freshConversation();
    const res = await get(`/api/messages?conversationId=${conv.id}&limit=99999`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.messages));
  });
});

describe('input validation', () => {
  it('rejects bad ids and empty bodies with 400', async () => {
    const conv = await freshConversation();
    const cases = [
      ['missing body', { conversationId: conv.id, senderId: 1 }],
      ['empty body', { conversationId: conv.id, senderId: 1, body: '   ' }],
      ['non-numeric conversationId', { conversationId: 'abc', senderId: 1, body: 'x' }],
      ['negative senderId', { conversationId: conv.id, senderId: -1, body: 'x' }],
      ['oversized clientId', { conversationId: conv.id, senderId: 1, body: 'x', clientId: 'c'.repeat(200) }],
    ];
    for (const [name, payload] of cases) {
      const res = await post('/api/messages', payload);
      assert.equal(res.status, 400, `${name} should be a 400, got ${res.status}`);
    }
  });

  it('requires userId on the conversation list', async () => {
    assert.equal((await get('/api/conversations')).status, 400);
  });
});
