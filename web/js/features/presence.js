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

/**
 * Seeds presence for a conversation from an inbox row's participants.
 *
 * The snapshot only covers what we were subscribed to when we subscribed, so a conversation that
 * arrived over the socket afterwards has no presence entry and renders with nobody online — even
 * though the row it arrived in says who is. Only for conversations we have no entry for: a live
 * `presence` event is more current than a row we were handed.
 */
export function seedPresence(conversationId, participants = []) {
  if (state.presence.has(conversationId)) return;
  state.presence.set(
    conversationId,
    new Set(participants.filter((p) => p.online).map((p) => p.id)),
  );
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
