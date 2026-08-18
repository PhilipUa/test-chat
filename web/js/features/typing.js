import { el, state } from '../state.js';
import { renderSidebar } from '../views/sidebar.js';

/**
 * Typing indicator — tasks/typing-indicator.md.
 *
 * Kept per conversation, not just for the open one: the client used to discard any event whose
 * conversation wasn't open, so you couldn't tell someone was replying in another thread. The sidebar
 * shows it for the others; the line under the message pane shows it for the open one.
 */

export function onTypingEvent(event) {
  if (event.userId === state.userId) return;

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

export function stopTyping(conversationId, userId) {
  const forConversation = state.typing.get(conversationId);
  const existing = forConversation?.get(userId);
  if (!existing) return;
  clearTimeout(existing.timer);
  forConversation.delete(userId);
  if (!forConversation.size) state.typing.delete(conversationId);
  renderTyping();
  renderSidebar();
}

export function clearTyping() {
  for (const forConversation of state.typing.values()) {
    for (const { timer } of forConversation.values()) clearTimeout(timer);
  }
  state.typing.clear();
  renderTyping();
}

/** Names of everyone typing in a conversation. */
export function typistsIn(conversationId) {
  return [...(state.typing.get(conversationId)?.values() ?? [])].map((t) => t.name);
}

export function renderTyping() {
  const names = state.activeConversation ? typistsIn(state.activeConversation) : [];
  const node = el('typing');
  if (!names.length) node.textContent = '';
  else if (names.length === 1) node.textContent = `${names[0]} is typing…`;
  else if (names.length === 2) node.textContent = `${names[0]} and ${names[1]} are typing…`;
  else node.textContent = `${names.length} people are typing…`;
}

export function sendTyping(isTyping) {
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

let stopTimer;

/** Wires the composer so typing is announced and retracted. */
export function watchComposer() {
  el('text').addEventListener('input', (e) => {
    clearTimeout(stopTimer);
    if (!e.target.value) {
      sendTyping(false);
      return;
    }
    sendTyping(true);
    // If they stop typing without sending, retract the indicator ourselves.
    stopTimer = setTimeout(() => sendTyping(false), 3000);
  });
}

export function cancelPendingStop() {
  clearTimeout(stopTimer);
}
