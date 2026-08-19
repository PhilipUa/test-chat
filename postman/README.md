# Postman: scaling and load balancing

`relay-scaling.postman_collection.json` — load-balancing checks for Relay, over HTTP.

```
docker compose up -d --scale api=3
npm run test:postman              # drives the autoscaler, runs the collection once per phase
npm run test:postman:collection   # just the collection, against the stack as it is
```

Import the collection and `relay-local.postman_environment.json` into the Postman app, or run it with
Newman as above (nothing to install — the scripts use `npx`).

## Autoscaling: what Postman can and cannot do

Postman has no shell, so a collection can never *cause* scaling. `npm run test:postman` therefore runs
`scripts/test-postman-scaling.mjs`, which supplies the half Postman cannot: it drives load, runs the real
autoscaler (`scripts/autoscale.mjs` a tick at a time — not a reimplementation of its decision), and
re-runs the collection once per phase with the before/after counts injected. Postman does the
verification.

```
PHASE 1 — baseline: 3 replica(s), as found
  ✓  traffic reached all 3 expected replicas (saw 3: 2c94…=20 7611…=20 ca86…=20)
  ✓  phase "baseline": 3 replica(s) serving, autoscaler reported 3

PHASE 2 — scaled up by the autoscaler
  opening 16 sockets to push connections per replica over the up watermark…
    scale up: 3 → 4 — above 2 per replica (18 connection(s) over 3 replica(s) = 6.0 each)
  ✓  traffic reached all 4 expected replicas (saw 4: 7611…=15 ca86…=15 2c94…=15 2d72…=15)
  ✓  phase "scaled-up": 4 replica(s) serving, autoscaler reported 4
  ✓  every replica now serving is fully wired, not just answering HTTP
  ✓  the autoscaler actually added a replica (3 -> 4)

PHASE 3 — scaled down by the autoscaler
  dropping the load…
    scale down: 4 → 3 — below 1 per replica (2 connection(s) over 4 replica(s) = 0.5 each)
  ✓  phase "scaled-down": 3 replica(s) serving, autoscaler reported 3
  ✓  the autoscaler actually removed a replica (4 -> 3)

  3/3 phases passed — autoscaling verified end to end
```

If autoscaling does not happen, the scaled-up phase fails: it asserts the count went *up*, not merely
that the stack is consistent. And "every replica now serving is fully wired" is there because a replica
an autoscaler just started could answer `/api/health` while its Redis subscriber never came up — it
would pass every distribution check and silently deliver no realtime.

The replica count found at the start is restored at the end, including on failure.

## What it asks about the stack itself

Two questions, in that order, because the second is meaningless without the first:

1. **Is the proxy actually spreading traffic?** 60 samples of `/api/health`, accumulating which replica
   answered. Asserts it saw `expectedReplicas` distinct instances and that none was starved.
2. **Does every replica give the same answer about shared state?** Read-your-writes from every replica,
   unread counts agreeing everywhere, and one send quota shared rather than one per replica.

Attribution comes from the `X-Relay-Instance` response header, which every response carries.

The assertion names carry their own evidence, so a passing run is still readable:

```
✓  traffic reached all 3 expected replicas (saw 3: cbfc8b26ba2f=20 2c94003120c8=20 0c85e6af97fa=20)
✓  the committed message is visible from every replica that answered (3)
✓  every replica reports the same unread count (0c85e6af97fa=1 cbfc8b26ba2f=1 2c94003120c8=1)
✓  one quota was shared, not one per replica (5 accepted, limit 5, 3 replicas)
```

## What it does **not** cover

**The realtime side.** The core of `tasks/multi-instance.md` is that a message published on one replica
reaches WebSocket clients on the others, and Postman's WebSocket requests cannot run inside a collection
or carry test scripts. So a green run here is *not* "multi-instance works".

That half is covered by `scripts/probe-scaling.mjs` (fan-out exactly-once, typing and presence across
replicas) and `tests/realtime.test.mjs`. Failover is `scripts/probe-failover.mjs`.

## Two things worth knowing before you trust a green run

**Point 1 above is the load-bearing assertion.** A collection that quietly ran against a single replica
would pass every agreement check while proving nothing — there is nothing to disagree with. That is not
hypothetical; it is the shape of the mistake, so it is worth checking the guard still bites. Against a
3-replica stack, told to expect 5:

```
$ npx newman run postman/relay-scaling.postman_collection.json \
    -e postman/relay-local.postman_environment.json \
    --env-var expectedReplicas=5 --env-var previousReplicas=3 --env-var phase=scaled-up

  1. traffic reached all 5 expected replicas (saw 3: …)
  2. and the read was actually spread, not served by one replica
  3. phase "scaled-up": 3 replica(s) serving, autoscaler reported 5
  4. the autoscaler actually added a replica (3 -> 3)
```

**Configuration is read with `pm.variables.get`, not `pm.collectionVariables.get`.** Only the former
resolves across scopes, so an environment file or `--env-var` can override it; reading configuration from
the collection scope silently ignores every override. That was a real bug here — the three phase runs all
reported themselves as `"baseline"` with `expectedReplicas=3`, because each script was reading the
collection default and never saw what the driver passed in. Worth knowing that the first version of the
guard check above used `expectedReplicas=3`, which is *also* the collection default: it failed for the
right reason but proved nothing about the override. Hence the 5 above.

**It needs the Collection Runner or Newman, not a single Send.** Several requests loop themselves with
`pm.execution.setNextRequest`, which a single Send ignores — the loop never completes, so the
end-of-loop assertions never fire and you get a green run that checked nothing. `npm run test:postman`
is the safe path.

## Side effects

It creates one conversation per run and deliberately exhausts that conversation's send quota (the point
of the shared-quota check). It touches nothing else, and never deletes anything.
