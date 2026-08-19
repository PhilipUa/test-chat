import type { Request, Response } from 'express';
import { actorId, searchQuery } from '../middleware/locals.ts';
import { searchMessages } from '../services/search.ts';
import { ok } from './respond.ts';

/**
 * Search — tasks/search.md.
 *
 * Results are scoped to the caller's conversations; see services/search.ts for the strategy ladder
 * ($text, then indexed prefix, then fuzzy). The route is rate limited (blank queries excepted — the
 * limiter skips them, since they do no work), and the query shape is validated by searchQuerySchema
 * in the route chain.
 *
 * A blank query needs no special case here: `searchMessages` answers it with the empty response
 * before touching either store. Building that response in this controller as well meant the same
 * literal existed twice, so a new field on SearchResponse would have been added to one and silently
 * missing from the other.
 */
export async function search(req: Request, res: Response): Promise<void> {
  const { q, ...opts } = searchQuery(res);
  ok(res, await searchMessages(actorId(res), q, opts));
}
