/**
 * Does anything leak when the app is used for a while?
 *
 * This session found two leaks — Redis channel subscriptions held by a replica with no connections, and
 * presence entries for sockets that no longer existed. Both were invisible to a green test suite, because a
 * test asserts behaviour and then exits: it never asks what the process is still *holding*. Both were found
 * by reading /api/health at a moment when nothing should have been held.
 *
 * So this churns the app for a few minutes — sockets connecting and going away, messages, reads — sampling
 * what each replica holds, and then checks it all comes back to where it started. Deltas throughout, because
 * a browser tab left open elsewhere is normal and must not read as a leak.
 *
 *   docker compose up -d --scale api=3
 *   node scripts/probe-soak.mjs               # 3 minutes
 *   node scripts/probe-soak.mjs --minutes 15  # longer, for a slower leak
 *
 * Read-only: it creates conversations and messages like any client, and stops nothing.
 */
const BASE = process.env.RELAY_URL || 'http://localhost:3000';

const numberOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const MINUTES = numberOf('minutes', 3);
const CHURN = numberOf('churn', 6);
/** Allowed RSS growth per replica. Node's heap grows and settles; a leak keeps climbing. */
const MEMORY_BUDGET_MB = numberOf('memory-budget', 60);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (p) => `${p}-${process.hrtime.bigint().toString(36)}`;

const results = [];
const check = (pass, what, detail) => {
  results.push({ pass, what });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${what}${detail ? `\n          ${detail}` : ''}`);
};

const jpost = async (p, b) => {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/** instanceId -> what that replica currently holds. */
async function snapshot(samples = 24) {
  const seen = new Map();
  for (let i = 0; i < samples; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      const body = await res.json();
      seen.set(body.instanceId, {
        connections: body.connections,
        channels: body.subscribedConversations,
        memoryMb: body.memoryMb,
      });
    } catch {
      /* a replica mid-restart is expected */
    }
  }
  return seen;
}

const total = (snap, field) => [...snap.values()].reduce((n, s) => n + s[field], 0);

/** One cycle of a client's life: connect, subscribe, send, be closed. The shape that leaked. */
async function churnOnce(conversationId, userId) {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('open timeout')), 10_000);
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
    ws.send(JSON.stringify({ type: 'subscribe', userId, conversationIds: [conversationId] }));
    await sleep(400);
    ws.send(JSON.stringify({ type: 'typing', conversationId, isTyping: true }));
    await sleep(300);
  } catch {
    /* count it as churn either way */
  } finally {
    ws.close();
  }
}

/**
 * Deliberately includes the shape that caused the worst leak: a socket that goes away while its subscribe
 * is still in flight. If the fix regresses, this is what will surface it.
 */
async function churnRace(conversationId, userId) {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('open timeout')), 10_000);
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
    ws.send(JSON.stringify({ type: 'subscribe', userId, conversationIds: [conversationId] }));
    ws.close(); // no wait: the server is still inside the participant query
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------------- run */

console.log(`  soaking for ${MINUTES} minute(s) with ${CHURN} concurrent churn workers…`);

const conversations = [];
for (let i = 0; i < 3; i++) {
  const conv = (await jpost('/api/conversations', { title: uid('soak'), participantIds: [1, 2] }))
    .body;
  if (conv?.id) conversations.push(conv.id);
}
if (!conversations.length) {
  console.error('  could not create a conversation to soak against');
  process.exit(1);
}

const baseline = await snapshot();
console.log(
  `  baseline: ${[...baseline.entries()].map(([id, s]) => `${id}=${s.connections}c/${s.channels}ch/${s.memoryMb}MB`).join('  ')}`,
);

const until = Date.now() + MINUTES * 60_000;
let cycles = 0;
let races = 0;
let sends = 0;
let throttled = 0;
const trend = [];
let sampling = true;

const sampler = (async () => {
  while (sampling) {
    await sleep(15_000);
    if (!sampling) break;
    const snap = await snapshot();
    trend.push(snap);
    const elapsed = Math.round((MINUTES * 60_000 - (until - Date.now())) / 1000);
    console.log(
      `  t+${String(elapsed).padStart(3)}s  held=${total(snap, 'connections')}c/${total(snap, 'channels')}ch  ` +
        `rss=[${[...snap.values()].map((s) => s.memoryMb).join(', ')}]MB  cycles=${cycles} races=${races}`,
    );
  }
})();

const workers = Array.from({ length: CHURN }, async (_, w) => {
  while (Date.now() < until) {
    const conversationId = conversations[(cycles + w) % conversations.length];
    const userId = w % 2 ? 2 : 1;
    // One in four is the close-during-subscribe race that caused the permanent channel leak.
    if (cycles % 4 === 3) {
      races += 1;
      await churnRace(conversationId, userId);
    } else {
      await churnOnce(conversationId, userId);
    }
    cycles += 1;

    const res = await jpost('/api/messages', {
      conversationId,
      senderId: userId,
      body: uid('soak-msg'),
      clientId: uid('soak'),
    });
    if (res.status === 201) sends += 1;
    else if (res.status === 429) throttled += 1;

    await fetch(`${BASE}/api/conversations?userId=${userId}&limit=20`).catch(() => {});
  }
});

await Promise.all(workers);
sampling = false;
await sampler;

// Let heartbeats reap anything mid-close, and give GC a chance before judging memory.
console.log('  churn stopped; letting the stack settle…');
await sleep(20_000);
const after = await snapshot();

console.log(
  `  final:    ${[...after.entries()].map(([id, s]) => `${id}=${s.connections}c/${s.channels}ch/${s.memoryMb}MB`).join('  ')}`,
);
console.log(
  `  did ${cycles} connect/close cycles (${races} of them the subscribe race), ${sends} sends, ${throttled} throttled`,
);

check(
  total(after, 'connections') <= total(baseline, 'connections'),
  'every socket this probe opened has been released',
  `baseline ${total(baseline, 'connections')} → ${total(after, 'connections')}`,
);

check(
  total(after, 'channels') <= total(baseline, 'channels'),
  'no Redis channel subscription was left behind',
  `baseline ${total(baseline, 'channels')} → ${total(after, 'channels')} ` +
    `after ${races} close-during-subscribe races`,
);

const growth = [...after.entries()].map(([id, s]) => ({
  id,
  grew: s.memoryMb - (baseline.get(id)?.memoryMb ?? s.memoryMb),
}));
const worst = Math.max(...growth.map((g) => g.grew));
check(
  worst <= MEMORY_BUDGET_MB,
  `no replica grew its resident memory by more than ${MEMORY_BUDGET_MB}MB`,
  growth.map((g) => `${g.id} ${g.grew >= 0 ? '+' : ''}${g.grew}MB`).join('  '),
);

// The memory signal itself, end to end. Not a scale-up demo — RSS here grows and settles rather than
// tracking load, so a memory *watermark* is a leak and pressure guard, not a load signal. What is worth
// asserting is that the number is live: reported, non-zero, and actually moving. A metric frozen at a
// constant would satisfy every unit test and tell an autoscaler nothing.
const memoryValues = [...after.values()].map((s) => s.memoryMb);
check(
  memoryValues.every((v) => v > 0),
  'every replica reports a real resident-memory figure',
  `${memoryValues.join(', ')}MB`,
);
const moved = [...after.entries()].some(
  ([id, s]) => s.memoryMb !== (baseline.get(id)?.memoryMb ?? s.memoryMb),
);
check(
  moved,
  'and the figure moves with use, rather than being frozen at a constant',
  `baseline [${[...baseline.values()].map((s) => s.memoryMb).join(', ')}] → [${memoryValues.join(', ')}]MB`,
);

// A leak climbs; a heap that grows and settles does not. Comparing the last two samples separates them.
if (trend.length >= 2) {
  const last = total(trend[trend.length - 1], 'memoryMb');
  const previous = total(trend[trend.length - 2], 'memoryMb');
  console.log(
    `  memory over the last two samples: ${previous}MB → ${last}MB across all replicas ` +
      `(${last > previous ? 'still climbing at the end — worth a longer --minutes' : 'settled'})`,
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\n═══ ${results.length - failed.length}/${results.length} soak checks passed ═══`);
for (const f of failed) console.log(`  FAILED: ${f.what}`);
process.exit(failed.length ? 1 : 0);
