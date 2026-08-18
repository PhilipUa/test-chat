import express from 'express';
import { config } from '../config.ts';
import { asyncHandler } from '../http/errors.ts';
import { enforceRateLimit } from '../http/rate-limit-headers.ts';
import {
  boundedInt,
  nonEmptyString,
  optionalClientId,
  optionalNonNegativeInt,
  optionalPositiveInt,
  positiveInt,
} from '../http/validate.ts';
import { assertParticipant } from '../services/conversations.ts';
import { createMessage, listMessages } from '../services/messages.ts';
import { consumeSendQuota } from '../services/rate-limit.ts';
import { publish } from '../ws/hub.ts';

export const messagesRouter = express.Router();

messagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const payload = req.body ?? {};
    const conversationId = positiveInt(payload.conversationId, 'conversationId');
    const senderId = positiveInt(payload.senderId, 'senderId');
    const body = nonEmptyString(payload.body, 'body', config.messages.maxBodyLength);
    const clientId = optionalClientId(payload.clientId);

    // Finding E: conversationId and senderId used to be trusted straight off the request, so you
    // could post into a conversation you weren't in, or as a user that didn't exist.
    await assertParticipant(senderId, conversationId);

    // tasks/rate-limiting.md. Deliberately after validation and authorization (a rejected request
    // shouldn't spend quota) and before the write.
    //
    // Note createMessage() checks clientId for an existing message *first*, so a client retrying
    // after a network timeout gets its original message back. That send is still counted here,
    // which is the conservative choice: a retry loop is exactly the traffic we're limiting, and
    // the caller still gets a correct 201 for anything already stored.
    enforceRateLimit(
      res,
      await consumeSendQuota(senderId, conversationId),
      (limit) =>
        `rate limit exceeded: at most ${limit} messages per ${
          config.rateLimit.windowMs / 1000
        }s per conversation`,
    );

    const { message, deduplicated } = await createMessage({
      conversationId,
      senderId,
      body,
      clientId,
    });

    // Only fan out genuinely new messages — re-broadcasting a deduplicated retry would put a
    // second copy in everyone's window, which is the bug idempotency exists to prevent.
    if (!deduplicated) {
      await publish(message.conversationId, { type: 'message', ...message });
    }

    res.status(deduplicated ? 200 : 201).json(message);
  }),
);

messagesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const conversationId = positiveInt(req.query.conversationId, 'conversationId');
    const userId = optionalPositiveInt(req.query.userId, 'userId');
    const limit = boundedInt(
      req.query.limit,
      'limit',
      config.messages.defaultPageSize,
      config.messages.maxPageSize,
    );
    const before = optionalPositiveInt(req.query.before, 'before');
    // `since` walks forwards from a known id, for a client catching up after a realtime gap.
    // Redis pub/sub is at-most-once, so events published while an instance was disconnected are
    // lost — this is how a client recovers exactly what it missed instead of refetching wholesale.
    const since = optionalNonNegativeInt(req.query.since, 'since');

    // userId is optional for backwards compatibility with the original endpoint, but when it's
    // supplied we enforce membership. See docs/04-tradeoffs.md on why this isn't mandatory yet.
    if (userId !== undefined) await assertParticipant(userId, conversationId);

    res.json(await listMessages(conversationId, { limit, before, since }));
  }),
);
