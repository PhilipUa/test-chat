import { getMessages, postRead } from '../api.js';
import { conversationById, el, state, userName } from '../state.js';
import { renderPresence } from '../features/presence.js';
import { clearTyping, renderTyping } from '../features/typing.js';
import { notice } from './notice.js';
import { renderSidebar } from './sidebar.js';
import { bestEffort, maxOf } from '../util.js';

/** The message pane: rendering, pagination, and read receipts. */

/**
 * Which load is current.
 *
 * openConversation clears the pane and *then* awaits the fetch, so anything that happens during
 * that await races with the render. Two ways that bit:
 *
 *  - Switching conversations quickly: a slower earlier fetch could resolve last and paint the wrong
 *    conversation's history. The generation check drops superseded loads.
 *  - Sending during the load: the optimistic bubble is appended while the fetch is in flight, so
 *    appending the history afterwards put it *below* the new message. Found by driving sends at
 *    250ms intervals immediately after opening a conversation — a human can't type that fast, but
 *    it self-corrected only on reload, which is exactly the kind of thing that turns into a bug
 *    report nobody can reproduce. Fixed by inserting the history above whatever is already there.
 */
let loadGeneration = 0;

export async function openConversation(id) {
  const generation = ++loadGeneration;

  state.activeConversation = id;
  state.viewingSearch = false;
  state.rendered.clear();
  state.pending.clear();

  el('title').textContent = conversationById(id)?.title ?? `#${id}`;
  renderSidebar();

  const pane = el('messages');
  pane.replaceChildren(el('loadOlder'));

  const page = await getMessages(id, state.userId);
  if (generation !== loadGeneration) return; // a newer open superseded this one

  state.oldestLoaded = page.nextBefore;
  state.hasOlder = page.hasMore;
  el('loadOlder').style.display = page.hasMore ? 'block' : 'none';

  // History goes above anything appended while we were loading (an optimistic send), so the pane
  // reads oldest-to-newest either way.
  //
  // Skipping ids already rendered matters as much as the ordering: a message sent during the load is
  // rendered by its own broadcast *and* included in the history the fetch returns, so appending
  // unconditionally shows it twice. That's what building the fragment by hand nearly cost — the
  // dedup that appendMessage() does for free.
  const history = document.createDocumentFragment();
  for (const m of page.messages) {
    if (m.id) {
      if (state.rendered.has(m.id)) continue;
      state.rendered.add(m.id);
      if (m.id > (state.lastSeen.get(id) ?? 0)) state.lastSeen.set(id, m.id);
    }
    history.appendChild(buildMessage(m));
  }
  pane.insertBefore(history, el('loadOlder').nextSibling);

  if (page.latestId) state.lastSeen.set(id, page.latestId);
  scrollToBottom();
  renderTyping();
  renderPresence();
  await markRead();
}

/**
 * openConversation with its failure surfaced to the user.
 *
 * The pane is cleared before the fetch is awaited, so a failure left an empty message area under a
 * title claiming the conversation was open. Both call sites discarded the promise, so the only trace
 * was an unhandled rejection in the console — while every other failure path in the app reports
 * through notice().
 */
export async function openConversationOrNotice(id) {
  try {
    await openConversation(id);
  } catch (err) {
    notice(`Could not open that conversation: ${err.message}`);
  }
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
  const latest = maxOf(state.rendered);
  if (conv) conv.unreadCount = 0;
  renderSidebar();
  if (!latest) return;
  // Cosmetic if it fails — the badge is right again after a refresh — but worth a log line, since
  // "the unread count is wrong" is otherwise unexplainable.
  await bestEffort('read-receipt', () => postRead(id, state.userId, latest));
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
