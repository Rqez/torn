// ==UserScript==
// @name         Weav3r Item Watcher
// @namespace    weav3r-item-watch
// @version      1.3
// @description  Background-polls weav3r.dev item pages for the cheapest buy-mode listing and alerts (desktop notification + optional Discord webhook + optional auto-opened tab that highlights the item on the seller's bazaar page) when it drops below a per-item threshold. Floating panel (bottom-left) lets you add/edit/remove watched item IDs and thresholds.
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
  };

  const TAB_ID = Math.random().toString(36).slice(2, 10);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // weav3r embeds the raw listings as JSON alongside the rendered table
  // (inside the page's RSC payload, escaped as \"listings\":[...]). Reading
  // that directly — rather than scraping table rows — sidesteps sponsored
  // rows (marked "sponsored":true, always shown first regardless of price)
  // and any future reordering/markup changes to the visible table.
  async function fetchCheapestListing(id) {
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
      return { name, price: null, seller: null, sellerUrl: null };
    }

    let listings;
    try {
      listings = JSON.parse(listingsMatch[1]);
    } catch {
      return { name, price: null, seller: null, sellerUrl: null };
    }

    const real = listings.filter((l) => !l.sponsored && Number.isFinite(l.price));
    if (real.length === 0) {
      return { name, price: null, seller: null, sellerUrl: null };
    }

    const cheapest = real.reduce((min, l) => (l.price < min.price ? l : min));
    const seller = cheapest.playerName ? `${cheapest.playerName} [${cheapest.playerId}]` : null;
    const sellerUrl = cheapest.playerId ? `https://www.torn.com/bazaar.php?userId=${cheapest.playerId}` : null;

    return { name, price: cheapest.price, seller, sellerUrl };
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

  function notify(item, price, seller, sellerUrl) {
    const seen = loadSeenAlerts();
    const key = `${item.id}-${price}`;
    if (seen[key]) return;
    seen[key] = Date.now();
    GM_setValue(LS.seenAlerts, seen);

    const link = buildAlertLink(item, sellerUrl);

    GM_notification({
      title: `Weav3r: ${item.name} deal!`,
      text: `$${price.toLocaleString()} (below $${item.threshold.toLocaleString()})${seller ? ' — ' + seller : ''}`,
      timeout: 25000,
      onclick: () => {
        window.focus();
        window.open(link, '_blank');
      },
    });
    if (getAutoOpenTab()) {
      // window.open() from a background poll isn't a user gesture and gets popup-blocked;
      // GM_openInTab is the extension-privileged equivalent of clicking the notification.
      GM_openInTab(link, { active: true, insert: true, setParent: true });
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
    sendDiscordAlert(item, price, seller, sellerUrl);
    console.log(`[W3B] ALERT: ${item.name} (${item.id}) $${price.toLocaleString()}`);
  }

  function sendDiscordAlert(item, price, seller, sellerUrl) {
    const webhook = getDiscordWebhook();
    if (!webhook) return;
    const link = buildAlertLink(item, sellerUrl);
    const payload = {
      embeds: [{
        title: `${item.name} deal!`,
        description: `$${price.toLocaleString()} (below $${item.threshold.toLocaleString()})${seller ? `\nSeller: ${seller}` : ''}`,
        url: link,
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
      panel.style.left = pos.left;
      panel.style.top = pos.top;
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

    const status = el('div', { id: 'w3b-status', style: { marginTop: '6px', opacity: '.7' } }, 'Idle');

    // input rows/status styling
    Array.from([addRow, intervalRow, discordRow]).forEach((row) => {
      row.querySelectorAll('input').forEach((i) => Object.assign(i.style, inputStyle()));
    });

    body.appendChild(rowsWrap);
    body.appendChild(addRow);
    body.appendChild(intervalRow);
    body.appendChild(autoOpenRow);
    body.appendChild(discordRow);
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
      const left = startLeft + (e.clientX - startX);
      const top = startTop + (e.clientY - startY);
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
      const { name, price, seller, sellerUrl } = await fetchCheapestListing(id);
      if (name && name !== item.name) {
        item.name = name;
        saveWatchlist(list);
      }
      statusById[id] = { price, seller, sellerUrl, error: false, checkedAt: Date.now() };
      if (price != null && price <= item.threshold) {
        notify(item, price, seller, sellerUrl);
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
    setStatus(`Checking ${getWatchlist().length} item(s)...`);
    for (const item of getWatchlist()) {
      await pollOne(item.id);
      await sleep(400); // gentle pacing between requests
    }
    setStatus(`Last checked ${new Date().toLocaleTimeString()}`);
  }

  async function loop() {
    while (true) {
      await pollAll(false);
      await sleep(getPollIntervalSec() * 1000);
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
  }
})();
