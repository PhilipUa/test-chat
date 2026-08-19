import { isDuplicateKeyError } from '../db/mysql.ts';
import { bodiesByIds } from '../repositories/message-bodies.repository.ts';
import { pageRows } from '../repositories/messages.repository.ts';
import { findBody, findRowByClientId, insertMessage, type MessageRow } from './message-store.ts';

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
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    body,
    clientId: row.clientId,
    createdAt: row.createdAt.toISOString(),
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
    const existing = await findExisting(conversationId, clientId, { senderId, body });
    if (existing) return { message: existing, deduplicated: true };
  }

  const createdAt = new Date();

  let stored;
  try {
    stored = await insertMessage({ conversationId, senderId, body, clientId, createdAt });
  } catch (err) {
    if (clientId && isDuplicateKeyError(err)) {
      const existing = await findExisting(conversationId, clientId, { senderId, body });
      if (existing) return { message: existing, deduplicated: true };
    }
    throw err;
  }

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

/**
 * The message already stored under `clientId`, if any.
 *
 * `pending` is the send that is being deduplicated — its body is the fallback for the window where
 * the winning request has committed its MySQL row but not yet written the Mongo body. Reporting the
 * empty string there is worse than it looks: the client renders the blank bubble *and* records the
 * id, so the winner's broadcast is deduplicated away and the message stays blank until a reload.
 */
async function findExisting(
  conversationId: number,
  clientId: string,
  pending?: { senderId: number; body: string },
): Promise<Message | null> {
  const row = await findRowByClientId(conversationId, clientId);
  if (!row) return null;

  const body = await settledBody(row.id);
  if (body) return toMessage(row, body);

  // Same sender and same idempotency key: this is a retry of the send we are holding, so its body is
  // the honest answer. Without a match we have nothing better than the empty string.
  if (pending && row.senderId === pending.senderId) return toMessage(row, pending.body);
  return toMessage(row, '');
}

/**
 * Reads a body, giving a concurrent two-store write a moment to finish.
 *
 * Only reached when the first read came back empty, which is either the millisecond-wide window
 * between the MySQL and Mongo writes or a genuinely bodyless row. Bounded, so a bodyless row costs a
 * fixed delay rather than hanging the request.
 */
async function settledBody(id: number, attempts = 3, delayMs = 25): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const body = await findBody(id);
    if (body) return body;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return '';
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
  // `limit` arrives already defaulted and clamped by the route schema — the one place page-size
  // policy lives.
  opts: { limit: number; before?: number; since?: number },
): Promise<MessagePage> {
  const { limit } = opts;
  const forwards = opts.since !== undefined;
  // limit + 1 rows tell us whether there is another page without a second COUNT query.
  const rows = await pageRows(conversationId, {
    forwards,
    cursorId: forwards ? opts.since : opts.before,
    limit,
  });

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  // Always hand back oldest -> newest for rendering. Forwards queries already are.
  const page = forwards ? trimmed : trimmed.reverse();

  const bodyById = await bodiesByIds(page.map((r) => r.id));

  return {
    messages: page.map((r) => toMessage(r, bodyById.get(r.id) ?? '')),
    // Null unless there is genuinely an older page: it used to be the oldest id on the page even at
    // the start of history, contradicting its own contract. Meaningless walking forwards, where
    // `latestId` is the cursor.
    nextBefore: !forwards && hasMore && page.length ? page[0].id : null,
    hasMore,
    latestId: page.length ? page[page.length - 1].id : null,
  };
}
