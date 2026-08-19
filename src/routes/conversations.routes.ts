import { Router } from 'express';
import * as conversations from '../controllers/conversations.controller.ts';
import { asyncHandler } from '../middleware/async-handler.ts';
import { actorId } from '../middleware/locals.ts';
import { rateLimit, rateLimitReads } from '../middleware/rate-limit.ts';
import { fromBody, fromParam, fromQuery, requireActor } from '../middleware/require-actor.ts';
import { requireParticipant } from '../middleware/require-participant.ts';
import { validateBody, validateQuery } from '../middleware/validate.ts';
import {
  conversationPayloadSchema,
  listConversationsQuerySchema,
  markReadPayloadSchema,
} from '../validation/schemas.ts';
import { config } from '../config.ts';

export const conversationsRouter = Router();

/**
 * GET /api/conversations?userId=… — the inbox for one user.
 *
 * Metered on the shared `reads` bucket, together with message history: the client refetches this on
 * every reconnect and every resync, which is exactly the shape a runaway loop has too.
 */
conversationsRouter.get(
  '/',
  requireActor(fromQuery('userId')),
  validateQuery(listConversationsQuerySchema, (res, query) => {
    res.locals.conversationsQuery = query;
  }),
  rateLimitReads,
  asyncHandler(conversations.list),
);

/**
 * POST /api/conversations
 *
 * The creator is the first participant until there's real auth to take it from. Metered so
 * conversation creation can't be used for unbounded growth — a high ceiling, since creating
 * conversations is normal bursty behaviour and isn't the abuse vector search is.
 *
 * The payload is validated before the limiter, so a malformed create returns the 400 that explains
 * it rather than spending quota and eventually answering 429.
 */
conversationsRouter.post(
  '/',
  requireActor((req) => req.body?.participantIds?.[0], 'participantIds[0]'),
  validateBody(conversationPayloadSchema, (res, payload) => {
    res.locals.newConversation = payload;
  }),
  rateLimit({
    rule: config.rateLimit.create,
    key: (_req, res) => `create:${actorId(res)}`,
    describe: (limit, windowSeconds) =>
      `rate limit exceeded: at most ${limit} new conversations per ${windowSeconds}s`,
  }),
  asyncHandler(conversations.create),
);

/** POST /api/conversations/:id/read — moves this participant's unread watermark forward. */
conversationsRouter.post(
  '/:id/read',
  requireParticipant({ actor: fromBody('userId'), conversation: fromParam('id') }),
  validateBody(markReadPayloadSchema, (res, payload) => {
    res.locals.readPayload = payload;
  }),
  asyncHandler(conversations.read),
);
