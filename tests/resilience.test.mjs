import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bestEffort, logThrottled, parseJson, withFallback } from '../src/util/resilience.ts';

/**
 * Unit tests for the error-handling helpers.
 *
 * Everything else in this suite is integration-level against a running stack, which is right for
 * this app — but these are pure functions whose whole job is to behave correctly when something
 * fails, and that's cheap and worth pinning down directly. Run via tsx so the test can import the
 * TypeScript module.
 */

describe('withFallback', () => {
  it('returns the value when the work succeeds', async () => {
    assert.equal(await withFallback('test', 'fallback', async () => 'ok'), 'ok');
  });

  it('returns the fallback when the work throws', async () => {
    const result = await withFallback('test:throws', 'fallback', async () => {
      throw new Error('boom');
    });
    assert.equal(result, 'fallback');
  });

  it('does not let a rejection escape', async () => {
    await assert.doesNotReject(() =>
      withFallback('test:rejects', null, () => Promise.reject(new Error('boom'))),
    );
  });

  it('passes through a falsy success value rather than treating it as failure', async () => {
    // The fail-open rate limiter and presence both return booleans, so `false` must survive.
    assert.equal(await withFallback('test:false', true, async () => false), false);
    assert.equal(await withFallback('test:zero', 99, async () => 0), 0);
  });
});

describe('bestEffort', () => {
  it('reports success so callers can branch instead of nesting a catch', async () => {
    assert.equal(await bestEffort('test', async () => undefined), true);
    assert.equal(
      await bestEffort('test:fails', async () => {
        throw new Error('boom');
      }),
      false,
    );
  });

  it('accepts a promise as well as a thunk', async () => {
    assert.equal(await bestEffort('test:promise', Promise.resolve(1)), true);
    assert.equal(await bestEffort('test:promise-fails', Promise.reject(new Error('x'))), false);
  });

  it('never rejects — that is the entire point', async () => {
    await assert.doesNotReject(() => bestEffort('test:norej', Promise.reject(new Error('x'))));
  });
});

describe('parseJson', () => {
  it('parses valid JSON', () => {
    assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  });

  it('returns undefined for anything malformed, instead of throwing', () => {
    for (const bad of ['', '{', 'not json', '{"a":', undefined]) {
      assert.equal(parseJson(bad), undefined, `expected undefined for ${JSON.stringify(bad)}`);
    }
  });

  it('distinguishes a parsed null from a parse failure', () => {
    // Both are falsy, so callers that check truthiness are fine — but they are different facts, and
    // a caller inspecting the result should be able to tell.
    assert.equal(parseJson('null'), null);
    assert.equal(parseJson('nul'), undefined);
  });
});

describe('logThrottled', () => {
  it('logs the first call for a label and suppresses immediate repeats', () => {
    const original = console.error;
    const lines = [];
    console.error = (line) => lines.push(line);
    try {
      const label = `throttle-test-${Math.trunc(performance.now())}`;
      for (let i = 0; i < 5; i++) logThrottled(label, `message ${i}`);
      assert.equal(lines.length, 1, 'a flapping dependency must not drown the log');
      assert.match(lines[0], /message 0/);
      assert.match(lines[0], new RegExp(label));
    } finally {
      console.error = original;
    }
  });

  it('throttles per label, so one noisy source does not mute another', () => {
    const original = console.error;
    const lines = [];
    console.error = (line) => lines.push(line);
    try {
      const stamp = Math.trunc(performance.now());
      logThrottled(`a-${stamp}`, 'from a');
      logThrottled(`a-${stamp}`, 'from a again');
      logThrottled(`b-${stamp}`, 'from b');
      assert.equal(lines.length, 2);
    } finally {
      console.error = original;
    }
  });
});
