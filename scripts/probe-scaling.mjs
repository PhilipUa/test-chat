/**
 * Does load balancing actually work, and does the app survive being several processes?
 *
 * Two different questions, and this reports both:
 *
 *   1. Is the proxy spreading traffic — HTTP requests *and* WebSocket connections — across every
 *      replica it should have discovered?
 *   2. Given that it is, does the app still behave like one system? Realtime reaching sockets on
 *      other replicas, and every replica giving the same answer about shared state.
 *
 * The second is what tasks/multi-instance.md asks for, and it is only meaningfully tested when the
 * first is true — a probe that quietly ran against one replica would pass everything.
 *
 *   docker compose up -d --scale api=3
 *   node scripts/probe-scaling.mjs
 *   node scripts/probe-scaling.mjs --expect 5      # after scaling up
 *
 * Attribution comes from the X-Relay-Instance response header. Sockets can't carry it, so they are
 * located by reading each replica's own connection count back out of /api/health.
 */

const BASE = process.env.RELAY_URL || 'http://localhost:3000';
const ADMIN = process.env.ENVOY_ADMIN || 'http://localhost:9901';

const expectIndex = process.argv.indexOf('--expect');
const EXPECTED = expectIndex === -1 ? undefined : Number(process.argv[expectIndex + 1]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}-${process.hrtime.bigint().toString(36)}`;

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    instance: res.headers.get('x-relay-instance'),
    body: await res.json().catch(() => null),
  };
}
const jget = (p) => req('GET', p);
const jpost = (p, b) => req('POST', p, b);

const results = [];
function check(pass, requirement, detail) {
  results.push({ pass, requirement });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${requirement}${detail ? `\n          ${detail}` : ''}`);
}
const section = (title) => console.log(`\n═══ ${title} ═══`);

/** A WS client that records what it receives. */
async function socket(userId, conversationIds) {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/');
  const events = [];
  ws.addEventListener('message', (e) => {
    try {
      events.push(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 10_000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); }, { once: true });
  });

  const waitFor = async (pred, ms = 6_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.find(pred);
      if (hit) return hit;
      await sleep(60);
    }
    return undefined;
  };

  ws.send(JSON.stringify({ type: 'subscribe', userId, conversationIds }));
  await waitFor((e) => e.type === 'subscribed');

  return {
    userId,
    events,
    waitFor,
    send: (p) => ws.send(JSON.stringify(p)),
    close: async () => {
      const closed = new Promise((r) => {
        ws.addEventListener('close', r, { once: true });
        setTimeout(r, 1_500);
      });
      ws.close();
      await closed;
    },
  };
}

/** Samples /api/health until it stops finding new replicas. Returns instanceId -> latest health. */
async function pollReplicas(samples = 30) {
  const seen = new Map();
  for (let i = 0; i < samples; i++) {
    const res = await jget('/api/health');
    if (res.instance) seen.set(res.instance, res.body);
  }
  return seen;
}

/** How many endpoints Envoy currently has in the api cluster, and how many it considers healthy. */
async function envoyEndpoints() {
  try {
    const text = await (await fetch(`${ADMIN}/clusters`)).text();
    const lines = text.split('\n').filter((l) => l.startsWith('api::') && l.includes('::health_flags::'));
    const total = lines.length;
    const healthy = lines.filter((l) => l.endsWith('::healthy')).length;
    return { total, healthy };
  } catch {
    return undefined;
  }
}

const newConversation = async (participantIds) =>
  (await jpost('/api/conversations', { title: uid('scale'), participantIds })).body;

/* ------------------------------------------------------- 1. is traffic spread? */

section('load balancing');

const replicas = await pollReplicas();
const replicaCount = replicas.size;
console.log(`  replicas answering: ${[...replicas.keys()].join(', ')}`);

const envoy = await envoyEndpoints();
if (envoy) {
  console.log(`  envoy api cluster: ${envoy.healthy}/${envoy.total} endpoints healthy`);
  check(
    envoy.healthy === envoy.total && envoy.total > 0,
    'every endpoint the proxy discovered is healthy',
    `${envoy.healthy}/${envoy.total}`,
  );
  check(
    replicaCount === envoy.total,
    'every discovered endpoint actually served a request',
    `${replicaCount} replica(s) answered, ${envoy.total} endpoint(s) in the cluster`,
  );
}

if (EXPECTED !== undefined) {
  check(replicaCount === EXPECTED, `all ${EXPECTED} expected replicas are serving`, `saw ${replicaCount}`);
}

// Distribution over a burst of requests. Round-robin should be close to even; the check is loose
// because it only needs to catch "one replica is taking everything".
const SAMPLES = 90;
const hits = new Map();
for (let i = 0; i < SAMPLES; i++) {
  const res = await jget('/api/users');
  hits.set(res.instance, (hits.get(res.instance) ?? 0) + 1);
}
const spread = [...hits.entries()].map(([id, n]) => `${id}=${n}`).join(' ');
const fairShare = SAMPLES / Math.max(replicaCount, 1);
const worst = Math.min(...hits.values());
check(
  hits.size === replicaCount,
  'HTTP requests reach every replica',
  `${SAMPLES} requests: ${spread}`,
);
check(
  replicaCount === 1 || worst >= fairShare * 0.5,
  'no replica is starved of HTTP traffic',
  `least-used got ${worst}, even split would be ${fairShare.toFixed(1)}`,
);

/* ------------------------------------------ 2. are sockets spread, and does fan-out work? */

section('realtime across replicas');

const conv = await newConversation([1, 2]);
const SOCKETS = Math.max(6, replicaCount * 2);

// Everything below is measured as a *delta*. Anything else may be connected — a browser tab left open
// is the normal case — and asserting absolute counts would make this probe report someone else's
// clients as a failure.
const sum = (health, field) => [...health.values()].reduce((n, h) => n + h[field], 0);
const baseline = await pollReplicas();
const heldBefore = sum(baseline, 'connections');
const channelsBefore = sum(baseline, 'subscribedConversations');
if (heldBefore) {
  console.log(`  note: ${heldBefore} socket(s) already connected before this probe started`);
}

const watchers = [];
for (let i = 0; i < SOCKETS; i++) {
  // Alternate identities: an event's subject never receives its own event back, so a mix is needed to
  // observe typing and presence at all.
  watchers.push(await socket(i === 0 ? 1 : 2, [conv.id]));
}

const holding = await pollReplicas();
const gained = [...holding.entries()].filter(
  ([id, h]) => h.connections > (baseline.get(id)?.connections ?? 0),
);
check(
  sum(holding, 'connections') - heldBefore === SOCKETS,
  'every WebSocket is accounted for by some replica',
  `${SOCKETS} opened, replicas gained ${sum(holding, 'connections') - heldBefore}`,
);
check(
  replicaCount === 1 || gained.length > 1,
  'WebSockets are spread across replicas, not pinned to one',
  `${gained.length}/${replicaCount} replica(s) took at least one: ` +
    `${gained.map(([id, h]) => `${id}=${h.connections - (baseline.get(id)?.connections ?? 0)}`).join(' ')}`,
);

// The original bug: a broadcast only reached sockets on the process that handled the POST.
const marker = uid('fanout');
const sent = await jpost('/api/messages', {
  conversationId: conv.id, senderId: 1, body: marker, clientId: marker,
});
await sleep(1_200);
const copies = watchers.map(
  (w) => w.events.filter((e) => e.type === 'message' && e.body === marker).length,
);
check(
  copies.every((n) => n === 1),
  'a message reaches every connected client exactly once',
  `POST served by ${sent.instance}; per-socket copies: ${JSON.stringify(copies)}`,
);

// tasks/typing-indicator.md, across replicas — the same fan-out path, and the one most likely to be
// left process-local because it never touches a database.
watchers[0].send({ type: 'typing', conversationId: conv.id, isTyping: true });
const typingSeen = [];
for (const w of watchers.slice(1)) {
  typingSeen.push(Boolean(await w.waitFor((e) => e.type === 'typing' && e.userId === 1, 4_000)));
}
check(
  typingSeen.every(Boolean),
  'a typing indicator reaches clients on other replicas',
  `${typingSeen.filter(Boolean).length}/${typingSeen.length} other sockets saw it`,
);
check(
  !watchers[0].events.some((e) => e.type === 'typing' && e.userId === 1),
  'and never comes back to the person typing',
);

// Presence: shared state, so every replica must agree — not just the one holding the socket.
const presenceConv = await newConversation([1, 5]);
const erin = await socket(5, [presenceConv.id]);
await sleep(500);
const presenceAnswers = new Map();
for (let i = 0; i < 24 && presenceAnswers.size < replicaCount; i++) {
  const res = await jget('/api/conversations?userId=1&limit=200');
  if (!res.instance || presenceAnswers.has(res.instance)) continue;
  const row = res.body.conversations.find((c) => c.id === presenceConv.id);
  presenceAnswers.set(res.instance, row?.participants?.find((p) => p.id === 5)?.online);
}
check(
  [...presenceAnswers.values()].every((online) => online === true),
  'presence reads the same from every replica',
  [...presenceAnswers.entries()].map(([id, online]) => `${id}=${online}`).join(' '),
);
await erin.close();

/* ------------------------------------------------------- 3. failover mid-connection */

section('surviving gaps, and cleaning up');

console.log(
  `  sockets per replica: ${[...holding.entries()].map(([id, h]) => `${id}=${h.connections}`).join(' ')}`,
);

const gapMarker = uid('gap');
await jpost('/api/messages', {
  conversationId: conv.id, senderId: 1, body: gapMarker, clientId: gapMarker,
});
await sleep(1_000);
const gapDelivered = watchers.filter((w) =>
  w.events.some((e) => e.type === 'message' && e.body === gapMarker),
).length;
check(
  gapDelivered === watchers.length,
  'fan-out is still exactly-once after a burst of other traffic',
  `${gapDelivered}/${watchers.length}`,
);

// A client that missed events while its replica was gone recovers them over HTTP rather than relying
// on the socket, which is what makes at-most-once pub/sub acceptable. Prove the recovery path works
// from any replica.
const history = await jget(`/api/messages?conversationId=${conv.id}&userId=1&since=0`);
check(
  history.body.messages.some((m) => m.body === marker) &&
    history.body.messages.some((m) => m.body === gapMarker),
  'catch-up over HTTP can replay everything a socket might have missed',
  `served by ${history.instance}, ${history.body.messages.length} message(s) since the start`,
);

await Promise.all(watchers.map((w) => w.close()));

// A replica must not keep holding what a departed client had. Deltas again, so a browser tab left open
// elsewhere doesn't read as a leak.
await sleep(1_500);
const afterClose = await pollReplicas();
check(
  sum(afterClose, 'connections') === heldBefore,
  'replicas release every socket this probe opened',
  `back to the ${heldBefore} that were there before (now ${sum(afterClose, 'connections')})`,
);
check(
  sum(afterClose, 'subscribedConversations') === channelsBefore,
  'and release every Redis channel those sockets held',
  `back to ${channelsBefore} (now ${sum(afterClose, 'subscribedConversations')})`,
);

/* ------------------------------------------------------------------------ summary */

const failed = results.filter((r) => !r.pass);
console.log(
  `\n═══ ${results.length - failed.length}/${results.length} checks passed ` +
    `across ${replicaCount} replica(s) ═══`,
);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.requirement}`);
}
if (replicaCount === 1) {
  console.log(
    '  note: only one replica answered, so the cross-replica checks proved little.\n' +
      '  run `docker compose up -d --scale api=3` first.',
  );
}
process.exit(failed.length ? 1 : 0);
