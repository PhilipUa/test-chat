import { getMessages } from './api.js';
import { conversationById, el, noteLatestMessage, state } from './state.js';
import { onPresenceEvent, onPresenceSnapshot, seedPresence } from './features/presence.js';
import { onTypingEvent, stopTyping } from './features/typing.js';
import { appendMessage, markRead, openConversation } from './views/messages.js';
import { renderSidebar } from './views/sidebar.js';
import { bestEffort, parseJson } from './util.js';

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
    // Deliberately not 'live' yet. An open socket receives nothing until the server has processed
    // our subscribe frame, so reporting "live" here overstates it — and anything published in that
    // gap is genuinely missed, since catch-up only runs on connect. 'live' is set when the server
    // acknowledges the subscription instead.
    setStatus('subscribing…', false);
    subscribe();
    // Catch up on anything published while we were away.
    await catchUp();
  };

  ws.onmessage = (ev) => {
    const event = parseJson(ev.data);
    if (event) handleEvent(event);
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
    case 'subscribed':
      // The server is now routing this conversation's events to us; only now are we really live.
      setStatus('live', false);
      return;
    case 'conversation':
      return onConversationEvent(event);
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
 * A conversation we've just been added to.
 *
 * The row arrives whole, so the sidebar can render it without refetching the inbox. The server has
 * already pointed our socket at it — we'd receive its messages either way — but the subscription set
 * we send on the next reconnect is built from `state.conversations`, so a conversation missing from
 * there would quietly drop out at that point.
 */
function onConversationEvent(event) {
  const conversation = event.conversation;
  if (!conversation?.id || conversationById(conversation.id)) return;
  state.conversations = [...state.conversations, conversation];
  // The row carries who is online; without this the conversation renders with nobody around until
  // something else prompts a fresh presence snapshot.
  seedPresence(conversation.id, conversation.participants);
  renderSidebar();
}

function onMessageEvent(msg) {
  const conv = conversationById(msg.conversationId);
  // Counted here rather than in noteLatestMessage: that one is deliberately idempotent, and a count
  // must move exactly once per message.
  if (conv) conv.messageCount += 1;
  // Also moves the conversation up the sidebar — renderSidebar orders on activity.
  noteLatestMessage(msg);

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
  const conv = conversationById(event.conversationId);
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
  await bestEffort('catch-up:conversations', reloadConversations);

  const id = state.activeConversation;
  if (!id || state.viewingSearch) return;

  /**
   * Whether the conversation we started catching up on is still the one on screen.
   *
   * This awaits a fetch that can walk up to twenty pages, and appendMessage writes into whatever pane
   * is open rather than a particular conversation's. openConversation was given a generation guard for
   * exactly this race; catchUp had none, so a reconnect while the user was navigating dropped the old
   * conversation's history into the new one's pane.
   */
  const stillOpen = () => state.activeConversation === id && !state.viewingSearch;

  const since = state.lastSeen.get(id);
  if (since === undefined) {
    // Guarded too: openConversation sets activeConversation, so calling it after the user moved on
    // would drag them back to the conversation they just left.
    if (stillOpen()) await bestEffort('catch-up:open', () => openConversation(id));
    return;
  }

  const walked = await bestEffort('catch-up:since', async () => {
    let cursor = since;
    // `hasMore` means the gap was bigger than one page; keep walking forwards.
    for (let guard = 0; guard < 20; guard++) {
      const page = await getMessages(id, state.userId, { since: cursor });
      if (!stillOpen()) return;
      for (const m of page.messages) appendMessage(m);
      if (page.latestId) cursor = page.latestId;
      if (!page.hasMore) break;
    }
    await markRead();
  });

  // Reloading the whole conversation is always correct, just heavier — the fallback for when the
  // cheap incremental path didn't work.
  if (!walked && stillOpen()) await bestEffort('catch-up:reload', () => openConversation(id));
}
