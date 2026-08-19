import type { Response } from 'express';
import type {
  ConversationPayload,
  ListConversationsQuery,
  ListMessagesQuery,
  MarkReadPayload,
  MessagePayload,
  SearchQuery,
} from '../validation/schemas.ts';

/**
 * Typed `res.locals`, the hand-off from middleware to controller.
 *
 * Middleware that has already validated something (who is acting, which conversation, the parsed
 * body or query) puts it here so the controller doesn't parse it a second time. The accessors
 * throw rather than returning undefined: reaching a controller without its middleware having run
 * is a wiring mistake, and it should fail loudly in development instead of turning into a
 * confusing NaN downstream.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      /** The user the request is acting as. Real auth would set this from a session or token. */
      actorId?: number;
      /** The conversation the request targets, already checked for membership. */
      conversationId?: number;
      /** A validated send, parsed before the rate limiter ran. */
      newMessage?: MessagePayload;
      /** A validated conversation create, parsed before the rate limiter ran. */
      newConversation?: ConversationPayload;
      /** A validated read acknowledgement. */
      readPayload?: MarkReadPayload;
      /** Validated pagination for GET /api/messages. */
      messagesQuery?: ListMessagesQuery;
      /** Validated pagination for GET /api/conversations. */
      conversationsQuery?: ListConversationsQuery;
      /** Validated parameters for GET /api/search. */
      searchQuery?: SearchQuery;
    }
  }
}

function required<T>(value: T | undefined, name: string, middleware: string): T {
  if (value === undefined) {
    throw new Error(`${name} is not set — this route is missing ${middleware}`);
  }
  return value;
}

export function actorId(res: Response): number {
  return required(res.locals.actorId, 'actorId', 'requireActor/requireParticipant');
}

export function conversationId(res: Response): number {
  return required(res.locals.conversationId, 'conversationId', 'requireParticipant');
}

export function newMessage(res: Response): MessagePayload {
  return required(res.locals.newMessage, 'newMessage', 'validateBody(messagePayloadSchema)');
}

export function newConversation(res: Response): ConversationPayload {
  return required(
    res.locals.newConversation,
    'newConversation',
    'validateBody(conversationPayloadSchema)',
  );
}

export function readPayload(res: Response): MarkReadPayload {
  return required(res.locals.readPayload, 'readPayload', 'validateBody(markReadPayloadSchema)');
}

export function messagesQuery(res: Response): ListMessagesQuery {
  return required(
    res.locals.messagesQuery,
    'messagesQuery',
    'validateQuery(listMessagesQuerySchema)',
  );
}

export function conversationsQuery(res: Response): ListConversationsQuery {
  return required(
    res.locals.conversationsQuery,
    'conversationsQuery',
    'validateQuery(listConversationsQuerySchema)',
  );
}

export function searchQuery(res: Response): SearchQuery {
  return required(res.locals.searchQuery, 'searchQuery', 'validateQuery(searchQuerySchema)');
}
