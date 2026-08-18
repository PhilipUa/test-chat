import crypto from 'node:crypto';
import { config } from '../config.ts';
import { isDuplicateKeyError, queryOne, queryRows, runWrite } from '../db/mysql.ts';
import { messageBodies, messageBodiesById, tokenizeBody } from '../db/mongo.ts';

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

/**
 * A `messages` row as selected by the queries below. Column aliases are chosen to match the
 * `Message` field names, so `toMessage` is a straight copy plus the body from Mongo.
 */
interface MessageRow {
  id: number;
  conversationId: number;
  senderId: number;
  clientId: string | null;
  createdAt: Date;
}

/**
 * The single row -> Message mapping.
 *
 * This was written out twice in this file, 76 lines apart, field for field — so a new field would
 * have had to be remembered in both. The body comes from Mongo, hence the second argument.
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

export interface CreateResult {
  message: Message;
  /** True when an existing message was returned instead of a new one being written. */
  deduplicated: boolean;
}

/**
 * Finding B: this was `crypto.pbkdf2Sync(body, 'relay-signing', 200000, 32, 'sha256')`.
 *
 * Two problems. It cost 20ms of *blocked event loop* per message, which is why an unrelated GET
 * went from 4ms to 790ms during a send burst. And it was the wrong primitive: pbkdf2 is a
 * password-stretching KDF, the "salt" was a hard-coded constant, and there was no secret — so
 * anyone could recompute a valid signature for a tampered body. It bought nothing.
 *
 * A keyed HMAC is what "detect tampering" actually calls for. Microseconds, and it needs the key.
 */
function sign(body: string): string {
  return crypto.createHmac('sha256', config.messageSigningKey).update(body).digest('hex');
}

export function verifySignature(body: string, signature: string): boolean {
  const expected = sign(body);
  // Constant-time compare, or the check leaks the signature a byte at a time.
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

/**
 * Writes a message across both stores.
 *
 * Findings D and I. MySQL holds the id and ordering, Mongo holds the body, and there is no
 * transaction spanning the two — so the order of operations and the failure handling *are* the
 * correctness story:
 *
 *  1. Look for an existing row with this (conversationId, clientId) and return it if present, so
 *     a retried send is free rather than a duplicate.
 *  2. Insert the MySQL row. A concurrent identical send loses this on the unique index; we catch
 *     that and read back the winner.
 *  3. Insert the body into Mongo. If that fails, delete the MySQL row we just wrote, because a
 *     message row with no body renders as an empty string forever.
 *
 * Residual risk: if the process dies between 2 and 3 the compensating delete never runs and we
 * keep a bodyless row. Reconciling that properly wants an outbox — noted in docs/04-tradeoffs.md.
 * The window is now milliseconds rather than a permanent hole in the write path.
 */
export async function createMessage(input: NewMessage): Promise<CreateResult> {
  const { conversationId, senderId, body, clientId } = input;

  if (clientId) {
    const existing = await findByClientId(conversationId, clientId);
    if (existing) return { message: existing, deduplicated: true };
  }

  // Finding M: one timestamp, generated once, stored in both places. Previously the POST
  // response used the app clock and a later GET returned MySQL's second-precision column, so a
  // single message had two different createdAt values.
  const createdAt = new Date();

  let id: number;
  try {
    const res = await runWrite(
      `INSERT INTO messages (conversation_id, sender_id, client_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [conversationId, senderId, clientId, createdAt],
    );
    id = Number(res.insertId);
  } catch (err) {
    if (clientId && isDuplicateKeyError(err)) {
      // Two identical sends raced. The other one won; return its row.
      const existing = await findByClientId(conversationId, clientId);
      if (existing) return { message: existing, deduplicated: true };
    }
    throw err;
  }

  try {
    await messageBodies().insertOne({
      _id: id,
      conversationId,
      senderId,
      body,
      signature: sign(body),
      createdAt,
      // Written at insert time so partial-word search is an index range scan rather than a
      // collection scan. See MessageBody.bodyTokens.
      bodyTokens: tokenizeBody(
        body,
        config.search.maxTokenLength,
        config.search.maxTokensPerMessage,
      ),
    });
  } catch (err) {
    await runWrite('DELETE FROM messages WHERE id = ?', [id]).catch((cleanupErr) =>
      console.error(`[messages] failed to roll back message ${id}:`, cleanupErr),
    );
    throw err;
  }

  // Keeps the inbox orderable by recency without scanning `messages`. Best-effort: a failure
  // here only affects sort order, so it must not fail a send that already succeeded.
  await runWrite('UPDATE conversations SET last_message_at = ? WHERE id = ?', [
    createdAt,
    conversationId,
  ]).catch(() => {});

  return {
    message: {
      id,
      conversationId,
      senderId,
      body,
      clientId,
      createdAt: createdAt.toISOString(),
    },
    deduplicated: false,
  };
}

async function findByClientId(
  conversationId: number,
  clientId: string,
): Promise<Message | null> {
  const row = await queryOne<MessageRow>(
    `SELECT id, conversation_id AS conversationId, sender_id AS senderId,
            client_id AS clientId, created_at AS createdAt
     FROM messages WHERE conversation_id = ? AND client_id = ? LIMIT 1`,
    [conversationId, clientId],
  );
  if (!row) return null;

  const doc = await messageBodies().findOne({ _id: Number(row.id) }, { projection: { body: 1 } });
  return toMessage(row, doc?.body ?? '');
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
 * Finding J: this used to be `SELECT ... ORDER BY id ASC` with no LIMIT, so opening a
 * conversation fetched every message ever sent in it from both stores.
 *
 * Keyset pagination on the primary key rather than OFFSET: it stays O(page) however deep you
 * scroll, and it can't skip or repeat a row when new messages arrive mid-scroll. We fetch the
 * newest page by default (what a chat window opens to) and return it in ascending order for
 * rendering.
 */
export async function listMessages(
  conversationId: number,
  opts: { limit?: number; before?: number; since?: number } = {},
): Promise<MessagePage> {
  const limit = Math.min(opts.limit ?? config.messages.defaultPageSize, config.messages.maxPageSize);

  const params: unknown[] = [conversationId];

  // `since` walks *forwards* from a known id — the catch-up direction. Realtime fan-out over
  // Redis pub/sub is at-most-once, so anything published while an instance was disconnected from
  // Redis is simply gone, and the client's WebSocket never noticed. This is how a client recovers
  // exactly what it missed instead of refetching a whole conversation.
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
    `SELECT id, conversation_id AS conversationId, sender_id AS senderId,
            client_id AS clientId, created_at AS createdAt
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
