import { Prisma, db } from '../db/mysql.ts';

/**
 * Data access for `conversations` and `conversation_participants`. No business logic here —
 * authorization decisions (403 vs 404), participant validation and inbox shaping live in
 * services/conversations/*.
 */

/** Creates the conversation and its membership as one atomic write. Returns the new id. */
export async function createWithParticipants(
  title: string,
  participantIds: number[],
): Promise<{ id: number; createdAt: Date }> {
  return db.$transaction(async (tx) => {
    // createdAt comes back from the row rather than being generated here: the column defaults to
    // CURRENT_TIMESTAMP(0) precisely so the app clock can't put it in the future (see the schema),
    // and it is the conversation's `activityAt` until its first message — the key the inbox is
    // ordered by, which the realtime announcement has to agree with.
    const created = await tx.conversation.create({
      data: { title },
      select: { id: true, createdAt: true },
    });
    // One multi-row insert instead of a loop. skipDuplicates keeps a duplicate from being fatal
    // even if something upstream lets one through.
    await tx.conversationParticipant.createMany({
      data: participantIds.map((userId) => ({ conversationId: created.id, userId })),
      skipDuplicates: true,
    });
    return { id: created.id, createdAt: created.createdAt ?? new Date() };
  });
}

export async function conversationExists(conversationId: number): Promise<boolean> {
  const row = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true },
  });
  return row !== null;
}

export async function isParticipant(userId: number, conversationId: number): Promise<boolean> {
  const row = await db.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { userId: true },
  });
  return row !== null;
}

export async function conversationIdsOf(userId: number, within?: number[]): Promise<number[]> {
  const rows = await db.conversationParticipant.findMany({
    where: {
      userId,
      ...(within && within.length ? { conversationId: { in: within } } : {}),
    },
    select: { conversationId: true },
  });
  return rows.map((r) => r.conversationId);
}

export async function participantIdsByConversation(
  conversationIds: number[],
): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  if (!conversationIds.length) return result;
  const rows = await db.conversationParticipant.findMany({
    where: { conversationId: { in: conversationIds } },
    select: { conversationId: true, userId: true },
  });
  for (const row of rows) {
    const list = result.get(row.conversationId) ?? [];
    list.push(row.userId);
    result.set(row.conversationId, list);
  }
  return result;
}

export interface ParticipantNameRow {
  conversationId: number;
  id: number;
  name: string;
}

/** The participants of each conversation except `excludeUserId`, with names, ordered by name. */
export async function participantNameRows(
  conversationIds: number[],
  excludeUserId: number,
): Promise<ParticipantNameRow[]> {
  if (!conversationIds.length) return [];
  const rows = await db.conversationParticipant.findMany({
    where: { conversationId: { in: conversationIds }, userId: { not: excludeUserId } },
    select: { conversationId: true, user: { select: { id: true, name: true } } },
    orderBy: { user: { name: 'asc' } },
  });
  return rows.map((r) => ({ conversationId: r.conversationId, id: r.user.id, name: r.user.name }));
}

export async function titlesByIds(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await db.conversation.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, title: true },
  });
  return new Map(rows.map((r) => [r.id, r.title]));
}

/**
 * Moves the unread watermark forward, never back, and returns the current value.
 *
 * Monotonicity is enforced in the WHERE rather than with GREATEST(): only a row whose watermark is
 * behind `messageId` is touched, so applying acknowledgements out of order is safe and idempotent.
 */
export async function advanceReadWatermark(
  userId: number,
  conversationId: number,
  messageId: number,
): Promise<number> {
  await db.conversationParticipant.updateMany({
    where: { conversationId, userId, lastReadMessageId: { lt: messageId } },
    data: { lastReadMessageId: messageId },
  });
  const row = await db.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { lastReadMessageId: true },
  });
  return Number(row?.lastReadMessageId ?? 0);
}

export interface ConversationSummaryRow {
  id: number;
  title: string;
  lastReadMessageId: number;
  messageCount: number;
  unreadCount: number;
  lastMessageId: number | null;
  lastSenderId: number | null;
  lastCreatedAt: Date | null;
  /** The value the inbox is ordered by: last message, or the conversation's own creation. */
  activityAt: Date;
}

interface RawSummaryRow {
  id: number;
  title: string;
  lastReadMessageId: bigint | null;
  messageCount: bigint;
  unreadCount: bigint;
  lastMessageId: bigint | null;
  lastSenderId: number | null;
  lastCreatedAt: Date | null;
  activityAt: Date;
}

/**
 * The inbox rows for one user: one query whose correlated subqueries are index-only scans against
 * idx_messages_conversation, ordered by activity with a keyset cursor.
 *
 * Raw SQL on purpose — this is the documented escape hatch. Prisma's query API cannot express the
 * correlated `MAX(id)` join, the `COALESCE` ordering key, or the row-wise keyset comparison
 * against that key, and splitting it into ORM calls would reintroduce the N+1 this query exists
 * to avoid. Returns `limit + 1` rows so the caller can detect another page without a COUNT.
 */
export async function summaryRows(
  userId: number,
  limit: number,
  cursor?: { activityAt: Date; conversationId: number },
): Promise<ConversationSummaryRow[]> {
  const keyset = cursor
    ? Prisma.sql`AND (COALESCE(lm.created_at, c.created_at) < ${cursor.activityAt}
          OR (COALESCE(lm.created_at, c.created_at) = ${cursor.activityAt} AND c.id < ${cursor.conversationId}))`
    : Prisma.empty;

  const rows = await db.$queryRaw<RawSummaryRow[]>`
    SELECT
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
      ON p.conversation_id = c.id AND p.user_id = ${userId}
    LEFT JOIN messages lm
      ON lm.id = (SELECT MAX(m2.id) FROM messages m2 WHERE m2.conversation_id = c.id)
    WHERE 1 = 1 ${keyset}
    ORDER BY COALESCE(lm.created_at, c.created_at) DESC, c.id DESC
    LIMIT ${limit + 1}`;

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    lastReadMessageId: Number(r.lastReadMessageId ?? 0),
    messageCount: Number(r.messageCount),
    unreadCount: Number(r.unreadCount),
    lastMessageId: r.lastMessageId === null ? null : Number(r.lastMessageId),
    lastSenderId: r.lastSenderId === null ? null : Number(r.lastSenderId),
    lastCreatedAt: r.lastCreatedAt,
    activityAt: r.activityAt,
  }));
}
