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
import { publish, publishToUsers } from '../ws/hub.ts';
import { created, ok } from './respond.ts';

/** Conversation endpoints. */

/** GET /api/conversations?userId=…[&limit=][&cursor=] */
export async function list(req: Request, res: Response): Promise<void> {
  ok(res, await listConversations(actorId(res), conversationsQuery(res)));
}

/**
 * Creates a conversation and tells the people in it.
 *
 * The announcement goes out on each participant's *user* channel, not the new conversation's:
 * nobody can be subscribed to a conversation that did not exist a moment ago, so there was no route
 * to them at all. Without it the other participants saw nothing until they reloaded — and, because
 * their sockets were not subscribed either, missed every message sent in the meantime.
 */
export async function create(req: Request, res: Response): Promise<void> {
  // Validated by the conversation schema, before the rate limiter charged for it.
  const { title, participantIds } = newConversation(res);
  const { conversation, summaries } = await createConversation(title, participantIds);

  await publishToUsers(
    summaries.map(({ userId, conversation }) => ({
      userId,
      event: { type: 'conversation' as const, conversation },
    })),
  );

  created(res, conversation);
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
