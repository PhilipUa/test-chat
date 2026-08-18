import type { Request, RequestHandler } from 'express';
import { asyncHandler } from './async-handler.ts';
import { assertParticipant } from '../services/conversations/membership.ts';
import { int, optionalInt } from '../validation/parse.ts';
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
 */
export interface ParticipantOptions {
  actor: ActorSource;
  conversation: ActorSource;
  actorField?: string;
  conversationField?: string;
  /**
   * When true, a missing actor skips the check instead of failing.
   *
   * Used by GET /api/messages, whose `userId` is optional for compatibility with the original
   * endpoint. It's the one soft edge in the authorization story and it goes away with real auth.
   */
  optionalActor?: boolean;
}

export function requireParticipant(options: ParticipantOptions): RequestHandler {
  const {
    actor,
    conversation,
    actorField = 'userId',
    conversationField = 'conversationId',
    optionalActor = false,
  } = options;

  return asyncHandler(async (req: Request, res, next) => {
    const conversationId = int(conversation(req), conversationField);
    res.locals.conversationId = conversationId;

    const actorId = optionalActor
      ? optionalInt(actor(req), actorField)
      : int(actor(req), actorField);

    if (actorId === undefined) {
      next();
      return;
    }

    res.locals.actorId = actorId;
    await assertParticipant(actorId, conversationId);
    next();
  });
}
