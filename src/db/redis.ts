import Redis, { type RedisOptions } from 'ioredis';
import { config } from '../config.ts';

/**
 * Redis was already declared in docker-compose and never used. It is now the shared state for
 * the two things that cannot live in one process's memory: WebSocket fan-out across instances
 * (tasks/multi-instance.md) and send rate limiting (tasks/rate-limiting.md).
 */

const baseOptions: RedisOptions = {
  // Fail fast rather than queueing commands forever if Redis is unreachable. The rate limiter
  // is designed to fail open, and it can only do that if the command actually rejects.
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  connectTimeout: 3_000,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
};

function create(role: string): Redis {
  const client = new Redis(config.redisUrl, { ...baseOptions, connectionName: `relay-${role}` });
  // Without an 'error' listener ioredis throws on connection errors, which would take the
  // process down for something we are explicitly prepared to survive.
  client.on('error', (err) => {
    log(role, err);
  });
  return client;
}

let lastLoggedAt = 0;
function log(role: string, err: Error): void {
  // Connection errors arrive in floods while Redis is down; one line every 5s is enough.
  const now = Date.now();
  if (now - lastLoggedAt < 5_000) return;
  lastLoggedAt = now;
  console.error(`[redis:${role}] ${err.message}`);
}

/** Commands (rate limiting, publish). Never put this connection into subscriber mode. */
export const redis = create('cmd');

/**
 * A connection in subscriber mode can't issue normal commands, so pub/sub needs its own.
 * Publishing goes through `redis` above.
 */
export const redisSubscriber = create('sub');

export async function waitForRedis(retries = 30): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      await redis.ping();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  throw new Error(`redis not reachable: ${lastErr}`);
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisSubscriber.quit()]);
}
