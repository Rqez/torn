// ==UserScript==
// @name         Torn Market Quality Watcher (3 pinned tabs)
// @namespace    tc-market-watch
// @version      4.0
// @description  Watches a single quality-sorted market category tab, auto-refreshing periodically, and notifies when a top-30 listing drops to/under $100k. Meant to run in 3 separate tabs, one per category.
// @match        https://www.torn.com/page.php?sid=ItemMarket*
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Tampermonkey's @match can't restrict by URL fragment (the #... part) —
  // match patterns only cover scheme://host/path. So @match above is
  // intentionally broad (any ItemMarket page), and this exact-hash check is
  // what actually enforces "only these 3 links". Anything else is a no-op.
  const TARGET_VIEWS = [
    { name: 'Primary',   hash: '#/market/view=category&categoryName=Primary&sortField=quality&sortOrder=DESC&priceTo=1000000' },
    { name: 'Secondary', hash: '#/market/view=category&categoryName=Secondary&sortField=quality&sortOrder=DESC&priceTo=1000000' },
    { name: 'Melee',     hash: '#/market/view=category&categoryName=Melee&sortField=quality&sortOrder=DESC&priceTo=1000000' },
  ];

  const CONFIG = {
    priceThreshold: 125_000,   // notify if a top-30 listing is at or below this
    topN: 30,
    loadWaitMs: 15_000,        // max time to wait for rows to render after (re)load
    scrollSettleMs: 1_200,     // wait after scrolling to let lazy-loaded rows appear
    refreshIntervalMinMs: 60_000,  // reload interval is randomised between these two
    refreshIntervalMaxMs: 90_000, // bounds, so the 3 tabs don't reload in lockstep
    realertCooldownMs: 15 * 60_000, // don't re-notify the same price again within this window

    // Verified against the OpenMarket userscript (greasyfork.org/scripts/571158),
    // which targets the same #item-market-root React tree.
    root: '#item-market-root',
    rowSelector: '[class*="itemTile___"]',
    priceSelector: '[class*="priceAndTotal___"] span',
  };

  const view = TARGET_VIEWS.find((v) => v.hash === location.hash);
  if (!view) {
    console.log('[TMW] Not one of the 3 watched category views — doing nothing.');
    return;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const seenKey = `tmw_seen_${view.name}`;

  function loadSeen() {
    const seen = GM_getValue(seenKey, {});
    const cutoff = Date.now() - CONFIG.realertCooldownMs;
    for (const [k, ts] of Object.entries(seen)) {
      if (ts < cutoff) delete seen[k];
    }
    return seen;
  }

  function notify(price, rank) {
    const seen = loadSeen();
    const key = String(price);
    if (seen[key]) return;
    seen[key] = Date.now();
    GM_setValue(seenKey, seen);

    GM_notification({
      title: `Torn Market: ${view.name} deal!`,
      text: `Rank #${rank} (top ${CONFIG.topN} by quality) · $${price.toLocaleString()}`,
      timeout: 20000,
      onclick: () => window.focus(),
    });
    console.log(`[TMW] ${view.name} ALERT: rank #${rank}, $${price.toLocaleString()}`);
  }

  function parsePrice(str) {
    const n = parseInt(String(str).replace(/[^0-9]/g, ''), 10);
    return Number.isNaN(n) ? null : n;
  }

  function scrapeTopListings() {
    const root = document.querySelector(CONFIG.root);
    if (!root) return [];
    const rows = Array.from(root.querySelectorAll(CONFIG.rowSelector)).slice(0, CONFIG.topN);
    const results = [];
    rows.forEach((row, i) => {
      const priceEl = row.querySelector(CONFIG.priceSelector);
      if (!priceEl) return;
      const price = parsePrice(priceEl.textContent);
      if (price == null) return;
      results.push({ rank: i + 1, price });
    });
    return results;
  }

  async function waitForRows() {
    const start = Date.now();
    while (Date.now() - start < CONFIG.loadWaitMs) {
      if (document.querySelector(CONFIG.root)?.querySelector(CONFIG.rowSelector)) return true;
      await sleep(300);
    }
    return false;
  }

  async function scanOnce() {
    const rendered = await waitForRows();
    if (!rendered) {
      console.warn(`[TMW] ${view.name}: rows never rendered — check CONFIG selectors, or the page failed to load.`);
      return;
    }

    // Force lazy-loaded rows to render so we actually see up to topN.
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(CONFIG.scrollSettleMs);
    window.scrollTo(0, 0);

    const listings = scrapeTopListings();
    if (listings.length === 0) {
      console.warn(`[TMW] ${view.name}: no rows matched. Check CONFIG selectors in the script.`);
      return;
    }

    listings.forEach((item) => {
      if (item.price <= CONFIG.priceThreshold) notify(item.price, item.rank);
    });

    console.log(`[TMW] ${view.name}: scanned ${listings.length} listings, cheapest $${Math.min(...listings.map((l) => l.price)).toLocaleString()}.`);
  }

  (async () => {
    await scanOnce();
    // The market list doesn't refetch on its own while the tab sits idle, so
    // a full reload is the reliable way to pick up new/changed listings.
    // Interval is randomised within the configured range so the 3 tabs don't
    // all reload on the same tick.
    const delay = CONFIG.refreshIntervalMinMs
      + Math.random() * (CONFIG.refreshIntervalMaxMs - CONFIG.refreshIntervalMinMs);
    setTimeout(() => location.reload(), delay);
  })();
})();
