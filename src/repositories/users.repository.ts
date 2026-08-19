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

/** Which of `ids` exist — for validating participant lists in one query. */
export async function existingUserIds(ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}
