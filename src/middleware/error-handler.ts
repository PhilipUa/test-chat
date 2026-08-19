import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../errors.ts';

/** Terminal middleware: turns anything thrown by a route into a response. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // If the response already started we can't turn it into a JSON error; just make sure the socket
  // closes rather than hanging the client.
  if (res.headersSent) {
    res.destroy();
    return;
  }

  // The validate middleware converts schema failures to HttpError before they get here; this
  // catches a stray schema.parse() elsewhere, so a validation slip is a 400 that names the
  // problem rather than a 500 that hides it.
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues[0]?.message ?? 'invalid request' });
    return;
  }

  if (err instanceof HttpError) {
    const body: Record<string, unknown> = { error: err.message };
    if (err.details !== undefined) body.details = err.details;
    res.status(err.status).json(body);
    return;
  }

  // body-parser rejects bad input with an Error carrying its own HTTP status: 400 for malformed
  // JSON, 413 for a body over the size limit, 415 for the wrong content type. Honour it instead of
  // reporting a client error as a 500 — a 5MB body used to come back as "internal server error",
  // which tells the caller nothing about what to do differently.
  const parserStatus =
    (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  if (typeof parserStatus === 'number' && parserStatus >= 400 && parserStatus < 500) {
    const message =
      err instanceof SyntaxError
        ? 'invalid JSON body'
        : (err as Error).message || 'request rejected';
    res.status(parserStatus).json({ error: message });
    return;
  }

  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: 'internal server error' });
};

/** Mounted after the API routes so an unmatched /api path gets JSON, not the SPA. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
};

/**
 * Last line of defence, outside the request cycle — and the two cases are not the same.
 *
 * An **unhandled rejection** is usually a missing `.catch()` on something non-essential: a presence
 * refresh, a read receipt. The process is still sound, so log it loudly and carry on. Taking an
 * instance down for a dropped promise turns a small omission into an outage.
 *
 * An **uncaught exception** unwound the stack from somewhere we don't know, so half-applied state and
 * abandoned locks are both possible and the heap is no longer trustworthy. Both handlers used to just
 * log, which meant continuing to serve requests from a process in an undefined state. It now shuts
 * down and exits non-zero, which the surrounding infrastructure is built for: `restart: on-failure`
 * brings the replica back, the healthcheck keeps it out of rotation until it is ready, and Envoy
 * retries the connection failures in between. That wasn't true when the original comment was written
 * — "a degraded instance beats a crash loop" was the right call before any of it existed.
 *
 * Split from its registration so the policy is testable without attaching listeners to the real
 * process.
 */
export function processErrorHandlers(onFatal: (err: unknown) => void) {
  return {
    unhandledRejection: (reason: unknown): void => {
      console.error('[unhandledRejection]', reason);
    },
    uncaughtException: (err: unknown): void => {
      console.error('[uncaughtException]', err);
      onFatal(err);
    },
  };
}

export function installProcessErrorHandlers(onFatal: (err: unknown) => void): void {
  const handlers = processErrorHandlers(onFatal);
  process.on('unhandledRejection', handlers.unhandledRejection);
  process.on('uncaughtException', handlers.uncaughtException);
}
