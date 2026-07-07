// ==UserScript==
// @name         Torn Player Location Watcher
// @namespace    tc-location-watch
// @version      1.0
// @description  Polls the Torn API for a fixed list of player IDs and notifies you when their status changes (Okay/Traveling/Abroad/Hospital/Jail). Runs on any torn.com tab.
// @match        https://weav3r.dev/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @connect      api.torn.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════
  //  CONFIG
  // ════════════════════════════════════════════════════════════

  const CONFIG = {
    checkGapMs: 3_000,       // gap between checking one profile and the next (not per full cycle)
    perRequestDelayMs: 800,  // gap between calls REUSING THE SAME key (Torn's soft limit is ~100/min/key)
    maxApiKeys: 10,
  };

  const API_BASE = 'https://api.torn.com/v2';

  const LS = {
    apiKeys: 'tlw_api_keys', // array of up to CONFIG.maxApiKeys key strings, all on your own account
    watchList: 'tlw_watch_list',   // array of numeric player IDs
    lastStatus: 'tlw_last_status', // { [id]: { state, description } }
    running: 'tlw_running',
    lock: 'tlw_lock',
  };

  const TAB_ID = Math.random().toString(36).slice(2, 10);
  const LOCK_TTL_MS = CONFIG.checkGapMs * 4;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ════════════════════════════════════════════════════════════
  //  API KEYS — up to 10 keys, all generated from the same account, used
  //  round-robin so each individual key stays well under Torn's per-key
  //  rate limit even while polling frequently.
  // ════════════════════════════════════════════════════════════

  function getApiKeys() {
    return GM_getValue(LS.apiKeys, []);
  }

  GM_registerMenuCommand(`🔑 Set Torn API Keys (up to ${CONFIG.maxApiKeys})`, () => {
    const current = getApiKeys().join(', ');
    const input = prompt(
      `Enter up to ${CONFIG.maxApiKeys} Torn API keys, comma-separated (all from your own account — generate more at torn.com/preferences.php#tab=api):`,
      current
    );
    if (input == null) return;
    const keys = input.split(',').map((s) => s.trim()).filter(Boolean).slice(0, CONFIG.maxApiKeys);
    GM_setValue(LS.apiKeys, keys);
    alert(keys.length ? `Saved ${keys.length} API key(s).` : 'API keys cleared.');
  });

  // ════════════════════════════════════════════════════════════
  //  WATCH LIST
  // ════════════════════════════════════════════════════════════

  function getWatchList() {
    return GM_getValue(LS.watchList, []);
  }

  GM_registerMenuCommand('📋 Set Watched Player IDs', () => {
    const current = getWatchList().join(', ');
    const input = prompt('Enter player IDs to watch, comma-separated (e.g. 1234567, 2345678):', current);
    if (input == null) return;
    const ids = input.split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    GM_setValue(LS.watchList, ids);
    // Clear stale baselines for anyone no longer watched, so a re-added ID
    // starts fresh instead of comparing against very old state.
    const lastStatus = GM_getValue(LS.lastStatus, {});
    for (const key of Object.keys(lastStatus)) {
      if (!ids.includes(Number(key))) delete lastStatus[key];
    }
    GM_setValue(LS.lastStatus, lastStatus);
    alert(ids.length ? `Watching ${ids.length} player(s): ${ids.join(', ')}` : 'Watch list cleared.');
  });

  // ════════════════════════════════════════════════════════════
  //  RATE-GATED HTTP
  // ════════════════════════════════════════════════════════════

  // Rate gating is per-key, not global — calls reusing the same key still
  // wait perRequestDelayMs apart, but rotating to a different key can fire
  // immediately, since each key has its own independent Torn rate budget.
  let rotationIndex = 0;
  const lastRequestByKey = {};

  function nextApiKey() {
    const keys = getApiKeys();
    if (keys.length === 0) return null;
    const key = keys[rotationIndex % keys.length];
    rotationIndex++;
    return key;
  }

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

  async function apiGet(path) {
    const key = nextApiKey();
    if (!key) throw new Error('no_api_keys');

    const lastForThisKey = lastRequestByKey[key] || 0;
    const wait = CONFIG.perRequestDelayMs - (Date.now() - lastForThisKey);
    if (wait > 0) await sleep(wait);
    lastRequestByKey[key] = Date.now();

    const keySlot = getApiKeys().indexOf(key) + 1;
    console.log(`[TLW] API call: ${path} @ ${new Date(lastRequestByKey[key]).toLocaleTimeString()} (key #${keySlot})`);

    const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
    const res = await gmGet(url);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status} for ${path}`);
    }
    let data;
    try {
      data = JSON.parse(res.responseText);
    } catch {
      throw new Error(`Non-JSON response for ${path}: ${res.responseText.slice(0, 200)}`);
    }
    if (data && data.error) {
      throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`);
    }
    return data;
  }

  // ════════════════════════════════════════════════════════════
  //  STATUS FETCH
  // ════════════════════════════════════════════════════════════

  // Standard Torn API "profile" selection: profile.status = { state, description,
  // details, until, color }. state is one of: Okay, Hospital, Jail, Traveling,
  // Abroad, Federal. This is the same field the (widely-used, public) Bounty
  // Hunter userscript relies on for its own status logic, so it's on more
  // solid ground than the market "quality" field we had to verify earlier —
  // but if the console logs "Unexpected profile response", paste it back and
  // I'll adjust the field names below.
  async function fetchStatus(id) {
    const data = await apiGet(`/user/${id}?selections=profile`);
    const profile = data.profile;
    if (!profile || !profile.status) {
      console.error(`[TLW] Unexpected profile response for ${id}:`, data);
      return null;
    }
    return {
      id,
      name: profile.name || `#${id}`,
      state: profile.status.state,
      description: profile.status.description,
    };
  }

  function notifyChange(prev, curr) {
    GM_notification({
      title: `${curr.name}: status changed`,
      text: `${prev.state} → ${curr.state}${curr.description ? ` (${curr.description})` : ''}`,
      timeout: 20000,
      onclick: () => window.focus(),
    });
    console.log(`[TLW] ${curr.name} (${curr.id}): ${prev.state} -> ${curr.state} — ${curr.description}`);
  }

  // Fired for the first observation of a player (on Start, or when newly
  // added to the watch list) — confirms the script is actually running and
  // reaching the API, rather than silently doing nothing until a change.
  function notifyBaseline(curr) {
    GM_notification({
      title: `${curr.name}: now watching`,
      text: `Current: ${curr.state}${curr.description ? ` (${curr.description})` : ''}`,
      timeout: 20000,
      onclick: () => window.focus(),
    });
    console.log(`[TLW] ${curr.name} (${curr.id}): baseline set — ${curr.state} (${curr.description})`);
  }

  // Round-robins through the watch list one player at a time — the caller
  // (the main loop) waits CONFIG.checkGapMs between calling this, so
  // consecutive profile checks land exactly checkGapMs apart, regardless of
  // how many players are being watched.
  let playerRotationIndex = 0;

  function nextPlayerId() {
    const ids = getWatchList();
    if (ids.length === 0) return null;
    const id = ids[playerRotationIndex % ids.length];
    playerRotationIndex++;
    return id;
  }

  async function checkOnePlayer(id) {
    const lastStatus = GM_getValue(LS.lastStatus, {});
    try {
      const curr = await fetchStatus(id);
      if (!curr) return;
      const prev = lastStatus[id];
      if (!prev) {
        // First time seeing this player — record a baseline and notify,
        // so you get immediate confirmation the watcher is actually working.
        lastStatus[id] = { name: curr.name, state: curr.state, description: curr.description };
        GM_setValue(LS.lastStatus, lastStatus);
        notifyBaseline(curr);
      } else {
        // Only the state (Okay/Hospital/Jail/Traveling/Abroad/Federal) drives
        // a notification. description is ignored here on purpose — while
        // hospitalised it contains a countdown that changes every check,
        // which would otherwise fire a "change" notification constantly.
        // We still always re-save name/description below so the on-page
        // panel reflects the latest countdown/location text.
        if (prev.state !== curr.state) notifyChange(prev, curr);
        lastStatus[id] = { name: curr.name, state: curr.state, description: curr.description };
        GM_setValue(LS.lastStatus, lastStatus);
      }
    } catch (e) {
      console.warn(`[TLW] Failed to fetch status for ${id}:`, e.message);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  LEADER LOCK — avoid duplicate polling/API calls across multiple open tabs
  // ════════════════════════════════════════════════════════════

  function claimLock() {
    const lock = GM_getValue(LS.lock, null);
    const now = Date.now();
    if (lock && lock.owner !== TAB_ID && now - lock.ts < LOCK_TTL_MS) return false;
    GM_setValue(LS.lock, { owner: TAB_ID, ts: now });
    return true;
  }

  function refreshLock() {
    GM_setValue(LS.lock, { owner: TAB_ID, ts: Date.now() });
  }

  // ════════════════════════════════════════════════════════════
  //  ON-PAGE PANEL — small floating box showing each watched player's
  //  name and current location. Re-created on every page load (since a
  //  fresh page is a fresh DOM), and kept live across tabs via
  //  GM_addValueChangeListener, so even a non-leader tab (one that isn't
  //  doing the actual polling) still shows up-to-date info.
  // ════════════════════════════════════════════════════════════

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function ensurePanel() {
    let panel = document.getElementById('tlw-panel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'tlw-panel';
    panel.style.cssText = `
      position: fixed;
      bottom: 12px;
      right: 12px;
      z-index: 999999;
      background: rgba(20, 20, 20, 0.9);
      color: #eee;
      font: 12px/1.5 -apple-system, Arial, sans-serif;
      padding: 8px 10px;
      border-radius: 6px;
      max-width: 260px;
      max-height: 40vh;
      overflow-y: auto;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    `;
    (document.body || document.documentElement).appendChild(panel);
    return panel;
  }

  function renderPanel() {
    const panel = ensurePanel();
    if (!isRunning()) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';

    const ids = getWatchList();
    const lastStatus = GM_getValue(LS.lastStatus, {});

    let html = '<div style="font-weight:bold;margin-bottom:4px;">📍 Location Watch</div>';
    if (ids.length === 0) {
      html += '<div style="opacity:0.7">No players watched.</div>';
    } else {
      for (const id of ids) {
        const s = lastStatus[id];
        const name = escapeHtml((s && s.name) || `#${id}`);
        const line = s
          ? escapeHtml(`${s.state}${s.description ? ' — ' + s.description : ''}`)
          : '<span style="opacity:0.7">checking...</span>';
        html += `<div><b>${name}</b>: ${line}</div>`;
      }
    }
    panel.innerHTML = html;
  }

  // Any tab (leader or not) re-renders whenever the shared state changes,
  // so the panel stays live even in tabs that aren't doing the polling.
  GM_addValueChangeListener(LS.lastStatus, renderPanel);
  GM_addValueChangeListener(LS.watchList, renderPanel);
  GM_addValueChangeListener(LS.running, renderPanel);
  renderPanel();

  // ════════════════════════════════════════════════════════════
  //  MAIN LOOP
  // ════════════════════════════════════════════════════════════

  function isRunning() {
    return GM_getValue(LS.running, false);
  }

  async function loop() {
    while (isRunning()) {
      if (getApiKeys().length === 0) {
        console.warn('[TLW] No API keys set. Use the Tampermonkey menu "Set Torn API Keys".');
        await sleep(CONFIG.checkGapMs);
        continue;
      }
      if (getWatchList().length === 0) {
        console.warn('[TLW] No player IDs set. Use the Tampermonkey menu "Set Watched Player IDs".');
        await sleep(CONFIG.checkGapMs);
        continue;
      }
      if (!claimLock()) {
        await sleep(CONFIG.checkGapMs);
        continue;
      }
      refreshLock();
      const id = nextPlayerId();
      if (id != null) {
        try {
          await checkOnePlayer(id);
        } catch (e) {
          console.error('[TLW] Check failed:', e.message);
        }
      }
      await sleep(CONFIG.checkGapMs);
    }
    console.log('[TLW] Stopped.');
  }

  GM_registerMenuCommand('▶ Start Location Watch', () => {
    if (isRunning()) return;
    if (getApiKeys().length === 0) {
      alert('Set at least one Torn API key first (Tampermonkey menu → "Set Torn API Keys").');
      return;
    }
    if (getWatchList().length === 0) {
      alert('Set at least one player ID first (Tampermonkey menu → "Set Watched Player IDs").');
      return;
    }
    GM_setValue(LS.lock, null);
    GM_setValue(LS.running, true);
    console.log('[TLW] Started.');
    loop();
  });

  GM_registerMenuCommand('⏹ Stop Location Watch', () => {
    GM_setValue(LS.running, false);
  });

  if (isRunning()) {
    loop();
  }
})();
