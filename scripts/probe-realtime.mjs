// Probe: does a message POSTed to one API instance reach a WS client on another?
// Usage: node scripts/probe-realtime.mjs [baseUrl]
const base = process.argv[2] || 'http://localhost:3000';
const wsUrl = base.replace(/^http/, 'ws') + '/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open several WS clients. With N api instances behind a round-robin proxy,
// each lands on a (probably) different instance.
const N = 6;
const clients = [];
for (let i = 0; i < N; i++) {
  const ws = new WebSocket(wsUrl);
  const got = [];
  ws.addEventListener('message', (ev) => got.push(JSON.parse(ev.data)));
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.send(JSON.stringify({ type: 'subscribe', userId: 1, conversationIds: [1, 2] }));
  clients.push({ ws, got, i });
}
await sleep(300);

const marker = 'realtime-probe-' + Math.floor(Math.random() * 1e9);
const res = await fetch(base + '/api/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ conversationId: 1, senderId: 1, body: marker, clientId: marker }),
});
console.log('POST /api/messages ->', res.status);
await sleep(1200);

let delivered = 0;
for (const c of clients) {
  const hit = c.got.some((m) => m.type === 'message' && m.body === marker);
  console.log(`  ws client #${c.i}: ${hit ? 'GOT the message' : 'MISSED it'}`);
  if (hit) delivered++;
  c.ws.close();
}
console.log(`\nfan-out: ${delivered}/${N} connected clients received the new message`);
process.exit(delivered === N ? 0 : 1);
