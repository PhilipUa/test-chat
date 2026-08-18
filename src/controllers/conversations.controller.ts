import type { Request, Response } from 'express';
import { actorId, conversationId } from '../middleware/locals.ts';
import { int, intArray, nonEmptyString } from '../validation/parse.ts';
import { createConversation, markRead } from '../services/conversations/commands.ts';
import { listConversations } from '../services/conversations/queries.ts';
import { publish } from '../ws/hub.ts';

/** Conversation endpoints. */

export async function list(req: Request, res: Response): Promise<void> {
  res.json(await listConversations(actorId(res)));
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = req.body ?? {};
  const title = nonEmptyString(body.title, 'title', 200);
  const participantIds = intArray(body.participantIds, 'participantIds');
  res.status(201).json(await createConversation(title, participantIds));
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
  const messageId = int(req.body?.messageId, 'messageId');

  const lastReadMessageId = await markRead(userId, conversation, messageId);
  await publish(conversation, {
    type: 'read',
    conversationId: conversation,
    userId,
    lastReadMessageId,
  });

  res.json({ conversationId: conversation, userId, lastReadMessageId });
}
