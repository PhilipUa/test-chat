import {
  advanceReadWatermark,
  createWithParticipants,
} from '../../repositories/conversations.repository.ts';
import { namesByIds } from '../../repositories/users.repository.ts';
import { onlineAmong } from '../presence.ts';
import { HttpError } from '../../errors.ts';
import type { ConversationSummary } from './queries.ts';

/**
 * Conversation writes — the policy half. The atomic write itself (conversation + membership in
 * one transaction) lives in repositories/conversations.repository.ts.
 *
 * Creating a conversation used to insert the row, then insert participants in a loop with no
 * transaction. A repeated id tripped the primary key, which — with no error handling on the async
 * route — killed the process and left a conversation with no participants behind. Now: ids
 * de-duplicated by the validator, participants must actually exist, and the write is atomic.
 */
export interface CreatedConversation {
  /** What POST /api/conversations answers with. */
  conversation: { id: number; title: string; participantIds: number[] };
  /**
   * The new conversation as each participant's inbox will show it, ready to be announced to them.
   *
   * One row per participant rather than one shared row, because an inbox row is a per-user view:
   * `participants` is everyone *else*. Built here rather than by re-reading the inbox, which would
   * be one query per recipient for a conversation whose entire contents we already know.
   */
  summaries: Array<{ userId: number; conversation: ConversationSummary }>;
}

export async function createConversation(
  title: string,
  participantIds: number[],
): Promise<CreatedConversation> {
  const names = await namesByIds(participantIds);
  const unknown = participantIds.filter((id) => !names.has(id));
  if (unknown.length) {
    throw HttpError.badRequest('unknown participant ids', { unknown });
  }

  const { id, createdAt } = await createWithParticipants(title, participantIds);

  // Whoever is already connected shows as online from the first render, instead of the dots
  // appearing a round trip later when the recipient re-subscribes.
  const online = await onlineAmong(participantIds);
  const activityAt = createdAt.toISOString();

  return {
    conversation: { id, title, participantIds },
    summaries: participantIds.map((userId) => ({
      userId,
      conversation: {
        id,
        title,
        messageCount: 0,
        unreadCount: 0,
        lastReadMessageId: 0,
        lastMessage: null,
        // A conversation with no messages is ordered by its own creation — the same rule the inbox
        // query uses, so a row that arrived over the socket sits where a refetch would put it.
        activityAt,
        participants: participantIds
          .filter((id) => id !== userId)
          .map((id) => ({ id, name: names.get(id) ?? `User ${id}`, online: online.has(id) })),
      },
    })),
  };
}

/**
 * Marks messages up to `messageId` as read for a participant.
 *
 * Unread state used to live in a browser variable, so it vanished on reload and could never be
 * consistent across two tabs — let alone across instances. It's a monotonic watermark on the
 * participant row: idempotent, and safe to apply out of order (the repository only ever moves it
 * forward).
 */
export async function markRead(
  userId: number,
  conversationId: number,
  messageId: number,
): Promise<number> {
  return advanceReadWatermark(userId, conversationId, messageId);
}
