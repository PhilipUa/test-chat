import { pool } from '../db/mysql.ts';

export interface User {
  id: number;
  name: string;
  email: string;
}

/**
 * User names are needed on the typing indicator, on every WS frame. They effectively never
 * change, so a short-lived in-process cache saves a query per keystroke-burst without needing
 * any invalidation story beyond the TTL.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<number, { name: string; at: number }>();

export async function listUsers(): Promise<User[]> {
  const [rows] = await pool.query<any[]>('SELECT id, name, email FROM users ORDER BY id ASC');
  return rows as User[];
}

export async function getUserName(userId: number): Promise<string> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.name;

  const [rows] = await pool.query<any[]>('SELECT name FROM users WHERE id = ?', [userId]);
  const name = rows[0]?.name ?? `User ${userId}`;
  cache.set(userId, { name, at: Date.now() });
  return name;
}

export async function userExists(userId: number): Promise<boolean> {
  const [rows] = await pool.query<any[]>('SELECT 1 FROM users WHERE id = ? LIMIT 1', [userId]);
  return rows.length > 0;
}
