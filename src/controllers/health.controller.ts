import type { Request, Response } from 'express';
import { redis } from '../db/redis.ts';
import { requestsPerMinute } from '../middleware/request-rate.ts';
import { memoryMbOf, startCpuSampling } from '../util/process-metrics.ts';
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

/**
 * Rolling CPU, so this endpoint can answer immediately instead of blocking to measure.
 *
 * `cpuUsage()` is cumulative: one reading says nothing about now. 5s is short enough to notice a spike and
 * long enough not to report noise as load — a scaler acting on a 200ms window would chase its own tail.
 */
const cpu = startCpuSampling(5_000);

export async function health(_req: Request, res: Response): Promise<void> {
  const redisOk = await withFallback('health:redis', false, async () => {
    await redis.ping();
    return true;
  });

  res.json({
    ok: true,
    redis: redisOk,
    startedAt,
    ...hubStats(),
    // What this replica currently costs. Reported here rather than scraped from `docker stats` so the
    // autoscaler gets every signal it can scale on from one call, and so the signal survives running the
    // app anywhere else. See scripts/autoscale-policy.mjs for what each one means.
    cpuPercent: Number(cpu.cpuPercent().toFixed(1)),
    memoryMb: memoryMbOf(process.memoryUsage().rss),
    requestsPerMinute: requestsPerMinute(),
  });
}
