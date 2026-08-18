# Testing the load balancing, and the three things it found

`tasks/multi-instance.md` was already built and passing. This pass was about proving it — and the
proving turned up three bugs, none of which the existing tests could see, because they were all about
what happens to a *process*, not to a request.

Verified against `docker compose up -d --scale api=3` and again at `--scale api=5`.

## First, a prerequisite nobody had: which replica served this?

`/api/health` reported its own `instanceId`, which answers "which process am I talking to?" for exactly
one endpoint — and never for the request you actually care about. Behind a round-robin proxy the
interesting failures are the intermittent ones, and "it only happens sometimes" is usually "it only
happens on one replica". You cannot chase that without being able to attribute a response.

Every response now carries `X-Relay-Instance`, including errors and static files. That one header is
what makes the rest of this measurable: `scripts/probe-scaling.mjs` uses it to check that traffic
really is spread, and that every replica gives the *same* answer about shared state.

## What load balancing looks like when it is working

```
═══ load balancing ═══
  replicas answering: 8df1b644ac90, 91a1160c0fed, 41407fe9a605, 906cc9d3b486, 2cf5423b8220
  envoy api cluster: 5/5 endpoints healthy
  PASS  every discovered endpoint actually served a request
  PASS  HTTP requests reach every replica
          90 requests: 8df1b644ac90=18 91a1160c0fed=18 41407fe9a605=18 906cc9d3b486=18 2cf5423b8220=18

═══ realtime across replicas ═══
  PASS  every WebSocket is accounted for by some replica          10 opened, replicas gained 10
  PASS  WebSockets are spread across replicas, not pinned to one  5/5 took at least one
  PASS  a message reaches every connected client exactly once     per-socket copies: [1,1,1,1,1,1,1,1,1,1]
  PASS  a typing indicator reaches clients on other replicas      9/9 other sockets saw it
  PASS  presence reads the same from every replica
```

Scaling from 3 to 5 needed no proxy restart — `STRICT_DNS` re-resolves, and the two new replicas were
serving an even share within seconds. The distribution being *exactly* even (18 each) is round-robin
doing what it says.

The probe checks the two questions separately on purpose: is traffic actually spread, and given that,
does the app still behave like one system. A probe that quietly ran against a single replica would pass
every cross-replica assertion while proving nothing, so it fails if the endpoints it can see don't all
answer.

One thing that cost me a wrong result first time round: I asserted absolute socket counts, and a
browser tab left open on the machine made the probe report someone else's clients as a leak. Every
count is a *delta* now, which is the same lesson the WebSocket unit tests already encode.

## 1. The graceful shutdown never ran, because npm was PID 1

`docker-compose.yml`, `docker/app/Dockerfile`

`closeWs()` deregisters presence on the way out, and says why:

> Without this, a rolling deploy leaves every connected user looking online for the whole presence TTL.

It never ran. `command: npm start` makes **npm** PID 1, so the SIGTERM from a scale-down went to npm,
which killed its child rather than letting it shut down:

```
relay [91a1160c0fed] listening on :3000
npm error signal SIGTERM
npm error command sh -c tsx src/index.ts
```

No `SIGTERM received` line at all. Measured through the user-visible consequence — a user connected to
the drained replica still read as online 30s later, with the 90s TTL doing the cleanup instead of the
code written for it. Fixed by running `node` directly so it receives the signal itself; presence now
releases in about 3s.

This is the kind of bug that only exists in the gap between the app and how it is launched, which is
why neither the test suite nor a code reading would ever have found it. It took stopping a container.

## 2. …and once it ran, it never finished

`src/ws/registry.ts`, `src/ws/hub.ts`, `src/server.ts`

With the signal arriving, the shutdown reached its 10s force-exit every single time — so everything
after the hang was skipped. Rather than guess, I made each phase report its own duration, which pointed
straight at it:

```
[shutdown] presence deregistered in 1ms
[shutdown] sockets closed in 1023ms (1 terminated without replying)   <- the hang was here
[shutdown] ws server closed in 1ms
[shutdown] http server closed in 1ms
[shutdown] databases closed in 12ms
[shutdown] complete
```

`WebSocketServer.close()` only calls back once its client set is empty, and `ws.close()` starts a close
*handshake* — a socket whose peer never replies stays in that set for ws's 30s close timeout. So one
unresponsive client was enough to stall every shutdown.

Now: ask politely first (1001 is what tells a browser to reconnect elsewhere rather than treating it as
an error), wait briefly for peers to answer, then terminate whatever is left. A whole drain is ~1s.

The per-step timings stayed in. This is on the critical path of every deploy, and "the shutdown is slow"
is unattributable without them — as this bug demonstrated.

A related guard went into the HTTP close, and it's worth recording what the evidence actually supports:
the hang was entirely in `closeWs`, and on a quiet stack the HTTP step measures 0ms either way. But on a
drain with traffic still arriving, the probe logged `http server closed in 3003ms` — the drain deadline
firing and bounding what would otherwise have run into the force-exit. So it earns its place, just not
for the reason I first wrote down.

## 3. A stale inbox refetch could overwrite a live message

`web/js/util.js`, `web/js/main.js`

This one surfaced as a flaky test rather than a probe failure — the new "a message moves its
conversation to the top" test failed about one run in two. The failure was odd in a useful way: the
`waitForFunction` matched, and the assertion right after it did not. So the sidebar reordered correctly
and then flipped *back*.

Two dead ends first, both worth recording because they were plausible and wrong:

- **The `subscribed` ack looked like a lie.** `channels.acquire` fires its Redis `SUBSCRIBE` with `void`
  and the ack goes out immediately after, so the server says "subscribed" while the subscriptions are
  still in flight — and the frontend sets its status to `live` on exactly that ack. A message published
  in that window would be lost. I wrote the test; it passed 3/3, with a subscription to ~900 channels to
  widen the window as far as it goes. The gap is real but too small to lose a message through.
- **A replica whose subscriber had missed its `SUBSCRIBE`.** A browser-driven loop went 8/8 with the
  holding replica showing all 50 channels.

The actual cause: `catchUp()` reloads the inbox on every reconnect and resync, and that request can
already be in flight when a message arrives over the socket. `loadConversations()` then assigned the
response straight over `state.conversations` — throwing away the newer information the broadcast had
just applied. The sidebar jumped back to its previous order, and the preview reverted to the message
before last.

Same shape as finding 6 in `docs/08-review-fixes.md`: a fetch resolving late and clobbering something
newer. The fix is `mergeConversations` — the page decides which conversations exist and in what order,
because that's the server's job and paging depends on it, while per-conversation freshness goes to
whichever side has the newer last message. `unreadCount` is deliberately taken from the page even when
it is lower: reading a conversation lowers it, and that is exactly when the server is right.

Worth noting what the flaky test was worth. It was a nuisance that failed half the time, and it was
reporting a real bug in the code it covered — one that a user would experience as the inbox order
randomly reverting after a reconnect.

## Failover, which behaves

`scripts/probe-failover.mjs` covers both ways a replica leaves, because they want different things:

- **SIGKILL**, no goodbye. The browser must notice, reconnect to a survivor, and recover what it missed
  — realtime is at-most-once, so the recovery is `GET /api/messages?since=`, not the socket. Verified
  by killing whichever replica held a real browser's socket: it reconnected on its own, the message
  published while it was down appeared after reconnect, live updates resumed, and nothing 5xx or
  uncaught reached the page.
- **SIGTERM**, a scale-down. The replica can say goodbye and now does — findings 1 and 2 above.

Killing a replica does *not* bring it back, incidentally: `docker kill` counts as a manual stop, so
`restart: on-failure` doesn't apply. Worth knowing before assuming a crash self-heals.

## What is now checked, and where

| | |
|---|---|
| `tests/scaling.test.mjs` | the properties worth failing a build over: every response attributable, and every replica agreeing about unread counts, committed messages, and send quota |
| `scripts/probe-scaling.mjs` | the readable report — distribution, socket spread, cross-replica fan-out, typing, presence. Read-only and safe to run any time |
| `scripts/probe-failover.mjs` | stops one replica at a time, hard and gracefully, and starts it again afterwards including on failure |

The suite is 139 tests. The rate-limit-across-replicas check went in green, as a characterisation test:
the limiter was already correct, and asserting it stays that way is the point.
