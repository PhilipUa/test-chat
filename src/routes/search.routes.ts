import { Router } from 'express';
import * as search from '../controllers/search.controller.ts';
import { asyncHandler } from '../middleware/async-handler.ts';
import { actorId } from '../middleware/locals.ts';
import { rateLimit } from '../middleware/rate-limit.ts';
import { fromQuery, requireActor } from '../middleware/require-actor.ts';
import { consumeSearchQuota } from '../services/rate-limit.ts';

export const searchRouter = Router();

/**
 * GET /api/search?q=…&userId=…[&conversationId=][&senderId=][&from=][&to=][&limit=][&offset=]
 *
 * Metered per user rather than per conversation, because a search spans them. A blank query is
 * skipped: it does no work, so charging for it would only punish an empty submit.
 */
searchRouter.get(
  '/',
  requireActor(fromQuery('userId')),
  rateLimit({
    consume: (_req, res) => consumeSearchQuota(actorId(res)),
    describe: (limit, windowSeconds) =>
      `search rate limit exceeded: at most ${limit} searches per ${windowSeconds}s`,
    skip: search.isBlankQuery,
  }),
  asyncHandler(search.search),
);
