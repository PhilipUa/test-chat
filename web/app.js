/**
 * Relay frontend.
 *
 * Fixes and additions over the original, all annotated inline:
 *  - conversation titles were interpolated into innerHTML (stored XSS) -> DOM + textContent
 *  - the WebSocket never reconnected, so one blip stopped all updates silently
 *  - a send had no local echo and no dedup, so it relied entirely on the broadcast coming back
 *  - the unread dot lived in a JS variable and vanished on reload -> server-side watermark
 *  - no handling of a 429 from the new rate limiter
 *  - typing indicator, message pagination, and a user switcher
 */

/**
 * Which demo user this tab is acting as.
 *
 * sessionStorage, not localStorage: sessionStorage is scoped per tab, so you can be Alice in one
 * tab and Bob in another. With localStorage (shared across all tabs of an origin) switching user
 * in one tab silently changed every other tab on its next reload — which makes it impossible to
 * demo the two things that need two people, the typing indicator and the unread badge.
 * `?userId=2` overrides, so a link can pin an identity.
 */
function initialUserId() {
  const fromUrl = Number(new URLSearchParams(location.search).get('userId'));
  if (Number.isInteger(fromUrl) && fromUrl > 0) {
    sessionStorage.setItem('relay.userId', String(fromUrl));
    return fromUrl;
  }
  return Number(sessionStorage.getItem('relay.userId')) || 1;
}

const state = {
  userId: initialUserId(),
  users: [],
  conversations: [],
  activeConversation: null,
  /** Oldest message id currently rendered — the cursor for "load older". */
  oldestLoaded: null,
  hasOlder: false,
  /** clientId -> element, so the broadcast can replace our optimistic bubble rather than duplicate it. */
  pending: new Map(),
  /** Ids already rendered in the open conversation, so a reconnect catch-up can't double up. */
  rendered: new Set(),
  /**
   * conversationId -> Map(userId -> { name, timer }).
   *
   * Keyed by conversation, not flat: typing used to be dropped for any conversation that wasn't
   * open, so you couldn't tell someone was replying in another thread — the indicator only
   * existed if you were already looking at it.
   */
  typing: new Map(),
  /** conversationId -> Set(userId) of participants currently online. */
  presence: new Map(),
  /** conversationId -> highest message id this tab has seen, for `?since=` catch-up. */
  lastSeen: new Map(),
  ws: null,
  wsAttempts: 0,
  lastTypingSentAt: 0,
  viewingSearch: false,
};

const el = (id) => document.getElementById(id);
const userName = (id) => state.users.find((u) => u.id === id)?.name ?? `#${id}`;

/* ---------------------------------------------------------------- data */

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(payload.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.retryAfter = Number(res.headers.get('Retry-After')) || payload.details?.retryAfterSeconds;
    throw err;
  }
  return res.json();
}

async function loadUsers() {
  state.users = await api('/api/users');
  const select = el('userSelect');
  select.replaceChildren(
    ...state.users.map((u) => {
      const option = document.createElement('option');
      option.value = String(u.id);
      option.textContent = u.name;
      option.selected = u.id === state.userId;
      return option;
    }),
  );
}

async function loadConversations() {
  state.conversations = await api(`/api/conversations?userId=${state.userId}`);
  renderSidebar();
  connectWs();
}

/* ------------------------------------------------------------ sidebar */

function renderSidebar() {
  const list = el('conversations');
  list.replaceChildren();

  if (!state.conversations.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No conversations yet.';
    list.appendChild(empty);
    return;
  }

  for (const c of state.conversations) {
    const li = document.createElement('li');
    if (c.id === state.activeConversation) li.className = 'active';

    // Built as nodes with textContent. The original did
    //   li.innerHTML = `<span>${c.title} (…)</span>`
    // with a title that came straight from POST /api/conversations, i.e. stored XSS.
    const main = document.createElement('div');
    main.className = 'conv-main';

    const title = document.createElement('span');
    title.className = 'conv-title';
    title.textContent = `${c.title} (${c.messageCount})`;

    const preview = document.createElement('span');
    preview.className = 'conv-preview';
    // Typing wins over the last-message preview: it's the more current information, and it's the
    // whole point of surfacing typing outside the open conversation.
    const typists = typistsIn(c.id);
    if (typists.length) {
      preview.classList.add('typing-preview');
      preview.textContent =
        typists.length === 1 ? `${typists[0]} is typing…` : `${typists.length} people are typing…`;
    } else {
      preview.textContent = c.lastMessage
        ? `${userName(c.lastMessage.senderId)}: ${c.lastMessage.body}`
        : 'No messages yet';
    }

    main.append(title, preview);

    // A dot for any other participant who's currently connected.
    const online = onlineIn(c.id);
    if ((c.participants ?? []).some((p) => online.has(p.id))) {
      const dot = document.createElement('span');
      dot.className = 'online-dot';
      dot.title = (c.participants ?? [])
        .filter((p) => online.has(p.id))
        .map((p) => p.name)
        .join(', ') + ' online';
      title.prepend(dot);
    }

    li.appendChild(main);

    // Unread count comes from the server now, so it survives a reload and is the same in
    // every tab and on every instance.
    if (c.unreadCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(c.unreadCount);
      li.appendChild(badge);
    }

    li.onclick = () => openConversation(c.id);
    list.appendChild(li);
  }
}

/* ----------------------------------------------------------- messages */

async function openConversation(id) {
  state.activeConversation = id;
  state.viewingSearch = false;
  state.rendered.clear();
  state.pending.clear();

  const conv = state.conversations.find((c) => c.id === id);
  el('title').textContent = conv?.title ?? `#${id}`;
  renderSidebar();

  const pane = el('messages');
  pane.replaceChildren(el('loadOlder'));

  const page = await api(`/api/messages?conversationId=${id}&userId=${state.userId}`);
  state.oldestLoaded = page.nextBefore;
  state.hasOlder = page.hasMore;
  el('loadOlder').style.display = page.hasMore ? 'block' : 'none';

  for (const m of page.messages) appendMessage(m);
  if (page.latestId) state.lastSeen.set(id, page.latestId);
  scrollToBottom();
  renderTyping();
  renderPresence();
  await markRead();
}

// GET /api/messages is paginated now (it used to return every message ever sent in the
// conversation), so older history is fetched on demand.
el('loadOlder').onclick = async () => {
  if (!state.activeConversation || !state.hasOlder) return;
  const button = el('loadOlder');
  button.disabled = true;
  try {
    const page = await api(
      `/api/messages?conversationId=${state.activeConversation}&userId=${state.userId}&before=${state.oldestLoaded}`,
    );
    const pane = el('messages');
    const anchor = pane.firstElementChild?.nextElementSibling ?? null;
    for (const m of page.messages) {
      if (state.rendered.has(m.id)) continue;
      state.rendered.add(m.id);
      pane.insertBefore(buildMessage(m), anchor);
    }
    state.oldestLoaded = page.nextBefore ?? state.oldestLoaded;
    state.hasOlder = page.hasMore;
    button.style.display = page.hasMore ? 'block' : 'none';
  } finally {
    button.disabled = false;
  }
};

function buildMessage(m) {
  const div = document.createElement('div');
  div.className = 'msg';

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = `${userName(m.senderId)}:`;

  const body = document.createElement('span');
  body.className = 'body';
  body.textContent = m.body;

  const at = document.createElement('span');
  at.className = 'at';
  at.textContent = m.createdAt ? new Date(m.createdAt).toLocaleTimeString() : '';

  div.append(who, body, at);
  return div;
}

function appendMessage(m) {
  if (m.id && state.rendered.has(m.id)) return;
  if (m.id) {
    state.rendered.add(m.id);
    const conversationId = m.conversationId ?? state.activeConversation;
    if (conversationId && m.id > (state.lastSeen.get(conversationId) ?? 0)) {
      state.lastSeen.set(conversationId, m.id);
    }
  }

  // If this is the broadcast of something we sent optimistically, upgrade that bubble in place
  // instead of appending a second copy of the same message.
  const optimistic = m.clientId ? state.pending.get(m.clientId) : undefined;
  if (optimistic) {
    state.pending.delete(m.clientId);
    optimistic.replaceWith(buildMessage(m));
    return;
  }

  el('messages').appendChild(buildMessage(m));
  scrollToBottom();
}

function scrollToBottom() {
  const pane = el('messages');
  pane.scrollTop = pane.scrollHeight;
}

async function markRead() {
  const id = state.activeConversation;
  if (!id) return;
  const conv = state.conversations.find((c) => c.id === id);
  const latest = Math.max(0, ...[...state.rendered]);
  if (!latest) {
    if (conv) conv.unreadCount = 0;
    renderSidebar();
    return;
  }
  if (conv) conv.unreadCount = 0;
  renderSidebar();
  try {
    await api(`/api/conversations/${id}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.userId, messageId: latest }),
    });
  } catch {
    // A failed read receipt is cosmetic; the badge will be right again after a refresh.
  }
}

/* --------------------------------------------------------- websocket */

function setConnectionStatus(text, down) {
  const node = el('connection');
  node.textContent = text;
  node.className = down ? 'down' : '';
}

/**
 * The original set `ws.onmessage` and nothing else — no reconnect, no error handling. One dropped
 * connection and the tab stopped updating, with nothing on screen to say so.
 *
 * Now: exponential backoff with jitter, and on every (re)connect we resubscribe *and* refetch the
 * open conversation, because anything broadcast while we were disconnected was missed. Realtime
 * fan-out is best-effort delivery; the HTTP endpoint is the source of truth.
 */
function connectWs() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    subscribe();
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/`);
  state.ws = ws;
  setConnectionStatus('connecting…', false);

  ws.onopen = async () => {
    state.wsAttempts = 0;
    setConnectionStatus('live', false);
    subscribe();
    // Catch up on anything published while we were away. Previously this refetched the whole open
    // conversation; `?since=` fetches only the gap.
    await catchUp();
  };

  ws.onmessage = (ev) => {
    let event;
    try {
      event = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(event);
  };

  ws.onerror = () => setConnectionStatus('connection problem', true);

  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    setConnectionStatus('reconnecting…', true);
    // Backoff caps at 10s, with jitter so N tabs don't all retry on the same tick.
    const delay = Math.min(500 * 2 ** state.wsAttempts++, 10_000) * (0.7 + Math.random() * 0.6);
    setTimeout(connectWs, delay);
  };
}

function subscribe() {
  if (state.ws?.readyState !== WebSocket.OPEN) return;
  // userId is required now: the server intersects the requested ids with the conversations you're
  // actually a participant in, rather than trusting the list (previously you could tail anything).
  state.ws.send(
    JSON.stringify({
      type: 'subscribe',
      userId: state.userId,
      conversationIds: state.conversations.map((c) => c.id),
    }),
  );
}

function handleEvent(event) {
  switch (event.type) {
    case 'message':
      return onMessageEvent(event);
    case 'typing':
      return onTypingEvent(event);
    case 'read':
      return onReadEvent(event);
    case 'presence':
      return onPresenceEvent(event);
    case 'presence-snapshot':
      return onPresenceSnapshot(event);
    case 'resync':
      // The server lost and regained its Redis subscriber, so events published in between were
      // dropped. Our socket never closed, so nothing else would have told us.
      return void catchUp();
    default:
      return;
  }
}

/**
 * Pulls anything missed since the last id we saw, rather than refetching whole conversations.
 *
 * Realtime here is best-effort (Redis pub/sub is at-most-once); this is what makes it eventually
 * complete. Cheap enough to run on every reconnect and every resync nudge.
 */
async function catchUp() {
  // Unread counts and previews for conversations we aren't looking at.
  await loadConversations().catch(() => {});

  const id = state.activeConversation;
  if (!id || state.viewingSearch) return;

  const since = state.lastSeen.get(id);
  if (!since) {
    await openConversation(id).catch(() => {});
    return;
  }

  try {
    let cursor = since;
    // `hasMore` means the gap was bigger than one page; keep walking forwards.
    for (let guard = 0; guard < 20; guard++) {
      const page = await api(
        `/api/messages?conversationId=${id}&userId=${state.userId}&since=${cursor}`,
      );
      for (const m of page.messages) appendMessage(m);
      if (page.latestId) cursor = page.latestId;
      if (!page.hasMore) break;
    }
    await markRead();
  } catch {
    // Falling back to a full reload of the conversation is always correct, just heavier.
    await openConversation(id).catch(() => {});
  }
}

function onMessageEvent(msg) {
  const conv = state.conversations.find((c) => c.id === msg.conversationId);
  if (conv) {
    conv.messageCount += 1;
    conv.lastMessage = { id: msg.id, senderId: msg.senderId, body: msg.body, createdAt: msg.createdAt };
  }

  // Someone who just sent a message is no longer typing.
  stopTyping(msg.conversationId, msg.senderId);

  if (msg.conversationId === state.activeConversation && !state.viewingSearch) {
    appendMessage(msg);
    if (msg.senderId !== state.userId) void markRead();
  } else if (conv && msg.senderId !== state.userId) {
    conv.unreadCount = (conv.unreadCount ?? 0) + 1;
  }
  renderSidebar();
}

function onReadEvent(event) {
  // Another session of ours read this conversation — clear the badge here too.
  if (event.userId !== state.userId) return;
  const conv = state.conversations.find((c) => c.id === event.conversationId);
  if (conv) conv.unreadCount = 0;
  renderSidebar();
}

/* --------------------------------------------------- typing indicator */

function onTypingEvent(event) {
  if (event.userId === state.userId) return;

  // Kept per conversation, not just for the open one, so the sidebar can show it too.
  if (!event.isTyping) {
    stopTyping(event.conversationId, event.userId);
    return;
  }

  const forConversation = state.typing.get(event.conversationId) ?? new Map();
  const existing = forConversation.get(event.userId);
  if (existing) clearTimeout(existing.timer);
  // TTL, so a client that disconnects mid-sentence doesn't leave someone "typing" forever.
  forConversation.set(event.userId, {
    name: event.userName,
    timer: setTimeout(() => stopTyping(event.conversationId, event.userId), event.ttlMs ?? 5000),
  });
  state.typing.set(event.conversationId, forConversation);
  renderTyping();
  renderSidebar();
}

function stopTyping(conversationId, userId) {
  const forConversation = state.typing.get(conversationId);
  const existing = forConversation?.get(userId);
  if (!existing) return;
  clearTimeout(existing.timer);
  forConversation.delete(userId);
  if (!forConversation.size) state.typing.delete(conversationId);
  renderTyping();
  renderSidebar();
}

function clearTyping() {
  for (const forConversation of state.typing.values()) {
    for (const { timer } of forConversation.values()) clearTimeout(timer);
  }
  state.typing.clear();
  renderTyping();
}

/** Names of everyone typing in a conversation. */
function typistsIn(conversationId) {
  return [...(state.typing.get(conversationId)?.values() ?? [])].map((t) => t.name);
}

function renderTyping() {
  const names = state.activeConversation ? typistsIn(state.activeConversation) : [];
  const node = el('typing');
  if (!names.length) {
    node.textContent = '';
  } else if (names.length === 1) {
    node.textContent = `${names[0]} is typing…`;
  } else if (names.length === 2) {
    node.textContent = `${names[0]} and ${names[1]} are typing…`;
  } else {
    node.textContent = `${names.length} people are typing…`;
  }
}

function sendTyping(isTyping) {
  if (state.ws?.readyState !== WebSocket.OPEN || !state.activeConversation) return;
  const now = Date.now();
  // Throttle to one frame every 2s while typing, so a keystroke isn't a broadcast. "Stopped" is
  // always sent, so the indicator clears promptly.
  if (isTyping && now - state.lastTypingSentAt < 2000) return;
  state.lastTypingSentAt = isTyping ? now : 0;
  state.ws.send(
    JSON.stringify({ type: 'typing', conversationId: state.activeConversation, isTyping }),
  );
}

let typingStopTimer;
el('text').addEventListener('input', (e) => {
  clearTimeout(typingStopTimer);
  if (!e.target.value) {
    sendTyping(false);
    return;
  }
  sendTyping(true);
  // If they stop typing without sending, retract the indicator ourselves.
  typingStopTimer = setTimeout(() => sendTyping(false), 3000);
});

/* ----------------------------------------------------------- presence */

function onPresenceEvent(event) {
  const set = state.presence.get(event.conversationId) ?? new Set();
  if (event.online) set.add(event.userId);
  else set.delete(event.userId);
  state.presence.set(event.conversationId, set);
  renderPresence();
  renderSidebar();
}

/** Sent right after subscribing, so we aren't blind until somebody's status changes. */
function onPresenceSnapshot(event) {
  for (const entry of event.conversations ?? []) {
    state.presence.set(entry.conversationId, new Set(entry.online ?? []));
  }
  renderPresence();
  renderSidebar();
}

function onlineIn(conversationId) {
  return state.presence.get(conversationId) ?? new Set();
}

function renderPresence() {
  const node = el('presence');
  const id = state.activeConversation;
  if (!id || state.viewingSearch) {
    node.textContent = '';
    return;
  }
  const conv = state.conversations.find((c) => c.id === id);
  const others = conv?.participants ?? [];
  if (!others.length) {
    node.textContent = '';
    return;
  }
  const online = onlineIn(id);
  const names = others.filter((p) => online.has(p.id)).map((p) => p.name);
  node.textContent = names.length ? `${names.join(', ')} online` : 'nobody else online';
}

/* -------------------------------------------------------------- send */

function notice(text) {
  el('notice').textContent = text;
  if (text) setTimeout(() => { if (el('notice').textContent === text) el('notice').textContent = ''; }, 6000);
}

el('composer').onsubmit = async (e) => {
  e.preventDefault();
  const input = el('text');
  const body = input.value.trim();
  if (!body || !state.activeConversation) return;

  // The clientId makes the send idempotent server-side, so a retry can't create a second message.
  // Reusing the same one on retry is the whole point.
  const clientId = crypto.randomUUID();
  input.value = '';
  clearTimeout(typingStopTimer);
  sendTyping(false);

  // Optimistic echo: the message shows immediately instead of after a server round trip plus a
  // broadcast. `pending` maps it to the clientId so the broadcast replaces it in place.
  const optimistic = buildMessage({ senderId: state.userId, body, createdAt: new Date().toISOString() });
  optimistic.classList.add('pending');
  state.pending.set(clientId, optimistic);
  el('messages').appendChild(optimistic);
  scrollToBottom();

  try {
    const saved = await api('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: state.activeConversation,
        senderId: state.userId,
        body,
        clientId,
      }),
    });
    // Usually the broadcast has already arrived and swapped the bubble out; this covers the case
    // where the WS is down, so a send still renders correctly.
    if (state.pending.has(clientId)) appendMessage(saved);
  } catch (err) {
    state.pending.delete(clientId);
    optimistic.classList.remove('pending');
    optimistic.classList.add('failed');
    if (err.status === 429) {
      // tasks/rate-limiting.md: Retry-After tells us exactly how long to back off.
      optimistic.remove();
      input.value = body; // don't lose what they typed
      notice(`Sending too fast — try again in ${err.retryAfter ?? 10}s.`);
    } else {
      notice(`Could not send: ${err.message}`);
    }
  }
};

/* ------------------------------------------------------------ search */

el('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = el('search').value.trim();
  if (!q) return;
  await runSearch(q, 0, false);
};

async function runSearch(q, offset, append) {
  try {
    const response = await api(
      `/api/search?q=${encodeURIComponent(q)}&userId=${state.userId}&offset=${offset}`,
    );
    renderResults(q, response, append);
  } catch (err) {
    // The search endpoint is rate limited now, so a 429 is an expected outcome, not a failure.
    if (err.status === 429) notice(`Searching too fast — try again in ${err.retryAfter ?? 10}s.`);
    else notice(`Search failed: ${err.message}`);
  }
}

function renderResults(q, response, append = false) {
  state.viewingSearch = true;
  state.activeConversation = null;
  renderTyping();
  renderPresence();
  renderSidebar();

  el('title').textContent = `Search: "${q}"`;
  el('loadOlder').style.display = 'none';
  const pane = el('messages');
  if (!append) pane.replaceChildren(el('loadOlder'));
  // Drop any previous "more results" control before appending the next page.
  pane.querySelectorAll('.more-results').forEach((n) => n.remove());

  const results = response.results ?? [];
  if (!results.length && !append) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = `No messages matching "${q}".`;
    pane.appendChild(empty);
    return;
  }

  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'result';

    const where = document.createElement('span');
    where.className = 'where';
    where.textContent = `${r.conversationTitle ?? '#' + r.conversationId} · ${userName(r.senderId)} · ${
      r.createdAt ? new Date(r.createdAt).toLocaleString() : ''
    }`;

    const body = document.createElement('span');
    body.textContent = r.body ?? '';

    div.append(where, body);
    div.onclick = () => openConversation(r.conversationId);
    pane.appendChild(div);
  }

  if (response.nextOffset !== null && response.nextOffset !== undefined) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'more-results';
    more.textContent = 'More results';
    more.onclick = () => {
      more.disabled = true;
      void runSearch(q, response.nextOffset, true);
    };
    pane.appendChild(more);
  } else if (response.hasMore) {
    // Paging is capped, so say so rather than implying the list is complete.
    const more = document.createElement('div');
    more.className = 'empty more-results';
    more.textContent = 'More matches exist — narrow the search to see them.';
    pane.appendChild(more);
  }
}

/* ------------------------------------------------------- new + switch */

el('newConv').onclick = async () => {
  const title = prompt('Conversation title?');
  if (!title?.trim()) return;
  const others = state.users.filter((u) => u.id !== state.userId).map((u) => u.id);
  try {
    const created = await api('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), participantIds: [state.userId, ...others] }),
    });
    await loadConversations();
    await openConversation(created.id);
  } catch (err) {
    notice(`Could not create conversation: ${err.message}`);
  }
};

el('userSelect').onchange = async (e) => {
  state.userId = Number(e.target.value);
  sessionStorage.setItem('relay.userId', String(state.userId));
  state.activeConversation = null;
  state.rendered.clear();
  state.lastSeen.clear();
  state.presence.clear();
  clearTyping();
  renderPresence();
  el('title').textContent = 'Pick a conversation';
  el('messages').replaceChildren(el('loadOlder'));
  await loadConversations();
  subscribe();
};

/* -------------------------------------------------------------- boot */

(async () => {
  try {
    await loadUsers();
    await loadConversations();
  } catch (err) {
    notice(`Could not load: ${err.message}`);
  }
})();
