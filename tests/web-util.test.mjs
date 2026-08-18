import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maxOf } from '../web/js/util.js';

/**
 * Unit tests for the browser helpers that are pure enough to run under node.
 *
 * web/ has no build step and these modules are plain ESM, so the ones with no DOM dependency can be
 * imported directly — which is worth doing for anything whose failure mode is a crash rather than a
 * wrong pixel.
 */

describe('maxOf', () => {
  it('returns the largest id in the set', () => {
    assert.equal(maxOf(new Set([3, 17, 9])), 17);
  });

  it('returns 0 for an empty set, so a read receipt is simply skipped', () => {
    assert.equal(maxOf(new Set()), 0);
  });

  it('handles more ids than Math.max accepts as arguments', () => {
    // markRead did `Math.max(0, ...[...state.rendered])`, which spreads the set as function
    // arguments. Past roughly 65k ids that is a RangeError, so scrolling far enough back through a
    // long conversation broke every read receipt from then on.
    const many = new Set(Array.from({ length: 200_000 }, (_, i) => i + 1));

    assert.equal(maxOf(many), 200_000);
  });
});
