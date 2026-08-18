# Follow-up: closing the gaps the first pass left

The first pass fixed the bugs and built the four tasks. This pass addresses what that left behind —
including one thing that was a genuine hole rather than a refinement.

Verified with `npm test` (59 tests, at one instance and at three) and `npm run audit:tasks`, which
checks every requirement written in `tasks/` and prints the evidence for each.

## 1. Sends were the only rate-limited endpoint — and search is the expensive one

`tasks/rate-limiting.md` asks for protection on sending, and that's what the first pass built. But
that left `/api/search`, `/api/conversations` and `/api/users` unmetered, and search is the most
expensive read in the app: it fans out over every message the caller can see.

Worse, the substring fallback I'd added made it *pathologically* expensive. `explain` on a query
that matches nothing:

```
docsExamined: 3203   keysExamined: 3203   nReturned: 0
```

Every document in the caller's conversations fetched and regex-tested, to return nothing. So a loop
of `?q=zzzz1`, `?q=zzzz2` was a cheap way for one user to generate unbounded read load — an
endpoint with an O(entire message history) cost and no limiter in front of it.

Fixed on both axes, because either alone is insufficient:

- **Metered.** Search gets its own bucket (20 per 10s per user, keyed per user rather than per
  conversation since a search spans them), conversation creation gets another. Same sliding-window
  mechanism, same `429` + `Retry-After`. A blank query is deliberately free — it does no work, so
  metering it would only punish an empty submit.
- **Made cheap.** See below.

The 429 shape moved into `src/http/rate-limit-headers.ts`, since copying it per endpoint is how the
headers drift apart.

On the create limit: I first set it to 10/minute, which promptly broke the test suite — nearly
every test creates a conversation. That's a real signal, not just a test problem. Creating
conversations is normal, bursty, legitimate behaviour (importing a backlog, an integration fanning
out), and it isn't the abuse vector search is. It's now a high ceiling (60/minute): low enough to
stop a runaway loop, high enough that nobody honest meets it. Tight limits on cheap operations
punish real users to prevent the wrong thing.

## 2. Indexed prefix search, replacing the collection scan

`$text` only matches whole words, so "desig" finds nothing in "design" — which reads as broken to
anyone typing into a search box. The first pass solved that with an unanchored regex over `body`,
which is the scan above.

Messages now store `bodyTokens`: lowercased word tokens, with a multikey index compound with
`conversationId`. The fallback is an anchored `^prefix` match against that index, which Mongo
serves as an index range scan. Cost tracks the number of *matching* tokens instead of the size of
the history:

| | docsExamined | keysExamined | returned |
|---|---|---|---|
| old, `migrat` matches 320 | 3203 | 3203 | 320 |
| new, `migrat` matches 320 | **320** | 403 | 320 |
| old, matches nothing | 3203 | 3203 | 0 |
| new, matches nothing | **0** | 41 | 0 |

Existing messages are backfilled at boot, batched and capped per run so it can't hold up start-up,
and resumable by construction. Results report `matchedBy` (`text` / `prefix` / `none`) so a query
that behaves unexpectedly can be explained.

Search also gained offset paging with a capped depth, `nextOffset`, and `senderId` / `from` / `to`
filters.

## 3. A realtime gap the client could never notice

Redis pub/sub is at-most-once. If an instance loses its Redis connection, events published during
the outage are gone — and the client's **WebSocket stays open throughout**, so nothing tells the
browser it stopped receiving. The first pass only refetched on *WebSocket* reconnect, which never
happened. Silently missing messages, indefinitely.

Demonstrated at three replicas by stopping Redis with sockets open:

```
redis healthy:  6/6 sockets received the message
redis down:     per-socket delivery [1,1,1,1,1,1] of 3 sent
                (each POST hit a different replica; only that replica's own sockets got it)
all sockets stayed open: true          <-- nothing signalled a problem
redis back:     6/6 sockets received a resync nudge
catch-up:       recovered ["lost 0","lost 1","lost 2"]
```

Two parts:

- **The server notices.** The hub tracks its subscriber's connection state and, on recovery, sends
  every local client a `resync`.
- **The client can act on it.** `GET /api/messages?since=<id>` walks *forwards* from the last id a
  client saw, so it fetches exactly the gap. It reports `hasMore` so a client can walk a gap bigger
  than one page. This also replaced the previous reconnect behaviour, which refetched an entire
  conversation.

Realtime is best-effort delivery; HTTP is the source of truth. That was the intended design all
along — this is the piece that makes it true rather than aspirational.

## 4. Typing you could only see if you were already looking, plus presence

The client discarded any typing event whose conversation wasn't the open one, so you couldn't tell
someone was replying in another thread. Typing state is now keyed by conversation and surfaced in
the sidebar, where it replaces the last-message preview (it's the more current information).

Presence came with it, because "it feels dead" — the complaint behind `tasks/typing-indicator.md` —
is only half about typing. Online state is a sorted set per user whose members are that user's live
connections, scored by last heartbeat.

The design took two attempts, and the first one was wrong in an instructive way. It tracked one
timestamp per *user* and decided online/offline transitions by combining that with the instance's
own socket list. Those two sources disagree — a stale timestamp, or a connection on another
instance — and in testing it both suppressed a genuine "came online" and reported someone still
online after their last socket closed. Transitions are now derived entirely from the shared state,
atomically, in one Lua script that prunes, mutates, and reports the count before and after. Closing
one of two tabs correctly leaves you online; closing the last one doesn't.

## Bugs I introduced and caught in this pass

Worth listing separately, because they're mine:

- **`offset=0` returned 400.** The offset went through a positive-integer validator, which rejects
  zero — and zero is exactly what a first page asks for. Same class of bug for `since=0`, which
  means "everything from the beginning". Both now use a non-negative validator.
- **Graceful shutdown never ran.** `server.close()` only invokes its callback once every connection
  has ended, and a WebSocket never ends on its own — so closing the sockets *inside* that callback
  meant the callback never fired, the force-exit timer killed the process ten seconds later, and no
  cleanup happened. Sockets are closed first now. The visible symptom was users showing as online
  for the whole presence TTL after a restart; the invisible one was every restart taking ten
  seconds and skipping cleanup.
- **A test asserted `matchedBy === 'substring'`** after I renamed the strategy to `prefix`.
- **A test asserted exactly one search hit** for a token built from `Date.now()` — tokens from
  different runs share a leading prefix, so earlier runs legitimately matched too.

## Test-suite lessons

Two changes that aren't about product code but were the cause of real flakiness:

- **`close()` on a test WebSocket now waits for the socket to actually close.** Closing without
  waiting leaves the server holding a live connection until its heartbeat reaps it, so the *next*
  test sees that user as online. Presence assertions became order-dependent, and it took a while to
  see why.
- **Test files run sequentially** (`--test-concurrency=1`). They share one stack, one database and
  one rate limiter; running files in parallel meant one file's live sockets made another file's
  presence baseline unreachable.
- Presence tests use two new seeded users (Dave and Erin) that nothing else connects as, because
  asserting "X is offline" is only meaningful for an identity no other test holds a socket for.
