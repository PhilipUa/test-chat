import type { Request, Response } from 'express';
import { HttpError } from '../errors.ts';
import { actorId, conversationId, newConversation } from '../middleware/locals.ts';
import { config } from '../config.ts';
import { int, intOr } from '../validation/parse.ts';
import { createConversation, markRead } from '../services/conversations/commands.ts';
import { decodeCursor, listConversations } from '../services/conversations/queries.ts';
import { publish } from '../ws/hub.ts';

/** Conversation endpoints. */

/** GET /api/conversations?userId=…[&limit=][&cursor=] */
export async function list(req: Request, res: Response): Promise<void> {
  const limit = intOr(req.query.limit, 'limit', config.conversations.defaultPageSize, {
    max: config.conversations.maxPageSize,
  });

  // Rejected rather than ignored: silently returning page one for a cursor we can't read looks to the
  // client like the end of the list, which is how a paging loop quietly drops conversations.
  const raw = req.query.cursor;
  let cursor;
  if (raw !== undefined && raw !== '') {
    cursor = decodeCursor(String(raw));
    if (!cursor) throw HttpError.badRequest('cursor is not a valid pagination cursor');
  }

  res.json(await listConversations(actorId(res), { limit, cursor }));
}

export async function create(req: Request, res: Response): Promise<void> {
  // Parsed by parseConversationPayload, before the rate limiter charged for it.
  const { title, participantIds } = newConversation(res);
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
