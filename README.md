# Relay

Hey — thanks for taking a look at this. Quick bit of context, honestly:

> I've been putting together this little chat / inbox app in my spare time. I rushed it, and I'm
> pretty sure I didn't think a bunch of things through — a few bits don't behave right once you
> actually use it. On top of that I never got around to the features I wanted. I could really use
> a second pair of hands.

So, a few things, if you don't mind:

1. **Get it running** and have a play with it.
2. **Something's off.** A few things don't behave the way they should once there's real traffic.
   Track down what you can and fix it — and leave me a short note per fix on what was actually wrong.
3. **Build some features.** I didn't finish the fun part. The things I had in mind are written up in
   [`tasks/`](tasks/) — pick whichever appeal to you and build **as many as you like** (or your own
   idea). No need to do them all; do good work on the ones you take.
4. **Anything you'd just do differently — do it (or note it).** I rushed this, so the structure, the
   types, bits of plumbing that aren't there... some of it probably makes you wince. If you'd change
   something, improve what bugs you most, or drop a note in [`docs/`](docs/) on what you'd change and
   why. I won't be offended — I'd rather see how you think about it.

## Running it

```
cp .env.example .env
docker compose up --build
```

Then open <http://localhost:3000>. It seeds a couple of demo users and conversations on first boot.

To try the two-person features (typing indicator, unread badges), open a second tab pinned to a
different user — identity is per-tab:

```
http://localhost:3000/?userId=1     # Alice
http://localhost:3000/?userId=2     # Bob
```

### Running several instances

```
docker compose up -d --scale api=3
```

Realtime state is shared through Redis, so replicas are interchangeable. `curl localhost:9901/clusters`
shows which replicas Envoy has discovered, and `/api/health` reports which one served you.

### Tests

139 tests — 81 API-level, 17 in a real browser, 41 unit tests (the error-handling helpers, the
WebSocket connection lifecycle, the process error policy, and the browser helpers):

```
npm install
npm test              # needs the stack up
npm run typecheck
npm run audit:tasks   # checks every requirement in tasks/ and prints the evidence
npm run test:postman  # the load-balancing checks as a Postman collection, via Newman
```

Worth running against `--scale api=3` as well — a single instance is exactly what hid the
multi-instance fan-out bug in the first place.

Scripts for the specific problems in the original build:

```
node scripts/probe-realtime.mjs               # does a message reach every connected client?
docker compose exec api \
  node scripts/probe-ws-lifecycle.mjs         # does a socket that dies mid-subscribe leak channels?
node scripts/probe-scaling.mjs                # is traffic really spread, and does the app still
                                              # behave like one system? (read-only)
node scripts/probe-failover.mjs               # what a connected user experiences when a replica
                                              # goes away, hard and gracefully (stops one at a time,
                                              # and starts it again afterwards)
node scripts/bench-send.mjs 50                # what does a send burst do to read latency?
node scripts/audit-tasks.mjs                  # every tasks/ requirement, with evidence
docker compose exec api npx tsx scripts/generate-demo-data.ts 30 60
                                              # bulk demo messages, for looking at search
```

A note on rebuilding: only source directories are bind-mounted, so `node_modules` is the one in the
image. Adding a dependency needs `docker compose up --build`. `docker compose down -v` resets all
data to the seeded demo state.

## Ground rules

- **Work in your own copy.** Clone this repo, push it to a fresh repo of your own, and send us the
  link when you're done. Public is fine.
- **Leave your working *in* the repo.** Notes, plans, decisions, dead ends — whatever you scribbled
  while figuring it out, commit it. There's a [`docs/`](docs/) and a [`spec/`](spec/) folder for
  exactly that. We care as much about *how* you worked as the final result, so please don't tidy it
  away before you send it.
- **No hard time limit.** A few focused hours is already a solid showing; if you're enjoying it, go
  further.
- Use whatever tools and setup you normally work with.
- Send us **just the link to your repo**, plus a short note on what you changed and why — what was
  broken, what you fixed, what you built.


---

# Notes from me (Filip)

Thanks — this was a good one to dig into. Everything below is in the repo as you asked.

**Where things are:**

| | |
|---|---|
| [`docs/01-investigation.md`](docs/01-investigation.md) | the 13 bugs I found, each reproduced with the command that shows it |
| [`spec/plan.md`](spec/plan.md) | how I sequenced the work, and why in that order |
| [`docs/03-changes.md`](docs/03-changes.md) | what I changed and why, with before/after numbers |
| [`docs/04-tradeoffs.md`](docs/04-tradeoffs.md) | what I deliberately *didn't* do, and the reasoning |
| [`docs/05-hardening.md`](docs/05-hardening.md) | a second pass closing the gaps the first one left, including bugs I introduced myself |
| [`spec/refactoring-plan.md`](spec/refactoring-plan.md) | the SOLID/KISS/DRY plan — including what I deliberately would not do |
| [`docs/06-refactoring.md`](docs/06-refactoring.md) | executing it, the outcome against the plan's own targets, and what it found |
| [`docs/07-structure.md`](docs/07-structure.md) | Express layering — controllers and middleware, and the plan decision I reversed |
| [`docs/08-review-fixes.md`](docs/08-review-fixes.md) | a code review of the whole branch, the 12 findings, and the one mistake three of them share |
| [`docs/09-scaling.md`](docs/09-scaling.md) | testing the load balancing at 3 and 5 replicas — including two bugs that only exist between the app and how it is launched |
| [`postman/README.md`](postman/README.md) | the same load-balancing checks as a Postman collection, and what it deliberately cannot cover |

## The short version

**Two bugs stood out**, because they weren't really about correctness:

*One bad request killed the whole server.* The async route handlers had no error handling, and
Express 4 doesn't catch a rejected promise from an `async` handler — so an unhandled rejection
terminated the process. A duplicate participant id in a request body was enough to restart the API
and drop every WebSocket on it. Any unauthenticated caller could do it at will.

*Every message send blocked the event loop for 20ms.* `createMessage` signed each body with
`pbkdf2Sync` at 200,000 iterations. That's a password-stretching KDF used synchronously on the main
thread, so the cost landed on everyone: an idle 4ms read became a 790ms read during a send burst.
It was also keyless with a hard-coded salt, so it provided no authenticity for its 20ms. A keyed
HMAC does the actual job 14,000x faster.

**And the one you predicted.** Realtime didn't survive `--scale api=3` — the hub kept its client
set in process memory, so a broadcast only reached sockets on the instance that handled the POST.
2 of 6 clients got the message. What makes it nasty is the failure mode: no error anywhere, the
sender's own tab usually works fine, messages just quietly don't arrive for other people.

The rest, briefly: retried sends duplicated messages (`client_id` existed but nothing read it);
re-running the seed silently blanked every message body you'd ever sent (64 of 66, on every
restart); nobody checked whether you were actually in a conversation before letting you post to it
or subscribe to it; `messages` had no index on `conversation_id`; the conversation list ran 2N+1
queries; `GET /api/messages` returned the entire conversation history; the WebSockets had no error
handler, no heartbeat and no client reconnect; and conversation titles went through `innerHTML`.

**Built all four tasks** — multi-instance realtime (Redis pub/sub, refcounted per conversation),
rate limiting (atomic sliding window in Lua, `429` + `Retry-After`, per user per conversation,
fails open), search (Mongo `$text` ranked, scoped to your own conversations, with a bounded
substring fallback for partial words), and the typing indicator (over the same Redis path, so it
works multi-instance too).

**Two things I'd flag as my judgement calls rather than requirements:** the rate limiter fails
*open* if Redis is down, because a chat app that stops delivering messages when its limiter breaks
has turned a safeguard into an outage — I'd invert that for anything money-related. And I added
server-side unread state, which is scope I chose: the dot was a browser variable that vanished on
reload, and `tasks/multi-instance.md` asks for it to keep working across instances, which isn't
possible client-side.

**What I'd do next, in order:** real authentication (I added authorization, but it's over a claimed
identity, which only stops accidents); close the last gap in the two-store write, or question why
the body and the id live in different databases at all; and move search off `$text` when volume
justifies it. All three are written up in `docs/04-tradeoffs.md`.

I also added a test suite (59 tests, against the real stack — the multi-instance bug is only
visible that way) and scripts that reproduce the original problems, so the before/after numbers in
`docs/03-changes.md` are re-runnable rather than just claimed. `npm run audit:tasks` checks each
requirement in `tasks/` one at a time and prints the evidence.

## A second pass

After the above I went back over my own work and found that the first pass had left real gaps —
written up in [`docs/05-hardening.md`](docs/05-hardening.md). The one that mattered:

**I'd only rate-limited sending, and search was the expensive endpoint.** Worse, the substring
fallback I'd added to make partial-word search work was examining every message in the caller's
history to return nothing — so `?q=zzzz1`, `?q=zzzz2`, … was an unmetered way to generate unbounded
read load. Fixed on both sides: search is metered, and the fallback is now an anchored prefix match
against an index, which took `docsExamined` from 3203 to 0 on a query that matches nothing.

Also: a realtime gap the client could never detect (Redis pub/sub is at-most-once, and the
WebSocket stays open through a Redis outage, so the browser silently stopped receiving — now the
server sends a resync nudge and `?since=` fetches exactly the gap); typing surfaced in the sidebar
so you can tell someone's replying in another thread; and presence, which took two attempts to get
right.

Four of the bugs in that document are ones I introduced myself, including a graceful shutdown that
never actually ran because it waited on `server.close()`, whose callback can't fire while a
WebSocket is open. They're listed as mine.
