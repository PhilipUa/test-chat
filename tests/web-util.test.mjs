import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isNewerMessage, maxOf, mergeConversations, orderByActivity } from '../web/js/util.js';

/**
 * Unit tests for the browser helpers that are pure enough to run under node.
 *
 * web/ has no build step and these modules are plain ESM, so the ones with no DOM dependency can be
 * imported directly — which is worth doing for anything whose failure mode is a crash rather than a
 * wrong pixel.
 */

describe('maxOf', () => {
  it('returns the largest id in the set', () => {
    assert.equal(maxOf(new Set([3, 17, 9])), 17);
  });

  it('returns 0 for an empty set, so a read receipt is simply skipped', () => {
    assert.equal(maxOf(new Set()), 0);
  });

  it('handles more ids than Math.max accepts as arguments', () => {
    // markRead did `Math.max(0, ...[...state.rendered])`, which spreads the set as function
    // arguments. Past roughly 65k ids that is a RangeError, so scrolling far enough back through a
    // long conversation broke every read receipt from then on.
    const many = new Set(Array.from({ length: 200_000 }, (_, i) => i + 1));

    assert.equal(maxOf(many), 200_000);
  });
});

describe('orderByActivity', () => {
  const conv = (id, activityAt) => ({ id, activityAt });

  it('puts the most recent activity first', () => {
    const list = [
      conv(1, '2026-08-18T10:00:00.000Z'),
      conv(2, '2026-08-18T12:00:00.000Z'),
      conv(3, '2026-08-18T11:00:00.000Z'),
    ];

    assert.deepEqual(
      orderByActivity(list).map((c) => c.id),
      [2, 3, 1],
    );
  });

  it('breaks ties on id descending, the way the server does', () => {
    // Conversations with no messages share their creation second, so without a stable tie-break they
    // shuffle between renders and disagree with the next page the server sends.
    const same = '2026-08-18T10:00:00.000Z';
    const list = [conv(7, same), conv(21, same), conv(13, same)];

    assert.deepEqual(
      orderByActivity(list).map((c) => c.id),
      [21, 13, 7],
    );
  });

  it('does not mutate the list it was given', () => {
    const list = [conv(1, '2026-08-18T10:00:00.000Z'), conv(2, '2026-08-18T12:00:00.000Z')];

    orderByActivity(list);

    assert.deepEqual(
      list.map((c) => c.id),
      [1, 2],
    );
  });

  it('falls back to the last message when there is no activity timestamp', () => {
    const list = [
      { id: 1, lastMessage: { createdAt: '2026-08-18T10:00:00.000Z' } },
      { id: 2, lastMessage: { createdAt: '2026-08-18T12:00:00.000Z' } },
    ];

    assert.deepEqual(
      orderByActivity(list).map((c) => c.id),
      [2, 1],
    );
  });
});

describe('isNewerMessage', () => {
  const conv = (lastId) => (lastId === undefined ? {} : { lastMessage: { id: lastId } });

  it('accepts the first message a conversation has seen', () => {
    assert.equal(isNewerMessage(conv(), { id: 5 }), true);
  });

  it('accepts a message newer than the one on record', () => {
    assert.equal(isNewerMessage(conv(5), { id: 6 }), true);
  });

  it('rejects the message already on record', () => {
    // The send path and the broadcast both report the same message, in either order — recording it
    // twice would double the preview update and re-sort for nothing.
    assert.equal(isNewerMessage(conv(6), { id: 6 }), false);
  });

  it('rejects an older message arriving late', () => {
    // Otherwise a delayed broadcast drags a conversation backwards down the sidebar.
    assert.equal(isNewerMessage(conv(9), { id: 4 }), false);
  });
});

describe('mergeConversations', () => {
  const held = (id, lastId, activityAt, messageCount = 5) => ({
    id,
    activityAt,
    messageCount,
    lastMessage: { id: lastId, body: 'held', createdAt: activityAt },
  });

  it('takes the server page when it is at least as fresh', () => {
    const existing = [held(1, 10, '2026-08-18T10:00:00.000Z')];
    const incoming = [held(1, 11, '2026-08-18T11:00:00.000Z')];

    const merged = mergeConversations(existing, incoming);

    assert.equal(merged[0].lastMessage.id, 11);
    assert.equal(merged[0].activityAt, '2026-08-18T11:00:00.000Z');
  });

  it('keeps what we hold when the page is older than the socket told us', () => {
    // catchUp() refetches the inbox on every reconnect and resync, and that request can already be in
    // flight when a message arrives. Assigning the response straight over state.conversations threw the
    // newer information away, so the sidebar jumped back to its previous order and the preview reverted.
    const existing = [held(1, 12, '2026-08-18T12:00:00.000Z')];
    const incoming = [held(1, 11, '2026-08-18T11:00:00.000Z')];

    const merged = mergeConversations(existing, incoming);

    assert.equal(merged[0].lastMessage.id, 12);
    assert.equal(merged[0].activityAt, '2026-08-18T12:00:00.000Z');
  });

  it('follows the page for which conversations exist and in what order', () => {
    // The server decides membership and paging; merging is only about per-conversation freshness.
    const existing = [
      held(1, 12, '2026-08-18T12:00:00.000Z'),
      held(9, 3, '2026-08-18T09:00:00.000Z'),
    ];
    const incoming = [
      held(2, 5, '2026-08-18T10:00:00.000Z'),
      held(1, 11, '2026-08-18T11:00:00.000Z'),
    ];

    const merged = mergeConversations(existing, incoming);

    assert.deepEqual(
      merged.map((c) => c.id),
      [2, 1],
    );
  });

  it('does not let a stale page walk the message count backwards', () => {
    const existing = [held(1, 12, '2026-08-18T12:00:00.000Z', 6)];
    const incoming = [held(1, 11, '2026-08-18T11:00:00.000Z', 5)];

    assert.equal(mergeConversations(existing, incoming)[0].messageCount, 6);
  });

  it('takes the page’s unread count even when it is lower', () => {
    // Unread is not monotonic — reading a conversation lowers it, and that is exactly the case where
    // the server is right and our copy is stale.
    const existing = [{ ...held(1, 12, '2026-08-18T12:00:00.000Z'), unreadCount: 3 }];
    const incoming = [{ ...held(1, 11, '2026-08-18T11:00:00.000Z'), unreadCount: 0 }];

    assert.equal(mergeConversations(existing, incoming)[0].unreadCount, 0);
  });

  it('passes through a conversation we have never seen', () => {
    const merged = mergeConversations([], [held(7, 1, '2026-08-18T10:00:00.000Z')]);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 7);
  });
});
