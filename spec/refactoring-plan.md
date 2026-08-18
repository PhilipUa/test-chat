# Refactoring plan — SOLID / KISS / DRY

Every item below names the file and the measurement that motivates it. Nothing here changes
behaviour; the 59 tests and `npm run audit:tasks` are the harness that proves it.

The plan is deliberately in two halves: **what to change**, and **what to leave alone**. Applying
SOLID without the KISS half is how a 3,300-line app grows a dependency-injection container, and the
second list is where most of the judgement is.

## Baseline

```
778  web/app.js                 377  src/ws/hub.ts             250  src/services/conversations.ts
242  src/services/messages.ts   204  src/services/search.ts    170  src/db/migrate.ts
                                                              3305  total (src + web)
```

Layering is already clean and worth preserving: `routes → services → db`, `ws → services → db`, and
no service ever imports the transport layer. Nothing below disturbs that direction.

---

## Tier 1 — DRY, and the type safety that makes the rest safe

Highest value, lowest risk. Do this first: it's mechanical, and it's what makes Tier 2's file moves
verifiable by the compiler rather than by hope.

### 1.1 Type the database rows (22 call sites)

```
pool.query<any[]> / execute<any> : 22 call sites
untyped (r) => / (row) => callbacks : 18
```

`tsconfig` says `strict`, and then every row that comes out of MySQL is `any`. That's the largest
hole in the project's type safety, and it's in exactly the place where a typo costs most — the
mapping between column names and JSON fields.

- Declare row interfaces next to the query that produces them (`MessageRow`, `ConversationRow`,
  `ParticipantRow`).
- Add one thin helper in `src/db/mysql.ts`:
  `queryRows<T>(sql, params): Promise<T[]>` wrapping `pool.query` and the tuple destructuring.
- Replace the 22 sites. The compiler then finds every `r.senderId` that should be `r.sender_id`.

Do this before any file moves, so the moves are checked.

### 1.2 One SQL list helper (5 hand-built copies)

```
src/services/conversations.ts:107, 134, 153, 200, 244
  IN (${ids.map(() => '?').join(',')})
```

Five hand-rolled placeholder builders, one of them the two-column `(?, ?)` variant. All correctly
parameterised, but the pattern is exactly the one that gets "simplified" into string interpolation
by the next person in a hurry.

```ts
sqlList(n)          // '?,?,?'
sqlRows(n, cols)    // '(?, ?),(?, ?)'
```

### 1.3 One `Message` mapper (duplicated in the same file)

`src/services/messages.ts:155` and `:231` build the same object from a row plus a body, field for
field. Two copies in one file, 76 lines apart — if one gains a field the other silently won't.

Extract `toMessage(row: MessageRow, body: string): Message`.

### 1.4 One body-lookup helper (duplicated across services)

```
src/services/messages.ts:227      const bodyById = new Map(bodies.map((b) => [b._id, b.body]));
src/services/conversations.ts:67  const bodyById = new Map(bodies.map((b) => [b._id, b.body]));
```

"Given message ids, fetch bodies from Mongo and index them by id" is the join between the two
stores, written twice. It belongs in one place — `messageBodiesById(ids): Promise<Map<number,string>>`
— because it's the seam where the split-store design is most likely to change.

### 1.5 Collapse five integer validators into one

```
positiveInt · optionalPositiveInt · optionalNonNegativeInt · boundedInt · boundedNonNegativeInt
```

Five near-identical parsers differing in optionality, a minimum, and a cap. **This duplication
already caused two bugs**: `offset=0` and `since=0` both returned 400, because the zero-handling was
decided independently in each copy and two of them got it wrong. That is the DRY argument in its
strongest form — not "less code", but "one place to be correct".

```ts
int(value, field, { min = 1, max, optional = false, fallback })
```

Keep thin named wrappers if they read better at the call site, but one implementation underneath.

### 1.6 Share the Lua clock preamble (3 copies)

```
src/services/rate-limit.ts:40   local now_parts = redis.call('TIME') …
src/services/presence.ts:35     (same three lines)
src/services/presence.ts:48     (same three lines)
```

Three copies of the same "read Redis's clock as milliseconds" preamble. Extract a `LUA_NOW_MS`
constant and compose the scripts from it. Also fold `serverNowMs()` (`presence.ts:134`) into a
shared `src/db/redis-time.ts`, since the rate limiter needs the same notion of "the shared clock".

Do **not** build a script-runner abstraction. A shared string constant is the whole fix.

### 1.7 Two one-line tidies

- `src/ws/hub.ts:6` and `:21` import from `services/conversations.ts` **twice**. Merge.
- `src/ws/events.ts:53,56` write the `'relay:conv:'` prefix twice — the parser and the builder can
  disagree. One `CHANNEL_PREFIX` constant.

---

## Tier 2 — SRP, where a file has outgrown one reason to change

### 2.1 Split `ws/hub.ts` (377 lines, 8 responsibilities)

It currently owns: the connection registry, frame parsing and protocol dispatch, subscription
authorization, typing, presence orchestration, refcounted Redis channel subscription, the heartbeat,
and fan-out. Eight reasons to change one file, and it's the file most likely to be edited next.

```
ws/registry.ts   the client set, add/remove/send, heartbeat
ws/channels.ts   refcounted Redis subscribe/unsubscribe
ws/fanout.ts     publish() + deliverLocally()
ws/protocol.ts   frame parsing and dispatch (subscribe / typing / ping)
ws/hub.ts        wiring only — attachWs, closeWs, hubStats
```

Five files, none over ~120 lines, each with one reason to change. Stop there: no plugin registry, no
handler base class.

### 2.2 `createMessage` — six responsibilities in one function

Idempotency lookup, timestamp, MySQL insert, duplicate-race recovery, signing, Mongo write,
compensating delete, and the `last_message_at` touch (since removed — see `docs/08-review-fixes.md`).
The dual-store write is the delicate part and
it's interleaved with everything else.

- `services/message-signing.ts` — the HMAC and `verifySignature`.
- `services/message-store.ts` — "write a message to both stores, or neither", including the
  compensation. One job, and the one whose failure modes need reading carefully.
- `createMessage` keeps the policy (dedupe → write → touch) and reads top to bottom.

### 2.3 Split `services/conversations.ts` (250 lines, three roles)

Read models, writes, and authorization currently share a file, and `assertParticipant` /
`participantConversationIds` are imported by routes, search **and** the WS hub. Membership is a
different concern from "the inbox read model" and has the widest fan-in.

```
services/conversations/membership.ts   assertParticipant, participantConversationIds, participantIdsOf
services/conversations/queries.ts      listConversations, participantsFor, conversationTitles
services/conversations/commands.ts     createConversation, markRead
```

Also drop the `export { isDuplicateKeyError }` re-export at `:250` — a pass-through that hides where
the symbol really comes from.

---

## Tier 3 — OCP, only where change actually happens

Event types are the one axis this codebase has genuinely grown along: `message` → `+typing` →
`+read` → `+presence` → `+presence-snapshot` → `+resync`. That makes the two switches below worth
opening for extension; nothing else here is.

### 3.1 Move delivery rules onto the events

`deliverLocally` (`hub.ts:307`) grows a special case per type:

```ts
if (event.type === 'typing'   && event.userId === client.userId) continue;
if (event.type === 'presence' && event.userId === client.userId) continue;
```

Both encode one rule — "don't tell someone about their own action" — in a place that has to be
edited for every new event type. Put it with the event definition in `events.ts`
(`{ echoToSelf: false }`, or a `shouldDeliver(event, client)` per type) and let `deliverLocally`
apply it generically.

### 3.2 Search strategies as an ordered list

`searchMessages` runs `$text`, then falls back to prefix via `if (!docs.length)`. Two strategies
inline, with the fallback rule expressed as control flow. An ordered array of
`{ name, run(filter, opts) }` iterated until one returns hits makes the precedence explicit and
adding a third additive — and it's the part of the app most likely to gain one (fuzzy matching,
or an external engine per `docs/04-tradeoffs.md`).

Two strategies is the threshold where this becomes worth it, not before.

---

## Tier 4 — the frontend (778 lines, one mutable global)

`web/app.js` is the largest file in the project and holds every concern behind one `state` object:
data loading, sidebar, message pane, WebSocket lifecycle, typing, presence, send, search, identity.
It already mirrors the server's event switch, so 3.1 applies here too.

Split into native ES modules — `<script type="module">`, no build step, keeping the
zero-tooling property the original had:

```
state.js            the store, and the only place it is mutated
api.js              fetch wrapper + error shape (already DRY — just move it)
socket.js           connect, backoff, resubscribe, resync
views/sidebar.js    views/messages.js    views/search.js
features/typing.js  features/presence.js
```

One extra thing to fix while in there: `renderSidebar()` rebuilds the entire list on every incoming
event. Correct, and O(conversations) per keystroke of somebody else's typing. Worth targeted updates
once the view is isolated — but only after the split, and only if it's measurable.

---

## What I am deliberately not doing

The other half of the plan. Each of these is a defensible reading of SOLID that would make this
codebase worse.

- **No DI container, and no interface-per-service.** There is exactly one implementation of every
  service. `import` *is* the injection. Interfaces with a single implementor are ceremony that adds
  a file and an indirection per concept and buys nothing until a second implementation exists.
- **No repository pattern hiding MySQL and Mongo behind a generic store.** Tempting, and wrong: the
  whole difficulty of this app is that the two stores have *different* semantics and no shared
  transaction. An abstraction that makes them look alike is precisely what would let the next
  cross-store consistency bug hide — the original one rendered as an empty string for exactly that
  reason. 1.4 shares the *join*, not the storage model.
- **No `BaseService` / inheritance hierarchy.** Composition of plain exported functions is already
  the simpler thing.
- **No controller classes for routes.** The routers are 13–89 lines and read as a list of
  endpoints. Wrapping them in classes adds indentation, not clarity.
- **No Lua script-runner framework** (1.6 shares a string).
- **No renaming for consistency's sake**, and no reformatting commits. Both bury real changes in
  diff noise.
- **Not touching `db/migrate.ts`** (170 lines) despite its repetition. Migrations are append-only
  history; DRYing them up means editing the past, and a shared helper that changes behaviour
  retroactively is a genuinely bad trade.

---

## Sequencing and safety

Tier 1 → 2 → 3 → 4, and within each, one item per commit.

1. **Tier 1 first**, because 1.1 turns the compiler into the safety net for everything after it.
2. **No behaviour changes bundled with moves.** If a refactor reveals a bug — likely, given 1.5
   already exposed two — fix it in a separate commit that says so.
3. After each item: `npm run typecheck`, `npm test` (at one instance **and** at `--scale api=3` —
   several of these touch the fan-out path, and single-instance is what hid the original bug), and
   `npm run audit:tasks` to confirm the four tasks still do what they claim.
4. Tier 4 has no test coverage (the suite is API-level). Either verify it by hand in two tabs each
   step, or add Playwright coverage for the handful of UI behaviours *first* — that's the honest
   prerequisite for touching 778 lines of untested frontend, and the reason Tier 4 is last.

## Expected outcome

| | before | after |
|---|---|---|
| `any` in DB access | 22 call sites | 0 |
| SQL placeholder builders | 5 | 1 |
| integer validators | 5 | 1 |
| Lua clock preambles | 3 | 1 |
| `Message` row mappers | 2 | 1 |
| body-lookup joins | 2 | 1 |
| largest server file | 377 lines | ~120 |
| largest frontend file | 778 lines | ~150 |

Line count will go *up* slightly. That's fine and expected: the win is one place to change per
concept, and a compiler that can check the mapping layer — not fewer characters.
