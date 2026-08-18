import mysql from 'mysql2/promise';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { config } from '../config.ts';
import { bestEffort } from '../util/resilience.ts';

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

/**
 * Anything that can run a query — the pool, or a connection inside a transaction. Lets the helpers
 * below be used identically in both, instead of having transaction code fall back to raw calls.
 */
export type Queryable = Pick<mysql.Pool, 'query' | 'execute'> | PoolConnection;

/**
 * Typed row access.
 *
 * The project compiles with `strict`, and then every row out of MySQL was `any` — 22 call sites of
 * `pool.query<any[]>`, which is precisely where a typo costs most: the mapping between column names
 * and the JSON we hand the client. These helpers put a row type on each query, so the compiler
 * checks that mapping.
 *
 * They also absorb the `const [rows] = await …` tuple destructuring that every call site repeated.
 */
export async function queryRows<T>(
  sql: string,
  params: unknown[] = [],
  conn: Queryable = pool,
): Promise<T[]> {
  const [rows] = await conn.query<(T & RowDataPacket)[]>(sql, params);
  return rows;
}

/** First row, or undefined. Replaces the `const [[row]] = …` double-destructuring idiom. */
export async function queryOne<T>(
  sql: string,
  params: unknown[] = [],
  conn: Queryable = pool,
): Promise<T | undefined> {
  const rows = await queryRows<T>(sql, params, conn);
  return rows[0];
}

/** True when the query matched at least one row — for `SELECT 1 … LIMIT 1` existence checks. */
export async function exists(
  sql: string,
  params: unknown[] = [],
  conn: Queryable = pool,
): Promise<boolean> {
  const rows = await queryRows<RowDataPacket>(sql, params, conn);
  return rows.length > 0;
}

/** INSERT/UPDATE/DELETE, returning the header so callers can read insertId / affectedRows. */
export async function runWrite(
  sql: string,
  params: unknown[] = [],
  conn: Queryable = pool,
): Promise<ResultSetHeader> {
  const [result] = await conn.query<ResultSetHeader>(sql, params);
  return result;
}

/**
 * Placeholder list for an `IN (…)` clause: sqlList(3) -> '?,?,?'.
 *
 * Five call sites built this by hand with `ids.map(() => '?').join(',')`. All correctly
 * parameterised, but it's the shape that gets "simplified" into string interpolation by the next
 * person in a hurry, so it's worth having one obviously-safe spelling.
 */
export function sqlList(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

/** Placeholder rows for a multi-row INSERT: sqlRows(2, 2) -> '(?, ?),(?, ?)'. */
export function sqlRows(rowCount: number, columnsPerRow: number): string {
  const row = `(${sqlList(columnsPerRow)})`;
  return Array.from({ length: rowCount }, () => row).join(',');
}

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
    // Report the original failure, not a rollback failure — but don't hide the latter either.
    await bestEffort('mysql:rollback', () => conn.rollback());
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
