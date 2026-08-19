import { config } from '../config.ts';
import {
  participantConversationIds,
  participantIdsOfMany,
} from '../services/conversations/membership.ts';
import { onlineAmong, connectionClosed, connectionOpened } from '../services/presence.ts';
import { consumeQuota } from '../services/rate-limit.ts';
import { getUserName } from '../services/users.ts';
import { publish, publishEach } from './fanout.ts';
import * as registry from './registry.ts';
import type { Client } from './registry.ts';
import { applySubscriptions, releaseClient } from './subscriptions.ts';
import { parseJson } from '../util/resilience.ts';

/**
 * The client-to-server protocol: parsing frames and handling each type.
 *
 * Split out of ws/hub.ts so the transport wiring and the protocol are separate concerns. Everything
 * here is about interpreting what a client sent; nothing here owns connection state or Redis.
 */

/**
 * Re-exported so the transport wiring keeps talking to one module. The subscription bookkeeping
 * itself lives in ws/subscriptions.ts, which fan-out also needs.
 */
export { applySubscriptions, releaseClient };

export async function handleFrame(client: Client, raw: string): Promise<void> {
  // Malformed frames are expected rather than exceptional on a public socket, and are ignored.
  const frame = parseJson<unknown>(raw);
  if (!frame || typeof frame !== 'object') return;

  const message = frame as Record<string, unknown>;
  switch (message.type) {
    case 'subscribe':
      return handleSubscribe(client, message);
    case 'typing':
      return handleTyping(client, message);
    case 'ping':
      // Lets the browser verify liveness without waiting for our heartbeat.
      registry.send(client, { type: 'pong' });
      return;
    default:
      return;
  }
}

/**
 * The original handler took whatever conversation ids the client named, so anyone could subscribe to
 * every conversation in the system and tail other people's messages. The request is intersected with
 * the conversations the user is actually a participant in.
 *
 * Every step after the first await re-checks that the socket is still alive. Frame handling is async
 * and the close event does not wait for it, so without those checks this function goes on acquiring
 * channels and registering presence for a connection that has already gone.
 */
async function handleSubscribe(client: Client, frame: Record<string, unknown>): Promise<void> {
  const userId = Number(frame.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    registry.send(client, { type: 'error', error: 'subscribe requires a numeric userId' });
    return;
  }

  const requested = Array.isArray(frame.conversationIds)
    ? frame.conversationIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : [];

  const previousUserId = client.userId;
  client.userId = userId;

  const allowed = await participantConversationIds(userId, requested);
  if (client.closed) return;

  // The UI re-subscribes on the same socket when you switch demo user. Without deregistering the
  // previous identity its presence connection lingers for the whole TTL with no offline event, so
  // the user you just stopped being shows as online to everyone for 90 seconds. Announced while the
  // old subscriptions are still in place, so it reaches the conversations that user was in.
  if (previousUserId !== undefined && previousUserId !== userId) {
    const wentOffline = await connectionClosed(previousUserId, client.id);
    if (wentOffline) await announcePresence(previousUserId, [...client.subs], false);
  }

  if (!applySubscriptions(client, allowed)) return;

  registry.send(client, { type: 'subscribed', conversationIds: [...client.subs] });

  // Register this connection, and announce only if it's what brought the user online. The registry
  // reports that, so it is never inferred from this instance's own socket list — which is what got
  // the transition wrong in the first version.
  const cameOnline = await connectionOpened(userId, client.id);
  if (client.closed) {
    // The socket went away while we were registering it. Undo the registration rather than leaving a
    // phantom connection online until the TTL expires.
    await connectionClosed(userId, client.id);
    return;
  }
  if (cameOnline) await announcePresence(userId, [...client.subs], true);

  await sendPresenceSnapshot(client);
}

/** tasks/typing-indicator.md */
async function handleTyping(client: Client, frame: Record<string, unknown>): Promise<void> {
  const conversationId = Number(frame.conversationId);
  const userId = client.userId;
  if (!userId || !client.subs.has(conversationId)) {
    // Not subscribed means either not authorized or not yet subscribed; either way, drop it rather
    // than letting the socket broadcast into a conversation it isn't in.
    return;
  }

  const isTyping = frame.isTyping !== false;

  // A typing indicator is a broadcast primitive, so it needs its own (looser) limit. Stop events
  // always go through, so a throttled client can't leave someone stuck as "typing".
  if (
    isTyping &&
    !(await consumeQuota(`typing:${userId}:${conversationId}`, config.rateLimit.typing)).allowed
  ) {
    return;
  }

  await publish(
    conversationId,
    {
      type: 'typing',
      conversationId,
      userId,
      userName: await getUserName(userId),
      isTyping,
      ttlMs: config.ws.typingTtlMs,
    },
    client.id,
  );
}

/**
 * Tells the client which participants of its conversations are online right now.
 *
 * Two round trips total — one query for every subscribed conversation's participants, one presence
 * lookup for the union of those users — rather than two per conversation.
 */
async function sendPresenceSnapshot(client: Client): Promise<void> {
  if (!client.subs.size) return;

  const byConversation = await participantIdsOfMany([...client.subs]);
  const everyone = new Set<number>();
  for (const ids of byConversation.values()) {
    for (const id of ids) if (id !== client.userId) everyone.add(id);
  }
  const online = await onlineAmong([...everyone]);

  const conversations = [...client.subs].map((conversationId) => ({
    conversationId,
    online: (byConversation.get(conversationId) ?? []).filter(
      (id) => id !== client.userId && online.has(id),
    ),
  }));
  registry.send(client, { type: 'presence-snapshot', conversations });
}

/**
 * Tells a user's conversations that they came online or went away.
 *
 * One pipelined publish rather than a round trip per conversation: this runs on every connect and
 * every disconnect, and a user in 878 conversations was spending ~95ms of serial Redis round trips
 * here before their presence snapshot could even be sent.
 */
async function announcePresence(
  userId: number,
  conversationIds: number[],
  online: boolean,
): Promise<void> {
  if (!conversationIds.length) return;
  const userName = await getUserName(userId);
  await publishEach(
    conversationIds.map((conversationId) => ({
      conversationId,
      event: { type: 'presence', conversationId, userId, userName, online },
    })),
  );
}

/**
 * When a socket closes, the user is only offline if that was their last live connection anywhere —
 * otherwise closing one of two tabs would report them as gone.
 */
export async function handleDisconnect(client: Client, wasSubscribedTo: number[]): Promise<void> {
  const userId = client.userId;
  if (!userId) return;

  const wentOffline = await connectionClosed(userId, client.id);
  if (wentOffline) await announcePresence(userId, wasSubscribedTo, false);
}

/** Deregisters presence for connections still held at shutdown. */
export async function deregisterAll(clients: Iterable<Client>): Promise<void> {
  await Promise.allSettled(
    [...clients].filter((c) => c.userId).map((c) => connectionClosed(c.userId!, c.id)),
  );
}
