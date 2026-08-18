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
import { closeMysql, pool, waitForMysql } from '../src/db/mysql.ts';
import {
  closeMongo,
  connectMongo,
  ensureMongoIndexes,
  messageBodies,
  tokenizeBody,
} from '../src/db/mongo.ts';

const CONVERSATIONS = Number(process.argv[2] || 30);
const PER_CONVERSATION = Number(process.argv[3] || 60);

const SUBJECTS = [
  'the migration', 'onboarding', 'the design review', 'invoice 4471', 'the staging deploy',
  'quarterly planning', 'the flaky test', 'customer feedback', 'the API rewrite', 'pricing',
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

const [users] = await pool.query<any[]>('SELECT id FROM users ORDER BY id');
const userIds = users.map((u) => Number(u.id));
if (userIds.length < 2) throw new Error('need at least two seeded users');

console.log(`generating ${CONVERSATIONS} conversations x ${PER_CONVERSATION} messages…`);
let totalMessages = 0;

for (let c = 0; c < CONVERSATIONS; c++) {
  const subject = SUBJECTS[c % SUBJECTS.length];
  const [created] = await pool.execute<any>('INSERT INTO conversations (title) VALUES (?)', [
    `${subject} — thread ${c + 1}`,
  ]);
  const conversationId = Number(created.insertId);

  await pool.query(
    `INSERT IGNORE INTO conversation_participants (conversation_id, user_id) VALUES ${userIds
      .map(() => '(?, ?)')
      .join(', ')}`,
    userIds.flatMap((uid) => [conversationId, uid]),
  );

  const rows: unknown[][] = [];
  const docs: any[] = [];
  const baseTime = Date.now() - (CONVERSATIONS - c) * 3_600_000;

  for (let m = 0; m < PER_CONVERSATION; m++) {
    const senderId = userIds[m % userIds.length]!;
    const createdAt = new Date(baseTime + m * 60_000);
    const body = `${PHRASES[(c + m) % PHRASES.length]} (re: ${subject})`;
    rows.push([conversationId, senderId, null, createdAt]);
    docs.push({ conversationId, senderId, body, createdAt });
  }

  // One multi-row insert, then read the id range back — the ids must match the Mongo _ids.
  const [res] = await pool.query<any>(
    `INSERT INTO messages (conversation_id, sender_id, client_id, created_at) VALUES ${rows
      .map(() => '(?, ?, ?, ?)')
      .join(', ')}`,
    rows.flat(),
  );
  const firstId = Number(res.insertId);

  await messageBodies().insertMany(
    docs.map((d, i) => ({
      _id: firstId + i,
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
    })),
    { ordered: false },
  );

  await pool.execute('UPDATE conversations SET last_message_at = ? WHERE id = ?', [
    docs[docs.length - 1]!.createdAt,
    conversationId,
  ]);
  totalMessages += docs.length;
}

console.log(`inserted ${totalMessages} messages across ${CONVERSATIONS} conversations`);
await Promise.allSettled([closeMongo(), closeMysql()]);
process.exit(0);
