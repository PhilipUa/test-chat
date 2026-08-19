import { Prisma, PrismaClient } from '../generated/prisma-mysql/index.js';

/**
 * The MySQL Prisma client and its lifecycle.
 *
 * All queries live in src/repositories/ — this module only owns the connection, the shutdown, and
 * the error taxonomy callers branch on. `timezone` and BIGINT handling, which the old mysql2 pool
 * had to be configured for by hand, are Prisma defaults: DATETIME comes back as a UTC `Date`, and
 * BIGINT columns come back as `bigint` (repositories convert to `number` at their boundary, since
 * every id in this app is far below 2^53).
 */
export const db = new PrismaClient();

export { Prisma };

export async function waitForMysql(retries = 40): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      await db.$queryRaw`SELECT 1`;
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`mysql not reachable: ${String(lastErr)}`, { cause: lastErr });
}

export async function closeMysql(): Promise<void> {
  await db.$disconnect();
}

/** P2002: unique constraint violation — the code we branch on for idempotent send races. */
export function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
