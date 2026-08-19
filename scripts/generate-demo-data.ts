/**
 * Bulk-loads demo messages, for looking at search and pagination with something more than three
 * rows in the database.
 *
 * Writes to MySQL and Mongo directly rather than through the API, for two reasons: sends are rate
 * limited (correctly — that's the feature), and bulk loading through HTTP one message at a time is
 * the wrong tool. It reuses the app's own tokenizer so the generated rows are indexed exactly like
 * real ones.
 *
 * Usage: docker compose exec api npx tsx scripts/generate-demo-data.ts [conversations] [perConversation]
 */
import { config } from '../src/config.ts';
import { Prisma, closeMysql, db, waitForMysql } from '../src/db/mysql.ts';
import { closeMongo, connectMongo, ensureMongoIndexes, mongoDb } from '../src/db/mongo.ts';
import { bodyTrigramsOf, tokenizeBody } from '../src/util/text.ts';

const CONVERSATIONS = Number(process.argv[2] || 30);
const PER_CONVERSATION = Number(process.argv[3] || 60);

const SUBJECTS = [
  'the migration',
  'onboarding',
  'the design review',
  'invoice 4471',
  'the staging deploy',
  'quarterly planning',
  'the flaky test',
  'customer feedback',
  'the API rewrite',
  'pricing',
];
const PHRASES = [
  'can you take a look when you get a chance',
  'I pushed a fix, should be green now',
  'notes are in the shared doc',
  'let us move this to tomorrow morning',
  'confirmed with the customer, we are good to ship',
  'still reproducing intermittently on staging',
  'approved — nice work on this',
  'blocked on the credentials, chasing it',
  'rolled back for now, investigating',
  'scheduling a follow up for next week',
];

await waitForMysql();
await connectMongo();
await ensureMongoIndexes();

const users = await db.user.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
const userIds = users.map((u) => u.id);
if (userIds.length < 2) throw new Error('need at least two seeded users');

console.log(`generating ${CONVERSATIONS} conversations x ${PER_CONVERSATION} messages…`);
let totalMessages = 0;

for (let c = 0; c < CONVERSATIONS; c++) {
  const subject = SUBJECTS[c % SUBJECTS.length];
  const conversation = await db.conversation.create({
    data: { title: `${subject} — thread ${c + 1}` },
    select: { id: true },
  });
  const conversationId = conversation.id;

  await db.conversationParticipant.createMany({
    data: userIds.map((userId) => ({ conversationId, userId })),
    skipDuplicates: true,
  });

  const docs: { conversationId: number; senderId: number; body: string; createdAt: Date }[] = [];
  // Space conversations by their own length, so the newest message always lands in the past.
  // Fixed 1-hour spacing put messages in the future once a conversation held more than 60 of them
  // (one per minute), which showed up as an inbox sorted by a timestamp that hadn't happened yet.
  const spacingMs = PER_CONVERSATION * 60_000;
  const baseTime = Date.now() - (CONVERSATIONS - c) * spacingMs;

  for (let m = 0; m < PER_CONVERSATION; m++) {
    const senderId = userIds[m % userIds.length];
    const createdAt = new Date(baseTime + m * 60_000);
    const body = `${PHRASES[(c + m) % PHRASES.length]} (re: ${subject})`;
    docs.push({ conversationId, senderId, body, createdAt });
  }

  // One multi-row insert, then read the first generated id back — the ids must match the Mongo
  // _ids, and MySQL guarantees a multi-row insert's ids are contiguous starting at
  // LAST_INSERT_ID(). Raw because createMany doesn't return ids; the interactive transaction pins
  // one connection so LAST_INSERT_ID() is this insert's.
  const firstId = await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO messages (conversation_id, sender_id, client_id, created_at)
      VALUES ${Prisma.join(
        docs.map((d) => Prisma.sql`(${d.conversationId}, ${d.senderId}, NULL, ${d.createdAt})`),
      )}`;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`SELECT LAST_INSERT_ID() AS id`;
    return Number(rows[0]?.id ?? 0);
  });
  if (!firstId) throw new Error('could not read back the inserted message id range');

  await mongoDb.messageBody.createMany({
    data: docs.map((d, i) => ({
      id: firstId + i,
      conversationId: d.conversationId,
      senderId: d.senderId,
      body: d.body,
      signature: '',
      createdAt: d.createdAt,
      bodyTokens: tokenizeBody(
        d.body,
        config.search.maxTokenLength,
        config.search.maxTokensPerMessage,
      ),
      bodyTrigrams: bodyTrigramsOf(
        d.body,
        config.search.maxTokenLength,
        config.search.maxTokensPerMessage,
        config.search.maxTrigramsPerMessage,
      ),
    })),
  });

  totalMessages += docs.length;
}

console.log(`inserted ${totalMessages} messages across ${CONVERSATIONS} conversations`);
await Promise.allSettled([closeMongo(), closeMysql()]);
process.exit(0);
