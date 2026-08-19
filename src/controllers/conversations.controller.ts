import type { Request, Response } from 'express';
import {
  actorId,
  conversationId,
  conversationsQuery,
  newConversation,
  readPayload,
} from '../middleware/locals.ts';
import { createConversation, markRead } from '../services/conversations/commands.ts';
import { listConversations } from '../services/conversations/queries.ts';
import { publish } from '../ws/hub.ts';
import { created, ok } from './respond.ts';

/** Conversation endpoints. */

/** GET /api/conversations?userId=…[&limit=][&cursor=] */
export async function list(req: Request, res: Response): Promise<void> {
  ok(res, await listConversations(actorId(res), conversationsQuery(res)));
}

export async function create(req: Request, res: Response): Promise<void> {
  // Validated by the conversation schema, before the rate limiter charged for it.
  const { title, participantIds } = newConversation(res);
  created(res, await createConversation(title, participantIds));
}

/**
 * Marks a conversation read up to a message id.
 *
 * Backs the unread badge, which used to be a browser variable that vanished on reload. The `read`
 * event is fanned out so the user's *other* sessions clear their badge too.
 */
export async function read(req: Request, res: Response): Promise<void> {
  const userId = actorId(res);
  const conversation = conversationId(res);
  const { messageId } = readPayload(res);

  const lastReadMessageId = await markRead(userId, conversation, messageId);
  await publish(conversation, {
    type: 'read',
    conversationId: conversation,
    userId,
    lastReadMessageId,
  });

  ok(res, { conversationId: conversation, userId, lastReadMessageId });
}
