import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from '../config.ts';
import { redis, redisSubscriber } from '../db/redis.ts';
import { participantConversationIds, participantIdsOf } from '../services/conversations.ts';
import { getUserName } from '../services/users.ts';
import {
  connectionClosed,
  connectionHeartbeat,
  connectionOpened,
  onlineAmong,
} from '../services/presence.ts';
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
/**
 * Whether our Redis subscriber is currently connected.
 *
 * Redis pub/sub is at-most-once: anything published while this instance is disconnected from Redis
 * is gone, and — crucially — the client's WebSocket stays open throughout, so the browser has no
 * idea it stopped receiving. That was a silent hole. When the subscriber recovers we tell every
 * local client to resync, and they pull what they missed via `GET /api/messages?since=`.
 */
let subscriberConnected = true;

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
      const subs = [...client.subs];
      for (const id of subs) releaseChannel(id);
      client.subs.clear();
      void handleDisconnect(client, subs);
    });
  });

  wss.on('error', (err) => console.error('[ws] server error:', err));

  // Finding K: without a heartbeat, sockets that died without a close frame are never reaped —
  // the client set grows and we keep writing to nobody.
  heartbeat = setInterval(() => {
    const live: Client[] = [];
    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (client.missedPings >= 2) {
        client.ws.terminate();
        continue;
      }
      client.missedPings += 1;
      client.ws.ping();
      if (client.userId) live.push(client);
    }
    // Presence is refreshed per connection from the heartbeat, so it stays true exactly as long
    // as a socket is genuinely alive — and ages out on its own if the process dies.
    for (const client of live) void connectionHeartbeat(client.userId!, client.id);
  }, config.ws.heartbeatIntervalMs);
  heartbeat.unref();

  // ioredis re-issues SUBSCRIBE for us on reconnect, so the gap is bounded by the outage — but
  // the events published during it are lost, which is what the resync nudge is for.
  redisSubscriber.on('end', () => {
    subscriberConnected = false;
  });
  redisSubscriber.on('close', () => {
    subscriberConnected = false;
  });
  redisSubscriber.on('ready', () => {
    if (subscriberConnected) return;
    subscriberConnected = true;
    console.warn('[ws] redis subscriber reconnected; asking clients to resync');
    for (const client of clients) {
      send(client, { type: 'resync', reason: 'realtime-reconnected' });
    }
  });

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

  // Presence: register this connection and announce only if it's what brought the user online.
  // The registry itself reports that, so we never have to infer it from this instance's own
  // socket list — which is what previously got the transition wrong.
  const cameOnline = await connectionOpened(userId, client.id);
  if (cameOnline) await announcePresence(userId, [...next], true);

  // Snapshot of who else is already online, so the client isn't blind until the next change.
  await sendPresenceSnapshot(client);
}

/** Tells the client which participants of its conversations are online right now. */
async function sendPresenceSnapshot(client: Client): Promise<void> {
  if (!client.subs.size) return;
  const byConversation = await Promise.all(
    [...client.subs].map(async (conversationId) => {
      const participants = await participantIdsOf(conversationId);
      const online = await onlineAmong(participants.filter((id) => id !== client.userId));
      return { conversationId, online: [...online] };
    }),
  );
  send(client, { type: 'presence-snapshot', conversations: byConversation });
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
async function handleDisconnect(client: Client, wasSubscribedTo: number[]): Promise<void> {
  const userId = client.userId;
  if (!userId) return;

  // The registry deregisters this one connection and tells us whether any remain — on any
  // instance, in any tab. Only the connection that empties it announces the user offline.
  const wentOffline = await connectionClosed(userId, client.id);
  if (wentOffline) await announcePresence(userId, wasSubscribedTo, false);
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
    // You don't need to be told about your own presence.
    if (envelope.event.type === 'presence' && envelope.event.userId === client.userId) continue;
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
    realtimeConnected: subscriberConnected,
  };
}

export async function closeWs(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);

  // Deregister our connections before we go. Without this, a rolling deploy leaves every
  // connected user looking online for the whole presence TTL: the members are ours, the instance
  // that owned them is gone, and nothing else can tell the difference between "stale" and
  // "genuinely connected elsewhere". The TTL would clean it up eventually — but "eventually" is
  // exactly the wrong answer during a deploy.
  await Promise.allSettled(
    [...clients]
      .filter((c) => c.userId)
      .map((c) => connectionClosed(c.userId!, c.id)),
  );

  for (const client of clients) {
    client.ws.close(1001, 'server shutting down');
  }
  clients.clear();
  await new Promise<void>((resolve) => {
    if (!wss) return resolve();
    wss.close(() => resolve());
  });
}
