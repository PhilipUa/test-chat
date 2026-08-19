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

That scale-up was originally done by hand, and this document presented it as though it were covered.
It is now `scripts/probe-scale-transition.mjs` — see "Testing the transition" below.

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
| `postman/relay-scaling.postman_collection.json` | the same load-balancing questions as a Postman collection, for anyone who would rather click Run than read a script — see `postman/README.md` |

The suite is 139 tests. The rate-limit-across-replicas check went in green, as a characterisation test:
the limiter was already correct, and asserting it stays that way is the point.

## The same checks in Postman

`postman/relay-scaling.postman_collection.json`, runnable with `npm run test:postman`.

Worth recording two things about it, because both are the sort of thing that makes a green run
worthless:

**The distribution assertion is load-bearing.** A collection that quietly ran against a single replica
would pass every agreement check while proving nothing — there is nothing to disagree with. So it asserts
it saw `expectedReplicas` distinct instances.

I first checked that guard by scaling to one replica and passing `--env-var expectedReplicas=3`. It
failed, and I recorded it as proof. It was not proof: 3 is also the collection's default, so that run
never demonstrated the override worked at all. It didn't — see below. Re-checked against a 3-replica
stack told to expect 5, which is a value the collection does not default to:

```
1. traffic reached all 5 expected replicas (saw 3: …)
2. and the read was actually spread, not served by one replica
```

**A variable-scope bug that made every phase run lie.** Configuration was read with
`pm.collectionVariables.get`, which reads *only* the collection scope. `newman --env-var` sets
environment variables, so nothing the driver passed in was ever visible: all three phases reported
themselves as `"baseline"` with `expectedReplicas=3`. `pm.variables.get` resolves across scopes and is
what configuration has to use; the accumulators stay on `pm.collectionVariables` because they are written
back mid-run. Two of my own checks were weaker than I claimed because of it.

**It needs the Runner or Newman.** Several requests loop themselves with `pm.execution.setNextRequest`,
which a single Send ignores — the loop never completes, the end-of-loop assertions never fire, and you
get a green run that checked nothing.

And the boundary: Postman's WebSocket requests can't run inside a collection or carry test scripts, so
the collection covers the HTTP half only. The realtime fan-out — the actual substance of
`tasks/multi-instance.md` — stays with `scripts/probe-scaling.mjs` and `tests/realtime.test.mjs`. A green
Postman run is not "multi-instance works", and `postman/README.md` says so where someone will read it.

---

## Testing the transition (and why "autoscaling" was never in scope)

Worth separating two things that get conflated, because the answer to "why doesn't the autoscaling test
pass?" was: there wasn't any autoscaling.

- **Discovery** was already automatic. Envoy's `STRICT_DNS` with `dns_refresh_rate: 5s` picks up a new
  replica in about 6s with no restart. Measured: `envoy saw 4 endpoints after 6s`.
- **Scaling** was manual. `--scale N` is a number a human types; nothing measured load and changed it.
  Compose has no autoscaler, and `deploy.replicas` is Swarm-only and still fixed.

So there were two gaps, and both are now closed.

### The transition itself: `scripts/probe-scale-transition.mjs`

`probe-scaling.mjs` checks that N replicas behave like one system. This checks the *change* — scaling up
and back down with traffic and WebSockets live:

```
═══ scaling up: 3 → 5 ═══
  PASS  the proxy converges on the new replica count          5 endpoints after 1.5s
  PASS  no request failed while the replica count changed     47 GETs + 47 POSTs, all served
  PASS  a newly started replica actually takes traffic        2 replicas served that were not before
  PASS  and receives a message published afterwards, exactly once   copies: [1,1,1,1,1,1]

═══ scaling down: 5 → 3 ═══
  PASS  the proxy converges on the new replica count          3 endpoints after 2.0s
  PASS  no request failed while the replica count changed     12 GETs + 12 POSTs, all served
  socket churn: 14 connects, closes=[1001,1001]
  PASS  departing replicas closed their sockets gracefully (1001), not abruptly
```

Its clients reconnect, like the browser does — a scale-down *will* close the sockets on a departing
replica, and the question is whether a user keeps receiving, not whether their first socket survived.

Two mistakes of mine are worth recording, because both would have produced a green run that proved
nothing:

- **The first version's eviction check passed vacuously.** Existing sockets don't migrate, so every
  client was on a replica that predated the scale-up, and the scale-down removed the *newest* replicas —
  `closes=[]`, nothing evicted, assertion satisfied. It now opens a second batch of clients while the
  stack is wide, and if nothing gets evicted it **fails** rather than passing, because there was nothing
  to judge.
- **`compose up --scale` re-ran the seed job** and waited on every database on each transition. Fixed
  with `--no-deps` and an explicit service.

### The missing control loop: `scripts/autoscale.mjs`

The decision is a pure function in `autoscale-policy.mjs`, unit tested in `tests/autoscale.test.mjs`;
the script around it samples, decides, and runs `compose up --scale`.

What to scale on is **configuration**, not a decision baked into the code — `autoscale.config.json`, with
CLI overrides. Three signals:

| signal | units | why |
|---|---|---|
| `connections` | count | For a chat app this is usually what runs out first: each connection is a live socket, a place in the heartbeat sweep, and a share of the fan-out. The default. |
| `cpu` | percent of **one** core | A Node process is effectively single-threaded, so 100% means the event loop is saturated. Against all 15 cores a pinned process reads ~7% and no sane watermark ever fires. |
| `memory` | MB resident | Absolute, not a percentage. A percentage needs a limit, and no container memory limit is set here (`/sys/fs/cgroup/memory.max` is `max`), so the only available "limit" is the host's 8.3 GB — which would describe the host, not the process. |
| `rpm` | requests/min | HTTP requests served, over a short sliding window. Excludes `/api/health` — the autoscaler polls it to find replicas, so counting it would make the scaler's own measuring look like load, and it would climb to `max` on its own. |

```json
{ "min": 2, "max": 6, "cooldownSeconds": 30,
  "rules": [
    { "signal": "connections", "up": 500, "down": 150 },
    { "signal": "cpu",         "up": 70,  "down": 20, "aggregate": "max" },
    { "signal": "memory",      "up": 400, "down": 150, "proportional": false }
  ] }
```

```
node scripts/autoscale.mjs --signal cpu --up 70 --down 20 --aggregate max
node scripts/autoscale.mjs --config my-rules.json
```

CPU is the conventional default and would be the wrong one here — an instance holding 10,000 idle sockets
is near its limit and looks unloaded, which misleads a CPU-based HPA exactly as much as it would mislead
this. Verified against real load: idle 2.6%, under a burst of expensive reads 24–37%, and
`--signal cpu --up 25` decided `scale up: 3 → 4 — above the watermark on max cpu 36.9%`.

Two config options exist because of specific mistakes they prevent:

- **`aggregate: "max"`** — the mean hides a single saturated replica. Right for CPU, usually wrong for
  connections.
- **`proportional`** — used only by the anti-flap projection. Connections and CPU redistribute when a
  replica leaves; memory does not, because a departing replica's baseline heap goes away with it. Projecting
  memory would block scale-downs that are perfectly safe.

Rules combine the way a Kubernetes HPA combines metrics: **up if any rule wants up, down only if every rule
agrees.** Being over on one resource is enough to hurt; being under on one is not enough to be safe.

Bad config fails at startup rather than on the first tick, because a scaler that exits immediately looks
a lot like one that is running and deciding nothing:

```
autoscaling config is not usable (autoscale.config.json):
  - unknown signal "diskio" — expected one of connections, cpu, memory
  - cpu has down (50) at or above up (50) — leave a gap, or it will flap
```

The part worth testing is the anti-flap rule, which two watermarks don't give you on their own. Shedding
a replica raises the load on the ones that remain; if that would push them over the *up* watermark, the
next tick adds it straight back. So a scale-down that would trip the up watermark is refused.

Driven with 12 real sockets against a 3-replica stack:

```
scale up: 3 → 4 — above 2 per replica (14 connection(s) over 3 replica(s) = 4.7 each)
hold at 4 — cooling down for another 12s
scale up: 4 → 5 — above 2 per replica (14 over 4 = 3.5 each)
scale up: 5 → 6 — above 2 per replica (14 over 5 = 2.8 each)
   ... sockets dropped ...
scale down: 6 → 5 — below 1 per replica (2 over 6 = 0.3 each)
scale down: 5 → 4 — below 1 per replica
scale down: 4 → 3 — below 1 per replica
```

One step per cooldown in both directions, stopping at the bounds, no oscillation.

**What it is not.** It runs on the host, because scaling Compose needs the docker CLI and the alternative
— a container with `/var/run/docker.sock` mounted — hands root-equivalent access to anything that can
reach that container. Not a trade worth making for a demo stack. In production the answer isn't this
script: it's a Kubernetes HPA scaling a Deployment, where the scaling authority already exists and is
scoped to it. What transfers is the signal and the anti-flap rule, not the plumbing.

### `npm run test:postman` shows the autoscaling

Postman cannot scale anything, so the collection is the verifier and `scripts/test-postman-scaling.mjs`
is the driver: it opens sockets, runs `scripts/autoscale.mjs` a tick at a time until the count moves, and
re-runs the collection per phase with the before/after counts injected.

```
PHASE 1 — baseline: 3 replica(s), as found
  ✓  phase "baseline": 3 replica(s) serving, autoscaler reported 3

PHASE 2 — scaled up by the autoscaler
    scale up: 3 → 4 — above 2 per replica (18 connection(s) over 3 replica(s) = 6.0 each)
  ✓  traffic reached all 4 expected replicas (saw 4: 7611…=15 ca86…=15 2c94…=15 2d72…=15)
  ✓  every replica now serving is fully wired, not just answering HTTP
  ✓  the autoscaler actually added a replica (3 -> 4)

PHASE 3 — scaled down by the autoscaler
    scale down: 4 → 3 — below 1 per replica (2 connection(s) over 4 replica(s) = 0.5 each)
  ✓  the autoscaler actually removed a replica (4 -> 3)

  3/3 phases passed — autoscaling verified end to end
```

The scaled-up phase asserts the count went *up*, not merely that the stack is consistent — so a run where
autoscaling silently did nothing fails. `every replica now serving is fully wired` earns its place
separately: a replica an autoscaler just started could answer `/api/health` while its Redis subscriber
never came up, passing every distribution check and delivering no realtime at all.

### Seeing each signal actually move

A fair complaint about the first version: a connections-driven run shows the socket count climbing and CPU
sitting flat, so it never demonstrates the CPU rule at all. Each signal needs its own kind of load, so the
driver now generates the load that matches the rule it is testing:

```
npm run test:postman                    # hold sockets open        → connections
npm run test:postman -- --signal cpu    # hammer the dearest read  → cpu
npm run test:postman -- --signal rpm    # hammer the cheapest read → rpm
```

```
PHASE 2 — scaled up by the autoscaler, on the "cpu" signal
  before load: ddf9af451d8d=0.8% cpu  ceb097695bb9=0.7% cpu  020edeff43e2=0.7% cpu
  driving HTTP load to push cpu over its up watermark of 15…
  under load : ceb097695bb9=26% cpu  020edeff43e2=22% cpu  ddf9af451d8d=24% cpu
    scale up: 3 → 4 — above the watermark on max cpu 26.0% per replica (up>15% down<5%)
PHASE 3 — scaled down by the autoscaler
  after load : ceb097695bb9=0.5% cpu  020edeff43e2=2.3% cpu  5a4201676824=1.8% cpu  ddf9af451d8d=0.4% cpu
    scale down: 4 → 3 — below the watermark on max cpu 2.3% per replica
```

`memory` is deliberately not offered as a driver option. RSS here is dominated by baseline heap and barely
moves under synthetic load, so a demo of it would be theatre — a memory rule is for leak and pressure
protection, not load tracking, and pretending otherwise would be the same kind of vacuous check as the
eviction test above.

**Building the rpm signal exposed a real problem with a full-minute window.** The first version read *higher*
after the load was dropped than during it, and phase 3 kept scaling up:

```
under load : 4684 rpm
after load : 11983 rpm      ← the 60s window still held the whole burst
scale up: 4 → 5 — above the watermark on mean rpm 11943.9/min
```

Two things were wrong: a 60s window makes every rate-driven scale-down lag a full minute, and "idle" read
966 rpm because the *previous* test's traffic was still inside the window. The window is now 15s
(`REQUEST_RATE_WINDOW_SECONDS`), still expressed per minute — short enough to decay quickly, long enough to
smooth a single spike. Idle now reads 0, and the same run reads 45 → 15,200 → 0.

### Is a newly started replica automatically in the pub/sub?

Two-part answer, and the driver now asserts both rather than leaving it to be assumed.

A new replica boots with its Redis **subscriber connected** (`realtimeConnected: true`) but **no channel
subscriptions** — `channels.acquire` subscribes to a conversation only when one of that replica's own sockets
asks for it. That is the refcounting working as designed: subscribing every replica to every conversation is
the design `ws/channels.ts` exists to avoid.

```
after scaling to 4:
  ca6713834b70 channels=0 realtimeConnected=true      ← the new one, nothing wants a channel yet
after 8 sockets connect:
  ca6713834b70 conn=4 channels=1                       ← subscribed on demand
published via ba2e45aa32f5 (a DIFFERENT replica)
per-socket copies: [1,1,1,1,1,1,1,1]                   ← every socket got it exactly once
```

So: automatic, but on demand rather than eagerly. `npm run test:postman` now fails the scaled-up phase if the
replica the autoscaler started does not take a channel and receive a message published through another
replica.

---

## Closing the gaps the verification pass listed

Writing up what had been checked made the holes obvious. Four of the eight were real and are now closed;
the rest are limits of the environment or the tool, and are recorded as such rather than quietly dropped.

### Closed: nothing stopped Redis — `scripts/probe-redis-outage.mjs`

Redis holds pub/sub, presence and the rate-limit counters, and the code has a considered answer for each
when it goes away. One of those answers had been a *bug* until this session (finding 3: a `SUBSCRIBE` issued
during an outage was never retried, so a conversation went silently dead for the life of the process) — and
none of it had ever been tested against a real outage. 15/15 now:

```
with redis stopped
  PASS  reports redis as down rather than claiming to be fine
  PASS  a send still succeeds — the rate limiter fails open
  PASS  reads still work, so nothing written during the outage is lost
  PASS  reports nobody online rather than guessing
  fan-out during the outage: 2/4 clients received it (local-only fallback, as designed)
after redis comes back
  PASS  clients are told to resync, since their sockets never closed   7/7
  PASS  clients that were connected before the outage receive messages again
  PASS  clients that subscribed DURING the outage receive messages again   ← finding 3, for real
  PASS  the rate limiter is enforcing again, not stuck failing open   201×5, 429×3
```

The last two are the point. Anyone can check a send returns 201 with Redis down; the question that matters is
whether a client that subscribed *during* the outage is still receiving ten seconds after recovery.

### Closed: no soak or leak test — `scripts/probe-soak.mjs`

This session found two leaks, both invisible to a green suite, because a test asserts behaviour and exits —
it never asks what the process is still *holding*. So: churn for a few minutes and check everything returns
to baseline. One in four cycles is deliberately the close-during-subscribe race that caused the permanent
channel leak.

```
baseline: 026a21f9cbb4=3c/50ch/125MB  3012c22e3085=0c/0ch/112MB  60e1773f7ddd=0c/0ch/107MB
t+ 60s  held=9c/56ch  rss=[135, 144, 134]MB  cycles=526 races=40
t+180s  held=7c/53ch  rss=[139, 150, 140]MB  cycles=1652 races=180
did 1656 connect/close cycles (180 of them the subscribe race), 495 sends, 1161 throttled
  PASS  no Redis channel subscription was left behind    baseline 50 → 50
  PASS  no replica grew resident memory by more than 60MB   +25MB  +32MB  +28MB
  memory over the last two samples: 430MB → 429MB (settled)
```

### Closed: the memory signal was never exercised

It is now, in the way memory actually behaves. RSS here grows +25–32MB under sustained churn and then
*settles* — it does not track load, so a memory watermark is a leak and pressure guard, not a load signal.
The soak probe asserts the growth budget, that the trend settles, and that the number is live at all (a
metric frozen at a constant would satisfy every unit test and tell an autoscaler nothing). There is still
deliberately no "memory drove a scale-up" demo, because tuning a watermark to a one-off heap rise would scale
up once and never come back down — teaching exactly the wrong lesson.

### Closed: the signal runs were not a named command

`npm run probe:signals` runs the driver on all three drivable signals in sequence, and `npm run verify` runs
the whole set — typecheck, suite, task audit, and the scaling, transition, failover, redis-outage and soak
probes.

### Still open, and why

- **Postman cannot test the realtime fan-out.** Its WebSocket requests do not run inside a collection. The
  driver asserts fan-out around it (a new replica taking a channel and receiving a message published
  elsewhere), so the property is covered — just not by Postman.
- **Single machine, Docker Desktop.** No real multi-host networking or partition testing. Not fixable here.
- **No Kubernetes HPA.** Writing manifests I cannot run against a cluster would add config that *looks*
  verified and is not, which is worse than the honest gap.
- **Demo-scale load.** Raised as far as this setup usefully goes: 1,656 connect/close cycles in the soak,
  16 sockets plus 40 HTTP workers through transitions. Not 10,000 connections, and the shipped watermarks are
  deliberately low so the loop is observable rather than production-tuned.

### One more measurement, while chasing a flaky assertion

The transition probe's close-code check failed intermittently on wide drains — `[1001]`, then `[1001 ×5]`,
then `[1001,1001,1006,1001,1001,1001]`. A 1006 means the peer never completed the close handshake, so the
draining replica terminated it after the grace window.

Two things came out of chasing it. First, the grace window was genuinely too short (1s) and is now 3s — that
part was a real fix. Second, the residual 1006s are *peer* timing, not server behaviour: with three replicas
draining at once the probe juggles sixteen sockets, reconnect timers and an HTTP load loop in one process and
occasionally answers late. Checked from the other side, a pure scale-up with sockets open closes nothing at
all, so adding replicas costs a connected user nothing and the churn only ever comes from the drain.

So the assertion was rewritten to catch the regression that matters — the polite close being dropped
altogether, which would make *every* eviction abrupt — rather than failing on a slow peer. What a user would
notice is asserted separately and held in every run, including the ones with a 1006: everyone resubscribes
and receives the next message exactly once.
