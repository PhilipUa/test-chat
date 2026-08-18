import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from '../config.ts';
import { redis, redisSubscriber } from '../db/redis.ts';
import { participantConversationIds } from '../services/conversations.ts';
import { getUserName } from '../services/users.ts';
import { consumeTypingQuota } from '../services/rate-limit.ts';
import {
  channelFor,
  conversationIdFromChannel,
  type ConversationEvent,
  type FanoutEnvelope,
} from './events.ts';

/**
 * WebSocket hub.
 *
 * Finding C / tasks/multi-instance.md: the original hub kept its client set in a module-level
 * variable, so `broadcast()` only reached sockets on the process that handled the POST. With one
 * instance that is every socket, which is why it looked fine. With three, two thirds of clients
 * silently stopped receiving messages.
 *
 * The fix routes every fan-out through Redis pub/sub, and — importantly — routes *local*
 * delivery through it too. There is one delivery path rather than a local path and a remote path
 * that can drift apart, and no message can be delivered twice. Each instance subscribes only to
 * the conversations it actually holds sockets for, refcounted, so adding instances doesn't mean
 * every instance sees every conversation's traffic.
 */

interface Client {
  id: string;
  ws: WebSocket;
  userId?: number;
  /** Conversations this socket is subscribed to, already filtered to ones the user is in. */
  subs: Set<number>;
  /** Cleared on pong; a socket that misses two heartbeats is terminated. */
  missedPings: number;
}

const clients = new Set<Client>();
/** conversationId -> number of local sockets subscribed, so we know when to (un)subscribe. */
const channelRefs = new Map<number, number>();

let heartbeat: NodeJS.Timeout | undefined;
let wss: WebSocketServer | undefined;

export function attachWs(server: Server): void {
  wss = new WebSocketServer({ server, path: '/' });

  wss.on('connection', (ws) => {
    const client: Client = { id: crypto.randomUUID(), ws, subs: new Set(), missedPings: 0 };
    clients.add(client);

    // Finding K: `ws` emits 'error' on an abrupt disconnect. An unhandled 'error' on an
    // EventEmitter is thrown, which is another way to take the process down.
    ws.on('error', (err) => {
      console.error(`[ws] socket error (${client.id}):`, err.message);
    });

    ws.on('pong', () => {
      client.missedPings = 0;
    });

    ws.on('message', (raw) => {
      // Never let a malformed or hostile frame reject into the void.
      void handleFrame(client, raw.toString()).catch((err) => {
        console.error('[ws] frame handling failed:', err);
        send(client, { type: 'error', error: 'could not handle that frame' });
      });
    });

    ws.on('close', () => {
      clients.delete(client);
      for (const id of client.subs) releaseChannel(id);
      client.subs.clear();
    });
  });

  wss.on('error', (err) => console.error('[ws] server error:', err));

  // Finding K: without a heartbeat, sockets that died without a close frame are never reaped —
  // the client set grows and we keep writing to nobody.
  heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (client.missedPings >= 2) {
        client.ws.terminate();
        continue;
      }
      client.missedPings += 1;
      client.ws.ping();
    }
  }, config.ws.heartbeatIntervalMs);
  heartbeat.unref();

  redisSubscriber.on('message', (channel, payload) => {
    const conversationId = conversationIdFromChannel(channel);
    if (conversationId === undefined) return;
    let envelope: FanoutEnvelope;
    try {
      envelope = JSON.parse(payload);
    } catch {
      return;
    }
    deliverLocally(conversationId, envelope);
  });
}

async function handleFrame(client: Client, raw: string): Promise<void> {
  let frame: any;
  try {
    frame = JSON.parse(raw);
  } catch {
    return; // malformed frames are ignored, as before
  }
  if (!frame || typeof frame !== 'object') return;

  switch (frame.type) {
    case 'subscribe':
      await handleSubscribe(client, frame);
      return;
    case 'typing':
      await handleTyping(client, frame);
      return;
    case 'ping':
      // Lets the browser verify liveness without waiting for our heartbeat.
      send(client, { type: 'pong' });
      return;
    default:
      return;
  }
}

/**
 * Finding E: the original handler took whatever conversation ids the client named. Anyone could
 * subscribe to every conversation in the system and tail other people's messages. We now
 * intersect the request with the conversations the user is actually a participant in.
 */
async function handleSubscribe(client: Client, frame: any): Promise<void> {
  const userId = Number(frame.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    send(client, { type: 'error', error: 'subscribe requires a numeric userId' });
    return;
  }
  const requested = Array.isArray(frame.conversationIds)
    ? frame.conversationIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : [];

  client.userId = userId;

  const allowed = await participantConversationIds(userId, requested);
  const next = new Set(allowed);

  for (const id of client.subs) {
    if (!next.has(id)) releaseChannel(id);
  }
  for (const id of next) {
    if (!client.subs.has(id)) acquireChannel(id);
  }
  client.subs = next;

  send(client, { type: 'subscribed', conversationIds: [...next] });
}

/** tasks/typing-indicator.md */
async function handleTyping(client: Client, frame: any): Promise<void> {
  const conversationId = Number(frame.conversationId);
  const userId = client.userId;
  if (!userId || !client.subs.has(conversationId)) {
    // Not subscribed means either not authorized or not yet subscribed; either way, drop it
    // rather than letting the socket broadcast into a conversation it isn't in.
    return;
  }

  const isTyping = frame.isTyping !== false;

  // A typing indicator is a broadcast primitive, so it needs its own (looser) limit — otherwise
  // it's a free way to spam every participant. Stop events are always allowed through so a
  // throttled client can't leave someone stuck as "typing".
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

/**
 * Publish an event to everyone subscribed to a conversation, on any instance.
 *
 * Delivery happens in the Redis 'message' handler, including for this process, so there is
 * exactly one code path and no risk of double delivery. If Redis is unreachable we fall back to
 * local-only delivery: single-instance behaviour is better than no realtime at all.
 */
export async function publish(
  conversationId: number,
  event: ConversationEvent,
  originConnectionId?: string,
): Promise<void> {
  const envelope: FanoutEnvelope = { event, origin: config.instanceId, originConnectionId };
  try {
    await redis.publish(channelFor(conversationId), JSON.stringify(envelope));
  } catch (err) {
    console.error(
      `[ws] redis publish failed, degrading to local fan-out: ${(err as Error).message}`,
    );
    deliverLocally(conversationId, envelope);
  }
}

function deliverLocally(conversationId: number, envelope: FanoutEnvelope): void {
  const data = JSON.stringify(envelope.event);
  for (const client of clients) {
    if (!client.subs.has(conversationId)) continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    // Don't echo a typing indicator back to the person typing.
    if (envelope.originConnectionId && envelope.originConnectionId === client.id) continue;
    if (envelope.event.type === 'typing' && envelope.event.userId === client.userId) continue;
    client.ws.send(data);
  }
}

function acquireChannel(conversationId: number): void {
  const next = (channelRefs.get(conversationId) ?? 0) + 1;
  channelRefs.set(conversationId, next);
  if (next === 1) {
    redisSubscriber.subscribe(channelFor(conversationId)).catch((err) => {
      console.error(`[ws] subscribe to conversation ${conversationId} failed: ${err.message}`);
    });
  }
}

function releaseChannel(conversationId: number): void {
  const next = (channelRefs.get(conversationId) ?? 1) - 1;
  if (next <= 0) {
    channelRefs.delete(conversationId);
    redisSubscriber.unsubscribe(channelFor(conversationId)).catch(() => {});
  } else {
    channelRefs.set(conversationId, next);
  }
}

function send(client: Client, payload: unknown): void {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(payload));
}

/** Exposed for the health endpoint — cheap visibility into what an instance is actually holding. */
export function hubStats() {
  return {
    instanceId: config.instanceId,
    connections: clients.size,
    subscribedConversations: channelRefs.size,
  };
}

export async function closeWs(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  for (const client of clients) {
    client.ws.close(1001, 'server shutting down');
  }
  clients.clear();
  await new Promise<void>((resolve) => {
    if (!wss) return resolve();
    wss.close(() => resolve());
  });
}
