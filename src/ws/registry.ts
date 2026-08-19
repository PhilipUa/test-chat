import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { config } from '../config.ts';
import { connectionHeartbeat } from '../services/presence.ts';

/**
 * The connection registry: which sockets this instance holds, and keeping them alive.
 *
 * One of five modules that used to be ws/hub.ts, a 377-line file with eight reasons to change.
 * This one owns the client set and the heartbeat, and nothing else — it knows nothing about
 * conversations, events, or Redis.
 */

export interface Client {
  id: string;
  ws: WebSocket;
  userId?: number;
  /** Conversations this socket is subscribed to, already filtered to ones the user is in. */
  subs: Set<number>;
  /**
   * The Redis channels held on this socket's behalf: one per conversation in `subs`, plus the
   * socket's own user channel. Derived from the two above, but stored rather than recomputed — see
   * ws/subscriptions.ts, which owns both sets.
   */
  channels: Set<string>;
  /** Cleared on pong; a socket that misses two heartbeats is terminated. */
  missedPings: number;
  /**
   * Set once this socket is gone.
   *
   * Frame handling is async, so a frame can still be mid-flight when the close event fires — the
   * handler resumes after its await and would otherwise go on mutating shared state on behalf of a
   * connection that no longer exists. Anything that acquires a resource must check this after every
   * await; see ws/protocol.ts.
   */
  closed: boolean;
}

const clients = new Set<Client>();
let heartbeat: NodeJS.Timeout | undefined;

export function add(ws: WebSocket): Client {
  const client: Client = {
    id: crypto.randomUUID(),
    ws,
    subs: new Set(),
    channels: new Set(),
    missedPings: 0,
    closed: false,
  };
  clients.add(client);
  return client;
}

/**
 * Drops a client from the set and marks it closed, so an in-flight frame handler can tell.
 *
 * Deliberately does not touch Redis channels or presence: this module owns the socket set and
 * nothing else. Releasing what the client held is ws/subscriptions.ts's `releaseClient`, which is
 * the one function that owns the whole teardown.
 */
export function markClosed(client: Client): void {
  client.closed = true;
  clients.delete(client);
}

export function all(): Iterable<Client> {
  return clients;
}

export function count(): number {
  return clients.size;
}

/** Sockets belonging to `userId` that are still open. */
export function openConnectionsOf(userId: number): Client[] {
  return [...clients].filter((c) => c.userId === userId && c.ws.readyState === WebSocket.OPEN);
}

export function send(client: Client, payload: unknown): void {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(payload));
}

/** Broadcast a raw pre-serialised frame to clients matching `predicate`. */
export function sendRaw(data: string, predicate: (client: Client) => boolean): void {
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (!predicate(client)) continue;
    client.ws.send(data);
  }
}

/**
 * Without a heartbeat, sockets that died without a close frame are never reaped — the set grows and
 * we keep writing to nobody. Presence is refreshed from the same tick, so it stays true for exactly
 * as long as a socket is genuinely alive.
 */
export function startHeartbeat(): void {
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
    for (const client of live) void connectionHeartbeat(client.userId!, client.id);
  }, config.ws.heartbeatIntervalMs);
  heartbeat.unref();
}

export function stopHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
}

/**
 * Asks every client to go away, politely: 1001 tells a browser to reconnect somewhere else.
 *
 * `ws.close()` starts a close *handshake*, so these sockets are not gone when this returns — see
 * terminateAll, which is what stops the shutdown waiting on a peer that never replies.
 */
export function closeAll(reason: string): void {
  for (const client of clients) {
    client.closed = true;
    client.ws.close(1001, reason);
  }
}

/** How many of the sockets we asked to leave are still open. */
export function openCount(): number {
  let open = 0;
  for (const client of clients) if (client.ws.readyState !== WebSocket.CLOSED) open += 1;
  return open;
}

/**
 * Destroys whatever is left, and empties the set.
 *
 * WebSocketServer.close() only calls back once its client set is empty, and a half-finished close
 * handshake keeps a socket in it — ws waits up to 30s for the peer's reply. So a shutdown that only
 * asked nicely never completed: it sat here until the force-exit killed it, skipping every step after
 * this one.
 */
export function terminateAll(): void {
  for (const client of clients) {
    client.closed = true;
    client.ws.terminate();
  }
  clients.clear();
}
