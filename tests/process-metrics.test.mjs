import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpuPercentBetween, memoryMbOf } from '../src/util/process-metrics.ts';

/**
 * Unit tests for the process metrics the autoscaler scales on.
 *
 * These are the numbers a scaling decision is made from, so getting the arithmetic wrong is not a
 * cosmetic bug — it silently scales on nonsense. Both are pure functions over samples passed in, so the
 * arithmetic is checkable without waiting for real load.
 */

describe('cpuPercentBetween', () => {
  it('reports percent of one core, not of all of them', () => {
    // A Node process is effectively single-threaded, so saturating one core is the number that matters.
    // 1s of CPU over 1s of wall clock is 100%, whatever the host's core count.
    const percent = cpuPercentBetween(
      { user: 0, system: 0 },
      { user: 1_000_000, system: 0 },
      1_000,
    );

    assert.equal(percent, 100);
  });

  it('counts system time as well as user time', () => {
    // Socket writes and epoll land in system time; ignoring it would understate a busy fan-out.
    const percent = cpuPercentBetween(
      { user: 0, system: 0 },
      { user: 250_000, system: 250_000 },
      1_000,
    );

    assert.equal(percent, 50);
  });

  it('is zero for an idle interval', () => {
    assert.equal(cpuPercentBetween({ user: 500, system: 500 }, { user: 500, system: 500 }, 1_000), 0);
  });

  it('can exceed 100 when worker threads are busy, rather than clamping a real signal away', () => {
    const percent = cpuPercentBetween({ user: 0, system: 0 }, { user: 2_000_000, system: 0 }, 1_000);

    assert.equal(percent, 200);
  });

  it('returns 0 rather than Infinity for a zero-length interval', () => {
    // The first sample after boot has no elapsed time to divide by.
    assert.equal(cpuPercentBetween({ user: 0, system: 0 }, { user: 1_000, system: 0 }, 0), 0);
  });

  it('never reports a negative percentage if a counter appears to go backwards', () => {
    assert.equal(cpuPercentBetween({ user: 1_000, system: 0 }, { user: 0, system: 0 }, 1_000), 0);
  });
});

describe('memoryMbOf', () => {
  it('converts resident bytes to whole MB', () => {
    assert.equal(memoryMbOf(44_412_928), 42);
  });

  it('is zero for zero', () => {
    assert.equal(memoryMbOf(0), 0);
  });
});
