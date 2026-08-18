import { config } from '../../config.ts';
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
  /** The value the inbox is ordered by: last message, or the conversation's own creation. */
  activityAt: Date;
}

export interface ConversationPage {
  conversations: ConversationSummary[];
  hasMore: boolean;
  /** Opaque cursor to pass back as `cursor`; null at the end of the list. */
  nextCursor: string | null;
}

/**
 * The inbox cursor: the row's sort key, which is (activity timestamp, conversation id).
 *
 * Keyset rather than OFFSET for the same reasons as messages — constant cost however far you page,
 * and it can't skip or repeat a row when a conversation moves while you're paging. The id breaks ties
 * between conversations with no messages, which all share their creation second.
 */
export interface ConversationCursor {
  activityMs: number;
  conversationId: number;
}

export function encodeCursor(cursor: ConversationCursor): string {
  return `${cursor.activityMs}.${cursor.conversationId}`;
}

export function decodeCursor(raw: string): ConversationCursor | undefined {
  const match = /^(\d+)\.(\d+)$/.exec(raw);
  if (!match) return undefined;
  const activityMs = Number(match[1]);
  const conversationId = Number(match[2]);
  if (!Number.isSafeInteger(activityMs) || !Number.isSafeInteger(conversationId)) return undefined;
  return { activityMs, conversationId };
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
 *
 * It is also paged. The N+1 was fixed but the bound was not, so this returned every conversation a
 * user is in — with two correlated subqueries each — and the client refetches it on every reconnect
 * and every resync. A user with 878 conversations was a 181 KB response on a path that runs whenever
 * realtime blips, and it degrades with message volume rather than conversation count.
 */
export async function listConversations(
  userId: number,
  opts: { limit?: number; cursor?: ConversationCursor } = {},
): Promise<ConversationPage> {
  const limit = Math.min(
    opts.limit ?? config.conversations.defaultPageSize,
    config.conversations.maxPageSize,
  );

  const params: unknown[] = [userId];
  let keyset = '';
  if (opts.cursor) {
    // Row-wise comparison against the same expression the ORDER BY uses.
    keyset = `AND (COALESCE(lm.created_at, c.created_at) < ?
                OR (COALESCE(lm.created_at, c.created_at) = ? AND c.id < ?))`;
    const at = new Date(opts.cursor.activityMs);
    params.push(at, at, opts.cursor.conversationId);
  }

  // limit + 1 tells us whether there is another page without a second COUNT query.
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
       lm.created_at                                                  AS lastCreatedAt,
       COALESCE(lm.created_at, c.created_at)                          AS activityAt
     FROM conversations c
     JOIN conversation_participants p
       ON p.conversation_id = c.id AND p.user_id = ?
     LEFT JOIN messages lm
       ON lm.id = (SELECT MAX(m2.id) FROM messages m2 WHERE m2.conversation_id = c.id)
     WHERE 1 = 1 ${keyset}
     ORDER BY COALESCE(lm.created_at, c.created_at) DESC, c.id DESC
     LIMIT ${limit + 1}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  const lastIds = page.map((r) => Number(r.lastMessageId)).filter((id) => Number.isInteger(id));
  const bodyById = await messageBodiesById(lastIds);
  const participantsByConversation = await participantsFor(
    page.map((r) => Number(r.id)),
    userId,
  );

  const conversations = page.map((r) => ({
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

  return {
    conversations,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            activityMs: new Date(last.activityAt).getTime(),
            conversationId: Number(last.id),
          })
        : null,
  };
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
