import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUCKETS,
  DEFAULT_RATE_LIMIT_CONFIG_PATH,
  loadRateLimitRules,
  resolveRateLimitRules,
} from '../src/config/rate-limit-rules.ts';

/**
 * Unit tests for the rate-limit rule loader.
 *
 * The limiter's numbers now come from a file (rate-limit.config.json), which means a typo in that
 * file is a security-relevant misconfiguration: a window of "10" instead of 10000 would meter three
 * orders of magnitude too loosely, and a limiter that is silently wrong is worse than one that is
 * absent. So the resolution and validation are a pure function over (file, env) and tested here
 * rather than only being exercised by a running stack.
 */

const RULE_NAMES = Object.keys(BUCKETS);

describe('resolveRateLimitRules — precedence', () => {
  it('uses the built-in defaults when neither a file nor env says otherwise', () => {
    const rules = resolveRateLimitRules({ file: {}, env: {} });

    for (const name of RULE_NAMES) {
      assert.deepEqual(
        { limit: rules[name].limit, windowMs: rules[name].windowMs },
        { limit: BUCKETS[name].limit, windowMs: BUCKETS[name].windowMs },
        `${name} should fall back to its default`,
      );
    }
  });

  it('lets the file override a default', () => {
    const rules = resolveRateLimitRules({
      file: { rules: { send: { limit: 9, windowMs: 30_000 } } },
      env: {},
    });

    assert.equal(rules.send.limit, 9);
    assert.equal(rules.send.windowMs, 30_000);
    // Untouched buckets keep their defaults rather than becoming undefined.
    assert.equal(rules.search.limit, BUCKETS.search.limit);
  });

  it('lets the file set one field of a rule and default the other', () => {
    const rules = resolveRateLimitRules({ file: { rules: { send: { limit: 9 } } }, env: {} });

    assert.equal(rules.send.limit, 9);
    assert.equal(rules.send.windowMs, BUCKETS.send.windowMs);
  });

  it('lets env override the file — a deployment can retune without editing the file', () => {
    const rules = resolveRateLimitRules({
      file: { rules: { send: { limit: 9, windowMs: 30_000 } } },
      env: { RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '5000' },
    });

    assert.equal(rules.send.limit, 2);
    assert.equal(rules.send.windowMs, 5_000);
  });

  it('treats an empty env var as unset, not as zero', () => {
    // Compose passes through empty strings for variables that aren't set in the host environment;
    // reading that as 0 would mean "limit: 0", i.e. every request rejected.
    const rules = resolveRateLimitRules({
      file: { rules: { send: { limit: 9 } } },
      env: { RATE_LIMIT_MAX: '' },
    });

    assert.equal(rules.send.limit, 9);
  });

  it('exposes every env override name for every bucket', () => {
    const rules = resolveRateLimitRules({
      file: {},
      env: Object.fromEntries(
        RULE_NAMES.flatMap((name) => [
          [BUCKETS[name].env.limit, '7'],
          [BUCKETS[name].env.windowMs, '7000'],
        ]),
      ),
    });

    for (const name of RULE_NAMES) {
      assert.deepEqual(
        { limit: rules[name].limit, windowMs: rules[name].windowMs },
        { limit: 7, windowMs: 7_000 },
        `${name} should be overridable by env`,
      );
    }
  });
});

describe('resolveRateLimitRules — validation', () => {
  const problemsOf = (input) => {
    try {
      resolveRateLimitRules(input);
      return undefined;
    } catch (err) {
      return err.message;
    }
  };

  it('rejects a limit of zero rather than silently blocking every request', () => {
    const message = problemsOf({ file: { rules: { send: { limit: 0 } } }, env: {} });
    assert.match(message ?? '', /send\.limit/);
  });

  it('rejects a negative or fractional limit', () => {
    assert.match(problemsOf({ file: { rules: { send: { limit: -1 } } }, env: {} }) ?? '', /send\.limit/);
    assert.match(problemsOf({ file: { rules: { send: { limit: 2.5 } } }, env: {} }) ?? '', /send\.limit/);
  });

  it('rejects a window so short it cannot be expressed as a Retry-After', () => {
    // Retry-After is whole seconds, and the sliding window is scored in ms; anything under 100ms is
    // a missing-zeroes typo far more often than an intention.
    assert.match(
      problemsOf({ file: { rules: { send: { windowMs: 10 } } }, env: {} }) ?? '',
      /send\.windowMs/,
    );
  });

  it('rejects a non-numeric value from the file', () => {
    assert.match(
      problemsOf({ file: { rules: { send: { limit: 'five' } } }, env: {} }) ?? '',
      /send\.limit/,
    );
  });

  it('rejects a non-numeric env override, naming the variable', () => {
    const message = problemsOf({ file: {}, env: { RATE_LIMIT_MAX: 'lots' } });
    assert.match(message ?? '', /RATE_LIMIT_MAX/);
  });

  it('rejects an unknown bucket name instead of ignoring it', () => {
    // A rule named "sends" would otherwise look configured and do nothing at all.
    const message = problemsOf({ file: { rules: { sends: { limit: 5 } } }, env: {} });
    assert.match(message ?? '', /sends/);
    assert.match(message ?? '', /send/);
  });

  it('rejects an unknown field inside a rule', () => {
    const message = problemsOf({ file: { rules: { send: { limit: 5, window: 10_000 } } }, env: {} });
    assert.match(message ?? '', /window/);
  });

  it('rejects a rules block that is not an object', () => {
    assert.match(problemsOf({ file: { rules: [] }, env: {} }) ?? '', /rules/);
  });

  it('reports every problem at once rather than one per restart', () => {
    const message = problemsOf({
      file: { rules: { send: { limit: 0 }, search: { windowMs: -1 } } },
      env: {},
    });

    assert.match(message ?? '', /send\.limit/);
    assert.match(message ?? '', /search\.windowMs/);
  });

  it('ignores the $-prefixed keys the config file uses for documentation', () => {
    const rules = resolveRateLimitRules({
      file: { $comment: ['notes'], $examples: { strict: {} }, rules: { send: { limit: 3 } } },
      env: {},
    });

    assert.equal(rules.send.limit, 3);
  });
});

describe('rate-limit.config.json', () => {
  // The shipped file is configuration, so it can drift from the code that consumes it. These are the
  // checks that it hasn't.
  const file = JSON.parse(readFileSync(DEFAULT_RATE_LIMIT_CONFIG_PATH, 'utf8'));

  it('is valid against the loader that reads it', () => {
    const rules = resolveRateLimitRules({ file, env: {} });

    for (const name of RULE_NAMES) {
      assert.ok(rules[name].limit >= 1, `${name} should have a usable limit`);
    }
  });

  it('documents every bucket the code meters, and no others', () => {
    // A bucket added in code but missing from the file is invisible to whoever tunes the limits.
    assert.deepEqual(Object.keys(file.rules).sort(), RULE_NAMES.sort());
  });

  it('keeps the headline number from the task: ~5 sends per 10s', () => {
    // tasks/rate-limiting.md. The file is where this is now set, so this is where it is asserted.
    assert.equal(file.rules.send.limit, 5);
    assert.equal(file.rules.send.windowMs, 10_000);
  });

  it('every example in the file is itself a valid rule set', () => {
    // The examples are there to be copied, so a broken one is a trap.
    for (const [name, rules] of Object.entries(file.$examples ?? {})) {
      assert.doesNotThrow(
        () => resolveRateLimitRules({ file: { rules }, env: {} }),
        `example "${name}" should be valid`,
      );
    }
  });
});

describe('loadRateLimitRules — reading the file', () => {
  const tmp = (name, contents) => {
    const path = join(tmpdir(), `relay-rl-${process.hrtime.bigint().toString(36)}-${name}`);
    writeFileSync(path, contents);
    return path;
  };

  it('falls back to the built-in defaults when the file is absent', () => {
    // The app has to boot without the file: a container image that ships only src/ is a normal
    // deployment, and the defaults are the documented ones from the task.
    const rules = loadRateLimitRules(join(tmpdir(), 'relay-rl-does-not-exist.json'), {});

    assert.equal(rules.send.limit, BUCKETS.send.limit);
  });

  it('refuses to start on malformed JSON rather than quietly using defaults', () => {
    // Silently ignoring a broken file is the failure mode where someone tightens a limit, restarts,
    // and is never told the limit they set is not the limit running.
    const path = tmp('broken.json', '{ "rules": { "send": }');

    assert.throws(() => loadRateLimitRules(path, {}), (err) => err.message.includes(path));
  });

  it('reads a well-formed file', () => {
    const path = tmp('good.json', JSON.stringify({ rules: { typing: { limit: 3, windowMs: 1_000 } } }));
    const rules = loadRateLimitRules(path, {});

    assert.equal(rules.typing.limit, 3);
    assert.equal(rules.typing.windowMs, 1_000);
  });

  it('names the file in a validation error, so the fix is obvious', () => {
    const path = tmp('invalid.json', JSON.stringify({ rules: { send: { limit: 0 } } }));

    assert.throws(() => loadRateLimitRules(path, {}), (err) => err.message.includes(path));
  });
});
