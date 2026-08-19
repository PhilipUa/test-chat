import {
  conversationExists,
  conversationIdsOf,
  isParticipant,
  participantIdsByConversation,
} from '../../repositories/conversations.repository.ts';
import { HttpError } from '../../errors.ts';

/**
 * Conversation membership and authorization.
 *
 * This half has the widest fan-in in the app — imported by the routes, by search, and by the
 * WebSocket protocol handlers — and it answers a different question from "what does the inbox
 * look like". The policy (which error, and when) lives here; the queries live in
 * repositories/conversations.repository.ts.
 *
 * There was no authorization at all originally: conversationId and senderId were taken from the
 * request body and trusted, so you could post into a conversation you weren't in, or subscribe to
 * one and tail it.
 */

/** Throws 403 if the user isn't a participant, 404 if the conversation doesn't exist. */
export async function assertParticipant(userId: number, conversationId: number): Promise<void> {
  if (await isParticipant(userId, conversationId)) return;

  // Distinguish "no such conversation" from "not yours" for a useful error, without leaking the
  // existence of conversations the caller isn't in.
  if (!(await conversationExists(conversationId))) {
    throw HttpError.notFound(`conversation ${conversationId} not found`);
  }
  throw HttpError.forbidden(
    `user ${userId} is not a participant in conversation ${conversationId}`,
  );
}

/**
 * Intersects a requested set of conversation ids with those the user is actually in. Used by the
 * WS subscribe handler, which previously accepted any ids the client named. An empty `requested`
 * means "everything I'm in".
 */
export async function participantConversationIds(
  userId: number,
  requested: number[] = [],
): Promise<number[]> {
  if (requested.length === 0) return conversationIdsOf(userId);
  return conversationIdsOf(userId, [...new Set(requested)]);
}

/**
 * Participant ids for many conversations in one query.
 *
 * The presence snapshot used to ask per conversation and then call onlineAmong per conversation —
 * two round trips each, on every subscribe. Harmless with two conversations; a subscriber with
 * 1,083 of them was issuing ~2,000 queries before its socket was usable, which is exactly the N+1
 * shape the conversation list was fixed for. Batched is the only shape now, so the single-id
 * variant is gone rather than sitting there inviting the loop back.
 */
export async function participantIdsOfMany(
  conversationIds: number[],
): Promise<Map<number, number[]>> {
  if (!conversationIds.length) return new Map();
  return participantIdsByConversation([...new Set(conversationIds)]);
}
