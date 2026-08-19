import { config } from '../config.ts';
import { redis } from '../db/redis.ts';
import { LUA_NOW_MS, redisNowMs } from '../db/redis-time.ts';
import { withFallback } from '../util/resilience.ts';

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
const CONNECT = `${LUA_NOW_MS}
local ttl = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - ttl)
local before = redis.call('ZCARD', KEYS[1])
redis.call('ZADD', KEYS[1], now, ARGV[2])
-- Generous expiry so an idle key disappears on its own rather than lingering forever.
redis.call('PEXPIRE', KEYS[1], ttl * 2)
return before
`;

/** Prune, remove this connection, report how many remain. ARGV: [ttlMs, member] */
const DISCONNECT = `${LUA_NOW_MS}
local ttl = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - ttl)
redis.call('ZREM', KEYS[1], ARGV[2])
return redis.call('ZCARD', KEYS[1])
`;

/**
 * Registers (or refreshes) a connection.
 * @returns true when this connection brought the user online — i.e. they had none before.
 */
export function connectionOpened(userId: number, connectionId: string): Promise<boolean> {
  // false = "this didn't bring them online", so a failure announces nothing rather than announcing
  // wrongly. Presence is decorative; it must never break a connection.
  return withFallback('presence:open', false, async () => {
    const before = (await redis.eval(
      CONNECT,
      1,
      keyFor(userId),
      String(config.presence.ttlMs),
      member(connectionId),
    )) as number;
    return Number(before) === 0;
  });
}

/** Refreshes an existing connection from the heartbeat. */
export async function connectionHeartbeat(userId: number, connectionId: string): Promise<void> {
  await connectionOpened(userId, connectionId).catch(() => false);
}

/**
 * Deregisters a connection.
 * @returns true when this was the user's last one — i.e. they are now offline everywhere.
 */
export function connectionClosed(userId: number, connectionId: string): Promise<boolean> {
  // false = "they still have connections", so a failure leaves them online until the TTL expires
  // rather than reporting a departure that may not have happened.
  return withFallback('presence:close', false, async () => {
    const remaining = (await redis.eval(
      DISCONNECT,
      1,
      keyFor(userId),
      String(config.presence.ttlMs),
      member(connectionId),
    )) as number;
    return Number(remaining) === 0;
  });
}

/** Filters the given user ids down to those with at least one live connection. */
export function onlineAmong(userIds: number[]): Promise<Set<number>> {
  const unique = [...new Set(userIds)];
  if (!unique.length) return Promise.resolve(new Set());

  // Fall back to "everyone offline": an absent dot degrades better than a failed request, and it can
  // never imply someone is present when we don't actually know.
  return withFallback('presence:lookup', new Set<number>(), async () => {
    const now = await redisNowMs();
    const cutoff = now - config.presence.ttlMs;

    // One pipeline rather than a round trip per user — this runs on the conversation-list path.
    const pipeline = redis.pipeline();
    for (const id of unique) pipeline.zcount(keyFor(id), cutoff, '+inf');
    const results = await pipeline.exec();

    const online = new Set<number>();
    results?.forEach(([err, count], i) => {
      if (!err && Number(count) > 0) online.add(unique[i]);
    });
    return online;
  });
}

const member = (connectionId: string) => `${config.instanceId}:${connectionId}`;
