import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KNOWN_SIGNALS,
  decideScale,
  validateBounds,
  validateRules,
} from '../scripts/autoscale-policy.mjs';

/**
 * Unit tests for the autoscaling decision.
 *
 * The controller loop is thin I/O — sample every replica, decide, run `compose up --scale`. The decision
 * is the part with judgement in it, so it is a pure function and this is where it gets pinned down.
 *
 * Two failure modes matter more than "does it scale at all":
 *  - **Flapping.** A scaler that oscillates is worse than none: it churns connections every cycle.
 *  - **A rule that silently does nothing.** A typo in a signal name, or a rule that can never fire, looks
 *    identical to a quiet system.
 */

const replica = (connections, cpuPercent = 0, memoryMb = 0) => ({
  connections,
  cpuPercent,
  memoryMb,
});

/** Rules mirroring autoscale.config.json, so the tests exercise the shipped shape. */
const connectionsRule = { signal: 'connections', up: 100, down: 40 };
const cpuRule = { signal: 'cpu', up: 70, down: 20 };
const memoryRule = { signal: 'memory', up: 400, down: 150, proportional: false };

const decide = (overrides) =>
  decideScale({
    min: 2,
    max: 6,
    rules: [connectionsRule],
    cooldownRemainingMs: 0,
    ...overrides,
  });

describe('decideScale · a single connections rule', () => {
  it('holds when the signal sits between the watermarks', () => {
    const d = decide({ replicas: 3, metrics: [replica(70), replica(70), replica(70)] });

    assert.equal(d.target, 3);
    assert.match(d.reason, /within/i);
  });

  it('adds a replica when the signal is above the up watermark', () => {
    const d = decide({ replicas: 3, metrics: [replica(120), replica(120), replica(120)] });

    assert.equal(d.target, 4);
    assert.match(d.reason, /connections/);
  });

  it('adds only one replica at a time, however far over it is', () => {
    // Jumping to the "right" number reacts to a spike that may already be over, and each added replica
    // costs its own discovery window. One step per cooldown still converges.
    const d = decide({ replicas: 3, metrics: [replica(5_000), replica(5_000), replica(5_000)] });

    assert.equal(d.target, 4);
  });

  it('removes a replica when the signal is below the down watermark', () => {
    const d = decide({
      replicas: 4,
      metrics: [replica(20), replica(20), replica(20), replica(20)],
    });

    assert.equal(d.target, 3);
  });

  it('never goes above max', () => {
    const d = decide({ replicas: 6, metrics: Array.from({ length: 6 }, () => replica(9_999)) });

    assert.equal(d.target, 6);
    assert.match(d.reason, /max/i);
  });

  it('never goes below min', () => {
    const d = decide({ replicas: 2, metrics: [replica(0), replica(0)] });

    assert.equal(d.target, 2);
    assert.match(d.reason, /min/i);
  });

  /**
   * `min` used to be consulted only on the way down, so a stack that ended up under it — a manual
   * `--scale`, a crash-looping replica, a restore — sat there forever, reporting "already at min 2"
   * while running one replica. A floor is a floor in both directions.
   */
  it('climbs back to min when it finds itself below the floor', () => {
    const d = decide({ replicas: 1, metrics: [replica(0)] });

    assert.equal(d.target, 2);
    assert.match(d.reason, /below the minimum/i);
  });

  it('restores the floor even when the signal is mid-band', () => {
    // Nothing about the load says "scale up" — the floor alone is the reason.
    const d = decide({ replicas: 1, metrics: [replica(70)] });

    assert.equal(d.target, 2);
    assert.match(d.reason, /below the minimum/i);
  });

  it('restores the floor in one step rather than climbing to it one replica at a time', () => {
    // Load-driven scale-up is deliberately +1 per tick; a floor is a constraint, not a response to
    // load, and leaving the stack under-provisioned for three more cooldowns serves nobody.
    const d = decide({ replicas: 1, metrics: [replica(0)], min: 4 });

    assert.equal(d.target, 4);
  });

  it('restoring the floor outranks the cooldown', () => {
    // Same reasoning as the no-replica-answered case, which already bypasses it: a cooldown exists to
    // stop load-chasing churn, not to hold a stack below its own minimum.
    const d = decide({ replicas: 1, metrics: [replica(0)], cooldownRemainingMs: 12_000 });

    assert.equal(d.target, 2);
    assert.match(d.reason, /below the minimum/i);
  });

  it('still reports being *at* the floor accurately', () => {
    const d = decide({ replicas: 2, metrics: [replica(0), replica(0)] });

    assert.equal(d.target, 2);
    assert.match(d.reason, /already at min/i);
  });

  /**
   * The mirror of the floor above. `max` was consulted only on the way up, so a stack that ended up
   * over the ceiling came down solely if load happened to sit under the down watermark — mid-band
   * load held it there indefinitely, paying for replicas the operator had capped.
   */
  it('comes back down to max when it finds itself above the ceiling', () => {
    const d = decide({ replicas: 8, metrics: Array.from({ length: 8 }, () => replica(0)) });

    assert.equal(d.target, 6);
    assert.match(d.reason, /above the maximum/i);
  });

  it('returns to the ceiling even when the signal is mid-band', () => {
    // Nothing about the load says "scale down" — the ceiling alone is the reason.
    const d = decide({ replicas: 8, metrics: Array.from({ length: 8 }, () => replica(70)) });

    assert.equal(d.target, 6);
    assert.match(d.reason, /above the maximum/i);
  });

  it('returns to the ceiling in one step rather than shedding one replica at a time', () => {
    const d = decide({ replicas: 9, metrics: Array.from({ length: 9 }, () => replica(0)) });

    assert.equal(d.target, 6);
  });

  it('returning to the ceiling outranks the cooldown', () => {
    const d = decide({
      replicas: 8,
      metrics: Array.from({ length: 8 }, () => replica(0)),
      cooldownRemainingMs: 12_000,
    });

    assert.equal(d.target, 6);
    assert.match(d.reason, /above the maximum/i);
  });

  it('still reports being *at* the ceiling accurately', () => {
    const d = decide({ replicas: 6, metrics: Array.from({ length: 6 }, () => replica(9_999)) });

    assert.equal(d.target, 6);
    assert.match(d.reason, /already at max/i);
  });

  /**
   * Two hard bounds can be made to fight each other. With min above max, a floor that pushes up and a
   * ceiling that pushes down would alternate forever — one scaling action per tick, for the life of
   * the process. validateBounds refuses that configuration up front, and this pins the pure function
   * so it cannot oscillate even when handed bounds nobody validated.
   */
  it('cannot be made to oscillate by bounds that cross', () => {
    const bounds = { min: 4, max: 2 };
    const below = decide({ replicas: 1, metrics: [replica(0)], ...bounds });
    assert.equal(below.target, 4, 'the floor wins when the bounds contradict');

    const settled = decide({
      replicas: 4,
      metrics: Array.from({ length: 4 }, () => replica(0)),
      ...bounds,
    });
    assert.equal(settled.target, 4, 'and having got there, it is not pushed straight back down');
  });

  it('does nothing at all while cooling down', () => {
    const d = decide({
      replicas: 3,
      metrics: [replica(9_000), replica(9_000), replica(9_000)],
      cooldownRemainingMs: 12_000,
    });

    assert.equal(d.target, 3);
    assert.match(d.reason, /cool(ing|down)/i);
  });

  it('asks for the floor when no replica answered', () => {
    const d = decide({ replicas: 0, metrics: [] });

    assert.equal(d.target, 2);
  });
});

describe('decideScale · choosing the signal', () => {
  it('scales on cpu when that is the configured rule', () => {
    const d = decide({
      rules: [cpuRule],
      replicas: 3,
      metrics: [replica(0, 90), replica(0, 90), replica(0, 90)],
    });

    assert.equal(d.target, 4);
    assert.match(d.reason, /cpu/);
  });

  it('scales on memory when that is the configured rule', () => {
    const d = decide({
      rules: [memoryRule],
      replicas: 3,
      metrics: [replica(0, 0, 600), replica(0, 0, 600), replica(0, 0, 600)],
    });

    assert.equal(d.target, 4);
    assert.match(d.reason, /memory/);
  });

  it('rejects a rule naming a signal it does not know', () => {
    // A typo'd signal that silently disabled the rule would be indistinguishable from a quiet system —
    // the worst way for a scaler to fail.
    assert.throws(
      () =>
        decide({
          rules: [{ signal: 'diskio', up: 10, down: 1 }],
          replicas: 3,
          metrics: [replica(0)],
        }),
      /diskio/,
    );
  });

  it('reports every signal it evaluated, with the value it used', () => {
    // The log line is the only window into why a scaler did something.
    const d = decide({
      rules: [connectionsRule, cpuRule],
      replicas: 2,
      metrics: [replica(60, 10), replica(40, 30)],
    });

    assert.deepEqual(
      d.signals.map((s) => [s.signal, s.value]),
      [
        ['connections', 50],
        ['cpu', 20],
      ],
    );
  });
});

describe('decideScale · aggregating across replicas', () => {
  it('averages by default, so one busy replica does not decide alone', () => {
    const d = decide({ replicas: 3, metrics: [replica(300), replica(0), replica(0)] });

    assert.equal(d.signals[0].value, 100);
    assert.equal(d.target, 3, '100 is not above the up watermark of 100');
  });

  it('takes the hottest replica when the rule says max', () => {
    // Right for CPU: one saturated event loop is a real problem even if the mean looks calm.
    const d = decide({
      rules: [{ ...cpuRule, aggregate: 'max' }],
      replicas: 3,
      metrics: [replica(0, 95), replica(0, 5), replica(0, 5)],
    });

    assert.equal(d.signals[0].value, 95);
    assert.equal(d.target, 4);
  });
});

describe('decideScale · combining several rules', () => {
  it('scales up if any single rule wants to', () => {
    // Same as a Kubernetes HPA with several metrics: the strongest recommendation wins, because being
    // over on any resource is enough to hurt.
    const d = decide({
      rules: [connectionsRule, cpuRule],
      replicas: 3,
      metrics: [replica(10, 95), replica(10, 95), replica(10, 95)],
    });

    assert.equal(d.target, 4);
    assert.match(d.reason, /cpu/);
  });

  it('only scales down when every rule agrees', () => {
    // Shedding a replica because connections are low, while CPU is pinned, would make things worse.
    const d = decide({
      rules: [connectionsRule, cpuRule],
      replicas: 4,
      metrics: Array.from({ length: 4 }, () => replica(10, 50)),
    });

    assert.equal(d.target, 4);
    assert.match(d.reason, /cpu/, 'the reason should name the rule that blocked it');
  });

  it('scales down when they do agree', () => {
    const d = decide({
      rules: [connectionsRule, cpuRule],
      replicas: 4,
      metrics: Array.from({ length: 4 }, () => replica(10, 5)),
    });

    assert.equal(d.target, 3);
  });
});

describe('decideScale · not flapping', () => {
  it('refuses a scale-down that would push a proportional signal over its up watermark', () => {
    // 3 replicas at 39 connections each is under the down watermark of 40. At 2 replicas that is 58
    // each — still under 100, so this one is safe.
    const safe = decide({ replicas: 3, metrics: [replica(39), replica(39), replica(39)] });
    assert.equal(safe.target, 2);

    // Narrow the band so shrinking would cross it: 39 each now, 58 at 2 replicas, up watermark 50.
    const risky = decide({
      rules: [{ signal: 'connections', up: 50, down: 40 }],
      replicas: 3,
      metrics: [replica(39), replica(39), replica(39)],
    });
    assert.equal(risky.target, 3);
    assert.match(risky.reason, /flap/i);
  });

  it('does not project a signal that does not redistribute', () => {
    // Memory is marked non-proportional: a replica's baseline heap does not move to its neighbours when
    // it goes away, so projecting `value * n / (n-1)` would block scale-downs that are perfectly safe.
    const d = decide({
      rules: [{ signal: 'memory', up: 200, down: 190, proportional: false }],
      replicas: 3,
      metrics: [replica(0, 0, 180), replica(0, 0, 180), replica(0, 0, 180)],
    });

    assert.equal(d.target, 2);
  });
});

describe('validateRules', () => {
  // Written after the code rather than before it, and then checked against each case it claims to catch —
  // the controller refuses to start on any of these, so a false negative here means a scaler that runs and
  // silently decides nothing.
  it('accepts a well-formed rule', () => {
    assert.deepEqual(validateRules([{ signal: 'cpu', up: 70, down: 20 }]), []);
  });

  it('rejects an empty rule set instead of scaling on nothing', () => {
    assert.equal(validateRules([]).length, 1);
    assert.match(validateRules([])[0], /at least one/);
  });

  it('rejects a signal it does not know, and says what it does know', () => {
    const [problem] = validateRules([{ signal: 'diskio', up: 10, down: 1 }]);

    assert.match(problem, /diskio/);
    for (const known of KNOWN_SIGNALS) assert.match(problem, new RegExp(known));
  });

  it('rejects an aggregate it does not know', () => {
    assert.match(
      validateRules([{ signal: 'cpu', up: 70, down: 20, aggregate: 'median' }])[0],
      /median/,
    );
  });

  it('rejects watermarks that touch, because that is an oscillator', () => {
    assert.match(validateRules([{ signal: 'cpu', up: 50, down: 50 }])[0], /flap/);
    assert.match(validateRules([{ signal: 'cpu', up: 20, down: 70 }])[0], /flap/);
  });

  it('rejects non-numeric watermarks', () => {
    assert.match(validateRules([{ signal: 'cpu', up: '70', down: 20 }])[0], /numeric/);
  });

  it('rejects bounds that cross, because two hard bounds fighting is an oscillator', () => {
    const problems = validateBounds({ min: 4, max: 2 });

    assert.equal(problems.length, 1);
    assert.match(problems[0], /min.*4.*above.*max.*2/i);
  });

  it('accepts a min equal to max, which pins the replica count', () => {
    assert.deepEqual(validateBounds({ min: 3, max: 3 }), []);
  });

  it('rejects bounds that are not usable replica counts', () => {
    assert.equal(validateBounds({ min: 0, max: 6 }).length, 1);
    assert.equal(validateBounds({ min: 2, max: 'six' }).length, 1);
  });

  it('reports every problem, not just the first', () => {
    const problems = validateRules([
      { signal: 'nope', up: 1, down: 0 },
      { signal: 'cpu', up: 10, down: 90 },
    ]);

    assert.equal(problems.length, 2);
  });
});
