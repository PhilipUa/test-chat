import type { ErrorRequestHandler, RequestHandler } from 'express';
import { HttpError } from '../errors.ts';

/** Terminal middleware: turns anything thrown by a route into a response. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // If the response already started we can't turn it into a JSON error; just make sure the socket
  // closes rather than hanging the client.
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
  // JSON, 413 for a body over the size limit, 415 for the wrong content type. Honour it instead of
  // reporting a client error as a 500 — a 5MB body used to come back as "internal server error",
  // which tells the caller nothing about what to do differently.
  const parserStatus =
    (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  if (typeof parserStatus === 'number' && parserStatus >= 400 && parserStatus < 500) {
    const message =
      err instanceof SyntaxError ? 'invalid JSON body' : (err as Error).message || 'request rejected';
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
 * Last line of defence, outside the request cycle.
 *
 * An unhandled rejection in a WebSocket handler or a timer would otherwise exit the process
 * silently. We log loudly and stay up: behind a load balancer, a degraded instance beats a crash
 * loop.
 */
export function installProcessErrorHandlers(): void {
  process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
  process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
}
