import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async handler so a rejection reaches the error middleware.
 *
 * Express 4 does not catch a rejected promise from an `async` handler: the rejection becomes an
 * unhandledRejection, which terminates Node. That is how a request tripping a DB constraint used to
 * restart the API and drop every WebSocket on it. Every async route goes through here.
 *
 * Express 5 handles this natively, at which point this becomes deletable.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
