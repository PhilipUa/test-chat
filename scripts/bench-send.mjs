/**
 * Reproduces the measurement from docs/01-investigation.md finding B: what does a burst of
 * concurrent sends do to the latency of an unrelated read?
 *
 * The original build spent 20ms of blocked event loop per message in pbkdf2Sync, so an idle 4ms
 * GET became a 790ms GET during a 50-message burst.
 *
 * Sends are spread over many conversations because sends are rate limited now (5/10s per user per
 * conversation) — piling them into one conversation would measure the limiter, not the write path.
 *
 * Usage: node scripts/bench-send.mjs [concurrentSends]
 */
const BASE = process.env.RELAY_URL || 'http://localhost:3000';
const TARGET = Number(process.argv[2] || 50);

const post = (path, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Waits until the proxy has a healthy upstream — relevant right after scaling replicas. */
async function waitForReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok && (await res.json()).ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API not ready');
}

async function postJson(path, body) {
  const res = await post(path, body);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} -> ${res.status}: ${text.slice(0, 120)}`);
  }
}

async function timed(fn) {
  const t = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

const SENDERS = [1, 2, 3];
const PER_PAIR = 4; // stay under the 5/10s per-user-per-conversation limit
const conversationsNeeded = Math.ceil(TARGET / (SENDERS.length * PER_PAIR));

await waitForReady();
process.stdout.write(`preparing ${conversationsNeeded} conversations… `);
const conversations = [];
for (let i = 0; i < conversationsNeeded; i++) {
  const created = await postJson('/api/conversations', {
    title: `bench-${Date.now()}-${i}`,
    participantIds: SENDERS,
  });
  conversations.push(created.id);
}
console.log('done');

const sends = [];
for (const conversationId of conversations) {
  for (const senderId of SENDERS) {
    for (let i = 0; i < PER_PAIR && sends.length < TARGET; i++) {
      sends.push({
        conversationId,
        senderId,
        body: `bench ${i}`,
        clientId: `bench-${conversationId}-${senderId}-${i}-${Date.now()}`,
      });
    }
  }
}

// Idle baseline.
const idle = [];
for (let i = 0; i < 5; i++) {
  idle.push(await timed(() => fetch(`${BASE}/api/conversations?userId=1`)));
}
const idleMedian = median(idle);

// Fire the burst, and sample read latency while it is in flight.
const inFlight = sends.map((s) => post('/api/messages', s));
const under = [];
for (let i = 0; i < 5; i++) {
  under.push(await timed(() => fetch(`${BASE}/api/conversations?userId=1`)));
}
const responses = await Promise.all(inFlight);
const statuses = responses.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, {});

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const underMedian = median(under);
console.log(`
sends fired concurrently : ${sends.length}
response codes           : ${JSON.stringify(statuses)}
GET latency, idle        : ${idleMedian.toFixed(1)} ms (median of 5)
GET latency, under load  : ${underMedian.toFixed(1)} ms (median of 5)
GET latency, worst       : ${Math.max(...under).toFixed(1)} ms
degradation factor       : ${(underMedian / idleMedian).toFixed(1)}x
`);
