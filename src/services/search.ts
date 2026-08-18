import { config } from '../config.ts';
import { messageBodies } from '../db/mongo.ts';
import { conversationTitles, participantConversationIds } from './conversations.ts';

/**
 * Search — tasks/search.md
 *
 * The bodies live in Mongo and the titles/membership live in MySQL, so a search is: work out
 * which conversations the caller can see (MySQL), search within those (Mongo), then decorate the
 * hits with titles (MySQL). Scoping first matters for correctness as well as cost — without it,
 * search is a way to read every conversation in the system, which is finding E in a new place.
 *
 * Two strategies, in order:
 *
 *  1. Mongo's `$text` index. Ranked by relevance, handles multiple terms, stemming
 *     ("meeting" matches "meetings") and quoted phrases. It's the one that scales, because it's
 *     the only one backed by an index.
 *  2. An escaped-regex fallback, used only when `$text` finds nothing. `$text` matches whole
 *     words, so a search for "desig" or "#1042" finds nothing at all — which reads as broken to
 *     someone who expects search-as-you-type. The fallback is a collection scan, so it's bounded:
 *     only ever within the caller's own conversations, only when `$text` came back empty, and
 *     always with a limit.
 */

export interface SearchHit {
  messageId: number;
  conversationId: number;
  conversationTitle: string;
  senderId: number;
  body: string;
  createdAt: string;
  matchedBy: 'text' | 'substring';
}

export interface SearchResponse {
  query: string;
  results: SearchHit[];
  hasMore: boolean;
}

export async function searchMessages(
  userId: number,
  query: string,
  opts: { limit?: number; conversationId?: number } = {},
): Promise<SearchResponse> {
  const limit = Math.min(opts.limit ?? config.search.defaultLimit, config.search.maxLimit);
  if (!query) return { query, results: [], hasMore: false };

  let scope = await participantConversationIds(userId);
  if (opts.conversationId !== undefined) {
    // Narrowing to one conversation must still respect the scope, not replace it.
    scope = scope.filter((id) => id === opts.conversationId);
  }
  if (!scope.length) return { query, results: [], hasMore: false };

  const filter = { conversationId: { $in: scope } };

  let docs = await messageBodies()
    .find(
      { ...filter, $text: { $search: query } },
      {
        projection: { conversationId: 1, senderId: 1, body: 1, createdAt: 1, score: { $meta: 'textScore' } },
        sort: { score: { $meta: 'textScore' }, _id: -1 },
        limit: limit + 1,
      },
    )
    .toArray();

  let matchedBy: SearchHit['matchedBy'] = 'text';

  if (!docs.length) {
    docs = await messageBodies()
      .find(
        { ...filter, body: { $regex: escapeRegex(query), $options: 'i' } },
        {
          projection: { conversationId: 1, senderId: 1, body: 1, createdAt: 1 },
          sort: { _id: -1 },
          limit: limit + 1,
        },
      )
      .toArray();
    matchedBy = 'substring';
  }

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;

  const titles = await conversationTitles(page.map((d) => d.conversationId));

  return {
    query,
    hasMore,
    results: page.map((d) => ({
      messageId: Number(d._id),
      conversationId: d.conversationId,
      conversationTitle: titles.get(d.conversationId) ?? `#${d.conversationId}`,
      senderId: d.senderId,
      // The UI renders this with textContent, so a snippet is plain text by design — no
      // highlight markup that would have to be trusted downstream.
      body: snippet(d.body, query),
      createdAt: new Date(d.createdAt).toISOString(),
      matchedBy,
    })),
  };
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A window of the body around the first matching term, so a hit in a long message is actually
 * visible in the results list rather than being truncated away.
 */
function snippet(body: string, query: string): string {
  const radius = config.search.snippetRadius;
  if (body.length <= radius * 2) return body;

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter(Boolean);

  const haystack = body.toLowerCase();
  let at = -1;
  for (const term of terms) {
    at = haystack.indexOf(term);
    if (at !== -1) break;
  }
  if (at === -1) return `${body.slice(0, radius * 2).trimEnd()}…`;

  const start = Math.max(0, at - radius);
  const end = Math.min(body.length, at + radius);
  return `${start > 0 ? '…' : ''}${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`;
}
