import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKETS, resolveRateLimitRules } from '../src/config/rate-limit-rules.ts';

/**
 * Unit tests for the rate-limit rule resolver.
 *
 * The rules are custom configs wired into the middleware in code: defaults live in BUCKETS, env
 * vars override per deployment. A wrong value fails in a direction nobody notices — a limit of 0
 * rejects everything, a window of "10" instead of 10000 meters three orders of magnitude too
 * loosely — so resolution and validation are a pure function over the environment and tested here
 * rather than only being exercised by a running stack.
 */

const RULE_NAMES = Object.keys(BUCKETS);

describe('resolveRateLimitRules — precedence', () => {
  it('uses the built-in defaults when the environment says nothing', () => {
    const rules = resolveRateLimitRules({});

    for (const name of RULE_NAMES) {
      assert.deepEqual(
        { limit: rules[name].limit, windowMs: rules[name].windowMs },
        { limit: BUCKETS[name].limit, windowMs: BUCKETS[name].windowMs },
        `${name} should fall back to its default`,
      );
    }
  });

  it('lets env override a default — a deployment can retune without a commit', () => {
    const rules = resolveRateLimitRules({ RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '5000' });

    assert.equal(rules.send.limit, 2);
    assert.equal(rules.send.windowMs, 5_000);
    // Untouched buckets keep their defaults rather than becoming undefined.
    assert.equal(rules.search.limit, BUCKETS.search.limit);
  });

  it('lets env set one field of a rule and default the other', () => {
    const rules = resolveRateLimitRules({ RATE_LIMIT_MAX: '9' });

    assert.equal(rules.send.limit, 9);
    assert.equal(rules.send.windowMs, BUCKETS.send.windowMs);
  });

  it('treats an empty env var as unset, not as zero', () => {
    // Compose passes through empty strings for variables that aren't set in the host environment;
    // reading that as 0 would mean "limit: 0", i.e. every request rejected.
    const rules = resolveRateLimitRules({ RATE_LIMIT_MAX: '' });

    assert.equal(rules.send.limit, BUCKETS.send.limit);
  });

  it('exposes every env override name for every bucket', () => {
    const rules = resolveRateLimitRules(
      Object.fromEntries(
        RULE_NAMES.flatMap((name) => [
          [BUCKETS[name].env.limit, '7'],
          [BUCKETS[name].env.windowMs, '7000'],
        ]),
      ),
    );

    for (const name of RULE_NAMES) {
      assert.deepEqual(
        { limit: rules[name].limit, windowMs: rules[name].windowMs },
        { limit: 7, windowMs: 7_000 },
        `${name} should be overridable by env`,
      );
    }
  });

  it('keeps the headline number from the task: ~5 sends per 10s', () => {
    // tasks/rate-limiting.md. The defaults in code are where this is now set, so this is where it
    // is asserted.
    assert.equal(BUCKETS.send.limit, 5);
    assert.equal(BUCKETS.send.windowMs, 10_000);
  });
});

describe('resolveRateLimitRules — validation', () => {
  const problemsOf = (env) => {
    try {
      resolveRateLimitRules(env);
      return undefined;
    } catch (err) {
      return err.message;
    }
  };

  it('rejects a limit of zero rather than silently blocking every request', () => {
    const message = problemsOf({ RATE_LIMIT_MAX: '0' });
    assert.match(message ?? '', /RATE_LIMIT_MAX/);
  });

  it('rejects a window so short it cannot be expressed as a Retry-After', () => {
    // Retry-After is whole seconds, and the sliding window is scored in ms; anything under 100ms is
    // a missing-zeroes typo far more often than an intention.
    assert.match(problemsOf({ RATE_LIMIT_WINDOW_MS: '10' }) ?? '', /RATE_LIMIT_WINDOW_MS/);
  });

  it('rejects a non-numeric env override, naming the variable and quoting the value', () => {
    const message = problemsOf({ RATE_LIMIT_MAX: 'lots' });
    assert.match(message ?? '', /RATE_LIMIT_MAX/);
    // The raw text must survive into the error — "got NaN" tells the reader nothing about what to fix.
    assert.match(message ?? '', /"lots"/);
  });

  it('rejects the numeric spellings Number() would quietly accept', () => {
    // '1e3', '0x10' and ' 5 ' all convert cleanly via Number(), but none of them is a value anyone
    // deliberately sets a rate limit to — they are formatting accidents, and accepting them hides that.
    for (const value of ['1e3', '0x10', ' 5 ', '-1', '2.5']) {
      const message = problemsOf({ RATE_LIMIT_MAX: value });
      assert.match(message ?? '', /RATE_LIMIT_MAX/, `${JSON.stringify(value)} should be rejected`);
    }
  });

  it('reports every problem at once rather than one per restart', () => {
    const message = problemsOf({ RATE_LIMIT_MAX: '0', SEARCH_RATE_LIMIT_WINDOW_MS: '1' });

    assert.match(message ?? '', /RATE_LIMIT_MAX/);
    assert.match(message ?? '', /SEARCH_RATE_LIMIT_WINDOW_MS/);
  });

  it('says what the misconfigured bucket meters, so the reader knows what the number governs', () => {
    const message = problemsOf({ RATE_LIMIT_MAX: '0' });
    assert.match(message ?? '', /POST \/api\/messages/);
  });
});
