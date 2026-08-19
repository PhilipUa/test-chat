import {
  advanceReadWatermark,
  createWithParticipants,
} from '../../repositories/conversations.repository.ts';
import { existingUserIds } from '../../repositories/users.repository.ts';
import { HttpError } from '../../errors.ts';

/**
 * Conversation writes — the policy half. The atomic write itself (conversation + membership in
 * one transaction) lives in repositories/conversations.repository.ts.
 *
 * Creating a conversation used to insert the row, then insert participants in a loop with no
 * transaction. A repeated id tripped the primary key, which — with no error handling on the async
 * route — killed the process and left a conversation with no participants behind. Now: ids
 * de-duplicated by the validator, participants must actually exist, and the write is atomic.
 */
export async function createConversation(
  title: string,
  participantIds: number[],
): Promise<{ id: number; title: string; participantIds: number[] }> {
  const known = await existingUserIds(participantIds);
  const unknown = participantIds.filter((id) => !known.has(id));
  if (unknown.length) {
    throw HttpError.badRequest('unknown participant ids', { unknown });
  }

  const id = await createWithParticipants(title, participantIds);
  return { id, title, participantIds };
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
