import { db } from '../db/mysql.ts';

/**
 * Data access for `users`. No business logic here — naming fallbacks, caching and error policy
 * live in services/users.ts.
 */

export interface UserRecord {
  id: number;
  name: string;
  email: string;
}

export async function listUsers(): Promise<UserRecord[]> {
  return db.user.findMany({ orderBy: { id: 'asc' } });
}

export async function findUserName(userId: number): Promise<string | undefined> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  return row?.name;
}

export async function userExists(userId: number): Promise<boolean> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  return row !== null;
}

/**
 * The names of whichever of `ids` exist, keyed by id.
 *
 * Doubles as the existence check for a participant list — a missing key is a missing user — so
 * validating a new conversation and naming the people in it are one query rather than two.
 */
export async function namesByIds(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}
