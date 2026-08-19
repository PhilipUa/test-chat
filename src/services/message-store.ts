import { config } from '../config.ts';
import { bodyTrigramsOf, tokenizeBody } from '../util/text.ts';
import { insertBody } from '../repositories/message-bodies.repository.ts';
import { deleteRow, insertRow, type MessageRow } from '../repositories/messages.repository.ts';
import { sign } from './message-signing.ts';

/**
 * The dual-store write: MySQL holds a message's id and ordering, Mongo holds its text.
 *
 * This is the delicate part of sending a message, and it used to be interleaved with idempotency and
 * rate-limit bookkeeping inside one function. It's isolated here because it's the code whose failure
 * modes need reading carefully, and because it's the seam that changes if the split-store design is
 * ever revisited (docs/04-tradeoffs.md).
 *
 * There is no transaction across two databases, so the order of operations *is* the correctness
 * story: MySQL first (it issues the id), then Mongo, and on a Mongo failure delete the MySQL row —
 * because a message row with no body renders as an empty string forever. That ordering is business
 * logic, which is why it lives here and not in a repository.
 *
 * Residual risk: if the process dies between the two writes the compensating delete never runs and
 * a bodyless row survives. The window is milliseconds rather than "any Mongo failure, permanently";
 * closing it properly wants an outbox.
 */

/**
 * Re-exported, not wrapped: this module is the seam the rest of the domain reads the split store
 * through (so nothing above it imports two repositories to assemble one message), and a forwarding
 * function body would add an indirection without adding a decision.
 */
export { findRowByClientId } from '../repositories/messages.repository.ts';
export { findBody } from '../repositories/message-bodies.repository.ts';
export type { MessageRow };

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

  const row = await insertRow({ conversationId, senderId, clientId, createdAt });

  try {
    await insertBody({
      id: row.id,
      conversationId,
      senderId,
      body,
      signature: sign(body),
      createdAt,
      // Written at insert time so partial-word and fuzzy search are index range scans rather than
      // collection scans. See prisma/mongo/schema.prisma.
      bodyTokens: tokenizeBody(
        body,
        config.search.maxTokenLength,
        config.search.maxTokensPerMessage,
      ),
      bodyTrigrams: bodyTrigramsOf(
        body,
        config.search.maxTokenLength,
        config.search.maxTokensPerMessage,
        config.search.maxTrigramsPerMessage,
      ),
    });
  } catch (err) {
    await deleteRow(row.id).catch((cleanupErr) =>
      console.error(`[messages] failed to roll back message ${row.id}:`, cleanupErr),
    );
    throw err;
  }

  return { id: row.id, createdAt };
}
