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

Superseded by a further pass into conventional Express layering — controllers, middleware, and app/
server separation. See [`07-structure.md`](07-structure.md).

## A note on the verification run

The final pass initially reported one failure at three replicas, and both scripts crashed with
ECONNREFUSED. That was Docker's daemon stopping mid-run, not the refactor — after restarting it,
70/70 passed at three replicas and both scripts were clean. Recording it because "one test failed
once" is worth knowing the cause of.


## Post-refactor manual pass

After the refactor I drove the whole app by hand in a browser — two tabs, every feature — rather than
trusting the suite. The suite was green throughout; the manual pass found three things it didn't.

**Two rendering races.** `openConversation` clears the pane and *then* awaits the history fetch, so
anything appended during that await raced with the render: a message sent inside the window ended up
above the history, and switching conversations quickly let a slower earlier fetch paint into the newer
conversation's pane. Both fixed (insert-above, plus a load generation guard).

The tests for these are worth a note. The first version of each **passed with its fix reverted**,
which makes them worse than nothing:

- The ordering test clicked and typed at normal speed, and the fetch always won. Delaying the history
  GET through request interception made the race deterministic — and that version immediately caught a
  *second* bug in my own fix: building the history fragment by hand skipped the dedup `appendMessage`
  does for free, so a message rendered by its broadcast and also present in the late history appeared
  twice. Worse than the bug I was fixing.
- The switching test seeded both conversations with identical message bodies, so it couldn't tell
  whose history had been painted.

Both now fail when their fix is reverted, which is the only evidence that a regression test is real.

**An overstated connection status.** The UI showed `live` the moment the socket opened. An open socket
receives nothing until the server has processed its subscribe frame, and anything published in that
gap is lost, because catch-up only runs on connect. This was the true cause of a UI test that failed
about one run in three at three replicas — I would have written that off as flakiness. The status now
reads `subscribing…` until the server's `subscribed` acknowledgement arrives.

**A demo-data bug.** `generate-demo-data.ts` spaced conversations an hour apart while spacing messages
a minute apart, so any conversation longer than 60 messages overflowed into the future — an inbox
sorted by a timestamp that hadn't happened yet. It briefly looked like an ordering bug in the app;
`EXPLAIN` on the actual data showed the app was sorting correctly and the generator was wrong.

What the manual pass confirmed working, for the record: pagination (50 of 70, then load-older to 70,
no duplicates), send with optimistic reconciliation (one copy, count and preview updated), live
delivery between two tabs, typing in both the open conversation and the sidebar, presence dots and the
header line, unread counting and clearing and surviving a reload, search by whole word / prefix /
no-match plus paging 25→50, both rate limits surfacing in the UI with the typed text preserved,
conversation creation, XSS payloads rendering as literal text, and reconnect-with-catch-up after the
API was stopped and restarted underneath an open page.
