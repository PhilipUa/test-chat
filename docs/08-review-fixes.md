# Code review, and the twelve things it found

A review pass over the whole branch, then every finding fixed. The interesting part is not the list —
it's that three of the twelve are the *same mistake*, and the code was already careful about that
mistake everywhere except one place.

Verified with `npm test`, `npm run typecheck`, and live probes against `docker compose up --scale
api=3`. Three findings were reproduced against the running stack rather than argued from the source,
which is what the first section is about.

## What the tests couldn't see

The suite was green (84/84) and `tsc --noEmit` was clean, so the review started at `/api/health`
instead of at the diff. That gave the worst finding away immediately:

```
api-1: connections:1  subscribedConversations:395
api-2: connections:0  subscribedConversations:741   <- all leaked
api-3: connections:1  subscribedConversations:773
```

741 Redis channel subscriptions held by a replica with no connections at all. `ws/channels.ts` exists
to give exactly the opposite property — an instance subscribes to a conversation when its first local
socket cares and unsubscribes when the last one stops — so this wasn't a slow leak, it was that
mechanism not working.

The lesson I'd keep: a green suite tells you the behaviours you thought to assert are intact. It says
nothing about the state the process is holding while it does that. `/api/health` reporting
`connections` and `subscribedConversations` side by side is what made this visible in one request, and
that endpoint was already there — nobody had read the two numbers together.

## 1. A WebSocket frame is processed after its socket has closed

`ws/protocol.ts`, `ws/hub.ts`

`handleSubscribe` set `client.userId`, awaited the participant query, and *then* acquired Redis
channels and registered presence. Frame handling is async and the close event doesn't wait for it, so
the close handler could run first — releasing an empty `client.subs` — and the resumed handler then
acquired the whole set with nobody left to release it. The client was already out of the registry, so
that release could never happen. Permanent, once per occurrence.

Reproduced in five rounds, with `scripts/probe-ws-lifecycle.mjs`:

```
$ docker compose exec api node scripts/probe-ws-lifecycle.mjs 5
instance 8df1b644ac90: 395 channel(s), 1 connection(s)
racing 5 subscribe/close rounds over 10 conversations…
instance 8df1b644ac90: 405 channel(s), 1 connection(s)

LEAKED CHANNELS: 10 (expected 0)
```

It has to run against a single instance — `subscribedConversations` is per-process and Envoy
round-robins, which is part of why this was invisible for so long.

The same race also registered presence for a connection that no longer existed:

```
socket closed 2.5s ago; asking the server who is online…
presence members for user 4: 8df1b644ac90:d3847d32-… 1787054406316
```

A `presence {online: true}` went out with no matching offline event — `handleDisconnect` had already
run and returned early, because `client.userId` was still undefined when close fired. That half
self-healed after the 90s TTL since nothing heartbeats a dead connection. The channel leak never did.

The fix is a `closed` flag on the client, set by the one function that now owns the whole teardown
(`releaseClient`), and checked after **every** await in `handleSubscribe`. Two named functions rather
than three steps at the call site, because the bug was precisely a teardown running in the wrong
order relative to an in-flight frame — that's not something to leave to whoever writes the next call
site.

## 2. Authorization on `GET /api/messages` was opt-in by the caller

`routes/messages.routes.ts`

```
GET /api/messages?conversationId=1&userId=4  -> 403   Dave is not in conv 1
GET /api/messages?conversationId=1           -> 200   full history
```

`optionalActor: true` meant omitting `userId` skipped the membership check entirely. The comment
justified it as "compatibility with the original endpoint" — but `git show main:src/routes/messages.js`
shows the original GET never accepted `userId` at all. There was no client on the other side of that
compatibility.

What *did* depend on the escape hatch was this repo's own test suite: seven call sites in
`tests/bugfixes.test.mjs` fetched without `userId`. So the tests were exercising the bypass while a
neighbouring test asserted the 403 and made the guard look like it worked. `optionalActor` is gone and
those call sites now name a user.

Worth being blunt about: I wrote that option, and I wrote the comment explaining why it was
acceptable. The comment is what made it survive — it reads like a decision rather than a hole.

## 3. A failed Redis `SUBSCRIBE` was never retried

`ws/channels.ts`

`acquire` bumped the refcount and fired the subscribe through `bestEffort`. With
`enableOfflineQueue: false` that rejects immediately while Redis is down, and ioredis only re-issues
`SUBSCRIBE` on reconnect for channels it managed to *acknowledge*. Nothing else would ever try again
either: the browser re-sends `subscribe`, `reconcile` sees `current === next`, and no `acquire` is
called.

Net effect: a tab that reconnects during a Redis blip gets the one-shot `resync` nudge and then
silently receives no messages, typing, or presence for that conversation for the life of the process.
Its socket stays open the whole time, so nothing on screen says so.

`channels.ts` now tracks the gap between "wanted" and "acknowledged", and the subscriber's `ready`
handler retries it — the same hook that already sends the resync nudge. The existing comment said
"leaking a subscription is harmless"; true for the leak, not for the inverse.

## 4. A deduplicated send could return an empty body — permanently, on screen

`services/messages.ts`

`createMessage` read MySQL then Mongo, and `findBody` returns `''` when the document is absent. The
two writes aren't atomic and MySQL autocommits, so there's a window where the winning request has
committed its row but not its text. A concurrent request with the same `clientId` found the row, got
`''`, and returned `200 {body: ''}` with `deduplicated: true` — which also skipped the fan-out.

The client-side consequence is what makes this worth more than a shrug: `appendMessage(saved)` adds id
N to `state.rendered` and replaces the optimistic bubble with an empty one, so the winner's real
broadcast then hits `if (state.rendered.has(m.id)) return` and is dropped. Blank until reload.

Now: a bounded re-read (the window is milliseconds), and failing that, the pending send's own body
when the sender matches — same idempotency key, same sender, so it's the same logical message.

Also newly reachable because of finding 5, which is the sort of interaction worth noticing: an
infrastructure change made a latent application race live.

## 5. Envoy retried non-idempotent POSTs

`docker/envoy/envoy.yaml`

`retry_on: "connect-failure,refused-stream,unavailable,reset"` on `prefix: "/"` — every route, every
method. The first two are safe (the request never reached an upstream); `unavailable` and `reset` can
both happen *after* it was processed.

The comment justified it with "sends are idempotent on clientId", which holds only for
`POST /api/messages` *with* a `clientId` — and `optionalClientId` returns `null` when it's absent.
`POST /api/conversations` and `/:id/read` aren't deduplicated at all, so a reset mid-create could
produce two conversations with the same title and two sets of participants.

Split into two routes: GET keeps the broad policy (and that covers the WebSocket upgrade, which is a
GET), everything else retries only where the request provably never arrived.

## 6. `catchUp()` could paint one conversation into another

`web/js/socket.js`

`openConversation` was given a `loadGeneration` guard for exactly this race, and it's documented at
length. `catchUp` captured the conversation id, awaited a `since=` fetch that walks up to twenty
pages, and then called `appendMessage` — which appends to `#messages` without checking
`m.conversationId`. Navigate during those awaits and `state.rendered` has already been cleared by
`openConversation`, so the dedup check doesn't stop it either.

Reachable on any reconnect or `resync` while the user is clicking around.

## 7. Presence announce was a serialised round trip per conversation

`ws/protocol.ts`

```
subscribed ack after 5ms for 878 conversations
presence-snapshot after 102ms
```

`announcePresence` awaited one publish per conversation, on every connect and every disconnect, with
the presence snapshot queued behind it. ~95ms of serial Redis round trips before the socket was
usable. One pipelined publish instead.

The N+1 in the presence snapshot itself had already been found and fixed; this had the same shape one
function away.

## 8. `GET /api/conversations` was unpaginated, on the reconnect path

`services/conversations/queries.ts`

No `LIMIT`, two correlated subqueries per conversation, and `catchUp()` refetches it on every
reconnect and every resync. 181 KB and ~13ms for user 1's 878 conversations — but only because
`messages` held 895 rows. It degrades with message volume, not conversation count.

Keyset-paginated on `(activity, id)`, the same way `listMessages` already was. The response shape
changed from a bare array to `{conversations, hasMore, nextCursor}`, so the client, the sidebar, one
audit script and eight test call sites moved with it. The sidebar grew a "Load more conversations"
row, because silently truncating the list is worse than the thing being fixed.

This composes with finding 7 in a way I liked: the socket now subscribes to the conversations that are
actually loaded, so one socket asking for 878 Redis `SUBSCRIBE`s isn't a shape the client can even
express any more.

## 9. Switching identity on a live socket stranded the old user's presence

`ws/protocol.ts`

`handleSubscribe` overwrote `client.userId` without deregistering the previous one, and the UI does
exactly this — `userSelect.onchange` re-subscribes on the same socket. The member stayed in
`relay:presence:<oldUserId>` until the TTL expired and no offline event was ever announced, so the
user you'd just stopped being showed as online to everyone for 90 seconds. `handleDisconnect` only
ever deregisters the *current* `client.userId`, so nothing downstream caught it.

The offline announce is deliberately sent before the subscriptions are reconciled, so it reaches the
conversations that user was actually in rather than the incoming user's set.

## 10. Two `openConversation` call sites swallowed their rejection

`web/js/main.js`, `web/js/views/search.js`

`void openConversation(id)` and `() => openConversation(...)`. The pane is cleared *before* the fetch
is awaited, so a 403, 429, or network failure left an empty message area, a title claiming the
conversation was open, and an unhandled rejection in the console. Every other user-facing failure path
in the app reports through `notice()`; these two didn't.

## 11. `conversations.last_message_at` was written on every send and read by nothing

`services/message-store.ts`, `db/migrate.ts`

Added to "order the inbox by recency without touching the messages table", then never used:
`listConversations` orders by the join on `messages`. A grep across `src/`, `web/`, `scripts/` and
`docker/` found writers only. Every send paid an extra `UPDATE` and a row lock on the conversation to
maintain a value with no reader.

Dropped rather than adopted, and the choice matters: using it would have made inbox ordering depend on
a deliberately best-effort write, where the join is always correct. Derived data with no reader is
just cost.

## 12. The create limiter charged before the body was validated

`routes/conversations.routes.ts`

`middleware/rate-limit.ts` states the ordering it needs — quota is only spent on a request that was
going to be accepted — and `messages.routes.ts` looked like it honoured it. Neither actually did:
validation lived in the controllers, which run *after* the limiter. A client looping a malformed body
burned its own allowance and got 429s instead of the 400 explaining the mistake.

Both routes now parse the payload in middleware ahead of the limiter, handing the checked value to the
controller through the typed `res.locals` accessors in `locals.ts`. That contradicts a comment in
`validation/parse.ts` arguing parsing belongs in controllers so TypeScript can check it — the typed
accessors are what make it safe to move, and the ordering requirement is the stronger constraint.

## Smaller notes, also fixed

- **`listMessages` returned a cursor to nowhere.** `nextBefore` was the oldest id on the page even at
  the start of history, contradicting its own "null when at the start" doc comment. Now null unless
  there genuinely is an older page, and never set on the forwards (`since=`) path where `latestId` is
  the cursor.
- **`markRead` could throw on a long conversation.** `Math.max(0, ...[...state.rendered])` spreads a
  Set as function arguments — a `RangeError` past roughly 65k ids, which would break every read
  receipt from then on. Now a loop, in `web/js/util.js` where it can be unit tested with 200k of them.
- **`uncaughtException` no longer keeps the process alive.** A dropped promise is recoverable and
  still only logged. An uncaught exception unwound the stack from an unknown point, so the heap isn't
  trustworthy and staying up means serving from an undefined state. It now runs the same orderly
  shutdown a SIGTERM does and exits non-zero. The original comment ("behind a load balancer, a
  degraded instance beats a crash loop") was correct when written — before `restart: on-failure`, the
  healthcheck, and Envoy's retries existed to make a restart the cheaper option.

## Checked and discarded

Recorded so they don't get re-investigated: the `unhandledRejection` handler does not turn a failed
`start()` into a zombie (ESM top-level-await rejections bypass it and still exit 1); the two-tier
search strategy can't desync across pages; `sqlList` and the `LIMIT ${n}` interpolation are
integer-validated throughout; keyset pagination and the `limit + 1` `hasMore` trick are correct in
both directions; posting with another user's `senderId` is the documented no-auth model rather than a
spoofing bug; and no secrets are committed.

## The pattern worth more than the list

Findings 1, 6 and 9 are one mistake: **mutating shared state after an `await` without re-checking that
the thing being mutated still exists.**

That's striking given what the rest of the code does. Presence transitions are a single Lua script so
two instances can't both decide they caused one. Rate limiting is check-and-increment in one atomic
script. Idempotency is enforced by a unique index rather than read-then-write. Every one of those is
the *same* concern — a window between reading and acting — solved carefully, in Redis and in MySQL.

In its own process memory it was solved nowhere. `openConversation` has a generation guard with a
paragraph explaining it; `catchUp`, twenty lines below, has none. `handleSubscribe` awaits three times
and re-checks nothing. The rigour didn't generalise from the databases to the heap, and I'd guess
that's because a database makes you *name* the concurrency (a transaction, a script, an index) while
an `await` hides it inside something that reads like a straight line.

## Tests

`npm test` — the counts, and what each new file pins down:

- `tests/ws-lifecycle.test.mjs` — 9 unit tests for connection lifecycle accounting. Runs in-process
  with no Redis reachable, which is deliberate: the refcounting is in-process state and its
  `SUBSCRIBE` calls go through `bestEffort`, so a host without Redis exercises exactly the two things
  under test. Assertions are on deltas, so no test reaches into module state to reset it.
- `tests/review-fixes.test.mjs` — the integration regressions, grouped by finding.
- `tests/ui-review-fixes.test.mjs` — the two browser ones (catch-up mid-navigation, a conversation
  that fails to open).
- `tests/process-errors.test.mjs` — the fatal-vs-recoverable policy, with the handlers exported apart
  from their registration so it can be tested without attaching listeners to the real process.
- `tests/web-util.test.mjs` — `maxOf`, including the 200k case that used to throw.

Two of the new tests were green before their change and are meant to stay that way: presence reaching
every conversation (guards the pipelining in finding 7) and a message moving its conversation to the
top of the inbox (guards dropping `last_message_at` in finding 11). Refactor guards, not bug
reproductions — worth labelling as such rather than counting them as evidence the fixes work.

---

## Follow-up: keeping the inbox ordered live

The server has always ordered the inbox by last activity — but only at fetch time. A message arriving
over the socket updated the conversation's preview and its unread badge and left the row exactly where
it was, so the list drifted out of order until the next reload or catch-up. Most visibly for the
conversation you *aren't* looking at, which is the one the ordering exists to surface.

Two parts:

- **The server now returns the key it sorts by**, as `activityAt` on each conversation: the last
  message's timestamp, or the conversation's own creation when it has none. `lastMessage.createdAt`
  wasn't enough on its own — a conversation with no messages has no last message and still has a place
  in the order. Sharing the key is what makes the client's order provably the same as the server's,
  which matters now that the list is paged: a client sorting by its own rule would disagree with the
  next page it fetches.
- **The client orders on read**, not on write: `renderSidebar` iterates `conversationsInOrder()`
  rather than `state.conversations`. Deliberately not "re-sort after each mutation" — the bug being
  fixed *was* a mutation path that forgot, and there is no shortage of them (a broadcast, a send with
  the socket down, a page append, a read receipt). Ordering on read means a new one can't forget.

`noteLatestMessage` is idempotent, guarded on the message id. Both the send path and the broadcast
report the same message, in either order, and when the socket is down only the send path does — so the
guard is what lets both call it unconditionally. It also stops a delayed older broadcast from dragging
a conversation backwards.

The comparator and that guard live in `web/js/util.js` rather than `state.js`, because `state.js`
touches `location` and `sessionStorage` at import and can't be loaded under node. Moving the two pure
functions out gets them unit tests for the cases the browser test won't reach: the id tie-break that
keeps message-less conversations from shuffling between renders, a double-report of one message, and a
late older one.

`npm test`: 126 tests.
