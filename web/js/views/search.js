import { search } from '../api.js';
import { el, state, userName } from '../state.js';
import { renderPresence } from '../features/presence.js';
import { renderTyping } from '../features/typing.js';
import { notice } from './notice.js';
import { openConversation } from './messages.js';
import { renderSidebar } from './sidebar.js';

/** Search — tasks/search.md. Results render with textContent, so a snippet is plain text by design. */

export function watchSearchForm() {
  el('searchForm').onsubmit = async (e) => {
    e.preventDefault();
    const q = el('search').value.trim();
    if (!q) return;
    await runSearch(q, 0, false);
  };
}

async function runSearch(q, offset, append) {
  try {
    render(q, await search(q, state.userId, offset), append);
  } catch (err) {
    // The endpoint is rate limited, so a 429 is an expected outcome rather than a failure.
    if (err.status === 429) notice(`Searching too fast — try again in ${err.retryAfter ?? 10}s.`);
    else notice(`Search failed: ${err.message}`);
  }
}

function render(q, response, append = false) {
  state.viewingSearch = true;
  state.activeConversation = null;
  renderTyping();
  renderPresence();
  renderSidebar();

  el('title').textContent = `Search: "${q}"`;
  el('loadOlder').style.display = 'none';
  const pane = el('messages');
  if (!append) pane.replaceChildren(el('loadOlder'));
  pane.querySelectorAll('.more-results').forEach((n) => n.remove());

  const results = response.results ?? [];
  if (!results.length && !append) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = `No messages matching "${q}".`;
    pane.appendChild(empty);
    return;
  }

  for (const r of results) pane.appendChild(result(r));

  if (response.nextOffset !== null && response.nextOffset !== undefined) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'more-results';
    more.textContent = 'More results';
    more.onclick = () => {
      more.disabled = true;
      void runSearch(q, response.nextOffset, true);
    };
    pane.appendChild(more);
  } else if (response.hasMore) {
    // Paging is capped, so say so rather than implying the list is complete.
    const more = document.createElement('div');
    more.className = 'empty more-results';
    more.textContent = 'More matches exist — narrow the search to see them.';
    pane.appendChild(more);
  }
}

function result(r) {
  const div = document.createElement('div');
  div.className = 'result';

  const where = document.createElement('span');
  where.className = 'where';
  where.textContent = `${r.conversationTitle ?? '#' + r.conversationId} · ${userName(r.senderId)} · ${
    r.createdAt ? new Date(r.createdAt).toLocaleString() : ''
  }`;

  const body = document.createElement('span');
  body.textContent = r.body ?? '';

  div.append(where, body);
  div.onclick = () => openConversation(r.conversationId);
  return div;
}
