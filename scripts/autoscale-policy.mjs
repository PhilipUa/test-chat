/**
 * The autoscaling decision, as a pure function.
 *
 * Separated from the controller loop in `autoscale.mjs` because this is the part with judgement in it —
 * the loop is sampling and shelling out. Everything here is decided from numbers passed in, so it is
 * unit tested (`tests/autoscale.test.mjs`) rather than only observable by watching a stack move.
 *
 * ## Signals
 *
 * Which signal to scale on is configuration, not a decision baked in here (`autoscale.config.json`).
 * Three are understood:
 *
 *  - `connections` — WebSocket connections held by a replica. For a chat app this is usually the resource
 *    that runs out first: each connection is a live socket, a place in the heartbeat sweep, and a share of
 *    the fan-out.
 *  - `cpu` — percent of **one** core, from the process's own `cpuUsage()`. One core, not all of them,
 *    because a Node process is effectively single-threaded: 100% means the event loop is saturated, which
 *    is the number that matters. A percentage of 15 cores would never trip.
 *  - `memory` — resident set size in MB, absolute rather than a percentage. A percentage needs a limit,
 *    and when no container memory limit is set the only "limit" available is the host's RAM, which makes
 *    the percentage meaningless.
 *  - `rpm` — HTTP requests per minute served by a replica, over a sliding one-minute window. Excludes
 *    `/api/health`, because the autoscaler polls it to find replicas and a metric that rises when you
 *    measure it would climb to `max` on its own.
 *
 * The default config scales on connections. CPU is the conventional choice and would be the wrong default
 * here for the same reason it would be wrong under a Kubernetes HPA: an instance holding 10,000 idle
 * sockets is near its limit and looks unloaded.
 *
 * ## Combining rules
 *
 * Up if **any** rule wants up; down only if **every** rule agrees. That is what a Kubernetes HPA does with
 * several metrics, and for the same reason: being over on any one resource is enough to hurt, while being
 * under on one is not enough to be safe.
 */

/** value in the units the rule is written in, per replica. */
const SIGNALS = {
  connections: { read: (m) => m.connections ?? 0, unit: '', proportional: true },
  cpu: { read: (m) => m.cpuPercent ?? 0, unit: '%', proportional: true },
  // A replica's baseline heap does not move to its neighbours when it goes away, so projecting what
  // memory would be after a scale-down is not sound — see the anti-flap check below.
  memory: { read: (m) => m.memoryMb ?? 0, unit: 'MB', proportional: false },
  rpm: { read: (m) => m.rpm ?? 0, unit: '/min', proportional: true },
};

const AGGREGATES = {
  mean: (values) => values.reduce((n, v) => n + v, 0) / values.length,
  max: (values) => Math.max(...values),
};

/** For validating configuration up front — a typo should be a readable error, not a stack trace. */
export const KNOWN_SIGNALS = Object.keys(SIGNALS);
export const KNOWN_AGGREGATES = Object.keys(AGGREGATES);

/**
 * Checks a rule set, returning the problems as readable strings.
 *
 * decideScale throws on the same mistakes — that is the library guard. This exists so the controller can
 * refuse to start with a bad config instead of dying on its first tick, because a scaler that exits
 * immediately looks a lot like a scaler that is quietly running.
 */
export function validateRules(rules) {
  const problems = [];
  if (!Array.isArray(rules) || rules.length === 0) {
    return ['no rules configured — autoscaling needs at least one'];
  }
  for (const rule of rules) {
    if (!SIGNALS[rule.signal]) {
      problems.push(
        `unknown signal "${rule.signal}" — expected one of ${KNOWN_SIGNALS.join(', ')}`,
      );
      continue;
    }
    if (rule.aggregate && !AGGREGATES[rule.aggregate]) {
      problems.push(
        `unknown aggregate "${rule.aggregate}" for ${rule.signal} — expected one of ${KNOWN_AGGREGATES.join(', ')}`,
      );
    }
    if (!Number.isFinite(rule.up) || !Number.isFinite(rule.down)) {
      problems.push(`${rule.signal} needs numeric up and down watermarks`);
    } else if (rule.down >= rule.up) {
      // Touching watermarks are the classic way to build an oscillator.
      problems.push(
        `${rule.signal} has down (${rule.down}) at or above up (${rule.up}) — leave a gap, or it will flap`,
      );
    }
  }
  return problems;
}

/**
 * @param {object} input
 * @param {number} input.replicas   how many replicas answered
 * @param {Array<{connections?: number, cpuPercent?: number, memoryMb?: number}>} input.metrics one per replica
 * @param {Array<{signal: string, up: number, down: number, aggregate?: 'mean'|'max', proportional?: boolean}>} input.rules
 * @param {number} input.min
 * @param {number} input.max
 * @param {number} [input.cooldownRemainingMs]
 * @returns {{target: number, reason: string, signals: Array<object>}}
 */
export function decideScale({
  replicas,
  metrics = [],
  rules = [],
  min,
  max,
  cooldownRemainingMs = 0,
}) {
  if (!rules.length) throw new Error('autoscaling needs at least one rule');

  for (const rule of rules) {
    if (!SIGNALS[rule.signal]) {
      throw new Error(
        `unknown autoscaling signal "${rule.signal}" — expected one of ${Object.keys(SIGNALS).join(', ')}`,
      );
    }
  }

  // Nothing is answering — that is a job for the health check and the restart policy, not for a scaler
  // reasoning about load it cannot see. Ask for the floor and let the stack come back.
  if (replicas === 0 || metrics.length === 0) {
    return {
      target: min,
      reason: `no replica answered; asking for the minimum of ${min}`,
      signals: [],
    };
  }

  const signals = rules.map((rule) => {
    const spec = SIGNALS[rule.signal];
    const aggregateName = rule.aggregate ?? 'mean';
    const aggregate = AGGREGATES[aggregateName];
    if (!aggregate) {
      throw new Error(
        `unknown aggregate "${aggregateName}" — expected one of ${Object.keys(AGGREGATES).join(', ')}`,
      );
    }

    const value = aggregate(metrics.map((m) => spec.read(m)));
    const verdict = value > rule.up ? 'up' : value < rule.down ? 'down' : 'hold';

    return {
      signal: rule.signal,
      value,
      up: rule.up,
      down: rule.down,
      aggregate: aggregateName,
      unit: spec.unit,
      proportional: rule.proportional ?? spec.proportional,
      verdict,
      describe() {
        return (
          `${aggregateName} ${this.signal} ${this.value.toFixed(1)}${this.unit} per replica ` +
          `(up>${this.up}${this.unit} down<${this.down}${this.unit})`
        );
      },
    };
  });

  const hold = (reason) => ({ target: replicas, reason, signals });

  // A cooldown outranks the load, deliberately. Reacting on every tick is how a scaler turns a brief spike
  // into a churn of connections, and every change costs a discovery window plus the sockets on whatever
  // replica leaves.
  if (cooldownRemainingMs > 0) {
    return hold(`cooling down for another ${Math.ceil(cooldownRemainingMs / 1000)}s`);
  }

  const wantsUp = signals.filter((s) => s.verdict === 'up');
  if (wantsUp.length) {
    const because = wantsUp.map((s) => s.describe()).join('; ');
    if (replicas >= max) return hold(`over on ${because}, but already at max ${max}`);
    // One step at a time: see the note on `up` in the header.
    return { target: replicas + 1, reason: `above the watermark on ${because}`, signals };
  }

  const blocking = signals.filter((s) => s.verdict !== 'down');
  if (blocking.length) {
    // Worth distinguishing: every signal sitting comfortably in band is the steady state, whereas some
    // wanting to shrink and others refusing is the interesting case to see in a log.
    const settled =
      blocking.length === signals.length && signals.every((s) => s.verdict === 'hold');
    const detail = blocking.map((s) => s.describe()).join('; ');
    return hold(
      settled ? `within the watermarks — ${detail}` : `not every rule wants to shrink — ${detail}`,
    );
  }

  if (replicas <= min) {
    return hold(`under on every rule, but already at min ${min}`);
  }

  // The anti-flap check, and the reason this is a function worth testing: shedding a replica raises the
  // load on the ones that remain, and if that pushes them over an up watermark the next tick adds it
  // straight back. Two watermarks are not enough on their own.
  //
  // Only applied to signals that actually redistribute. Projecting memory this way would block
  // scale-downs that are perfectly safe, because a departing replica's baseline heap goes away with it.
  for (const s of signals) {
    if (!s.proportional) continue;
    const projected = (s.value * replicas) / (replicas - 1);
    if (projected > s.up) {
      return hold(
        `under on every rule, but shrinking to ${replicas - 1} would put ${s.signal} at ` +
          `${projected.toFixed(1)}${s.unit} and trip its up watermark of ${s.up}${s.unit} — would flap`,
      );
    }
  }

  return {
    target: replicas - 1,
    reason: `below the watermark on ${signals.map((s) => s.describe()).join('; ')}`,
    signals,
  };
}
