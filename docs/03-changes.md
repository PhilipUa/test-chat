# What I changed and why

Findings referenced as (A)…(M) from [`01-investigation.md`](01-investigation.md), where each is
reproduced with the command that shows it. Plan in [`../spec/plan.md`](../spec/plan.md).

## Bugs fixed

### 1. A failing request no longer takes the server down — (A)

`src/http/errors.ts`, and every route.

The async route handlers had no error handling, and Express 4 doesn't catch a rejected promise
from an `async` handler. The rejection became an unhandledRejection, which terminates Node 22 — so
a request tripping a DB constraint restarted the API and dropped every WebSocket on that instance.

- `asyncHandler()` wraps each handler so a rejection reaches Express's error middleware.
- `HttpError` carries an intended status; anything else logs in full and returns a 500.
- `notFoundHandler` for unmatched `/api` routes, so a typo'd URL gets JSON, not the SPA.
- Process-level `unhandledRejection`/`uncaughtException` handlers log instead of exiting — behind a
  load balancer, a degraded instance beats a crash loop.
- Body-parser errors keep their own status. A 5MB body was coming back as `500 internal server
  error`; it's now a `413`. **I introduced this one myself** while fixing the above and caught it
  in the verification pass — the first version only special-cased `SyntaxError`.

Every input is now validated at the edge (`src/http/validate.ts`) rather than being handed to the
driver as-is. The conversation-creation path is a transaction, so a partial failure can't leave the
orphaned conversation row that finding A produced.

### 2. Sending a message no longer stalls the whole instance — (B)

`src/services/messages.ts`.

`createMessage` computed a signature with `crypto.pbkdf2Sync(body, 'relay-signing', 200000, 32,
'sha256')` — 20.5ms of *blocked event loop* per message. Two distinct problems:

1. **Synchronous**, so the cost hit every other request on the instance, not just the sender.
2. **The wrong primitive.** pbkdf2 is a password-stretching KDF. The "salt" was a hard-coded
   constant and there was no secret key, so anyone could recompute a valid signature for a body
   they'd tampered with. It cost 20ms and provided no authenticity.

Replaced with a keyed `HMAC-SHA256` (`MESSAGE_SIGNING_KEY`), which is what "detect tampering"
actually calls for. Verification uses `timingSafeEqual`.

```
old pbkdf2Sync(200k): 17.300 ms per message (blocking)
new createHmac      :  0.0012 ms per message
speedup             : 14408x
```

End to end, on one instance, `scripts/bench-send.mjs` (50 concurrent sends, measuring an
unrelated read). Numbers move a few ms run to run, so this is a representative run rather than the
best one:

| | before | after |
|---|---|---|
| GET latency, idle | 4 ms | 2.7 ms |
| GET latency, under send load (median) | — | 6.7 ms |
| GET latency, under send load (worst) | 790 ms | 8.6 ms |

The residual 2-3x on the median is ordinary contention from 50 concurrent writes hitting the
connection pool, not the event loop being held — the tell is that the worst case is now within a
few ms of the median instead of two orders of magnitude above it.

### 3. Realtime works with more than one instance — (C), `tasks/multi-instance.md`

`src/ws/hub.ts`, `src/ws/events.ts`.

The hub kept its client set in a module-level `Set`, so `broadcast()` only reached sockets on the
process that handled the POST. Invisible with one instance; with three, most clients silently
stopped receiving messages.

Fan-out now goes through Redis pub/sub, one channel per conversation. Two details that matter:

- **Local delivery goes through Redis too.** There's one delivery path rather than a local path and
  a remote path that can drift, and no message can arrive twice. A test asserts exactly-once per
  socket.
- **Channel subscriptions are refcounted** per instance, so an instance only receives traffic for
  conversations it actually holds sockets for, instead of every conversation in the system.

If Redis is unreachable it degrades to local-only fan-out — single-instance behaviour beats no
realtime.

```
before, --scale api=3:  fan-out: 2/6 clients received the new message
after,  --scale api=3:  fan-out: 6/6 clients received the new message
```

### 4. Retried sends don't duplicate messages — (D)

`src/services/messages.ts`, `src/db/migrate.ts`.

`messages.client_id` existed and the frontend sent a UUID with every send, but nothing ever read it
back — no constraint, no lookup. Any retry created a second message.

- `UNIQUE (conversation_id, client_id)`, so the database enforces it.
- `createMessage` looks for an existing row first and returns it (`200` rather than `201`).
- A concurrent duplicate loses the race on the unique index; that's caught and the winning row
  returned, so three simultaneous identical sends yield one message.
- NULL `client_id` doesn't collide in a MySQL unique index, so sends without one are still allowed
  to repeat — which is the behaviour you want.
- A deduplicated retry is **not** re-broadcast; otherwise the retry would put a second copy in
  everyone's window, which is the bug idempotency exists to prevent.

This also let Envoy retry idempotent POSTs safely, so a replica restarting mid-request no longer
surfaces a 503.

### 5. Authorization — (E)

`conversationId` and `senderId` were taken from the request body and trusted. You could post into a
conversation you weren't in, or as a user that didn't exist, and both returned `201`.

- Sending requires participation: `403` if not a participant, `404` if the conversation doesn't
  exist (without leaking which conversations exist).
- WS `subscribe` intersects the requested ids with the caller's actual conversations. Previously
  anyone could tail any conversation in the system.
- Typing frames are only accepted for conversations the socket is subscribed to.
- Read receipts require participation.

### 6. Indexes and the N+1 — (F), (G)

`messages` had no index on `conversation_id` despite every query filtering by it, and
`conversation_participants`' composite PK starts with `conversation_id` while the conversation list
looks up by `user_id`.

- `messages (conversation_id, id)` — covering, so `ORDER BY id` and `MAX(id)` are index seeks.
- `conversation_participants (user_id)`.
- The conversation list was the rows plus **two queries per conversation in a loop** (101 round
  trips for 50 conversations, each a full scan). Now one query, with the correlated subqueries
  running as index-only scans, plus one batched Mongo lookup for the preview bodies.

Verified with `EXPLAIN`: the optimizer drives from `idx_participants_user` for a selective user
(16 of 178 conversations) and only scans `conversations` when the user is in nearly all of them,
which is the right plan in each case.

### 7. Restarting no longer wipes your message history — (H)

`docker/db/seed.ts`.

The seed opened with `bodies.deleteMany({})` and re-inserted three fixed documents. Because `seed`
is a compose dependency of `api`, it ran on **every** `docker compose up`, while MySQL kept its
`messages` rows — so every restart deleted the bodies of everything you'd sent and left the rows
behind. `GET /api/messages` falls back to `''` for a missing body, so the symptom was your history
silently going blank rather than an error. Measured at 64 of 66 messages.

Now an idempotent upsert of exactly the three demo documents, with fixed timestamps, touching
nothing else.

### 8. Cross-store writes can't leave a message without a body — (I)

MySQL held the id and Mongo the body, with no compensation if the second write failed — leaving a
message that renders as an empty string forever, the same corrupt state as (H) by another route.

There's no transaction across two databases, so the order of operations *is* the correctness
story: insert MySQL, insert Mongo, and on Mongo failure delete the MySQL row. The residual window
(process dies between the two) is called out in [`04-tradeoffs.md`](04-tradeoffs.md) rather than
papered over.

### 9. Pagination — (J)

`GET /api/messages` had no `LIMIT`: opening a conversation fetched every message ever sent in it,
from both stores. Now keyset pagination on the primary key — newest 50 by default with a `before`
cursor, which stays O(page) however deep you scroll and can't skip or repeat a row when new
messages arrive mid-scroll. The UI grew a "load older messages" button.

### 10. WebSocket lifecycle — (K)

- **No `'error'` listener.** `ws` emits `'error'` on an abrupt disconnect, and an unhandled
  `'error'` on an EventEmitter is thrown — another route to killing the process per (A).
- **No heartbeat**, so sockets that died without a close frame were never reaped; the client set
  grew and we kept writing to nobody. Now ping/pong with termination after two missed beats.
- **No reconnect in the browser.** One blip and the tab stopped updating with nothing on screen to
  say so. Now exponential backoff with jitter, a visible connection status, and a catch-up refetch
  on reconnect — realtime is best-effort delivery, HTTP is the source of truth.
- Graceful shutdown on SIGTERM, so scaling down or redeploying drains instead of cutting sockets.

### 11. Stored XSS in the sidebar — (L)

`renderSidebar` did `li.innerHTML = '<span>' + c.title + '</span>'` with a title straight from
`POST /api/conversations`. `appendMessage` already used `textContent`, so it was an inconsistency
as much as a bug. The sidebar is now built from DOM nodes; there is no `innerHTML` in the frontend.

### 12. Smaller things — (M)

- **One timestamp per message.** The POST response used the app clock while a later GET returned
  MySQL's second-precision column, so one message had two different `createdAt` values. Generated
  once in the write path, stored in both, column widened to `DATETIME(3)`.
- **Unread survives a reload.** The dot lived in a browser variable, so it vanished on refresh and
  could never agree between two tabs — let alone two instances. Now a `last_read_message_id`
  watermark per participant, an `unreadCount` in the list, and a `read` event so your *other*
  sessions clear the badge too.
- **Inbox ordered by recent activity** instead of `c.id ASC`, which put the conversation that just
  got a message at the bottom.
- `timezone: 'Z'` on the MySQL pool — without it, mysql2 reads `DATETIME` in the server's local
  timezone, which is how a message can appear to arrive an hour before it was sent.
- Malformed WS frames validated (`NaN` was previously a valid subscription).

## Features built

All four in `tasks/`.

### Multi-instance realtime — `tasks/multi-instance.md`
Covered in fix 3 above.

### Rate limiting — `tasks/rate-limiting.md`

`src/services/rate-limit.ts`. 5 messages per 10s per user per conversation, `429` + `Retry-After`.

- **Sliding window over a Redis sorted set**, not a fixed window: a fixed window lets someone send
  2x the limit across a boundary and can't produce an honest `Retry-After`. The value returned is
  the actual time until the oldest entry ages out.
- **One Lua script**, so check-and-increment is atomic. Three instances handling three concurrent
  sends can't each read "4 used" and all allow.
- **Clock from Redis `TIME`**, not the app, so instances with skewed clocks agree on the window.
- **Keyed per user *and* conversation**, so one noisy sender only throttles themselves.
- **Fails open.** A chat app that stops delivering messages because its rate limiter is
  unavailable has turned a protection mechanism into an outage. Logged, and the response omits the
  rate-limit headers so a client can tell the limiter isn't authoritative.
- Checked *after* validation and authorization, so a rejected request doesn't spend quota.
- Typing frames get their own looser bucket — a broadcast primitive shouldn't be a free
  megaphone.

Five buckets in total, same mechanism throughout — `send` (user + conversation), `search` (user),
`reads` for `GET /api/messages` and `GET /api/conversations` (user), `create` (user) and `typing`
(user + conversation). `/api/health` stays unmetered on purpose, because the autoscaler polls it to
discover replicas, and a typing *stop* frame is never dropped, or a throttled client would leave
someone stuck as "typing".

**The numbers live in [`rate-limit.config.json`](../rate-limit.config.json), not in code.** They are
policy: what a limit should be is a judgement about a deployment, and asking someone to edit
TypeScript or to guess five environment variable names to change it is the wrong shape. Same argument
`autoscale.config.json` makes for scaling rules, so the file is deliberately its counterpart — every
knob documented in a `$comment`, `$examples` to copy from, bind-mounted so a retune is an edit and a
restart. What stays in code is which buckets exist and how each is keyed, because a key shape is a
decision about what the limit protects.

Precedence is env > file > built-in defaults, so a deployment can still override one rule without a
commit. Validation is strict and fails startup: a limit of `0` rejects every request, `windowMs: 10`
instead of `10000` meters a thousand times too loosely, and a rule misspelled `sends` looks
configured while doing nothing — all three fail in a direction nobody notices, which is the worst
property a protection mechanism can have. `src/config/rate-limit-rules.ts` resolves and validates as
a pure function over (file, env), and `tests/rate-limit-config.test.mjs` covers it, including that
the shipped file and its examples are valid against the loader that reads them.

```
send 1 -> 201  remaining=4
...
send 5 -> 201  remaining=0
send 6 -> 429  retry-after=10
{"error":"rate limit exceeded: at most 5 messages per 10s per conversation",
 "details":{"retryAfterMs":9829,"retryAfterSeconds":10}}
```

The client handles it: the message stays in the composer and a "try again in Ns" notice appears,
rather than the text being lost.

### Search — `tasks/search.md`

`src/services/search.ts`. Bodies are in Mongo, titles and membership in MySQL, so: resolve the
caller's conversations, search within those, decorate with titles.

- **Mongo `$text` index** on `body`, ranked by `textScore`. Handles multiple terms, stemming
  ("meeting" matches "meetings") and quoted phrases, and it's the only strategy backed by an index.
- **Escaped-regex fallback**, used *only* when `$text` returns nothing. `$text` matches whole
  words, so "desig" or a partial token finds nothing at all, which reads as broken. The fallback is
  a collection scan, so it's bounded: only within the caller's own conversations, only on an empty
  `$text` result, always with a limit. Results report which strategy matched.
- **Scoped to the caller** — without that, search is a way to read every conversation in the
  system, which is finding E in a new place. Tested from a non-participant's perspective.
- Regex metacharacters are escaped, so `.*` is a literal search rather than a match-everything.
- Plain-text snippet around the match, so a hit in a long message is visible in the results.

The frontend needed one change (passing `userId`); the result item shape is unchanged.

### Typing indicator — `tasks/typing-indicator.md`

`typing` frames over the existing socket, fanned out through the same Redis path, so it works
multi-instance like everything else.

- Only accepted for conversations the socket is subscribed to.
- Never echoed to the typist.
- Client throttles to one frame per 2s while typing; an explicit "stopped" is always sent.
- **TTL on the event**, so a client that disconnects mid-sentence doesn't leave someone showing as
  typing forever — plus a client-side 3s retraction if they stop without sending.
- Carries a display name, resolved server-side with a short-lived cache (it's on a per-keystroke
  path).

Verified in a real browser across two tabs — `screenshots/typing-indicator.png`.

## Things I'd have done differently, and did

- **Routes to TypeScript.** They were `.js` in a `strict` project with `checkJs: false`, so the
  request and row shapes that matter most were the ones nothing checked.
- **`tsc` had never been run here.** The source imports siblings as `./config.ts`, which is what
  `tsx` executes, but `allowImportingTsExtensions` wasn't set — so `tsc` errored on every import.
  Fixed, and `npm run typecheck` is clean.
- **A migration runner** (`src/db/migrate.ts`). `docker/db/mysql.sql` only executes on a fresh
  MySQL volume, so schema changes never reach an existing install — anyone already running the app
  would silently keep the old schema, missing indexes and all. Migrations run at boot, are safe to
  re-run, and take a named lock so `--scale api=3` boots cleanly.
- **Compose volumes.** The original mounted `./:/app` and papered over the resulting empty
  `node_modules` with an anonymous volume — which Compose carries across container recreation, so a
  dependency added to `package.json` never actually appeared. Only source directories are mounted
  now, and `node_modules` stays the one in the image. Also gave MySQL/Mongo/Redis named volumes,
  and Mongo a healthcheck (it was `service_started`, which only waits for the container to exist).
- **`/api/health`**, with the instance id and start time. "Which replica served that, and did it
  restart?" is the first question when debugging anything scale-related, and there was no way to
  answer it. Envoy uses it to take restarting replicas out of rotation, and one test uses the
  start time to prove a bad request didn't restart anything.
- **Envoy**: access logs including `upstream_host`, active health checks, outlier detection, faster
  DNS refresh so `--scale` is picked up promptly, and retries for idempotent requests.
- **A test suite.** There wasn't one. 44 tests over the real stack (`npm test`), each bug test
  naming its finding.
- **A user switcher in the UI**, because nothing about this app is demonstrable as a single user.
  Per-tab (`sessionStorage`) — I first used `localStorage` and caught in the browser that switching
  user in one tab silently changed every other tab on reload, which makes the two-person features
  impossible to demo. `?userId=2` pins an identity.
- Optimistic send with `clientId` reconciliation, so the composer feels immediate and the broadcast
  replaces the local echo rather than duplicating it.

Deliberately left alone, with reasoning, in [`04-tradeoffs.md`](04-tradeoffs.md).
