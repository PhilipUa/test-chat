import { config } from '../config.ts';
import { messageBodies, tokenizeBody } from '../db/mongo.ts';
import { isDuplicateKeyError, queryOne, runWrite } from '../db/mysql.ts';
import { sign } from './message-signing.ts';

/**
 * The dual-store write: MySQL holds a message's id and ordering, Mongo holds its text.
 *
 * This is the delicate part of sending a message, and it used to be interleaved with idempotency,
 * rate-limit bookkeeping and the conversation timestamp touch inside one function. It's isolated
 * here because it's the code whose failure modes need reading carefully, and because it's the seam
 * that changes if the split-store design is ever revisited (docs/04-tradeoffs.md).
 *
 * There is no transaction across two databases, so the order of operations *is* the correctness
 * story: MySQL first (it issues the id), then Mongo, and on a Mongo failure delete the MySQL row —
 * because a message row with no body renders as an empty string forever.
 *
 * Residual risk: if the process dies between the two writes the compensating delete never runs and
 * a bodyless row survives. The window is milliseconds rather than "any Mongo failure, permanently";
 * closing it properly wants an outbox.
 */

/** Row shape shared by the queries here and in messages.ts. */
export interface MessageRow {
  id: number;
  conversationId: number;
  senderId: number;
  clientId: string | null;
  createdAt: Date;
}

const SELECT_COLUMNS = `id, conversation_id AS conversationId, sender_id AS senderId,
       client_id AS clientId, created_at AS createdAt`;

export interface StoredMessage {
  id: number;
  createdAt: Date;
}

/** Writes to both stores, or leaves neither behind. Throws if the body could not be stored. */
export async function insertMessage(input: {
  conversationId: number;
  senderId: number;
  body: string;
  clientId: string | null;
  createdAt: Date;
}): Promise<StoredMessage> {
  const { conversationId, senderId, body, clientId, createdAt } = input;

  const res = await runWrite(
    `INSERT INTO messages (conversation_id, sender_id, client_id, created_at)
     VALUES (?, ?, ?, ?)`,
    [conversationId, senderId, clientId, createdAt],
  );
  const id = Number(res.insertId);

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

  return { id, createdAt };
}

/** Looks up a message by its client-supplied idempotency key. */
export async function findRowByClientId(
  conversationId: number,
  clientId: string,
): Promise<MessageRow | undefined> {
  return queryOne<MessageRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM messages WHERE conversation_id = ? AND client_id = ? LIMIT 1`,
    [conversationId, clientId],
  );
}

export async function findBody(id: number): Promise<string> {
  const doc = await messageBodies().findOne({ _id: id }, { projection: { body: 1 } });
  return doc?.body ?? '';
}

/**
 * Best-effort: keeps the inbox orderable by recency without scanning `messages`. A failure here
 * only affects sort order, so it must never fail a send that already succeeded.
 */
export async function touchConversation(conversationId: number, at: Date): Promise<void> {
  await runWrite('UPDATE conversations SET last_message_at = ? WHERE id = ?', [
    at,
    conversationId,
  ]).catch(() => {});
}

export { SELECT_COLUMNS, isDuplicateKeyError };
