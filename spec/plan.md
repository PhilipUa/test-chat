# Plan

Ordered by blast radius, then by what unblocks what. Findings referenced as (A)…(M) from
`docs/01-investigation.md`.

## Stage 1 — stop the process dying or stalling

- **Async error handling.** `asyncHandler` wrapper + a real Express error middleware + a typed
  `HttpError`, so a rejected handler becomes a 4xx/5xx instead of killing the process. Belt and
  braces: `unhandledRejection`/`uncaughtException` handlers that log rather than exit silently. (A)
- **Kill the sync KDF.** Replace `pbkdf2Sync(…, 200000)` with a keyed `HMAC-SHA256`. Microseconds
  instead of 20ms, and it actually provides authenticity because the key is secret. (B)
- **WebSocket lifecycle.** `'error'` listeners, ping/pong heartbeat with reaping, remove on close. (K)
- **Graceful shutdown** on SIGTERM/SIGINT: stop accepting, drain, close sockets and pools. Matters
  as soon as we're scaling instances up and down.

## Stage 2 — data integrity

- **Idempotent sends.** `UNIQUE (conversation_id, client_id)`, look up before insert, and catch the
  duplicate-key race to return the winning row. NULL `client_id` stays un-deduped (MySQL doesn't
  collide NULLs), which is the behaviour we want. (D)
- **Cross-store write.** MySQL row, then Mongo body, and on Mongo failure delete the MySQL row so we
  never keep a message we can't render. Two databases can't share a transaction; this is a
  compensating action, and the residual window gets documented, not hidden. (I)
- **Transaction** around conversation creation, `INSERT IGNORE` for participants. (A)
- **Idempotent seed.** Upsert the three demo bodies by `_id`; never `deleteMany`. (H)
- **One timestamp per message.** Generate `createdAt` once in the write path and pass it to both
  stores; widen the column to `DATETIME(3)` so it survives the round trip. (M)

## Stage 3 — Redis, and the two tasks that need it

Redis is already in compose and unused. It's the right answer for both remaining shared-state
problems, so it lands once with a small typed client module.

- **Multi-instance realtime** (`tasks/multi-instance.md`, finding C). Redis pub/sub per
  conversation channel, refcounted subscribe/unsubscribe per instance. Every fan-out goes
  *through* Redis — including same-process delivery — so there's one delivery path rather than a
  local path and a remote path that can disagree. Degrade to local-only if Redis is unreachable.
- **Rate limiting** (`tasks/rate-limiting.md`). Sliding window in a Lua script (atomic, one round
  trip) keyed `user:conversation`, 5 per 10s. 429 + `Retry-After` + `X-RateLimit-*`. Clock from
  Redis `TIME`, not the app, so three instances agree. Fail *open* if Redis is down — a chat app
  should keep working if the rate limiter is unavailable. Check idempotency *before* the limiter so
  a retry doesn't spend quota.

## Stage 4 — the traffic-shaped problems

- **Indexes**: `messages (conversation_id, id)`, `conversation_participants (user_id)`. (F)
- **Collapse the N+1** into one query with correlated subqueries that the new index turns into
  seeks. (G)
- **Paginate** `GET /api/messages` — newest N with a `before` cursor, and "load older" in the UI. (J)
- Run DDL through a small idempotent **migration runner** at startup instead of relying on
  `docker-entrypoint-initdb.d`, which only fires on a fresh volume. Existing installs need to pick
  up the new indexes too.

## Stage 5 — remaining tasks

- **Search** (`tasks/search.md`). Mongo text index on `body`, ranked by `textScore`, scoped to the
  caller's conversations, titles joined from MySQL, plain-text snippet around the match. Escaped
  regex fallback for short/partial queries that `$text` word-matching misses.
- **Typing indicator** (`tasks/typing-indicator.md`). `typing` frames over the existing WS, fanned
  out through the same Redis path so it works multi-instance. Server-side throttle, TTL on the
  client so a dropped socket can't leave someone typing forever, never echoed to the typist.

## Stage 6 — correctness, then the frontend

- **Authorization** on every entry point: sender must participate in the conversation, WS
  subscriptions filtered to conversations you're actually in. (E)
- **Server-side unread.** `last_read_message_id` on the participant row, `unreadCount` in the
  conversation list, a `read` endpoint. The dot currently can't survive a reload, and
  `tasks/multi-instance.md` explicitly asks for it to keep working across instances. (M)
- **Frontend**: `textContent` instead of `innerHTML` (L), WS reconnect with backoff and catch-up,
  optimistic send with `clientId` dedup, 429 handling, typing indicator, unread counts, load-older,
  and a user switcher so two-party features can actually be demoed in two tabs.
- **Routes to TypeScript.** `.js` in a `strict` project with `checkJs: false` means the row and
  request shapes go unchecked. (M)

## Verification

`scripts/probe-realtime.mjs` already reproduces (C). Extend to a real integration suite
(`npm test`, `node:test`) covering idempotency, the 429 and its `Retry-After`, authorization,
pagination, search, and cross-instance fan-out — runnable against 1 instance and against 3, since
"works on one" is precisely what hid (C).
