import { findUserName } from '../repositories/users.repository.ts';
import type { UserRecord } from '../repositories/users.repository.ts';

/**
 * The user read surface controllers and the WS layer use, so nothing above this file imports a
 * repository directly. The two plain lookups are re-exported rather than wrapped — a forwarding
 * body adds an indirection without adding a decision; `getUserName` below is here because it does
 * make one (the cache and the fallback name).
 */
export { listUsers, userExists } from '../repositories/users.repository.ts';
export type User = UserRecord;

/**
 * User names are needed on the typing indicator, on every WS frame. They effectively never
 * change, so a short-lived in-process cache saves a query per keystroke-burst without needing
 * any invalidation story beyond the TTL.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<number, { name: string; at: number }>();

export async function getUserName(userId: number): Promise<string> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.name;

  const name = (await findUserName(userId)) ?? `User ${userId}`;
  cache.set(userId, { name, at: Date.now() });
  return name;
}
