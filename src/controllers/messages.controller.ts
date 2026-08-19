import type { Request, Response } from 'express';
import { actorId, conversationId, messagesQuery, newMessage } from '../middleware/locals.ts';
import { createMessage, listMessages } from '../services/messages.ts';
import { publish } from '../ws/hub.ts';
import { createdOrOk, ok } from './respond.ts';

/**
 * Message endpoints.
 *
 * Controllers do three things and nothing else: read the request, call a service, shape the response.
 * Identity, authorization, schema validation and rate limiting happen in middleware — see
 * routes/messages.routes.ts for the chain — so what's left here is the HTTP shape of each endpoint.
 */

export async function send(req: Request, res: Response): Promise<void> {
  // Everything here was validated and authorized by the middleware chain: requireParticipant checked
  // the sender and conversation, the message schema checked the body.
  const senderId = actorId(res);
  const conversation = conversationId(res);
  const { body, clientId } = newMessage(res);

  const { message, deduplicated } = await createMessage({
    conversationId: conversation,
    senderId,
    body,
    clientId,
  });

  // Only fan out genuinely new messages. Re-broadcasting a deduplicated retry would put a second
  // copy in everyone's window, which is the bug idempotency exists to prevent.
  if (!deduplicated) {
    await publish(message.conversationId, { type: 'message', ...message });
  }

  createdOrOk(res, !deduplicated, message);
}

export async function list(req: Request, res: Response): Promise<void> {
  // `since` walks forwards from a known id, for a client catching up after a realtime gap. Redis
  // pub/sub is at-most-once, so events published while an instance was disconnected are lost; this
  // is how a client recovers exactly what it missed instead of refetching wholesale.
  ok(res, await listMessages(conversationId(res), messagesQuery(res)));
}
