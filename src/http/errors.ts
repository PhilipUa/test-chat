import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Finding A: Express 4 does not catch a rejected promise from an `async` handler. The rejection
 * became an unhandledRejection, which terminates Node 22 — so any request that tripped a DB
 * constraint restarted the API and dropped every WebSocket on that instance. Everything below
 * exists to make a failed request produce a response instead of an outage.
 */

/** An error with an intended HTTP status. Anything else is a 500 and gets logged in full. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  static badRequest(message: string, details?: unknown) {
    return new HttpError(400, message, details);
  }
  static forbidden(message: string) {
    return new HttpError(403, message);
  }
  static notFound(message: string) {
    return new HttpError(404, message);
  }
  static tooManyRequests(message: string, details?: unknown) {
    return new HttpError(429, message, details);
  }
  static unavailable(message: string) {
    return new HttpError(503, message);
  }
}

/** Wraps an async route handler so a rejection reaches the Express error middleware. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // If the response already started we can't turn it into a JSON error; just make sure the
  // socket closes rather than hanging the client.
  if (res.headersSent) {
    res.destroy();
    return;
  }

  if (err instanceof HttpError) {
    const body: Record<string, unknown> = { error: err.message };
    if (err.details !== undefined) body.details = err.details;
    res.status(err.status).json(body);
    return;
  }

  // body-parser rejects bad input with an Error carrying its own HTTP status: 400 for malformed
  // JSON, 413 for a body over the size limit, 415 for the wrong content type. Honour it instead
  // of reporting a client error as a 500 — a 5MB body was coming back as "internal server error",
  // which tells the caller nothing about what to do differently.
  const parserStatus = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode;
  if (typeof parserStatus === 'number' && parserStatus >= 400 && parserStatus < 500) {
    const message =
      err instanceof SyntaxError
        ? 'invalid JSON body'
        : ((err as Error).message || 'request rejected');
    res.status(parserStatus).json({ error: message });
    return;
  }

  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: 'internal server error' });
};

/**
 * Last line of defence. An unhandled rejection anywhere outside a request (a WebSocket handler,
 * a timer) would otherwise exit the process silently. We log loudly and stay up; a crash loop
 * behind a load balancer is worse than a degraded instance.
 */
export function installProcessErrorHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
  });
}
