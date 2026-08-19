import { redis } from './redis.ts';

/**
 * The shared clock.
 *
 * The rate limiter and presence both need "now", and both must read it from Redis rather than from
 * the process: three instances with skewed clocks would otherwise disagree about where a rate-limit
 * window starts and about who is online. Redis replicates script *effects*, so calling TIME inside
 * a script is fine.
 *
 * This preamble was copy-pasted into three Lua scripts across two files. It's one string now —
 * deliberately not a "script runner" abstraction, which would be more machinery than the problem
 * deserves.
 */
export const LUA_NOW_MS = `
local now_parts = redis.call('TIME')
local now = (tonumber(now_parts[1]) * 1000) + math.floor(tonumber(now_parts[2]) / 1000)
`;

/** The same clock, read from application code. */
export async function redisNowMs(): Promise<number> {
  const [seconds, micros] = await redis.time();
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
}
