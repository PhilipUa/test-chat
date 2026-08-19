/** Wire format for everything that travels over the WebSocket and through Redis pub/sub. */

import type { ConversationSummary } from '../services/conversations/queries.ts';

export interface MessageEvent {
  type: 'message';
  id: number;
  conversationId: number;
  senderId: number;
  body: string;
  clientId: string | null;
  createdAt: string;
}

export interface TypingEvent {
  type: 'typing';
  conversationId: number;
  userId: number;
  userName: string;
  /** false is an explicit "stopped typing" (message sent, or input cleared). */
  isTyping: boolean;
  /** Client-side safety net: drop the indicator after this many ms even if nothing follows. */
  ttlMs: number;
}

export interface ReadEvent {
  type: 'read';
  conversationId: number;
  userId: number;
  lastReadMessageId: number;
}

export interface PresenceEvent {
  type: 'presence';
  conversationId: number;
  userId: number;
  userName: string;
  online: boolean;
}

/** Events about one conversation, delivered to whoever is subscribed to it. */
export type ConversationEvent = MessageEvent | TypingEvent | ReadEvent | PresenceEvent;

/**
 * A conversation the recipient has just been added to.
 *
 * Addressed to a *user*, not to a conversation, and that is the whole point: the recipient has
 * never heard of this conversation, so there is no conversation channel they could already be
 * subscribed to. It carries a whole inbox row rather than an id, so the sidebar can render it
 * without a refetch.
 */
export interface ConversationCreatedEvent {
  type: 'conversation';
  conversation: ConversationSummary;
}

/** Events about a user's own inbox, delivered to every socket signed in as them. */
export type UserEvent = ConversationCreatedEvent;

export type RealtimeEvent = ConversationEvent | UserEvent;

/** Envelope used on the Redis channel only — carries routing metadata the browser never sees. */
export interface FanoutEnvelope {
  event: RealtimeEvent;
  /** Instance that published it. Useful when debugging a multi-instance setup. */
  origin: string;
  /**
   * Connection that caused it, if any. Lets us skip delivery back to the originating socket —
   * you should not see your own typing indicator.
   */
  originConnectionId?: string;
}

/** Written once, so the builders and the parser below can't drift apart. */
const CONVERSATION_PREFIX = 'relay:conv:';
const USER_PREFIX = 'relay:user:';

/**
 * Whether an event should be delivered to a given subscriber.
 *
 * Tier 3.1 of the refactoring plan. `deliverLocally` grew one `if` per event type:
 *
 *   if (event.type === 'typing'   && event.userId === client.userId) continue;
 *   if (event.type === 'presence' && event.userId === client.userId) continue;
 *
 * Both encode the same rule — don't tell someone about their own action — in the one place that has
 * to be edited for every new event type. Event types are the axis this codebase has actually grown
 * along (1 -> 7), so the rule belongs with the event definition instead.
 *
 * `message` is deliberately *not* self-suppressed: you do want your own message echoed back, since
 * that's what confirms it and replaces the optimistic bubble. Neither is `conversation` — the
 * creator's *other* tabs need it just as much as the people they invited.
 */
const SUPPRESS_OWN: Partial<Record<RealtimeEvent['type'], true>> = {
  typing: true,
  presence: true,
};

/** The subject of an event, when it has one — used to decide self-suppression. */
function subjectOf(event: RealtimeEvent): number | undefined {
  return 'userId' in event ? event.userId : undefined;
}

export function shouldDeliver(event: RealtimeEvent, toUserId: number | undefined): boolean {
  if (!SUPPRESS_OWN[event.type]) return true;
  return subjectOf(event) !== toUserId;
}

export const channelFor = (conversationId: number): string =>
  `${CONVERSATION_PREFIX}${conversationId}`;

export const userChannelFor = (userId: number): string => `${USER_PREFIX}${userId}`;

/**
 * Who a channel's traffic is for.
 *
 * Two namespaces rather than one: conversation channels are held by whoever is subscribed to that
 * conversation, user channels by whoever is signed in as that user. The subscriber has only the
 * channel name to go on, so the routing rule has to be recoverable from it.
 */
export type ChannelTarget =
  { kind: 'conversation'; conversationId: number } | { kind: 'user'; userId: number };

export function targetOfChannel(channel: string): ChannelTarget | undefined {
  if (channel.startsWith(CONVERSATION_PREFIX)) {
    const conversationId = positiveIntOrUndefined(channel.slice(CONVERSATION_PREFIX.length));
    return conversationId === undefined ? undefined : { kind: 'conversation', conversationId };
  }
  if (channel.startsWith(USER_PREFIX)) {
    const userId = positiveIntOrUndefined(channel.slice(USER_PREFIX.length));
    return userId === undefined ? undefined : { kind: 'user', userId };
  }
  return undefined;
}

/** True for exactly the conversation channels — what /api/health counts. */
export function isConversationChannel(channel: string): boolean {
  return targetOfChannel(channel)?.kind === 'conversation';
}

function positiveIntOrUndefined(raw: string): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}
