import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BASE, freshConversation, post, sleep, unique } from './helpers.mjs';

/**
 * Browser regressions for the code-review findings.
 *
 * Both of these are about what happens on the *unhappy* path — a reconnect landing mid-navigation,
 * and a fetch that fails — which is where the frontend was still trusting that nothing would
 * interleave.
 */

let browser;

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

async function openApp(userId) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?userId=${userId}`);
  await page.waitForFunction(() => document.querySelectorAll('#userSelect option').length > 0);
  await page.waitForSelector('#conversations li, #conversations .empty');
  return { ctx, page };
}

async function waitLive(page) {
  await page.waitForFunction(
    () => document.getElementById('connection')?.textContent === 'live',
    undefined,
    { timeout: 15_000 },
  );
}

const bodiesIn = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.msg .body')].map((n) => n.textContent));

describe('UI: catch-up after a reconnect', () => {
  it('does not paint the previous conversation into the one now open', async () => {
    // catchUp() captures the conversation id, then awaits a `since=` fetch that can walk several
    // pages, and appended straight to #messages without checking what is open now. openConversation
    // has a generation guard for exactly this race; catchUp had none, so a reconnect while the user
    // was navigating dropped the old conversation's history into the new one's pane.
    const a = await freshConversation([1, 2], unique('ui-catchup-a'));
    const b = await freshConversation([1, 2], unique('ui-catchup-b'));
    const bMarker = `beta-${Date.now()}`;
    const gapped = `gapped-${Date.now()}`;
    await post('/api/messages', {
      conversationId: a.id,
      senderId: 2,
      body: 'seed-a',
      clientId: unique('a'),
    });
    await post('/api/messages', {
      conversationId: b.id,
      senderId: 2,
      body: bMarker,
      clientId: unique('b'),
    });

    const { ctx, page } = await openApp(1);
    try {
      await waitLive(page);
      await page.locator('#conversations li', { hasText: a.title }).first().click();
      await page.waitForFunction(() => document.querySelectorAll('.msg').length > 0, undefined, {
        timeout: 10_000,
      });

      // Hold the catch-up fetch open long enough to switch conversations underneath it.
      let sinceRequests = 0;
      await page.route('**/api/messages?*', async (route) => {
        const url = route.request().url();
        if (route.request().method() === 'GET' && url.includes('since=')) {
          sinceRequests += 1;
          await sleep(2000);
        }
        await route.continue();
      });

      // Drop the socket, then create the gap it will have to catch up on. Importing the state module
      // by URL gets the same module instance the app is using — ESM caches per resolved specifier.
      await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        state.ws?.close();
      });
      await post('/api/messages', {
        conversationId: a.id,
        senderId: 2,
        body: gapped,
        clientId: unique('gap'),
      });

      // Wait for the reconnect to start its catch-up, then navigate away mid-flight.
      await page.waitForFunction(() => true);
      const deadline = Date.now() + 15_000;
      while (sinceRequests === 0 && Date.now() < deadline) await sleep(100);
      assert.ok(sinceRequests > 0, 'the reconnect never issued a catch-up fetch');

      await page.locator('#conversations li', { hasText: b.title }).first().click();
      await sleep(3500);

      assert.match(await page.locator('#title').textContent(), new RegExp(b.title));
      const bodies = await bodiesIn(page);
      assert.equal(
        bodies.includes(gapped),
        false,
        `catch-up painted conversation a into b: ${JSON.stringify(bodies)}`,
      );
      assert.ok(bodies.includes(bMarker), `expected b's message, got ${JSON.stringify(bodies)}`);
    } finally {
      await ctx.close();
    }
  });
});

describe('UI: the paged inbox', () => {
  it('offers the next page rather than quietly truncating the list', async () => {
    // The inbox is bounded now, so the sidebar has to admit there is more. A silently short list is
    // worse than the unbounded query it replaced: it reads as "these are all your conversations".
    await freshConversation([1, 2], unique('ui-paged'));

    const { ctx, page } = await openApp(1);
    try {
      await page.waitForSelector('#loadMoreConversations', { timeout: 15_000 });
      const rows = () => page.locator('#conversations li:not(.load-more)').count();
      const firstPage = await rows();
      assert.ok(firstPage > 0, 'the first page should have rendered');

      await page.click('#loadMoreConversations');
      await page.waitForFunction(
        (before) => document.querySelectorAll('#conversations li:not(.load-more)').length > before,
        firstPage,
        { timeout: 15_000 },
      );

      assert.ok((await rows()) > firstPage, 'clicking load more should append the next page');
    } finally {
      await ctx.close();
    }
  });
});

describe('UI: a conversation that fails to open', () => {
  it('says so instead of leaving a blank pane', async () => {
    // openConversation clears the pane before awaiting its fetch, and both call sites discarded the
    // promise. A failure left an empty message area, a title claiming the conversation was open, and
    // nothing but an unhandled rejection in the console.
    const conv = await freshConversation([1, 2], unique('ui-openfail'));
    await post('/api/messages', {
      conversationId: conv.id,
      senderId: 2,
      body: 'hello',
      clientId: unique('of'),
    });

    const { ctx, page } = await openApp(1);
    try {
      await waitLive(page);

      await page.route('**/api/messages?*', async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'history unavailable' }),
          });
          return;
        }
        await route.continue();
      });

      await page.locator('#conversations li', { hasText: conv.title }).first().click();

      await page.waitForFunction(
        () => (document.getElementById('notice')?.textContent ?? '').length > 0,
        undefined,
        { timeout: 10_000 },
      );
      const message = await page.locator('#notice').textContent();
      assert.match(message, /could not open/i, `unhelpful notice: ${message}`);
    } finally {
      await ctx.close();
    }
  });
});
