import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE,
  conversationsOf,
  freshConversation,
  get,
  post,
  presenceOf,
  seedMessages,
  sleep,
  unique,
  waitForApi,
  waitUntilOffline,
  wsClient,
} from './helpers.mjs';

/**
 * Regressions for the code-review findings.
 *
 * Each test here failed before its fix. They are grouped by the finding they pin down rather than by
 * subsystem, so a failure points straight at what regressed.
 */

before(async () => {
  await waitForApi();
});

/** Polls until `userId` reads as offline, for the short window a correct server needs. */
async function offlineWithin(viewerId, conversationId, userId, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const participant = await presenceOf(viewerId, conversationId, userId);
    if (participant && !participant.online) return true;
    await sleep(250);
  }
  return false;
}

async function onlineWithin(viewerId, conversationId, userId, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const participant = await presenceOf(viewerId, conversationId, userId);
    if (participant?.online) return true;
    await sleep(250);
  }
  return false;
}

describe('a socket that closes while its subscribe is in flight', () => {
  it('does not leave the user registered as online', async () => {
    // handleSubscribe awaits the participant query, so the close event can land first. It then went
    // on to register presence for a connection that no longer existed — and because the disconnect
    // had already run, nothing ever deregistered it. The user stayed online for the full 90s TTL.
    const conv = await freshConversation([1, 5]);
    assert.ok(await waitUntilOffline(1, conv.id, 5), 'user 5 should start offline');

    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws open timeout')), 10_000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    ws.send(JSON.stringify({ type: 'subscribe', userId: 5, conversationIds: [conv.id] }));
    // Close straight away: the server is still inside the participant query.
    ws.close();

    assert.ok(
      await offlineWithin(1, conv.id, 5),
      'user 5 is online through a connection that no longer exists',
    );
  });
});

describe('switching identity on a live socket', () => {
  it('marks the user you stopped being offline', async () => {
    // The UI re-subscribes on the same socket when you change demo user. handleSubscribe overwrote
    // client.userId without deregistering the old one, so the previous identity stayed online with
    // no offline event until the TTL expired.
    const asFive = await freshConversation([1, 5]);
    const asFour = await freshConversation([1, 4]);
    assert.ok(await waitUntilOffline(1, asFive.id, 5), 'user 5 should start offline');

    const client = await wsClient(5, [asFive.id]);
    assert.ok(await onlineWithin(1, asFive.id, 5), 'user 5 should be online after subscribing');

    client.send({ type: 'subscribe', userId: 4, conversationIds: [asFour.id] });
    const ack = await client.waitFor(
      (e) => e.type === 'subscribed' && e.conversationIds.includes(asFour.id),
    );
    assert.ok(ack, 'the socket should be resubscribed as user 4');

    assert.ok(
      await offlineWithin(1, asFive.id, 5),
      'user 5 is still online after the socket became user 4',
    );

    await client.close();
  });
});

describe('GET /api/messages authorization', () => {
  it('requires userId, so the membership check cannot be skipped by omitting it', async () => {
    // `optionalActor` made the check opt-in: naming a user you are not got 403, naming nobody got
    // the whole history. The original endpoint never accepted userId at all, so there was no client
    // to stay compatible with.
    const conv = await freshConversation([1, 2]);
    await seedMessages(conv.id, 1, [1]);

    const res = await get(`/api/messages?conversationId=${conv.id}`);

    assert.equal(res.status, 400);
  });

  it('still refuses a user who is not a participant', async () => {
    const conv = await freshConversation([1, 2]);

    const res = await get(`/api/messages?conversationId=${conv.id}&userId=4`);

    assert.equal(res.status, 403);
  });

  it('still serves a participant', async () => {
    const conv = await freshConversation([1, 2]);

    const res = await get(`/api/messages?conversationId=${conv.id}&userId=1`);

    assert.equal(res.status, 200);
  });
});

describe('message paging cursor', () => {
  it('reports no older page rather than a cursor pointing at nothing', async () => {
    // nextBefore was the oldest id on the page even when that page was the start of history, which
    // contradicts its own "null when at the start" contract.
    const conv = await freshConversation([1, 2]);
    await seedMessages(conv.id, 3, [1, 2]);

    const res = await get(`/api/messages?conversationId=${conv.id}&userId=1&limit=50`);

    assert.equal(res.status, 200);
    assert.equal(res.body.hasMore, false);
    assert.equal(res.body.nextBefore, null);
  });

  it('still hands back a usable cursor while there is more history', async () => {
    const conv = await freshConversation([1, 2]);
    await seedMessages(conv.id, 6, [1, 2]);

    const first = await get(`/api/messages?conversationId=${conv.id}&userId=1&limit=3`);

    assert.equal(first.body.hasMore, true);
    assert.equal(typeof first.body.nextBefore, 'number');

    const older = await get(
      `/api/messages?conversationId=${conv.id}&userId=1&limit=3&before=${first.body.nextBefore}`,
    );
    assert.equal(older.status, 200);
    assert.equal(older.body.messages.length, 3);
  });
});

describe('conversation list paging', () => {
  it('bounds the page and says whether there is more', async () => {
    // The inbox was unbounded, and catchUp() refetches it on every reconnect: 878 conversations and
    // two correlated subqueries each, on a path that runs whenever realtime blips.
    await freshConversation([1, 2]);
    await freshConversation([1, 2]);

    const res = await get('/api/conversations?userId=1&limit=1');

    assert.equal(res.status, 200);
    assert.equal(res.body.conversations.length, 1);
    assert.equal(res.body.hasMore, true);
    assert.equal(typeof res.body.nextCursor, 'string');
  });

  it('walks pages without repeating or skipping a conversation', async () => {
    await freshConversation([1, 2]);
    await freshConversation([1, 2]);
    await freshConversation([1, 2]);

    const seen = [];
    let cursor = null;
    for (let page = 0; page < 4; page++) {
      const query = `/api/conversations?userId=1&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await get(query);
      assert.equal(res.status, 200);
      seen.push(...res.body.conversations.map((c) => c.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }

    assert.equal(new Set(seen).size, seen.length, `a conversation appeared twice: ${seen}`);
    assert.ok(seen.length >= 3);
  });

  it('rejects a malformed cursor rather than ignoring it', async () => {
    const res = await get('/api/conversations?userId=1&cursor=not-a-cursor');

    assert.equal(res.status, 400);
  });
});

describe('conversation create validation', () => {
  it('rejects a malformed body without charging the create quota', async () => {
    // rate-limit.ts documents the ordering — charge quota only after validation and authorization —
    // and the messages route honours it. Here the limiter ran first, so a client looping malformed
    // creates burned its own allowance and got 429s instead of the 400 explaining the mistake.
    // User 3 is the suite's reserved victim for limit tests.
    const attempts = 70;
    const statuses = new Set();
    for (let i = 0; i < attempts; i++) {
      const res = await post('/api/conversations', { title: '   ', participantIds: [3, 1] });
      statuses.add(res.status);
    }

    assert.deepEqual([...statuses], [400], `expected only 400s, saw ${[...statuses]}`);
  });

  it('still enforces the quota on well-formed creates', async () => {
    // The guard above must not have turned the limiter off.
    const res = await post('/api/conversations', {
      title: unique('quota-check'),
      participantIds: [3, 1],
    });
    assert.ok([201, 429].includes(res.status), `unexpected status ${res.status}`);
  });
});

describe('presence announce to many conversations', () => {
  it('reaches every conversation the user is in', async () => {
    // announcePresence is now one pipelined publish instead of a round trip per conversation; every
    // conversation must still be told.
    const first = await freshConversation([1, 5]);
    const second = await freshConversation([1, 5]);
    assert.ok(await waitUntilOffline(1, first.id, 5), 'user 5 should start offline');

    const watcher = await wsClient(1, [first.id, second.id]);
    const joiner = await wsClient(5, [first.id, second.id]);

    const announced = new Set();
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline && announced.size < 2) {
      for (const e of watcher.events) {
        if (e.type === 'presence' && e.userId === 5 && e.online) announced.add(e.conversationId);
      }
      if (announced.size < 2) await sleep(100);
    }

    assert.deepEqual(
      [...announced].sort((a, b) => a - b),
      [first.id, second.id].sort((a, b) => a - b),
    );

    await joiner.close();
    await watcher.close();
  });
});

describe('inbox ordering', () => {
  it('moves a conversation to the top when a message arrives', async () => {
    // last_message_at was written on every send and read by nothing; ordering came from the join on
    // `messages`. Dropping the write must not change what the inbox looks like.
    const older = await freshConversation([1, 2]);
    const newer = await freshConversation([1, 2]);
    await seedMessages(newer.id, 1, [2]);
    await seedMessages(older.id, 1, [2]);

    const list = await conversationsOf(1, { limit: 5 });

    assert.equal(list[0].id, older.id, `expected ${older.id} first, got ${list.map((c) => c.id)}`);
  });
});
