import type { RequestHandler } from 'express';
import { config } from '../config.ts';
import { intArray, nonEmptyString, optionalClientId } from '../validation/parse.ts';

/**
 * Request-body parsing, as middleware, so it happens *before* the rate limiter charges anyone.
 *
 * middleware/rate-limit.ts states the ordering it needs — quota is only spent on a request that was
 * going to be accepted — but the parsers used to live in the controllers, which run after the
 * limiter. So a malformed body was charged and then rejected: a client looping a mistake got 429s
 * instead of the 400 that would tell it what to fix, and burned its allowance for real traffic on
 * the way.
 *
 * The parsed value goes into `res.locals` and comes back out through the typed accessors in
 * locals.ts, so the controller still gets a checked shape rather than re-reading `req.body`.
 */

export const parseMessagePayload: RequestHandler = (req, res, next) => {
  try {
    res.locals.newMessage = {
      body: nonEmptyString(req.body?.body, 'body', config.messages.maxBodyLength),
      clientId: optionalClientId(req.body?.clientId),
    };
    next();
  } catch (err) {
    next(err);
  }
};

export const parseConversationPayload: RequestHandler = (req, res, next) => {
  try {
    res.locals.newConversation = {
      title: nonEmptyString(req.body?.title, 'title', 200),
      participantIds: intArray(req.body?.participantIds, 'participantIds'),
    };
    next();
  } catch (err) {
    next(err);
  }
};
