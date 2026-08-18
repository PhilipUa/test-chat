/**
 * Error-handling helpers, so failure policy is named at the call site instead of re-implemented in
 * an ad-hoc try/catch each time.
 *
 * The codebase had four copies of `try { … } catch { console.error(…); return fallback }` and six
 * copies of `.catch(() => {})`. The second kind is the worse of the two: a swallowed failure leaves
 * no trace, so "presence is wrong" or "the inbox sort is stale" becomes unexplainable. Naming the
 * policy makes it reviewable — you can see at a glance whether a call is allowed to fail and what
 * happens when it does.
 *
 * What deliberately does *not* belong here: catches that are control flow rather than error
 * handling. `createMessage` catching a duplicate-key error to recover the winning row, and
 * `insertMessage` deleting its MySQL row when the Mongo write fails, are both decisions about what
 * to do next — not "log it and carry on".
 */

/** Log at most once per label per window, so a flapping dependency can't drown the log. */
const THROTTLE_MS = 5_000;
const lastLoggedAt = new Map<string, number>();

export function logThrottled(label: string, message: string): void {
  const now = Date.now();
  const previous = lastLoggedAt.get(label) ?? 0;
  if (now - previous < THROTTLE_MS) return;
  lastLoggedAt.set(label, now);
  console.error(`[${label}] ${message}`);
}

const describe = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Runs `fn`, and returns `fallback` if it throws.
 *
 * For work whose failure should degrade a feature rather than fail a request: presence going quiet,
 * or the rate limiter failing open. The fallback is passed in, so the degraded behaviour is visible
 * at the call site rather than buried in a catch block.
 */
export async function withFallback<T>(
  label: string,
  fallback: T,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logThrottled(label, describe(err));
    return fallback;
  }
}

/**
 * Awaits work for its side effect only, logging rather than hiding a failure.
 *
 * Replaces `.catch(() => {})`. The behaviour is the same — the caller carries on — but the failure
 * is now visible, which is the entire difference between "best effort" and "silently broken".
 *
 * Returns whether it succeeded, so "try this, otherwise do that" reads as a branch instead of
 * needing a nested catch.
 */
export async function bestEffort(
  label: string,
  work: Promise<unknown> | (() => Promise<unknown>),
): Promise<boolean> {
  try {
    await (typeof work === 'function' ? work() : work);
    return true;
  } catch (err) {
    logThrottled(label, describe(err));
    return false;
  }
}

/**
 * JSON.parse that returns undefined instead of throwing.
 *
 * Every caller of this is parsing something that arrived over the network, where malformed input is
 * expected rather than exceptional — a hostile WebSocket frame, or a Redis payload. Three places
 * each wrapped JSON.parse in its own try/catch to reach exactly this behaviour.
 */
export function parseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
