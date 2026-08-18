import { el, state, userName } from '../state.js';
import { onlineIn } from '../features/presence.js';
import { typistsIn } from '../features/typing.js';

/**
 * The conversation list.
 *
 * Built from DOM nodes with textContent. The original did
 *   li.innerHTML = `<span>${c.title} (…)</span>`
 * with a title that came straight from POST /api/conversations — i.e. stored XSS.
 */

/** Set by the app so a click can open a conversation without this module importing the message view. */
let onSelect = () => {};
export function setOnSelect(fn) {
  onSelect = fn;
}

/** Set by the app, for the same reason: the sidebar shouldn't know how a page is fetched. */
let onLoadMore = async () => {};
export function setOnLoadMore(fn) {
  onLoadMore = fn;
}

export function renderSidebar() {
  const list = el('conversations');
  list.replaceChildren();

  if (!state.conversations.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No conversations yet.';
    list.appendChild(empty);
    return;
  }

  for (const c of state.conversations) list.appendChild(row(c));
  if (state.hasMoreConversations) list.appendChild(loadMoreRow());
}

/**
 * The inbox is paged, so say so rather than letting a truncated list read as the whole thing.
 */
function loadMoreRow() {
  const li = document.createElement('li');
  li.className = 'load-more';

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'loadMoreConversations';
  button.textContent = 'Load more conversations';
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'Loading…';
    try {
      await onLoadMore();
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Load more conversations';
      throw err;
    }
  };

  li.appendChild(button);
  return li;
}

function row(c) {
  const li = document.createElement('li');
  if (c.id === state.activeConversation) li.className = 'active';

  const main = document.createElement('div');
  main.className = 'conv-main';

  const title = document.createElement('span');
  title.className = 'conv-title';
  title.textContent = `${c.title} (${c.messageCount})`;

  // A dot for any other participant who's currently connected.
  const online = onlineIn(c.id);
  const onlineNames = (c.participants ?? []).filter((p) => online.has(p.id)).map((p) => p.name);
  if (onlineNames.length) {
    const dot = document.createElement('span');
    dot.className = 'online-dot';
    dot.title = `${onlineNames.join(', ')} online`;
    title.prepend(dot);
  }

  const preview = document.createElement('span');
  preview.className = 'conv-preview';
  // Typing wins over the last-message preview: it's the more current information, and showing it
  // here is the whole point of tracking typing for conversations that aren't open.
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
  li.appendChild(main);

  // Unread comes from the server, so the badge survives a reload and agrees between tabs.
  if (c.unreadCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String(c.unreadCount);
    li.appendChild(badge);
  }

  li.onclick = () => onSelect(c.id);
  return li;
}
