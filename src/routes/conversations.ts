import express from 'express';
import { config } from '../config.ts';
import { asyncHandler } from '../http/errors.ts';
import { enforceRateLimit } from '../http/rate-limit-headers.ts';
import { int, intArray, nonEmptyString } from '../http/validate.ts';
import { createConversation, markRead } from '../services/conversations/commands.ts';
import { assertParticipant } from '../services/conversations/membership.ts';
import { listConversations } from '../services/conversations/queries.ts';
import { consumeCreateQuota } from '../services/rate-limit.ts';
import { publish } from '../ws/hub.ts';

export const conversationsRouter = express.Router();

conversationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = int(req.query.userId, 'userId');
    res.json(await listConversations(userId));
  }),
);

conversationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const title = nonEmptyString(body.title, 'title', 200);
    const participantIds = intArray(body.participantIds, 'participantIds');

    // The creator is whoever is first in the list until there's real auth to take it from.
    // Metered so conversation creation can't be used for unbounded growth.
    enforceRateLimit(
      res,
      await consumeCreateQuota(participantIds[0]!),
      (limit) =>
        `rate limit exceeded: at most ${limit} new conversations per ${
          config.rateLimit.createWindowMs / 1000
        }s`,
    );

    res.status(201).json(await createConversation(title, participantIds));
  }),
);

/**
 * Marks a conversation read up to a message id. Backs the unread dot, which used to be a browser
 * variable that vanished on reload (finding M) and could never agree between two tabs.
 * The `read` event is fanned out so the user's *other* sessions clear the dot too.
 */
conversationsRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const conversationId = int(req.params.id, 'conversationId');
    const userId = int(req.body?.userId, 'userId');
    const messageId = int(req.body?.messageId, 'messageId');

    await assertParticipant(userId, conversationId);
    const lastReadMessageId = await markRead(userId, conversationId, messageId);

    await publish(conversationId, { type: 'read', conversationId, userId, lastReadMessageId });
    res.json({ conversationId, userId, lastReadMessageId });
  }),
);
