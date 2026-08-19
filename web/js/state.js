import { isNewerMessage, orderByActivity } from './util.js';

/**
 * The store — the one place client state is declared, and the only module that owns it.
 *
 * web/app.js was 778 lines with every concern behind this one object. Splitting the views and
 * features out of it means the state has to be explicit about what it holds, which is most of the
 * value: `lastSeen` and `rendered` in particular are subtle, and were easy to miss when they lived
 * three hundred lines from the code that used them.
 */

/**
 * Which demo user this tab is acting as.
 *
 * sessionStorage, not localStorage: sessionStorage is scoped per tab, so you can be Alice in one tab
 * and Bob in another. With localStorage (shared across all tabs of an origin) switching user in one
 * tab silently changed every other tab on its next reload — which makes it impossible to demo the two
 * things that need two people, the typing indicator and the unread badge. `?userId=2` overrides, so a
 * link can pin an identity.
 */
function initialUserId() {
  const fromUrl = Number(new URLSearchParams(location.search).get('userId'));
  if (Number.isInteger(fromUrl) && fromUrl > 0) {
    sessionStorage.setItem('relay.userId', String(fromUrl));
    return fromUrl;
  }
  return Number(sessionStorage.getItem('relay.userId')) || 1;
}

export const state = {
  userId: initialUserId(),
  users: [],
  conversations: [],
  /** Cursor for the next page of the inbox, or null when the whole list is loaded. */
  conversationsCursor: null,
  hasMoreConversations: false,
  activeConversation: null,

  /** Oldest message id currently rendered — the cursor for "load older". */
  oldestLoaded: null,
  hasOlder: false,

  /** clientId -> element, so a broadcast replaces our optimistic bubble rather than duplicating it. */
  pending: new Map(),
  /** Ids already rendered in the open conversation, so a catch-up can't double up. */
  rendered: new Set(),
  /** conversationId -> Map(userId -> { name, timer }) for whoever is typing where. */
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

export function setUserId(userId) {
  state.userId = userId;
  sessionStorage.setItem('relay.userId', String(userId));

  // Keep the URL in step with the choice. initialUserId() reads ?userId= *before* sessionStorage, so
  // leaving a stale value there meant a reload silently reverted the switch — and overwrote the
  // stored choice on the way. replaceState, not pushState: changing who you are isn't a navigation
  // step, and undoing it shouldn't need a Back press.
  const url = new URL(location.href);
  url.searchParams.set('userId', String(userId));
  history.replaceState(null, '', url);
}

/**
 * Conversations in the order the inbox is meant to read: most recent activity first.
 *
 * Ordered on read rather than kept sorted, so no mutation path can forget to re-sort — the sidebar
 * drifting out of order whenever a message arrived over the socket was exactly that omission.
 */
export function conversationsInOrder() {
  return orderByActivity(state.conversations);
}

/**
 * Records a message as its conversation's most recent, for the sidebar preview and the ordering.
 *
 * Returns whether anything changed, so a caller can skip a pointless re-render.
 */
export function noteLatestMessage(msg) {
  const conv = conversationById(msg.conversationId ?? state.activeConversation);
  if (!conv || !isNewerMessage(conv, msg)) return false;

  conv.lastMessage = {
    id: msg.id,
    senderId: msg.senderId,
    body: msg.body,
    createdAt: msg.createdAt,
  };
  conv.activityAt = msg.createdAt;
  return true;
}

export const el = (id) => document.getElementById(id);

export const userName = (id) => state.users.find((u) => u.id === id)?.name ?? `#${id}`;

export const conversationById = (id) => state.conversations.find((c) => c.id === id);
