/**
 * What happens to a connected user when a replica goes away — hard, and gracefully.
 *
 * Two different failures with two different correct behaviours:
 *
 *   1. **SIGKILL.** No chance to say goodbye. The browser must notice its socket died, reconnect to a
 *      survivor, and recover anything published while it was away — realtime is at-most-once, so the
 *      recovery is `GET /api/messages?since=`, not the socket.
 *   2. **SIGTERM** — a scale-down or a rolling deploy. The replica *can* say goodbye, and should:
 *      deregister its users' presence, or everyone it was holding looks online for the whole
 *      presence TTL. That path exists in closeWs(); this measures whether it actually runs.
 *
 * Needs a browser (part 1 is frontend behaviour, not something HTTP can answer) and docker, so it
 * lives here rather than in the test suite:
 *
 *   docker compose up -d --scale api=3
 *   node scripts/probe-failover.mjs
 *
 * It stops one replica at a time and starts it again afterwards, including on failure.
 */
import { execFileSync, execSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.RELAY_URL || 'http://localhost:3000';
const PRESENCE_TTL_MS = Number(process.env.PRESENCE_TTL_MS || 90_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}-${process.hrtime.bigint().toString(36)}`;
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
/** Container logs, stdout *and* stderr — docker sends each to its own stream, and the interesting
 *  shutdown lines are on stderr. */
const containerLog = (name, tail = 40) =>
  execSync(`docker logs --tail ${tail} ${name} 2>&1`, { encoding: 'utf8' });

const jget = async (p) => (await fetch(BASE + p)).json();
const jpost = async (p, b) => {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const results = [];
const check = (pass, what, detail) => {
  results.push({ pass, what });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${what}${detail ? `\n          ${detail}` : ''}`);
};
const section = (t) => console.log(`\n═══ ${t} ═══`);

/** instanceId -> live socket count, sampled across every replica behind the proxy. */
async function connectionsByReplica(samples = 40) {
  const seen = new Map();
  for (let i = 0; i < samples; i++) {
    const h = await jget('/api/health');
    seen.set(h.instanceId, h.connections);
  }
  return seen;
}

/** instanceId is the container's hostname, which is its short id. */
function containerFor(instanceId) {
  const rows = sh('docker', ['ps', '--format', '{{.ID}} {{.Names}}']).split('\n');
  return rows.find((r) => r.startsWith(instanceId.slice(0, 12)))?.split(' ')[1];
}

/** Which replica's connection count went up — i.e. took the socket we just opened. */
function replicaThatGained(before, after) {
  return [...after.entries()].find(([id, n]) => n > (before.get(id) ?? 0))?.[0];
}

async function waitHealthy(container, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', container]);
    if (status === 'healthy') return true;
    await sleep(2_000);
  }
  return false;
}

const stopped = new Set();
function restore() {
  for (const container of stopped) {
    try {
      sh('docker', ['start', container]);
      console.log(`  restored ${container}`);
    } catch (err) {
      console.error(`  could not restart ${container}: ${err.message}`);
    }
  }
  stopped.clear();
}

const conv = (await jpost('/api/conversations', { title: uid('failover'), participantIds: [1, 2] }))
  .body;
const presenceConv = (
  await jpost('/api/conversations', { title: uid('drain'), participantIds: [1, 5] })
).body;

let browser;
try {
  /* ------------------------------------------------------- 1. a replica is killed outright */

  section('a replica is killed outright (SIGKILL)');

  await jpost('/api/messages', {
    conversationId: conv.id,
    senderId: 2,
    body: 'before the kill',
    clientId: uid('b'),
  });

  browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  const serverErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`);
  });

  const beforeBrowser = await connectionsByReplica();
  await page.goto(`${BASE}/?userId=1`);
  await page.waitForFunction(() => document.querySelectorAll('#userSelect option').length > 0);
  await page.waitForFunction(
    () => document.getElementById('connection')?.textContent === 'live',
    undefined,
    { timeout: 20_000 },
  );
  await page.locator('#conversations li', { hasText: conv.title }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0, undefined, {
    timeout: 15_000,
  });

  const holder = replicaThatGained(beforeBrowser, await connectionsByReplica());
  const victim = holder && containerFor(holder);
  if (!victim) throw new Error(`could not locate the replica holding the browser's socket`);
  console.log(`  the browser's socket landed on ${holder} (${victim})`);

  sh('docker', ['kill', victim]);
  stopped.add(victim);
  console.log(`  killed ${victim}`);

  // Publish while it is down, so the browser cannot have received this over its socket.
  await sleep(1_500);
  const duringOutage = uid('sent-while-down');
  const posted = await jpost('/api/messages', {
    conversationId: conv.id,
    senderId: 2,
    body: duringOutage,
    clientId: duringOutage,
  });
  check(
    posted.status === 201,
    'a send still succeeds with a replica gone',
    `POST -> ${posted.status}`,
  );

  await page.waitForFunction(
    () => document.getElementById('connection')?.textContent === 'live',
    undefined,
    { timeout: 40_000 },
  );
  check(true, 'the browser reconnects to a surviving replica on its own');

  await page.waitForFunction(
    (body) => [...document.querySelectorAll('.msg .body')].some((n) => n.textContent === body),
    duringOutage,
    { timeout: 30_000 },
  );
  check(true, 'and recovers what was published while it was away', 'via GET ?since= catch-up');

  const afterRecovery = uid('after-recovery');
  await jpost('/api/messages', {
    conversationId: conv.id,
    senderId: 2,
    body: afterRecovery,
    clientId: afterRecovery,
  });
  await page.waitForFunction(
    (body) => [...document.querySelectorAll('.msg .body')].some((n) => n.textContent === body),
    afterRecovery,
    { timeout: 20_000 },
  );
  check(true, 'live updates resume on the new replica');
  check(pageErrors.length === 0, 'no uncaught errors in the page', pageErrors.join('; ') || 'none');
  check(
    serverErrors.length === 0,
    'nothing 5xx reached the page',
    serverErrors.join('; ') || 'none',
  );

  await ctx.close();

  // Put it back before the second half, so this runs at full strength.
  restore();
  if (!(await waitHealthy(victim))) throw new Error(`${victim} did not come back healthy`);

  /* ------------------------------------------------- 2. a replica is drained gracefully */

  section('a replica is drained gracefully (SIGTERM)');

  /** Whether user 5 reads as online to user 1, according to whichever replica answers. */
  const erinOnline = async () => {
    const page = await jget(`/api/conversations?userId=1&limit=200`);
    const row = page.conversations.find((c) => c.id === presenceConv.id);
    return row?.participants?.find((p) => p.id === 5)?.online;
  };

  // Start from a known baseline rather than inheriting a connection from something else.
  for (let i = 0; i < 200 && (await erinOnline()) !== false; i++) await sleep(500);
  check((await erinOnline()) === false, 'user 5 starts offline');

  const beforeSocket = await connectionsByReplica();
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 10_000);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  ws.send(JSON.stringify({ type: 'subscribe', userId: 5, conversationIds: [presenceConv.id] }));
  await new Promise((r) => ws.addEventListener('message', r, { once: true }));
  await sleep(500);
  check((await erinOnline()) === true, 'and reads as online once connected');

  const drainHolder = replicaThatGained(beforeSocket, await connectionsByReplica());
  const draining = drainHolder && containerFor(drainHolder);
  if (!draining) throw new Error("could not locate the replica holding user 5's socket");
  console.log(`  user 5's socket landed on ${drainHolder} (${draining}) — sending SIGTERM`);

  const t0 = Date.now();
  sh('docker', ['stop', '-t', '15', draining]);
  stopped.add(draining);

  let releasedAfterMs;
  for (let i = 0; i < 60; i++) {
    if ((await erinOnline()) === false) {
      releasedAfterMs = Date.now() - t0;
      break;
    }
    await sleep(500);
  }

  // The TTL always cleans up eventually. The point of deregistering on the way out is that a
  // scale-down doesn't leave a crowd of ghosts online for a minute and a half.
  check(
    releasedAfterMs !== undefined && releasedAfterMs < 20_000,
    'a drained replica releases its users’ presence promptly',
    releasedAfterMs === undefined
      ? `still online 30s after SIGTERM — the ${PRESENCE_TTL_MS / 1000}s TTL is doing the work instead, ` +
          `which means the shutdown handler never ran`
      : `released after ${(releasedAfterMs / 1000).toFixed(1)}s (TTL fallback would be ` +
          `up to ${PRESENCE_TTL_MS / 1000}s)`,
  );

  // Releasing presence isn't the whole job: the shutdown has to actually *finish*. Hitting the
  // force-exit means the teardown hung and everything after the hang was skipped — a rolling deploy
  // then costs the timeout per replica and cuts in-flight work at an arbitrary point.
  const drainLog = containerLog(draining);
  check(
    !drainLog.includes('[shutdown] took too long'),
    'the shutdown completes instead of hitting its force-exit',
    drainLog.includes('[shutdown] took too long')
      ? 'logged "[shutdown] took too long, exiting anyway" — something in the teardown never resolved'
      : 'no force-exit',
  );
  check(
    drainLog.includes('[shutdown] complete'),
    'and says so',
    drainLog
      .split('\n')
      .filter((l) => l.includes('shutdown') || l.includes('shutting down'))
      .join(' | ') || 'no shutdown lines logged at all',
  );
} finally {
  restore();
  await browser?.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n═══ ${results.length - failed.length}/${results.length} failover checks passed ═══`);
for (const f of failed) console.log(`  FAILED: ${f.what}`);
process.exit(failed.length ? 1 : 0);
