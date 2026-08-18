/**
 * `npm run test:postman` — the Postman collection run against a stack the autoscaler is moving.
 *
 * Postman has no shell, so a collection can never *cause* scaling. This driver supplies the half Postman
 * cannot: drive load, run the real autoscaler (`scripts/autoscale.mjs`, not a reimplementation of its
 * decision), and re-run the collection once per phase with the before/after counts injected. Postman
 * does the verification — that the topology the autoscaler claims to have produced is the one actually
 * serving traffic, that every replica it started is fully wired, and that the whole system still agrees
 * with itself at each size.
 *
 * Three phases:
 *   baseline      the stack as found
 *   scaled-up     after load pushed the autoscaler up at least one replica
 *   scaled-down   after the load went away and it shed at least one
 *
 * If autoscaling does not happen, the scaled-up phase fails — it asserts the count went up.
 *
 *   npm run test:postman
 *   npm run test:postman -- --sockets 20      # more load, to climb further
 *
 * The replica count it found is restored at the end, including on failure.
 */
import { execFileSync, spawnSync } from 'node:child_process';

const BASE = process.env.RELAY_URL || 'http://localhost:3000';
const ADMIN = process.env.ENVOY_ADMIN || 'http://localhost:9901';

const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const SOCKETS = flag('sockets', 16);
const SCALE_BUDGET_MS = flag('budget', 120) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}-${process.hrtime.bigint().toString(36)}`;
const sh = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const section = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

const runningReplicas = () =>
  sh('docker', ['compose', 'ps', 'api', '--format', '{{.Name}}']).split('\n').filter(Boolean).length;

const healthyReplicas = () =>
  sh('docker', ['compose', 'ps', 'api', '--format', '{{.Status}}'])
    .split('\n')
    .filter((l) => l.includes('healthy')).length;

async function envoyEndpoints() {
  const text = await (await fetch(`${ADMIN}/clusters`)).text();
  return text.split('\n').filter((l) => l.startsWith('api::') && l.includes('::health_flags::healthy')).length;
}

/** Waits until the stack has settled at `n`: containers healthy and the proxy agreeing. */
async function settleAt(n, budgetMs = 90_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (healthyReplicas() === n && (await envoyEndpoints()) === n) return true;
    await sleep(1_000);
  }
  return false;
}

/** How many replicas are answering through the proxy right now. */
async function servingReplicas(samples = 24) {
  const seen = new Set();
  for (let i = 0; i < samples; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      const instance = res.headers.get('x-relay-instance');
      if (instance) seen.add(instance);
    } catch {
      /* a replica mid-restart is expected */
    }
  }
  return seen.size;
}

/** Opens sockets and keeps them open — the load signal the autoscaler reacts to. */
async function openLoad(count) {
  const conv = await (
    await fetch(`${BASE}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: uid('postman-load'), participantIds: [1, 2] }),
    })
  ).json();

  const sockets = [];
  for (let i = 0; i < count; i++) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws open timeout')), 10_000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); }, { once: true });
    });
    ws.addEventListener('error', () => {});
    ws.send(JSON.stringify({ type: 'subscribe', userId: i % 2 ? 2 : 1, conversationIds: [conv.id] }));
    sockets.push(ws);
  }
  return {
    close: async () => {
      for (const ws of sockets) ws.close();
      await sleep(2_000);
    },
  };
}

/**
 * Runs the real autoscaler a tick at a time until the replica count moves, or the budget runs out.
 *
 * `--once` per tick on purpose: the cooldown lives in the autoscaler process, so one-shot invocations
 * let this drive it as fast as the stack can settle without reaching into its policy. The decision being
 * made is still entirely the autoscaler's.
 */
async function autoscaleUntilChanged(from, direction) {
  const deadline = Date.now() + SCALE_BUDGET_MS;
  let ticks = 0;

  while (Date.now() < deadline) {
    ticks += 1;
    const tick = spawnSync('node', ['scripts/autoscale.mjs', '--once', '--min', '2', '--max', '6'], {
      encoding: 'utf8',
    });
    for (const line of (tick.stdout || '').trim().split('\n')) {
      if (line.trim()) console.log(`    ${line}`);
    }

    const now = runningReplicas();
    const moved = direction === 'up' ? now > from : now < from;
    if (moved) {
      await settleAt(now);
      return { replicas: now, ticks };
    }
    await sleep(3_000);
  }
  return { replicas: runningReplicas(), ticks };
}

function runCollection({ phase, previousReplicas, expectedReplicas }) {
  const result = spawnSync(
    'npx',
    [
      '--yes',
      'newman',
      'run',
      'postman/relay-scaling.postman_collection.json',
      '-e',
      'postman/relay-local.postman_environment.json',
      '--env-var',
      `expectedReplicas=${expectedReplicas}`,
      '--env-var',
      `previousReplicas=${previousReplicas}`,
      '--env-var',
      `phase=${phase}`,
      '--reporters',
      'cli',
    ],
    { encoding: 'utf8' },
  );

  const out = result.stdout || '';
  for (const line of out.split('\n')) {
    if (/^\s{2}(✓|\d+\.)/.test(line) || /assertions|failed/.test(line)) console.log(line);
  }
  return result.status === 0;
}

/* ------------------------------------------------------------------------ run */

const started = runningReplicas();
let load;
const phases = [];

try {
  if (!(await settleAt(started))) {
    throw new Error(`the stack is not settled at ${started} replicas; start it before running this`);
  }

  section(`PHASE 1 — baseline: ${started} replica(s), as found`);
  const baselineServing = await servingReplicas();
  phases.push({
    phase: 'baseline',
    ok: runCollection({ phase: 'baseline', previousReplicas: baselineServing, expectedReplicas: baselineServing }),
    replicas: baselineServing,
  });

  section(`PHASE 2 — scaled up by the autoscaler`);
  console.log(`  opening ${SOCKETS} sockets to push connections per replica over the up watermark…`);
  load = await openLoad(SOCKETS);
  console.log('  running scripts/autoscale.mjs one tick at a time until it moves:');
  const up = await autoscaleUntilChanged(started, 'up');
  console.log(`  autoscaler went ${started} → ${up.replicas} in ${up.ticks} tick(s)`);
  const upServing = await servingReplicas();
  phases.push({
    phase: 'scaled-up',
    ok: runCollection({ phase: 'scaled-up', previousReplicas: started, expectedReplicas: upServing }),
    replicas: upServing,
  });

  section(`PHASE 3 — scaled down by the autoscaler`);
  console.log('  dropping the load…');
  await load.close();
  load = undefined;
  console.log('  running scripts/autoscale.mjs one tick at a time until it moves:');
  const down = await autoscaleUntilChanged(up.replicas, 'down');
  console.log(`  autoscaler went ${up.replicas} → ${down.replicas} in ${down.ticks} tick(s)`);
  const downServing = await servingReplicas();
  phases.push({
    phase: 'scaled-down',
    ok: runCollection({ phase: 'scaled-down', previousReplicas: up.replicas, expectedReplicas: downServing }),
    replicas: downServing,
  });
} finally {
  await load?.close();
  if (runningReplicas() !== started) {
    console.log(`\n  restoring ${started} replica(s)`);
    sh('docker', ['compose', 'up', '-d', '--no-deps', '--scale', `api=${started}`, 'api']);
    await settleAt(started);
  }
}

section('SUMMARY');
for (const p of phases) {
  console.log(`  ${p.ok ? 'PASS' : 'FAIL'}  ${p.phase.padEnd(12)} ${p.replicas} replica(s)`);
}
const failed = phases.filter((p) => !p.ok);
console.log(
  `\n  ${phases.length - failed.length}/${phases.length} phases passed — ` +
    (failed.length ? 'see the failing assertions above' : 'autoscaling verified end to end'),
);
process.exit(failed.length ? 1 : 0);
