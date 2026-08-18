import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationsOf,
  freshConversation,
  get,
  post,
  sleep,
  unique,
  waitForApi,
  wsClient,
} from './helpers.mjs';

/** Tests for the four things in tasks/. */

before(async () => {
  await waitForApi();
});

describe('tasks/rate-limiting.md', () => {
  it('allows the quota then returns 429 with Retry-After', async () => {
    const conv = await freshConversation();
    const send = (i) =>
      post('/api/messages', {
        conversationId: conv.id,
        senderId: 1,
        body: `flood ${i}`,
        clientId: unique('flood'),
      });

    const accepted = [];
    let limited;
    for (let i = 0; i < 12; i++) {
      const res = await send(i);
      if (res.status === 429) {
        limited = res;
        break;
      }
      accepted.push(res);
    }

    assert.ok(limited, 'expected to be rate limited within 12 rapid sends');
    assert.equal(limited.status, 429);

    // The header the task specifically asks for.
    const retryAfter = limited.headers.get('retry-after');
    assert.ok(retryAfter, 'a 429 must carry Retry-After');
    const seconds = Number(retryAfter);
    assert.ok(Number.isInteger(seconds) && seconds >= 1, `Retry-After should be whole seconds, got ${retryAfter}`);
    assert.ok(seconds <= 10, `Retry-After should be within the window, got ${seconds}`);

    // ~5 per 10s: allow a little slack so the test isn't brittle, but catch an order-of-magnitude
    // misconfiguration.
    assert.ok(
      accepted.length >= 3 && accepted.length <= 7,
      `expected roughly 5 accepted sends before limiting, got ${accepted.length}`,
    );
  });

  it('is per user — one sender being throttled does not throttle another', async () => {
    const conv = await freshConversation([1, 2]);

    // Burn Alice's quota.
    let alice;
    for (let i = 0; i < 12; i++) {
      alice = await post('/api/messages', {
        conversationId: conv.id, senderId: 1, body: `a${i}`, clientId: unique('a'),
      });
      if (alice.status === 429) break;
    }
    assert.equal(alice.status, 429, 'expected Alice to be limited');

    // Bob, in the same conversation, must be unaffected.
    const bob = await post('/api/messages', {
      conversationId: conv.id, senderId: 2, body: 'bob still talks', clientId: unique('b'),
    });
    assert.equal(bob.status, 201, 'a throttled user must not throttle the room');
  });

  it('is per conversation — being throttled in one room does not block another', async () => {
    const a = await freshConversation();
    const b = await freshConversation();

    let limited;
    for (let i = 0; i < 12; i++) {
      limited = await post('/api/messages', {
        conversationId: a.id, senderId: 1, body: `x${i}`, clientId: unique('x'),
      });
      if (limited.status === 429) break;
    }
    assert.equal(limited.status, 429);

    const other = await post('/api/messages', {
      conversationId: b.id, senderId: 1, body: 'different room', clientId: unique('y'),
    });
    assert.equal(other.status, 201);
  });

  it('reports remaining quota, and lets you send again after the window', async () => {
    const conv = await freshConversation();
    const first = await post('/api/messages', {
      conversationId: conv.id, senderId: 1, body: 'first', clientId: unique('r'),
    });
    assert.equal(first.headers.get('x-ratelimit-limit'), '5');
    assert.equal(first.headers.get('x-ratelimit-remaining'), '4');

    let limited;
    for (let i = 0; i < 12; i++) {
      limited = await post('/api/messages', {
        conversationId: conv.id, senderId: 1, body: `fill ${i}`, clientId: unique('r'),
      });
      if (limited.status === 429) break;
    }
    assert.equal(limited.status, 429);

    // The sliding window should free a slot after Retry-After elapses.
    const waitMs = Number(limited.headers.get('retry-after')) * 1000 + 500;
    await sleep(waitMs);
    const afterWindow = await post('/api/messages', {
      conversationId: conv.id, senderId: 1, body: 'window reopened', clientId: unique('r'),
    });
    assert.equal(afterWindow.status, 201, 'the window should have slid open again');
  });

  it('does not count a rejected (unauthorized) request against quota', async () => {
    const conv = await freshConversation([1, 2]);
    // Carol isn't a participant — these must not consume anyone's quota.
    for (let i = 0; i < 8; i++) {
      const res = await post('/api/messages', { conversationId: conv.id, senderId: 3, body: 'x' });
      assert.equal(res.status, 403);
    }
    const alice = await post('/api/messages', {
      conversationId: conv.id, senderId: 1, body: 'still fine', clientId: unique('q'),
    });
    assert.equal(alice.status, 201);
  });
});

describe('tasks/search.md', () => {
  it('finds a message by a word in its body, with the conversation title', async () => {
    const conv = await freshConversation([1, 2], unique('搜索 Search Room'));
    const token = `zephyr${Date.now()}`;
    await post('/api/messages', {
      conversationId: conv.id, senderId: 1,
      body: `the ${token} manifold needs recalibrating`, clientId: unique('s'),
    });

    const res = await get(`/api/search?q=${token}&userId=1`);
    assert.equal(res.status, 200);
    assert.equal(res.body.results.length, 1);
    const hit = res.body.results[0];
    assert.equal(hit.conversationId, conv.id);
    assert.equal(hit.conversationTitle, conv.title, 'title should be joined in from MySQL');
    assert.match(hit.body, new RegExp(token));
    assert.equal(hit.senderId, 1);
  });

  it('matches on word stems and across multiple terms', async () => {
    const conv = await freshConversation();
    const tag = `qx${Date.now()}`;
    await post('/api/messages', {
      conversationId: conv.id, senderId: 1,
      body: `${tag} scheduling the quarterly meetings`, clientId: unique('s'),
    });

    // "meeting" should match the stored "meetings" via the text index.
    const stem = await get(`/api/search?q=${encodeURIComponent(`${tag} meeting`)}&userId=1`);
    assert.ok(stem.body.results.length >= 1, 'expected a stemmed match for meeting/meetings');
  });

  it('falls back to indexed prefix matching for a partial word', async () => {
    const conv = await freshConversation();
    const token = `parsnip${Date.now()}`;
    await post('/api/messages', {
      conversationId: conv.id, senderId: 1, body: `about ${token}s in general`, clientId: unique('s'),
    });

    // A prefix of a word: Mongo's $text matches whole words, so this exercises the fallback.
    const partial = token.slice(0, 10);
    const res = await get(`/api/search?q=${partial}&userId=1`);
    assert.ok(res.body.results.length >= 1, 'a partial word should still find the message');
    // Was 'substring' when the fallback was an unindexed regex over the body; it's now an
    // anchored prefix match against the bodyTokens index.
    assert.equal(res.body.results[0].matchedBy, 'prefix');
  });

  it('never returns messages from conversations the caller is not in', async () => {
    // Conversation between Alice and Bob only.
    const conv = await freshConversation([1, 2]);
    const secret = `classified${Date.now()}`;
    await post('/api/messages', {
      conversationId: conv.id, senderId: 1, body: `${secret} launch codes`, clientId: unique('s'),
    });

    const asParticipant = await get(`/api/search?q=${secret}&userId=1`);
    assert.equal(asParticipant.body.results.length, 1);

    // Carol (3) searching the same term must get nothing.
    const asOutsider = await get(`/api/search?q=${secret}&userId=3`);
    assert.equal(asOutsider.body.results.length, 0, 'search must be scoped to the caller');
  });

  it('treats regex metacharacters as literal text', async () => {
    const conv = await freshConversation();
    const res = await get(`/api/search?q=${encodeURIComponent('.*+?[](){}')}&userId=1`);
    // The point is that it does not 500 or match everything via an injected regex.
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.results));
  });

  it('returns an empty result set for a blank query, and 400 without userId', async () => {
    assert.deepEqual((await get('/api/search?q=&userId=1')).body.results, []);
    assert.equal((await get('/api/search?q=hello')).status, 400);
  });

  it('can narrow to a single conversation', async () => {
    const token = `narrow${Date.now()}`;
    const a = await freshConversation();
    const b = await freshConversation();
    await post('/api/messages', { conversationId: a.id, senderId: 1, body: `${token} one`, clientId: unique('s') });
    await post('/api/messages', { conversationId: b.id, senderId: 1, body: `${token} two`, clientId: unique('s') });

    const all = await get(`/api/search?q=${token}&userId=1`);
    assert.equal(all.body.results.length, 2);

    const scoped = await get(`/api/search?q=${token}&userId=1&conversationId=${a.id}`);
    assert.equal(scoped.body.results.length, 1);
    assert.equal(scoped.body.results[0].conversationId, a.id);
  });
});

describe('tasks/typing-indicator.md', () => {
  it('delivers a typing event to the other participant but not to the typist', async () => {
    const conv = await freshConversation([1, 2]);
    const alice = await wsClient(1, [conv.id]);
    const bob = await wsClient(2, [conv.id]);

    try {
      alice.send({ type: 'typing', conversationId: conv.id, isTyping: true });

      const seenByBob = await bob.waitFor((e) => e.type === 'typing' && e.userId === 1);
      assert.ok(seenByBob, 'Bob should see that Alice is typing');
      assert.equal(seenByBob.isTyping, true);
      assert.equal(seenByBob.userName, 'Alice', 'event should carry a display name');
      assert.ok(seenByBob.ttlMs > 0, 'event should carry a TTL so a dropped client self-clears');

      const echoed = await alice.waitFor((e) => e.type === 'typing' && e.userId === 1, 1_000);
      assert.equal(echoed, undefined, 'the typist must not see their own indicator');
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it('delivers an explicit stop', async () => {
    const conv = await freshConversation([1, 2]);
    const alice = await wsClient(1, [conv.id]);
    const bob = await wsClient(2, [conv.id]);
    try {
      alice.send({ type: 'typing', conversationId: conv.id, isTyping: true });
      assert.ok(await bob.waitFor((e) => e.type === 'typing' && e.isTyping === true));

      alice.send({ type: 'typing', conversationId: conv.id, isTyping: false });
      assert.ok(
        await bob.waitFor((e) => e.type === 'typing' && e.isTyping === false),
        'a stop event should be delivered so the indicator clears promptly',
      );
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it('ignores typing frames for a conversation the socket is not subscribed to', async () => {
    const conv = await freshConversation([1, 2]);
    const bob = await wsClient(2, [conv.id]);
    // Carol subscribes to nothing she can see, then claims to be typing in Alice+Bob's room.
    const carol = await wsClient(3, []);
    try {
      carol.send({ type: 'typing', conversationId: conv.id, isTyping: true });
      const leaked = await bob.waitFor((e) => e.type === 'typing' && e.userId === 3, 1_500);
      assert.equal(leaked, undefined, 'a non-participant must not be able to broadcast typing');
    } finally {
      await bob.close();
      await carol.close();
    }
  });
});

describe('unread state (survives a reload, unlike the old client-side dot)', () => {
  it('counts unread messages from others and clears on read', async () => {
    const conv = await freshConversation([1, 2]);
    await post('/api/messages', {
      conversationId: conv.id, senderId: 2, body: 'unread one', clientId: unique('u'),
    });
    await post('/api/messages', {
      conversationId: conv.id, senderId: 2, body: 'unread two', clientId: unique('u'),
    });

    let mine = (await conversationsOf(1)).find((c) => c.id === conv.id);
    assert.equal(mine.unreadCount, 2);

    const page = await get(`/api/messages?conversationId=${conv.id}&userId=1`);
    const latest = page.body.messages.at(-1).id;
    const read = await post(`/api/conversations/${conv.id}/read`, { userId: 1, messageId: latest });
    assert.equal(read.status, 200);

    mine = (await conversationsOf(1)).find((c) => c.id === conv.id);
    assert.equal(mine.unreadCount, 0, 'unread should be zero after marking read');
    assert.equal(mine.lastReadMessageId, latest);
  });

  it('does not count your own messages as unread', async () => {
    const conv = await freshConversation([1, 2]);
    await post('/api/messages', {
      conversationId: conv.id, senderId: 1, body: 'mine', clientId: unique('u'),
    });
    const list = await conversationsOf(1);
    assert.equal(list.find((c) => c.id === conv.id).unreadCount, 0);
  });

  it('the read watermark only moves forward', async () => {
    const conv = await freshConversation([1, 2]);
    const sent = [];
    for (let i = 0; i < 3; i++) {
      const res = await post('/api/messages', {
        conversationId: conv.id, senderId: 2, body: `w${i}`, clientId: unique('w'),
      });
      sent.push(res.body.id);
    }
    await post(`/api/conversations/${conv.id}/read`, { userId: 1, messageId: sent[2] });
    // A stale receipt arriving late must not un-read things.
    const stale = await post(`/api/conversations/${conv.id}/read`, { userId: 1, messageId: sent[0] });
    assert.equal(stale.body.lastReadMessageId, sent[2]);
  });

  it('refuses a read receipt from a non-participant', async () => {
    const conv = await freshConversation([1, 2]);
    const res = await post(`/api/conversations/${conv.id}/read`, { userId: 3, messageId: 1 });
    assert.equal(res.status, 403);
  });
});

describe('conversation list', () => {
  it('carries the activity timestamp it is ordered by, so a client can keep the order live', async () => {
    // Without this the client cannot reproduce the server's ordering: `lastMessage.createdAt` covers
    // conversations that have messages, but a conversation with none sorts by its own creation time
    // and that was never exposed.
    const quiet = await freshConversation([1, 2], unique('quiet-room'));
    const busy = await freshConversation([1, 2], unique('busy-room'));
    await post('/api/messages', {
      conversationId: busy.id, senderId: 2, body: 'hello', clientId: unique('b'),
    });

    const list = await conversationsOf(1);
    const quietRow = list.find((c) => c.id === quiet.id);
    const busyRow = list.find((c) => c.id === busy.id);

    assert.equal(typeof quietRow.activityAt, 'string', 'a conversation with no messages needs one too');
    assert.equal(busyRow.activityAt, busyRow.lastMessage.createdAt);
    assert.ok(
      new Date(busyRow.activityAt) > new Date(quietRow.activityAt),
      'activityAt must order the list the same way the server does',
    );
  });

  it('is ordered by recent activity and carries a preview of the last message', async () => {
    const older = await freshConversation([1, 2], unique('older-room'));
    const newer = await freshConversation([1, 2], unique('newer-room'));

    await post('/api/messages', {
      conversationId: older.id, senderId: 2, body: 'older activity', clientId: unique('o'),
    });
    await sleep(50);
    await post('/api/messages', {
      conversationId: newer.id, senderId: 2, body: 'newest activity', clientId: unique('n'),
    });

    const list = await conversationsOf(1);
    const ids = list.map((c) => c.id);
    assert.ok(
      ids.indexOf(newer.id) < ids.indexOf(older.id),
      'the conversation with the most recent message should sort first',
    );

    const top = list.find((c) => c.id === newer.id);
    assert.equal(top.lastMessage.body, 'newest activity');
    assert.equal(top.messageCount, 1);
  });
});
