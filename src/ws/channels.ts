import { redisSubscriber } from '../db/redis.ts';
import { bestEffort } from '../util/resilience.ts';
import { channelFor } from './events.ts';

/**
 * Refcounted Redis channel subscriptions.
 *
 * An instance subscribes to a conversation's channel when its first local socket cares, and
 * unsubscribes when the last one stops. The alternative — one global channel with local filtering —
 * is simpler but means every instance receives every conversation's traffic, which stops scaling at
 * exactly the point tasks/multi-instance.md is about.
 *
 * A channel is only *usable* once Redis has acknowledged the SUBSCRIBE, which is why the refcount
 * isn't the whole story — see `unconfirmed` below.
 */

const refs = new Map<number, number>();

/**
 * Channels we want but Redis has not acknowledged.
 *
 * `enableOfflineQueue: false` means a SUBSCRIBE issued while Redis is down rejects immediately, and
 * ioredis only re-issues SUBSCRIBE on reconnect for channels it managed to acknowledge. So a channel
 * acquired during an outage stayed silently dead for the life of the process: the browser re-sends
 * `subscribe` on reconnect, but `reconcile` sees current === next and calls no `acquire`, so nothing
 * ever tried again. Tracking the gap is what makes `resubscribeUnconfirmed` possible.
 */
const unconfirmed = new Set<number>();

async function subscribe(conversationId: number): Promise<void> {
  unconfirmed.add(conversationId);
  const ok = await bestEffort(`ws:subscribe:${conversationId}`, () =>
    redisSubscriber.subscribe(channelFor(conversationId)),
  );
  // Only clear it if the channel is still wanted — a release during the round trip has to win, or
  // we'd resurrect a channel nobody holds.
  if (ok && refs.has(conversationId)) unconfirmed.delete(conversationId);
}

export function acquire(conversationId: number): void {
  const next = (refs.get(conversationId) ?? 0) + 1;
  refs.set(conversationId, next);
  if (next === 1) void subscribe(conversationId);
}

export function release(conversationId: number): void {
  const next = (refs.get(conversationId) ?? 1) - 1;
  if (next <= 0) {
    refs.delete(conversationId);
    unconfirmed.delete(conversationId);
    void bestEffort(`ws:unsubscribe:${conversationId}`, () =>
      redisSubscriber.unsubscribe(channelFor(conversationId)),
    );
  } else {
    refs.set(conversationId, next);
  }
}

/** Moves a client's subscription set to `next`, acquiring and releasing the difference. */
export function reconcile(current: ReadonlySet<number>, next: ReadonlySet<number>): void {
  for (const id of current) if (!next.has(id)) release(id);
  for (const id of next) if (!current.has(id)) acquire(id);
}

export function subscribedCount(): number {
  return refs.size;
}

export function unconfirmedCount(): number {
  return unconfirmed.size;
}

/**
 * Retries every channel whose SUBSCRIBE never landed, and reports how many were retried.
 *
 * Called when the subscriber reconnects. Channels nothing holds any more are skipped rather than
 * resurrected.
 */
export async function resubscribeUnconfirmed(): Promise<number> {
  const pending = [...unconfirmed].filter((id) => refs.has(id));
  await Promise.all(pending.map((id) => subscribe(id)));
  return pending.length;
}
