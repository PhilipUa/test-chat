import { config } from '../config.ts';
import { redis } from '../db/redis.ts';

/**
 * Who is currently online.
 *
 * One sorted set per user, `relay:presence:<userId>`, whose members are that user's live
 * connections (`instanceId:connectionId`) scored by their last heartbeat. Online means "has at
 * least one member scored within the TTL".
 *
 * The first version of this tracked one timestamp per *user* and decided online/offline
 * transitions by combining that with the instance's own socket list. Those two sources disagree —
 * a stale timestamp, or a connection on another instance, and the transition is computed wrongly:
 * in testing it both suppressed a genuine "came online" and reported someone still online after
 * their last socket closed. Transitions are now derived entirely from the shared state, which is
 * the only place that knows the whole picture.
 *
 * Properties worth keeping:
 *  - **Self-healing.** An instance that dies without cleaning up leaves members that fall out of
 *    the TTL window on their own. Nobody is stranded as permanently online after a hard crash.
 *  - **Correct across instances**, because a user's connections on every instance land in the same
 *    key — the mistake the WebSocket hub originally made with in-process state.
 *  - **Atomic transitions.** Connect and disconnect each run as one script that prunes, mutates,
 *    and reports the count before and after, so two instances racing on the same user can't both
 *    conclude they caused the transition.
 */

const keyFor = (userId: number) => `relay:presence:${userId}`;

/**
 * Prune stale members, add/refresh this connection, report whether the user was offline before.
 * ARGV: [ttlMs, member]
 */
const CONNECT = `
local now_parts = redis.call('TIME')
local now = (tonumber(now_parts[1]) * 1000) + math.floor(tonumber(now_parts[2]) / 1000)
local ttl = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - ttl)
local before = redis.call('ZCARD', KEYS[1])
redis.call('ZADD', KEYS[1], now, ARGV[2])
-- Generous expiry so an idle key disappears on its own rather than lingering forever.
redis.call('PEXPIRE', KEYS[1], ttl * 2)
return before
`;

/** Prune, remove this connection, report how many remain. ARGV: [ttlMs, member] */
const DISCONNECT = `
local now_parts = redis.call('TIME')
local now = (tonumber(now_parts[1]) * 1000) + math.floor(tonumber(now_parts[2]) / 1000)
local ttl = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - ttl)
redis.call('ZREM', KEYS[1], ARGV[2])
return redis.call('ZCARD', KEYS[1])
`;

/**
 * Registers (or refreshes) a connection.
 * @returns true when this connection brought the user online — i.e. they had none before.
 */
export async function connectionOpened(userId: number, connectionId: string): Promise<boolean> {
  try {
    const before = (await redis.eval(
      CONNECT,
      1,
      keyFor(userId),
      String(config.presence.ttlMs),
      member(connectionId),
    )) as number;
    return Number(before) === 0;
  } catch (err) {
    // Presence is decorative; never let it break a connection.
    console.error(`[presence] open failed for user ${userId}: ${(err as Error).message}`);
    return false;
  }
}

/** Refreshes an existing connection from the heartbeat. */
export async function connectionHeartbeat(userId: number, connectionId: string): Promise<void> {
  await connectionOpened(userId, connectionId).catch(() => false);
}

/**
 * Deregisters a connection.
 * @returns true when this was the user's last one — i.e. they are now offline everywhere.
 */
export async function connectionClosed(userId: number, connectionId: string): Promise<boolean> {
  try {
    const remaining = (await redis.eval(
      DISCONNECT,
      1,
      keyFor(userId),
      String(config.presence.ttlMs),
      member(connectionId),
    )) as number;
    return Number(remaining) === 0;
  } catch (err) {
    console.error(`[presence] close failed for user ${userId}: ${(err as Error).message}`);
    return false;
  }
}

/** Filters the given user ids down to those with at least one live connection. */
export async function onlineAmong(userIds: number[]): Promise<Set<number>> {
  const unique = [...new Set(userIds)];
  if (!unique.length) return new Set();
  try {
    const now = await serverNowMs();
    const cutoff = now - config.presence.ttlMs;

    // One pipeline rather than a round trip per user — this runs on the conversation-list path.
    const pipeline = redis.pipeline();
    for (const id of unique) pipeline.zcount(keyFor(id), cutoff, '+inf');
    const results = await pipeline.exec();

    const online = new Set<number>();
    results?.forEach(([err, count], i) => {
      if (!err && Number(count) > 0) online.add(unique[i]!);
    });
    return online;
  } catch (err) {
    // Fail "everyone offline": an absent dot degrades better than a failed request, and it can
    // never imply someone is present when we don't actually know.
    console.error(`[presence] lookup failed: ${(err as Error).message}`);
    return new Set();
  }
}

const member = (connectionId: string) => `${config.instanceId}:${connectionId}`;

/**
 * Reads the clock from Redis rather than the app, for the same reason the rate limiter does:
 * instances with skewed clocks would otherwise disagree about who is online.
 */
async function serverNowMs(): Promise<number> {
  const [seconds, micros] = await redis.time();
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
}
