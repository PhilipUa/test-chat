import { config } from '../../src/config.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { closeMongo, connectMongo, ensureMongoIndexes } from '../../src/db/mongo.ts';
import { bodyTrigramsOf, tokenizeBody } from '../../src/util/text.ts';
import { closeMysql, db, waitForMysql } from '../../src/db/mysql.ts';
import {
  backfillSearchIndexes,
  countBodies,
  upsertSeedBody,
} from '../../src/repositories/message-bodies.repository.ts';

/**
 * The one idempotent seed for both stores: applies the MySQL migrations, then upserts the demo
 * users, conversations, participants and messages. Replaces the old docker-entrypoint-initdb.d
 * SQL (which only ever ran on a fresh volume) — a `seed` compose run now produces the same demo
 * data on a fresh install and touches nothing on an existing one.
 *
 * Finding H (historical): this used to open with `bodies.deleteMany({})`. Because `seed` is a
 * compose dependency of `api` it runs on *every* `docker compose up`, while MySQL keeps its
 * `messages` rows — so every restart deleted the bodies of everything you'd sent. It has been an
 * insert-if-absent ever since, and stays one here (`createMany skipDuplicates` / empty-update
 * upserts).
 */

const DEMO_USERS = [
  { id: 1, name: 'Alice', email: 'alice@example.com' },
  { id: 2, name: 'Bob', email: 'bob@example.com' },
  { id: 3, name: 'Carol', email: 'carol@example.com' },
  // Dave and Erin exist so the presence tests have identities no other test connects as.
  // Presence is shared, TTL-based state, so a test asserting "X is offline" is otherwise at the
  // mercy of whatever else recently held a socket for X.
  { id: 4, name: 'Dave', email: 'dave@example.com' },
  { id: 5, name: 'Erin', email: 'erin@example.com' },
];

const DEMO_CONVERSATIONS = [
  { id: 1, title: 'Support — order #1042' },
  { id: 2, title: 'Design sync' },
];

const DEMO_PARTICIPANTS = [
  { conversationId: 1, userId: 1 },
  { conversationId: 1, userId: 2 },
  { conversationId: 2, userId: 1 },
  { conversationId: 2, userId: 3 },
];

const DEMO_MESSAGES = [
  { id: 1, conversationId: 1, senderId: 2, body: 'Hi, any update on order #1042?' },
  { id: 2, conversationId: 1, senderId: 1, body: 'Checking now — give me a minute.' },
  { id: 3, conversationId: 2, senderId: 3, body: 'Notes from the design sync are in the doc.' },
];

// Fixed timestamps: re-running the seed shouldn't reorder or "refresh" existing demo messages.
const SEEDED_AT = new Date('2024-01-01T09:00:00.000Z');
const demoCreatedAt = (i: number) => new Date(SEEDED_AT.getTime() + i * 60_000);

await waitForMysql();
await runMigrations();
await connectMongo();
await ensureMongoIndexes();

await db.user.createMany({ data: DEMO_USERS, skipDuplicates: true });
await db.conversation.createMany({ data: DEMO_CONVERSATIONS, skipDuplicates: true });
await db.conversationParticipant.createMany({ data: DEMO_PARTICIPANTS, skipDuplicates: true });
await db.message.createMany({
  data: DEMO_MESSAGES.map((m, i) => ({
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    clientId: null,
    createdAt: demoCreatedAt(i),
  })),
  skipDuplicates: true,
});

for (const [i, m] of DEMO_MESSAGES.entries()) {
  await upsertSeedBody({
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    body: m.body,
    // Signature is recomputed by the app on write; the demo rows only need a placeholder
    // that verifySignature will reject rather than a forged-looking valid one.
    signature: '',
    createdAt: demoCreatedAt(i),
    bodyTokens: tokenizeBody(
      m.body,
      config.search.maxTokenLength,
      config.search.maxTokensPerMessage,
    ),
    bodyTrigrams: bodyTrigramsOf(
      m.body,
      config.search.maxTokenLength,
      config.search.maxTokensPerMessage,
      config.search.maxTrigramsPerMessage,
    ),
  });
}

await backfillSearchIndexes({
  maxTokenLength: config.search.maxTokenLength,
  maxTokens: config.search.maxTokensPerMessage,
  maxTrigrams: config.search.maxTrigramsPerMessage,
});

const total = await countBodies();
console.log(
  `seeded ${DEMO_MESSAGES.length} demo message bodies (${total} total, existing data kept)`,
);

await Promise.allSettled([closeMongo(), closeMysql()]);
process.exit(0);
