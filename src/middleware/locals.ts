import type { Response } from 'express';

/**
 * Typed `res.locals`, the hand-off from middleware to controller.
 *
 * Middleware that has already validated something (who is acting, which conversation) puts it here
 * so the controller doesn't parse it a second time. The accessors throw rather than returning
 * undefined: reaching a controller without its middleware having run is a wiring mistake, and it
 * should fail loudly in development instead of turning into a confusing NaN downstream.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      /** The user the request is acting as. Real auth would set this from a session or token. */
      actorId?: number;
      /** The conversation the request targets, already checked for membership. */
      conversationId?: number;
      /** A validated send, parsed before the rate limiter ran. See middleware/payload.ts. */
      newMessage?: { body: string; clientId: string | null };
      /** A validated conversation create, parsed before the rate limiter ran. */
      newConversation?: { title: string; participantIds: number[] };
    }
  }
}

export function actorId(res: Response): number {
  const id = res.locals.actorId;
  if (id === undefined) {
    throw new Error('actorId is not set — this route is missing requireActor/requireParticipant');
  }
  return id;
}

export function conversationId(res: Response): number {
  const id = res.locals.conversationId;
  if (id === undefined) {
    throw new Error('conversationId is not set — this route is missing requireParticipant');
  }
  return id;
}

export function newMessage(res: Response): { body: string; clientId: string | null } {
  const payload = res.locals.newMessage;
  if (payload === undefined) {
    throw new Error('newMessage is not set — this route is missing parseMessagePayload');
  }
  return payload;
}

export function newConversation(res: Response): { title: string; participantIds: number[] } {
  const payload = res.locals.newConversation;
  if (payload === undefined) {
    throw new Error('newConversation is not set — this route is missing parseConversationPayload');
  }
  return payload;
}
