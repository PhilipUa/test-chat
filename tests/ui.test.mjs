import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BASE, freshConversation, post, seedMessages, sleep, unique } from './helpers.mjs';

/**
 * Browser coverage for web/app.js.
 *
 * Written *before* splitting the frontend into modules (Tier 4 of spec/refactoring-plan.md): 778
 * lines of untested browser code doesn't earn a refactor until something can tell you the refactor
 * broke it. Everything here asserts behaviour a user can see, not internals, so it survives the
 * restructuring it exists to protect.
 *
 * These are the behaviours that were bugs at some point: XSS via a conversation title, the identity
 * switch not sticking across a reload, typing being invisible unless the conversation was open, and
 * the optimistic send duplicating when the broadcast arrived.
 */

let browser;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

/**
 * Waits until the app has finished booting.
 *
 * `#userSelect` is in the static HTML, so waiting for the *element* proves nothing — it matches
 * before loadUsers() has populated it, and reading its value then returns ''. Wait for the options.
 */
async function waitReady(page) {
  await page.waitForFunction(
    () => document.querySelectorAll('#userSelect option').length > 0,
  );
  await page.waitForSelector('#conversations li, #conversations .empty');
}

/**
 * Waits until the socket is connected.
 *
 * The app reports this itself in #connection, which is the observable signal to wait on. Without it,
 * a test can type before `subscribe` has been acknowledged — sendTyping() bails when the socket
 * isn't open, so the frame is never sent and the assertion times out for the wrong reason.
 */
async function waitLive(page) {
  await page.waitForFunction(
    () => document.getElementById('connection')?.textContent === 'live',
    undefined,
    { timeout: 10_000 },
  );
}

/** A fresh isolated browser context, so tabs don't share sessionStorage unless we want them to. */
async function openApp(userId, { context } = {}) {
  const ctx = context ?? (await browser.newContext());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`${BASE}/?userId=${userId}`);
  await waitReady(page);
  return { ctx, page, errors };
}

const openConversation = async (page, titleFragment) => {
  await page.locator('#conversations li', { hasText: titleFragment }).first().click();
  await page.waitForFunction(
    (t) => document.getElementById('title')?.textContent?.includes(t),
    titleFragment,
  );
};

describe('UI: identity', () => {
  it('switching user survives a reload, and keeps the URL in step', async () => {
    // This was a bug: the switch worked but the URL kept its original ?userId=, and initialUserId()
    // reads the URL before sessionStorage — so a reload silently reverted the choice.
    const { ctx, page } = await openApp(1);
    try {
      assert.equal(await page.locator('#userSelect').inputValue(), '1');

      await page.locator('#userSelect').selectOption('3');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('userId') === '3');

      await page.reload();
      await waitReady(page);
      assert.equal(
        await page.locator('#userSelect').inputValue(),
        '3',
        'the switch must survive a reload',
      );
    } finally {
      await ctx.close();
    }
  });

  it('two tabs can be two different users', async () => {
    // sessionStorage is per tab on purpose: with localStorage, switching in one tab changed every
    // other tab on its next reload, which makes the two-person features impossible to demo.
    const ctx = await browser.newContext();
    try {
      const a = await openApp(1, { context: ctx });
      const b = await openApp(2, { context: ctx });
      await b.page.reload();
      await waitReady(b.page);
      assert.equal(await a.page.locator('#userSelect').inputValue(), '1');
      assert.equal(await b.page.locator('#userSelect').inputValue(), '2');
    } finally {
      await ctx.close();
    }
  });
});

describe('UI: safety', () => {
  it('renders a conversation title as text, never as markup', async () => {
    // renderSidebar used innerHTML with a title straight from POST /api/conversations.
    const payload = '<img src=x onerror=window.__xss=1>';
    await post('/api/conversations', { title: payload, participantIds: [1, 2] });

    const { ctx, page } = await openApp(1);
    try {
      await page.waitForSelector('#conversations li');
      const executed = await page.evaluate(() => Boolean(window.__xss));
      assert.equal(executed, false, 'the payload must not execute');

      // And it should still be readable as literal text.
      const shown = await page
        .locator('#conversations li', { hasText: 'img src=x' })
        .first()
        .textContent();
      assert.ok(shown.includes(payload), 'the title should render as visible text');
      const imgs = await page.locator('#conversations img').count();
      assert.equal(imgs, 0, 'no element should have been created from the title');
    } finally {
      await ctx.close();
    }
  });
});

describe('UI: sending', () => {
  it('shows a sent message once, not twice', async () => {
    // The optimistic bubble is reconciled with the broadcast by clientId; getting that wrong shows
    // the message twice.
    const conv = await freshConversation([1, 2], unique('ui-send'));
    const { ctx, page } = await openApp(1);
    try {
      await waitLive(page);
      await openConversation(page, conv.title);
      const body = `hello ${Date.now()}`;
      await page.fill('#text', body);
      await page.press('#text', 'Enter');

      await page.waitForFunction(
        (b) => [...document.querySelectorAll('.msg')].some((m) => m.textContent.includes(b)),
        body,
      );
      await sleep(1200); // give the broadcast time to arrive and reconcile

      const count = await page.evaluate(
        (b) => [...document.querySelectorAll('.msg')].filter((m) => m.textContent.includes(b)).length,
        body,
      );
      assert.equal(count, 1, 'a sent message must appear exactly once');
      assert.equal(await page.locator('#text').inputValue(), '', 'composer should clear');
    } finally {
      await ctx.close();
    }
  });

  it('keeps the text and explains when rate limited', async () => {
    // A 429 must not lose what the user typed.
    const conv = await freshConversation([1, 2], unique('ui-429'));
    const { ctx, page } = await openApp(1);
    try {
      await openConversation(page, conv.title);
      // Burn the allowance from the server side, so the UI hits a 429 on its first attempt.
      for (let i = 0; i < 7; i++) {
        await post('/api/messages', {
          conversationId: conv.id, senderId: 1, body: `burn ${i}`, clientId: unique('burn'),
        });
      }
      const body = `throttled ${Date.now()}`;
      await page.fill('#text', body);
      await page.press('#text', 'Enter');

      await page.waitForFunction(() =>
        document.getElementById('notice')?.textContent?.includes('too fast'),
      );
      assert.equal(
        await page.locator('#text').inputValue(),
        body,
        'the message must be put back in the composer, not lost',
      );
    } finally {
      await ctx.close();
    }
  });
});

describe('UI: loading races', () => {
  it('keeps history above a message sent while the conversation is still loading', async () => {
    // openConversation clears the pane and then awaits the fetch. Sending inside that window used to
    // append the optimistic bubble first, so the history landed below it — wrong order until the next
    // reload.
    //
    // The window is a few milliseconds locally, so an ordinary click-then-type never opens it: the
    // first version of this test passed with the fix reverted, which makes it worthless. The history
    // fetch is delayed deliberately here so the race is guaranteed rather than hoped for.
    const conv = await freshConversation([1, 2, 3], unique('ui-race'));
    await seedMessages(conv.id, 3);

    const { ctx, page } = await openApp(1);
    try {
      await waitLive(page);

      // Hold the *history* GET for a second; leave the send POST alone.
      await page.route('**/api/messages?*', async (route) => {
        if (route.request().method() === 'GET') await sleep(1000);
        await route.continue();
      });

      await page.locator('#conversations li', { hasText: conv.title }).first().click();
      // Well inside the delayed fetch.
      await page.fill('#text', 'sent while loading');
      await page.press('#text', 'Enter');

      // Wait for the history to land on top of it.
      await page.waitForFunction(
        () => document.querySelectorAll('.msg').length >= 4,
        undefined,
        { timeout: 10_000 },
      );
      await sleep(1500);

      const bodies = await page.evaluate(() =>
        [...document.querySelectorAll('.msg .body')].map((n) => n.textContent),
      );
      assert.equal(
        bodies[bodies.length - 1],
        'sent while loading',
        `the new message must be last, got order: ${JSON.stringify(bodies)}`,
      );
      assert.equal(
        bodies.filter((b) => b === 'sent while loading').length,
        1,
        'and exactly once',
      );
    } finally {
      await ctx.close();
    }
  });

  it('ignores a superseded load when conversations are switched quickly', async () => {
    // The bodies have to be distinguishable per conversation, or the assertion can't tell whose
    // history got painted — the first version of this test used identical seed bodies for both and
    // therefore passed with the guard removed.
    const a = await freshConversation([1, 2, 3], unique('ui-switch-a'));
    const b = await freshConversation([1, 2, 3], unique('ui-switch-b'));
    const aMarker = `alpha-${Date.now()}`;
    const bMarker = `beta-${Date.now()}`;
    await post('/api/messages', {
      conversationId: a.id, senderId: 2, body: aMarker, clientId: unique('a'),
    });
    await post('/api/messages', {
      conversationId: b.id, senderId: 2, body: bMarker, clientId: unique('b'),
    });

    const { ctx, page } = await openApp(1);
    try {
      await waitLive(page);

      // Make the first open's fetch the slow one, so it resolves *after* the second and would paint
      // conversation a's history into conversation b's pane if nothing guarded against it.
      let firstGet = true;
      await page.route('**/api/messages?*', async (route) => {
        if (route.request().method() === 'GET' && firstGet) {
          firstGet = false;
          await sleep(1200);
        }
        await route.continue();
      });

      await page.locator('#conversations li', { hasText: a.title }).first().click();
      await page.locator('#conversations li', { hasText: b.title }).first().click();
      await sleep(2500);

      assert.match(await page.locator('#title').textContent(), new RegExp(b.title));
      const bodies = await page.evaluate(() =>
        [...document.querySelectorAll('.msg .body')].map((n) => n.textContent),
      );
      assert.ok(bodies.includes(bMarker), `expected b's message, got ${JSON.stringify(bodies)}`);
      assert.equal(
        bodies.includes(aMarker),
        false,
        `the superseded load painted conversation a into b: ${JSON.stringify(bodies)}`,
      );
    } finally {
      await ctx.close();
    }
  });
});

describe('UI: realtime', () => {
  it('moves a conversation to the top of the sidebar when a message arrives in it', async () => {
    // The server orders the inbox by last activity, but only at fetch time. A message arriving over the
    // socket updated the preview and the badge and left the row where it was, so the list drifted out
    // of order until the next reload — most visibly for the conversation you are *not* looking at,
    // which is exactly the one the ordering is there to surface.
    const first = await freshConversation([1, 2], unique('ui-order-first'));
    const second = await freshConversation([1, 2], unique('ui-order-second'));
    await post('/api/messages', {
      conversationId: first.id, senderId: 2, body: 'first activity', clientId: unique('f'),
    });
    await sleep(50);
    await post('/api/messages', {
      conversationId: second.id, senderId: 2, body: 'second activity', clientId: unique('s'),
    });

    const { ctx, page } = await openApp(1);
    try {
      await waitLive(page);

      const topTitle = () =>
        page.evaluate(
          () =>
            document.querySelector('#conversations li:not(.load-more) .conv-title')?.textContent ?? '',
        );

      // `second` had the most recent message, so the server put it on top.
      assert.match(await topTitle(), new RegExp(second.title), 'unexpected starting order');

      // Now `first` gets a newer message, delivered over the socket rather than by a refetch.
      await post('/api/messages', {
        conversationId: first.id, senderId: 2, body: 'newest of all', clientId: unique('n'),
      });

      await page.waitForFunction(
        (title) =>
          (
            document.querySelector('#conversations li:not(.load-more) .conv-title')?.textContent ?? ''
          ).includes(title),
        first.title,
        { timeout: 10_000 },
      );

      assert.match(await topTitle(), new RegExp(first.title));
    } finally {
      await ctx.close();
    }
  });

  it("shows another user's message live, without a reload", async () => {
    const conv = await freshConversation([1, 2], unique('ui-live'));
    const { ctx, page } = await openApp(1);
    try {
      await waitLive(page);
      await openConversation(page, conv.title);
      const body = `from bob ${Date.now()}`;
      await post('/api/messages', {
        conversationId: conv.id, senderId: 2, body, clientId: unique('live'),
      });
      await page.waitForFunction(
        (b) => [...document.querySelectorAll('.msg')].some((m) => m.textContent.includes(b)),
        body,
        { timeout: 8000 },
      );
    } finally {
      await ctx.close();
    }
  });

  it('shows typing in the sidebar for a conversation that is not open', async () => {
    // Typing used to be discarded unless you already had that conversation open, so you could not
    // tell someone was replying in another thread.
    const conv = await freshConversation([1, 2], unique('ui-typing'));
    const viewer = await openApp(1);
    const typist = await openApp(2);
    try {
      await waitLive(viewer.page);
      await waitLive(typist.page);

      // The viewer deliberately opens nothing.
      await openConversation(typist.page, conv.title);

      // Type like a person: several keystrokes. One synthetic event can land inside the client's
      // 2s typing throttle or before the subscribe ack, and then nothing is sent at all.
      for (let i = 0; i < 4; i++) {
        await typist.page.fill('#text', 'typing something'.slice(0, 6 + i * 3));
        await typist.page.dispatchEvent('#text', 'input');
        await sleep(250);
      }

      await viewer.page.waitForFunction(
        () => document.querySelector('.conv-preview.typing-preview')?.textContent?.includes('typing'),
        undefined,
        { timeout: 8000 },
      );
      assert.equal(
        await viewer.page.locator('#title').textContent(),
        'Pick a conversation',
        'the viewer had no conversation open — the sidebar is the only place this could show',
      );
    } finally {
      await viewer.ctx.close();
      await typist.ctx.close();
    }
  });

  it('shows an unread badge for a message in another conversation', async () => {
    const conv = await freshConversation([1, 2], unique('ui-unread'));
    const { ctx, page } = await openApp(1);
    try {
      await waitLive(page);
      await post('/api/messages', {
        conversationId: conv.id, senderId: 2, body: 'unread please', clientId: unique('u'),
      });
      await page.waitForFunction(
        (t) =>
          [...document.querySelectorAll('#conversations li')].some(
            (li) => li.textContent.includes(t) && li.querySelector('.badge'),
          ),
        conv.title,
        { timeout: 8000 },
      );
    } finally {
      await ctx.close();
    }
  });
});

describe('UI: search', () => {
  it('searches and renders results, then opens one', async () => {
    const conv = await freshConversation([1, 2], unique('ui-search'));
    const needle = `findme${Date.now()}`;
    await post('/api/messages', {
      conversationId: conv.id, senderId: 1, body: `a message about ${needle}`, clientId: unique('s'),
    });

    const { ctx, page } = await openApp(1);
    try {
      await page.fill('#search', needle);
      await page.press('#search', 'Enter');
      await page.waitForSelector('.result');

      const text = await page.locator('.result').first().textContent();
      assert.ok(text.includes(needle), 'the result should show the matching body');

      await page.locator('.result').first().click();
      await page.waitForFunction(
        (t) => document.getElementById('title')?.textContent?.includes(t),
        conv.title,
      );
    } finally {
      await ctx.close();
    }
  });

  it('says so when nothing matches', async () => {
    const { ctx, page } = await openApp(1);
    try {
      await page.fill('#search', `nomatch${Date.now()}`);
      await page.press('#search', 'Enter');
      await page.waitForFunction(() =>
        document.querySelector('#messages .empty')?.textContent?.includes('No messages matching'),
      );
    } finally {
      await ctx.close();
    }
  });
});

describe('UI: no page errors', () => {
  it('loads, opens a conversation and sends without a single uncaught error', async () => {
    const conv = await freshConversation([1, 2], unique('ui-clean'));
    const { ctx, page, errors } = await openApp(1);
    try {
      await openConversation(page, conv.title);
      await page.fill('#text', 'clean run');
      await page.press('#text', 'Enter');
      await sleep(1200);
      assert.deepEqual(errors, [], 'no uncaught page errors');
    } finally {
      await ctx.close();
    }
  });
});
