import http from 'node:http';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { runMigrations } from './db/migrate.ts';
import { backfillBodyTokens, closeMongo, connectMongo, ensureMongoIndexes } from './db/mongo.ts';
import { closeMysql, waitForMysql } from './db/mysql.ts';
import { closeRedis, waitForRedis } from './db/redis.ts';
import { installProcessErrorHandlers } from './middleware/error-handler.ts';
import { attachWs, closeWs } from './ws/hub.ts';

/**
 * Process lifecycle: connect, migrate, listen, and shut down cleanly.
 *
 * Everything here is about the process rather than the HTTP surface, which lives in app.ts.
 */
export async function start(): Promise<http.Server> {
  installProcessErrorHandlers();

  const server = http.createServer(createApp());
  attachWs(server);

  // Connect and migrate *before* listening, so an instance never accepts traffic it can't serve.
  await waitForMysql();
  await connectMongo();
  await waitForRedis();
  await runMigrations();
  await ensureMongoIndexes();
  // Populates bodyTokens on messages written before the field existed, so indexed prefix search
  // covers existing history. Batched and capped per boot so it can't hold up start-up.
  await backfillBodyTokens(config.search.maxTokenLength, config.search.maxTokensPerMessage);

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
  let shuttingDown = false;

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[${config.instanceId}] ${signal} received, shutting down`);

      const forceExit = setTimeout(() => {
        console.error('[shutdown] took too long, exiting anyway');
        process.exit(1);
      }, 10_000);
      forceExit.unref();

      void (async () => {
        // WebSockets first, then the HTTP server.
        //
        // The other order deadlocks: server.close() only invokes its callback once every connection
        // has ended, and an open WebSocket never ends on its own — so closing the sockets *inside*
        // that callback meant the callback never fired, the force-exit timer killed the process ten
        // seconds later, and none of the cleanup ran.
        await closeWs();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.allSettled([closeRedis(), closeMongo(), closeMysql()]);
        clearTimeout(forceExit);
        process.exit(0);
      })();
    });
  }
}
