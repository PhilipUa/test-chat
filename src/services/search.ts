import { config } from '../config.ts';
import {
  searchFuzzyCandidates,
  searchPrefix,
  searchText,
  type BodySearchDoc,
  type BodySearchFilter,
} from '../repositories/message-bodies.repository.ts';
import { closestTokenDistance, editThresholdFor, trigramsOf } from '../util/text.ts';
import { participantConversationIds } from './conversations/membership.ts';
import { conversationTitles } from './conversations/queries.ts';

/**
 * Search — tasks/search.md
 *
 * The bodies live in Mongo and the titles/membership live in MySQL, so a search is: work out
 * which conversations the caller can see (MySQL), search within those (Mongo), then decorate the
 * hits with titles (MySQL). Scoping first matters for correctness as well as cost — without it,
 * search is a way to read every conversation in the system.
 *
 * Two strategies, in order:
 *
 *  1. Mongo's `$text` index. Ranked by relevance, handles multiple terms, stemming
 *     ("meeting" matches "meetings") and quoted phrases.
 *  2. An **indexed prefix** match against `bodyTokens`, used when `$text` finds nothing. `$text`
 *     matches whole words, so "desig" or a partial token finds nothing at all, which reads as
 *     broken to someone typing into a search box.
 *
 * On (2): the first version of this ran an unanchored regex over `body`, which fetched and tested
 * every document in the caller's conversations — `explain` reported docsExamined 384 for
 * nReturned 0. That made an unmetered endpoint cost O(entire message history) per query. It is now
 * an anchored `^prefix` regex against a multikey index on `bodyTokens`, which Mongo can serve as
 * an index range scan, so cost tracks the number of matching tokens rather than the size of the
 * history. `/api/search` is rate limited as well — the two fixes are complementary, not
 * alternatives.
 *
 * The strategy order and the snippets are policy and live here; the Mongo queries themselves live
 * in repositories/message-bodies.repository.ts.
 */

export interface SearchHit {
  messageId: number;
  conversationId: number;
  conversationTitle: string;
  senderId: number;
  body: string;
  createdAt: string;
  matchedBy: 'text' | 'prefix' | 'fuzzy';
}

export interface SearchResponse {
  query: string;
  results: SearchHit[];
  hasMore: boolean;
  /** Offset to request for the next page, or null when there isn't one. */
  nextOffset: number | null;
  /** Which strategy produced these results — useful when a query behaves unexpectedly. */
  matchedBy: 'text' | 'prefix' | 'fuzzy' | 'none';
}

interface Strategy {
  name: SearchHit['matchedBy'];
  run(
    filter: BodySearchFilter,
    query: string,
    page: { limit: number; offset: number },
  ): Promise<BodySearchDoc[]>;
}

/**
 * Search strategies, most precise first. As a list, the precedence is explicit and a third
 * strategy (fuzzy matching, or an external engine per docs/04-tradeoffs.md) is additive rather
 * than another branch in the middle of the function.
 */
const STRATEGIES: Strategy[] = [
  {
    // Mongo's text index: ranked by relevance, handles multiple terms, stemming ("meeting" matches
    // "meetings") and quoted phrases. The one that scales, because it's index-backed.
    name: 'text',
    run: (filter, query, page) => searchText(filter, query, page),
  },
  {
    // Indexed prefix match, for the partial words $text cannot see.
    name: 'prefix',
    run: async (filter, query, page) => {
      const prefixes = prefixTermsFor(query);
      if (!prefixes.length) return [];
      return searchPrefix(filter, prefixes, page);
    },
  },
  {
    // Typo tolerance, for the queries the first two strategies cannot reach at all: `$text` matches
    // whole words and prefix matching is anchored, so a single wrong keystroke — especially in the
    // first character — turns a real query into zero results.
    //
    // Two halves, split by what each is good at. Mongo narrows: messages sharing a trigram with the
    // query come back through the multikey index, capped, so cost doesn't grow with history. Then
    // ranking happens here, because "how close is close enough" is policy, not storage.
    name: 'fuzzy',
    run: async (filter, query, { limit, offset }) => {
      const terms = queryTerms(query);
      if (!terms.length) return [];

      const trigrams = [...new Set(terms.flatMap(trigramsOf))];
      const candidates = await searchFuzzyCandidates(
        filter,
        trigrams,
        config.search.fuzzyCandidates,
      );

      // Score every candidate by its worst-matching term: a two-word query should not be satisfied
      // by a message that only resembles one of them.
      const scored = [];
      for (const doc of candidates) {
        let worst = 0;
        for (const term of terms) {
          const threshold = editThresholdFor(term);
          const distance = closestTokenDistance(
            term,
            doc.body,
            config.search.maxTokenLength,
            config.search.maxTokensPerMessage,
            threshold,
          );
          if (distance > threshold) {
            worst = Number.POSITIVE_INFINITY;
            break;
          }
          if (distance > worst) worst = distance;
        }
        if (Number.isFinite(worst)) scored.push({ doc, distance: worst });
      }

      // Closest first, then newest — the same tie-break the other strategies use.
      scored.sort((a, b) => a.distance - b.distance || b.doc.id - a.doc.id);
      return scored.slice(offset, offset + limit).map((hit) => hit.doc);
    },
  },
];

export interface SearchOptions {
  limit?: number;
  offset?: number;
  conversationId?: number;
  senderId?: number;
  /** Inclusive lower bound on createdAt. */
  from?: Date;
  /** Inclusive upper bound on createdAt. */
  to?: Date;
}

export async function searchMessages(
  userId: number,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResponse> {
  const limit = Math.min(opts.limit ?? config.search.defaultLimit, config.search.maxLimit);
  const offset = Math.min(Math.max(opts.offset ?? 0, 0), config.search.maxOffset);
  const empty: SearchResponse = {
    query,
    results: [],
    hasMore: false,
    nextOffset: null,
    matchedBy: 'none',
  };
  if (!query) return empty;

  let scope = await participantConversationIds(userId);
  if (opts.conversationId !== undefined) {
    // Narrowing to one conversation must still respect the scope, not replace it.
    scope = scope.filter((id) => id === opts.conversationId);
  }
  if (!scope.length) return empty;

  const filter: BodySearchFilter = {
    conversationIds: scope,
    senderId: opts.senderId,
    from: opts.from,
    to: opts.to,
  };

  // Try each strategy in order and take the first that finds anything.
  let docs: BodySearchDoc[] = [];
  let matchedBy: SearchHit['matchedBy'] = 'text';
  for (const strategy of STRATEGIES) {
    docs = await strategy.run(filter, query, { limit: limit + 1, offset });
    if (docs.length) {
      matchedBy = strategy.name;
      break;
    }
  }

  if (!docs.length) return { ...empty, hasMore: false };

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const titles = await conversationTitles(page.map((d) => d.conversationId));

  return {
    query,
    hasMore,
    matchedBy,
    // Capped, so a client paging forever can't push `skip` somewhere expensive.
    nextOffset: hasMore && offset + limit < config.search.maxOffset ? offset + limit : null,
    results: page.map((d) => ({
      messageId: d.id,
      conversationId: d.conversationId,
      conversationTitle: titles.get(d.conversationId) ?? `#${d.conversationId}`,
      senderId: d.senderId,
      // The UI renders this with textContent, so a snippet is plain text by design — no
      // highlight markup that would have to be trusted downstream.
      body: snippet(d.body, query),
      createdAt: d.createdAt.toISOString(),
      matchedBy,
    })),
  };
}

/**
 * Builds anchored prefix patterns (as regex sources) for the query's terms.
 *
 * Anchoring with `^` is what lets Mongo use the `bodyTokens` index as a range scan; an unanchored
 * pattern would degrade back into examining every indexed token. Terms are escaped, so a query
 * full of regex metacharacters is a literal search rather than an injected pattern.
 */
function prefixTermsFor(query: string): string[] {
  return queryTerms(query).map((t) => `^${escapeRegex(t)}`);
}

/**
 * The query's search terms: lowercased, split like the indexer splits bodies, truncated to the
 * indexed token length, and capped in number — more terms just multiply index lookups.
 */
function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 5)
    .map((t) => t.slice(0, config.search.maxTokenLength));
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
