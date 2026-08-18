import { exists, queryOne, queryRows } from '../db/mysql.ts';

export interface User {
  id: number;
  name: string;
  email: string;
}

/** Shape of a `users` row as selected below. */
interface UserRow {
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
  const rows = await queryRows<UserRow>('SELECT id, name, email FROM users ORDER BY id ASC');
  return rows.map((r) => ({ id: Number(r.id), name: r.name, email: r.email }));
}

export async function getUserName(userId: number): Promise<string> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.name;

  const row = await queryOne<{ name: string }>('SELECT name FROM users WHERE id = ?', [userId]);
  const name = row?.name ?? `User ${userId}`;
  cache.set(userId, { name, at: Date.now() });
  return name;
}

export async function userExists(userId: number): Promise<boolean> {
  return exists('SELECT 1 FROM users WHERE id = ? LIMIT 1', [userId]);
}
