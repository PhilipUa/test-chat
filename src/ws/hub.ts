import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from '../config.ts';
import { redisSubscriber } from '../db/redis.ts';
import * as channels from './channels.ts';
import { conversationIdFromChannel, type FanoutEnvelope } from './events.ts';
import { deliverLocally } from './fanout.ts';
import { deregisterAll, handleDisconnect, handleFrame, releaseClient } from './protocol.ts';
import * as registry from './registry.ts';
import { parseJson } from '../util/resilience.ts';

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
      // RawData is Buffer | ArrayBuffer | Buffer[]; normalise explicitly rather than relying on
      // toString(), which stringifies an ArrayBuffer as '[object ArrayBuffer]'.
      const text = Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.from(raw).toString('utf8');
      // Never let a malformed or hostile frame reject into the void.
      void handleFrame(client, text).catch((err) => {
        console.error('[ws] frame handling failed:', err);
        registry.send(client, { type: 'error', error: 'could not handle that frame' });
      });
    });

    ws.on('close', () => {
      // One call owns the whole teardown — marking the client closed, releasing its channels, and
      // reporting what it held. An in-flight frame handler checks that closed flag after every await,
      // so it can no longer acquire anything on behalf of this socket.
      const subs = releaseClient(client);
      void handleDisconnect(client, subs);
    });
  });

  wss.on('error', (err) => console.error('[ws] server error:', err));

  registry.startHeartbeat();
  watchSubscriberHealth();

  redisSubscriber.on('message', (channel, payload) => {
    const conversationId = conversationIdFromChannel(channel);
    if (conversationId === undefined) return;
    const envelope = parseJson<FanoutEnvelope>(payload);
    if (!envelope) return;
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

    // ioredis re-issues SUBSCRIBE only for channels it had acknowledged. Any channel acquired *during*
    // the outage was never subscribed and nothing else would ever retry it — the client re-sends
    // `subscribe`, reconcile sees no difference, and that conversation stays silent for the life of the
    // process. Retry them here, where we already know realtime just came back.
    void channels.resubscribeUnconfirmed().then((retried) => {
      if (retried) console.warn(`[ws] resubscribed ${retried} channel(s) that had not landed`);
    });

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

/**
 * Shuts the realtime side down, in the order that actually terminates.
 *
 * Each phase is timed, because this is on the critical path of every scale-down and redeploy and "the
 * shutdown is slow" is otherwise unattributable.
 */
export async function closeWs(): Promise<void> {
  registry.stopHeartbeat();

  // Deregister presence before we go. Without this, a rolling deploy leaves every connected user
  // looking online for the whole presence TTL.
  const deregisterStarted = Date.now();
  await deregisterAll(registry.all());
  console.log(`[shutdown] presence deregistered in ${Date.now() - deregisterStarted}ms`);

  // Ask politely first: 1001 is what tells a browser to reconnect elsewhere rather than treating this
  // as an error. Then stop waiting — a close handshake needs the peer to reply, and ws will sit on an
  // unanswered one for 30 seconds while its client set stays non-empty.
  registry.closeAll('server shutting down');
  const graceStarted = Date.now();
  // Long enough for a close handshake to complete, short enough to stay well inside the force-exit. 1s was
  // not enough: draining six sockets at once left two of them terminated mid-handshake, which the client
  // sees as 1006 (abnormal) rather than 1001 (server going away). Both make a browser reconnect, so nothing
  // was lost — but 1006 in a log reads as a network fault rather than a planned drain, which is exactly the
  // wrong story to tell about a scale-down.
  const graceMs = 3_000;
  const step = 50;
  for (let i = 0; i < graceMs / step && registry.openCount() > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  const stillOpen = registry.openCount();
  registry.terminateAll();
  console.log(
    `[shutdown] sockets closed in ${Date.now() - graceStarted}ms` +
      (stillOpen ? ` (${stillOpen} terminated without replying)` : ''),
  );

  const serverStarted = Date.now();
  await new Promise<void>((resolve) => {
    if (!wss) return resolve();
    wss.close(() => resolve());
  });
  console.log(`[shutdown] ws server closed in ${Date.now() - serverStarted}ms`);
}

// Routes publish through the hub, so keep the entry point here rather than making callers reach
// into ws/fanout.ts directly.
export { publish } from './fanout.ts';
