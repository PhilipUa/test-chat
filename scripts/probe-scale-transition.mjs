/**
 * Does changing the replica count cost anything?
 *
 * `probe-scaling.mjs` checks that N replicas behave like one system. This checks the *transition* —
 * scaling up and back down while traffic and WebSockets are live — which is the part that was only ever
 * verified by hand (docs/09-scaling.md said 3→5 worked; nothing asserted it).
 *
 * Three questions per transition:
 *   1. Does the proxy notice? STRICT_DNS re-resolves on a timer, so there is a discovery window; this
 *      measures it rather than assuming it.
 *   2. Does a new replica actually take its share, or does it sit idle behind a proxy that found it?
 *   3. Does anything in flight break — HTTP requests failing, or a connected client silently stopping
 *      receiving?
 *
 * On (3): the WebSocket clients here reconnect, like the browser does. A scale-down *will* close the
 * sockets on a departing replica — the question is whether a client comes back and keeps receiving, not
 * whether its first socket survived.
 *
 *   docker compose up -d --scale api=3
 *   node scripts/probe-scale-transition.mjs           # 3 -> 5 -> 3
 *   node scripts/probe-scale-transition.mjs 2 6       # 2 -> 6 -> 2
 *
 * It restores the replica count it started with, including on failure.
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.RELAY_URL || 'http://localhost:3000';
const ADMIN = process.env.ENVOY_ADMIN || 'http://localhost:9901';
const DISCOVERY_BUDGET_MS = Number(process.env.DISCOVERY_BUDGET_MS || 30_000);

const FROM = Number(process.argv[2] || 3);
const TO = Number(process.argv[3] || 5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}-${process.hrtime.bigint().toString(36)}`;
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
/** Compose writes its progress to stderr; keep it out of the report unless it fails. */
const shQuiet = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const results = [];
const check = (pass, what, detail) => {
  results.push({ pass, what });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${what}${detail ? `\n          ${detail}` : ''}`);
};
const section = (t) => console.log(`\n═══ ${t} ═══`);

async function jpost(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, instance: res.headers.get('x-relay-instance'), body: await res.json().catch(() => null) };
}

/** How many endpoints Envoy has in the api cluster right now. */
async function envoyEndpoints() {
  const text = await (await fetch(`${ADMIN}/clusters`)).text();
  return text.split('\n').filter((l) => l.startsWith('api::') && l.includes('::health_flags::healthy')).length;
}

// --no-deps and an explicit service, or Compose re-runs the seed job and waits on every database
// every time the replica count changes.
const scaleTo = (n) =>
  shQuiet('docker', ['compose', 'up', '-d', '--no-deps', '--scale', `api=${n}`, 'api']);
const runningReplicas = () =>
  sh('docker', ['compose', 'ps', 'api', '--format', '{{.Name}}']).split('\n').filter(Boolean).length;

/** Waits until Envoy reports exactly `n` healthy endpoints, and reports how long that took. */
async function waitForDiscovery(n, budgetMs = DISCOVERY_BUDGET_MS) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if ((await envoyEndpoints()) === n) return Date.now() - started;
    await sleep(500);
  }
  return undefined;
}

/**
 * Continuous HTTP traffic, recording every non-2xx.
 *
 * A GET and a POST, because they are retried differently: the proxy retries GETs on `unavailable` and
 * `reset` but a write only where the request provably never arrived, so a write is the harsher test of
 * whether a transition is graceful (docs/08-review-fixes.md finding 5).
 */
function startTraffic(conversationId) {
  const seen = { get: 0, post: 0, failures: [], instances: new Set() };
  let running = true;

  const loop = (async () => {
    while (running) {
      try {
        const res = await fetch(`${BASE}/api/conversations?userId=1&limit=5`);
        seen.get += 1;
        const instance = res.headers.get('x-relay-instance');
        if (instance) seen.instances.add(instance);
        if (!res.ok) seen.failures.push(`GET ${res.status}`);
      } catch (err) {
        seen.failures.push(`GET threw: ${err.message}`);
      }

      try {
        const clientId = uid('traffic');
        const res = await fetch(`${BASE}/api/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId, senderId: 2, body: clientId, clientId }),
        });
        seen.post += 1;
        const instance = res.headers.get('x-relay-instance');
        if (instance) seen.instances.add(instance);
        // 429 is the rate limiter working as designed, not a transition failure.
        if (!res.ok && res.status !== 429) seen.failures.push(`POST ${res.status}`);
      } catch (err) {
        seen.failures.push(`POST threw: ${err.message}`);
      }

      await sleep(120);
    }
  })();

  return {
    stats: seen,
    stop: async () => {
      running = false;
      await loop;
      return seen;
    },
  };
}

/**
 * A client that behaves like the browser: reconnects and re-subscribes when its socket goes away.
 *
 * Without the reconnect this probe would only be able to say "a scale-down closes sockets", which is
 * true and uninteresting. What matters is whether the user keeps receiving messages.
 */
function reconnectingClient(userId, conversationIds) {
  const state = { events: [], closes: [], connects: 0, ws: undefined, live: false, stopped: false };

  const connect = () => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/');
    state.ws = ws;
    ws.addEventListener('open', () => {
      state.connects += 1;
      ws.send(JSON.stringify({ type: 'subscribe', userId, conversationIds }));
    });
    ws.addEventListener('message', (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === 'subscribed') state.live = true;
        state.events.push(event);
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener('close', (e) => {
      state.live = false;
      state.closes.push(e.code);
      if (!state.stopped) setTimeout(connect, 200);
    });
    ws.addEventListener('error', () => {});
  };

  connect();

  return {
    state,
    waitLive: async (timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (state.live) return true;
        await sleep(100);
      }
      return false;
    },
    close: async () => {
      state.stopped = true;
      state.ws?.close();
      await sleep(300);
    },
  };
}

/* ------------------------------------------------------------------------ run */

const started = runningReplicas();
console.log(`  stack is running ${started} replica(s); this probe will end back at ${FROM}`);

const conv = (await jpost('/api/conversations', { title: uid('scale-transition'), participantIds: [1, 2] })).body;
const CLIENTS = 6;
let clients = [];

try {
  if (started !== FROM) {
    scaleTo(FROM);
    await waitForDiscovery(FROM);
  }

  clients = Array.from({ length: CLIENTS }, (_, i) => reconnectingClient(i === 0 ? 1 : 2, [conv.id]));
  const allLive = await Promise.all(clients.map((c) => c.waitLive()));
  check(allLive.every(Boolean), `${CLIENTS} clients are connected and subscribed at ${FROM} replicas`);

  for (const [label, target] of [
    ['scaling up', TO],
    ['scaling down', FROM],
  ]) {
    section(`${label}: ${label === 'scaling up' ? FROM : TO} → ${target}`);

    if (label === 'scaling down') {
      // Existing sockets do not migrate, so every client so far is on a replica that predates the
      // scale-up — and the scale-down removes the *newest* replicas. Without a batch opened while the
      // stack was wide, nothing would be on a departing replica and the eviction checks below would
      // pass without testing anything.
      const late = Array.from({ length: CLIENTS }, (_, i) => reconnectingClient(i === 0 ? 1 : 2, [conv.id]));
      await Promise.all(late.map((c) => c.waitLive()));
      clients = [...clients, ...late];
      console.log(`  opened ${CLIENTS} more clients while wide, so some sit on replicas about to go`);
    }

    const traffic = startTraffic(conv.id);
    await sleep(1_000); // establish a baseline of traffic before disturbing anything

    const before = new Set(traffic.stats.instances);
    scaleTo(target);
    const discoveredMs = await waitForDiscovery(target);
    check(
      discoveredMs !== undefined,
      'the proxy converges on the new replica count',
      discoveredMs === undefined
        ? `still not ${target} endpoints after ${DISCOVERY_BUDGET_MS / 1000}s`
        : `${target} endpoints after ${(discoveredMs / 1000).toFixed(1)}s`,
    );

    // Give the new set a moment to actually receive traffic, then see who served it.
    await sleep(4_000);
    const stats = await traffic.stop();

    check(
      stats.failures.length === 0,
      'no request failed while the replica count changed',
      stats.failures.length
        ? `${stats.failures.length} of ${stats.get + stats.post}: ${[...new Set(stats.failures)].join(', ')}`
        : `${stats.get} GETs + ${stats.post} POSTs, all served`,
    );

    if (target > before.size) {
      const fresh = [...stats.instances].filter((i) => !before.has(i));
      check(
        fresh.length > 0,
        'a newly started replica actually takes traffic, not just a place in the cluster',
        `${fresh.length} replica(s) served traffic that were not serving before`,
      );
    }

    // The point of all this: a connected user keeps receiving.
    const backLive = await Promise.all(clients.map((c) => c.waitLive()));
    check(backLive.every(Boolean), 'every client is subscribed again after the transition');

    const marker = uid('after-transition');
    await jpost('/api/messages', {
      conversationId: conv.id, senderId: 1, body: marker, clientId: marker,
    });
    await sleep(1_500);
    const copies = clients.map((c) => c.state.events.filter((e) => e.type === 'message' && e.body === marker).length);
    check(
      copies.every((n) => n === 1),
      'and receives a message published afterwards, exactly once',
      `per-client copies: ${JSON.stringify(copies)}`,
    );

    const abrupt = clients.flatMap((c) => c.state.closes).filter((code) => code !== 1001 && code !== 1000);
    console.log(
      `  socket churn: ${clients.reduce((n, c) => n + c.state.connects, 0)} connects, ` +
        `closes=${JSON.stringify(clients.flatMap((c) => c.state.closes))}`,
    );
    if (label === 'scaling down') {
      const closes = clients.flatMap((c) => c.state.closes);
      if (closes.length === 0) {
        // Not a pass. It means nothing was evicted, so the assertion had nothing to judge.
        check(
          false,
          'the scale-down actually evicted some sockets (otherwise this proves nothing)',
          'no client socket closed — every client happened to be on a surviving replica',
        );
      } else {
        check(
          abrupt.length === 0,
          'departing replicas closed their sockets gracefully (1001), not abruptly',
          abrupt.length
            ? `abrupt close codes: ${JSON.stringify(abrupt)}`
            : `${closes.length} socket(s) evicted, all with a normal close code`,
        );
      }
    }
  }
} finally {
  await Promise.all(clients.map((c) => c.close()));
  if (runningReplicas() !== started) {
    console.log(`\n  restoring ${started} replica(s)`);
    scaleTo(started);
    await waitForDiscovery(started);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n═══ ${results.length - failed.length}/${results.length} transition checks passed ═══`);
for (const f of failed) console.log(`  FAILED: ${f.what}`);
process.exit(failed.length ? 1 : 0);
