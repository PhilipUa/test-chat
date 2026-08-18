/**
 * The autoscaling decision, as a pure function.
 *
 * Separated from the controller loop in `autoscale.mjs` because this is the part with judgement in it —
 * the loop is sampling and shelling out. Everything here is decided from numbers passed in, so it is
 * unit tested (`tests/autoscale.test.mjs`) rather than only observable by watching a stack move.
 *
 * The signal is **WebSocket connections per replica**. For a chat app that is the resource that actually
 * runs out first: each connection is a live socket, a place in the heartbeat sweep, and a share of the
 * fan-out. CPU would be the conventional choice and would be the wrong one here — an idle instance
 * holding 10,000 sockets is near its limit and looks unloaded.
 */

/**
 * @param {object} input
 * @param {number} input.replicas            how many replicas are answering right now
 * @param {number} input.connections         total WebSocket connections across all of them
 * @param {number} input.min                 never go below this
 * @param {number} input.max                 never go above this
 * @param {number} input.connectionsPerReplicaUp    add a replica above this
 * @param {number} input.connectionsPerReplicaDown  remove a replica below this
 * @param {number} input.cooldownRemainingMs  0 when free to act
 * @returns {{target: number, reason: string, connectionsPerReplica: number}}
 */
export function decideScale({
  replicas,
  connections,
  min,
  max,
  connectionsPerReplicaUp,
  connectionsPerReplicaDown,
  cooldownRemainingMs = 0,
}) {
  const perReplica = replicas > 0 ? connections / replicas : 0;
  const load = `${connections} connection(s) over ${replicas} replica(s) = ${perReplica.toFixed(1)} each`;
  const hold = (reason) => ({ target: replicas, reason, connectionsPerReplica: perReplica });

  // Nothing is answering — that is a job for the health check and the restart policy, not for a scaler
  // reasoning about load it cannot see. Ask for the floor and let the stack come back.
  if (replicas === 0) {
    return { target: min, reason: `no replica answered; asking for the minimum of ${min}`, connectionsPerReplica: 0 };
  }

  // A cooldown outranks the load, deliberately. Reacting on every tick is how a scaler turns a brief
  // spike into a churn of connections, and every change costs a discovery window plus the sockets on
  // whatever replica leaves.
  if (cooldownRemainingMs > 0) {
    return hold(`cooling down for another ${Math.ceil(cooldownRemainingMs / 1000)}s (${load})`);
  }

  if (perReplica > connectionsPerReplicaUp) {
    if (replicas >= max) return hold(`over the up watermark but already at max ${max} (${load})`);
    // One step at a time: jumping to the "right" number reacts to a spike that may already be over, and
    // each added replica costs its own discovery window. One step per cooldown still converges.
    return {
      target: replicas + 1,
      reason: `above ${connectionsPerReplicaUp} per replica (${load})`,
      connectionsPerReplica: perReplica,
    };
  }

  if (perReplica < connectionsPerReplicaDown) {
    if (replicas <= min) return hold(`under the down watermark but already at min ${min} (${load})`);

    // The anti-flap check, and the reason this is a function worth testing: shedding a replica raises
    // the load on the ones that remain, and if that pushes them over the up watermark the next tick
    // adds it straight back. Two watermarks are not enough on their own.
    const afterShrink = connections / (replicas - 1);
    if (afterShrink > connectionsPerReplicaUp) {
      return hold(
        `under the down watermark, but shrinking to ${replicas - 1} would mean ` +
          `${afterShrink.toFixed(1)} each and trip the up watermark — would flap (${load})`,
      );
    }

    return {
      target: replicas - 1,
      reason: `below ${connectionsPerReplicaDown} per replica (${load})`,
      connectionsPerReplica: perReplica,
    };
  }

  return hold(
    `within ${connectionsPerReplicaDown}–${connectionsPerReplicaUp} per replica (${load})`,
  );
}
