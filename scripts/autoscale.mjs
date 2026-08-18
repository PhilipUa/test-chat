/**
 * A load-driven autoscaler for the api service.
 *
 * Compose has no autoscaler — `--scale N` is a number a human types — so this is the missing control
 * loop: sample the load, decide, run `compose up --scale`, wait out a cooldown, repeat. The decision is
 * `autoscale-policy.mjs` and is unit tested; everything here is the I/O around it.
 *
 *   node scripts/autoscale.mjs --dry-run        # decide and log, change nothing
 *   node scripts/autoscale.mjs --once           # a single tick
 *   node scripts/autoscale.mjs                  # run until Ctrl-C
 *   node scripts/autoscale.mjs --up 2 --down 1 --min 2 --max 6 --interval 10
 *
 * ## What this is and is not
 *
 * It is a real control loop, and honest about being a demonstration of one. It runs on the host because
 * scaling Compose needs the docker CLI, and the alternative — a container with `/var/run/docker.sock`
 * mounted — hands root-equivalent access to anything that can reach that container. That trade is not
 * worth making for a demo, and in production the answer is not this script at all: it is a Kubernetes
 * HPA (or equivalent) scaling a Deployment, where the scaling authority already exists and is scoped.
 *
 * What is worth keeping from it either way: the *signal*. A HPA on CPU would be wrong for this app for
 * the same reason it is wrong here — see autoscale-policy.mjs.
 */
import { execFileSync } from 'node:child_process';
import { decideScale } from './autoscale-policy.mjs';

const BASE = process.env.RELAY_URL || 'http://localhost:3000';

const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const has = (name) => process.argv.includes(`--${name}`);

const config = {
  min: flag('min', 2),
  max: flag('max', 6),
  // Deliberately low defaults so the loop is observable on a demo stack — a handful of browser tabs is
  // enough to move it. Real numbers would be in the thousands.
  connectionsPerReplicaUp: flag('up', 2),
  connectionsPerReplicaDown: flag('down', 1),
  cooldownMs: flag('cooldown', 30) * 1000,
  intervalMs: flag('interval', 10) * 1000,
};
const dryRun = has('dry-run');
const once = has('once');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

const sh = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Total WebSocket connections and how many replicas answered.
 *
 * Replicas are not individually addressable from the host, so this samples through the proxy until it
 * stops finding new instance ids — round-robin gets to all of them. Each reports its own connection
 * count, and `X-Relay-Instance` is what makes the samples attributable.
 */
async function sampleLoad(samples = 24) {
  const byInstance = new Map();
  for (let i = 0; i < samples; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      const instance = res.headers.get('x-relay-instance');
      const body = await res.json();
      if (instance) byInstance.set(instance, body.connections ?? 0);
    } catch {
      // A replica mid-restart refusing a connection is expected; the sample just misses it.
    }
  }
  const connections = [...byInstance.values()].reduce((n, c) => n + c, 0);
  return { replicas: byInstance.size, connections, byInstance };
}

const scaleTo = (n) =>
  sh('docker', ['compose', 'up', '-d', '--no-deps', '--scale', `api=${n}`, 'api']);

let cooldownUntil = 0;

async function tick() {
  const { replicas, connections, byInstance } = await sampleLoad();

  const decision = decideScale({
    replicas,
    connections,
    ...config,
    cooldownRemainingMs: Math.max(0, cooldownUntil - Date.now()),
  });

  const detail = [...byInstance.entries()].map(([id, n]) => `${id}=${n}`).join(' ');
  if (decision.target === replicas) {
    log(`hold at ${replicas} — ${decision.reason}`);
    if (detail) log(`  per replica: ${detail}`);
    return;
  }

  const direction = decision.target > replicas ? 'up' : 'down';
  log(`scale ${direction}: ${replicas} → ${decision.target} — ${decision.reason}`);
  if (detail) log(`  per replica: ${detail}`);

  if (dryRun) {
    log('  --dry-run, so not touching the stack');
    return;
  }

  try {
    scaleTo(decision.target);
    // The cooldown starts when the change is issued, not when it converges: the discovery window is
    // part of what we are waiting out.
    cooldownUntil = Date.now() + config.cooldownMs;
    log(`  scaled; cooling down for ${config.cooldownMs / 1000}s`);
  } catch (err) {
    log(`  scaling failed: ${err.message.split('\n')[0]}`);
  }
}

log(
  `autoscaler watching ${BASE} — min=${config.min} max=${config.max} ` +
    `up>${config.connectionsPerReplicaUp} down<${config.connectionsPerReplicaDown} ` +
    `every ${config.intervalMs / 1000}s, cooldown ${config.cooldownMs / 1000}s` +
    (dryRun ? ' (dry run)' : ''),
);

if (once) {
  await tick();
} else {
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
    log('stopping (the stack is left at whatever it was last scaled to)');
  });
  while (!stopping) {
    await tick();
    await sleep(config.intervalMs);
  }
}
