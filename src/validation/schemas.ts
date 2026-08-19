import { z } from 'zod';
import { config } from '../config.ts';
import { HttpError } from '../errors.ts';
import { decodeCursor, type ConversationCursor } from '../services/conversations/queries.ts';

/**
 * The request boundary, as Zod schemas — one per route, wired in the route table through the
 * validate middleware (middleware/validate.ts). Everything past this file works with checked,
 * transformed values: controllers and services do no type checking or coercion of their own.
 *
 * Each route schema is a single transform over the raw body/query object, with field parsers that
 * handle absence themselves. Deliberately not `z.object` of piped leaves: an absent key and a
 * present-but-empty one mean the same thing at an HTTP boundary (that is what an empty query param
 * is), and this shape reports *every* wrong field in one response instead of one per round trip.
 *
 * The field parsers reproduce the semantics the old hand parsers had, because they are behavior,
 * not incidental detail: values above a cap are *clamped*, not rejected (a caller asking for too
 * much gets the cap); `participantIds` are de-duplicated (a repeated id used to trip the primary
 * key and kill the process); `clientId: ''` means "no idempotency key", i.e. null.
 */

interface IntOptions {
  /** Smallest accepted value. Defaults to 1, since most numbers here are ids. */
  min?: number;
  /** Values above this are clamped, not rejected — a caller asking for too much gets the cap. */
  max?: number;
}

type Ctx = z.RefinementCtx;

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function intField(value: unknown, field: string, { min = 1, max }: IntOptions, ctx: Ctx): number {
  // Only numbers and strings can be integers; anything else (Express's parsed-object query
  // shapes, arrays) is rejected rather than stringified into something accidentally numeric.
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isInteger(n) || n < min) {
    ctx.addIssue({
      code: 'custom',
      message:
        min === 1
          ? `${field} must be a positive integer`
          : `${field} must be an integer of at least ${min}`,
    });
    return z.NEVER;
  }
  return max === undefined ? n : Math.min(n, max);
}

function optionalIntField(
  value: unknown,
  field: string,
  opts: IntOptions,
  ctx: Ctx,
): number | undefined {
  return absent(value) ? undefined : intField(value, field, opts, ctx);
}

/** Optional integer with a default, clamped to `max`. For page sizes and offsets. */
function intFieldOr(
  value: unknown,
  field: string,
  fallback: number,
  opts: IntOptions,
  ctx: Ctx,
): number {
  return absent(value) ? fallback : intField(value, field, opts, ctx);
}

function nonEmptyStringField(value: unknown, field: string, maxLength: number, ctx: Ctx): string {
  if (typeof value !== 'string') {
    ctx.addIssue({ code: 'custom', message: `${field} must be a string` });
    return z.NEVER;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    ctx.addIssue({ code: 'custom', message: `${field} must not be empty` });
    return z.NEVER;
  }
  if (trimmed.length > maxLength) {
    ctx.addIssue({ code: 'custom', message: `${field} must be at most ${maxLength} characters` });
    return z.NEVER;
  }
  return trimmed;
}

function clientIdField(value: unknown, ctx: Ctx): string | null {
  if (absent(value)) return null;
  if (typeof value !== 'string') {
    ctx.addIssue({ code: 'custom', message: 'clientId must be a string' });
    return z.NEVER;
  }
  const trimmed = value.trim();
  // Column is VARCHAR(64); reject rather than silently truncating, which would make two
  // different sends collide on the idempotency index.
  if (trimmed.length > 64) {
    ctx.addIssue({ code: 'custom', message: 'clientId must be at most 64 characters' });
    return z.NEVER;
  }
  return trimmed || null;
}

function idListField(value: unknown, field: string, ctx: Ctx, maxLength = 100): number[] {
  if (!Array.isArray(value)) {
    ctx.addIssue({ code: 'custom', message: `${field} must be an array` });
    return z.NEVER;
  }
  if (value.length === 0) {
    ctx.addIssue({ code: 'custom', message: `${field} must not be empty` });
    return z.NEVER;
  }
  if (value.length > maxLength) {
    ctx.addIssue({ code: 'custom', message: `${field} must contain at most ${maxLength} entries` });
    return z.NEVER;
  }
  // De-duplicate: the old code inserted participants in a loop and a repeated id tripped the
  // primary key, which is what took the process down.
  return [...new Set(value.map((v) => intField(v, `${field}[]`, {}, ctx)))];
}

function optionalIsoDateField(value: unknown, field: string, ctx: Ctx): Date | undefined {
  if (absent(value)) return undefined;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    ctx.addIssue({ code: 'custom', message: `${field} must be an ISO date` });
    return z.NEVER;
  }
  return parsed;
}

// --- route schemas -------------------------------------------------------------------------

export interface MessagePayload {
  body: string;
  clientId: string | null;
}

export const messagePayloadSchema: z.ZodType<MessagePayload, unknown> = z
  .unknown()
  .transform((input, ctx): MessagePayload => {
    const raw = asObject(input);
    return {
      body: nonEmptyStringField(raw.body, 'body', config.messages.maxBodyLength, ctx),
      clientId: clientIdField(raw.clientId, ctx),
    };
  });

export interface ConversationPayload {
  title: string;
  participantIds: number[];
}

export const conversationPayloadSchema: z.ZodType<ConversationPayload, unknown> = z
  .unknown()
  .transform((input, ctx): ConversationPayload => {
    const raw = asObject(input);
    return {
      title: nonEmptyStringField(raw.title, 'title', 200, ctx),
      participantIds: idListField(raw.participantIds, 'participantIds', ctx),
    };
  });

export interface MarkReadPayload {
  messageId: number;
}

export const markReadPayloadSchema: z.ZodType<MarkReadPayload, unknown> = z
  .unknown()
  .transform((input, ctx): MarkReadPayload => {
    const raw = asObject(input);
    return { messageId: intField(raw.messageId, 'messageId', {}, ctx) };
  });

export interface ListMessagesQuery {
  limit: number;
  before?: number;
  since?: number;
}

export const listMessagesQuerySchema: z.ZodType<ListMessagesQuery, unknown> = z
  .unknown()
  .transform((input, ctx): ListMessagesQuery => {
    const raw = asObject(input);
    return {
      limit: intFieldOr(
        raw.limit,
        'limit',
        config.messages.defaultPageSize,
        { max: config.messages.maxPageSize },
        ctx,
      ),
      before: optionalIntField(raw.before, 'before', {}, ctx),
      // `since` walks forwards from a known id, for a client catching up after a realtime gap.
      // min 0: `since=0` means "everything from the beginning".
      since: optionalIntField(raw.since, 'since', { min: 0 }, ctx),
    };
  });

export interface ListConversationsQuery {
  limit: number;
  cursor?: ConversationCursor;
}

export const listConversationsQuerySchema: z.ZodType<ListConversationsQuery, unknown> = z
  .unknown()
  .transform((input, ctx): ListConversationsQuery => {
    const raw = asObject(input);

    // Rejected rather than ignored: silently returning page one for a cursor we can't read looks
    // to the client like the end of the list, which is how a paging loop quietly drops
    // conversations.
    let cursor: ConversationCursor | undefined;
    if (!absent(raw.cursor)) {
      cursor = typeof raw.cursor === 'string' ? decodeCursor(raw.cursor) : undefined;
      if (!cursor) {
        ctx.addIssue({ code: 'custom', message: 'cursor is not a valid pagination cursor' });
      }
    }

    return {
      limit: intFieldOr(
        raw.limit,
        'limit',
        config.conversations.defaultPageSize,
        { max: config.conversations.maxPageSize },
        ctx,
      ),
      cursor,
    };
  });

export interface SearchQuery {
  q: string;
  limit: number;
  offset: number;
  conversationId?: number;
  senderId?: number;
  from?: Date;
  to?: Date;
}

export const searchQuerySchema: z.ZodType<SearchQuery, unknown> = z
  .unknown()
  .transform((input, ctx): SearchQuery => {
    const raw = asObject(input);
    return {
      // Non-string shapes (`?q[a]=b`, repeated `?q=`) mean nothing for a search term, so they read
      // as blank rather than stringifying into '[object Object]'.
      q: typeof raw.q === 'string' ? raw.q.trim() : '',
      limit: intFieldOr(
        raw.limit,
        'limit',
        config.search.defaultLimit,
        { max: config.search.maxLimit },
        ctx,
      ),
      // min 0: offset 0 is the first page.
      offset: intFieldOr(raw.offset, 'offset', 0, { min: 0, max: config.search.maxOffset }, ctx),
      conversationId: optionalIntField(raw.conversationId, 'conversationId', {}, ctx),
      senderId: optionalIntField(raw.senderId, 'senderId', {}, ctx),
      from: optionalIsoDateField(raw.from, 'from', ctx),
      to: optionalIsoDateField(raw.to, 'to', ctx),
    };
  });

/**
 * One id, for the authorization middleware (require-actor / require-participant), which resolves
 * ids from configurable request sources before any schema has run. Throws the same 400 the
 * validate middleware produces, so the two paths are indistinguishable to a client.
 */
const idSchema = z.unknown().transform((value, ctx) => intField(value, 'id', {}, ctx));

export function parseId(value: unknown, field: string): number {
  const result = idSchema.safeParse(value);
  if (!result.success) {
    // The schema names the generic 'id'; rewrite with the field the route configured.
    throw HttpError.badRequest(`${field} must be a positive integer`);
  }
  return result.data;
}
