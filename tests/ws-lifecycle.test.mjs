import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Unit tests for WebSocket connection lifecycle accounting.
 *
 * These run in-process on the host with no Redis reachable, which is deliberate: the refcounting in
 * ws/channels.ts is in-process state and its `SUBSCRIBE` calls go through `bestEffort`, so a host
 * with no Redis exercises exactly what's under test — that the refcount stays balanced whatever
 * order things happen in, and that a channel whose SUBSCRIBE never landed is remembered so it can be
 * retried.
 *
 * Redis points at a closed local port so connections fail fast (ECONNREFUSED) rather than retrying
 * against an unresolvable Compose hostname for the length of the run. Assertions are on *deltas*, so
 * no test needs to reach into module state to reset it.
 */
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const channels = await import('../src/ws/channels.ts');
const registry = await import('../src/ws/registry.ts');
const protocol = await import('../src/ws/protocol.ts');
const { redis, redisSubscriber } = await import('../src/db/redis.ts');

after(() => {
  redis.disconnect();
  redisSubscriber.disconnect();
});

/** A stand-in for a live `ws` socket: the registry only reads readyState and writes frames. */
function liveClient() {
  return registry.add({ readyState: 1, send() {}, ping() {}, terminate() {} });
}

/** Lets the rejected SUBSCRIBE settle, so `unconfirmed` reflects the failure. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('channel refcounting across a client closing', () => {
  it('acquires one channel per conversation a live client subscribes to', () => {
    const before = channels.subscribedCount();
    const client = liveClient();

    const applied = protocol.applySubscriptions(client, [1101, 1102, 1103]);

    assert.equal(applied, true);
    assert.equal(channels.subscribedCount() - before, 3);
    protocol.releaseClient(client);
  });

  it('releases every channel the client held when it goes away', () => {
    const before = channels.subscribedCount();
    const client = liveClient();
    protocol.applySubscriptions(client, [1201, 1202, 1203]);

    protocol.releaseClient(client);

    assert.equal(channels.subscribedCount() - before, 0);
  });

  it('reports which conversations the client was in, for the offline announce', () => {
    const client = liveClient();
    protocol.applySubscriptions(client, [1301, 1302]);

    const held = protocol.releaseClient(client);

    assert.deepEqual([...held].sort(), [1301, 1302]);
  });

  it('ignores a subscribe that resolves after its client has already closed', () => {
    // The bug: handleSubscribe set up its subscription *after* awaiting the participant query, so
    // the close handler could run first. It then acquired channels nobody would ever release —
    // permanently, because the client is already out of the registry.
    const before = channels.subscribedCount();
    const client = liveClient();
    protocol.releaseClient(client);

    const applied = protocol.applySubscriptions(client, [1401, 1402, 1403]);

    assert.equal(applied, false, 'a closed client must not acquire subscriptions');
    assert.equal(channels.subscribedCount() - before, 0, 'leaked channel refs');
  });

  it('keeps a channel while a second client still holds it', () => {
    const before = channels.subscribedCount();
    const first = liveClient();
    const second = liveClient();
    protocol.applySubscriptions(first, [1501]);
    protocol.applySubscriptions(second, [1501]);

    protocol.releaseClient(first);

    assert.equal(channels.subscribedCount() - before, 1);
    protocol.releaseClient(second);
  });

  it('drops a closed client from the connection registry', () => {
    const client = liveClient();

    protocol.releaseClient(client);

    assert.equal([...registry.all()].includes(client), false);
  });
});

describe('unconfirmed channel subscriptions', () => {
  it('remembers a channel whose SUBSCRIBE never landed', async () => {
    // ioredis only re-issues SUBSCRIBE on reconnect for channels it managed to acknowledge. One
    // acquired while Redis was down is never resubscribed, and `reconcile` won't retry it either:
    // the client re-sends `subscribe`, current === next, so nothing calls acquire again.
    const before = channels.unconfirmedCount();
    const client = liveClient();
    protocol.applySubscriptions(client, [2101, 2102]);
    await settle();

    assert.equal(channels.unconfirmedCount() - before, 2);
    protocol.releaseClient(client);
  });

  it('retries every unconfirmed channel when asked to resubscribe', async () => {
    const client = liveClient();
    protocol.applySubscriptions(client, [2201, 2202]);
    await settle();

    const retried = await channels.resubscribeUnconfirmed();

    assert.equal(retried >= 2, true, `expected at least the 2 held channels, got ${retried}`);
    protocol.releaseClient(client);
  });

  it('does not retry a channel no client holds any more', async () => {
    const client = liveClient();
    protocol.applySubscriptions(client, [2301, 2302]);
    await settle();
    protocol.releaseClient(client);

    const retried = await channels.resubscribeUnconfirmed();

    assert.equal(retried, 0);
  });
});
