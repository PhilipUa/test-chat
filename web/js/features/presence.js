import { conversationById, el, state } from '../state.js';
import { renderSidebar } from '../views/sidebar.js';

/** Who's online. Fed by a snapshot on subscribe, then incremental events. */

export function onPresenceEvent(event) {
  const set = state.presence.get(event.conversationId) ?? new Set();
  if (event.online) set.add(event.userId);
  else set.delete(event.userId);
  state.presence.set(event.conversationId, set);
  renderPresence();
  renderSidebar();
}

/** Sent right after subscribing, so we aren't blind until somebody's status changes. */
export function onPresenceSnapshot(event) {
  for (const entry of event.conversations ?? []) {
    state.presence.set(entry.conversationId, new Set(entry.online ?? []));
  }
  renderPresence();
  renderSidebar();
}

export function onlineIn(conversationId) {
  return state.presence.get(conversationId) ?? new Set();
}

export function renderPresence() {
  const node = el('presence');
  const id = state.activeConversation;
  if (!id || state.viewingSearch) {
    node.textContent = '';
    return;
  }
  const others = conversationById(id)?.participants ?? [];
  if (!others.length) {
    node.textContent = '';
    return;
  }
  const online = onlineIn(id);
  const names = others.filter((p) => online.has(p.id)).map((p) => p.name);
  node.textContent = names.length ? `${names.join(', ')} online` : 'nobody else online';
}
