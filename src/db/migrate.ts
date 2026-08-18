import { exists as rowExists, pool, queryOne, queryRows, runWrite } from './mysql.ts';

/**
 * Tiny forward-only migration runner.
 *
 * `docker/db/mysql.sql` only executes on a *fresh* MySQL volume, so schema changes never reach
 * an existing install — anyone who had the app running before would silently keep the old
 * schema, missing indexes and all. These run on every boot instead, and each one is written to
 * be safe to re-run. Concurrent instances racing to apply the same DDL is handled by taking a
 * named lock first, so `--scale api=3` boots cleanly.
 */

interface Migration {
  name: string;
  run: () => Promise<void>;
}

const LOCK_NAME = 'relay_migrations';

async function columnExists(table: string, column: string): Promise<boolean> {
  return rowExists(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  );
}

async function indexExists(table: string, index: string): Promise<boolean> {
  return rowExists(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [table, index],
  );
}

const migrations: Migration[] = [
  {
    // Two extra demo users. Also gives the presence tests identities nothing else uses.
    name: 'users: extra demo users',
    run: async () => {
      await pool.query(
        `INSERT IGNORE INTO users (id, name, email) VALUES
           (4, 'Dave', 'dave@example.com'),
           (5, 'Erin', 'erin@example.com')`,
      );
    },
  },
  {
    // Finding F: every query filters by conversation_id and there was no index on it.
    // Covering (conversation_id, id) also serves `ORDER BY id` and `MAX(id)` as index seeks.
    name: 'messages: index (conversation_id, id)',
    run: async () => {
      if (await indexExists('messages', 'idx_messages_conversation')) return;
      await pool.query(
        'CREATE INDEX idx_messages_conversation ON messages (conversation_id, id)',
      );
    },
  },
  {
    // Finding D: client_id existed but nothing enforced it, so retries duplicated messages.
    // NULLs don't collide in a MySQL unique index, so messages sent without a client id are
    // simply not deduplicated — which is the behaviour we want.
    name: 'messages: unique (conversation_id, client_id)',
    run: async () => {
      if (await indexExists('messages', 'uniq_messages_client_id')) return;
      await deduplicateExistingClientIds();
      await pool.query(
        'CREATE UNIQUE INDEX uniq_messages_client_id ON messages (conversation_id, client_id)',
      );
    },
  },
  {
    // Finding M: the POST response used the app clock while GET used MySQL's second-precision
    // column, so one message had two different timestamps. One value is now generated in the
    // write path and stored in both stores, which needs millisecond precision to survive.
    name: 'messages: created_at -> DATETIME(3)',
    run: async () => {
      const column = await queryOne<{ column_type: string; datetime_precision: number | null }>(
        `SELECT column_type, datetime_precision FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'messages' AND column_name = 'created_at'`,
      );
      if (column?.datetime_precision === 3 && /datetime/i.test(column.column_type ?? '')) return;
      await pool.query(
        'ALTER TABLE messages MODIFY created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)',
      );
    },
  },
  {
    // Finding F: the composite PK is (conversation_id, user_id); the conversation list looks up
    // by user_id, which is not a usable prefix of that key.
    name: 'conversation_participants: index (user_id)',
    run: async () => {
      if (await indexExists('conversation_participants', 'idx_participants_user')) return;
      await pool.query(
        'CREATE INDEX idx_participants_user ON conversation_participants (user_id)',
      );
    },
  },
  {
    // Finding M: the unread dot only existed in browser memory, so it could not survive a
    // reload, a second tab, or a second instance. Watermark per participant instead.
    name: 'conversation_participants: last_read_message_id',
    run: async () => {
      if (await columnExists('conversation_participants', 'last_read_message_id')) return;
      await pool.query(
        'ALTER TABLE conversation_participants ADD COLUMN last_read_message_id BIGINT NOT NULL DEFAULT 0',
      );
    },
  },
  {
    // Lets us order the inbox by recency without touching the messages table.
    name: 'conversations: last_message_at',
    run: async () => {
      if (await columnExists('conversations', 'last_message_at')) return;
      await pool.query(
        'ALTER TABLE conversations ADD COLUMN last_message_at DATETIME(3) NULL',
      );
      // Backfill from whatever is already there.
      await pool.query(
        `UPDATE conversations c
         SET last_message_at = (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id)`,
      );
    },
  },
];

/**
 * The unique index can't be created while duplicates exist. Keep the earliest row of each
 * (conversation_id, client_id) group — that's the one clients were told about — and null out the
 * client_id on the rest so they survive as ordinary messages rather than being deleted.
 */
async function deduplicateExistingClientIds(): Promise<void> {
  const dupes = await queryRows<{
    conversation_id: number;
    client_id: string;
    keep_id: number;
    n: number;
  }>(
    `SELECT conversation_id, client_id, MIN(id) AS keep_id, COUNT(*) AS n
     FROM messages
     WHERE client_id IS NOT NULL
     GROUP BY conversation_id, client_id
     HAVING n > 1`,
  );
  for (const d of dupes) {
    await runWrite(
      'UPDATE messages SET client_id = NULL WHERE conversation_id = ? AND client_id = ? AND id <> ?',
      [d.conversation_id, d.client_id, d.keep_id],
    );
  }
  if (dupes.length) {
    console.log(`[migrate] cleared client_id on duplicates of ${dupes.length} client id(s)`);
  }
}

export async function runMigrations(): Promise<void> {
  // GET_LOCK is connection-scoped, so hold one connection for the whole run.
  const conn = await pool.getConnection();
  try {
    const lock = await queryOne<{ ok: number | null }>(
      'SELECT GET_LOCK(?, 30) AS ok',
      [LOCK_NAME],
      conn,
    );
    if (Number(lock?.ok) !== 1) throw new Error('could not acquire migration lock');
    try {
      for (const m of migrations) {
        await m.run();
      }
      console.log(`[migrate] schema up to date (${migrations.length} checks)`);
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
  } finally {
    conn.release();
  }
}
