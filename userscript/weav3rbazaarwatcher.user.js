// ==UserScript==
// @name         Weav3r Item Watcher
// @namespace    weav3r-item-watch
// @version      3.4
// @description  Background-polls weav3r.dev item pages for buy-mode listings and alerts (desktop notification + optional Discord webhook + optional auto-opened tab that highlights the item on the seller's bazaar page) when the cheapest listing drops below a per-item threshold. Also has a "Check all" button that scans every tradeable item between $100k and $15m market value (via the Torn API) for bazaar listings 20% or more below market price, a $100k+ per-unit gap to a trader's buy price, or a profitable bulk flip — a "Check Flushies" button that scans every Plushie/Flower (above $1k market value) for any bazaar at least 1% below market — and an optional background auto-scanner for Plushies/Flowers that alerts (and can auto-open tabs) on listings at least 2% below market with more than 25 units available. Floating panel (bottom-left) lets you add/edit/remove watched item IDs and thresholds.
// @match        https://weav3r.dev/*
// @match        https://www.torn.com/bazaar.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @downloadURL  https://github.com/Rqez/torn/blob/main/userscript/weav3rbazaarwatcher.user.js
// @updateURL    https://github.com/Rqez/torn/blob/main/userscript/weav3rbazaarwatcher.user.js
// @connect      weav3r.dev
// @connect      api.torn.com
// @connect      discord.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════
  //  CONFIG
  // ════════════════════════════════════════════════════════════

  const CONFIG = {
    defaultPollIntervalSec: 1,
    realertCooldownMs: 15 * 60_000, // don't re-notify the same item again within this window while it stays cheap
    lockTtlMultiplier: 2,           // a leader that's gone quiet this long (x poll interval) is assumed dead
    checkAllDiscountFactor: 0.8,    // "check all" flags listings at/below 80% of market value (20% under)
    checkAllMinMarketValue: 100_000, // skip items cheaper than this — not worth the scan time
    checkAllMaxMarketValue: 15_000_000, // skip items pricier than this
    checkAllBatchSize: 5,           // items fetched concurrently per batch during a "check all" scan
    checkAllBatchPauseMs: 500,      // gap between batches — a full scan is hundreds of items, pace it gently
    flipMinPriceGap: 100_000,       // ping if a trader's buy price beats the cheapest sell by at least this much
    flipMinTotalProfit: 100_000,    // ping if flipping the sell listing's full quantity nets at least this much
    flipMinProfitRatio: 100_000 / 4_000_000, // "100k profit for every 4mil spent" — minimum 2.5% margin
    flipCheckPaceMs: 2000,          // gap between individual trader-search requests — weav3r rate-limits this
                                     // endpoint hard ("Too many deal searches"), far stricter than the listings one
    flipCheckBackoffMs: 60_000,     // how long to pause entirely after a 429 before resuming trader searches
    flushiesDiscountFactor: 0.99,   // "check flushies" flags listings at/below 99% of market value (1% under)
    flushiesMinMarketValue: 1_000,  // skip plushies/flowers cheaper than this
    flushiesAutoDiscountFactor: 0.98, // auto-scan trigger: at/below 98% of market (2% under) — stricter than the
                                     // manual "Check Flushies" button's 1%, since this one can open tabs on its own
    flushiesAutoMinQuantity: 25,    // ...and only when more than this many units are available in one listing
    flushiesAutoScanIntervalMs: 5_000, // how often the background auto-scan re-checks all plushies/flowers
  };

  const DEFAULT_WATCHLIST = [
    { id: 206, name: 'Xanax', threshold: 780_000 },
    { id: 366, name: 'Erotic DVD', threshold: 4_200_000 },
  ];

  const LS = {
    watchlist: 'w3b_watchlist',
    pollIntervalSec: 'w3b_poll_interval_sec',
    running: 'w3b_running',
    lock: 'w3b_lock',
    seenAlerts: 'w3b_seen_alerts',
    panelPos: 'w3b_panel_pos',
    discordWebhook: 'w3b_discord_webhook',
    autoOpenTab: 'w3b_auto_open_tab',
    tornApiKey: 'w3b_torn_api_key',
    flushiesAutoScan: 'w3b_flushies_auto_scan',
  };

  const TAB_ID = Math.random().toString(36).slice(2, 10);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  // ════════════════════════════════════════════════════════════
  //  WATCHLIST STORAGE
  // ════════════════════════════════════════════════════════════

  function getWatchlist() {
    return GM_getValue(LS.watchlist, DEFAULT_WATCHLIST);
  }

  function saveWatchlist(list) {
    GM_setValue(LS.watchlist, list);
  }

  function upsertItem(id, name, threshold) {
    const list = getWatchlist();
    const existing = list.find((i) => i.id === id);
    if (existing) {
      existing.threshold = threshold;
      if (name) existing.name = name;
    } else {
      list.push({ id, name: name || `Item ${id}`, threshold });
    }
    saveWatchlist(list);
    return list;
  }

  function removeItem(id) {
    const list = getWatchlist().filter((i) => i.id !== id);
    saveWatchlist(list);
    return list;
  }

  function getPollIntervalSec() {
    return GM_getValue(LS.pollIntervalSec, CONFIG.defaultPollIntervalSec);
  }

  function getDiscordWebhook() {
    return GM_getValue(LS.discordWebhook, '');
  }

  function saveDiscordWebhook(url) {
    GM_setValue(LS.discordWebhook, url.trim());
  }

  function getAutoOpenTab() {
    return GM_getValue(LS.autoOpenTab, false);
  }

  function getTornApiKey() {
    return GM_getValue(LS.tornApiKey, '');
  }

  function saveTornApiKey(key) {
    GM_setValue(LS.tornApiKey, key.trim());
  }

  function getFlushiesAutoScan() {
    return GM_getValue(LS.flushiesAutoScan, false);
  }

  // ════════════════════════════════════════════════════════════
  //  FETCH + PARSE
  // ════════════════════════════════════════════════════════════

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (r) => resolve(r),
        onerror: () => reject(new Error('network_error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  // Plain same-origin fetch, for weav3r.dev URLs only. GM_xmlhttpRequest is dispatched
  // through the extension's own context, and weav3r's Cloudflare rules 403 that for
  // every /api/ route we've tried (confirmed twice now) even though the identical URL
  // works fine as a normal page fetch. This script's polling/check-all logic only ever
  // runs while the current tab is actually on weav3r.dev (see INIT), so a real fetch()
  // here is genuinely same-origin — no CORS issue, and it goes through the browser's
  // normal fetch path instead of the extension's, which is what Cloudflare seems to be
  // keying off. Not a substitute for gmGet() cross-origin (Discord, Torn's API).
  async function pageGet(url) {
    const res = await fetch(url);
    return { status: res.status, responseText: await res.text() };
  }

  // weav3r's dedicated JSON listings API (/api/item/{id}/listings) is ~50x lighter
  // than this full page, but Cloudflare returns 403 to it specifically when called via
  // GM_xmlhttpRequest (it's presumably fingerprinting the request as non-browser —
  // confirmed by testing: a plain fetch() from weav3r.dev's own page JS gets 200, the
  // same URL via GM_xmlhttpRequest gets 403). The full item page isn't gated the same
  // way, so that's what we're stuck fetching.
  //
  // weav3r embeds the raw listings as JSON alongside the rendered table
  // (inside the page's RSC payload, escaped as \"listings\":[...]). Reading
  // that directly — rather than scraping table rows — sidesteps sponsored
  // rows (marked "sponsored":true, always shown first regardless of price)
  // and any future reordering/markup changes to the visible table.
  async function fetchWeav3rListings(id) {
    const url = `https://weav3r.dev/item/${id}?mode=buy&tab=all&timeframe=7d`;
    const res = await gmGet(url);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}`);
    }
    const html = res.responseText;

    let name = null;
    const titleMatch = html.match(/<title>TornW3B \| ([^<]+)<\/title>/);
    if (titleMatch) name = titleMatch[1];

    const unescaped = html.replace(/\\"/g, '"');
    const listingsMatch = unescaped.match(/"listings":(\[[^\]]*\])/);
    if (!listingsMatch) {
      return { name, listings: [] };
    }

    let rawListings;
    try {
      rawListings = JSON.parse(listingsMatch[1]);
    } catch {
      return { name, listings: [] };
    }

    const listings = rawListings
      .filter((l) => !l.sponsored && Number.isFinite(l.price))
      .sort((a, b) => a.price - b.price)
      .map((l) => ({
        price: l.price,
        quantity: Number.isFinite(l.quantity) ? l.quantity : 0,
        seller: l.playerName ? `${l.playerName} [${l.playerId}]` : null,
        sellerUrl: l.playerId ? `https://www.torn.com/bazaar.php?userId=${l.playerId}` : null,
      }));

    return { name, listings };
  }

  // Traders with an active pricelist offering to BUY this item — the flip side of the
  // listings above. This is the mode=sell tab's data, but that tab only populates via a
  // client-side call to this endpoint; a direct page fetch of ?mode=sell never includes
  // it server-rendered, unlike the buy-side listings. Response shape confirmed directly:
  // {"deals":[{playerId, playerName, price, rating:{...}, pricelistId, lastTrade,
  // lastAction}]}. Uses pageGet (plain same-origin fetch), not gmGet — this /api/ route
  // 403'd unconditionally via GM_xmlhttpRequest, confirmed fixed by switching to a plain
  // fetch(). But it has its own much stricter rate limit at the application level
  // ("Too many deal searches. Please slow down.", confirmed live) — callers must pace
  // these requests far more gently than the listings endpoint; see checkAll's flip phase.
  async function fetchWeav3rTraders(id) {
    const url = `https://weav3r.dev/api/search-deals/find?id=${id}&type=item`;
    const res = await pageGet(url);
    if (res.status === 429) {
      throw new Error('rate_limited');
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}`);
    }

    let data;
    try {
      data = JSON.parse(res.responseText);
    } catch {
      throw new Error('bad_json');
    }
    const deals = Array.isArray(data.deals) ? data.deals : [];

    const traders = deals
      .filter((d) => Number.isFinite(d.price))
      .sort((a, b) => b.price - a.price) // highest bidder first
      .map((d) => ({
        price: d.price,
        seller: d.playerName ? `${d.playerName} [${d.playerId}]` : null,
        sellerUrl: d.playerId ? `https://www.torn.com/bazaar.php?userId=${d.playerId}` : null,
      }));

    return { traders };
  }

  // Torn's own official API — the only place a "market price (and category) for every
  // item" list exists (weav3r only gives per-item bazaar listings, not a catalogue).
  // Cached in memory for the page session since the item catalogue barely changes and
  // there's no reason to re-fetch it on every scan. Returns the full catalogue
  // unfiltered by value — each scan (check-all, check-flushies) applies its own filter
  // on top, so they can share this one fetch instead of each needing their own.
  let itemsCatalogueCache = null;
  async function fetchAllItemsCatalog() {
    if (itemsCatalogueCache) return itemsCatalogueCache;
    const key = getTornApiKey();
    if (!key) throw new Error('no_api_key');

    const res = await gmGet(`https://api.torn.com/torn/?selections=items&key=${encodeURIComponent(key)}`);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}`);
    }
    let data;
    try {
      data = JSON.parse(res.responseText);
    } catch {
      throw new Error('bad_json');
    }
    if (data.error) {
      throw new Error(`Torn API: ${data.error.error || data.error.code}`);
    }

    const catalogue = Object.entries(data.items || {})
      .map(([id, info]) => ({ id: Number(id), name: info.name, type: info.type, marketValue: info.market_value }))
      .filter((i) => Number.isFinite(i.marketValue) && i.marketValue > 0);

    itemsCatalogueCache = catalogue;
    return catalogue;
  }

  // ════════════════════════════════════════════════════════════
  //  ALERTS
  // ════════════════════════════════════════════════════════════

  function loadSeenAlerts() {
    const seen = GM_getValue(LS.seenAlerts, {});
    const cutoff = Date.now() - CONFIG.realertCooldownMs;
    for (const [k, ts] of Object.entries(seen)) {
      if (ts < cutoff) delete seen[k];
    }
    return seen;
  }

  // Tracks bazaar tabs opened via the auto-open toggle, keyed by seller URL, so a
  // seller with more than one watched item cheap at once doesn't get a tab each.
  const openBazaarTabs = new Map();

  // Seller bazaar links get a w3b_search param naming the item, so the bazaar-page
  // half of this script (see BAZAAR HIGHLIGHT below) knows what to scroll to and
  // highlight the moment the tab opens.
  function buildAlertLink(item, sellerUrl) {
    if (!sellerUrl) {
      return `https://weav3r.dev/item/${item.id}?mode=buy&tab=all&timeframe=7d`;
    }
    const sep = sellerUrl.includes('?') ? '&' : '?';
    return `${sellerUrl}${sep}w3b_search=${encodeURIComponent(item.name)}`;
  }

  // listing: the sell listing this alert is about (its price/seller drive the dedup key
  // and the opened link either way).
  // item: a watchlist entry ({id, name, threshold}), a "check all" market-value context
  // ({id, name, marketValue}), or a flip-check context ({id, name, note}) — whichever
  // field is set decides the alert's wording; `note`, if present, wins outright.
  // opts.autoOpen (default true) lets a caller suppress the auto-open-tab toggle for
  // this specific alert, without touching the toggle itself — "check all" uses this so
  // a bulk scan can't pop dozens of tabs.
  // opts.dedupTag distinguishes multiple *kinds* of alert that could otherwise fire for
  // the exact same listing (e.g. "below market" and "profitable flip" at once) — without
  // it they'd share a dedup key and the second would be silently swallowed.
  function notify(item, listing, opts = {}) {
    const { autoOpen = true, dedupTag = '' } = opts;
    const seen = loadSeenAlerts();
    const key = `${item.id}-${listing.sellerUrl || 'x'}-${listing.price}${dedupTag ? '-' + dedupTag : ''}`;
    if (seen[key]) return;
    seen[key] = Date.now();
    GM_setValue(LS.seenAlerts, seen);

    const link = buildAlertLink(item, listing.sellerUrl);
    const belowText = item.note
      ? item.note
      : item.marketValue
      ? `${Math.round((1 - listing.price / item.marketValue) * 100)}% below market $${item.marketValue.toLocaleString()}`
      : `below $${item.threshold.toLocaleString()}`;

    GM_notification({
      title: `Weav3r: ${item.name} deal!`,
      text: `$${listing.price.toLocaleString()} ×${listing.quantity} (${belowText})${listing.seller ? ' — ' + listing.seller : ''}`,
      timeout: 25000,
      onclick: () => {
        window.focus();
        window.open(link, '_blank');
      },
    });
    if (autoOpen && getAutoOpenTab()) {
      // window.open() from a background poll isn't a user gesture and gets popup-blocked;
      // GM_openInTab is the extension-privileged equivalent of clicking the notification.
      if (listing.sellerUrl) {
        const existing = openBazaarTabs.get(listing.sellerUrl);
        if (!existing || existing.closed) {
          const handle = GM_openInTab(link, { active: true, insert: true, setParent: true });
          handle.onclose = () => openBazaarTabs.delete(listing.sellerUrl);
          openBazaarTabs.set(listing.sellerUrl, handle);
        }
      } else {
        GM_openInTab(link, { active: true, insert: true, setParent: true });
      }
    }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch {}
    sendDiscordAlert(item, listing, belowText);
    console.log(`[W3B] ALERT: ${item.name} (${item.id}) $${listing.price.toLocaleString()} (${belowText})`);
  }

  function sendDiscordAlert(item, listing, belowText) {
    const webhook = getDiscordWebhook();
    if (!webhook) return;
    const payload = {
      embeds: [{
        title: `${item.name} deal!`,
        description: `$${listing.price.toLocaleString()} ×${listing.quantity} (${belowText})${listing.seller ? `\nSeller: ${listing.seller}` : ''}`,
        url: buildAlertLink(item, listing.sellerUrl),
        color: 0x3ddc84,
        timestamp: new Date().toISOString(),
      }],
    };
    GM_xmlhttpRequest({
      method: 'POST',
      url: webhook,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(payload),
      onerror: () => console.warn('[W3B] Discord webhook failed to send (network error)'),
      onload: (r) => {
        if (r.status < 200 || r.status >= 300) {
          console.warn(`[W3B] Discord webhook failed to send (HTTP ${r.status})`);
        }
      },
    });
  }

  // ════════════════════════════════════════════════════════════
  //  BAZAAR HIGHLIGHT — runs on the seller's Torn bazaar page when opened from an alert
  // ════════════════════════════════════════════════════════════

  function highlightSearchTarget() {
    const term = new URLSearchParams(location.search).get('w3b_search');
    if (!term) return;
    const needle = term.toLowerCase();

    function tryHighlight() {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const tag = node.parentElement && node.parentElement.tagName;
          return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT'
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        const idx = node.nodeValue.toLowerCase().indexOf(needle);
        if (idx === -1) continue;
        try {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + needle.length);
          const mark = document.createElement('mark');
          mark.style.cssText = 'background:#ffe066;color:#111;border-radius:2px;padding:0 2px;';
          range.surroundContents(mark);
          mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
          mark.animate(
            [{ backgroundColor: '#ff9800' }, { backgroundColor: '#ffe066' }],
            { duration: 600, iterations: 6 }
          );
        } catch {
          node.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return true;
      }
      return false;
    }

    if (tryHighlight()) return;

    // the bazaar listing can still be loading in — keep trying for a few seconds
    let attempts = 0;
    const iv = setInterval(() => {
      attempts++;
      if (tryHighlight() || attempts >= 25) clearInterval(iv);
    }, 400);
  }

  // ════════════════════════════════════════════════════════════
  //  LEADER LOCK — avoid duplicate polling/alerts across multiple open tabs
  // ════════════════════════════════════════════════════════════

  function claimLock() {
    const lock = GM_getValue(LS.lock, null);
    const now = Date.now();
    const ttl = getPollIntervalSec() * 1000 * CONFIG.lockTtlMultiplier;
    if (lock && lock.owner !== TAB_ID && now - lock.ts < ttl) return false;
    GM_setValue(LS.lock, { owner: TAB_ID, ts: now });
    return true;
  }

  function refreshLock() {
    GM_setValue(LS.lock, { owner: TAB_ID, ts: Date.now() });
  }

  // ════════════════════════════════════════════════════════════
  //  PANEL UI
  // ════════════════════════════════════════════════════════════

  let statusById = {}; // id -> { price, seller, error, checkedAt }

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'style') {
          if (typeof v === 'string') e.style.cssText += v;
          else Object.assign(e.style, v);
        } else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function buildPanel() {
    const panel = el('div', {
      id: 'w3b-panel',
      style: {
        position: 'fixed', zIndex: 999999, width: '340px',
        background: '#1b1f27', color: '#e8e8e8', border: '1px solid #3a3f4b',
        borderRadius: '8px', font: '12px/1.4 system-ui, sans-serif',
        boxShadow: '0 4px 18px rgba(0,0,0,.5)', overflow: 'hidden',
      },
    });

    const pos = GM_getValue(LS.panelPos, null);
    if (pos) {
      // clamp on restore too, in case a bad position (e.g. dragged above the
      // viewport, making the header unreachable) was already saved
      const margin = 24;
      const panelWidth = parseFloat(panel.style.width) || 340;
      const leftNum = parseFloat(pos.left);
      const topNum = parseFloat(pos.top);
      panel.style.left = `${Number.isFinite(leftNum) ? clamp(leftNum, margin - panelWidth, window.innerWidth - margin) : 12}px`;
      panel.style.top = `${Number.isFinite(topNum) ? clamp(topNum, 0, window.innerHeight - margin) : 12}px`;
    } else {
      panel.style.left = '12px';
      panel.style.bottom = '12px';
    }

    const header = el('div', {
      style: {
        cursor: 'move', padding: '8px 10px', background: '#242a35',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        userSelect: 'none',
      },
    },
      el('strong', {}, 'Weav3r Watcher'),
      el('button', { id: 'w3b-collapse-btn', style: btnStyle() }, '_')
    );

    const body = el('div', { id: 'w3b-body', style: { padding: '8px 10px', maxHeight: '55vh', overflowY: 'auto' } });

    const rowsWrap = el('div', { id: 'w3b-rows' });

    const addRow = el('div', { style: { display: 'flex', gap: '4px', marginTop: '8px' } },
      el('input', { id: 'w3b-add-id', placeholder: 'Item ID', style: 'width:64px;min-width:64px', type: 'number' }),
      el('input', { id: 'w3b-add-threshold', placeholder: 'Alert below $', style: 'flex:1;min-width:0', type: 'number' }),
      el('button', { id: 'w3b-add-btn', style: btnStyle() }, 'Add')
    );

    const intervalRow = el('div', { style: { display: 'flex', gap: '4px', marginTop: '6px', alignItems: 'center' } },
      el('span', {}, 'Poll every'),
      el('input', { id: 'w3b-interval', type: 'number', style: 'width:56px', value: String(getPollIntervalSec()) }),
      el('span', {}, 'sec'),
      el('button', { id: 'w3b-check-now', style: { ...btnStyle(), marginLeft: 'auto' } }, 'Check now')
    );

    const autoOpenCheckboxAttrs = { id: 'w3b-auto-open', type: 'checkbox', style: { cursor: 'pointer' } };
    if (getAutoOpenTab()) autoOpenCheckboxAttrs.checked = 'checked';
    const autoOpenRow = el('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center' } },
      el('input', autoOpenCheckboxAttrs),
      el('label', { for: 'w3b-auto-open', style: 'cursor:pointer' }, 'Auto-open tab on alert')
    );

    const discordRow = el('div', { style: { display: 'flex', gap: '4px', marginTop: '6px', alignItems: 'center' } },
      el('input', { id: 'w3b-discord-webhook', type: 'text', placeholder: 'Discord webhook URL', style: 'flex:1;min-width:0', value: getDiscordWebhook() }),
      el('button', { id: 'w3b-discord-test', style: btnStyle() }, 'Test')
    );

    const checkAllRow = el('div', { style: { display: 'flex', gap: '4px', marginTop: '6px', alignItems: 'center' } },
      el('input', { id: 'w3b-torn-key', type: 'password', placeholder: 'Torn API key (public)', style: 'flex:1;min-width:0', value: getTornApiKey() }),
      el('button', { id: 'w3b-check-all', style: btnStyle() }, 'Check all')
    );

    const flushiesRow = el('div', { style: { display: 'flex', gap: '4px', marginTop: '6px', alignItems: 'center' } },
      el('span', {}, 'Plushies & flowers'),
      el('button', { id: 'w3b-check-flushies', style: { ...btnStyle(), marginLeft: 'auto' } }, 'Check Flushies')
    );

    const flushiesAutoCheckboxAttrs = { id: 'w3b-flushies-auto', type: 'checkbox', style: { cursor: 'pointer' } };
    if (getFlushiesAutoScan()) flushiesAutoCheckboxAttrs.checked = 'checked';
    const flushiesAutoRow = el('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center' } },
      el('input', flushiesAutoCheckboxAttrs),
      el('label', { for: 'w3b-flushies-auto', style: 'cursor:pointer' }, 'Auto-scan flushies (2%+, >25 qty) — uses Auto-open tab toggle above')
    );

    const status = el('div', { id: 'w3b-status', style: { marginTop: '6px', opacity: '.7' } }, 'Idle');

    // input rows/status styling
    Array.from([addRow, intervalRow, discordRow, checkAllRow]).forEach((row) => {
      row.querySelectorAll('input').forEach((i) => Object.assign(i.style, inputStyle()));
    });

    body.appendChild(rowsWrap);
    body.appendChild(addRow);
    body.appendChild(intervalRow);
    body.appendChild(autoOpenRow);
    body.appendChild(discordRow);
    body.appendChild(checkAllRow);
    body.appendChild(flushiesRow);
    body.appendChild(flushiesAutoRow);
    body.appendChild(status);

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    makeDraggable(panel, header);

    header.querySelector('#w3b-collapse-btn').addEventListener('click', () => {
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? 'block' : 'none';
    });

    addRow.querySelector('#w3b-add-btn').addEventListener('click', () => {
      const idInput = addRow.querySelector('#w3b-add-id');
      const thInput = addRow.querySelector('#w3b-add-threshold');
      const id = parseInt(idInput.value, 10);
      const threshold = Number(thInput.value);
      if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(threshold) || threshold <= 0) {
        setStatus('Enter a valid item ID and threshold.');
        return;
      }
      upsertItem(id, null, threshold);
      idInput.value = '';
      thInput.value = '';
      renderRows();
      pollOne(id); // fetch immediately so the new row isn't blank until next cycle
    });

    intervalRow.querySelector('#w3b-interval').addEventListener('change', (e) => {
      const v = Math.max(1, Math.round(Number(e.target.value) || CONFIG.defaultPollIntervalSec));
      GM_setValue(LS.pollIntervalSec, v);
      e.target.value = String(v);
    });

    intervalRow.querySelector('#w3b-check-now').addEventListener('click', () => pollAll(true));

    autoOpenRow.querySelector('#w3b-auto-open').addEventListener('change', (e) => {
      GM_setValue(LS.autoOpenTab, e.target.checked);
    });

    discordRow.querySelector('#w3b-discord-webhook').addEventListener('change', (e) => {
      saveDiscordWebhook(e.target.value);
    });

    discordRow.querySelector('#w3b-discord-test').addEventListener('click', () => {
      const webhook = getDiscordWebhook();
      if (!webhook) {
        setStatus('Enter a Discord webhook URL first.');
        return;
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url: webhook,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ content: 'Weav3r Watcher: test alert ✅' }),
        onload: (r) => setStatus(r.status >= 200 && r.status < 300 ? 'Discord test sent.' : `Discord test failed (HTTP ${r.status}).`),
        onerror: () => setStatus('Discord test failed (network error).'),
      });
    });

    checkAllRow.querySelector('#w3b-torn-key').addEventListener('change', (e) => {
      saveTornApiKey(e.target.value);
      itemsCatalogueCache = null; // key changed — drop the cache so the next scan re-fetches with it
    });

    checkAllRow.querySelector('#w3b-check-all').addEventListener('click', (e) => checkAll(e.target));

    flushiesRow.querySelector('#w3b-check-flushies').addEventListener('click', (e) => checkFlushies(e.target));

    flushiesAutoRow.querySelector('#w3b-flushies-auto').addEventListener('change', (e) => {
      GM_setValue(LS.flushiesAutoScan, e.target.checked);
      if (e.target.checked && !getTornApiKey()) {
        setStatus('Auto-scan flushies is on, but needs a Torn API key first.');
      }
    });

    renderRows();
  }

  function btnStyle() {
    return {
      background: '#3a4152', color: '#fff', border: '1px solid #4a5268',
      borderRadius: '4px', padding: '3px 8px', cursor: 'pointer', font: 'inherit',
    };
  }

  function inputStyle() {
    return {
      background: '#12151b', color: '#fff', border: '1px solid #3a3f4b',
      borderRadius: '4px', padding: '3px 6px', font: 'inherit',
    };
  }

  function setStatus(text) {
    const s = document.getElementById('w3b-status');
    if (s) s.textContent = text;
  }

  function renderRows() {
    const wrap = document.getElementById('w3b-rows');
    if (!wrap) return;
    wrap.innerHTML = '';
    const list = getWatchlist();

    if (list.length === 0) {
      wrap.appendChild(el('div', { style: { opacity: '.6' } }, 'No items watched yet.'));
      return;
    }

    const table = el('table', { style: 'width:100%;border-collapse:collapse' });
    for (const item of list) {
      const st = statusById[item.id] || {};
      const isCheap = st.price != null && st.price <= item.threshold;
      const priceText = st.error ? 'error' : st.price != null ? `$${st.price.toLocaleString()}` : '…';

      const tr = el('tr', { style: 'border-top:1px solid #2a2f3a' },
        el('td', { style: 'padding:4px 2px' },
          el('a', { href: `https://weav3r.dev/item/${item.id}?mode=buy&tab=all&timeframe=7d`, target: '_blank', style: 'color:#8ab4f8;text-decoration:none' }, item.name || `Item ${item.id}`),
          el('div', { style: 'opacity:.55;font-size:10px' }, `ID ${item.id} · below $${item.threshold.toLocaleString()}`)
        ),
        el('td', { style: `padding:4px 2px;text-align:right;font-weight:600;color:${isCheap ? '#3ddc84' : '#e8e8e8'}` }, priceText),
        el('td', { style: 'padding:4px 2px;text-align:right' },
          el('button', {
            style: { ...btnStyle(), padding: '2px 6px' },
            onclick: () => { removeItem(item.id); delete statusById[item.id]; renderRows(); },
          }, '×')
        )
      );
      table.appendChild(tr);
    }
    wrap.appendChild(table);
  }

  function makeDraggable(panel, handle) {
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      panel.style.bottom = '';
      panel.style.top = `${rect.top}px`;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      // keep at least `margin` px of the panel on-screen so the header (the only
      // drag handle) can never end up somewhere the mouse can't reach
      const margin = 24;
      const panelWidth = parseFloat(panel.style.width) || 340;
      const left = clamp(startLeft + (e.clientX - startX), margin - panelWidth, window.innerWidth - margin);
      const top = clamp(startTop + (e.clientY - startY), 0, window.innerHeight - margin);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      GM_setValue(LS.panelPos, { left: panel.style.left, top: panel.style.top });
    });
  }

  // ════════════════════════════════════════════════════════════
  //  POLL LOOP
  // ════════════════════════════════════════════════════════════

  async function pollOne(id) {
    const list = getWatchlist();
    const item = list.find((i) => i.id === id);
    if (!item) return;
    try {
      const { name, listings } = await fetchWeav3rListings(id);
      if (name && name !== item.name) {
        item.name = name;
        saveWatchlist(list);
      }
      const cheapest = listings[0] || null;
      statusById[id] = {
        price: cheapest ? cheapest.price : null,
        seller: cheapest ? cheapest.seller : null,
        sellerUrl: cheapest ? cheapest.sellerUrl : null,
        error: false,
        checkedAt: Date.now(),
      };
      if (cheapest && cheapest.price <= item.threshold) {
        notify(item, cheapest);
      }
    } catch (e) {
      statusById[id] = { error: true, checkedAt: Date.now() };
      console.warn(`[W3B] Failed to fetch item ${id}:`, e.message);
    }
    renderRows();
  }

  async function pollAll(manual = false) {
    if (!manual && !claimLock()) return;
    refreshLock();
    const list = getWatchlist();
    setStatus(`Checking ${list.length} item(s)...`);
    // items are polled concurrently rather than one-at-a-time-with-a-pause, so the
    // per-item re-check rate no longer degrades as the watchlist grows.
    await Promise.all(list.map((item) => pollOne(item.id)));
    setStatus(`Last checked ${new Date().toLocaleTimeString()}`);
  }

  async function loop() {
    while (true) {
      await pollAll(false);
      await sleep(getPollIntervalSec() * 1000);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  CHECK ALL — one-off scan of every tradeable item, market-price-relative
  // ════════════════════════════════════════════════════════════

  // shared by every bulk scan (check-all, check-flushies) so they can't run concurrently
  // and compound load on weav3r
  let bulkScanRunning = false;

  function checkMarketValueDeal(entry, cheapestSell) {
    if (cheapestSell.price <= entry.marketValue * CONFIG.checkAllDiscountFactor) {
      notify({ id: entry.id, name: entry.name, marketValue: entry.marketValue }, cheapestSell, { autoOpen: false, dedupTag: 'market' });
      return true;
    }
    return false;
  }

  // The per-unit gap and the bulk-flip-profit checks are two different lenses on the
  // same opportunity (and at quantity 1 they're mathematically the same number), so this
  // fires at most one notify() covering whichever condition(s) matched — never two
  // separate alerts for one listing. Returns 1 if it fired, 0 otherwise.
  function checkFlipDeals(entry, cheapestSell, bestBuy) {
    const perUnitProfit = bestBuy.price - cheapestSell.price;
    const flipQty = cheapestSell.quantity;
    const totalCost = cheapestSell.price * flipQty;
    const totalProfit = perUnitProfit * flipQty;

    const gapHit = perUnitProfit >= CONFIG.flipMinPriceGap;
    const flipHit = flipQty > 0 && totalProfit >= CONFIG.flipMinTotalProfit && totalProfit / totalCost >= CONFIG.flipMinProfitRatio;
    if (!gapHit && !flipHit) return 0;

    const bulkPart = flipQty > 1 ? `, ${flipQty}x = +$${totalProfit.toLocaleString()}` : '';
    const note = `buy $${cheapestSell.price.toLocaleString()} → sell $${bestBuy.price.toLocaleString()} (+$${perUnitProfit.toLocaleString()}/unit${bulkPart})`;
    notify({ id: entry.id, name: entry.name, note }, cheapestSell, { autoOpen: false, dedupTag: 'flip' });
    return 1;
  }

  async function checkAll(button) {
    if (bulkScanRunning) {
      setStatus('A scan is already running — wait for it to finish.');
      return;
    }

    let catalogue;
    try {
      const full = await fetchAllItemsCatalog();
      catalogue = full.filter((i) => i.marketValue > CONFIG.checkAllMinMarketValue && i.marketValue < CONFIG.checkAllMaxMarketValue);
    } catch (e) {
      setStatus(e.message === 'no_api_key' ? 'Enter a Torn API key first.' : `Check-all failed: ${e.message}`);
      return;
    }

    bulkScanRunning = true;
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = 'Checking...';

    let hits = 0;
    // items with a real sell listing, carried over into the slower flip-check phase
    const flipCandidates = [];

    try {
      // Phase 1: market-value check. Batched and fast — weav3r has never rate-limited
      // the listings endpoint the way it does the deal-search one below.
      for (let i = 0; i < catalogue.length; i += CONFIG.checkAllBatchSize) {
        const batch = catalogue.slice(i, i + CONFIG.checkAllBatchSize);
        setStatus(`Check all (1/2 — market value): ${Math.min(i + batch.length, catalogue.length)}/${catalogue.length} items (${hits} deal(s) so far)...`);
        await Promise.all(batch.map(async (entry) => {
          let sell;
          try {
            sell = await fetchWeav3rListings(entry.id);
          } catch (e) {
            console.warn(`[W3B] check-all: failed to fetch listings for item ${entry.id} (${entry.name}):`, e.message);
            return;
          }
          const cheapestSell = sell.listings[0];
          if (!cheapestSell) return;
          if (checkMarketValueDeal(entry, cheapestSell)) hits++;
          flipCandidates.push({ entry, cheapestSell });
        }));
        await sleep(CONFIG.checkAllBatchPauseMs);
      }

      // Phase 2: gap/flip check via trader buy prices. One at a time, deliberately
      // slow, with a real backoff on 429 — weav3r's deal-search endpoint has a much
      // tighter rate limit ("Too many deal searches. Please slow down.", confirmed
      // live) than anything else this script talks to.
      let flipBackoffUntil = 0;
      for (let i = 0; i < flipCandidates.length; i++) {
        const { entry, cheapestSell } = flipCandidates[i];
        setStatus(`Check all (2/2 — flips, slow by design): ${i + 1}/${flipCandidates.length} items (${hits} deal(s) so far)...`);

        if (Date.now() < flipBackoffUntil) {
          await sleep(flipBackoffUntil - Date.now());
        }
        try {
          const { traders } = await fetchWeav3rTraders(entry.id);
          if (traders[0]) hits += checkFlipDeals(entry, cheapestSell, traders[0]);
        } catch (e) {
          if (e.message === 'rate_limited') {
            flipBackoffUntil = Date.now() + CONFIG.flipCheckBackoffMs;
            console.warn(`[W3B] check-all: deal-search rate-limited — pausing ${CONFIG.flipCheckBackoffMs / 1000}s`);
          } else {
            console.warn(`[W3B] check-all: failed to fetch traders for item ${entry.id} (${entry.name}):`, e.message);
          }
        }
        await sleep(CONFIG.flipCheckPaceMs);
      }

      setStatus(`Check all done — ${hits} deal(s) found across ${catalogue.length} items.`);
    } finally {
      bulkScanRunning = false;
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  // Unlike checkMarketValueDeal (cheapest listing only), this pings every qualifying
  // bazaar for the item, per the ask — with a 1% bar there can genuinely be several
  // worth seeing, not just the single best one.
  async function checkFlushiesOneItem(entry) {
    let sell;
    try {
      sell = await fetchWeav3rListings(entry.id);
    } catch (e) {
      console.warn(`[W3B] check-flushies: failed to fetch listings for item ${entry.id} (${entry.name}):`, e.message);
      return 0;
    }
    const threshold = entry.marketValue * CONFIG.flushiesDiscountFactor;
    const qualifying = sell.listings.filter((l) => l.price <= threshold);
    for (const listing of qualifying) {
      notify({ id: entry.id, name: entry.name, marketValue: entry.marketValue }, listing, { autoOpen: false, dedupTag: 'flushie' });
    }
    return qualifying.length;
  }

  // Scans every Plushie and Flower above $1k market value (skips the handful of
  // near-worthless ones, e.g. Teddy Bear/Sheep/Kitten Plushies at ~$500) for any bazaar
  // at least 1% below market — a much lower bar than check-all's 20%, and unlike it,
  // pings every qualifying listing rather than just the cheapest. A small category (a
  // few dozen items total) so, unlike check-all's flip phase, there's no need for slow
  // pacing: it only uses the listings endpoint, which weav3r has never rate-limited.
  async function checkFlushies(button) {
    if (bulkScanRunning) {
      setStatus('A scan is already running — wait for it to finish.');
      return;
    }

    let catalogue;
    try {
      const full = await fetchAllItemsCatalog();
      catalogue = full.filter((i) => (i.type === 'Plushie' || i.type === 'Flower') && i.marketValue > CONFIG.flushiesMinMarketValue);
    } catch (e) {
      setStatus(e.message === 'no_api_key' ? 'Enter a Torn API key first.' : `Check-flushies failed: ${e.message}`);
      return;
    }

    bulkScanRunning = true;
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = 'Checking...';

    let hits = 0;
    try {
      for (let i = 0; i < catalogue.length; i += CONFIG.checkAllBatchSize) {
        const batch = catalogue.slice(i, i + CONFIG.checkAllBatchSize);
        setStatus(`Check flushies: ${Math.min(i + batch.length, catalogue.length)}/${catalogue.length} items (${hits} deal(s) so far)...`);
        const results = await Promise.all(batch.map(checkFlushiesOneItem));
        hits += results.reduce((sum, n) => sum + n, 0);
        await sleep(CONFIG.checkAllBatchPauseMs);
      }
      setStatus(`Check flushies done — ${hits} deal(s) found across ${catalogue.length} plushies/flowers.`);
    } finally {
      bulkScanRunning = false;
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }

  // Stricter than the manual scan (2% under market, >25 qty vs. 1% under, any qty) and,
  // unlike it, doesn't force autoOpen:false — it defers to the Auto-open tab toggle like
  // the regular watchlist does, so turning that off also silences this. Shares the
  // 'flushie' dedup tag with the manual scan deliberately: whichever catches a listing
  // first, the other shouldn't re-alert on the same unchanged deal.
  async function checkFlushiesAutoOneItem(entry) {
    let sell;
    try {
      sell = await fetchWeav3rListings(entry.id);
    } catch (e) {
      console.warn(`[W3B] flushies auto-scan: failed to fetch listings for item ${entry.id} (${entry.name}):`, e.message);
      return;
    }
    const threshold = entry.marketValue * CONFIG.flushiesAutoDiscountFactor;
    for (const listing of sell.listings) {
      if (listing.price <= threshold && listing.quantity > CONFIG.flushiesAutoMinQuantity) {
        notify({ id: entry.id, name: entry.name, marketValue: entry.marketValue }, listing, { dedupTag: 'flushie' });
      }
    }
  }

  async function flushiesAutoTick() {
    if (!getFlushiesAutoScan()) return;
    if (!getTornApiKey()) return; // silently idle without a key — no point warning every cycle
    if (bulkScanRunning) return; // don't compete with a manual check-all/check-flushies run
    if (!claimLock()) return;

    let catalogue;
    try {
      const full = await fetchAllItemsCatalog();
      catalogue = full.filter((i) => (i.type === 'Plushie' || i.type === 'Flower') && i.marketValue > CONFIG.flushiesMinMarketValue);
    } catch (e) {
      console.warn('[W3B] flushies auto-scan: failed to fetch catalogue:', e.message);
      return;
    }
    // small category (a few dozen items) — fine to check all concurrently each tick,
    // same as the regular watchlist does with its handful of items
    await Promise.all(catalogue.map(checkFlushiesAutoOneItem));
  }

  async function flushiesAutoLoop() {
    while (true) {
      await flushiesAutoTick();
      await sleep(CONFIG.flushiesAutoScanIntervalMs);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════════════════════════

  if (location.hostname === 'www.torn.com') {
    highlightSearchTarget();
  } else {
    if (!document.getElementById('w3b-panel')) {
      buildPanel();
    }
    loop();
    flushiesAutoLoop();
  }
})();
