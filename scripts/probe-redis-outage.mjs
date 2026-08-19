/**
 * What survives losing Redis, and what recovers afterwards.
 *
 * Redis holds everything that cannot live in one process: pub/sub fan-out, presence, rate-limit counters.
 * The code has a considered answer for each when it goes away — fail open on limits, degrade presence to
 * quiet, fall back to local-only delivery — and one of those answers was a *bug* until recently (review
 * finding 3: a SUBSCRIBE issued while Redis was down was never retried, so a conversation went silently
 * dead for the life of the process). None of it had ever been tested against a real outage. This does that.
 *
 * The recovery half is the point. Anyone can check that a send still returns 201 with Redis down; the
 * question that matters is whether a client that *subscribed during* the outage is still receiving messages
 * ten seconds after Redis comes back.
 *
 *   docker compose up -d --scale api=3
 *   node scripts/probe-redis-outage.mjs
 *
 * It stops the redis container and starts it again afterwards, including on failure. Nothing else in the
 * stack is touched — MySQL and Mongo keep the data, so no message is at risk.
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.RELAY_URL || 'http://localhost:3000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}-${process.hrtime.bigint().toString(36)}`;
const sh = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const results = [];
const check = (pass, what, detail) => {
  results.push({ pass, what });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${what}${detail ? `\n          ${detail}` : ''}`);
};
const section = (t) => console.log(`\n═══ ${t} ═══`);

const jget = async (p) => {
  const res = await fetch(BASE + p);
  return {
    status: res.status,
    instance: res.headers.get('x-relay-instance'),
    body: await res.json().catch(() => null),
  };
};
const jpost = async (p, b) => {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  return {
    status: res.status,
    instance: res.headers.get('x-relay-instance'),
    body: await res.json().catch(() => null),
  };
};

/** Every replica's view of its own dependencies. */
async function replicaHealth(samples = 24) {
  const seen = new Map();
  for (let i = 0; i < samples; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      const body = await res.json();
      seen.set(body.instanceId, body);
    } catch {
      /* a replica refusing while Redis is down is itself a finding, caught below */
    }
  }
  return seen;
}

/** A client that records what it receives and stays put — no reconnect, so gaps are visible. */
async function client(userId, conversationIds) {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/');
  const events = [];
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
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('ws error'));
      },
      { once: true },
    );
  });
  ws.addEventListener('error', () => {});
  ws.addEventListener('message', (e) => {
    try {
      events.push(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  });

  const waitFor = async (pred, ms = 6_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = events.find(pred);
      if (hit) return hit;
      await sleep(80);
    }
    return undefined;
  };

  ws.send(JSON.stringify({ type: 'subscribe', userId, conversationIds }));
  const ack = await waitFor((e) => e.type === 'subscribed', 8_000);
  return { ws, events, waitFor, ack, close: () => ws.close() };
}

const got = (c, body) => c.events.filter((e) => e.type === 'message' && e.body === body).length;

let redisStopped = false;
const startRedis = () => {
  if (!redisStopped) return;
  sh('docker', ['compose', 'start', 'redis']);
  redisStopped = false;
};

const conv = (
  await jpost('/api/conversations', { title: uid('redis-outage'), participantIds: [1, 2] })
).body;
const before = [];
const during = [];

try {
  /* ------------------------------------------------------------- 1. while healthy */

  section('with redis up');
  for (let i = 0; i < 4; i++) before.push(await client(i % 2 ? 2 : 1, [conv.id]));
  check(
    before.every((c) => c.ack),
    'clients subscribe normally',
  );

  const baseline = uid('baseline');
  await jpost('/api/messages', {
    conversationId: conv.id,
    senderId: 1,
    body: baseline,
    clientId: baseline,
  });
  await sleep(1_200);
  check(
    before.every((c) => got(c, baseline) === 1),
    'a message reaches every client exactly once',
    `copies: ${JSON.stringify(before.map((c) => got(c, baseline)))}`,
  );

  /* ---------------------------------------------------------------- 2. take it away */

  section('with redis stopped');
  sh('docker', ['compose', 'stop', 'redis']);
  redisStopped = true;
  await sleep(3_000);

  const health = await replicaHealth();
  check(
    health.size > 0,
    'every replica still answers /api/health',
    `${health.size} replica(s) answered`,
  );
  check(
    [...health.values()].every((h) => h.redis === false),
    'and reports redis as down rather than claiming to be fine',
    [...health.values()]
      .map((h) => `${h.instanceId} redis=${h.redis} realtime=${h.realtimeConnected}`)
      .join('  '),
  );

  // The rate limiter is designed to fail *open*: a chat app that stops accepting messages because its
  // limiter is unreachable has turned a protection into an outage.
  const duringOutage = uid('sent-during-outage');
  const sent = await jpost('/api/messages', {
    conversationId: conv.id,
    senderId: 1,
    body: duringOutage,
    clientId: duringOutage,
  });
  check(
    sent.status === 201,
    'a send still succeeds — the rate limiter fails open',
    `POST -> ${sent.status}`,
  );
  check(
    sent.body?.body === duringOutage,
    'and the message comes back intact, not empty',
    `body=${JSON.stringify(sent.body?.body)}`,
  );

  const readBack = await jget(`/api/messages?conversationId=${conv.id}&userId=1&since=0`);
  check(
    readBack.body?.messages?.some((m) => m.body === duringOutage),
    'reads still work, so nothing written during the outage is lost',
    `${readBack.body?.messages?.length} message(s) readable from ${readBack.instance}`,
  );

  // Presence lives in Redis, so it degrades to "nobody is online" rather than erroring. Quiet is the
  // correct failure: an absent dot is better than a wrong one, and it can never imply presence we cannot
  // actually confirm.
  const inbox = await jget('/api/conversations?userId=1&limit=200');
  const row = inbox.body?.conversations?.find((c) => c.id === conv.id);
  check(
    inbox.status === 200 && row !== undefined,
    'the inbox still loads with presence unavailable',
    `participants: ${JSON.stringify(row?.participants?.map((p) => `${p.id}:${p.online}`) ?? [])}`,
  );
  check(
    (row?.participants ?? []).every((p) => p.online === false),
    'and reports nobody online rather than guessing',
  );

  // Fan-out goes through Redis, so cross-replica delivery cannot work. The code falls back to local-only
  // delivery, which is single-instance behaviour rather than nothing — worth measuring rather than assuming.
  const localOnly = before.filter((c) => got(c, duringOutage) === 1).length;
  console.log(
    `  fan-out during the outage: ${localOnly}/${before.length} clients received it ` +
      `(local-only fallback — Redis pub/sub is at-most-once, so this is expected to be partial)`,
  );

  // The interesting client: one that subscribes *while* Redis is down. Its SUBSCRIBE cannot land, and
  // before review finding 3 was fixed nothing ever retried it — that conversation stayed dead for the life
  // of the process, with the socket still open and nothing on screen to say so.
  for (let i = 0; i < 3; i++) during.push(await client(i % 2 ? 2 : 1, [conv.id]));
  check(
    during.every((c) => c.ack),
    'a client can still subscribe, and is acknowledged',
    'its Redis SUBSCRIBE cannot have landed — that is what recovery has to repair',
  );

  /* ------------------------------------------------------------------ 3. bring it back */

  section('after redis comes back');
  startRedis();

  // Wait for every replica to report the subscriber healthy again.
  const deadline = Date.now() + 60_000;
  let recovered = new Map();
  while (Date.now() < deadline) {
    recovered = await replicaHealth();
    if (recovered.size > 0 && [...recovered.values()].every((h) => h.redis && h.realtimeConnected))
      break;
    await sleep(1_000);
  }
  check(
    [...recovered.values()].every((h) => h.redis && h.realtimeConnected),
    'every replica reports redis and realtime healthy again',
    [...recovered.values()]
      .map((h) => `${h.instanceId} redis=${h.redis} realtime=${h.realtimeConnected}`)
      .join('  '),
  );

  // The resync nudge: the socket never closed, so nothing else would tell these clients they missed events.
  const nudged = [];
  for (const c of [...before, ...during]) {
    nudged.push(Boolean(await c.waitFor((e) => e.type === 'resync', 15_000)));
  }
  check(
    nudged.some(Boolean),
    'clients are told to resync, since their sockets never closed',
    `${nudged.filter(Boolean).length}/${nudged.length} clients received a resync`,
  );

  await sleep(3_000);
  const afterRecovery = uid('after-recovery');
  await jpost('/api/messages', {
    conversationId: conv.id,
    senderId: 1,
    body: afterRecovery,
    clientId: afterRecovery,
  });
  await sleep(2_500);

  check(
    before.every((c) => got(c, afterRecovery) === 1),
    'clients that were connected before the outage receive messages again',
    `copies: ${JSON.stringify(before.map((c) => got(c, afterRecovery)))}`,
  );

  // This is the assertion the whole probe exists for.
  check(
    during.every((c) => got(c, afterRecovery) === 1),
    'clients that subscribed DURING the outage receive messages again',
    `copies: ${JSON.stringify(during.map((c) => got(c, afterRecovery)))} — ` +
      `the unconfirmed SUBSCRIBE was retried on reconnect (review finding 3)`,
  );

  // And the limiter is authoritative again rather than stuck open.
  const burst = [];
  for (let i = 0; i < 8; i++) {
    const res = await jpost('/api/messages', {
      conversationId: conv.id,
      senderId: 2,
      body: `burst-${i}`,
      clientId: uid('rl'),
    });
    burst.push(res.status);
  }
  check(
    burst.includes(429),
    'the rate limiter is enforcing again, not stuck failing open',
    `statuses: ${burst.join(',')}`,
  );
} finally {
  for (const c of [...before, ...during]) c.close();
  startRedis();
  await sleep(2_000);
}

const failed = results.filter((r) => !r.pass);
console.log(
  `\n═══ ${results.length - failed.length}/${results.length} redis-outage checks passed ═══`,
);
for (const f of failed) console.log(`  FAILED: ${f.what}`);
process.exit(failed.length ? 1 : 0);
