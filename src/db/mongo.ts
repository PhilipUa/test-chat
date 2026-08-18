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
  /**
   * Lowercased word tokens from `body`, so a partial-word search can use an index.
   *
   * Mongo's `$text` index only matches whole words, so "desig" finds nothing in "design" — which
   * reads as broken to anyone who expects search-as-you-type. The first fix was an unanchored
   * regex over `body`, but that fetches and tests every document in the caller's conversations:
   * `explain` showed docsExamined 384, nReturned 0. Unbounded read cost per query.
   *
   * An anchored `^prefix` regex against a multikey index on this array is an index range scan
   * instead, so cost tracks the number of *matching* tokens rather than the size of the history.
   */
  bodyTokens?: string[];
}

/**
 * Splits a message body into the tokens stored in `bodyTokens`.
 *
 * Deliberately simple: lowercase, split on anything that isn't a letter or digit, drop empties.
 * Unicode-aware so it doesn't mangle non-Latin text. Long tokens are truncated and the count is
 * capped, so one enormous message can't produce an enormous index entry.
 */
export function tokenizeBody(
  body: string,
  maxTokenLength: number,
  maxTokens: number,
): string[] {
  const seen = new Set<string>();
  for (const raw of body.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    seen.add(raw.slice(0, maxTokenLength));
    if (seen.size >= maxTokens) break;
  }
  return [...seen];
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
    // Multikey index backing indexed prefix search. Compound with conversationId so the scope
    // filter and the prefix range are served by one index.
    { key: { conversationId: 1, bodyTokens: 1 }, name: 'conversation_body_tokens' },
    // Lets search filter by sender without falling back to a scan.
    { key: { conversationId: 1, senderId: 1, _id: -1 }, name: 'conversation_sender' },
  ]);
}

/**
 * Backfills `bodyTokens` for documents written before the field existed.
 *
 * Batched and capped per boot: a migration that rewrites an entire collection while holding up
 * start-up is how a deploy turns into an outage. It's resumable by construction — each run picks
 * up whatever is still missing the field — so several boots converge.
 */
export async function backfillBodyTokens(
  maxTokenLength: number,
  maxTokens: number,
  batchSize = 500,
  maxBatches = 20,
): Promise<number> {
  let updated = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const pending = await messageBodies()
      .find({ bodyTokens: { $exists: false } }, { projection: { body: 1 }, limit: batchSize })
      .toArray();
    if (!pending.length) break;

    const ops = pending.map((doc) => ({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { bodyTokens: tokenizeBody(doc.body ?? '', maxTokenLength, maxTokens) } },
      },
    }));
    const res = await messageBodies().bulkWrite(ops, { ordered: false });
    updated += res.modifiedCount ?? 0;
    if (pending.length < batchSize) break;
  }
  if (updated) console.log(`[migrate:mongo] backfilled bodyTokens on ${updated} message(s)`);
  return updated;
}

export async function closeMongo(): Promise<void> {
  await client.close();
}
