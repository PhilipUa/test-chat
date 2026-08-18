import { Router } from 'express';
import { config } from '../config.ts';
import * as messages from '../controllers/messages.controller.ts';
import { asyncHandler } from '../middleware/async-handler.ts';
import { rateLimit } from '../middleware/rate-limit.ts';
import { fromBody, fromQuery } from '../middleware/require-actor.ts';
import { requireParticipant } from '../middleware/require-participant.ts';
import { actorId, conversationId } from '../middleware/locals.ts';
import { consumeSendQuota } from '../services/rate-limit.ts';

export const messagesRouter = Router();

/**
 * POST /api/messages
 *
 * The middleware order is the design, not an accident:
 *   requireParticipant  400 for a bad id, 404 for no such conversation, 403 for not yours
 *   rateLimit           only then charge quota — a request that was going to be rejected shouldn't
 *                       spend it
 *   send                the write
 */
messagesRouter.post(
  '/',
  requireParticipant({ actor: fromBody('senderId'), conversation: fromBody('conversationId'), actorField: 'senderId' }),
  rateLimit({
    consume: (_req, res) => consumeSendQuota(actorId(res), conversationId(res)),
    describe: (limit) =>
      `rate limit exceeded: at most ${limit} messages per ${
        config.rateLimit.windowMs / 1000
      }s per conversation`,
  }),
  asyncHandler(messages.send),
);

/**
 * GET /api/messages?conversationId=…[&userId=…][&limit=][&before=][&since=]
 *
 * `userId` is optional for compatibility with the original endpoint; when present, membership is
 * enforced. See docs/04-tradeoffs.md for why that edge is still soft.
 */
messagesRouter.get(
  '/',
  requireParticipant({
    actor: fromQuery('userId'),
    conversation: fromQuery('conversationId'),
    optionalActor: true,
  }),
  asyncHandler(messages.list),
);
