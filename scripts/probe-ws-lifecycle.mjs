/**
 * Does a socket that dies mid-subscribe leak its Redis channel subscriptions?
 *
 * This is the probe that found the worst of the code-review findings (docs/08-review-fixes.md).
 * `handleSubscribe` awaits a participant query before acquiring channels, so the close handler can
 * run first — and the resumed handler then acquired subscriptions nobody was left to release. One
 * replica was found holding 741 channels for zero connections.
 *
 * Run it against a SINGLE instance, because `subscribedConversations` is per-process and Envoy
 * round-robins:
 *
 *   docker compose exec api node scripts/probe-ws-lifecycle.mjs
 *   docker compose exec api node scripts/probe-ws-lifecycle.mjs 20     # more rounds
 *
 * Inside the container `localhost:3000` is that container, so the socket and the health read land on
 * the same process. Pointing it at the proxy instead will report nonsense.
 */

const BASE = process.env.RELAY_URL || 'http://localhost:3000';
const ROUNDS = Number(process.argv[2] ?? 5);
const USER_ID = Number(process.env.USER_ID ?? 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async () => (await fetch(`${BASE}/api/health`)).json();

/** A handful of conversations this user is actually in — the server intersects the request anyway. */
async function conversationIdsFor(userId) {
  const res = await fetch(`${BASE}/api/conversations?userId=${userId}&limit=10`);
  if (!res.ok) throw new Error(`could not list conversations: ${res.status}`);
  const page = await res.json();
  const ids = page.conversations.map((c) => c.id);
  if (!ids.length) throw new Error(`user ${userId} is in no conversations`);
  return ids;
}

/** Opens a socket, asks to subscribe, and drops it before the server can finish authorizing. */
async function raceOnce(conversationIds) {
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
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('ws error'));
      },
      { once: true },
    );
  });
  ws.send(JSON.stringify({ type: 'subscribe', userId: USER_ID, conversationIds }));
  ws.close();
}

const conversationIds = await conversationIdsFor(USER_ID);
const before = await health();
console.log(
  `instance ${before.instanceId}: ${before.subscribedConversations} channel(s), ` +
    `${before.connections} connection(s)`,
);
console.log(
  `racing ${ROUNDS} subscribe/close rounds over ${conversationIds.length} conversations…`,
);

for (let round = 0; round < ROUNDS; round++) {
  await raceOnce(conversationIds);
  await sleep(300);
}

// Let the last close and any in-flight handler settle before reading the count back.
await sleep(2_000);
const after = await health();
const leaked = after.subscribedConversations - before.subscribedConversations;

console.log(
  `instance ${after.instanceId}: ${after.subscribedConversations} channel(s), ` +
    `${after.connections} connection(s)`,
);
console.log(`\nLEAKED CHANNELS: ${leaked} (expected 0)`);
if (leaked > 0) {
  console.error(
    'A closed socket left channels behind. Nothing will ever release them: the client is already ' +
      'out of the registry, so this instance keeps receiving traffic for conversations no local ' +
      'socket cares about, for the life of the process.',
  );
}
process.exit(leaked > 0 ? 1 : 0);
