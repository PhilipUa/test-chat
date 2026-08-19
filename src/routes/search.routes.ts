import { Router } from 'express';
import * as search from '../controllers/search.controller.ts';
import { asyncHandler } from '../middleware/async-handler.ts';
import { actorId, searchQuery } from '../middleware/locals.ts';
import { rateLimit } from '../middleware/rate-limit.ts';
import { fromQuery, requireActor } from '../middleware/require-actor.ts';
import { validateQuery } from '../middleware/validate.ts';
import { searchQuerySchema } from '../validation/schemas.ts';
import { config } from '../config.ts';

export const searchRouter = Router();

/**
 * GET /api/search?q=…&userId=…[&conversationId=][&senderId=][&from=][&to=][&limit=][&offset=]
 *
 * Metered per user rather than per conversation, because a search spans them. A blank query is
 * skipped by the limiter: it does no work, so charging for it would only punish an empty submit.
 */
searchRouter.get(
  '/',
  requireActor(fromQuery('userId')),
  validateQuery(searchQuerySchema, (res, query) => {
    res.locals.searchQuery = query;
  }),
  rateLimit({
    rule: config.rateLimit.search,
    key: (_req, res) => `search:${actorId(res)}`,
    describe: (limit, windowSeconds) =>
      `search rate limit exceeded: at most ${limit} searches per ${windowSeconds}s`,
    skip: (_req, res) => searchQuery(res).q.length === 0,
  }),
  asyncHandler(search.search),
);
