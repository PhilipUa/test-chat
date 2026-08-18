import {
  exists,
  isDuplicateKeyError,
  queryOne,
  queryRows,
  runWrite,
  sqlList,
  sqlRows,
  withTransaction,
} from '../db/mysql.ts';
import { messageBodiesById } from '../db/mongo.ts';
import { HttpError } from '../http/errors.ts';
import { onlineAmong } from './presence.ts';

export interface LastMessage {
  id: number;
  senderId: number;
  body: string;
  createdAt: string;
}

export interface Participant {
  id: number;
  name: string;
  online: boolean;
}

/** Row shapes for the queries in this file, declared next to the query that produces them. */
interface ConversationSummaryRow {
  id: number;
  title: string;
  lastReadMessageId: number | null;
  messageCount: number;
  unreadCount: number;
  lastMessageId: number | null;
  lastSenderId: number | null;
  lastCreatedAt: Date | null;
}

interface ParticipantRow {
  conversationId: number;
  id: number;
  name: string;
}

export interface ConversationSummary {
  id: number;
  title: string;
  messageCount: number;
  unreadCount: number;
  lastReadMessageId: number;
  lastMessage: LastMessage | null;
  /** Other participants, with live presence — lets the UI show who's around. */
  participants: Participant[];
}

/**
 * Finding G: this used to be the conversation rows plus *two* queries per conversation in a
 * `for` loop — 101 round trips for 50 conversations, each one a full scan of `messages` because
 * of finding F. It's now a single query; the correlated subqueries are index seeks against
 * idx_messages_conversation, plus one batched Mongo lookup for the preview bodies.
 */
export async function listConversations(userId: number): Promise<ConversationSummary[]> {
  const rows = await queryRows<ConversationSummaryRow>(
    `SELECT
       c.id,
       c.title,
       p.last_read_message_id                                         AS lastReadMessageId,
       (SELECT COUNT(*) FROM messages m
         WHERE m.conversation_id = c.id)                              AS messageCount,
       (SELECT COUNT(*) FROM messages m
         WHERE m.conversation_id = c.id
           AND m.id > p.last_read_message_id
           AND m.sender_id <> p.user_id)                              AS unreadCount,
       lm.id                                                          AS lastMessageId,
       lm.sender_id                                                   AS lastSenderId,
       lm.created_at                                                  AS lastCreatedAt
     FROM conversations c
     JOIN conversation_participants p
       ON p.conversation_id = c.id AND p.user_id = ?
     LEFT JOIN messages lm
       ON lm.id = (SELECT MAX(m2.id) FROM messages m2 WHERE m2.conversation_id = c.id)
     ORDER BY COALESCE(lm.created_at, c.created_at) DESC, c.id DESC`,
    [userId],
  );

  // One batched lookup for the preview bodies instead of one per conversation.
  const lastIds = rows.map((r) => Number(r.lastMessageId)).filter((id) => Number.isInteger(id));
  const bodyById = await messageBodiesById(lastIds);

  // Participants for every conversation in one query rather than one per row — the same N+1 the
  // rest of this function exists to avoid.
  const conversationIds = rows.map((r) => Number(r.id));
  const participantsByConversation = await participantsFor(conversationIds, userId);

  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    messageCount: Number(r.messageCount),
    unreadCount: Number(r.unreadCount),
    lastReadMessageId: Number(r.lastReadMessageId ?? 0),
    lastMessage: r.lastMessageId
      ? {
          id: Number(r.lastMessageId),
          senderId: Number(r.lastSenderId),
          body: bodyById.get(Number(r.lastMessageId)) ?? '',
          createdAt: new Date(r.lastCreatedAt!).toISOString(),
        }
      : null,
    participants: participantsByConversation.get(Number(r.id)) ?? [],
  }));
}

/**
 * The other participants of each conversation, with presence. One query for all conversations and
 * one Redis lookup for all users, rather than a round trip per row.
 */
async function participantsFor(
  conversationIds: number[],
  excludeUserId: number,
): Promise<Map<number, Participant[]>> {
  const result = new Map<number, Participant[]>();
  if (!conversationIds.length) return result;

  const rows = await queryRows<ParticipantRow>(
    `SELECT p.conversation_id AS conversationId, u.id, u.name
     FROM conversation_participants p
     JOIN users u ON u.id = p.user_id
     WHERE p.conversation_id IN (${sqlList(conversationIds.length)})
       AND p.user_id <> ?
     ORDER BY u.name ASC`,
    [...conversationIds, excludeUserId],
  );

  const online = await onlineAmong([...new Set(rows.map((r) => Number(r.id)))]);
  for (const row of rows) {
    const conversationId = Number(row.conversationId);
    const list = result.get(conversationId) ?? [];
    list.push({ id: Number(row.id), name: row.name, online: online.has(Number(row.id)) });
    result.set(conversationId, list);
  }
  return result;
}

/**
 * Finding A: creating a conversation used to insert the row, then insert participants in a loop
 * with no transaction. A repeated id tripped the primary key, killed the process, and left a
 * conversation with no participants behind. Now: one transaction, ids de-duplicated by the
 * validator, and participants must actually exist.
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

    // One multi-row insert instead of a loop. INSERT IGNORE keeps a duplicate from being fatal
    // even if something upstream lets one through.
    await runWrite(
      `INSERT IGNORE INTO conversation_participants (conversation_id, user_id)
       VALUES ${sqlRows(participantIds.length, 2)}`,
      participantIds.flatMap((uid) => [id, uid]),
      conn,
    );

    return { id, title, participantIds };
  });
}

/** Finding E: nothing checked whether the caller was actually in the conversation. */
export async function assertParticipant(userId: number, conversationId: number): Promise<void> {
  const isParticipant = await exists(
    `SELECT 1 FROM conversation_participants
     WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
    [conversationId, userId],
  );
  if (isParticipant) return;

  // Distinguish "no such conversation" from "not yours" for a useful error, but don't leak the
  // existence of conversations the caller isn't in.
  const conversationExists = await exists(
    'SELECT 1 FROM conversations WHERE id = ? LIMIT 1',
    [conversationId],
  );
  if (!conversationExists) throw HttpError.notFound(`conversation ${conversationId} not found`);
  throw HttpError.forbidden(`user ${userId} is not a participant in conversation ${conversationId}`);
}

/**
 * Intersects a requested set of conversation ids with those the user is actually in. Used by the
 * WS subscribe handler, which previously accepted any ids the client named. An empty `requested`
 * means "everything I'm in".
 */
export async function participantConversationIds(
  userId: number,
  requested: number[] = [],
): Promise<number[]> {
  if (requested.length === 0) {
    const rows = await queryRows<{ conversation_id: number }>(
      'SELECT conversation_id FROM conversation_participants WHERE user_id = ?',
      [userId],
    );
    return rows.map((r) => Number(r.conversation_id));
  }

  const unique = [...new Set(requested)];
  const rows = await queryRows<{ conversation_id: number }>(
    `SELECT conversation_id FROM conversation_participants
     WHERE user_id = ? AND conversation_id IN (${sqlList(unique.length)})`,
    [userId, ...unique],
  );
  return rows.map((r) => Number(r.conversation_id));
}

export async function participantIdsOf(conversationId: number): Promise<number[]> {
  const rows = await queryRows<{ user_id: number }>(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = ?',
    [conversationId],
  );
  return rows.map((r) => Number(r.user_id));
}

/**
 * Marks messages up to `messageId` as read for a participant.
 *
 * Finding M: unread state lived in a browser variable, so it vanished on reload and could never
 * be consistent across two tabs — let alone across instances. It's a monotonic watermark on the
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

export async function conversationTitles(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const unique = [...new Set(ids)];
  const rows = await queryRows<{ id: number; title: string }>(
    `SELECT id, title FROM conversations WHERE id IN (${sqlList(unique.length)})`,
    unique,
  );
  return new Map(rows.map((r) => [Number(r.id), r.title]));
}

export { isDuplicateKeyError };
