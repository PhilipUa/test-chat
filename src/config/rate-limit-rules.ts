import { readFileSync } from 'node:fs';

/**
 * Where the rate-limiting rules come from — `rate-limit.config.json`, env vars, or the defaults here.
 *
 * The limits themselves were literals in config.ts, which meant "5 messages per 10 seconds" was a
 * number in TypeScript and retuning it needed a code change or five separate environment variables
 * nobody could enumerate. They are policy, not code: the same argument the autoscaler makes for
 * `autoscale.config.json`, and this file is deliberately its counterpart — one file, a `$comment`
 * explaining every knob, `$examples` to copy from.
 *
 * Precedence is env > file > defaults, matching `scripts/autoscale.mjs` (flag > file > default): the
 * file is where the intended policy lives and is reviewed, and an env var is the per-deployment
 * override that doesn't need a commit. Every pre-existing `RATE_LIMIT_*` variable keeps working.
 *
 * What is *not* configurable here is which buckets exist and how they are keyed. A bucket's key
 * shape (per user, or per user per conversation) is a decision about what the limit protects, and it
 * lives in code with the endpoint it guards. The file sets numbers.
 *
 * Validation is strict and fails startup, because every wrong value here fails in a direction nobody
 * notices: a limit of 0 rejects everything, a window of `10` instead of `10000` meters a thousand
 * times too loosely, and a rule named `sends` looks configured while doing nothing at all. The
 * limiter is a protection mechanism — it should refuse to run misconfigured rather than run wrong.
 */

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  /** Length of the sliding window in milliseconds. */
  windowMs: number;
}

interface BucketSpec extends RateLimitRule {
  /** What the bucket meters, and how it is keyed — for the error messages and the docs. */
  what: string;
  env: { limit: string; windowMs: string };
}

/**
 * Every metered bucket, with the default that applies when nothing overrides it.
 *
 * The defaults are the shipped policy, so the app boots correctly with no config file at all.
 */
export const BUCKETS = {
  /** tasks/rate-limiting.md: ~5 messages per 10s, per user per conversation. */
  send: {
    what: 'POST /api/messages — per user, per conversation',
    limit: 5,
    windowMs: 10_000,
    env: { limit: 'RATE_LIMIT_MAX', windowMs: 'RATE_LIMIT_WINDOW_MS' },
  },
  /**
   * Search is the most expensive read in the app — it fans out over every message in the caller's
   * conversations. Per user, not per conversation: a search spans them.
   */
  search: {
    what: 'GET /api/search — per user, across their conversations',
    limit: 20,
    windowMs: 10_000,
    env: { limit: 'SEARCH_RATE_LIMIT_MAX', windowMs: 'SEARCH_RATE_LIMIT_WINDOW_MS' },
  },
  /**
   * List reads: the inbox and message history. Cheaper than search — both are bounded page-size
   * queries — but unmetered they are still an open loop against MySQL and Mongo.
   *
   * Deliberately loose. A legitimate client reads these on open, on reconnect, on resync and when
   * paging back through history, and automation that polls the inbox for a state change is normal —
   * the busiest honest reader in this repo is a test helper polling presence at 4/s. 100 per 10s is
   * ~10/s sustained, which leaves that real traffic a wide margin and still costs a runaway loop its
   * allowance inside the first second. The short window matters as much as the number: an exhausted
   * client recovers in ten seconds rather than going dark for a minute.
   */
  reads: {
    what: 'GET /api/messages and GET /api/conversations — per user',
    limit: 100,
    windowMs: 10_000,
    env: { limit: 'READ_RATE_LIMIT_MAX', windowMs: 'READ_RATE_LIMIT_WINDOW_MS' },
  },
  /**
   * Creating conversations is cheap per call, but unbounded growth isn't. A high ceiling on purpose:
   * this is a runaway-script guard, not a tight control. Creating conversations is normal, bursty,
   * legitimate behaviour (importing a backlog, an integration fanning out), and a tight limit here
   * punishes real use to prevent something that isn't the actual abuse vector — search is.
   */
  create: {
    what: 'POST /api/conversations — per user',
    limit: 60,
    windowMs: 60_000,
    env: { limit: 'CREATE_RATE_LIMIT_MAX', windowMs: 'CREATE_RATE_LIMIT_WINDOW_MS' },
  },
  /** Typing frames are cheap but shouldn't be a free broadcast channel either. */
  typing: {
    what: 'WebSocket typing frames — per user, per conversation',
    limit: 10,
    windowMs: 10_000,
    env: { limit: 'TYPING_RATE_LIMIT_MAX', windowMs: 'TYPING_RATE_LIMIT_WINDOW_MS' },
  },
} as const satisfies Record<string, BucketSpec>;

export type BucketName = keyof typeof BUCKETS;

export type RateLimitRules = Record<BucketName, RateLimitRule>;

export const DEFAULT_RATE_LIMIT_CONFIG_PATH = 'rate-limit.config.json';

const BUCKET_NAMES = Object.keys(BUCKETS) as BucketName[];
const RULE_FIELDS = ['limit', 'windowMs'] as const;

/**
 * Floor on a window. Retry-After is whole seconds and the window is scored in milliseconds, so
 * anything under 100ms is a dropped-zeroes typo far more often than an intention.
 */
const MIN_WINDOW_MS = 100;

type Env = Record<string, string | undefined>;

interface RawFile {
  rules?: unknown;
  [key: string]: unknown;
}

/** One resolved field, plus where it came from, so an error can name the thing to go and edit. */
interface Sourced {
  value: unknown;
  source: string;
}

function fieldFrom(
  bucket: BucketName,
  field: (typeof RULE_FIELDS)[number],
  fileRule: Record<string, unknown> | undefined,
  env: Env,
): Sourced {
  const fromEnv = env[BUCKETS[bucket].env[field]];
  // An unset variable and an empty one mean the same thing: Compose passes empty strings straight
  // through for variables the host doesn't define, and reading that as 0 would reject every request.
  if (fromEnv !== undefined && fromEnv !== '') {
    return { value: Number(fromEnv), source: BUCKETS[bucket].env[field] };
  }
  if (fileRule && fileRule[field] !== undefined) {
    return { value: fileRule[field], source: `${bucket}.${field}` };
  }
  return { value: BUCKETS[bucket][field], source: `${bucket}.${field} (default)` };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves the rule set from an already-parsed file and an environment.
 *
 * Pure, so the precedence and the validation are testable without a filesystem or a running app.
 * Throws with *every* problem listed rather than the first: a misconfiguration usually comes in
 * pairs, and finding them one restart at a time is miserable.
 */
export function resolveRateLimitRules({ file, env }: { file: RawFile; env: Env }): RateLimitRules {
  const problems: string[] = [];
  const rulesBlock = file.rules;

  if (rulesBlock !== undefined && !isPlainObject(rulesBlock)) {
    problems.push('"rules" must be an object keyed by bucket name');
  }

  const fileRules = isPlainObject(rulesBlock) ? rulesBlock : {};

  for (const name of Object.keys(fileRules)) {
    if (!(BUCKET_NAMES as string[]).includes(name)) {
      problems.push(`unknown rule "${name}" — known rules are ${BUCKET_NAMES.join(', ')}`);
    }
  }

  const resolved = {} as RateLimitRules;

  for (const bucket of BUCKET_NAMES) {
    const raw = fileRules[bucket];
    if (raw !== undefined && !isPlainObject(raw)) {
      problems.push(`${bucket} must be an object like { "limit": 5, "windowMs": 10000 }`);
    }
    const fileRule = isPlainObject(raw) ? raw : undefined;

    for (const key of Object.keys(fileRule ?? {})) {
      if (!(RULE_FIELDS as readonly string[]).includes(key)) {
        problems.push(`unknown field "${bucket}.${key}" — a rule takes ${RULE_FIELDS.join(' and ')}`);
      }
    }

    const limit = fieldFrom(bucket, 'limit', fileRule, env);
    const windowMs = fieldFrom(bucket, 'windowMs', fileRule, env);

    problems.push(...wholeNumberProblem(limit, 1, 'requests'));
    problems.push(...wholeNumberProblem(windowMs, MIN_WINDOW_MS, 'milliseconds'));

    resolved[bucket] = { limit: limit.value as number, windowMs: windowMs.value as number };
  }

  if (problems.length) {
    throw new Error(
      `rate limiting config is not usable:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }

  return resolved;
}

/**
 * The single check both fields need: a whole number at or above a floor.
 *
 * Returns problems rather than throwing, so the caller can collect every one. The message leads with
 * `field.source`, which is either a path into the file or an environment variable name — i.e. it tells
 * the reader which of the two to go and edit.
 */
function wholeNumberProblem(field: Sourced, min: number, unit: string): string[] {
  if (Number.isInteger(field.value) && (field.value as number) >= min) return [];
  const got = typeof field.value === 'string' ? JSON.stringify(field.value) : String(field.value);
  return [`${field.source} must be a whole number of ${unit}, at least ${min}, got ${got}`];
}

/**
 * Reads the rule file if it is there, and resolves the rules against `env`.
 *
 * A missing file is fine — the defaults above are the shipped policy, and an image that ships only
 * `src/` should still boot metered. A file that exists but cannot be read or parsed is not fine: the
 * whole point of putting limits in a file is that editing it changes the limits, and quietly running
 * defaults instead means someone tightens a limit, restarts, and is never told it didn't take.
 */
export function loadRateLimitRules(
  path: string = process.env.RATE_LIMIT_CONFIG || DEFAULT_RATE_LIMIT_CONFIG_PATH,
  env: Env = process.env,
): RateLimitRules {
  let file: RawFile = {};
  let contents: string | undefined;

  try {
    contents = readFileSync(path, 'utf8');
  } catch (err) {
    // Only a missing file is tolerated. A permissions error or a directory is a real problem.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`could not read rate limiting config ${path}: ${(err as Error).message}`);
    }
  }

  if (contents !== undefined) {
    try {
      const parsed: unknown = JSON.parse(contents);
      if (!isPlainObject(parsed)) throw new Error('top level must be an object');
      file = parsed;
    } catch (err) {
      throw new Error(`could not parse rate limiting config ${path}: ${(err as Error).message}`);
    }
  }

  try {
    return resolveRateLimitRules({ file, env });
  } catch (err) {
    // Re-thrown with the path, because the fix is an edit to a specific file.
    throw new Error(`${(err as Error).message}\n  (from ${path})`);
  }
}
