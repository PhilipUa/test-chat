import { config } from '../config.ts';
import { redis } from '../db/redis.ts';
import { channelFor, shouldDeliver, type ConversationEvent, type FanoutEnvelope } from './events.ts';
import * as registry from './registry.ts';
import { bestEffort } from '../util/resilience.ts';

/**
 * Fan-out: getting an event to every subscriber of a conversation, on any instance.
 *
 * The original hub kept its client set in process memory, so a broadcast only reached sockets on the
 * process that handled the POST — invisible with one instance, silently broken with three
 * (2 of 6 clients received a message). Everything now goes through Redis pub/sub.
 *
 * Local delivery goes through Redis *too*. One delivery path rather than a local path and a remote
 * path that can drift, and exactly-once per socket by construction — a local send plus a Redis echo
 * would deliver twice.
 */

export async function publish(
  conversationId: number,
  event: ConversationEvent,
  originConnectionId?: string,
): Promise<void> {
  const envelope: FanoutEnvelope = { event, origin: config.instanceId, originConnectionId };

  const published = await bestEffort('ws:publish', () =>
    redis.publish(channelFor(conversationId), JSON.stringify(envelope)),
  );

  // Degrade to local-only rather than dropping the event: single-instance behaviour beats no
  // realtime at all.
  if (!published) deliverLocally(conversationId, envelope);
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
  if (!events.length) return;

  const envelopes = events.map(({ conversationId, event }) => ({
    conversationId,
    envelope: { event, origin: config.instanceId, originConnectionId } satisfies FanoutEnvelope,
  }));

  const published = await bestEffort('ws:publish-each', async () => {
    const pipeline = redis.pipeline();
    for (const { conversationId, envelope } of envelopes) {
      pipeline.publish(channelFor(conversationId), JSON.stringify(envelope));
    }
    const results = await pipeline.exec();
    // A pipeline resolves even when individual commands failed, so check them: a partial failure has
    // to degrade to local delivery rather than silently dropping events.
    if (!results || results.some(([err]) => err)) throw new Error('one or more publishes failed');
  });

  if (!published) {
    for (const { conversationId, envelope } of envelopes) deliverLocally(conversationId, envelope);
  }
}

/**
 * Delivers an envelope to this instance's matching sockets. Called from the Redis subscriber, so it
 * handles both locally-published and remote events identically.
 */
export function deliverLocally(conversationId: number, envelope: FanoutEnvelope): void {
  const data = JSON.stringify(envelope.event);
  registry.sendRaw(data, (client) => {
    if (!client.subs.has(conversationId)) return false;
    // The originating socket never receives its own event back.
    if (envelope.originConnectionId && envelope.originConnectionId === client.id) return false;
    return shouldDeliver(envelope.event, client.userId);
  });
}
