import { config } from '../config.ts';
import { participantConversationIds, participantIdsOf } from '../services/conversations.ts';
import { onlineAmong, connectionClosed, connectionOpened } from '../services/presence.ts';
import { consumeTypingQuota } from '../services/rate-limit.ts';
import { getUserName } from '../services/users.ts';
import * as channels from './channels.ts';
import { publish } from './fanout.ts';
import * as registry from './registry.ts';
import type { Client } from './registry.ts';

/**
 * The client-to-server protocol: parsing frames and handling each type.
 *
 * Split out of ws/hub.ts so the transport wiring and the protocol are separate concerns. Everything
 * here is about interpreting what a client sent; nothing here owns connection state or Redis.
 */

export async function handleFrame(client: Client, raw: string): Promise<void> {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return; // malformed frames are ignored, as they always were
  }
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

  client.userId = userId;

  const allowed = await participantConversationIds(userId, requested);
  const next = new Set(allowed);
  channels.reconcile(client.subs, next);
  client.subs = next;

  registry.send(client, { type: 'subscribed', conversationIds: [...next] });

  // Register this connection, and announce only if it's what brought the user online. The registry
  // reports that, so it is never inferred from this instance's own socket list — which is what got
  // the transition wrong in the first version.
  const cameOnline = await connectionOpened(userId, client.id);
  if (cameOnline) await announcePresence(userId, [...next], true);

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
  if (isTyping && !(await consumeTypingQuota(userId, conversationId))) return;

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

/** Tells the client which participants of its conversations are online right now. */
async function sendPresenceSnapshot(client: Client): Promise<void> {
  if (!client.subs.size) return;
  const conversations = await Promise.all(
    [...client.subs].map(async (conversationId) => {
      const participants = await participantIdsOf(conversationId);
      const online = await onlineAmong(participants.filter((id) => id !== client.userId));
      return { conversationId, online: [...online] };
    }),
  );
  registry.send(client, { type: 'presence-snapshot', conversations });
}

async function announcePresence(
  userId: number,
  conversationIds: number[],
  online: boolean,
): Promise<void> {
  const userName = await getUserName(userId);
  for (const conversationId of conversationIds) {
    await publish(conversationId, { type: 'presence', conversationId, userId, userName, online });
  }
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
