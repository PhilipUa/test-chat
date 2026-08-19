import http from 'node:http';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { runMigrations } from './db/migrate.ts';
import { closeMongo, connectMongo, ensureMongoIndexes } from './db/mongo.ts';
import { closeMysql, waitForMysql } from './db/mysql.ts';
import { backfillSearchIndexes } from './repositories/message-bodies.repository.ts';
import { closeRedis, waitForRedis } from './db/redis.ts';
import { installProcessErrorHandlers } from './middleware/error-handler.ts';
import { attachWs, closeWs } from './ws/hub.ts';

/**
 * Process lifecycle: connect, migrate, listen, and shut down cleanly.
 *
 * Everything here is about the process rather than the HTTP surface, which lives in app.ts.
 */
export async function start(): Promise<http.Server> {
  const server = http.createServer(createApp());

  // An uncaught exception leaves the heap untrustworthy, so shut down and let the supervisor restart
  // us rather than serving from a process in an undefined state. See middleware/error-handler.ts.
  installProcessErrorHandlers(() => void shutdown(server, 'uncaughtException', 1));

  attachWs(server);

  // Connect and migrate *before* listening, so an instance never accepts traffic it can't serve.
  await waitForMysql();
  await connectMongo();
  await waitForRedis();
  await runMigrations();
  await ensureMongoIndexes();
  // Populates bodyTokens/bodyTrigrams on messages written before those fields existed, so prefix
  // and fuzzy search cover existing history. Batched and capped per boot so it can't hold up
  // start-up.
  await backfillSearchIndexes({
    maxTokenLength: config.search.maxTokenLength,
    maxTokens: config.search.maxTokensPerMessage,
    maxTrigrams: config.search.maxTrigramsPerMessage,
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, () => {
      console.log(`relay [${config.instanceId}] listening on :${config.port}`);
      resolve();
    });
  });

  installShutdownHandlers(server);
  return server;
}

/**
 * Graceful shutdown. Matters as soon as there's more than one instance: on a scale-down or a
 * redeploy, a SIGTERM'd process should finish its in-flight requests and tell its WebSocket clients
 * to reconnect elsewhere, rather than having its sockets cut.
 */
function installShutdownHandlers(server: http.Server): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(server, signal, 0));
  }
}

let shuttingDown = false;

/**
 * Closes everything down once and exits with `code`.
 *
 * Shared by the signal handlers and by the fatal-error path, so a crash gets the same orderly
 * teardown a redeploy does — WebSocket clients told to reconnect elsewhere, presence deregistered
 * rather than left to time out.
 */
async function shutdown(server: http.Server, reason: string, code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${config.instanceId}] ${reason} received, shutting down`);

  const forceExit = setTimeout(() => {
    // Always non-zero: reaching this means the teardown didn't finish, which isn't a clean exit even
    // when the trigger was an ordinary SIGTERM.
    console.error('[shutdown] took too long, exiting anyway');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  // Timed per step, because "the shutdown is slow" is otherwise unattributable — and it was: this
  // reliably hit the force-exit above, which meant everything after the hang was skipped.
  await step('websockets closed', closeWs);
  await step('http server closed', () => closeHttp(server));
  await step('databases closed', async () => {
    await Promise.allSettled([closeRedis(), closeMongo(), closeMysql()]);
  });

  clearTimeout(forceExit);
  console.log('[shutdown] complete');
  process.exit(code);
}

async function step(name: string, work: () => Promise<void>): Promise<void> {
  const started = Date.now();
  await work();
  console.log(`[shutdown] ${name} in ${Date.now() - started}ms`);
}

/**
 * Stops the HTTP server without waiting on connections that may never end on their own.
 *
 * `server.close()` only calls back once every connection has ended, and Envoy holds persistent
 * upstream connections — so an idle keep-alive connection can keep the callback pending. Close the
 * idle ones at once, give anything mid-request a moment, then take the rest.
 *
 * Worth being precise about what this did and didn't fix. The hang that made *every* drain hit the
 * force-exit was elsewhere — an unanswered WebSocket close handshake in closeWs — and on a quiet stack
 * this step measures 0ms either way. But it is not decorative: on a drain with traffic still arriving,
 * `scripts/probe-failover.mjs` logged `http server closed in 3003ms`, i.e. the deadline below fired and
 * bounded what would otherwise have run into the force-exit. Both halves earn their place.
 */
async function closeHttp(server: http.Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));

  server.closeIdleConnections();
  const drainDeadline = setTimeout(() => {
    console.warn('[shutdown] forcing remaining in-flight connections closed');
    server.closeAllConnections();
  }, 3_000);
  drainDeadline.unref();

  await closed;
  clearTimeout(drainDeadline);
}
