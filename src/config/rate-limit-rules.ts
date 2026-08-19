/**
 * The rate-limiting rules: defaults in code, per-deployment overrides from env vars.
 *
 * Each route wires its own rule into the `rateLimit` middleware where the route is declared, so
 * the numbers, the key shape and the endpoint they protect sit together in code and the compiler
 * checks the wiring. There is deliberately no config file any more: the previous
 * `rate-limit.config.json` was a second place for the numbers to live, and its failure modes —
 * silently ignored typos, a bind mount turning into an empty directory — all came from the file
 * existing at all. An env var (`RATE_LIMIT_MAX` and friends) remains the per-deployment override
 * that doesn't need a commit.
 *
 * What is *not* configurable is which buckets exist and how they are keyed. A bucket's key shape
 * (per user, or per user per conversation) is a decision about what the limit protects, and it
 * lives with the endpoint it guards.
 *
 * Validation is strict and fails startup, because every wrong value here fails in a direction
 * nobody notices: a limit of 0 rejects everything, a window of `10` instead of `10000` meters a
 * thousand times too loosely. The limiter is a protection mechanism — it should refuse to run
 * misconfigured rather than run wrong.
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
 * Every metered bucket, with the default that applies when no env var overrides it.
 *
 * The defaults are the shipped policy, so the app boots correctly with no configuration at all.
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

const BUCKET_NAMES = Object.keys(BUCKETS) as BucketName[];

type RuleField = 'limit' | 'windowMs';

/**
 * Floor on a window. Retry-After is whole seconds and the window is scored in milliseconds, so
 * anything under 100ms is a dropped-zeroes typo far more often than an intention.
 */
const MIN_WINDOW_MS = 100;

type Env = Record<string, string | undefined>;

/** One resolved field, plus where it came from, so an error can name the thing to go and edit. */
interface Sourced {
  value: unknown;
  source: string;
}

function fieldFrom(bucket: BucketName, field: RuleField, env: Env): Sourced {
  const fromEnv = env[BUCKETS[bucket].env[field]];
  // An unset variable and an empty one mean the same thing: Compose passes empty strings straight
  // through for variables the host doesn't define, and reading that as 0 would reject every request.
  if (fromEnv !== undefined && fromEnv !== '') {
    // Plain decimal digits only. Number() would reduce a typo to NaN — destroying the text the
    // error exists to show — and quietly accept '1e3', '0x10' and ' 5 ' as overrides. Anything
    // else is kept as the raw string so the validation error can quote what was actually set.
    const value = /^[0-9]+$/.test(fromEnv) ? Number(fromEnv) : fromEnv;
    return { value, source: BUCKETS[bucket].env[field] };
  }
  return { value: BUCKETS[bucket][field], source: `${bucket}.${field} (default)` };
}

/**
 * Resolves the rule set from an environment: defaults from BUCKETS, overridden per field by env.
 *
 * Pure, so the precedence and the validation are testable without a running app. Throws with
 * *every* problem listed rather than the first: a misconfiguration usually comes in pairs, and
 * finding them one restart at a time is miserable.
 */
export function resolveRateLimitRules(env: Env): RateLimitRules {
  const problems: string[] = [];
  const resolved = {} as RateLimitRules;

  for (const bucket of BUCKET_NAMES) {
    const limit = fieldFrom(bucket, 'limit', env);
    const windowMs = fieldFrom(bucket, 'windowMs', env);

    // Each problem names what the bucket meters, so the reader fixing a number also knows what
    // traffic the number governs.
    const meters = ` (meters ${BUCKETS[bucket].what})`;
    problems.push(...wholeNumberProblem(limit, 1, 'requests').map((p) => p + meters));
    problems.push(
      ...wholeNumberProblem(windowMs, MIN_WINDOW_MS, 'milliseconds').map((p) => p + meters),
    );

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
 * `field.source` — the environment variable to go and edit, or the in-code default that applies.
 */
function wholeNumberProblem(field: Sourced, min: number, unit: string): string[] {
  if (Number.isInteger(field.value) && (field.value as number) >= min) return [];
  const got = typeof field.value === 'string' ? JSON.stringify(field.value) : String(field.value);
  return [`${field.source} must be a whole number of ${unit}, at least ${min}, got ${got}`];
}
