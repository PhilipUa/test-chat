import { MongoClient, type Collection, type Db } from 'mongodb';
import { config } from '../config.ts';

/** The Mongo half of a message: the body itself, keyed by the MySQL message id. */
export interface MessageBody {
  _id: number;
  conversationId: number;
  senderId: number;
  body: string;
  signature: string;
  createdAt: Date;
}

const client = new MongoClient(config.mongoUrl, {
  serverSelectionTimeoutMS: 5_000,
});
let db: Db | undefined;

export async function connectMongo(retries = 20): Promise<Db> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      await client.connect();
      // `connect()` resolves optimistically, so confirm we can actually talk to the server.
      await client.db().command({ ping: 1 });
      db = client.db();
      return db;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`mongo not reachable: ${lastErr}`);
}

export function mongo(): Db {
  if (!db) throw new Error('mongo not connected');
  return db;
}

export function messageBodies(): Collection<MessageBody> {
  return mongo().collection<MessageBody>('message_bodies');
}

/**
 * Idempotent — Mongo ignores a createIndex for an index that already exists with the same spec.
 * The text index is what makes GET /api/search possible (tasks/search.md); without it a text
 * query is an error rather than a slow query.
 */
export async function ensureMongoIndexes(): Promise<void> {
  await messageBodies().createIndexes([
    { key: { body: 'text' }, name: 'body_text', default_language: 'english' },
    // Search and the conversation-list body lookup both filter by conversation.
    { key: { conversationId: 1, _id: -1 }, name: 'conversation_recent' },
  ]);
}

export async function closeMongo(): Promise<void> {
  await client.close();
}
