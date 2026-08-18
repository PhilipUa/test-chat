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
 */

const refs = new Map<number, number>();

export function acquire(conversationId: number): void {
  const next = (refs.get(conversationId) ?? 0) + 1;
  refs.set(conversationId, next);
  if (next === 1) {
    void bestEffort(`ws:subscribe:${conversationId}`, () =>
      redisSubscriber.subscribe(channelFor(conversationId)),
    );
  }
}

export function release(conversationId: number): void {
  const next = (refs.get(conversationId) ?? 1) - 1;
  if (next <= 0) {
    refs.delete(conversationId);
    // Leaking a subscription is harmless (we filter by client subs anyway) but worth knowing about.
    void bestEffort(`ws:unsubscribe:${conversationId}`, () =>
      redisSubscriber.unsubscribe(channelFor(conversationId)),
    );
  } else {
    refs.set(conversationId, next);
  }
}

/** Moves a client's subscription set to `next`, acquiring and releasing the difference. */
export function reconcile(current: Set<number>, next: Set<number>): void {
  for (const id of current) if (!next.has(id)) release(id);
  for (const id of next) if (!current.has(id)) acquire(id);
}

export function subscribedCount(): number {
  return refs.size;
}
