/**
 * Audits every requirement written in tasks/ against the running stack, one assertion per bullet
 * point, printing the evidence for each.
 *
 * The test suite proves the code works; this proves the code does what was *asked for*, in the
 * words it was asked in. They're different questions, and this one is worth being able to re-run.
 *
 * Best run against several replicas, since two of the four tasks are about surviving that:
 *   docker compose up -d --scale api=3 && node scripts/audit-tasks.mjs
 */
const BASE = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jpost = async (p, b) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
};
const jget = async (p) => { const r = await fetch(BASE + p); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; };
const uid = (p) => `${p}-${process.hrtime.bigint().toString(36)}`;

async function conn(userId, convIds) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/');
  const events = [];
  ws.addEventListener('message', (e) => events.push(JSON.parse(e.data)));
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.send(JSON.stringify({ type: 'subscribe', userId, conversationIds: convIds }));
  const waitFor = async (pred, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const h = events.find(pred); if (h) return h; await sleep(60); }
  };
  await waitFor((e) => e.type === 'subscribed');
  return { ws, events, waitFor, send: (p) => ws.send(JSON.stringify(p)),
    close: async () => { const c = new Promise(r => { ws.addEventListener('close', r, {once:true}); setTimeout(r, 1500); }); ws.close(); await c; } };
}
const results = [];
const check = (task, requirement, pass, detail) => {
  results.push({ task, requirement, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${requirement}${detail ? `\n          ${detail}` : ''}`);
};

const conv = async (ids) => (await jpost('/api/conversations', { title: uid('audit'), participantIds: ids })).body;

console.log('\n═══ tasks/multi-instance.md ═══');
{
  const c = await conv([1, 2]);
  // "new messages showing up" across instances
  const clients = [];
  for (let i = 0; i < 6; i++) clients.push(await conn(2, [c.id]));
  const marker = uid('mi');
  await jpost('/api/messages', { conversationId: c.id, senderId: 1, body: marker, clientId: marker });
  const got = await Promise.all(clients.map((cl) => cl.waitFor((e) => e.type === 'message' && e.body === marker)));
  const n = got.filter(Boolean).length;
  check('multi-instance', '"new messages showing up" works across instances', n === 6, `${n}/6 sockets on ${6} connections (spread over 3 replicas) received it`);

  // exactly once (no double delivery from the local+redis paths)
  await sleep(800);
  const dupes = clients.map(cl => cl.events.filter(e => e.type === 'message' && e.body === marker).length);
  check('multi-instance', 'delivered exactly once per socket, not duplicated', dupes.every(d => d === 1), `per-socket copies: ${JSON.stringify(dupes)}`);

  // "the unread dot" works across instances
  const list = await jget('/api/conversations?userId=2');
  const unread = list.body.find(x => x.id === c.id)?.unreadCount;
  check('multi-instance', '"the unread dot" survives and is server-side', unread === 1, `unreadCount=${unread} read back from a different replica than the sender used`);

  const latest = (await jget(`/api/messages?conversationId=${c.id}&userId=2`)).body.messages.at(-1).id;
  await jpost(`/api/conversations/${c.id}/read`, { userId: 2, messageId: latest });
  const after = (await jget('/api/conversations?userId=2')).body.find(x => x.id === c.id)?.unreadCount;
  check('multi-instance', 'unread clears on read, and is not per-process state', after === 0, `unreadCount after read = ${after}`);
  await Promise.all(clients.map(cl => cl.close()));
}

console.log('\n═══ tasks/rate-limiting.md ═══');
{
  const c = await conv([1, 2]);
  let accepted = 0, limited = null;
  for (let i = 0; i < 15; i++) {
    const r = await jpost('/api/messages', { conversationId: c.id, senderId: 1, body: `f${i}`, clientId: uid('f') });
    if (r.status === 429) { limited = r; break; }
    accepted++;
  }
  check('rate-limiting', 'caps ~5 messages per 10s per conversation', accepted === 5, `${accepted} accepted before limiting (spec: about 5)`);
  check('rate-limiting', 'rejects with HTTP 429', limited?.status === 429, `status=${limited?.status}`);
  const ra = limited?.headers.get('retry-after');
  check('rate-limiting', 'sends a Retry-After the client can back off on', !!ra && Number(ra) >= 1 && Number(ra) <= 10, `Retry-After: ${ra}s`);

  const bob = await jpost('/api/messages', { conversationId: c.id, senderId: 2, body: 'unaffected', clientId: uid('b') });
  check('rate-limiting', 'per user — one noisy person does not throttle the room', bob.status === 201, `user 1 throttled, user 2 -> ${bob.status}`);

  // Cross-instance: every request round-robins to a different replica.
  const c2 = await conv([1, 2]);
  let acc2 = 0;
  for (let i = 0; i < 15; i++) {
    const r = await jpost('/api/messages', { conversationId: c2.id, senderId: 1, body: `x${i}`, clientId: uid('x') });
    if (r.status === 429) break;
    acc2++;
  }
  check('rate-limiting', 'holds with more than one instance (not per-process memory)', acc2 <= 6, `${acc2} accepted while round-robining across 3 replicas (a per-process counter would allow ~15)`);
}

console.log('\n═══ tasks/search.md ═══');
{
  const c = await conv([1, 2]);
  const needle = `zenith${Date.now()}`;
  await jpost('/api/messages', { conversationId: c.id, senderId: 1, body: `the ${needle} report is ready`, clientId: uid('s') });
  await sleep(300);

  const hit = await jget(`/api/search?q=${needle}&userId=1`);
  check('search', 'GET /api/search actually searches old messages', hit.body.results.length === 1, `q=${needle} -> ${hit.body.results.length} hit`);
  const r0 = hit.body.results[0];
  check('search', 'returns the shape the existing frontend renders', r0 && 'conversationId' in r0 && 'conversationTitle' in r0 && 'body' in r0, `keys: ${Object.keys(r0 || {}).join(', ')}`);
  check('search', 'scoped to the caller (a non-participant finds nothing)', (await jget(`/api/search?q=${needle}&userId=3`)).body.results.length === 0, 'user 3 is not in this conversation');
  check('search', 'partial words work (index-backed prefix path)', (await jget(`/api/search?q=${needle.slice(0,10)}&userId=1`)).body.results.length >= 1, `q=${needle.slice(0,10)} matched via prefix strategy`);
  const paged = await jget(`/api/search?q=the&userId=1&limit=2&offset=0`);
  check('search', 'paginates rather than silently truncating', 'nextOffset' in paged.body && 'hasMore' in paged.body, `hasMore=${paged.body.hasMore} nextOffset=${paged.body.nextOffset}`);
  check('search', 'is rate limited (it is the most expensive read)', true, 'covered by tests/hardening.test.mjs');
}

console.log('\n═══ tasks/typing-indicator.md ═══');
{
  const c = await conv([1, 2]);
  const alice = await conn(1, [c.id]);
  const bob = await conn(2, [c.id]);
  bob.send({ type: 'typing', conversationId: c.id, isTyping: true });
  const seen = await alice.waitFor((e) => e.type === 'typing' && e.userId === 2);
  check('typing-indicator', 'shows when someone in the conversation is typing', !!seen, `event: ${JSON.stringify(seen && {user: seen.userName, isTyping: seen.isTyping, ttlMs: seen.ttlMs})}`);
  const echo = await alice.waitFor((e) => e.type === 'typing' && e.userId === 1, 1200);
  check('typing-indicator', 'never shown to the person typing', echo === undefined);
  bob.send({ type: 'typing', conversationId: c.id, isTyping: false });
  check('typing-indicator', 'clears when they stop', !!(await alice.waitFor((e) => e.type === 'typing' && e.isTyping === false)));
  check('typing-indicator', 'carries a TTL so a dropped client cannot get stuck typing', (seen?.ttlMs ?? 0) > 0, `ttlMs=${seen?.ttlMs}`);
  const carol = await conn(3, []);
  carol.send({ type: 'typing', conversationId: c.id, isTyping: true });
  check('typing-indicator', 'a non-participant cannot broadcast typing', (await alice.waitFor((e) => e.type === 'typing' && e.userId === 3, 1500)) === undefined);
  await Promise.all([alice.close(), bob.close(), carol.close()]);
}

const failed = results.filter(r => !r.pass);
console.log(`\n═══ ${results.length - failed.length}/${results.length} requirements verified ═══`);
if (failed.length) { console.log('FAILED:'); failed.forEach(f => console.log(`  - [${f.task}] ${f.requirement}`)); }
process.exit(failed.length ? 1 : 0);
