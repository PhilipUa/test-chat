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

/**
 * Runs `request` and, if it comes back 429, honours Retry-After once and retries.
 *
 * The one spelling of the wait — Retry-After is whole seconds, plus a small buffer for clock skew
 * between the limiter's window and ours. This pattern used to live as four verbatim copies (one of
 * which had quietly diverged); every helper that talks to a metered endpoint goes through here.
 * The result may still be a 429 — what that means is the caller's decision, so callers must check
 * the status rather than assume the retry succeeded.
 */
export async function retryOn429(request) {
  let res = await request();
  if (res.status === 429) {
    await sleep((Number(res.headers.get('retry-after')) || 1) * 1000 + 250);
    res = await request();
  }
  return res;
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
 *
 * Conversation creation is itself rate limited (per user), and nearly every test needs a
 * conversation, so the creator is rotated across users to spread the load. User 3 is deliberately
 * never used as the creator here: the test that proves the create limit works has to exhaust
 * somebody's allowance, and it uses user 3 so it can't starve everything else.
 */
let creatorTurn = 0;
const RESERVED_LIMIT_TEST_CREATOR = 3;

export async function freshConversation(participantIds = [1, 2], title = unique('test-conv')) {
  const candidates = participantIds.filter((id) => id !== RESERVED_LIMIT_TEST_CREATOR);
  const creator = candidates.length
    ? candidates[creatorTurn++ % candidates.length]
    : participantIds[0];
  // The route treats the first id as the creator, so put the chosen one first.
  const ordered = [creator, ...participantIds.filter((id) => id !== creator)];

  // Honour the limiter rather than failing the test for the wrong reason.
  const res = await retryOn429(() =>
    post('/api/conversations', { title, participantIds: ordered }),
  );
  if (res.status !== 201)
    throw new Error(`could not create conversation: ${res.status} ${res.text}`);
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
    /**
     * Closes and waits for the socket to actually be closed.
     *
     * Awaiting matters for anything presence-related: a test that closes without waiting leaves
     * the server holding a live connection until its heartbeat reaps it, so the *next* test sees
     * that user as online and its assertions become order-dependent. That cost me a while to
     * track down.
     */
    close: async () => {
      if (ws.readyState === WebSocket.CLOSED) return;
      const closed = new Promise((resolve) => {
        ws.addEventListener('close', resolve, { once: true });
        setTimeout(resolve, 2_000);
      });
      ws.close();
      await closed;
    },
  };

  client.send({ type: 'subscribe', userId, conversationIds });
  // Wait for the server's ack, so a subsequent POST can't race the subscription.
  await client.waitFor((e) => e.type === 'subscribed', 4_000);
  return client;
}

/**
 * The inbox for a user, as a plain array.
 *
 * One place that knows the endpoint's response shape, so a change to it doesn't ripple through every
 * test that only wants the conversations. Tolerates the pre-pagination bare-array form too, which
 * keeps a paging regression pointed at the tests that assert the shape explicitly rather than
 * breaking every presence test at the same time.
 */
export async function conversationsOf(userId, { limit, cursor } = {}) {
  const query = new URLSearchParams({ userId: String(userId) });
  if (limit !== undefined) query.set('limit', String(limit));
  if (cursor) query.set('cursor', cursor);
  // List reads are metered too, and the presence helpers below poll this endpoint several times a
  // second. Honour Retry-After rather than returning an empty inbox: a throttled poll that looks
  // like "no conversations" fails the caller's assertion for entirely the wrong reason.
  const res = await retryOn429(() => get(`/api/conversations?${query}`));
  if (res.status === 429) {
    // Still throttled after honouring Retry-After. Returning [] here is the exact wrong-reason
    // failure the retry exists to prevent — the caller would assert on an empty inbox with no
    // trace of throttling — so fail the way the other helpers do: loudly, with the status.
    throw new Error(`inbox read throttled twice for user ${userId}: ${res.status} ${res.text}`);
  }
  if (Array.isArray(res.body)) return res.body;
  return res.body?.conversations ?? [];
}

/** How `viewerId` currently sees `userId` in `conversationId` — the participant row, or undefined. */
export async function presenceOf(viewerId, conversationId, userId) {
  const conversations = await conversationsOf(viewerId, { limit: 200 });
  return conversations
    .find((c) => c.id === conversationId)
    ?.participants?.find((p) => p.id === userId);
}

/**
 * Waits until `userId` is reported offline in `conversationId`, so a presence test starts from a
 * known baseline rather than inheriting connections from whatever ran before it.
 */
export async function waitUntilOffline(viewerId, conversationId, userId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const participant = await presenceOf(viewerId, conversationId, userId);
    if (participant && !participant.online) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Sends one message that the test depends on landing.
 *
 * `post()` alone hides why a test then fails: a throttled send returns 429, nothing is delivered, and the
 * assertion that was waiting for it times out with no clue as to the cause. That is exactly how the unread
 * badge test failed once under load — as "timeout waiting for badge" rather than "the send was throttled".
 * This honours a 429's Retry-After once and throws with the status otherwise.
 */
export async function sendMessage(payload) {
  // Same clientId on the retry, so it is the idempotent path rather than a second message.
  const res = await retryOn429(() => post('/api/messages', payload));
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`send failed: ${res.status} ${res.text}`);
  }
  return res.body;
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
    // Same clientId on the retry, so it is the idempotent path rather than a new message.
    const res = await retryOn429(() => post('/api/messages', payload));
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
