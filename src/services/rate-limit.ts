import { config } from '../config.ts';
import type { RateLimitRule } from '../config/rate-limit-rules.ts';
import { redis } from '../db/redis.ts';
import { LUA_NOW_MS } from '../db/redis-time.ts';
import { withFallback } from '../util/resilience.ts';

/**
 * Rate limiting — tasks/rate-limiting.md
 *
 * Requirements and how each is met:
 *  - ~5 messages / 10s per conversation  -> configurable window + limit, set in
 *                                           rate-limit.config.json rather than in code
 *  - 429 + Retry-After                   -> `retryAfterMs` is the exact time until a slot frees
 *  - per user, not global                -> key is user:conversation, so one noisy sender only
 *                                           ever throttles themselves
 *  - survives multiple instances         -> state is in Redis, not process memory
 *
 * Sends were initially the only limited endpoint, which was a hole: `/api/search` fans out over
 * every message in the caller's conversations, so an unmetered loop of queries that match nothing
 * is a cheap way to generate unbounded read load. Reads now have their own buckets — separate
 * from sends, because the costs and the sensible limits are different.
 *
 * Five buckets, one mechanism: send, search, reads, create, typing. What each one meters, how it is
 * keyed and why its numbers are what they are lives in config/rate-limit-rules.ts, alongside the
 * config file that sets them.
 *
 * Sliding window over a sorted set rather than a fixed window: a fixed window lets someone send
 * 2x the limit across a window boundary, and can't produce an honest Retry-After.
 *
 * The whole check-and-increment is one Lua script so it's atomic. Three instances handling three
 * concurrent sends can't each read "4 used" and all decide to allow.
 */

const ALLOW = 1;

/**
 * KEYS[1] = window key
 * ARGV[1] = window length in ms
 * ARGV[2] = limit
 * ARGV[3] = unique member id for this attempt
 * returns { allowed, remaining, retryAfterMs }
 *
 * The clock comes from redis TIME rather than from the caller, so instances with skewed clocks
 * still agree on where the window starts. Redis replicates script *effects*, so a non
 * deterministic command like TIME is fine here.
 */
const SLIDING_WINDOW = `${LUA_NOW_MS}
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]

-- Drop everything that has aged out of the window.
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)

local used = redis.call('ZCARD', KEYS[1])
if used >= limit then
  -- The oldest entry in the window is the one whose expiry frees the next slot.
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then
    retry = (tonumber(oldest[2]) + window) - now
    if retry < 1 then retry = 1 end
  end
  return { 0, 0, retry }
end

redis.call('ZADD', KEYS[1], now, member)
-- Let the key expire on its own so idle users leave nothing behind.
redis.call('PEXPIRE', KEYS[1], window)
return { 1, limit - used - 1, 0 }
`;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** The window the limit applies over. Carried so a 429 can describe the rule it enforced. */
  windowMs: number;
  remaining: number;
  retryAfterMs: number;
  /** True when Redis was unreachable and we allowed the request without counting it. */
  degraded: boolean;
}

let attemptCounter = 0;

function consume(key: string, { limit, windowMs }: RateLimitRule): Promise<RateLimitResult> {
  // Unique per attempt so two sends in the same millisecond both count. A ZADD with a duplicate
  // member would overwrite rather than add, silently granting a free send.
  const member = `${config.instanceId}:${process.hrtime.bigint()}:${attemptCounter++}`;

  // Fail *open*. A chat app that refuses to deliver messages because its rate limiter is down has
  // turned a protection mechanism into an outage. `degraded: true` is what makes the route omit the
  // rate-limit headers, so a client can tell the limiter wasn't authoritative.
  const failOpen: RateLimitResult = {
    allowed: true,
    limit,
    windowMs,
    remaining: limit,
    retryAfterMs: 0,
    degraded: true,
  };

  return withFallback('rate-limit', failOpen, async () => {
    const [allowed, remaining, retryAfterMs] = (await redis.eval(
      SLIDING_WINDOW,
      1,
      key,
      String(windowMs),
      String(limit),
      member,
    )) as [number, number, number];

    return { allowed: allowed === ALLOW, limit, windowMs, remaining, retryAfterMs, degraded: false };
  });
}

/** Quota for sending a message: per user, per conversation. */
export function consumeSendQuota(userId: number, conversationId: number): Promise<RateLimitResult> {
  return consume(`relay:rl:send:${userId}:${conversationId}`, config.rateLimit.send);
}

/**
 * Quota for searching: per user, across all their conversations, because a search spans them.
 * Exposed as a full result so the route can surface Retry-After like sends do.
 */
export function consumeSearchQuota(userId: number): Promise<RateLimitResult> {
  return consume(`relay:rl:search:${userId}`, config.rateLimit.search);
}

/**
 * Quota for the list reads — the inbox and message history.
 *
 * One bucket for both, per user: they are the same kind of work (a bounded page for one user) and a
 * client that is looping does it over whichever endpoint is convenient, so metering them separately
 * would just double the allowance a loop gets. Far looser than search, which is the only read whose
 * cost grows with how much history the caller has.
 */
export function consumeReadQuota(userId: number): Promise<RateLimitResult> {
  return consume(`relay:rl:reads:${userId}`, config.rateLimit.reads);
}

/** Quota for creating conversations. Cheap per call, but unbounded growth isn't free. */
export function consumeCreateQuota(userId: number): Promise<RateLimitResult> {
  return consume(`relay:rl:create:${userId}`, config.rateLimit.create);
}

/** Looser quota for typing frames — same mechanism, separate bucket. */
export async function consumeTypingQuota(
  userId: number,
  conversationId: number,
): Promise<boolean> {
  const result = await consume(
    `relay:rl:typing:${userId}:${conversationId}`,
    config.rateLimit.typing,
  );
  return result.allowed;
}
