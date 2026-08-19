import { PrismaClient } from '../generated/prisma-mongo/index.js';

/**
 * The Mongo Prisma client and its lifecycle.
 *
 * All document access lives in src/repositories/message-bodies.repository.ts — this module owns
 * the connection, the shutdown, the index set, and the tokenizer both the write path and the
 * backfill share.
 */
export const mongoDb = new PrismaClient();

export async function connectMongo(retries = 20): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      // $connect resolves optimistically, so confirm we can actually talk to the server.
      await mongoDb.$runCommandRaw({ ping: 1 });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`mongo not reachable: ${String(lastErr)}`, { cause: lastErr });
}

/**
 * Idempotent — Mongo ignores a createIndex for an index that already exists with the same spec.
 *
 * Raw on purpose, and not `prisma db push`: Prisma's schema DSL cannot declare a `$text` index
 * (which is what makes GET /api/search possible — without it a text query is an error rather than
 * a slow query), so the index set lives here in one place instead of being split across two.
 */
export async function ensureMongoIndexes(): Promise<void> {
  await mongoDb.$runCommandRaw({
    createIndexes: 'message_bodies',
    indexes: [
      { key: { body: 'text' }, name: 'body_text', default_language: 'english' },
      // Search and the conversation-list body lookup both filter by conversation.
      { key: { conversationId: 1, _id: -1 }, name: 'conversation_recent' },
      // Multikey index backing indexed prefix search. Compound with conversationId so the scope
      // filter and the prefix range are served by one index.
      { key: { conversationId: 1, bodyTokens: 1 }, name: 'conversation_body_tokens' },
      // The same shape for fuzzy matching: a typo'd query looks its trigrams up here instead of
      // examining documents. Denser than bodyTokens, which is why its per-message cap is separate.
      { key: { conversationId: 1, bodyTrigrams: 1 }, name: 'conversation_body_trigrams' },
      // Lets search filter by sender without falling back to a scan.
      { key: { conversationId: 1, senderId: 1, _id: -1 }, name: 'conversation_sender' },
    ],
  });
}

export async function closeMongo(): Promise<void> {
  await mongoDb.$disconnect();
}
