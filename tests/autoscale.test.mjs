import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideScale } from '../scripts/autoscale-policy.mjs';

/**
 * Unit tests for the autoscaling decision.
 *
 * The controller loop is thin I/O — sample every replica, decide, run `compose up --scale`. The decision
 * is the part with judgement in it, so it is a pure function and this is where it gets pinned down.
 * Flapping is the failure mode that matters: a scaler that oscillates is worse than none, because it
 * churns connections on every cycle.
 */

const policy = {
  min: 2,
  max: 6,
  /** Scale up above this many WebSocket connections per replica. */
  connectionsPerReplicaUp: 100,
  /** Scale down below this many. Deliberately well under `up`, or the two watermarks touch. */
  connectionsPerReplicaDown: 40,
  cooldownMs: 60_000,
};

const at = (overrides) => decideScale({ ...policy, cooldownRemainingMs: 0, ...overrides });

describe('decideScale', () => {
  it('holds when load sits between the watermarks', () => {
    const decision = at({ replicas: 3, connections: 210 }); // 70 each

    assert.equal(decision.target, 3);
    assert.match(decision.reason, /within/i);
  });

  it('adds a replica when load is above the upper watermark', () => {
    const decision = at({ replicas: 3, connections: 360 }); // 120 each

    assert.equal(decision.target, 4);
  });

  it('adds only one replica at a time, however far over it is', () => {
    // Jumping straight to the "right" number reacts to a spike that may already be over, and every
    // added replica costs a discovery window. One step per cooldown converges without overshooting.
    const decision = at({ replicas: 3, connections: 3_000 });

    assert.equal(decision.target, 4);
  });

  it('never goes above max', () => {
    const decision = at({ replicas: 6, connections: 6_000 });

    assert.equal(decision.target, 6);
    assert.match(decision.reason, /max/i);
  });

  it('removes a replica when load is below the lower watermark', () => {
    const decision = at({ replicas: 4, connections: 80 }); // 20 each

    assert.equal(decision.target, 3);
  });

  it('never goes below min', () => {
    const decision = at({ replicas: 2, connections: 0 });

    assert.equal(decision.target, 2);
    assert.match(decision.reason, /min/i);
  });

  it('refuses a scale-down that would immediately trip the upper watermark', () => {
    // 4 replicas, 150 connections: 37 each, under the down watermark. But at 3 replicas that is 50
    // each — still fine. At the boundary it is not: this is the case that makes a naive scaler
    // oscillate, removing a replica and adding it straight back on the next tick.
    const decision = at({ replicas: 3, connections: 115 }); // 38 each now, 57 at 2 replicas

    assert.equal(decision.target, 2, 'this one is safe to shrink');

    const risky = at({ replicas: 3, connections: 39 * 3, connectionsPerReplicaDown: 40, connectionsPerReplicaUp: 50 });
    assert.equal(risky.target, 3, 'shrinking would put it over the up watermark, so hold');
    assert.match(risky.reason, /flap/i);
  });

  it('does nothing at all while cooling down', () => {
    const decision = at({ replicas: 3, connections: 9_000, cooldownRemainingMs: 12_000 });

    assert.equal(decision.target, 3);
    assert.match(decision.reason, /cool(ing|down)/i);
  });

  it('reports the load it based the decision on', () => {
    // The log line is the only window into why a scaler did something; it has to carry the numbers.
    const decision = at({ replicas: 3, connections: 360 });

    assert.equal(decision.connectionsPerReplica, 120);
  });

  it('does not divide by zero when no replica is answering', () => {
    const decision = at({ replicas: 0, connections: 0 });

    assert.equal(decision.target, policy.min);
    assert.ok(Number.isFinite(decision.connectionsPerReplica));
  });
});
