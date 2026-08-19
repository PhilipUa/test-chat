import type { Request, RequestHandler } from 'express';
import { asyncHandler } from './async-handler.ts';
import { assertParticipant } from '../services/conversations/membership.ts';
import { parseId } from '../validation/schemas.ts';
import type { ActorSource } from './require-actor.ts';

/**
 * Authorization: the acting user must be a participant in the target conversation.
 *
 * Originally there was none — `senderId` and `conversationId` were taken from the request and
 * trusted, so posting into a conversation you weren't in returned 201. As middleware rather than a
 * call inside each handler, it's visible in the route table: you can read a routes file and see
 * which endpoints are guarded, which is the property that makes a missing check noticeable.
 *
 * Both ids land in res.locals, so controllers don't re-parse them.
 *
 * The actor is always required. GET /api/messages used to make it optional "for compatibility with
 * the original endpoint" — but the original never accepted `userId` at all, so the only thing that
 * bought was an authorization check any caller could skip by leaving the parameter off.
 */
export interface ParticipantOptions {
  actor: ActorSource;
  conversation: ActorSource;
  actorField?: string;
  conversationField?: string;
}

export function requireParticipant(options: ParticipantOptions): RequestHandler {
  const {
    actor,
    conversation,
    actorField = 'userId',
    conversationField = 'conversationId',
  } = options;

  return asyncHandler(async (req: Request, res, next) => {
    const conversationId = parseId(conversation(req), conversationField);
    res.locals.conversationId = conversationId;

    const actorId = parseId(actor(req), actorField);
    res.locals.actorId = actorId;
    await assertParticipant(actorId, conversationId);
    next();
  });
}
