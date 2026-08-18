import type { Request, Response } from 'express';
import { config } from '../config.ts';
import { actorId, conversationId, newMessage } from '../middleware/locals.ts';
import { int, intOr, optionalInt } from '../validation/parse.ts';
import { createMessage, listMessages } from '../services/messages.ts';
import { publish } from '../ws/hub.ts';

/**
 * Message endpoints.
 *
 * Controllers do three things and nothing else: read the request, call a service, shape the response.
 * Identity, authorization and rate limiting happen in middleware — see routes/messages.routes.ts for
 * the chain — so what's left here is the HTTP shape of each endpoint.
 */

export async function send(req: Request, res: Response): Promise<void> {
  // Everything here was validated and authorized by the middleware chain: requireParticipant checked
  // the sender and conversation, parseMessagePayload checked the body.
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

  // 200 rather than 201 for a deduplicated retry: nothing was created.
  res.status(deduplicated ? 200 : 201).json(message);
}

export async function list(req: Request, res: Response): Promise<void> {
  const conversation = int(req.query.conversationId, 'conversationId');
  const limit = intOr(req.query.limit, 'limit', config.messages.defaultPageSize, {
    max: config.messages.maxPageSize,
  });
  const before = optionalInt(req.query.before, 'before');
  // `since` walks forwards from a known id, for a client catching up after a realtime gap. Redis
  // pub/sub is at-most-once, so events published while an instance was disconnected are lost; this
  // is how a client recovers exactly what it missed instead of refetching wholesale.
  // min 0: `since=0` means "everything from the beginning".
  const since = optionalInt(req.query.since, 'since', { min: 0 });

  res.json(await listMessages(conversation, { limit, before, since }));
}
