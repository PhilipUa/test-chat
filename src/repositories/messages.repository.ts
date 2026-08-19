import { db } from '../db/mysql.ts';

/**
 * Data access for `messages` rows — the MySQL half of a message (id, ordering, idempotency key).
 * The body lives in Mongo (message-bodies.repository.ts). No business logic here: the two-store
 * write ordering and its compensation live in services/message-store.ts, pagination policy in
 * services/messages.ts.
 *
 * Ids are BIGINT and come back from Prisma as `bigint`; they are converted to `number` at this
 * boundary — every id in this app is far below 2^53, and the JSON the API hands out is numeric.
 */

export interface MessageRow {
  id: number;
  conversationId: number;
  senderId: number;
  clientId: string | null;
  createdAt: Date;
}

interface RawRow {
  id: bigint;
  conversationId: number;
  senderId: number;
  clientId: string | null;
  createdAt: Date;
}

const toRow = (r: RawRow): MessageRow => ({
  id: Number(r.id),
  conversationId: r.conversationId,
  senderId: r.senderId,
  clientId: r.clientId,
  createdAt: r.createdAt,
});

export async function insertRow(input: {
  conversationId: number;
  senderId: number;
  clientId: string | null;
  createdAt: Date;
}): Promise<MessageRow> {
  return toRow(await db.message.create({ data: input }));
}

/** Best-effort delete — used by the compensation path, so it must not throw on a missing row. */
export async function deleteRow(id: number): Promise<void> {
  await db.message.deleteMany({ where: { id } });
}

export async function findRowByClientId(
  conversationId: number,
  clientId: string,
): Promise<MessageRow | undefined> {
  const row = await db.message.findUnique({
    where: { conversationId_clientId: { conversationId, clientId } },
  });
  return row ? toRow(row) : undefined;
}

/**
 * One keyset page of a conversation's rows, in query order (the caller decides presentation
 * order). `limit + 1` rows tell the caller whether there is another page without a COUNT query.
 */
export async function pageRows(
  conversationId: number,
  opts: { forwards: boolean; cursorId?: number; limit: number },
): Promise<MessageRow[]> {
  const { forwards, cursorId, limit } = opts;
  const rows = await db.message.findMany({
    where: {
      conversationId,
      ...(cursorId !== undefined ? { id: forwards ? { gt: cursorId } : { lt: cursorId } } : {}),
    },
    orderBy: { id: forwards ? 'asc' : 'desc' },
    take: limit + 1,
  });
  return rows.map(toRow);
}
