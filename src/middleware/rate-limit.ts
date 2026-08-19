import type { Request, RequestHandler, Response } from 'express';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import type { RateLimitRule } from '../config/rate-limit-rules.ts';
import { asyncHandler } from './async-handler.ts';
import { actorId } from './locals.ts';
import { consumeQuota, type RateLimitResult } from '../services/rate-limit.ts';

/**
 * Rate limiting as middleware — tasks/rate-limiting.md.
 *
 * Each route passes its own custom config where it is wired: the rule (the numbers — defaults in
 * config/rate-limit-rules.ts, env overrides applied at boot) and the key shape (what one allowance
 * covers: a user, or a user in a conversation). That keeps the numbers, the key and the endpoint
 * they protect in one place, checked by the compiler — there is no config file to drift from.
 *
 * The 429 response shape is written once here, so headers can't drift apart between endpoints, and
 * the route table shows which endpoints are metered.
 *
 * Placement in the chain is deliberate and worth preserving: this goes *after* validation and
 * authorization, so a request that was going to be rejected anyway doesn't spend anyone's quota.
 */
export interface RateLimitOptions {
  /** The custom config for this route: how many requests per window. */
  rule: RateLimitRule;
  /**
   * What one allowance covers — e.g. `send:${user}:${conversation}` or `reads:${user}`. Reads
   * res.locals, so it runs after the actor/participant middleware.
   */
  key: (req: Request, res: Response) => string;
  /**
   * Message for the 429, given the rule that was exceeded. Both numbers come from the result, so the
   * message can't describe a rule other than the one actually charged.
   */
  describe: (limit: number, windowSeconds: number) => string;
  /** Requests to let through unmetered — work that costs nothing shouldn't cost quota. */
  skip?: (req: Request, res: Response) => boolean;
}

export function rateLimit({ rule, key, describe, skip }: RateLimitOptions): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    if (skip?.(req, res)) {
      next();
      return;
    }

    const result: RateLimitResult = await consumeQuota(key(req, res), rule);

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
    throw HttpError.tooManyRequests(describe(result.limit, result.windowMs / 1000), {
      retryAfterMs: result.retryAfterMs,
      retryAfterSeconds,
    });
  });
}

/**
 * The shared `reads` bucket, wired once.
 *
 * `GET /api/messages` and `GET /api/conversations` both draw on it — one bucket, per user, because
 * they are the same kind of work (a bounded page for one user) and a client that loops does it
 * over whichever endpoint is to hand; two buckets would just hand a loop twice the allowance. A
 * copy of this per route is exactly how two endpoints' 429s drift apart. The route table still
 * names it, so what is metered stays visible where the chain is declared.
 */
export const rateLimitReads: RequestHandler = rateLimit({
  rule: config.rateLimit.reads,
  key: (_req, res) => `reads:${actorId(res)}`,
  describe: (limit, windowSeconds) =>
    `read rate limit exceeded: at most ${limit} list reads per ${windowSeconds}s`,
});
