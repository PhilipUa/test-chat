# Investigation notes

Working notes from the first pass: get it running, then find out what "doesn't behave right
once you actually use it" actually means. Everything below was reproduced against the stack
running via `docker compose up`, not read off the page — commands and output included so you
can re-run them.

## Getting it running

`cp .env.example .env && docker compose up --build` worked first time. Seeded demo data showed
up at <http://localhost:3000>. Two papercuts worth fixing (done later, see `03-changes.md`):

- `redis` is declared in compose and `REDIS_URL` is in `.env.example`, but nothing in the code
  ever connects to it. It looked like a leftover — turns out it's exactly what the
  multi-instance and rate-limiting tasks need.
- `api` doesn't wait for `redis`, and `mongo` has no healthcheck (only `service_started`), so a
  slow Mongo start is a race.

## What I found

I'll go in blast-radius order rather than the order I found them.

### A. One bad request kills the whole server

The async route handlers have no error handling, and Express 4 doesn't catch rejected promises
from an `async` handler. An unhandled rejection in Node 22 terminates the process.

Reproduced by sending a duplicate participant id, which trips the composite primary key on
`conversation_participants`:

```
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/conversations \
    -H 'Content-Type: application/json' -d '{"title":"dup participants","participantIds":[1,1]}'
503
$ docker compose logs --tail=5 api
api-1  | Error: Duplicate entry '3-1' for key 'conversation_participants.PRIMARY'
api-1  |     at file:///app/src/routes/conversations.js:45:16
api-1  | Node.js v22.23.2          <-- process exited
$ docker inspect c1-take-home-api-1 --format '{{.RestartCount}}'
1
```

So an unprivileged caller can restart the API at will. `restart: on-failure` brings it back in a
second or two, but every in-flight request and **every WebSocket connection** on that instance
dies with it. The 503 came from Envoy, not the app.

The same request also leaks a half-created conversation — the `conversations` row is committed
and then the participant inserts fail, with no transaction around them:

```
id  title              participants
3   dup participants   1        <-- title exists, participants incomplete
```

### B. Every message send blocks the event loop for ~20ms

`createMessage` computes a "signature" with `crypto.pbkdf2Sync(body, 'relay-signing', 200000, ...)`.
`pbkdf2` is a deliberately slow password-stretching KDF, and the `Sync` variant runs on the main
thread, so the entire process stalls for the duration on every single send:

```
$ docker compose exec api node -e "...pbkdf2Sync('hello','relay-signing',200000,32,'sha256')..."
pbkdf2Sync(200k) avg: 20.5 ms of BLOCKED event loop per message
```

Which is exactly the "doesn't behave right once there's real traffic" symptom — the cost lands on
everyone, not just the sender:

```
idle GET /api/conversations:            4 ms
same GET during a 50-message burst:   790 ms     <-- ~200x
```

Two separate problems in one line, worth separating:

1. It's synchronous, so it serialises the whole instance.
2. It's the wrong primitive anyway. The "salt" is the hard-coded constant `'relay-signing'` and
   there's no secret key, so anyone can recompute the signature for a body they've tampered
   with. It costs 20ms and buys no authenticity at all.

### C. Realtime silently breaks with more than one instance

`src/ws/hub.ts` keeps `clients` in a module-level `Set`, so `broadcast()` only ever reaches
sockets attached to *the process that handled the POST*. With one instance that's every client,
which is why it looks fine locally. Envoy round-robins, so with three instances a client has a
1-in-3 chance of being on the same process as any given sender.

`scripts/probe-realtime.mjs` opens 6 WS clients, subscribes them, POSTs one message and checks
who received it:

```
$ docker compose up -d --scale api=1 && node scripts/probe-realtime.mjs
fan-out: 6/6 connected clients received the new message

$ docker compose up -d --scale api=3 && node scripts/probe-realtime.mjs
fan-out: 2/6 connected clients received the new message
```

Note the failure mode: no error anywhere, the sender's own client usually works, messages just
quietly don't arrive for other people. This is `tasks/multi-instance.md`, but I'm listing it as a
bug too because nothing surfaces it.

### D. Sends aren't idempotent, so retries duplicate messages

The `messages` table has a `client_id` column and the frontend dutifully sends a fresh
`crypto.randomUUID()` with every send — but nothing ever reads it back. There's no unique
constraint and no lookup, so the column is decoration. Any retry (double-click, flaky network,
a proxy replay) posts the message twice:

```
$ curl ... -d '{"conversationId":2,...,"clientId":"dup-test-1"}'   # -> id 67
$ curl ... -d '{"conversationId":2,...,"clientId":"dup-test-1"}'   # -> id 68, same clientId
$ SELECT COUNT(*) FROM messages WHERE client_id='dup-test-1';
2
```

This gets worse once rate limiting exists: a client that retries on a network timeout needs the
retry to be free, or it burns quota re-sending something already stored.

### E. Nobody checks who's allowed to do anything

There's no auth in this app, which is fine for a demo — but there's no *authorization* either,
and the two aren't the same thing. `senderId` and `conversationId` are taken from the request
body and trusted:

```
POST {"conversationId":999999,"senderId":42424,"body":"orphan"}          -> 201 Created
POST {"conversationId":1,"senderId":3,"body":"not in this conversation"} -> 201 Created
```

Carol (user 3) is not a participant in conversation 1, and user 42424 doesn't exist. Both writes
succeed and create rows referencing nothing. Same on the WS side: `subscribe` accepts any
`conversationIds` you name, so anyone can tail any conversation in the system.

### F. `messages` has no index on `conversation_id`

Every query in the app filters or groups by `conversation_id`, and the only index on the table is
the primary key on `id`:

```
$ SHOW INDEX FROM messages;
Key_name: PRIMARY   Column_name: id
```

So `WHERE conversation_id = ?` and `SELECT MAX(id) ... WHERE conversation_id = ?` are full table
scans. It's invisible with 70 rows and quadratic-ish with real volume. `conversation_participants`
has the same shape of problem: the composite PK is `(conversation_id, user_id)`, and the
conversation list looks up by `user_id`, which isn't a usable prefix of that key.

### G. The conversation list is an N+1 (2N+1, really)

`GET /api/conversations` fetches the conversation rows, then runs *two* more queries per
conversation inside a `for` loop — last message, then count. 50 conversations is 101 round trips,
each of them a full scan of `messages` per (F).

### H. Re-running the seed blanks every message body

`docker/db/seed.ts` starts with `bodies.deleteMany({})` and then inserts the three demo bodies
with fixed `_id`s. But `seed` is a compose dependency of `api`, so it runs on *every*
`docker compose up` — while MySQL keeps its `messages` rows. The bodies for everything you've
sent are deleted, the MySQL rows survive, and `GET /api/messages` renders
`bodyById.get(r.id) ?? ''`:

```
$ docker compose run --rm seed
seeded message bodies
$ curl -s 'localhost:3000/api/messages?conversationId=1' | ...
of 66 messages, 64 have an empty body
```

Silent data loss on restart. It reads as "my history is gone" rather than as an error.

### I. Writes span two stores with nothing holding them together

`createMessage` inserts a row into MySQL and then the body into Mongo, with no compensation. If
the Mongo write fails, the MySQL row is already committed, and the message exists forever with an
empty body — the same corrupt state as (H), reached a different way. There's no transaction
available across two databases, so this needs handling in the write path.

### J. `GET /api/messages` returns the entire conversation

No `LIMIT`, no cursor. Every conversation open fetches every message ever sent in it from both
stores. Fine for 3 messages; not fine for the "conversation with a lot of messages" that
`tasks/search.md` is premised on.

### K. WebSocket lifecycle is unmanaged

- No `'error'` listener on the sockets. `ws` emits `'error'` on an abrupt disconnect (a laptop
  sleeping, a proxy timing out), and an unhandled `'error'` on an `EventEmitter` is thrown —
  another route to killing the process, per (A).
- No ping/pong. A socket that dies without a close frame is never cleaned up, so `clients` grows
  and `broadcast` writes to sockets nobody is listening to.
- No reconnect on the client either (`web/app.js` sets `ws.onmessage` and nothing else), so one
  blip and the tab stops updating until a manual refresh — with no indication anything is wrong.

### L. Conversation titles are injected as HTML

`renderSidebar` does `li.innerHTML = '<span>' + c.title + '</span>'` with a title that came from
`POST /api/conversations`. `appendMessage` gets this right with `textContent`, so it's an
inconsistency as much as a bug. Stored XSS via the "+ New" dialog.

### M. Smaller things

- The `createdAt` a POST returns is `new Date()` from the app, but the one a subsequent GET
  returns is MySQL's `created_at`. Two clocks, two values for one message, and the column is
  second-precision so they don't even round the same way.
- The unread dot lives only in browser memory. Reload and it's gone; it can't be right across
  two tabs, let alone two instances.
- `GET /api/conversations` orders by `c.id ASC`, so an inbox is sorted by creation order and the
  conversation that just got a message can be at the bottom.
- `ws.subs` is set from `m.conversationIds.map(Number)` with no validation, so `NaN` is a
  perfectly acceptable subscription.
- Route files are `.js` inside a `strict` TypeScript project with `checkJs: false` — the request
  and row shapes that matter most are the ones nothing checks.

## Where that leaves the plan

Fix A, B, K first — those three are how the process dies or stalls for everyone. Then the data
integrity set (D, H, I, and the transaction in A). C is shared with the multi-instance task and
wants Redis, which rate limiting needs too, so those land together. F, G, J are the "real traffic"
performance set. E, L are the correctness/safety pass. M gets swept up along the way.

Plan in `spec/`, what I actually did in `docs/03-changes.md`.
