import http from 'node:http';
import express from 'express';
import { config } from './config.ts';
import { closeMysql, waitForMysql } from './db/mysql.ts';
import { closeMongo, connectMongo, ensureMongoIndexes } from './db/mongo.ts';
import { closeRedis, redis, waitForRedis } from './db/redis.ts';
import { runMigrations } from './db/migrate.ts';
import { errorHandler, installProcessErrorHandlers, notFoundHandler } from './http/errors.ts';
import { conversationsRouter } from './routes/conversations.ts';
import { messagesRouter } from './routes/messages.ts';
import { searchRouter } from './routes/search.ts';
import { usersRouter } from './routes/users.ts';
import { attachWs, closeWs, hubStats } from './ws/hub.ts';

installProcessErrorHandlers();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.static('web'));

/**
 * Readiness, and a window into which instance you're talking to. With `--scale api=3` behind a
 * round-robin proxy, "which process served that?" is the first question you have when debugging,
 * and there was previously no way to answer it.
 */
const startedAt = new Date().toISOString();

app.get('/api/health', async (_req, res) => {
  let redisOk = true;
  try {
    await redis.ping();
  } catch {
    redisOk = false;
  }
  // `startedAt` is how a test can tell "this instance never restarted" from "the proxy sent me
  // to a different instance" — the two are indistinguishable from the instance id alone.
  res.json({ ok: true, redis: redisOk, startedAt, ...hubStats() });
});

app.use('/api/users', usersRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/search', searchRouter);

app.use('/api', notFoundHandler);
// Finding A: without this, a rejected async handler killed the process instead of returning 500.
app.use(errorHandler);

const server = http.createServer(app);
attachWs(server);

// Connect and migrate *before* listening, so an instance never accepts traffic it can't serve.
await waitForMysql();
await connectMongo();
await waitForRedis();
await runMigrations();
await ensureMongoIndexes();

server.listen(config.port, () => {
  console.log(`relay [${config.instanceId}] listening on :${config.port}`);
});

/**
 * Graceful shutdown. Matters as soon as there's more than one instance: on a scale-down or a
 * redeploy, a SIGTERM'd process should finish its in-flight requests and tell its WebSocket
 * clients to reconnect elsewhere, rather than having its sockets cut.
 */
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

    server.close(() => {
      void (async () => {
        await closeWs();
        await Promise.allSettled([closeRedis(), closeMongo(), closeMysql()]);
        clearTimeout(forceExit);
        process.exit(0);
      })();
    });
  });
}
