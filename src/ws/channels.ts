import { redisSubscriber } from '../db/redis.ts';
import { bestEffort } from '../util/resilience.ts';
import { isConversationChannel } from './events.ts';

/**
 * Refcounted Redis channel subscriptions.
 *
 * An instance subscribes to a channel when its first local socket cares, and unsubscribes when the
 * last one stops. The alternative — one global channel with local filtering — is simpler but means
 * every instance receives every conversation's traffic, which stops scaling at exactly the point
 * tasks/multi-instance.md is about.
 *
 * Keyed on the channel *name* rather than a conversation id, because there are two namespaces now:
 * `relay:conv:<id>` for a conversation's traffic and `relay:user:<id>` for a user's own inbox
 * (see ws/events.ts). The refcounting is identical for both, so it is written once.
 *
 * A channel is only *usable* once Redis has acknowledged the SUBSCRIBE, which is why the refcount
 * isn't the whole story — see `unconfirmed` below.
 */

const refs = new Map<string, number>();

/**
 * Channels we want but Redis has not acknowledged.
 *
 * `enableOfflineQueue: false` means a SUBSCRIBE issued while Redis is down rejects immediately, and
 * ioredis only re-issues SUBSCRIBE on reconnect for channels it managed to acknowledge. So a channel
 * acquired during an outage stayed silently dead for the life of the process: the browser re-sends
 * `subscribe` on reconnect, but `reconcile` sees current === next and calls no `acquire`, so nothing
 * ever tried again. Tracking the gap is what makes `resubscribeUnconfirmed` possible.
 */
const unconfirmed = new Set<string>();

async function subscribe(channel: string): Promise<void> {
  unconfirmed.add(channel);
  const ok = await bestEffort(`ws:subscribe:${channel}`, () => redisSubscriber.subscribe(channel));
  // Only clear it if the channel is still wanted — a release during the round trip has to win, or
  // we'd resurrect a channel nobody holds.
  if (ok && refs.has(channel)) unconfirmed.delete(channel);
}

export function acquire(channel: string): void {
  const next = (refs.get(channel) ?? 0) + 1;
  refs.set(channel, next);
  if (next === 1) void subscribe(channel);
}

export function release(channel: string): void {
  const next = (refs.get(channel) ?? 1) - 1;
  if (next <= 0) {
    refs.delete(channel);
    unconfirmed.delete(channel);
    void bestEffort(`ws:unsubscribe:${channel}`, () => redisSubscriber.unsubscribe(channel));
  } else {
    refs.set(channel, next);
  }
}

/** Moves a client's channel set to `next`, acquiring and releasing the difference. */
export function reconcile(current: ReadonlySet<string>, next: ReadonlySet<string>): void {
  for (const channel of current) if (!next.has(channel)) release(channel);
  for (const channel of next) if (!current.has(channel)) acquire(channel);
}

/**
 * How many *conversation* channels this instance holds.
 *
 * Deliberately not every channel: /api/health reports this as `subscribedConversations`, and the
 * scaling probes read it as "conversations this replica is carrying". A per-user channel is
 * bookkeeping for one socket's own inbox, not load taken on from the proxy, so counting it here
 * would make every replica look busier than it is by exactly its connection count.
 */
export function subscribedCount(): number {
  let count = 0;
  for (const channel of refs.keys()) if (isConversationChannel(channel)) count += 1;
  return count;
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
  const pending = [...unconfirmed].filter((channel) => refs.has(channel));
  await Promise.all(pending.map((channel) => subscribe(channel)));
  return pending.length;
}
