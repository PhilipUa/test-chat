import express, { type Express } from 'express';
import { errorHandler } from './middleware/error-handler.ts';
import { instanceHeader } from './middleware/instance-header.ts';
import { apiRouter } from './routes/index.ts';

/**
 * Builds the Express application.
 *
 * Separated from the server bootstrap so the app can be constructed without opening a port or
 * connecting to anything — which is what makes it testable in-process, and keeps "what the HTTP
 * surface is" readable in one screen instead of interleaved with migrations and shutdown handling.
 */
export function createApp(): Express {
  const app = express();

  // Don't advertise the framework.
  app.disable('x-powered-by');

  // Which replica served this. First, so it covers static files and error responses as well.
  app.use(instanceHeader);

  // 256kb is well above any legitimate message and low enough that a huge body is rejected by the
  // parser (413) rather than being buffered.
  app.use(express.json({ limit: '256kb' }));

  app.use(express.static('web'));
  app.use('/api', apiRouter);

  // Terminal error middleware, mounted last: Express only treats a four-argument handler as an
  // error handler, and only routes registered before it can reach it.
  app.use(errorHandler);

  return app;
}
