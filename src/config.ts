function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got ${raw}`);
  return parsed;
}

export const config = {
  port: num('PORT', 3000),
  mysqlUrl: process.env.MYSQL_URL || 'mysql://root:root@mysql:3306/relay?charset=utf8mb4',
  mongoUrl: process.env.MONGO_URL || 'mongodb://mongo:27017/relay',
  redisUrl: process.env.REDIS_URL || 'redis://redis:6379',

  /**
   * Identifies this process in logs and in the Redis fan-out. Compose gives each replica a
   * distinct hostname, which is exactly what we want when debugging across instances.
   */
  instanceId: process.env.INSTANCE_ID || process.env.HOSTNAME || `pid-${process.pid}`,

  /**
   * Key for the message body HMAC. The old code used pbkdf2 with a hard-coded salt and no key,
   * which is unkeyed and therefore forgeable by anyone. A real deployment must set this.
   */
  messageSigningKey: process.env.MESSAGE_SIGNING_KEY || 'relay-dev-signing-key-do-not-ship',

  messages: {
    /** Default page size for GET /api/messages, and the ceiling a caller can ask for. */
    defaultPageSize: num('MESSAGES_PAGE_SIZE', 50),
    maxPageSize: num('MESSAGES_MAX_PAGE_SIZE', 200),
    maxBodyLength: num('MESSAGE_MAX_LENGTH', 4000),
  },

  /** tasks/rate-limiting.md: ~5 messages per 10s per user per conversation. */
  rateLimit: {
    limit: num('RATE_LIMIT_MAX', 5),
    windowMs: num('RATE_LIMIT_WINDOW_MS', 10_000),
    /** Typing frames are cheap but shouldn't be a free broadcast channel either. */
    typingLimit: num('TYPING_RATE_LIMIT_MAX', 10),
    typingWindowMs: num('TYPING_RATE_LIMIT_WINDOW_MS', 10_000),
  },

  search: {
    defaultLimit: num('SEARCH_LIMIT', 25),
    maxLimit: num('SEARCH_MAX_LIMIT', 100),
    snippetRadius: num('SEARCH_SNIPPET_RADIUS', 60),
  },

  ws: {
    /** Ping every interval; a client that misses two in a row is considered gone. */
    heartbeatIntervalMs: num('WS_HEARTBEAT_MS', 30_000),
    /** How long a "typing" state is honoured before it expires on its own. */
    typingTtlMs: num('WS_TYPING_TTL_MS', 5_000),
  },
} as const;
