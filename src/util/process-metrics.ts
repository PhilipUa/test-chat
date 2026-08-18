/**
 * What this process is costing, for the autoscaler to scale on.
 *
 * Reported by /api/health rather than read from `docker stats`, so the signal works wherever the app runs
 * and one health call gives the autoscaler everything it needs. The arithmetic is separated from the
 * sampling because a scaling decision made from a wrong number is worse than no scaling at all — see
 * tests/process-metrics.test.mjs.
 */

export interface CpuSample {
  user: number;
  system: number;
}

/**
 * CPU used between two `process.cpuUsage()` samples, as a percentage of **one** core.
 *
 * One core, not all of them: a Node process is effectively single-threaded, so 100% here means the event
 * loop is saturated, which is the number worth scaling on. Expressed against every core it would sit near
 * 7% on a 15-core host while the process was completely pinned, and no sane watermark would ever fire.
 *
 * Deliberately not clamped at 100 — worker threads and libuv's pool can genuinely exceed one core, and
 * flattening that would hide the very situation the number exists to detect.
 *
 * @param before  cpuUsage() at the start of the interval
 * @param after   cpuUsage() at the end
 * @param elapsedMs wall-clock time between them
 */
export function cpuPercentBetween(before: CpuSample, after: CpuSample, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  // cpuUsage() is in microseconds; the interval is in milliseconds.
  const usedMicros = after.user - before.user + (after.system - before.system);
  if (usedMicros <= 0) return 0;
  return (usedMicros / (elapsedMs * 1_000)) * 100;
}

/**
 * Resident set size in whole MB.
 *
 * Absolute, not a percentage. A percentage needs a limit, and when no container memory limit is set the
 * only limit available is the host's RAM — which makes the percentage describe the host rather than the
 * process. An absolute number is unambiguous, and a watermark in MB is what an operator can reason about.
 */
export function memoryMbOf(residentBytes: number): number {
  return Math.round(residentBytes / (1024 * 1024));
}

/**
 * A rolling CPU percentage, refreshed on a timer.
 *
 * `cpuUsage()` is cumulative, so a single reading says nothing about *now* — it needs two samples and the
 * time between them. Sampling on an interval means /api/health can answer immediately with the last
 * computed value instead of blocking to measure.
 */
export function startCpuSampling(intervalMs: number): { cpuPercent: () => number; stop: () => void } {
  let previous = process.cpuUsage();
  let previousAt = Date.now();
  let percent = 0;

  const timer = setInterval(() => {
    const now = process.cpuUsage();
    const at = Date.now();
    percent = cpuPercentBetween(previous, now, at - previousAt);
    previous = now;
    previousAt = at;
  }, intervalMs);
  // Never hold the process open for a metric.
  timer.unref();

  return {
    cpuPercent: () => percent,
    stop: () => clearInterval(timer),
  };
}
