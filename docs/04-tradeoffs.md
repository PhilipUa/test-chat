# Trade-offs, and what I deliberately left alone

The things I decided *not* to do matter as much as the things I did, so here they are with
reasoning. Roughly in order of how much they'd bother me in a real deployment.

## Known gaps I'd fix next

### There's no authentication

`senderId` and `userId` are request parameters. I added *authorization* — you can't post into a
conversation you're not in, or subscribe to one, or search it — but authorization over a claimed
identity only stops accidents, not an attacker: anyone can claim to be user 2.

I left it out on purpose. Real auth means sessions or tokens, a login screen, and a decision about
where identity lives, which is a design conversation rather than a bug fix, and it would have
rewritten every endpoint and obscured the actual fixes. The shape I've built assumes it though: an
authenticated `req.user.id` would replace the `userId`/`senderId` parameters at exactly the
`positiveInt(...)` call sites, and every `assertParticipant` check stays as-is.

One consequence: `GET /api/messages` takes `userId` as *optional*, and only enforces membership
when supplied, so the original endpoint contract still works. That's a knowingly soft edge — with
real auth it becomes mandatory. It's the one place I chose compatibility over strictness, and I'd
reverse it the moment identity is trustworthy.

### The two-store write has a small hole left in it

`createMessage` writes MySQL then Mongo, and deletes the MySQL row if Mongo fails. But if the
process is killed *between* the two writes, the compensating delete never runs and a bodyless row
survives — which renders as an empty message forever.

The window went from "any Mongo failure, permanently" to "a process death inside a few
milliseconds", which is a big improvement but not a guarantee. Doing it properly means either:

- **an outbox**: write the body and an intent in one store, have a worker complete the other and
  retry until it succeeds; or
- **stop splitting the write**: the reason a message's id and ordering live in MySQL while its text
  lives in Mongo isn't clear to me from the code, and the split is the source of this whole class
  of problem. If there's no strong reason, putting the body in MySQL alongside the row makes the
  write atomic and deletes the failure mode rather than managing it.

I'd want to know why the split exists before proposing to remove it, so I've left it and written it
down. A reconciliation query (`messages` rows with no Mongo document) would at least make the
residue visible.

### Search is good, not great

Mongo's `$text` is a reasonable answer at this size and needs no new infrastructure. It's also
word-based, single-language (`english` stemming), and can't do fuzzy matching or typo tolerance.
The regex fallback covers partial words but is a collection scan — bounded to the caller's own
conversations and to queries where `$text` found nothing, but still linear.

At real volume this wants a search engine (Elasticsearch/OpenSearch, or Postgres full-text if the
stores consolidated), fed asynchronously. I didn't reach for that because standing up another
service for a demo dataset is the wrong trade, and the interface (`searchMessages`) is narrow
enough to swap out behind.

Also unimplemented: paging past the first page of results. `hasMore` is reported honestly and the
UI says "narrow the search" rather than pretending the list is complete — I'd rather show a visible
limit than silently truncate.

### The rate limiter fails open

If Redis is unreachable, sends are allowed and uncounted. That's a deliberate availability-over-
enforcement call for a chat app: refusing to deliver messages because the *limiter* is down turns a
protection mechanism into an outage. It's logged, and the response omits rate-limit headers so a
client can tell the limiter isn't authoritative.

For an endpoint where the limit is a hard requirement — payments, password attempts — I'd invert
this and fail closed. It's a per-endpoint judgement, not a global one.

Also: a retry with an already-seen `clientId` returns the stored message but still counts against
quota. Conservative on purpose (a retry loop is exactly the traffic being limited) and the caller
still gets a correct response, but you could argue it either way.

## Smaller decisions

- **No foreign keys.** The schema has none, and I didn't add them; membership and existence are
  enforced in the service layer instead. FKs would be better, but adding them to a table with
  existing unreferenced rows is a data-cleanup migration, and the app-level checks close the actual
  hole. I'd add them with a proper backfill.
- **`conversations.last_message_at` is best-effort.** Updated after a successful send, and a
  failure there is swallowed — it only affects inbox sort order, so it must never fail a send that
  already succeeded. It's derived data; the correct value is always recomputable from `messages`.
- **User names cached in-process for 60s.** They're on the per-keystroke typing path. Names
  effectively never change, so a TTL beats an invalidation protocol. A rename takes up to a minute
  to show.
- **Redis pub/sub is at-most-once.** If an instance is disconnected from Redis at the moment of a
  publish, its clients miss that event. This is why the browser refetches the open conversation on
  every reconnect: realtime is best-effort delivery, HTTP is the source of truth. Guaranteed
  delivery would mean Redis Streams with per-client cursors — much more machinery for a typing
  indicator and a new-message ping.
- **One Redis channel per conversation, refcounted.** Simpler would be a single global channel with
  local filtering; that means every instance receives every conversation's traffic, which stops
  scaling at exactly the point this exercise is about. Per-conversation channels cost a
  SUBSCRIBE/UNSUBSCRIBE round trip when a socket's first/last subscription for a conversation
  comes and goes.
- **The message signature isn't verified on read.** `verifySignature` exists and is tested by
  construction, but nothing calls it on the read path — I didn't want to add an unrequested failure
  mode (what should a body that fails verification render as?). The seeded demo rows have an empty
  signature, so they'd fail it; a real deployment would backfill and then enforce.
- **`X-RateLimit-*` are informational.** Not the RFC 9331 `RateLimit` header. Fine for this app;
  I'd use the standard header if third parties consumed the API.
- **Envoy retries POSTs.** Only safe because sends are idempotent on `clientId` — a retried POST
  returns the original message rather than writing a second one. A send *without* a `clientId`
  could be duplicated by a retry, which is another reason clients should always send one.
- **Tests hit the real stack** rather than mocking. They catch integration bugs (the multi-instance
  fan-out bug is *only* visible this way), at the cost of needing Docker up and being slower.
  They're also subject to the rate limiter, which is why `seedMessages` paces itself — a naive loop
  gets throttled at 5 and fails for the wrong reason.

## Things I noticed and consciously skipped

- No CI config — nothing to run it on, but `npm test` and `npm run typecheck` are what a workflow
  would call.
- No structured logging. `console.log` with an instance prefix is enough at this size; anything
  real wants JSON lines with a request id.
- No linter. There was none, and adding one would have produced a diff dominated by formatting.
- The frontend is vanilla JS with no build step, which I kept deliberately — it's ~600 lines and a
  framework would have made the diff unreviewable.
- No message editing, deletion, attachments, or read-receipt display beyond the unread badge. Out
  of scope.
- `docker/db/mysql.sql` and `src/db/migrate.ts` describe the same schema in two places, which can
  drift. A single migration path (drop the init SQL, always migrate) would be better; I kept the
  init file so a fresh volume starts correct in one step, and noted the duplication in both files.
