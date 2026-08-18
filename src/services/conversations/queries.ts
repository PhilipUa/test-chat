import { messageBodiesById } from '../../db/mongo.ts';
import { queryRows, sqlList } from '../../db/mysql.ts';
import { onlineAmong } from '../presence.ts';

/**
 * Conversation read models — the inbox list and its supporting lookups.
 *
 * Split out of services/conversations.ts, which mixed these with writes and authorization.
 */

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

/**
 * The inbox.
 *
 * This used to be the conversation rows plus *two* queries per conversation in a `for` loop — 101
 * round trips for 50 conversations, each a full table scan because `messages` had no index on
 * conversation_id. It's now one query whose correlated subqueries are index-only scans against
 * idx_messages_conversation, plus one batched Mongo lookup for the preview bodies and one query for
 * all participants.
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

  const lastIds = rows.map((r) => Number(r.lastMessageId)).filter((id) => Number.isInteger(id));
  const bodyById = await messageBodiesById(lastIds);
  const participantsByConversation = await participantsFor(
    rows.map((r) => Number(r.id)),
    userId,
  );

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
 * one Redis lookup for all users, rather than a round trip per row — the same N+1 the function above
 * exists to avoid.
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

export async function conversationTitles(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const unique = [...new Set(ids)];
  const rows = await queryRows<{ id: number; title: string }>(
    `SELECT id, title FROM conversations WHERE id IN (${sqlList(unique.length)})`,
    unique,
  );
  return new Map(rows.map((r) => [Number(r.id), r.title]));
}
