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

export const channelFor = (conversationId: number): string => `relay:conv:${conversationId}`;

export function conversationIdFromChannel(channel: string): number | undefined {
  const id = Number(channel.slice('relay:conv:'.length));
  return Number.isInteger(id) && id > 0 ? id : undefined;
}
