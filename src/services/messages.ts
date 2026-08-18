import { config } from '../config.ts';
import { messageBodiesById } from '../db/mongo.ts';
import { isDuplicateKeyError, queryRows } from '../db/mysql.ts';
import {
  SELECT_COLUMNS,
  findBody,
  findRowByClientId,
  insertMessage,
  touchConversation,
  type MessageRow,
} from './message-store.ts';

export { verifySignature } from './message-signing.ts';

export interface NewMessage {
  conversationId: number;
  senderId: number;
  body: string;
  clientId: string | null;
}

export interface Message {
  id: number;
  conversationId: number;
  senderId: number;
  body: string;
  clientId: string | null;
  createdAt: string;
}

export interface CreateResult {
  message: Message;
  /** True when an existing message was returned instead of a new one being written. */
  deduplicated: boolean;
}

/**
 * The single row -> Message mapping. The body comes from Mongo, hence the second argument.
 */
function toMessage(row: MessageRow, body: string): Message {
  return {
    id: Number(row.id),
    conversationId: Number(row.conversationId),
    senderId: Number(row.senderId),
    body,
    clientId: row.clientId,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

/**
 * Sending a message: the policy, reading top to bottom.
 *
 * The mechanics live in message-store.ts (the two-store write and its compensation) and
 * message-signing.ts. What's left here is the decision sequence:
 *
 *  1. If this clientId was already used, return the existing message — a retried send is free
 *     rather than a duplicate. The `messages` table has a unique index on
 *     (conversation_id, client_id) to enforce it.
 *  2. Write to both stores under one timestamp, so the two never disagree about when a message
 *     was sent (they used to: the response used the app clock, a later GET used MySQL's column).
 *  3. A concurrent identical send loses the race on the unique index; catch that and return the
 *     winner, so three simultaneous identical sends yield one message.
 */
export async function createMessage(input: NewMessage): Promise<CreateResult> {
  const { conversationId, senderId, body, clientId } = input;

  if (clientId) {
    const existing = await findExisting(conversationId, clientId);
    if (existing) return { message: existing, deduplicated: true };
  }

  const createdAt = new Date();

  let stored;
  try {
    stored = await insertMessage({ conversationId, senderId, body, clientId, createdAt });
  } catch (err) {
    if (clientId && isDuplicateKeyError(err)) {
      const existing = await findExisting(conversationId, clientId);
      if (existing) return { message: existing, deduplicated: true };
    }
    throw err;
  }

  await touchConversation(conversationId, createdAt);

  return {
    message: {
      id: stored.id,
      conversationId,
      senderId,
      body,
      clientId,
      createdAt: createdAt.toISOString(),
    },
    deduplicated: false,
  };
}

async function findExisting(conversationId: number, clientId: string): Promise<Message | null> {
  const row = await findRowByClientId(conversationId, clientId);
  if (!row) return null;
  return toMessage(row, await findBody(Number(row.id)));
}

export interface MessagePage {
  messages: Message[];
  /** Id to pass as `before` to fetch the previous page; null when at the start. */
  nextBefore: number | null;
  hasMore: boolean;
  /** Highest id in this page, for a client tracking what it has seen. */
  latestId: number | null;
}

/**
 * A page of a conversation's messages.
 *
 * Keyset pagination on the primary key rather than OFFSET: it stays O(page) however deep you scroll,
 * and it can't skip or repeat a row when new messages arrive mid-scroll. This used to have no LIMIT
 * at all, so opening a conversation fetched every message ever sent in it from both stores.
 *
 * `since` walks *forwards* — the catch-up direction. Realtime fan-out over Redis pub/sub is
 * at-most-once, so anything published while an instance was disconnected from Redis is gone and the
 * client's socket never noticed. This is how a client recovers exactly what it missed.
 */
export async function listMessages(
  conversationId: number,
  opts: { limit?: number; before?: number; since?: number } = {},
): Promise<MessagePage> {
  const limit = Math.min(opts.limit ?? config.messages.defaultPageSize, config.messages.maxPageSize);

  const params: unknown[] = [conversationId];
  const forwards = opts.since !== undefined;
  let cursor = '';
  if (forwards) {
    cursor = 'AND id > ?';
    params.push(opts.since);
  } else if (opts.before !== undefined) {
    cursor = 'AND id < ?';
    params.push(opts.before);
  }

  // limit + 1 tells us whether there is another page without a second COUNT query.
  const rows = await queryRows<MessageRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM messages
     WHERE conversation_id = ? ${cursor}
     ORDER BY id ${forwards ? 'ASC' : 'DESC'}
     LIMIT ${limit + 1}`,
    params,
  );

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  // Always hand back oldest -> newest for rendering. Forwards queries already are.
  const page = forwards ? trimmed : trimmed.reverse();

  const bodyById = await messageBodiesById(page.map((r) => Number(r.id)));

  return {
    messages: page.map((r) => toMessage(r, bodyById.get(Number(r.id)) ?? '')),
    nextBefore: page.length ? Number(page[0]!.id) : null,
    hasMore,
    latestId: page.length ? Number(page[page.length - 1]!.id) : null,
  };
}
