import { Router } from 'express';
import * as messages from '../controllers/messages.controller.ts';
import { asyncHandler } from '../middleware/async-handler.ts';
import { parseMessagePayload } from '../middleware/payload.ts';
import { rateLimit, rateLimitReads } from '../middleware/rate-limit.ts';
import { fromBody, fromQuery } from '../middleware/require-actor.ts';
import { requireParticipant } from '../middleware/require-participant.ts';
import { actorId, conversationId } from '../middleware/locals.ts';
import { consumeSendQuota } from '../services/rate-limit.ts';

export const messagesRouter = Router();

/**
 * POST /api/messages
 *
 * The middleware order is the design, not an accident:
 *   requireParticipant   400 for a bad id, 404 for no such conversation, 403 for not yours
 *   parseMessagePayload  400 for a missing or oversized body
 *   rateLimit            only then charge quota — a request that was going to be rejected shouldn't
 *                        spend it, and that includes one rejected for a malformed body
 *   send                 the write
 */
messagesRouter.post(
  '/',
  requireParticipant({ actor: fromBody('senderId'), conversation: fromBody('conversationId'), actorField: 'senderId' }),
  parseMessagePayload,
  rateLimit({
    consume: (_req, res) => consumeSendQuota(actorId(res), conversationId(res)),
    describe: (limit, windowSeconds) =>
      `rate limit exceeded: at most ${limit} messages per ${windowSeconds}s per conversation`,
  }),
  asyncHandler(messages.send),
);

/**
 * GET /api/messages?conversationId=…&userId=…[&limit=][&before=][&since=]
 *
 * `userId` is required. It used to be optional "for compatibility with the original endpoint", which
 * meant naming a user you weren't got a 403 while naming nobody returned the whole history — an
 * authorization check the caller could opt out of. The original endpoint never accepted `userId` at
 * all, so there was no client on the other side of that compatibility.
 *
 * Metered on the shared `reads` bucket. A page is bounded, so this isn't the fan-out that search is,
 * but unmetered it's still an open loop against MySQL and Mongo — and the same client that would
 * loop here would loop on the inbox, which is why both share one allowance.
 */
messagesRouter.get(
  '/',
  requireParticipant({ actor: fromQuery('userId'), conversation: fromQuery('conversationId') }),
  rateLimitReads,
  asyncHandler(messages.list),
);
