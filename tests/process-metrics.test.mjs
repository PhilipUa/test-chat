import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpuPercentBetween, memoryMbOf, ratePerMinute } from '../src/util/process-metrics.ts';

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

describe('ratePerMinute', () => {
  it('scales a count over its window to a per-minute rate', () => {
    assert.equal(ratePerMinute(30, 60), 30);
  });

  it('extrapolates a shorter window rather than understating the rate', () => {
    // Right after boot the window is only a few seconds long. Dividing by a full minute anyway would
    // report a twelfth of the real traffic, and a scaler would sit still through a genuine spike.
    assert.equal(ratePerMinute(30, 30), 60);
    assert.equal(ratePerMinute(10, 5), 120);
  });

  it('is zero for no requests', () => {
    assert.equal(ratePerMinute(0, 60), 0);
  });

  it('returns 0 rather than Infinity before any time has passed', () => {
    assert.equal(ratePerMinute(5, 0), 0);
  });

  it('reports a fractional rate rather than rounding quiet traffic to zero', () => {
    // 1 request a minute is not the same as none, and a `down` watermark has to be able to tell them apart.
    assert.equal(ratePerMinute(1, 60), 1);
    assert.ok(ratePerMinute(1, 120) > 0);
  });
});
