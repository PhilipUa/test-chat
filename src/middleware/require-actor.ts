import type { Request, RequestHandler } from 'express';
import { parseId } from '../validation/schemas.ts';

/**
 * Resolves which user a request is acting as, into `res.locals.actorId`.
 *
 * This is the seam where real authentication goes. Today the identity is a request parameter, which
 * is only safe against accidents — see docs/04-tradeoffs.md. When there is a session or a token,
 * this middleware reads it from there and every route below is unchanged.
 */
export type ActorSource = (req: Request) => unknown;

export const fromBody =
  (field: string): ActorSource =>
  (req) =>
    (req.body as Record<string, unknown> | undefined)?.[field];
export const fromQuery =
  (field: string): ActorSource =>
  (req) =>
    req.query?.[field];
export const fromParam =
  (field: string): ActorSource =>
  (req) =>
    req.params?.[field];

export function requireActor(source: ActorSource, field = 'userId'): RequestHandler {
  return (req, res, next) => {
    try {
      res.locals.actorId = parseId(source(req), field);
      next();
    } catch (err) {
      next(err);
    }
  };
}
