// ==UserScript==
// @name         Weav3r Item Watcher
// @namespace    weav3r-item-watch
// @version      1.0
// @description  Background-polls weav3r.dev item pages for the cheapest buy-mode listing and alerts when it drops below a per-item threshold. Floating panel (bottom-left) lets you add/edit/remove watched item IDs and thresholds.
// @match        https://weav3r.dev/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      weav3r.dev
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════
  //  CONFIG
  // ════════════════════════════════════════════════════════════

  const CONFIG = {
    defaultPollIntervalSec: 5,
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

  // weav3r renders listings server-side, price-ascending, inside
  // <tr class="item-table-row ...">...<td>...$price...$total...</td></tr>.
  // The first row is therefore the cheapest available listing.
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

    const rowMatch = html.match(/<tr class="item-table-row[\s\S]*?<\/tr>/);
    if (!rowMatch) {
      return { name, price: null, seller: null, sellerUrl: null };
    }
    const row = rowMatch[0];

    const priceMatch = row.match(/\$([\d,]+)/);
    const price = priceMatch ? Number(priceMatch[1].replace(/,/g, '')) : null;

    const sellerMatch = row.match(/<a href="([^"]+)"[^>]*>([^<]+)<!-- -->\s*\[(\d+)\]<\/a>/);
    const seller = sellerMatch ? `${sellerMatch[2]} [${sellerMatch[3]}]` : null;
    const sellerUrl = sellerMatch ? sellerMatch[1] : null;

    return { name, price, seller, sellerUrl };
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

  function notify(item, price, seller, sellerUrl) {
    const seen = loadSeenAlerts();
    const key = `${item.id}-${price}`;
    if (seen[key]) return;
    seen[key] = Date.now();
    GM_setValue(LS.seenAlerts, seen);

    GM_notification({
      title: `Weav3r: ${item.name} deal!`,
      text: `$${price.toLocaleString()} (below $${item.threshold.toLocaleString()})${seller ? ' — ' + seller : ''}`,
      timeout: 25000,
      onclick: () => {
        window.focus();
        window.open(sellerUrl || `https://weav3r.dev/item/${item.id}?mode=buy&tab=all&timeframe=7d`, '_blank');
      },
    });
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
    console.log(`[W3B] ALERT: ${item.name} (${item.id}) $${price.toLocaleString()}`);
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

    const status = el('div', { id: 'w3b-status', style: { marginTop: '6px', opacity: '.7' } }, 'Idle');

    // input rows/status styling
    Array.from([addRow, intervalRow]).forEach((row) => {
      row.querySelectorAll('input').forEach((i) => Object.assign(i.style, inputStyle()));
    });

    body.appendChild(rowsWrap);
    body.appendChild(addRow);
    body.appendChild(intervalRow);
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
      const v = Math.max(3, Math.round(Number(e.target.value) || CONFIG.defaultPollIntervalSec));
      GM_setValue(LS.pollIntervalSec, v);
      e.target.value = String(v);
    });

    intervalRow.querySelector('#w3b-check-now').addEventListener('click', () => pollAll(true));

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

  if (!document.getElementById('w3b-panel')) {
    buildPanel();
  }
  loop();
})();
