import type { Response } from 'express';
import { HttpError } from './errors.ts';
import type { RateLimitResult } from '../services/rate-limit.ts';

/**
 * Applies a rate-limit decision to a response: sets the informational headers, and throws a 429
 * carrying Retry-After when the caller is over.
 *
 * Extracted so every limited endpoint produces an identical 429 — the send route grew this logic
 * inline first, and copying it per endpoint is how the headers drift apart.
 */
export function enforceRateLimit(
  res: Response,
  result: RateLimitResult,
  describe: (limit: number) => string,
): void {
  // A degraded (Redis-down) result is allowed but not authoritative, so we deliberately omit the
  // headers rather than publish numbers we didn't actually enforce.
  if (!result.degraded) {
    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  }
  if (result.allowed) return;

  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  res.setHeader('Retry-After', String(retryAfterSeconds));
  throw HttpError.tooManyRequests(describe(result.limit), {
    retryAfterMs: result.retryAfterMs,
    retryAfterSeconds,
  });
}
