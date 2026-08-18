import express from 'express';
import { config } from '../config.ts';
import { asyncHandler } from '../http/errors.ts';
import { boundedInt, optionalPositiveInt, positiveInt } from '../http/validate.ts';
import { searchMessages } from '../services/search.ts';

export const searchRouter = express.Router();

/**
 * GET /api/search?q=…&userId=…[&conversationId=…][&limit=…]
 *
 * tasks/search.md. Results are scoped to the caller's conversations — see
 * src/services/search.ts for how the ranking and the substring fallback work.
 *
 * Each result keeps the `{ conversationId, conversationTitle, body }` shape the original
 * `renderResults` read, with extra fields alongside. The response is wrapped in an envelope
 * carrying `hasMore`, which matches how `GET /api/messages` now paginates — so both list
 * endpoints report truncation the same way instead of one of them silently dropping results.
 */
searchRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json({ query: '', results: [], hasMore: false });

    const userId = positiveInt(req.query.userId, 'userId');
    const conversationId = optionalPositiveInt(req.query.conversationId, 'conversationId');
    const limit = boundedInt(req.query.limit, 'limit', config.search.defaultLimit, config.search.maxLimit);

    res.json(await searchMessages(userId, q, { limit, conversationId }));
  }),
);
