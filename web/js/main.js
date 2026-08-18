import { createConversation, getConversations, getUsers, postMessage } from './api.js';
import { el, setUserId, state } from './state.js';
import { connectWs, setReloadConversations, subscribe } from './socket.js';
import { cancelPendingStop, sendTyping, watchComposer } from './features/typing.js';
import { appendMessage, buildMessage, openConversationOrNotice, resetPane, scrollToBottom, watchLoadOlder } from './views/messages.js';
import { notice } from './views/notice.js';
import { renderSidebar, setOnLoadMore, setOnSelect } from './views/sidebar.js';
import { watchSearchForm } from './views/search.js';

/**
 * Boot and the top-level actions.
 *
 * web/app.js was 778 lines holding every concern behind one mutable object. It's now nine modules
 * under web/js/, loaded as native ES modules — no build step, keeping the zero-tooling property the
 * original had.
 *
 * The two `set*` callbacks below break what would otherwise be import cycles: the sidebar needs to
 * open a conversation, and the socket needs to reload the conversation list, but neither should
 * depend on the boot sequence.
 */

async function loadUsers() {
  state.users = await getUsers();
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

/**
 * Loads the first page of the inbox.
 *
 * This runs on boot, on a user switch, and on every catch-up, so it resets to page one rather than
 * accumulating: the alternative is a list that only ever grows and re-fetches everything already
 * loaded each time realtime blips.
 */
async function loadConversations() {
  const page = await getConversations(state.userId);
  state.conversations = page.conversations;
  state.conversationsCursor = page.nextCursor;
  state.hasMoreConversations = page.hasMore;
  renderSidebar();
  connectWs();
}

/**
 * Appends the next page of the inbox.
 *
 * Subscribing to what's loaded rather than to everything is deliberate: one socket used to ask for all
 * 878 of a user's conversations, which is 878 Redis SUBSCRIBEs and a presence announce to match.
 */
async function loadMoreConversations() {
  if (!state.conversationsCursor) return;
  const page = await getConversations(state.userId, { cursor: state.conversationsCursor });
  state.conversations = [...state.conversations, ...page.conversations];
  state.conversationsCursor = page.nextCursor;
  state.hasMoreConversations = page.hasMore;
  renderSidebar();
  // Take in the newly visible conversations' events too.
  subscribe();
}

/* ------------------------------------------------------------------ send */

el('composer').onsubmit = async (e) => {
  e.preventDefault();
  const input = el('text');
  const body = input.value.trim();
  if (!body || !state.activeConversation) return;

  // The clientId makes the send idempotent server-side, so a retry can't create a second message.
  // Reusing the same one on retry is the whole point.
  const clientId = crypto.randomUUID();
  input.value = '';
  cancelPendingStop();
  sendTyping(false);

  // Optimistic echo: the message shows immediately instead of after a round trip plus a broadcast.
  // `pending` maps it to the clientId so the broadcast replaces it in place.
  const optimistic = buildMessage({
    senderId: state.userId,
    body,
    createdAt: new Date().toISOString(),
  });
  optimistic.classList.add('pending');
  state.pending.set(clientId, optimistic);
  el('messages').appendChild(optimistic);
  scrollToBottom();

  try {
    const saved = await postMessage({
      conversationId: state.activeConversation,
      senderId: state.userId,
      body,
      clientId,
    });
    // Usually the broadcast has already swapped the bubble out; this covers the case where the
    // socket is down, so a send still renders correctly.
    if (state.pending.has(clientId)) appendMessage(saved);
  } catch (err) {
    state.pending.delete(clientId);
    optimistic.remove();
    if (err.status === 429) {
      // tasks/rate-limiting.md: Retry-After tells us exactly how long to back off.
      input.value = body; // don't lose what they typed
      notice(`Sending too fast — try again in ${err.retryAfter ?? 10}s.`);
    } else {
      input.value = body;
      notice(`Could not send: ${err.message}`);
    }
  }
};

/* --------------------------------------------------------- new + switch */

el('newConv').onclick = async () => {
  const title = prompt('Conversation title?');
  if (!title?.trim()) return;
  const others = state.users.filter((u) => u.id !== state.userId).map((u) => u.id);
  try {
    const created = await createConversation(title.trim(), [state.userId, ...others]);
    await loadConversations();
    await openConversationOrNotice(created.id);
  } catch (err) {
    notice(`Could not create conversation: ${err.message}`);
  }
};

el('userSelect').onchange = async (e) => {
  setUserId(Number(e.target.value));
  resetPane();
  await loadConversations();
  subscribe();
};

/* ------------------------------------------------------------------ boot */

setOnSelect((id) => void openConversationOrNotice(id));
setOnLoadMore(() => loadMoreConversations());
setReloadConversations(loadConversations);
watchComposer();
watchLoadOlder();
watchSearchForm();

try {
  await loadUsers();
  await loadConversations();
} catch (err) {
  notice(`Could not load: ${err.message}`);
}
