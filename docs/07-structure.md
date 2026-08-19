# Structure: controllers, middleware, and where things live

Reorganised into the conventional Express layering. This **reverses a call I made** in
[`../spec/refactoring-plan.md`](../spec/refactoring-plan.md), which said "no controller classes for
routes" — worth being explicit about what changed and what didn't.

## What changed my mind

The plan was right that **classes** would be ceremony. It was wrong to bundle that conclusion with
"leave the routes alone", because it caused me to miss that **rate limiting and authorization are
textbook middleware** and I had them as inline calls in every handler. That's the part I got wrong:

```ts
// before — every handler repeated the sequence, and nothing enforced the order
messagesRouter.post('/', asyncHandler(async (req, res) => {
  const conversationId = int(payload.conversationId, 'conversationId');
  const senderId = int(payload.senderId, 'senderId');
  await assertParticipant(senderId, conversationId);
  enforceRateLimit(res, await consumeSendQuota(senderId, conversationId), (limit) => `…`);
  /* …and only now the actual endpoint */
}));
```

```ts
// after — the chain is the route definition, and it reads as a policy
messagesRouter.post(
  '/',
  requireParticipant({ actor: fromBody('senderId'), conversation: fromBody('conversationId') }),
  rateLimit({ consume: (_req, res) => consumeSendQuota(actorId(res), conversationId(res)), describe }),
  asyncHandler(messages.send),
);
```

The property that buys: **you can read a routes file and see which endpoints are guarded and metered.**
A missing authorization check is now a visible absence in a three-line chain rather than something you
have to notice isn't inside a 40-line handler. Given that the original app's central bug was *no
authorization anywhere*, that visibility is worth more than the indirection costs.

Controllers are plain exported functions, not classes. Nothing here needs instantiation or injected
state, so a class would add a constructor and an indentation level and buy nothing.

## Layout

```
src/
  index.ts        entry point — four lines
  app.ts          the HTTP surface: parser, static, /api, error handler
  server.ts       the process: connect, migrate, listen, graceful shutdown
  errors.ts       HttpError

  routes/         path + method + middleware chain + controller. No logic.
    index.ts      mounts the four groups under /api, plus health and the API 404
    {conversations,messages,search,users}.routes.ts

  controllers/    read the request, call a service, shape the response. Nothing else.
    {conversations,messages,search,users,health}.controller.ts

  middleware/     cross-cutting concerns
    async-handler.ts        Express 4 doesn't catch async rejections; this is why it stays up
    error-handler.ts        errorHandler, notFoundHandler, process-level handlers
    require-actor.ts        who is acting → res.locals.actorId  ← real auth plugs in here
    require-participant.ts  membership check → 403/404
    rate-limit.ts           the limiter and the 429 shape, once
    locals.ts               typed res.locals, with accessors that throw on a wiring mistake

  config.ts / config/      settings, and the rate-limit rule loader that reads rate-limit.config.json
  validation/parse.ts       request value parsers (int, intOr, nonEmptyString, …)
  services/                 the domain. Unchanged, and still knows nothing about HTTP.
  ws/  db/  util/           unchanged
```

Two boundaries worth stating, because they're what keeps this from being folders-for-their-own-sake:

- **Services never import from `middleware/`, `controllers/` or `routes/`.** They throw `HttpError`
  (hence its home at the root, not under middleware/) but know nothing about Express. That's why
  `ws/protocol.ts` can call `assertParticipant` for a WebSocket frame, where there is no `req`.
- **`app.ts` doesn't listen and `server.ts` doesn't route.** `createApp()` builds an app with no port
  and no connections, which is what makes in-process HTTP testing possible without the stack.

## Why validation stayed in controllers

It's the one thing a "everything is middleware" reading would move, and it shouldn't be. Middleware
can only hand results to a controller through `res.locals`, and TypeScript can't type that per-route —
so validating in middleware means the controller reads `res.locals.limit` as `any`, and the compiler
stops checking the layer where column-to-field mistakes actually happen.

`res.locals` is used for exactly the two values that middleware *owns* — `actorId` and
`conversationId` — with typed accessors that throw if the middleware wasn't mounted. Everything else
is parsed in the controller where the types survive.

## Ordering is a design decision, not an accident

`requireParticipant` → `rateLimit` → controller. Rejected requests must not spend quota, so
authorization comes first. Verified rather than assumed: eight unauthorized POSTs, then a legitimate
sender still gets its full allowance of five, and the 403 responses carry no rate-limit headers at all
because the limiter never ran.

## Verification

84 tests unchanged and passing at one instance and at three, 20/20 task requirements, and every status
code on every endpoint spot-checked against the pre-refactor behaviour — 200/400/403/404/429 all
identical. No test needed editing, which is the evidence that the restructuring didn't change
behaviour.
