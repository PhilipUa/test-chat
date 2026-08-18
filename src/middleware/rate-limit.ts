import type { Request, RequestHandler, Response } from 'express';
import { HttpError } from '../errors.ts';
import { asyncHandler } from './async-handler.ts';
import type { RateLimitResult } from '../services/rate-limit.ts';

/**
 * Rate limiting as middleware — tasks/rate-limiting.md.
 *
 * Previously each handler called the limiter inline and formatted its own 429, which is how the
 * headers drift apart between endpoints. Here the response shape is written once and the route table
 * shows which endpoints are metered.
 *
 * Placement in the chain is deliberate and worth preserving: this goes *after* validation and
 * authorization, so a request that was going to be rejected anyway doesn't spend anyone's quota.
 */
export interface RateLimitOptions {
  /** Which bucket to charge. Reads res.locals, so it runs after the actor/participant middleware. */
  consume: (req: Request, res: Response) => Promise<RateLimitResult>;
  /** Message for the 429, given the limit that was exceeded. */
  describe: (limit: number) => string;
  /** Requests to let through unmetered — work that costs nothing shouldn't cost quota. */
  skip?: (req: Request) => boolean;
}

export function rateLimit({ consume, describe, skip }: RateLimitOptions): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    if (skip?.(req)) {
      next();
      return;
    }

    const result = await consume(req, res);

    // A degraded (Redis-down) result was allowed but not enforced, so we deliberately omit the
    // headers rather than publishing numbers we didn't actually apply.
    if (!result.degraded) {
      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    }

    if (result.allowed) {
      next();
      return;
    }

    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    throw HttpError.tooManyRequests(describe(result.limit), {
      retryAfterMs: result.retryAfterMs,
      retryAfterSeconds,
    });
  });
}
