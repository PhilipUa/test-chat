/** Wire format for everything that travels over the WebSocket and through Redis pub/sub. */

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

export type ConversationEvent = MessageEvent | TypingEvent | ReadEvent | PresenceEvent;

/** Envelope used on the Redis channel only — carries routing metadata the browser never sees. */
export interface FanoutEnvelope {
  event: ConversationEvent;
  /** Instance that published it. Useful when debugging a multi-instance setup. */
  origin: string;
  /**
   * Connection that caused it, if any. Lets us skip delivery back to the originating socket —
   * you should not see your own typing indicator.
   */
  originConnectionId?: string;
}

/** Written once, so the builder and the parser below can't drift apart. */
const CHANNEL_PREFIX = 'relay:conv:';

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
 * along (1 -> 6), so the rule belongs with the event definition instead.
 *
 * `message` is deliberately *not* self-suppressed: you do want your own message echoed back, since
 * that's what confirms it and replaces the optimistic bubble.
 */
const SUPPRESS_OWN: Partial<Record<ConversationEvent['type'], true>> = {
  typing: true,
  presence: true,
};

/** The subject of an event, when it has one — used to decide self-suppression. */
function subjectOf(event: ConversationEvent): number | undefined {
  return 'userId' in event ? event.userId : undefined;
}

export function shouldDeliver(event: ConversationEvent, toUserId: number | undefined): boolean {
  if (!SUPPRESS_OWN[event.type]) return true;
  return subjectOf(event) !== toUserId;
}

export const channelFor = (conversationId: number): string => `${CHANNEL_PREFIX}${conversationId}`;

export function conversationIdFromChannel(channel: string): number | undefined {
  const id = Number(channel.slice(CHANNEL_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : undefined;
}
