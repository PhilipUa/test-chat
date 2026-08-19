import {
  participantNameRows,
  summaryRows,
  titlesByIds,
} from '../../repositories/conversations.repository.ts';
import { bodiesByIds } from '../../repositories/message-bodies.repository.ts';
import { onlineAmong } from '../presence.ts';

/**
 * Conversation read models — the inbox list and its supporting lookups.
 *
 * The shaping (paging, cursors, presence decoration) lives here; the queries live in
 * repositories/conversations.repository.ts, including the one raw-SQL inbox query whose history
 * (a 101-round-trip N+1, then an unbounded response) is documented there and in docs/03-changes.md.
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
  /**
   * The value this list is ordered by: the last message's timestamp, or the conversation's own
   * creation when it has none.
   *
   * Exposed so the client can hold the order itself as messages arrive, instead of drifting out of
   * order until the next fetch. `lastMessage.createdAt` isn't enough on its own — a conversation with
   * no messages has no last message, and it still has a place in the ordering.
   */
  activityAt: string;
  /** Other participants, with live presence — lets the UI show who's around. */
  participants: Participant[];
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

/**
 * The inbox: one summary query, one batched Mongo lookup for the preview bodies, one query for
 * all participants, one Redis lookup for presence — regardless of page size.
 */
export async function listConversations(
  userId: number,
  // `limit` arrives already defaulted and clamped by the route schema — the one place page-size
  // policy lives.
  opts: { limit: number; cursor?: ConversationCursor },
): Promise<ConversationPage> {
  const { limit } = opts;
  const rows = await summaryRows(
    userId,
    limit,
    opts.cursor
      ? { activityAt: new Date(opts.cursor.activityMs), conversationId: opts.cursor.conversationId }
      : undefined,
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  const lastIds = page.map((r) => r.lastMessageId).filter((id): id is number => id !== null);
  const bodyById = await bodiesByIds(lastIds);
  const participantsByConversation = await participantsFor(
    page.map((r) => r.id),
    userId,
  );

  const conversations = page.map((r) => ({
    id: r.id,
    title: r.title,
    messageCount: r.messageCount,
    unreadCount: r.unreadCount,
    lastReadMessageId: r.lastReadMessageId,
    lastMessage:
      r.lastMessageId !== null
        ? {
            id: r.lastMessageId,
            senderId: r.lastSenderId ?? 0,
            body: bodyById.get(r.lastMessageId) ?? '',
            createdAt: new Date(r.lastCreatedAt ?? r.activityAt).toISOString(),
          }
        : null,
    activityAt: new Date(r.activityAt).toISOString(),
    participants: participantsByConversation.get(r.id) ?? [],
  }));

  return {
    conversations,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            activityMs: new Date(last.activityAt).getTime(),
            conversationId: last.id,
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

  const rows = await participantNameRows(conversationIds, excludeUserId);
  const online = await onlineAmong([...new Set(rows.map((r) => r.id))]);
  for (const row of rows) {
    const list = result.get(row.conversationId) ?? [];
    list.push({ id: row.id, name: row.name, online: online.has(row.id) });
    result.set(row.conversationId, list);
  }
  return result;
}

export async function conversationTitles(ids: number[]): Promise<Map<number, string>> {
  return titlesByIds(ids);
}
