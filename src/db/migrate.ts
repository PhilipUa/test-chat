import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './mysql.ts';

/**
 * Boot-time schema migrations, now via Prisma Migrate.
 *
 * The previous version of this file was a hand-rolled list of idempotent DDL steps; those steps
 * are gone — their end state IS the `0_init` baseline in prisma/mysql/migrations. What remains
 * here is the glue that keeps the old operational contract:
 *
 *  - Migrations still run on every boot, before the instance accepts traffic.
 *  - `--scale api=3` still boots cleanly: `prisma migrate deploy` takes its own advisory lock,
 *    and the one step it doesn't cover (baselining) runs under a MySQL named lock here.
 *
 * Baselining: an install that ran the old runner has the full schema but no `_prisma_migrations`
 * table. Deploying `0_init` against it would fail on the first CREATE TABLE, so such a database is
 * marked as already at `0_init` (`prisma migrate resolve --applied`) — recorded, nothing executed.
 * A fresh volume skips that and lets `0_init` actually run.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = join(REPO_ROOT, 'prisma/mysql/schema.prisma');
const LOCK_NAME = 'relay_migrations';

function runPrisma(args: string[]): void {
  const res = spawnSync('npx', ['prisma', ...args, '--schema', SCHEMA], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (res.status !== 0) {
    throw new Error(`prisma ${args.join(' ')} exited with ${res.status}`);
  }
}

async function tableExists(tx: Pick<typeof db, '$queryRaw'>, table: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = ${table}`;
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function runMigrations(): Promise<void> {
  // GET_LOCK is connection-scoped; an interactive transaction pins one connection for the check
  // and the resolve, so N instances racing to baseline the same database do it once.
  await db.$transaction(
    async (tx) => {
      const lock = await tx.$queryRaw<{ ok: bigint | number | null }[]>`
        SELECT GET_LOCK(${LOCK_NAME}, 30) AS ok`;
      if (Number(lock[0]?.ok) !== 1) throw new Error('could not acquire migration lock');
      try {
        const migrated = await tableExists(tx, '_prisma_migrations');
        const hasSchema = await tableExists(tx, 'messages');
        if (hasSchema && !migrated) {
          console.log('[migrate] existing schema without migration history — baselining as 0_init');
          runPrisma(['migrate', 'resolve', '--applied', '0_init']);
        }
      } finally {
        await tx.$queryRaw`SELECT RELEASE_LOCK(${LOCK_NAME})`;
      }
    },
    // The resolve step shells out to the Prisma CLI; give it room beyond the 5s default.
    { timeout: 120_000, maxWait: 30_000 },
  );

  // Advisory-locked by Prisma itself, so concurrent instances queue rather than clash.
  runPrisma(['migrate', 'deploy']);
  console.log('[migrate] schema up to date (prisma migrate deploy)');
}
