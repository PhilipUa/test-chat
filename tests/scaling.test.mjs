import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { freshConversation, get, post, unique, waitForApi } from './helpers.mjs';

/**
 * Load-balancing properties: every replica must answer the same way.
 *
 * These pass at one instance and are only meaningful at several — run them against
 * `docker compose up -d --scale api=3`. `scripts/probe-scaling.mjs` is the same ideas as a report
 * you can read; this is the part worth failing a build over.
 */

before(async () => {
  await waitForApi();
});

/** Which replica served a response. */
const servedBy = (res) => res.headers.get('x-relay-instance');

/** Samples a path until it has seen `want` distinct replicas, or runs out of attempts. */
async function acrossReplicas(path, want = 3, attempts = 24) {
  const byInstance = new Map();
  for (let i = 0; i < attempts && byInstance.size < want; i++) {
    const res = await get(path);
    const instance = servedBy(res);
    if (instance && !byInstance.has(instance)) byInstance.set(instance, res);
  }
  return byInstance;
}

describe('every response identifies the replica that served it', () => {
  it('sets X-Relay-Instance on an API response', async () => {
    // Without this, "which process served that?" — the first question you have when something only
    // misbehaves sometimes — is unanswerable for every endpoint except /api/health.
    const res = await get('/api/users');

    assert.equal(res.status, 200);
    assert.ok(servedBy(res), 'no X-Relay-Instance header');
  });

  it('agrees with what /api/health reports about itself', async () => {
    const res = await get('/api/health');

    assert.equal(servedBy(res), res.body.instanceId);
  });

  it('sets it on an error response too', async () => {
    // The failing requests are the ones you most want to attribute to a replica.
    const res = await get('/api/messages?conversationId=999999999&userId=1');

    assert.ok(res.status >= 400, `expected an error, got ${res.status}`);
    assert.ok(servedBy(res), 'no X-Relay-Instance header on an error');
  });
});

describe('state is shared, not per-process', () => {
  it('reports the same unread count whichever replica answers', async () => {
    // The unread dot used to be a browser variable, then a per-process one. Either way it disagrees
    // between replicas; the watermark is in MySQL so every replica must give the same answer.
    const conv = await freshConversation([1, 2], unique('scale-unread'));
    await post('/api/messages', {
      conversationId: conv.id,
      senderId: 2,
      body: 'unread me',
      clientId: unique('u'),
    });

    const seen = await acrossReplicas(`/api/conversations?userId=1&limit=200`);
    const counts = [...seen.values()].map(
      (res) => res.body.conversations.find((c) => c.id === conv.id)?.unreadCount,
    );

    assert.ok(counts.length >= 1);
    assert.deepEqual(
      [...new Set(counts)],
      [1],
      `replicas disagreed about the unread count: ${JSON.stringify(counts)}`,
    );
  });

  it('serves a message from any replica the moment the write returns', async () => {
    // Read-your-writes across the load balancer: the POST lands on one replica and the next GET very
    // likely lands on another.
    const conv = await freshConversation([1, 2], unique('scale-ryw'));
    const marker = unique('ryw-body');
    const written = await post('/api/messages', {
      conversationId: conv.id,
      senderId: 2,
      body: marker,
      clientId: unique('r'),
    });
    assert.equal(written.status, 201);

    const seen = await acrossReplicas(`/api/messages?conversationId=${conv.id}&userId=1`);
    const found = [...seen.values()].map((res) => res.body.messages.some((m) => m.body === marker));

    assert.deepEqual(
      [...new Set(found)],
      [true],
      `a replica could not see a committed message: ${JSON.stringify([...seen.keys()])}`,
    );
  });

  it('enforces one send quota across replicas rather than one each', async () => {
    // The whole point of putting the limiter in Redis. Per-process state would let roughly
    // limit x replicas through, which is the failure this asserts against: the sends below are spread
    // over every replica by the proxy and must still stop at the limit.
    const conv = await freshConversation([1, 2], unique('scale-rl'));
    const statuses = [];
    const servers = new Set();
    for (let i = 0; i < 8; i++) {
      const res = await post('/api/messages', {
        conversationId: conv.id,
        senderId: 1,
        body: `burst-${i}`,
        clientId: unique('rl'),
      });
      statuses.push(res.status);
      if (servedBy(res)) servers.add(servedBy(res));
    }

    const accepted = statuses.filter((s) => s === 201).length;
    const limited = statuses.filter((s) => s === 429).length;

    assert.ok(limited > 0, `nothing was limited across ${servers.size} replica(s): ${statuses}`);
    assert.ok(
      accepted <= 5,
      `${accepted} sends accepted against a limit of 5 — the quota looks per-process ` +
        `(served by ${servers.size} replica(s))`,
    );
  });
});
