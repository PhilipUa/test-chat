import { mongoDb } from '../db/mongo.ts';
import { bodyTrigramsOf, tokenizeBody } from '../util/text.ts';

/**
 * Data access for the `message_bodies` collection — the Mongo half of a message. No business
 * logic here: search strategy order and snippets live in services/search.ts, the two-store write
 * in services/message-store.ts.
 *
 * Typed Prisma calls where the query API can express the shape; `findRaw`/`$runCommandRaw` for
 * the two searches and the backfill, because Prisma's Mongo filters are equality-only over scalar
 * lists (no anchored-regex range scan over `bodyTokens`) and cannot rank by `$text` score. Raw
 * results come back as extended JSON, decoded at this boundary so nothing above it sees EJSON.
 */

export interface StoredBody {
  id: number;
  conversationId: number;
  senderId: number;
  body: string;
  signature: string;
  createdAt: Date;
  bodyTokens: string[];
  bodyTrigrams: string[];
}

export async function insertBody(doc: StoredBody): Promise<void> {
  await mongoDb.messageBody.create({ data: doc });
}

export async function findBody(id: number): Promise<string> {
  const doc = await mongoDb.messageBody.findUnique({ where: { id }, select: { body: true } });
  return doc?.body ?? '';
}

/**
 * Fetches message bodies by id, indexed by id.
 *
 * This is the join between the two stores — MySQL holds a message's id and ordering, Mongo holds
 * its text. It lives in one place because it's the seam most likely to change if the split-store
 * design is ever revisited (docs/04-tradeoffs.md).
 */
export async function bodiesByIds(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const docs = await mongoDb.messageBody.findMany({
    where: { id: { in: ids } },
    select: { id: true, body: true },
  });
  return new Map(docs.map((d) => [d.id, d.body]));
}

/** Inserts the document if absent, touches nothing if present — for idempotent seeding. */
export async function upsertSeedBody(doc: StoredBody): Promise<void> {
  await mongoDb.messageBody.upsert({ where: { id: doc.id }, update: {}, create: doc });
}

export async function countBodies(): Promise<number> {
  return mongoDb.messageBody.count();
}

export interface BodySearchFilter {
  conversationIds: number[];
  senderId?: number;
  /** Inclusive bounds on createdAt. */
  from?: Date;
  to?: Date;
}

export interface BodySearchDoc {
  id: number;
  conversationId: number;
  senderId: number;
  body: string;
  createdAt: Date;
}

interface Page {
  limit: number;
  offset: number;
}

/** Mongo's `$text` search: relevance-ranked, stemming, quoted phrases. */
export async function searchText(
  filter: BodySearchFilter,
  query: string,
  { limit, offset }: Page,
): Promise<BodySearchDoc[]> {
  const docs = await mongoDb.messageBody.findRaw({
    filter: { ...baseFilter(filter), $text: { $search: query } },
    options: {
      projection: {
        conversationId: 1,
        senderId: 1,
        body: 1,
        createdAt: 1,
        score: { $meta: 'textScore' },
      },
      sort: { score: { $meta: 'textScore' }, _id: -1 },
      skip: offset,
      limit,
    },
  });
  return decodeDocs(docs);
}

/**
 * Indexed prefix match over `bodyTokens`, for the partial words `$text` cannot see.
 *
 * `prefixes` are pre-escaped regex sources anchored with `^` — the anchor is what lets Mongo use
 * the multikey index as a range scan instead of examining every indexed token.
 */
export async function searchPrefix(
  filter: BodySearchFilter,
  prefixes: string[],
  { limit, offset }: Page,
): Promise<BodySearchDoc[]> {
  const docs = await mongoDb.messageBody.findRaw({
    filter: {
      ...baseFilter(filter),
      $and: prefixes.map((p) => ({ bodyTokens: { $regex: p } })),
    },
    options: {
      projection: { conversationId: 1, senderId: 1, body: 1, createdAt: 1 },
      sort: { _id: -1 },
      skip: offset,
      limit,
    },
  });
  return decodeDocs(docs);
}

/**
 * Candidates for a fuzzy match: messages sharing at least one trigram with the query's terms.
 *
 * Bounded by construction. `$in` over the multikey trigram index is a range scan, and `limit` caps
 * how many candidates come back, so a typo'd query costs the same whether the history is a hundred
 * messages or a million. Ranking the candidates by edit distance is the caller's job — that is
 * policy, and it belongs in the search service.
 *
 * Two details that are not cosmetic, both measured with `explain` on a collection of ~8,600
 * messages:
 *
 *  - **The hint is required.** Left to itself the planner prefers `conversation_recent`, because
 *    that index also satisfies an `_id` ordering, and then examines every message in the caller's
 *    conversations — 1,039 documents for 9 hits. Hinted onto the trigram index it examines 9. The
 *    whole point of storing trigrams is that the index does the narrowing, so it is worth being
 *    explicit rather than hoping the planner agrees.
 *  - **No sort.** An ordering the index cannot serve forces a blocking sort over every match before
 *    the limit applies, which is unbounded work for a common trigram. The caller ranks by edit
 *    distance anyway, so ordering here would be thrown away.
 */
export async function searchFuzzyCandidates(
  filter: BodySearchFilter,
  trigrams: string[],
  limit: number,
): Promise<BodySearchDoc[]> {
  if (!trigrams.length) return [];
  const docs = await mongoDb.messageBody.findRaw({
    filter: { ...baseFilter(filter), bodyTrigrams: { $in: trigrams } },
    options: {
      projection: { conversationId: 1, senderId: 1, body: 1, createdAt: 1 },
      hint: 'conversation_body_trigrams',
      limit,
    },
  });
  return decodeDocs(docs);
}

/** The index-term limits a backfill needs. Passed in, so this module holds no configuration. */
export interface IndexingLimits {
  maxTokenLength: number;
  maxTokens: number;
  maxTrigrams: number;
}

/**
 * Backfills the search index fields for documents written before they existed.
 *
 * Both `bodyTokens` and `bodyTrigrams` are filled by one pass, because a document missing either
 * needs the same read of its body — searching twice for the same rows would double the boot cost
 * for no benefit.
 *
 * Batched and capped per boot: a migration that rewrites an entire collection while holding up
 * start-up is how a deploy turns into an outage. It's resumable by construction — each run picks
 * up whatever is still missing a field — so several boots converge.
 */
export async function backfillSearchIndexes(
  limits: IndexingLimits,
  batchSize = 500,
  maxBatches = 20,
): Promise<number> {
  const { maxTokenLength, maxTokens, maxTrigrams } = limits;
  let updated = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    const raw = await mongoDb.messageBody.findRaw({
      filter: { $or: [{ bodyTokens: { $exists: false } }, { bodyTrigrams: { $exists: false } }] },
      options: { projection: { body: 1 }, limit: batchSize },
    });
    const pending = asArray(raw);
    if (!pending.length) break;

    const res = (await mongoDb.$runCommandRaw({
      update: 'message_bodies',
      updates: pending.map((doc) => {
        const body = asString(doc.body);
        return {
          q: { _id: asNumber(doc._id) },
          u: {
            $set: {
              bodyTokens: tokenizeBody(body, maxTokenLength, maxTokens),
              bodyTrigrams: bodyTrigramsOf(body, maxTokenLength, maxTokens, maxTrigrams),
            },
          },
        };
      }),
      ordered: false,
    })) as { nModified?: number };
    updated += res.nModified ?? 0;
    if (pending.length < batchSize) break;
  }

  if (updated) console.log(`[migrate:mongo] backfilled search indexes on ${updated} message(s)`);
  return updated;
}

function baseFilter(filter: BodySearchFilter): Record<string, unknown> {
  const base: Record<string, unknown> = { conversationId: { $in: filter.conversationIds } };
  if (filter.senderId !== undefined) base.senderId = filter.senderId;
  if (filter.from || filter.to) {
    base.createdAt = {
      ...(filter.from ? { $gte: { $date: filter.from.toISOString() } } : {}),
      ...(filter.to ? { $lte: { $date: filter.to.toISOString() } } : {}),
    };
  }
  return base;
}

/**
 * Extended-JSON decoding for findRaw results. Numbers can arrive plain or as
 * {$numberInt|$numberLong|$numberDouble}, dates as {$date: iso} or {$date: {$numberLong: ms}}.
 */
type EJson = Record<string, unknown>;

function asArray(value: unknown): EJson[] {
  return Array.isArray(value) ? (value as EJson[]) : [];
}

function asNumber(value: unknown): number {
  if (value !== null && typeof value === 'object') {
    const v = value as EJson;
    return Number(v.$numberLong ?? v.$numberInt ?? v.$numberDouble ?? NaN);
  }
  return Number(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asDate(value: unknown): Date {
  if (value !== null && typeof value === 'object' && '$date' in (value as EJson)) {
    const inner = (value as EJson).$date;
    if (inner !== null && typeof inner === 'object' && '$numberLong' in (inner as EJson)) {
      return new Date(Number((inner as EJson).$numberLong));
    }
    return new Date(inner as string | number);
  }
  return new Date(value as string | number);
}

function decodeDocs(raw: unknown): BodySearchDoc[] {
  return asArray(raw).map((d) => ({
    id: asNumber(d._id),
    conversationId: asNumber(d.conversationId),
    senderId: asNumber(d.senderId),
    body: asString(d.body),
    createdAt: asDate(d.createdAt),
  }));
}
