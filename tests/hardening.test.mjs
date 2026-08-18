import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  freshConversation,
  get,
  post,
  seedMessages,
  sleep,
  unique,
  waitForApi,
  waitUntilOffline,
  wsClient,
} from './helpers.mjs';

/**
 * Follow-up work after the first pass, covering the gaps that pass left behind. See
 * docs/05-hardening.md.
 */

before(async () => {
  await waitForApi();
});

describe('read paths are rate limited too (sends were the only metered endpoint)', () => {
  it('limits search with a Retry-After', async () => {
    // Search fans out over every message the caller can see, so leaving it unmetered was a cheap
    // way to generate unbounded read load.
    let limited;
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      const res = await get(`/api/search?q=${unique('rl')}&userId=2`);
      if (res.status === 429) {
        limited = res;
        break;
      }
      accepted++;
    }
    assert.ok(limited, 'expected search to be rate limited');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1, 'a 429 must carry Retry-After');
    assert.ok(accepted >= 5, `expected a usable allowance before limiting, got ${accepted}`);
  });

  it('does not meter a blank query, which does no work', async () => {
    for (let i = 0; i < 30; i++) {
      const res = await get('/api/search?q=&userId=3');
      assert.equal(res.status, 200, 'an empty query should never be throttled');
    }
  });

  it('limits conversation creation', async () => {
    // Uses user 3 as creator on purpose: exhausting an allowance is the only way to observe the
    // limit, and freshConversation never creates as user 3, so this can't starve other tests.
    let limited;
    for (let i = 0; i < 90; i++) {
      const res = await post('/api/conversations', {
        title: unique('rl-create'),
        participantIds: [3, 1],
      });
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    assert.ok(limited, 'expected conversation creation to be rate limited');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  });

  it('accepts offset=0, which is what a first page asks for', async () => {
    // This was a 400: the offset went through a positive-integer validator, which rejects zero.
    const res = await get('/api/search?q=the&userId=1&offset=0');
    assert.equal(res.status, 200);
  });
});

describe('search: paging, filters, and the indexed prefix path', () => {
  it('pages without overlapping, and stops advertising a next page at the end', async () => {
    const conv = await freshConversation([1, 2, 3]);
    const token = `pagetoken${Date.now()}`;
    // Distinct bodies all sharing one token, so there are several hits to page through.
    for (let i = 0; i < 6; i++) {
      const senderId = [1, 2, 3][i % 3];
      let res = await post('/api/messages', {
        conversationId: conv.id,
        senderId,
        body: `${token} entry number ${i}`,
        clientId: unique('page'),
      });
      if (res.status === 429) {
        await sleep((Number(res.headers.get('retry-after')) || 1) * 1000 + 250);
        res = await post('/api/messages', {
          conversationId: conv.id,
          senderId,
          body: `${token} entry number ${i}`,
          clientId: unique('page'),
        });
      }
      assert.ok(res.status < 400, `seed send failed: ${res.status}`);
    }

    const seen = [];
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      const res = await get(`/api/search?q=${token}&userId=1&limit=2&offset=${offset}`);
      assert.equal(res.status, 200);
      seen.push(...res.body.results.map((r) => r.messageId));
      if (res.body.nextOffset === null) break;
      offset = res.body.nextOffset;
    }
    assert.ok(seen.length >= 6, `expected to page through at least 6 hits, saw ${seen.length}`);
    assert.equal(new Set(seen).size, seen.length, 'pages must not overlap');
  });

  it('reports which strategy matched, and uses the prefix path for a partial word', async () => {
    const conv = await freshConversation();
    const token = `honeycomb${Date.now()}`;
    await post('/api/messages', {
      conversationId: conv.id,
      senderId: 1,
      body: `about ${token} structures`,
      clientId: unique('s'),
    });

    const whole = await get(`/api/search?q=${token}&userId=1`);
    assert.equal(whole.body.matchedBy, 'text');

    // A prefix the text index cannot match, since $text works on whole words.
    // A prefix the text index cannot match, since $text works on whole words. Asserting
    // "exactly one hit" would be wrong: tokens built from a timestamp share a leading prefix
    // between runs, so earlier runs' messages legitimately match too.
    const partial = await get(`/api/search?q=${token.slice(0, 12)}&userId=1`);
    assert.ok(partial.body.results.length >= 1, 'a partial word should still find the message');
    assert.equal(partial.body.matchedBy, 'prefix');
    assert.ok(
      partial.body.results.some((r) => r.body.includes(token)),
      'the message we just sent should be among the prefix matches',
    );

    const nothing = await get(`/api/search?q=zzz${Date.now()}&userId=1`);
    assert.equal(nothing.body.matchedBy, 'none');
    assert.equal(nothing.body.results.length, 0);
  });

  it('filters by sender and by date range', async () => {
    const conv = await freshConversation([1, 2]);
    const token = `filtertoken${Date.now()}`;
    await post('/api/messages', {
      conversationId: conv.id, senderId: 1, body: `${token} from alice`, clientId: unique('f'),
    });
    await post('/api/messages', {
      conversationId: conv.id, senderId: 2, body: `${token} from bob`, clientId: unique('f'),
    });

    const bySender = await get(`/api/search?q=${token}&userId=1&senderId=2`);
    assert.equal(bySender.body.results.length, 1);
    assert.equal(bySender.body.results[0].senderId, 2);

    const future = await get(`/api/search?q=${token}&userId=1&from=2999-01-01`);
    assert.equal(future.body.results.length, 0, 'nothing was sent in the future');

    const past = await get(`/api/search?q=${token}&userId=1&from=2000-01-01`);
    assert.ok(past.body.results.length >= 2);

    const bad = await get(`/api/search?q=${token}&userId=1&from=not-a-date`);
    assert.equal(bad.status, 400);
  });
});

describe('catch-up after a realtime gap', () => {
  it('?since= returns only what came after the given id, oldest first', async () => {
    const conv = await freshConversation([1, 2, 3]);
    const sent = await seedMessages(conv.id, 6);
    const midpoint = sent[2].id;

    const res = await get(`/api/messages?conversationId=${conv.id}&userId=1&since=${midpoint}`);
    assert.equal(res.status, 200);
    const ids = res.body.messages.map((m) => m.id);

    assert.ok(ids.every((id) => id > midpoint), 'every message must be newer than the cursor');
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'must be oldest-first for appending');
    assert.equal(ids.length, 3);
    assert.equal(res.body.latestId, ids[ids.length - 1]);
  });

  it('returns nothing when there is nothing to catch up on', async () => {
    const conv = await freshConversation([1, 2, 3]);
    const sent = await seedMessages(conv.id, 3);
    const res = await get(
      `/api/messages?conversationId=${conv.id}&userId=1&since=${sent[sent.length - 1].id}`,
    );
    assert.equal(res.body.messages.length, 0);
    assert.equal(res.body.hasMore, false);
  });

  it('reports hasMore so a client can walk a gap larger than one page', async () => {
    const conv = await freshConversation([1, 2, 3]);
    const sent = await seedMessages(conv.id, 9);

    let cursor = sent[0].id;
    const collected = [];
    for (let i = 0; i < 10; i++) {
      const res = await get(
        `/api/messages?conversationId=${conv.id}&userId=1&since=${cursor}&limit=3`,
      );
      collected.push(...res.body.messages.map((m) => m.id));
      if (!res.body.hasMore) break;
      cursor = res.body.latestId;
    }
    assert.equal(collected.length, 8, 'should have walked the whole gap');
    assert.equal(new Set(collected).size, collected.length, 'pages must not repeat a message');
  });

  it('still enforces membership on a catch-up request', async () => {
    const conv = await freshConversation([1, 2]);
    const res = await get(`/api/messages?conversationId=${conv.id}&userId=3&since=0`);
    assert.equal(res.status, 403);
  });
});

describe('presence', () => {
  // Dave (4) and Erin (5) are used throughout this block because presence is shared, TTL-based
  // state: asserting "X is offline" is only meaningful for an identity nothing else connects as.
  it('announces a user coming online and going offline', async () => {
    const conv = await freshConversation([4, 5]);
    await waitUntilOffline(4, conv.id, 5);

    const dave = await wsClient(4, [conv.id]);
    try {
      const snapshot = await dave.waitFor((e) => e.type === 'presence-snapshot');
      assert.ok(snapshot, 'a subscriber should get a presence snapshot');
      const entry = snapshot.conversations.find((c) => c.conversationId === conv.id);
      assert.deepEqual(entry.online, [], 'nobody else is connected yet');

      const erin = await wsClient(5, [conv.id]);
      const online = await dave.waitFor(
        (e) => e.type === 'presence' && e.userId === 5 && e.online === true,
        6_000,
      );
      assert.ok(online, 'Dave should be told Erin came online');
      assert.equal(online.userName, 'Erin');

      // Presence is in the conversation list too, which is what renders the sidebar dot.
      const list = await get('/api/conversations?userId=4');
      const participant = list.body
        .find((c) => c.id === conv.id)
        .participants.find((p) => p.id === 5);
      assert.equal(participant.online, true);

      await erin.close();
      const offline = await dave.waitFor(
        (e) => e.type === 'presence' && e.userId === 5 && e.online === false,
        8_000,
      );
      assert.ok(offline, 'Dave should be told Erin went offline');
    } finally {
      await dave.close();
    }
  });

  it('does not report a user offline while they still have another connection', async () => {
    const conv = await freshConversation([4, 5]);
    await waitUntilOffline(4, conv.id, 5);

    const dave = await wsClient(4, [conv.id]);
    const erinTabOne = await wsClient(5, [conv.id]);
    const erinTabTwo = await wsClient(5, [conv.id]);
    try {
      assert.ok(await dave.waitFor((e) => e.type === 'presence' && e.userId === 5 && e.online));

      // Closing one of two tabs must not report Erin as gone — this is why presence is tracked
      // per connection rather than per user.
      await erinTabOne.close();
      const premature = await dave.waitFor(
        (e) => e.type === 'presence' && e.userId === 5 && e.online === false,
        3_000,
      );
      assert.equal(premature, undefined, 'Erin still has a live connection');

      await erinTabTwo.close();
      assert.ok(
        await dave.waitFor(
          (e) => e.type === 'presence' && e.userId === 5 && e.online === false,
          8_000,
        ),
        'closing the last connection should report Erin offline',
      );
    } finally {
      await dave.close();
      await erinTabOne.close();
      await erinTabTwo.close();
    }
  });

  it('never tells a user about their own presence', async () => {
    const conv = await freshConversation([4, 5]);
    const dave = await wsClient(4, [conv.id]);
    try {
      const own = await dave.waitFor((e) => e.type === 'presence' && e.userId === 4, 2_000);
      assert.equal(own, undefined);
    } finally {
      await dave.close();
    }
  });
});

describe('typing is delivered per conversation, not just the one you are looking at', () => {
  it('reaches a subscriber regardless of which conversation they have open', async () => {
    // The client used to discard typing for any conversation that wasn't open, so you couldn't
    // tell someone was replying in another thread. The event has to arrive for the sidebar to
    // be able to show it.
    const [a, b] = [await freshConversation([1, 2]), await freshConversation([1, 2])];
    const alice = await wsClient(1, [a.id, b.id]);
    const bob = await wsClient(2, [a.id, b.id]);
    try {
      bob.send({ type: 'typing', conversationId: b.id, isTyping: true });
      const event = await alice.waitFor((e) => e.type === 'typing' && e.conversationId === b.id);
      assert.ok(event, 'typing for a second conversation must still be delivered');
      assert.equal(event.userId, 2);
      assert.equal(event.conversationId, b.id);
    } finally {
      await alice.close();
      await bob.close();
    }
  });
});
