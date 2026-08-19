import type { Response } from 'express';

/**
 * How controllers answer, in one place.
 *
 * The error side of the response surface has always been centralised — controllers throw
 * `HttpError` and `middleware/error-handler.ts` decides the status and the body shape, which is why
 * a 400 looks the same wherever it comes from. The success side was the half still written out at
 * each call site, so these are its counterpart: the status codes this API uses, named.
 *
 * `ok` is deliberately thin. It is here so that every controller reads the same way — and so the
 * response surface has a seam if it ever needs one — not because wrapping `res.json` is itself an
 * improvement.
 */

/** 200 with a body. The ordinary read response. */
export function ok<T>(res: Response, body: T): void {
  res.json(body);
}

/** 201 with the created resource. */
export function created<T>(res: Response, body: T): void {
  res.status(201).json(body);
}

/**
 * 201 when something was created, 200 when an existing resource is being handed back.
 *
 * The distinction is the idempotency contract, not a formality: a retried send with the same
 * `clientId` returns the message that already exists, and answering 201 there would tell the client
 * a second message was written when the whole point is that one wasn't. Named here so the rule is
 * stated once rather than living as a ternary inside a handler.
 */
export function createdOrOk<T>(res: Response, wasCreated: boolean, body: T): void {
  if (wasCreated) created(res, body);
  else ok(res, body);
}
