# Refactoring: what was done, and what it found

Execution of [`../spec/refactoring-plan.md`](../spec/refactoring-plan.md), all four tiers.
Behaviour-preserving throughout: 70/70 tests pass at one instance and at three, `npm run audit:tasks`
still verifies 20/20 requirements from `tasks/`, and `scripts/probe-realtime.mjs` still reports 6/6
fan-out.

## Outcome against the plan's own table

| | before | planned | actual |
|---|---|---|---|
| `any` in DB access | 22 call sites | 0 | **0** |
| SQL placeholder builders | 5 | 1 | **1** (`sqlList`/`sqlRows`) |
| integer validators | 5 | 1 | **1** implementation, 3 thin wrappers |
| Lua clock preambles | 3 | 1 | **1** |
| `Message` row mappers | 2 | 1 | **1** |
| body-lookup joins | 2 | 1 | **1** |
| largest server file | 377 (`ws/hub.ts`) | ~120 | **247** (`services/search.ts`) |
| largest frontend file | 778 (`web/app.js`) | ~150 | **169** (`js/socket.js`) |
| total server lines | 2,481 | up slightly | 2,957 |

Two honest misses:

- **The largest server file is 247, not ~120.** `ws/hub.ts` did go from 377 to 134, but
  `services/search.ts` grew from 204 to 247 when the two search strategies became declared objects
  with types. That's the line-count-goes-up trade the plan predicted, landing in a place it didn't
  predict. I'd rather have the explicit strategy list.
- **Line count rose ~19%**, as the plan said it would. The win is one place to change per concept and
  a compiler that checks the mapping layer, not fewer characters.

## What the refactor found

Three things, none of which were the point of the exercise — which is the argument for doing it.

**A presence N+1 I had introduced.** `sendPresenceSnapshot` ran two round trips *per subscribed
conversation* — `participantIdsOf` then `onlineAmong`. Invisible with two conversations. A test
account with 1,083 of them (test debris) was issuing ~2,000 queries before its socket was usable,
which is what made one UI test fail about one run in three. Found by instrumenting the flake instead
of adding a retry. Now two round trips total:

```
subscribe ack:      45ms   (1,088 conversations)
presence snapshot: 112ms
```

Exactly the shape of the original 2N+1 conversation-list bug, reintroduced by me in a different
place.

**The five duplicated integer validators were a real bug, not a style problem.** They're why
`?offset=0` and `?since=0` both returned 400: each copy decided zero-handling independently and two
decided wrongly. Collapsing them is why that class of bug can't recur.

**Two of my own test bugs**, both "waited for the wrong thing": waiting for `#userSelect` to exist
(it's in the static HTML, so it matched before `loadUsers()` filled it) and typing before the socket
had acknowledged `subscribe` (`sendTyping` correctly does nothing when the socket is closed).

## Deviations from the plan

- **Tier 2.3 barrel deleted.** I wrote a `conversations/index.ts` re-exporting all three halves so
  the split wouldn't touch call sites. Then every consumer turned out to want one specific half —
  search, the WS protocol and the messages route only need `membership` — so importing the half is
  both more honest about the coupling and the actual point of the split. That left the barrel with no
  importers, so it went.
- **Pass-throughs removed, including one I added.** The plan flagged the old
  `export { isDuplicateKeyError }` re-export; I then created the same smell in `message-store.ts`
  during Tier 2.2. Both gone.
- **Tier 4 got its browser tests first**, as the plan required — 11 Playwright tests written against
  the *pre-refactor* code, asserting only what a user can see. They needed no changes when the
  frontend became nine modules, which is the whole point: they verified the move rather than being
  rewritten by it.
- **`renderSidebar` still rebuilds the whole list on every event.** Correct, and O(conversations) per
  incoming keystroke. The plan said leave it until it's measurable; it isn't yet. Now that the view
  is one 83-line file, targeted row updates are a contained change.

## What I did not do, and still wouldn't

Unchanged from the plan: no DI container, no interface-per-service, no repository pattern over
MySQL+Mongo (the two stores have genuinely different semantics and no shared transaction — an
abstraction that hides that is what let the original cross-store bug render as an empty string), no
base classes, no controller classes, no reformatting commits, and `db/migrate.ts` stays repetitive
because migrations are append-only history.

## Structure now

```
src/
  db/       mysql (typed helpers) · mongo · redis · redis-time · migrate
  http/     errors · validate · rate-limit-headers
  routes/   conversations · messages · search · users
  services/ conversations/{membership,queries,commands} · messages · message-store
            message-signing · search · presence · rate-limit · users
  ws/       hub (wiring) · registry · channels · fanout · protocol · events
web/js/     state · api · socket · main · views/{sidebar,messages,search,notice}
            features/{typing,presence}
```

## A note on the verification run

The final pass initially reported one failure at three replicas, and both scripts crashed with
ECONNREFUSED. That was Docker's daemon stopping mid-run, not the refactor — after restarting it,
70/70 passed at three replicas and both scripts were clean. Recording it because "one test failed
once" is worth knowing the cause of.
