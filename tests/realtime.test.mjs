import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { freshConversation, get, post, sleep, unique, waitForApi, wsClient } from './helpers.mjs';

/**
 * tasks/multi-instance.md — finding C.
 *
 * These are the tests that catch the original bug, and the reason they open *several* sockets is
 * that the bug is invisible with one. Behind a round-robin proxy each socket lands on a
 * (probably) different replica, so a fan-out that only reaches the publishing process shows up as
 * some clients receiving and some not.
 *
 * Run against 3 replicas to make it meaningful:
 *   docker compose up -d --scale api=3 && npm test
 */

const FANOUT_CLIENTS = Number(process.env.FANOUT_CLIENTS || 6);

before(async () => {
  await waitForApi();
});

describe('realtime fan-out', () => {
  it('a new message reaches every subscribed socket, whichever instance holds it', async () => {
    const conv = await freshConversation([1, 2]);
    const clients = [];
    for (let i = 0; i < FANOUT_CLIENTS; i++) {
      clients.push(await wsClient(2, [conv.id]));
    }

    try {
      const marker = unique('fanout');
      const res = await post('/api/messages', {
        conversationId: conv.id, senderId: 1, body: marker, clientId: marker,
      });
      assert.equal(res.status, 201);

      const received = await Promise.all(
        clients.map((c) => c.waitFor((e) => e.type === 'message' && e.body === marker, 5_000)),
      );
      const misses = received.filter((r) => r === undefined).length;
      assert.equal(
        misses,
        0,
        `${misses}/${FANOUT_CLIENTS} sockets missed the message — fan-out is not crossing instances`,
      );
    } finally {
      for (const c of clients) c.close();
    }
  });

  it('a message is delivered exactly once per socket', async () => {
    const conv = await freshConversation([1, 2]);
    const clients = [];
    for (let i = 0; i < FANOUT_CLIENTS; i++) clients.push(await wsClient(2, [conv.id]));

    try {
      const marker = unique('once');
      await post('/api/messages', {
        conversationId: conv.id, senderId: 1, body: marker, clientId: marker,
      });
      await sleep(1_500);

      for (const [i, c] of clients.entries()) {
        const copies = c.events.filter((e) => e.type === 'message' && e.body === marker).length;
        // Publishing through Redis *including* for the local process is what guarantees this:
        // a local send plus a Redis echo would deliver twice.
        assert.equal(copies, 1, `socket ${i} received ${copies} copies of the same message`);
      }
    } finally {
      for (const c of clients) c.close();
    }
  });

  it('typing events cross instances too', async () => {
    const conv = await freshConversation([1, 2]);
    const typist = await wsClient(1, [conv.id]);
    const watchers = [];
    for (let i = 0; i < FANOUT_CLIENTS; i++) watchers.push(await wsClient(2, [conv.id]));

    try {
      typist.send({ type: 'typing', conversationId: conv.id, isTyping: true });
      const received = await Promise.all(
        watchers.map((w) => w.waitFor((e) => e.type === 'typing' && e.userId === 1, 5_000)),
      );
      const misses = received.filter((r) => r === undefined).length;
      assert.equal(misses, 0, `${misses}/${FANOUT_CLIENTS} sockets missed the typing event`);
    } finally {
      typist.close();
      for (const w of watchers) w.close();
    }
  });

  it('a read receipt reaches the user\'s other sessions', async () => {
    const conv = await freshConversation([1, 2]);
    const sessions = [];
    for (let i = 0; i < 3; i++) sessions.push(await wsClient(1, [conv.id]));

    try {
      const sent = await post('/api/messages', {
        conversationId: conv.id, senderId: 2, body: 'read me', clientId: unique('read'),
      });
      await post(`/api/conversations/${conv.id}/read`, { userId: 1, messageId: sent.body.id });

      const received = await Promise.all(
        sessions.map((s) => s.waitFor((e) => e.type === 'read' && e.userId === 1, 5_000)),
      );
      assert.equal(received.filter((r) => r === undefined).length, 0);
    } finally {
      for (const s of sessions) s.close();
    }
  });

  it('rate limiting holds across instances', async () => {
    // Each request is round-robined to a different replica. A per-process counter would let
    // roughly limit x replicas through; a shared one holds the line at the limit.
    const conv = await freshConversation();
    let accepted = 0;
    for (let i = 0; i < 15; i++) {
      const res = await post('/api/messages', {
        conversationId: conv.id, senderId: 1, body: `cross ${i}`, clientId: unique('cross'),
      });
      if (res.status === 429) break;
      accepted++;
    }
    assert.ok(
      accepted <= 7,
      `${accepted} sends were accepted — the limit is not shared between instances`,
    );
  });

  it('resubscribing replaces the previous subscription set', async () => {
    const a = await freshConversation([1, 2]);
    const b = await freshConversation([1, 2]);
    const client = await wsClient(2, [a.id]);

    try {
      // Move the subscription from a to b.
      client.send({ type: 'subscribe', userId: 2, conversationIds: [b.id] });
      const ack = await client.waitFor(
        (e) => e.type === 'subscribed' && e.conversationIds.includes(b.id),
      );
      assert.ok(ack);
      assert.equal(ack.conversationIds.includes(a.id), false);

      const markerA = unique('gone');
      await post('/api/messages', { conversationId: a.id, senderId: 1, body: markerA, clientId: markerA });
      assert.equal(
        await client.waitFor((e) => e.type === 'message' && e.body === markerA, 1_500),
        undefined,
        'should no longer receive events for the unsubscribed conversation',
      );

      const markerB = unique('here');
      await post('/api/messages', { conversationId: b.id, senderId: 1, body: markerB, clientId: markerB });
      assert.ok(
        await client.waitFor((e) => e.type === 'message' && e.body === markerB, 5_000),
        'should receive events for the newly subscribed conversation',
      );
    } finally {
      client.close();
    }
  });

  it('a deduplicated retry is not broadcast a second time', async () => {
    const conv = await freshConversation([1, 2]);
    const watcher = await wsClient(2, [conv.id]);
    try {
      const clientId = unique('nodupe');
      const payload = { conversationId: conv.id, senderId: 1, body: 'sent once', clientId };
      await post('/api/messages', payload);
      await post('/api/messages', payload); // the retry
      await sleep(1_500);

      const copies = watcher.events.filter((e) => e.type === 'message' && e.clientId === clientId).length;
      assert.equal(copies, 1, 'a retried send must not put a second copy in everyone\'s window');
    } finally {
      watcher.close();
    }
  });
});
