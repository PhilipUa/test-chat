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
 *   npm run test:postman                        # the connections signal
 *   npm run test:postman -- --signal cpu        # drive CPU up instead, and watch it rise
 *   npm run test:postman -- --signal rpm        # drive request rate up instead
 *   npm run test:postman -- --sockets 20        # more socket load
 *
 * `memory` is deliberately not offered: RSS on this app is dominated by baseline heap and barely moves
 * under synthetic load, so a demo of it would be theatre. A memory rule is for leak and pressure
 * protection, not load tracking — see docs/09-scaling.md.
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
const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const SOCKETS = flag('sockets', 16);
const SCALE_BUDGET_MS = flag('budget', 120) * 1000;

/**
 * Which signal to make rise.
 *
 * The point of the choice: with `connections` you watch the socket count climb, and CPU and memory never
 * move — so "I can't see CPU going up" is a fair complaint about a connections-driven run, not a bug. Each
 * signal needs its own kind of load, so the driver generates the load that matches the rule it is testing.
 *
 *   connections  hold sockets open              (default)
 *   cpu          hammer the most expensive read
 *   rpm          hammer the cheapest read
 */
const SIGNAL = argOf('signal') ?? 'connections';
const WATERMARKS = {
  connections: { up: 2, down: 1, aggregate: 'mean' },
  // Watermarks tuned to what this stack actually reaches under synthetic load — measured, not guessed:
  // idle sits near 2-3%, a burst of expensive reads takes it to 25-40%.
  cpu: { up: 15, down: 5, aggregate: 'max' },
  rpm: { up: 400, down: 100, aggregate: 'mean' },
};
if (!WATERMARKS[SIGNAL]) {
  console.error(`--signal must be one of ${Object.keys(WATERMARKS).join(', ')} (memory does not respond to synthetic load — see below)`);
  process.exit(2);
}

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

/** Opens sockets and keeps them open — raises `connections`, and nothing else meaningfully. */
async function openSocketLoad(count) {
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
 * Sustained HTTP load, for the cpu and rpm signals.
 *
 * `cpu` hits the most expensive read there is — the inbox with a large page, two correlated subqueries per
 * conversation. `rpm` hits the cheapest one, because the point there is request *count*, and using an
 * expensive endpoint would move both signals and muddy which rule fired.
 */
function openHttpLoad(kind, workers = 40) {
  const path = kind === 'cpu' ? '/api/conversations?userId=1&limit=200' : '/api/users';
  let running = true;
  let served = 0;

  const loops = Array.from({ length: workers }, async () => {
    while (running) {
      try {
        await (await fetch(BASE + path)).json();
        served += 1;
      } catch {
        /* a replica mid-restart is expected */
      }
    }
  });

  return {
    served: () => served,
    close: async () => {
      running = false;
      await Promise.all(loops);
      await sleep(1_000);
    },
  };
}

const openLoad = async () => {
  if (SIGNAL === 'connections') return openSocketLoad(SOCKETS);
  return openHttpLoad(SIGNAL);
};

/** What each replica currently reads for the signal under test — so the rise is visible, not inferred. */
async function showSignal(label) {
  const seen = new Map();
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      const instance = res.headers.get('x-relay-instance');
      const body = await res.json();
      if (!instance) continue;
      const value =
        SIGNAL === 'connections' ? `${body.connections} conn`
        : SIGNAL === 'cpu' ? `${body.cpuPercent}% cpu`
        : `${Math.round(body.requestsPerMinute)} rpm`;
      seen.set(instance, value);
    } catch {
      /* ignore */
    }
  }
  console.log(`  ${label}: ${[...seen.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`);
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
    const w = WATERMARKS[SIGNAL];
    const tick = spawnSync(
      'node',
      [
        'scripts/autoscale.mjs', '--once', '--min', '2', '--max', '6',
        '--signal', SIGNAL, '--up', String(w.up), '--down', String(w.down), '--aggregate', w.aggregate,
      ],
      { encoding: 'utf8' },
    );
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

/**
 * Does the replica the autoscaler just started actually receive fan-out?
 *
 * A new replica boots with its Redis subscriber connected but **no channel subscriptions** — it subscribes
 * to a conversation only when one of its own sockets asks for it (`channels.acquire`). So "is the new
 * container automatically in the pub/sub?" has a two-part answer, and this checks both: that it takes a
 * channel on demand, and that a message published *through a different replica* reaches a socket sitting on
 * the new one.
 */
async function newReplicaJoinsFanout() {
  const before = new Map();
  for (let i = 0; i < 24; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      const body = await res.json();
      before.set(body.instanceId, body);
    } catch {
      /* ignore */
    }
  }
  // The newest replica is the one that started last — that is the one the autoscaler added.
  const newest = [...before.entries()].sort((a, b) => (a[1].startedAt < b[1].startedAt ? 1 : -1))[0];
  if (!newest) return { ok: false, detail: 'no replica answered' };

  const conv = await (
    await fetch(`${BASE}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: uid('fanout-check'), participantIds: [1, 2] }),
    })
  ).json();

  // Enough sockets that at least one lands on the new replica.
  const sockets = [];
  for (let i = 0; i < 10; i++) {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/');
    const events = [];
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
    ws.addEventListener('message', (e) => {
      try {
        events.push(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener('error', () => {});
    ws.send(JSON.stringify({ type: 'subscribe', userId: i % 2 ? 2 : 1, conversationIds: [conv.id] }));
    sockets.push({ ws, events });
  }
  await sleep(1_500);

  let onNewest = { connections: 0, subscribedConversations: 0 };
  for (let i = 0; i < 24; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      const body = await res.json();
      if (body.instanceId === newest[0]) onNewest = body;
    } catch {
      /* ignore */
    }
  }

  const marker = uid('fanout');
  const sent = await fetch(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: conv.id, senderId: 1, body: marker, clientId: marker }),
  });
  const publishedBy = sent.headers.get('x-relay-instance');
  await sleep(1_500);

  const copies = sockets.map((s) => s.events.filter((e) => e.type === 'message' && e.body === marker).length);
  for (const s of sockets) s.ws.close();
  await sleep(300);

  const tookChannel = onNewest.subscribedConversations > 0;
  const everyoneGotIt = copies.every((n) => n === 1);
  return {
    ok: tookChannel && everyoneGotIt,
    detail:
      `${newest[0]} took ${onNewest.subscribedConversations} channel(s) for ${onNewest.connections} socket(s); ` +
      `published via ${publishedBy}${publishedBy === newest[0] ? ' (itself)' : ' (a different replica)'}; ` +
      `per-socket copies ${JSON.stringify(copies)}`,
  };
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

  section(`PHASE 2 — scaled up by the autoscaler, on the "${SIGNAL}" signal`);
  await showSignal('before load');
  console.log(
    SIGNAL === 'connections'
      ? `  opening ${SOCKETS} sockets to push ${SIGNAL} over its up watermark of ${WATERMARKS[SIGNAL].up}…`
      : `  driving HTTP load to push ${SIGNAL} over its up watermark of ${WATERMARKS[SIGNAL].up}…`,
  );
  load = await openLoad();
  // CPU is a 5s rolling average in the app, so it needs a moment of sustained load before it reads high.
  await sleep(SIGNAL === 'cpu' ? 9_000 : 2_000);
  await showSignal('under load ');
  console.log('  running scripts/autoscale.mjs one tick at a time until it moves:');
  const up = await autoscaleUntilChanged(started, 'up');
  console.log(`  autoscaler went ${started} → ${up.replicas} in ${up.ticks} tick(s)`);
  const upServing = await servingReplicas();
  const wired = await newReplicaJoinsFanout();
  console.log(
    wired.ok
      ? `  the replica the autoscaler started joined the fan-out: ${wired.detail}`
      : `  PROBLEM — the new replica did not join the fan-out: ${wired.detail}`,
  );
  phases.push({
    phase: 'scaled-up',
    ok:
      runCollection({ phase: 'scaled-up', previousReplicas: started, expectedReplicas: upServing }) &&
      wired.ok,
    replicas: upServing,
  });

  section(`PHASE 3 — scaled down by the autoscaler`);
  console.log('  dropping the load…');
  await load.close();
  load = undefined;
  // Let the rolling window decay before measuring, or the signal still contains the burst. CPU averages
  // over 5s in the app; the request rate over config.metrics.requestRateWindowSeconds (15s).
  await sleep(SIGNAL === 'connections' ? 1_000 : SIGNAL === 'cpu' ? 12_000 : 25_000);
  await showSignal('after load ');
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
