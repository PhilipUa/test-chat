/** Shared helpers for the integration suite. Runs against a live stack via the Envoy proxy. */

export const BASE = process.env.RELAY_URL || 'http://localhost:3000';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, body: json, text };
}

export const get = (path) => req('GET', path);
export const post = (path, body) => req('POST', path, body);

export function unique(prefix) {
  return `${prefix}-${process.hrtime.bigint().toString(36)}`;
}

/** Waits for the API to be reachable and to report Redis healthy. */
export async function waitForApi(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const res = await get('/api/health');
      if (res.status === 200 && res.body?.ok) return res.body;
      last = res.text;
    } catch (err) {
      last = err.message;
    }
    await sleep(500);
  }
  throw new Error(`API not healthy within ${timeoutMs}ms: ${last}`);
}

/**
 * Creates a fresh conversation so tests don't interfere with each other or with the demo data —
 * important for the rate-limit tests in particular, since the limiter is keyed per conversation.
 */
export async function freshConversation(participantIds = [1, 2], title = unique('test-conv')) {
  const res = await post('/api/conversations', { title, participantIds });
  if (res.status !== 201) throw new Error(`could not create conversation: ${res.status} ${res.text}`);
  return res.body;
}

/** Opens a WS, subscribes, and collects events. */
export async function wsClient(userId, conversationIds) {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/');
  const events = [];
  ws.addEventListener('message', (ev) => {
    try {
      events.push(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timeout')), 10_000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('ws error')); }, { once: true });
  });

  const client = {
    ws,
    events,
    send: (payload) => ws.send(JSON.stringify(payload)),
    /** Waits for an event matching `predicate`, or resolves undefined on timeout. */
    async waitFor(predicate, timeoutMs = 4_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = events.find(predicate);
        if (hit) return hit;
        await sleep(50);
      }
      return undefined;
    },
    close: () => ws.close(),
  };

  client.send({ type: 'subscribe', userId, conversationIds });
  // Wait for the server's ack, so a subsequent POST can't race the subscription.
  await client.waitFor((e) => e.type === 'subscribed', 4_000);
  return client;
}

/**
 * Posts `count` messages into a conversation for tests that need history.
 *
 * Spreads sends across the participants and honours a 429's Retry-After, because the rate
 * limiter applies to test traffic too — a naive loop here gets throttled at 5 and the test then
 * fails for the wrong reason. Sequential so message ordering stays deterministic.
 */
export async function seedMessages(conversationId, count, senderIds = [1, 2, 3]) {
  const sent = [];
  for (let i = 0; i < count; i++) {
    const senderId = senderIds[i % senderIds.length];
    const payload = {
      conversationId,
      senderId,
      body: `page-msg-${i}`,
      clientId: unique('seed'),
    };
    let res = await post('/api/messages', payload);
    if (res.status === 429) {
      const wait = (Number(res.headers.get('retry-after')) || 1) * 1000 + 250;
      await sleep(wait);
      // Same clientId, so this is the idempotent retry path rather than a new message.
      res = await post('/api/messages', payload);
    }
    if (res.status >= 400) throw new Error(`seed send failed: ${res.status} ${res.text}`);
    sent.push(res.body);
  }
  return sent;
}

/**
 * Samples /api/health enough times to see every replica behind the proxy, returning
 * instanceId -> startedAt. Round-robin means one call only tells you about one replica.
 */
export async function instanceFingerprints(samples = 12) {
  const seen = new Map();
  for (let i = 0; i < samples; i++) {
    const res = await get('/api/health');
    if (res.status === 200 && res.body?.instanceId) {
      seen.set(res.body.instanceId, res.body.startedAt);
    }
  }
  return seen;
}
