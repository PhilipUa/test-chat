import type { Request, Response } from 'express';
import { config } from '../config.ts';
import { actorId } from '../middleware/locals.ts';
import { int, intOr, optionalInt, optionalIsoDate } from '../validation/parse.ts';
import { searchMessages } from '../services/search.ts';

/**
 * Search — tasks/search.md.
 *
 * Results are scoped to the caller's conversations; see services/search.ts for the ranking and the
 * indexed prefix fallback. The route is rate limited, because this is the most expensive read in the
 * app — it fans out over every message the caller can see.
 */

/** A blank query does no work, so it's answered here and never reaches the limiter. */
export const isBlankQuery = (req: Request): boolean =>
  String(req.query.q ?? '').trim().length === 0;

export async function search(req: Request, res: Response): Promise<void> {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.json({ query: '', results: [], hasMore: false, nextOffset: null, matchedBy: 'none' });
    return;
  }

  res.json(
    await searchMessages(actorId(res), q, {
      limit: intOr(req.query.limit, 'limit', config.search.defaultLimit, {
        max: config.search.maxLimit,
      }),
      // min 0: offset 0 is the first page.
      offset: intOr(req.query.offset, 'offset', 0, { min: 0, max: config.search.maxOffset }),
      conversationId: optionalInt(req.query.conversationId, 'conversationId'),
      senderId: optionalInt(req.query.senderId, 'senderId'),
      from: optionalIsoDate(req.query.from, 'from'),
      to: optionalIsoDate(req.query.to, 'to'),
    }),
  );
}
