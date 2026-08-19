import type { Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { HttpError } from '../errors.ts';

/**
 * Schema validation as middleware: each route names its Zod schema in the route table, and the
 * controller reads the checked, transformed value back out of res.locals through the typed
 * accessors in locals.ts. Runs *before* the rate limiter, so a malformed request costs a 400 that
 * says what to fix rather than spending quota.
 *
 * `store` writes into the named res.locals slot — the same hand-off contract the rest of the
 * middleware chain uses — so TypeScript checks that a route stores exactly the shape its
 * controller will read.
 */
export function validate<T>(
  pick: (req: Request) => unknown,
  schema: ZodType<T>,
  store: (res: Response, value: T) => void,
): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(pick(req));
    if (!result.success) {
      const problems = result.error.issues.map((issue) => issue.message);
      // Lead with the first problem — the old parsers reported one at a time and clients display
      // `error` — but carry the rest, so a request wrong in two ways is fixable in one round trip.
      next(
        HttpError.badRequest(
          problems[0] ?? 'invalid request',
          problems.length > 1 ? { problems } : undefined,
        ),
      );
      return;
    }
    store(res, result.data);
    next();
  };
}

export const validateBody = <T>(
  schema: ZodType<T>,
  store: (res: Response, value: T) => void,
): RequestHandler => validate((req) => req.body, schema, store);

export const validateQuery = <T>(
  schema: ZodType<T>,
  store: (res: Response, value: T) => void,
): RequestHandler => validate((req) => req.query, schema, store);
