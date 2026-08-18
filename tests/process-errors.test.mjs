import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processErrorHandlers } from '../src/middleware/error-handler.ts';

/**
 * Unit tests for the process-level error policy.
 *
 * The two cases genuinely differ and the old code treated them the same. A rejected promise nobody
 * awaited is usually a missing `.catch()` on something non-essential — the process is still sound. An
 * uncaught exception unwound the stack from an unknown point, so the heap is no longer trustworthy,
 * and staying up means serving requests from a process in an undefined state.
 *
 * The handlers are exported separately from their registration so the policy can be tested without
 * attaching listeners to the real process.
 */

/** Runs `fn` with console.error silenced, so the suite output stays clean. */
function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

describe('process error policy', () => {
  it('treats an uncaught exception as fatal', () => {
    const fatal = [];
    const handlers = processErrorHandlers((err) => fatal.push(err));
    const boom = new Error('boom');

    quietly(() => handlers.uncaughtException(boom));

    assert.deepEqual(fatal, [boom]);
  });

  it('keeps running after an unhandled rejection', () => {
    // A dropped promise is recoverable and common on a public socket; taking the process down for one
    // would turn a missing .catch() into an outage.
    const fatal = [];
    const handlers = processErrorHandlers((err) => fatal.push(err));

    quietly(() => handlers.unhandledRejection(new Error('dropped')));

    assert.deepEqual(fatal, []);
  });

  it('reports an uncaught exception before handing it on', () => {
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    try {
      processErrorHandlers(() => {}).uncaughtException(new Error('boom'));
    } finally {
      console.error = original;
    }

    assert.equal(logged.length, 1);
    assert.match(logged[0], /uncaughtException/);
  });
});
