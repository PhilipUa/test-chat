/**
 * Error-handling helpers for the client, mirroring src/util/resilience.ts.
 *
 * Same reasoning: name the failure policy at the call site instead of writing another try/catch, and
 * never swallow a failure without a trace. The browser copy is separate rather than shared because
 * web/ has no build step — the server module is TypeScript and imports Node APIs.
 */

const THROTTLE_MS = 5_000;
const lastLoggedAt = new Map();

export function logThrottled(label, message) {
  const now = Date.now();
  if (now - (lastLoggedAt.get(label) ?? 0) < THROTTLE_MS) return;
  lastLoggedAt.set(label, now);
  console.warn(`[${label}] ${message}`);
}

const describe = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Awaits work for its side effect only, logging rather than hiding a failure.
 *
 * Replaces `.catch(() => {})`. On the client these are genuinely non-fatal — a failed read receipt
 * or a failed catch-up corrects itself on the next event or reload — but "non-fatal" is not the same
 * as "not worth knowing about" when someone reports the badge being wrong.
 */
export async function bestEffort(label, work) {
  try {
    await (typeof work === 'function' ? work() : work);
    return true;
  } catch (err) {
    logThrottled(label, describe(err));
    return false;
  }
}

/** JSON.parse that returns undefined instead of throwing, for anything off the network. */
export function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * The largest value in a set, or 0 when it's empty.
 *
 * `Math.max(0, ...set)` spreads the set as function arguments, which is a RangeError past roughly
 * 65k of them — so scrolling far enough back through a long conversation broke every read receipt
 * from that point on.
 */
export function maxOf(values) {
  let max = 0;
  for (const value of values) if (value > max) max = value;
  return max;
}
