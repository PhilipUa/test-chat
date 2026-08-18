/**
 * Error-handling helpers for the client, mirroring src/util/resilience.ts.
 *
 * Same reasoning: name the failure policy at the call site instead of writing another try/catch, and
 * never swallow a failure without a trace. The browser copy is separate rather than shared because
 * web/ has no build step — the server module is TypeScript and imports Node APIs.
 */

const THROTTLE_MS = 5_000;
const lastLoggedAt = new Map();

export function logThrottled(label, message) {
  const now = Date.now();
  if (now - (lastLoggedAt.get(label) ?? 0) < THROTTLE_MS) return;
  lastLoggedAt.set(label, now);
  console.warn(`[${label}] ${message}`);
}

const describe = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Awaits work for its side effect only, logging rather than hiding a failure.
 *
 * Replaces `.catch(() => {})`. On the client these are genuinely non-fatal — a failed read receipt
 * or a failed catch-up corrects itself on the next event or reload — but "non-fatal" is not the same
 * as "not worth knowing about" when someone reports the badge being wrong.
 */
export async function bestEffort(label, work) {
  try {
    await (typeof work === 'function' ? work() : work);
    return true;
  } catch (err) {
    logThrottled(label, describe(err));
    return false;
  }
}

/** JSON.parse that returns undefined instead of throwing, for anything off the network. */
export function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * The largest value in a set, or 0 when it's empty.
 *
 * `Math.max(0, ...set)` spreads the set as function arguments, which is a RangeError past roughly
 * 65k of them — so scrolling far enough back through a long conversation broke every read receipt
 * from that point on.
 */
export function maxOf(values) {
  let max = 0;
  for (const value of values) if (value > max) max = value;
  return max;
}

/**
 * How recent a conversation is, for the inbox ordering.
 *
 * `activityAt` is the key the server sorts by — the last message's timestamp, or the conversation's
 * own creation when it has none. Using the same key means a partially-loaded list stays consistent
 * with the pages that haven't been fetched yet. The fallbacks only matter for a payload from an older
 * server.
 */
const activityOf = (c) => new Date(c.activityAt ?? c.lastMessage?.createdAt ?? 0).getTime();

/**
 * Conversations most-recent-first, as a new array.
 *
 * The tie-break on id descending matches the server's, so conversations with no messages — which all
 * share their creation second — don't shuffle between renders or disagree with the next page.
 */
export function orderByActivity(conversations) {
  return [...conversations].sort((a, b) => activityOf(b) - activityOf(a) || b.id - a.id);
}

/**
 * Whether `msg` is newer than what this conversation already has on record.
 *
 * The send path and the broadcast both report the same message, in either order — or only one of them
 * does, when the socket is down. This makes recording it idempotent, and stops a delayed older message
 * from dragging a conversation backwards down the sidebar.
 */
export function isNewerMessage(conversation, msg) {
  if (msg.id === undefined) return true;
  return msg.id > (conversation.lastMessage?.id ?? 0);
}

/**
 * Folds a freshly fetched inbox page into what we already hold.
 *
 * A refetch can be *older* than the socket. catchUp() reloads the inbox on every reconnect and every
 * resync, and that request can already be in flight when a message arrives — so assigning the response
 * straight over state.conversations threw the newer information away: the sidebar jumped back to its
 * previous order and the preview reverted to the message before last. Same shape as the catchUp race in
 * the message pane: a fetch resolving late and clobbering something newer.
 *
 * The page decides *which* conversations exist and in what order — that's the server's job, and paging
 * depends on it. Merging only settles per-conversation freshness, and only for the fields the socket
 * also maintains. `unreadCount` is deliberately taken from the page even when it is lower: reading a
 * conversation lowers it, which is precisely when the server is right and our copy is stale.
 */
export function mergeConversations(existing, incoming) {
  const held = new Map(existing.map((c) => [c.id, c]));

  return incoming.map((fresh) => {
    const mine = held.get(fresh.id);
    if (!mine?.lastMessage || !isNewerMessage(fresh, mine.lastMessage)) return fresh;

    return {
      ...fresh,
      lastMessage: mine.lastMessage,
      activityAt: mine.activityAt ?? fresh.activityAt,
      // Monotonic within a conversation, so the higher of the two is the true count.
      messageCount: Math.max(fresh.messageCount ?? 0, mine.messageCount ?? 0),
    };
  });
}
