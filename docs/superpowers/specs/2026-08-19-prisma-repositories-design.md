# Prisma + repository layer — design

Date: 2026-08-19. Approved direction: Prisma for **both** MySQL and MongoDB (user choice),
migrations applied **at boot** like today (user choice), and a **repository layer** so no service
talks to a database client directly (user request). Repositories hold no business logic.

## Goals

- Replace raw `mysql2` queries and the hand-rolled migration runner with Prisma Client + Prisma
  Migrate.
- Replace the `mongodb` driver with the Prisma Mongo client; raw escape hatches only where
  Prisma's API cannot express the query.
- Introduce `src/repositories/` — all DB access behind repositories that return plain domain
  shapes (`number`, not `BigInt`; `Date` handed out as-is). Services keep the policy: authorization
  decisions (403 vs 404), idempotency, the two-store write compensation, pagination shaping,
  search strategy order. Repositories never throw `HttpError` and never decide policy.

## Layout

```
prisma/
  mysql/schema.prisma          datasource MYSQL_URL, output src/generated/prisma-mysql
  mysql/migrations/0_init/     baseline DDL = the schema the old runner converged on
  mongo/schema.prisma          datasource MONGO_URL, output src/generated/prisma-mongo
src/db/
  mysql.ts                     Prisma MySQL client + waitForMysql/close + isDuplicateKeyError (P2002)
  mongo.ts                     Prisma Mongo client + waitFor/close + index creation + tokenizeBody
  migrate.ts                   boot runner: baseline-resolve if needed, then `prisma migrate deploy`
src/repositories/
  users.repository.ts          listUsers, findName, exists
  conversations.repository.ts  createWithParticipants (one atomic write), titlesByIds,
                               summaryRows (the inbox $queryRaw), participantRows,
                               advanceReadWatermark (monotonic updateMany), membership reads
  messages.repository.ts       insertRow, deleteRow, findRowByClientId, pageRows
  message-bodies.repository.ts insertBody, findBody, bodiesByIds, searchText, searchPrefix
                               (findRaw + EJSON decode), backfillBodyTokens
```

## Decisions and their reasons

- **Two schemas, two generated clients.** Prisma supports one datasource per schema. Outputs go
  under `src/generated/` (gitignored) because compose bind-mounts `./src`, so clients generated on
  the host are the ones the container runs; `binaryTargets` includes the container's Linux engines.
- **MySQL migrations**: baseline `0_init` equals the schema the old idempotent runner produced.
  At boot: if the tables exist but `_prisma_migrations` doesn't, run
  `prisma migrate resolve --applied 0_init`, then `prisma migrate deploy` (advisory-locked by
  Prisma, so `--scale api=3` stays safe). The resolve step runs under a MySQL named lock held on
  one connection via an interactive transaction.
- **Mongo has no Prisma Migrate.** Indexes (text index included, which the schema DSL cannot
  declare) stay as an idempotent `createIndexes` via `$runCommandRaw` at boot — same behavior as
  today. Prisma's Mongo connector requires a replica set, so the compose `mongo` service becomes a
  single-node replica set (`--replSet rs0`, healthcheck initiates it); `MONGO_URL` gains
  `?replicaSet=rs0`. Existing volumes upgrade in place.
- **Raw escape hatches** (documented at each site): the inbox summary query (correlated
  subqueries + keyset over `COALESCE`) via `$queryRaw`; `$text` and anchored-prefix search plus the
  `bodyTokens` backfill via `findRaw`/`$runCommandRaw`, because Prisma's Mongo filters are
  equality-only over scalar lists and cannot rank by text score.
- **Duplicate-key handling** moves from `ER_DUP_ENTRY` to Prisma error `P2002` inside
  `src/db/mysql.ts`; the send idempotency race in `services/messages.ts` is unchanged.
- **Seeding**: `docker/db/mysql.sql` (initdb, fresh volumes only) is deleted; `docker/db/seed.ts`
  becomes the one idempotent seed for both stores (demo users 1-5, conversations, participants,
  messages + bodies), running migrations first — same compose `seed` service.
- **Deleted**: `mysql2` and `mongodb` dependencies, the old `src/db/migrate.ts` migration list,
  `docker/db/mysql.sql`.

## Testing

`npm run typecheck`, `npm run lint`, unit tests, then the full integration suite (192 tests over
HTTP/WS) against the rebuilt stack — the API surface is unchanged, so the existing suite is the
regression net. `npm run verify` remains the full gate.
