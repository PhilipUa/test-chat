import { queryOne, queryRows, runWrite, sqlList, sqlRows, withTransaction } from '../../db/mysql.ts';
import { HttpError } from '../../http/errors.ts';

/**
 * Conversation writes.
 *
 * Split out of services/conversations.ts, which mixed these with read models and authorization.
 */

/**
 * Creating a conversation used to insert the row, then insert participants in a loop with no
 * transaction. A repeated id tripped the primary key, which — with no error handling on the async
 * route — killed the process and left a conversation with no participants behind.
 *
 * Now: one transaction, ids de-duplicated by the validator, and participants must actually exist.
 */
export async function createConversation(
  title: string,
  participantIds: number[],
): Promise<{ id: number; title: string; participantIds: number[] }> {
  const known = await queryRows<{ id: number }>(
    `SELECT id FROM users WHERE id IN (${sqlList(participantIds.length)})`,
    participantIds,
  );
  const knownIds = new Set(known.map((r) => Number(r.id)));
  const unknown = participantIds.filter((id) => !knownIds.has(id));
  if (unknown.length) {
    throw HttpError.badRequest('unknown participant ids', { unknown });
  }

  return withTransaction(async (conn) => {
    const created = await runWrite('INSERT INTO conversations (title) VALUES (?)', [title], conn);
    const id = Number(created.insertId);

    // One multi-row insert instead of a loop. INSERT IGNORE keeps a duplicate from being fatal even
    // if something upstream lets one through.
    await runWrite(
      `INSERT IGNORE INTO conversation_participants (conversation_id, user_id)
       VALUES ${sqlRows(participantIds.length, 2)}`,
      participantIds.flatMap((uid) => [id, uid]),
      conn,
    );

    return { id, title, participantIds };
  });
}

/**
 * Marks messages up to `messageId` as read for a participant.
 *
 * Unread state used to live in a browser variable, so it vanished on reload and could never be
 * consistent across two tabs — let alone across instances. It's a monotonic watermark on the
 * participant row: idempotent, and safe to apply out of order.
 */
export async function markRead(
  userId: number,
  conversationId: number,
  messageId: number,
): Promise<number> {
  await runWrite(
    `UPDATE conversation_participants
     SET last_read_message_id = GREATEST(last_read_message_id, ?)
     WHERE conversation_id = ? AND user_id = ?`,
    [messageId, conversationId, userId],
  );
  const row = await queryOne<{ lastReadMessageId: number }>(
    `SELECT last_read_message_id AS lastReadMessageId FROM conversation_participants
     WHERE conversation_id = ? AND user_id = ?`,
    [conversationId, userId],
  );
  return Number(row?.lastReadMessageId ?? 0);
}
