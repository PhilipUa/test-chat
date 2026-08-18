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

  metrics: {
    /**
     * Window for the request-rate signal, expressed per minute whatever the window is.
     *
     * 15s rather than a full minute because an autoscaler has to notice load *stopping*: with a 60s window
     * every rate-driven scale-down lags a minute behind reality, and a burst keeps the scaler climbing long
     * after the traffic has gone. Short enough to decay quickly, long enough to smooth a single spike.
     */
    requestRateWindowSeconds: num('REQUEST_RATE_WINDOW_SECONDS', 15),
  },

  conversations: {
    /**
     * Default and maximum page size for the inbox. Bounded because the client refetches this list on
     * every reconnect and every resync, so an unbounded version turns one realtime blip into a scan
     * of everything the user is in.
     */
    defaultPageSize: num('CONVERSATIONS_PAGE_SIZE', 50),
    maxPageSize: num('CONVERSATIONS_MAX_PAGE_SIZE', 200),
  },

  /** tasks/rate-limiting.md: ~5 messages per 10s per user per conversation. */
  rateLimit: {
    limit: num('RATE_LIMIT_MAX', 5),
    windowMs: num('RATE_LIMIT_WINDOW_MS', 10_000),
    /** Typing frames are cheap but shouldn't be a free broadcast channel either. */
    typingLimit: num('TYPING_RATE_LIMIT_MAX', 10),
    typingWindowMs: num('TYPING_RATE_LIMIT_WINDOW_MS', 10_000),
    /**
     * Search is the most expensive read in the app — it fans out over every message in the
     * caller's conversations. Sends were the only limited endpoint, which left an unmetered way
     * to generate unbounded read load. Per user, not per conversation: search spans them.
     */
    searchLimit: num('SEARCH_RATE_LIMIT_MAX', 20),
    searchWindowMs: num('SEARCH_RATE_LIMIT_WINDOW_MS', 10_000),
    /**
     * Creating conversations is cheap per call, but unbounded growth isn't. Deliberately a high
     * ceiling: this is a runaway-script guard, not a tight control. Creating conversations is
     * normal, bursty, legitimate behaviour (importing a backlog, an integration fanning out), and
     * a tight limit here punishes real use to prevent something that isn't the actual abuse
     * vector — search is. Set low enough to stop a loop, high enough that nobody honest meets it.
     */
    createLimit: num('CREATE_RATE_LIMIT_MAX', 60),
    createWindowMs: num('CREATE_RATE_LIMIT_WINDOW_MS', 60_000),
  },

  search: {
    defaultLimit: num('SEARCH_LIMIT', 25),
    maxLimit: num('SEARCH_MAX_LIMIT', 100),
    snippetRadius: num('SEARCH_SNIPPET_RADIUS', 60),
    /** Ceiling on paging depth. Deep skips get expensive and nobody pages to 10,000. */
    maxOffset: num('SEARCH_MAX_OFFSET', 500),
    /** Longest token stored for prefix matching; anything longer is truncated. */
    maxTokenLength: num('SEARCH_MAX_TOKEN_LENGTH', 32),
    /** Cap tokens per message so one enormous message can't bloat its index entry. */
    maxTokensPerMessage: num('SEARCH_MAX_TOKENS_PER_MESSAGE', 200),
  },

  ws: {
    /** Ping every interval; a client that misses two in a row is considered gone. */
    heartbeatIntervalMs: num('WS_HEARTBEAT_MS', 30_000),
    /** How long a "typing" state is honoured before it expires on its own. */
    typingTtlMs: num('WS_TYPING_TTL_MS', 5_000),
  },

  presence: {
    /**
     * How long after its last heartbeat a connection still counts as online. Must comfortably
     * exceed ws.heartbeatIntervalMs, or a live connection flickers offline between beats.
     */
    ttlMs: num('PRESENCE_TTL_MS', 90_000),
  },
} as const;
