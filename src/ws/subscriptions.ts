import * as channels from './channels.ts';
import { channelFor, userChannelFor } from './events.ts';
import * as registry from './registry.ts';
import type { Client } from './registry.ts';

/**
 * What each socket is subscribed to, and the Redis channels that implies.
 *
 * Split out of ws/protocol.ts because fan-out needs it too: delivering a "you're in a new
 * conversation" event has to subscribe the socket to that conversation, and protocol.ts publishes
 * through ws/fanout.ts — so this had to be somewhere neither of them owns.
 *
 * `client.subs` (conversation ids) is the authorization-facing set: what this socket is allowed to
 * see, and what presence announcements are addressed to. `client.channels` is the Redis-facing set
 * derived from it, plus the socket's own user channel. Keeping the derived set on the client rather
 * than recomputing it is what makes switching demo user correct — the *old* user's channel is in
 * there to be released, and by then `client.userId` is already the new one.
 */

function channelsOf(client: Client): Set<string> {
  const wanted = new Set([...client.subs].map(channelFor));
  if (client.userId !== undefined) wanted.add(userChannelFor(client.userId));
  return wanted;
}

function reconcileTo(client: Client, next: Set<string>): void {
  channels.reconcile(client.channels, next);
  client.channels = next;
}

/**
 * Points a live client's subscriptions at exactly `allowed`, acquiring and releasing the difference.
 *
 * Returns false when the socket closed while its subscribe was still in flight, which is the whole
 * reason this is a named function: everything after the participant query has to be able to bail.
 * Acquiring a channel for a client that is already out of the registry leaks it permanently — nobody
 * is left to release it — and one replica was found holding 741 subscriptions for zero connections.
 */
export function applySubscriptions(client: Client, allowed: number[]): boolean {
  if (client.closed) return false;
  client.subs = new Set(allowed);
  reconcileTo(client, channelsOf(client));
  return true;
}

/**
 * Adds one conversation to a live client's subscriptions, leaving the rest alone.
 *
 * For a conversation the socket could not have asked for because it did not exist when it
 * subscribed. Idempotent, so re-delivery of the same announcement costs nothing.
 */
export function attachConversation(client: Client, conversationId: number): void {
  if (client.closed || client.subs.has(conversationId)) return;
  client.subs.add(conversationId);

  const channel = channelFor(conversationId);
  if (client.channels.has(channel)) return;
  client.channels.add(channel);
  channels.acquire(channel);
}

/**
 * The whole teardown for one socket, in one place: mark it gone, release every channel it held, and
 * report which conversations it was in so the caller can announce the departure.
 *
 * One function rather than three steps at the call site, because the bug this fixes was precisely a
 * teardown that ran in the wrong order relative to an in-flight frame.
 */
export function releaseClient(client: Client): number[] {
  registry.markClosed(client);
  const held = [...client.subs];
  reconcileTo(client, new Set());
  client.subs = new Set();
  return held;
}
