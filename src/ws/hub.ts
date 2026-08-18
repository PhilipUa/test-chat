import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from '../config.ts';
import { redisSubscriber } from '../db/redis.ts';
import * as channels from './channels.ts';
import { conversationIdFromChannel, type FanoutEnvelope } from './events.ts';
import { deliverLocally } from './fanout.ts';
import { deregisterAll, handleDisconnect, handleFrame } from './protocol.ts';
import * as registry from './registry.ts';

/**
 * WebSocket wiring.
 *
 * This file was 377 lines and owned eight things: the connection registry, frame parsing, protocol
 * dispatch, subscription authorization, typing, presence orchestration, refcounted Redis channels,
 * the heartbeat, and fan-out. It now owns only the wiring between them:
 *
 *   registry.ts   the client set, heartbeat, sending
 *   channels.ts   refcounted Redis subscribe/unsubscribe
 *   fanout.ts     publish + local delivery
 *   protocol.ts   what each client frame means
 *   hub.ts        this — attach, resync, shut down
 */

let wss: WebSocketServer | undefined;

/**
 * Whether our Redis subscriber is currently connected.
 *
 * Redis pub/sub is at-most-once: anything published while this instance is disconnected is gone,
 * and — crucially — the client's WebSocket stays open throughout, so the browser has no idea it
 * stopped receiving. When the subscriber recovers we tell every local client to resync, and they
 * pull what they missed via `GET /api/messages?since=`.
 */
let subscriberConnected = true;

export function attachWs(server: Server): void {
  wss = new WebSocketServer({ server, path: '/' });

  wss.on('connection', (ws) => {
    const client = registry.add(ws);

    // `ws` emits 'error' on an abrupt disconnect, and an unhandled 'error' on an EventEmitter is
    // thrown — which is another way to take the process down.
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
        registry.send(client, { type: 'error', error: 'could not handle that frame' });
      });
    });

    ws.on('close', () => {
      registry.remove(client);
      const subs = [...client.subs];
      for (const id of subs) channels.release(id);
      client.subs.clear();
      void handleDisconnect(client, subs);
    });
  });

  wss.on('error', (err) => console.error('[ws] server error:', err));

  registry.startHeartbeat();
  watchSubscriberHealth();

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

/**
 * ioredis re-issues SUBSCRIBE for us on reconnect, so the gap is bounded by the outage — but the
 * events published during it are lost, which is what the resync nudge is for.
 */
function watchSubscriberHealth(): void {
  const markDown = () => {
    subscriberConnected = false;
  };
  redisSubscriber.on('end', markDown);
  redisSubscriber.on('close', markDown);
  redisSubscriber.on('ready', () => {
    if (subscriberConnected) return;
    subscriberConnected = true;
    console.warn('[ws] redis subscriber reconnected; asking clients to resync');
    for (const client of registry.all()) {
      registry.send(client, { type: 'resync', reason: 'realtime-reconnected' });
    }
  });
}

/** Cheap visibility into what an instance is actually holding — used by /api/health. */
export function hubStats() {
  return {
    instanceId: config.instanceId,
    connections: registry.count(),
    subscribedConversations: channels.subscribedCount(),
    realtimeConnected: subscriberConnected,
  };
}

export async function closeWs(): Promise<void> {
  registry.stopHeartbeat();

  // Deregister presence before we go. Without this, a rolling deploy leaves every connected user
  // looking online for the whole presence TTL.
  await deregisterAll(registry.all());

  registry.closeAll('server shutting down');
  await new Promise<void>((resolve) => {
    if (!wss) return resolve();
    wss.close(() => resolve());
  });
}

// Routes publish through the hub, so keep the entry point here rather than making callers reach
// into ws/fanout.ts directly.
export { publish } from './fanout.ts';
