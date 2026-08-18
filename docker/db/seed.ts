import {
  backfillBodyTokens,
  closeMongo,
  connectMongo,
  ensureMongoIndexes,
  messageBodies,
  tokenizeBody,
} from '../../src/db/mongo.ts';
import { closeMysql, pool, waitForMysql } from '../../src/db/mysql.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { config } from '../../src/config.ts';

/**
 * Seeds the Mongo half of the demo messages, and applies the MySQL schema migrations.
 *
 * Finding H: this used to open with `bodies.deleteMany({})`. Because `seed` is a compose
 * dependency of `api` it runs on *every* `docker compose up`, while MySQL keeps its `messages`
 * rows — so every restart deleted the bodies of everything you'd sent and left the rows behind.
 * `GET /api/messages` falls back to `''` for a missing body, so the symptom was every message in
 * your history silently going blank. Reproduced at 64 of 66 messages.
 *
 * It's now an idempotent upsert of exactly the three demo documents, touching nothing else.
 */

const DEMO_BODIES = [
  { _id: 1, conversationId: 1, senderId: 2, body: 'Hi, any update on order #1042?' },
  { _id: 2, conversationId: 1, senderId: 1, body: 'Checking now — give me a minute.' },
  { _id: 3, conversationId: 2, senderId: 3, body: 'Notes from the design sync are in the doc.' },
];

// Fixed timestamps: re-running the seed shouldn't reorder or "refresh" existing demo messages.
const SEEDED_AT = new Date('2024-01-01T09:00:00.000Z');

await waitForMysql();
await runMigrations();
await connectMongo();
await ensureMongoIndexes();

const bodies = messageBodies();
for (const [i, doc] of DEMO_BODIES.entries()) {
  await bodies.updateOne(
    { _id: doc._id },
    {
      $setOnInsert: {
        ...doc,
        // Signature is recomputed by the app on write; the demo rows only need a placeholder
        // that verifySignature will reject rather than a forged-looking valid one.
        signature: '',
        createdAt: new Date(SEEDED_AT.getTime() + i * 60_000),
        bodyTokens: tokenizeBody(
          doc.body,
          config.search.maxTokenLength,
          config.search.maxTokensPerMessage,
        ),
      },
    },
    { upsert: true },
  );
}

await backfillBodyTokens(config.search.maxTokenLength, config.search.maxTokensPerMessage);

const total = await bodies.countDocuments();
console.log(`seeded ${DEMO_BODIES.length} demo message bodies (${total} total, existing data kept)`);

await Promise.allSettled([closeMongo(), closeMysql()]);
process.exit(0);
