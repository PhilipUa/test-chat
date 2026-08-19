# A new conversation reached nobody

Reported as "when new conversation is created it is not real time".

## What was actually wrong

Two things, and the second is the one that mattered.

**`POST /api/conversations` published nothing.** Every other state change in the app fans out —
`send` publishes a `message`, `read` publishes a `read`, connecting publishes `presence` — but
creating a conversation wrote its rows and returned. There was no `conversation` event in the wire
protocol at all (`ConversationEvent` was `message | typing | read | presence`).

**And there was no route it could have used.** Fan-out is per-conversation: an event goes to the
Redis channel `relay:conv:<id>`, and `deliverLocally` sends it to sockets whose `subs` already
contain that id. A socket's `subs` comes from the ids the browser names in its `subscribe` frame,
which come from the inbox it loaded when it connected. A conversation created *after* that is in
nobody's `subs` and nobody's channel — so publishing it to its own channel would have reached
exactly zero sockets. Announcing membership needs a channel keyed by **user**, not by conversation.

The visible symptom was a sidebar that didn't update. The one underneath was worse: because the
recipient's socket was not subscribed either, **every message sent into a new conversation was
silently missed too**, until the recipient reloaded or their socket reconnected. Reproduced before
the fix — Bob held an open socket, Alice created a conversation with him and sent a message, and
Bob received neither; a refetch showed both had existed the whole time.

## The fix

A second channel namespace, `relay:user:<id>`, alongside `relay:conv:<id>`:

- **`ws/events.ts`** — adds the `conversation` event (carrying a whole inbox row, so the sidebar can
  render it without a refetch) and `targetOfChannel`, which recovers the routing rule from a channel
  name. Two namespaces, one parser.
- **`ws/channels.ts`** — refcounts channel *names* rather than conversation ids. The refcounting was
  already right; it just needed to stop assuming what it was counting.
- **`ws/subscriptions.ts`** (new) — the socket's subscription set and the channels it implies,
  including its own user channel. Split out of `protocol.ts` because fan-out needs it now, and
  `protocol.ts` publishes *through* fan-out.
- **`ws/fanout.ts`** — `publishToUsers`, one event per recipient. And delivering a `conversation`
  event also subscribes that socket to the conversation, which is what closes the second bug: waiting
  for the browser to send a fresh `subscribe` frame leaves a gap, and Redis pub/sub is at-most-once,
  so anything published in that gap is gone.
- **`services/conversations/commands.ts`** — builds one inbox row per participant. A row is a
  per-user view (`participants` is everyone *else*), so it can't be one shared payload. Built from
  what the write already knows rather than by re-reading the inbox, which would be a query per
  recipient.
- **`web/js/socket.js`** — inserts the row and seeds presence from it, so the online dots are right
  on the first render rather than a round trip later.

`createdAt` now comes back from the `create` rather than being generated in the app, because it is
the conversation's `activityAt` until its first message — the key the inbox is ordered by. The schema
comment explains why the app clock is the wrong source for it.

## Trade-off worth knowing about

A socket now accumulates a channel for every conversation it is added to while it stays open. That is
deliberate — it is the only way not to lose the first messages — and it is bounded by conversations
created during one session, which is the same bound the client's own `state.conversations` has. But it
does soften the "subscribe only to what's loaded" property that keeps a socket from holding 878
subscriptions. If that ever bites, the fix is for the client to drop conversations it has scrolled
past out of its subscribe set, not for the server to stop attaching.

## Verified

- Three new tests in `tests/realtime.test.mjs`: the announcement arrives, the first message arrives
  with no re-subscribe, and a non-participant is not told. All three fail on the old code.
- Full suite green (209 tests), across `--scale api=3` as well as one replica.
- `probe:scaling`, `probe:transition`, `probe:failover`, `probe:redis`, `audit:tasks` all pass —
  including the channel-accounting check, which confirms the attached channels are released when the
  socket closes.
- Two browser tabs: Alice creates a conversation and sends into it; Bob's tab, never reloaded, shows
  the row, the online dot, the preview and the unread badge.
