import type { Request, Response } from 'express';
import { redis } from '../db/redis.ts';
import { withFallback } from '../util/resilience.ts';
import { hubStats } from '../ws/hub.ts';

/**
 * Readiness, and a window into which instance you're talking to.
 *
 * With `--scale api=3` behind a round-robin proxy, "which process served that?" is the first question
 * you have when debugging, and there was no way to answer it. Envoy also uses this to take a
 * restarting replica out of rotation.
 */

// Module load time. Lets a caller distinguish "this instance never restarted" from "the proxy sent me
// to a different instance" — indistinguishable from the instance id alone.
const startedAt = new Date().toISOString();

export async function health(_req: Request, res: Response): Promise<void> {
  const redisOk = await withFallback('health:redis', false, async () => {
    await redis.ping();
    return true;
  });
  res.json({ ok: true, redis: redisOk, startedAt, ...hubStats() });
}
