import mysql from 'mysql2/promise';
import { config } from '../config.ts';

export const pool = mysql.createPool({
  uri: config.mysqlUrl,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // DATETIME/TIMESTAMP columns come back as JS Dates in UTC. Without this, mysql2 interprets
  // them in the server's local timezone, which is how a message can appear to arrive an hour
  // before it was sent.
  timezone: 'Z',
  // The `messages` PK is BIGINT. mysql2 hands BIGINT back as a string when it exceeds the safe
  // integer range unless told otherwise; keeping numbers is fine here and keeps the JSON
  // shape stable for the client.
  supportBigNumbers: true,
  bigNumberStrings: false,
  namedPlaceholders: false,
});

export async function waitForMysql(retries = 40): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`mysql not reachable: ${lastErr}`);
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (conn: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export async function closeMysql(): Promise<void> {
  await pool.end();
}

/** MySQL error codes we branch on, rather than string-matching messages. */
export const MYSQL_DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === MYSQL_DUPLICATE_ENTRY;
}
