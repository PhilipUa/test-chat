import { config } from '../config.ts';
import { redis } from '../db/redis.ts';
import {
  channelFor,
  shouldDeliver,
  targetOfChannel,
  userChannelFor,
  type ChannelTarget,
  type ConversationEvent,
  type FanoutEnvelope,
  type RealtimeEvent,
  type UserEvent,
} from './events.ts';
import * as registry from './registry.ts';
import { attachConversation } from './subscriptions.ts';
import { bestEffort } from '../util/resilience.ts';

/**
 * Fan-out: getting an event to every subscriber, on any instance.
 *
 * The original hub kept its client set in process memory, so a broadcast only reached sockets on the
 * process that handled the POST — invisible with one instance, silently broken with three
 * (2 of 6 clients received a message). Everything now goes through Redis pub/sub.
 *
 * Local delivery goes through Redis *too*. One delivery path rather than a local path and a remote
 * path that can drift, and exactly-once per socket by construction — a local send plus a Redis echo
 * would deliver twice.
 */

/** One channel to publish on, with the envelope to put on it. */
interface Publication {
  channel: string;
  envelope: FanoutEnvelope;
}

const wrap = (event: RealtimeEvent, originConnectionId?: string): FanoutEnvelope => ({
  event,
  origin: config.instanceId,
  originConnectionId,
});

export async function publish(
  conversationId: number,
  event: ConversationEvent,
  originConnectionId?: string,
): Promise<void> {
  await publishAll('ws:publish', [
    { channel: channelFor(conversationId), envelope: wrap(event, originConnectionId) },
  ]);
}

/**
 * Publishes one event per conversation in a single Redis pipeline.
 *
 * Presence announces to every conversation a user is in, and doing that as one awaited round trip
 * each cost ~95ms for a user in 878 conversations — with the presence snapshot queued behind it, so
 * the socket wasn't usable until it finished. One pipeline is one round trip.
 */
export async function publishEach(
  events: Array<{ conversationId: number; event: ConversationEvent }>,
  originConnectionId?: string,
): Promise<void> {
  await publishAll(
    'ws:publish-each',
    events.map(({ conversationId, event }) => ({
      channel: channelFor(conversationId),
      envelope: wrap(event, originConnectionId),
    })),
  );
}

/**
 * Publishes one event per user, on each recipient's own channel.
 *
 * The route for anything a recipient could not already be subscribed to — a conversation they have
 * just been added to being the case that needs it, since there is no conversation channel they
 * could be holding for a conversation that did not exist a moment ago. One event per recipient
 * rather than one shared event, because an inbox row is a per-user view: who the *other*
 * participants are, and what is unread, differ for each of them.
 */
export async function publishToUsers(
  events: Array<{ userId: number; event: UserEvent }>,
): Promise<void> {
  await publishAll(
    'ws:publish-to-users',
    events.map(({ userId, event }) => ({ channel: userChannelFor(userId), envelope: wrap(event) })),
  );
}

/**
 * The one publish path: a single round trip, whatever the shape of the caller.
 *
 * Degrades to local-only delivery rather than dropping the events — single-instance behaviour beats
 * no realtime at all — and reconstructs the target from the channel name to do it, so the degraded
 * path routes identically to the Redis one.
 */
async function publishAll(label: string, publications: Publication[]): Promise<void> {
  if (!publications.length) return;

  const published = await bestEffort(label, async () => {
    if (publications.length === 1) {
      const [only] = publications;
      return redis.publish(only.channel, JSON.stringify(only.envelope));
    }
    const pipeline = redis.pipeline();
    for (const { channel, envelope } of publications) {
      pipeline.publish(channel, JSON.stringify(envelope));
    }
    const results = await pipeline.exec();
    // A pipeline resolves even when individual commands failed, so check them: a partial failure has
    // to degrade to local delivery rather than silently dropping events.
    if (!results || results.some(([err]) => err)) throw new Error('one or more publishes failed');
    return results.length;
  });

  if (published) return;
  for (const { channel, envelope } of publications) {
    const target = targetOfChannel(channel);
    if (target) deliverLocally(target, envelope);
  }
}

/**
 * Delivers an envelope to this instance's matching sockets. Called from the Redis subscriber, so it
 * handles both locally-published and remote events identically.
 */
export function deliverLocally(target: ChannelTarget, envelope: FanoutEnvelope): void {
  if (target.kind === 'user') {
    deliverToUser(target.userId, envelope);
    return;
  }

  const { conversationId } = target;
  send(envelope, (client) => client.subs.has(conversationId));
}

/**
 * Delivers to every socket signed in as `userId`.
 *
 * Being *told* about a conversation also subscribes the socket to it. Without that the announcement
 * lands but the conversation itself stays silent until the browser gets round to sending a fresh
 * `subscribe` frame, and anything published in that gap is gone — Redis pub/sub is at-most-once.
 * The authorization `handleSubscribe` would do isn't skipped so much as already done: this event
 * only reached this user's channel because the write that produced it put them in the conversation.
 */
function deliverToUser(userId: number, envelope: FanoutEnvelope): void {
  if (envelope.event.type === 'conversation') {
    const { id } = envelope.event.conversation;
    for (const client of registry.openConnectionsOf(userId)) attachConversation(client, id);
  }
  send(envelope, (client) => client.userId === userId);
}

/** Serialise once, then hand it to every socket the envelope is addressed to. */
function send(envelope: FanoutEnvelope, addressed: (client: registry.Client) => boolean): void {
  const data = JSON.stringify(envelope.event);
  registry.sendRaw(data, (client) => {
    if (!addressed(client)) return false;
    // The originating socket never receives its own event back.
    if (envelope.originConnectionId && envelope.originConnectionId === client.id) return false;
    return shouldDeliver(envelope.event, client.userId);
  });
}
