import type { Filter } from 'mongodb';
import { config } from '../config.ts';
import { messageBodies, type MessageBody } from '../db/mongo.ts';
import { conversationTitles, participantConversationIds } from './conversations.ts';

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
 */

export interface SearchHit {
  messageId: number;
  conversationId: number;
  conversationTitle: string;
  senderId: number;
  body: string;
  createdAt: string;
  matchedBy: 'text' | 'prefix';
}

export interface SearchResponse {
  query: string;
  results: SearchHit[];
  hasMore: boolean;
  /** Offset to request for the next page, or null when there isn't one. */
  nextOffset: number | null;
  /** Which strategy produced these results — useful when a query behaves unexpectedly. */
  matchedBy: 'text' | 'prefix' | 'none';
}

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

  const base: Filter<MessageBody> = { conversationId: { $in: scope } };
  if (opts.senderId !== undefined) base.senderId = opts.senderId;
  if (opts.from || opts.to) {
    base.createdAt = {
      ...(opts.from ? { $gte: opts.from } : {}),
      ...(opts.to ? { $lte: opts.to } : {}),
    };
  }

  // Strategy 1: the text index, ranked by relevance.
  let matchedBy: SearchHit['matchedBy'] = 'text';
  let docs = await messageBodies()
    .find(
      { ...base, $text: { $search: query } },
      {
        projection: {
          conversationId: 1,
          senderId: 1,
          body: 1,
          createdAt: 1,
          score: { $meta: 'textScore' },
        },
        sort: { score: { $meta: 'textScore' }, _id: -1 },
        skip: offset,
        limit: limit + 1,
      },
    )
    .toArray();

  // Strategy 2: indexed prefix match, only if the text index found nothing.
  if (!docs.length) {
    const prefixes = prefixTermsFor(query);
    if (prefixes.length) {
      docs = await messageBodies()
        .find(
          { ...base, $and: prefixes.map((p) => ({ bodyTokens: { $regex: p } })) },
          {
            projection: { conversationId: 1, senderId: 1, body: 1, createdAt: 1 },
            sort: { _id: -1 },
            skip: offset,
            limit: limit + 1,
          },
        )
        .toArray();
      matchedBy = 'prefix';
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

/**
 * Builds anchored prefix patterns for the query's terms.
 *
 * Anchoring with `^` is what lets Mongo use the `bodyTokens` index as a range scan; an unanchored
 * pattern would degrade back into examining every indexed token. Terms are escaped, so a query
 * full of regex metacharacters is a literal search rather than an injected pattern.
 */
function prefixTermsFor(query: string): RegExp[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 5); // a handful of terms is plenty; more just multiplies index lookups
  return terms.map((t) => new RegExp(`^${escapeRegex(t.slice(0, config.search.maxTokenLength))}`));
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
