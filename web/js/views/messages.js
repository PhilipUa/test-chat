import { getMessages, postRead } from '../api.js';
import { conversationById, el, state, userName } from '../state.js';
import { renderPresence } from '../features/presence.js';
import { clearTyping, renderTyping } from '../features/typing.js';
import { renderSidebar } from './sidebar.js';

/** The message pane: rendering, pagination, and read receipts. */

export async function openConversation(id) {
  state.activeConversation = id;
  state.viewingSearch = false;
  state.rendered.clear();
  state.pending.clear();

  el('title').textContent = conversationById(id)?.title ?? `#${id}`;
  renderSidebar();

  const pane = el('messages');
  pane.replaceChildren(el('loadOlder'));

  const page = await getMessages(id, state.userId);
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

export function buildMessage(m) {
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

export function appendMessage(m) {
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

export function scrollToBottom() {
  const pane = el('messages');
  pane.scrollTop = pane.scrollHeight;
}

export async function markRead() {
  const id = state.activeConversation;
  if (!id) return;
  const conv = conversationById(id);
  const latest = Math.max(0, ...[...state.rendered]);
  if (conv) conv.unreadCount = 0;
  renderSidebar();
  if (!latest) return;
  try {
    await postRead(id, state.userId, latest);
  } catch {
    // A failed read receipt is cosmetic; the badge will be right again after a refresh.
  }
}

/** GET /api/messages is paginated, so older history is fetched on demand. */
export function watchLoadOlder() {
  el('loadOlder').onclick = async () => {
    if (!state.activeConversation || !state.hasOlder) return;
    const button = el('loadOlder');
    button.disabled = true;
    try {
      const page = await getMessages(state.activeConversation, state.userId, {
        before: state.oldestLoaded,
      });
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
}

export function resetPane() {
  state.activeConversation = null;
  state.rendered.clear();
  state.lastSeen.clear();
  state.presence.clear();
  clearTyping();
  renderPresence();
  el('title').textContent = 'Pick a conversation';
  el('messages').replaceChildren(el('loadOlder'));
}
