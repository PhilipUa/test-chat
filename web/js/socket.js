import { getMessages } from './api.js';
import { el, state } from './state.js';
import { onPresenceEvent, onPresenceSnapshot } from './features/presence.js';
import { onTypingEvent, stopTyping } from './features/typing.js';
import { appendMessage, markRead, openConversation } from './views/messages.js';
import { renderSidebar } from './views/sidebar.js';

/**
 * The realtime connection.
 *
 * The original set `ws.onmessage` and nothing else — no reconnect, no error handling. One dropped
 * connection and the tab stopped updating, with nothing on screen to say so.
 */

/** Set by the app, so this module doesn't import the boot sequence. */
let reloadConversations = async () => {};
export function setReloadConversations(fn) {
  reloadConversations = fn;
}

function setStatus(text, down) {
  const node = el('connection');
  node.textContent = text;
  node.className = down ? 'down' : '';
}

export function connectWs() {
  if (
    state.ws &&
    (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)
  ) {
    subscribe();
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/`);
  state.ws = ws;
  setStatus('connecting…', false);

  ws.onopen = async () => {
    state.wsAttempts = 0;
    setStatus('live', false);
    subscribe();
    // Catch up on anything published while we were away.
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

  ws.onerror = () => setStatus('connection problem', true);

  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    setStatus('reconnecting…', true);
    // Backoff caps at 10s, with jitter so N tabs don't all retry on the same tick.
    const delay = Math.min(500 * 2 ** state.wsAttempts++, 10_000) * (0.7 + Math.random() * 0.6);
    setTimeout(connectWs, delay);
  };
}

export function subscribe() {
  if (state.ws?.readyState !== WebSocket.OPEN) return;
  // userId is required: the server intersects the requested ids with the conversations you're
  // actually a participant in, rather than trusting the list.
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

function onMessageEvent(msg) {
  const conv = state.conversations.find((c) => c.id === msg.conversationId);
  if (conv) {
    conv.messageCount += 1;
    conv.lastMessage = {
      id: msg.id,
      senderId: msg.senderId,
      body: msg.body,
      createdAt: msg.createdAt,
    };
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

/**
 * Pulls anything missed since the last id we saw, rather than refetching whole conversations.
 *
 * Realtime here is best-effort (Redis pub/sub is at-most-once); this is what makes it eventually
 * complete. Cheap enough to run on every reconnect and every resync nudge.
 */
export async function catchUp() {
  await reloadConversations().catch(() => {});

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
      const page = await getMessages(id, state.userId, { since: cursor });
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
