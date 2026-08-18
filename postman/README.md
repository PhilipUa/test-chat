# Postman: scaling and load balancing

`relay-scaling.postman_collection.json` — load-balancing checks for Relay, over HTTP.

```
docker compose up -d --scale api=3
npm run test:postman
```

Import the collection and `relay-local.postman_environment.json` into the Postman app, or run it with
Newman as above (that npm script is just `npx newman run …`, so there is nothing to install).

## What it asks

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
hypothetical; it is the shape of the mistake, so it is worth checking the guard still bites:

```
$ docker compose up -d --scale api=1
$ npx newman run postman/relay-scaling.postman_collection.json --env-var expectedReplicas=3

  1. traffic reached all 3 expected replicas (saw 1: 2c94003120c8=60)
  2. and the read was actually spread, not served by one replica
```

Set `expectedReplicas` to match your actual scale when you mean to run at a different one.

**It needs the Collection Runner or Newman, not a single Send.** Several requests loop themselves with
`pm.execution.setNextRequest`, which a single Send ignores — the loop never completes, so the
end-of-loop assertions never fire and you get a green run that checked nothing. `npm run test:postman`
is the safe path.

## Side effects

It creates one conversation per run and deliberately exhausts that conversation's send quota (the point
of the shared-quota check). It touches nothing else, and never deletes anything.
