import { exists, queryRows, sqlList } from '../../db/mysql.ts';
import { HttpError } from '../../http/errors.ts';

/**
 * Conversation membership and authorization.
 *
 * Split out of a 250-line services/conversations.ts that mixed read models, writes and
 * authorization. This half has the widest fan-in in the app — imported by the routes, by search, and
 * by the WebSocket protocol handlers — and it answers a different question from "what does the inbox
 * look like".
 *
 * There was no authorization at all originally: conversationId and senderId were taken from the
 * request body and trusted, so you could post into a conversation you weren't in, or subscribe to
 * one and tail it.
 */

/** Throws 403 if the user isn't a participant, 404 if the conversation doesn't exist. */
export async function assertParticipant(userId: number, conversationId: number): Promise<void> {
  const isParticipant = await exists(
    `SELECT 1 FROM conversation_participants
     WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
    [conversationId, userId],
  );
  if (isParticipant) return;

  // Distinguish "no such conversation" from "not yours" for a useful error, without leaking the
  // existence of conversations the caller isn't in.
  const conversationExists = await exists('SELECT 1 FROM conversations WHERE id = ? LIMIT 1', [
    conversationId,
  ]);
  if (!conversationExists) throw HttpError.notFound(`conversation ${conversationId} not found`);
  throw HttpError.forbidden(
    `user ${userId} is not a participant in conversation ${conversationId}`,
  );
}

/**
 * Intersects a requested set of conversation ids with those the user is actually in. Used by the WS
 * subscribe handler, which previously accepted any ids the client named. An empty `requested` means
 * "everything I'm in".
 */
export async function participantConversationIds(
  userId: number,
  requested: number[] = [],
): Promise<number[]> {
  if (requested.length === 0) {
    const rows = await queryRows<{ conversation_id: number }>(
      'SELECT conversation_id FROM conversation_participants WHERE user_id = ?',
      [userId],
    );
    return rows.map((r) => Number(r.conversation_id));
  }

  const unique = [...new Set(requested)];
  const rows = await queryRows<{ conversation_id: number }>(
    `SELECT conversation_id FROM conversation_participants
     WHERE user_id = ? AND conversation_id IN (${sqlList(unique.length)})`,
    [userId, ...unique],
  );
  return rows.map((r) => Number(r.conversation_id));
}

export async function participantIdsOf(conversationId: number): Promise<number[]> {
  const rows = await queryRows<{ user_id: number }>(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = ?',
    [conversationId],
  );
  return rows.map((r) => Number(r.user_id));
}

/**
 * Participant ids for many conversations in one query.
 *
 * The presence snapshot used to call participantIdsOf per conversation and then onlineAmong per
 * conversation — two round trips each, on every subscribe. Harmless with two conversations; a
 * subscriber with 1,083 of them was issuing ~2,000 queries before its socket was usable, which is
 * exactly the N+1 shape the conversation list was fixed for.
 */
export async function participantIdsOfMany(
  conversationIds: number[],
): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  if (!conversationIds.length) return result;

  const unique = [...new Set(conversationIds)];
  const rows = await queryRows<{ conversation_id: number; user_id: number }>(
    `SELECT conversation_id, user_id FROM conversation_participants
     WHERE conversation_id IN (${sqlList(unique.length)})`,
    unique,
  );
  for (const row of rows) {
    const id = Number(row.conversation_id);
    const list = result.get(id) ?? [];
    list.push(Number(row.user_id));
    result.set(id, list);
  }
  return result;
}
