import express from 'express';
import { config } from '../config.ts';
import { asyncHandler } from '../http/errors.ts';
import { enforceRateLimit } from '../http/rate-limit-headers.ts';
import { int, intOr, optionalInt, optionalIsoDate } from '../http/validate.ts';
import { consumeSearchQuota } from '../services/rate-limit.ts';
import { searchMessages } from '../services/search.ts';

export const searchRouter = express.Router();

/**
 * GET /api/search?q=…&userId=…
 *   optional: conversationId, senderId, from, to (ISO dates), limit, offset
 *
 * tasks/search.md. Results are scoped to the caller's conversations; see
 * src/services/search.ts for the ranking, the indexed prefix fallback and why it replaced a
 * collection scan.
 *
 * Rate limited. Search is the most expensive read in the app — it fans out over every message the
 * caller can see — and sends were originally the only metered endpoint, which left an unbounded
 * way to generate read load.
 *
 * Each result keeps the `{ conversationId, conversationTitle, body }` shape the original
 * `renderResults` read, with extra fields alongside. The response is wrapped in an envelope
 * carrying `hasMore`/`nextOffset`, matching how `GET /api/messages` reports truncation, so neither
 * list endpoint silently drops results.
 */
searchRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const userId = int(req.query.userId, 'userId');

    // A blank query is free — it does no work, so metering it would only punish an empty submit.
    if (!q) {
      return res.json({ query: '', results: [], hasMore: false, nextOffset: null, matchedBy: 'none' });
    }

    enforceRateLimit(
      res,
      await consumeSearchQuota(userId),
      (limit) =>
        `search rate limit exceeded: at most ${limit} searches per ${
          config.rateLimit.searchWindowMs / 1000
        }s`,
    );

    res.json(
      await searchMessages(userId, q, {
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
  }),
);
