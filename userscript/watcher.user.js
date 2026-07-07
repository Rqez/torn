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
// @connect      discord.com
// @connect      discordapp.com
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
    discordWebhook: 'tlw_discord_webhook',
    discordMessageId: 'tlw_discord_message_id',
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
  //  DISCORD RELAY — optional. Instead of posting a new message per event,
  //  this keeps ONE message alive and edits it in place, mirroring the
  //  on-page panel — a friend watching that Discord channel sees the same
  //  always-current dashboard, not a growing feed of separate alerts.
  // ════════════════════════════════════════════════════════════

  function getDiscordWebhook() {
    return GM_getValue(LS.discordWebhook, '');
  }

  GM_registerMenuCommand('🔔 Set Discord Webhook (for friend)', () => {
    const current = getDiscordWebhook();
    const url = prompt(
      "Enter a Discord webhook URL to relay a live status dashboard to a friend's channel (Discord: Channel Settings → Integrations → Webhooks → New Webhook → Copy URL). Leave blank to disable:",
      current
    );
    if (url == null) return;
    GM_setValue(LS.discordWebhook, url.trim());
    GM_setValue(LS.discordMessageId, null); // start a fresh message under the new webhook
    alert(url.trim() ? 'Discord webhook saved.' : 'Discord webhook cleared — alerts will only show locally.');
  });

  // Torn's description is sometimes just a repeat of state (e.g. state="Okay",
  // description="Okay"), which reads as a redundant "Okay — Okay". When that
  // happens, show the physical location (Torn, for Okay/Jail/Federal) instead
  // of the duplicate — e.g. "Torn — Okay". Any other combo (Hospital/Traveling/
  // Abroad, where description actually adds detail) is left as-is.
  function formatStatusLine(state, description) {
    if (description === state) {
      const location = (state === 'Okay' || state === 'Jail' || state === 'Federal') ? 'Torn' : state;
      return `${location} — ${state}`;
    }
    return `${state}${description ? ' — ' + description : ''}`;
  }

  // Builds the same status list the on-page panel shows, as Discord markdown.
  // Disabled players are struck through, same as the panel dims them.
  function buildDiscordContent() {
    const list = getWatchList();
    if (list.length === 0) return '📍 **Location Watch** — no players watched.';
    const lastStatus = GM_getValue(LS.lastStatus, {});
    const lines = list.map((entry) => {
      const s = lastStatus[entry.id];
      const name = (s && s.name) || `#${entry.id}`;
      const line = s ? formatStatusLine(s.state, s.description) : 'checking...';
      const text = `**${name}**: ${line}`;
      return entry.enabled ? text : `~~${text}~~`;
    });
    return `📍 **Location Watch**\n${lines.join('\n')}`;
  }

  function postNewDiscordMessage(webhook, content) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${webhook}?wait=true`,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ content }),
      onload: (r) => {
        if (r.status < 200 || r.status >= 300) {
          console.warn(`[TLW] Discord post failed: HTTP ${r.status} — ${r.responseText.slice(0, 200)}`);
          return;
        }
        try {
          const msg = JSON.parse(r.responseText);
          if (msg.id) GM_setValue(LS.discordMessageId, msg.id);
        } catch {
          console.warn('[TLW] Discord post succeeded but response could not be parsed for message id.');
        }
      },
      onerror: () => console.warn('[TLW] Discord post request failed (network error).'),
    });
  }

  function syncDiscordMessage() {
    const webhook = getDiscordWebhook();
    if (!webhook) return;
    const content = buildDiscordContent();
    const messageId = GM_getValue(LS.discordMessageId, null);

    if (!messageId) {
      postNewDiscordMessage(webhook, content);
      return;
    }

    GM_xmlhttpRequest({
      method: 'PATCH',
      url: `${webhook}/messages/${messageId}`,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ content }),
      onload: (r) => {
        if (r.status === 404) {
          // The message was deleted on Discord's side — start a new one.
          GM_setValue(LS.discordMessageId, null);
          postNewDiscordMessage(webhook, content);
        } else if (r.status < 200 || r.status >= 300) {
          console.warn(`[TLW] Discord edit failed: HTTP ${r.status} — ${r.responseText.slice(0, 200)}`);
        }
      },
      onerror: () => console.warn('[TLW] Discord edit request failed (network error).'),
    });
  }

  // Separate from the persistent dashboard message above — this posts a
  // one-off "something changed" ping that self-deletes ~10s later, so a
  // friend gets an actual notification-style blip instead of only the
  // silently-updating dashboard.
  const TRANSIENT_ALERT_TTL_MS = 10_000;

  function deleteDiscordMessage(webhook, messageId) {
    GM_xmlhttpRequest({
      method: 'DELETE',
      url: `${webhook}/messages/${messageId}`,
      onload: (r) => {
        if ((r.status < 200 || r.status >= 300) && r.status !== 404) {
          console.warn(`[TLW] Discord alert delete failed: HTTP ${r.status} — ${r.responseText.slice(0, 200)}`);
        }
      },
      onerror: () => console.warn('[TLW] Discord alert delete request failed (network error).'),
    });
  }

  function sendTransientDiscordAlert(content) {
    const webhook = getDiscordWebhook();
    if (!webhook) return;
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${webhook}?wait=true`,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ content }),
      onload: (r) => {
        if (r.status < 200 || r.status >= 300) {
          console.warn(`[TLW] Discord alert post failed: HTTP ${r.status} — ${r.responseText.slice(0, 200)}`);
          return;
        }
        try {
          const msg = JSON.parse(r.responseText);
          if (msg.id) setTimeout(() => deleteDiscordMessage(webhook, msg.id), TRANSIENT_ALERT_TTL_MS);
        } catch {
          console.warn('[TLW] Discord alert posted but response could not be parsed for message id — it will not auto-delete.');
        }
      },
      onerror: () => console.warn('[TLW] Discord alert post request failed (network error).'),
    });
  }

  // ════════════════════════════════════════════════════════════
  //  WATCH LIST
  // ════════════════════════════════════════════════════════════

  // Stored as [{ id, enabled }] rather than a bare id array, so each player
  // can be toggled on/off from the on-page panel without losing their spot
  // in the list.
  function getWatchList() {
    return GM_getValue(LS.watchList, []);
  }

  function getEnabledIds() {
    return getWatchList().filter((e) => e.enabled).map((e) => e.id);
  }

  GM_registerMenuCommand('📋 Set Watched Player IDs', () => {
    const current = getWatchList().map((e) => e.id).join(', ');
    const input = prompt('Enter player IDs to watch, comma-separated (e.g. 1234567, 2345678):', current);
    if (input == null) return;
    const ids = input.split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);

    // Preserve each existing player's enabled/disabled toggle; new entries
    // default to enabled.
    const existingEnabled = new Map(getWatchList().map((e) => [e.id, e.enabled]));
    const newList = ids.map((id) => ({ id, enabled: existingEnabled.has(id) ? existingEnabled.get(id) : true }));
    GM_setValue(LS.watchList, newList);

    // Clear stale baselines for anyone no longer watched, so a re-added ID
    // starts fresh instead of comparing against very old state.
    const lastStatus = GM_getValue(LS.lastStatus, {});
    for (const key of Object.keys(lastStatus)) {
      if (!ids.includes(Number(key))) delete lastStatus[key];
    }
    GM_setValue(LS.lastStatus, lastStatus);
    alert(ids.length ? `Watching ${ids.length} player(s): ${ids.join(', ')}` : 'Watch list cleared.');
  });

  function toggleWatched(id, enabled) {
    const list = getWatchList();
    const entry = list.find((e) => e.id === id);
    if (!entry) return;
    entry.enabled = enabled;
    GM_setValue(LS.watchList, list);
    console.log(`[TLW] ${enabled ? 'Enabled' : 'Disabled'} monitoring for #${id}`);
  }

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
    sendTransientDiscordAlert(`🔔 **${curr.name}**: ${prev.state} → ${curr.state}${curr.description ? ` (${curr.description})` : ''}`);
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
    const ids = getEnabledIds();
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
      // Runs from this tab only (the poll loop's leader), so it can't
      // double-fire the way a cross-tab GM_addValueChangeListener would —
      // unlike the on-page panel, we don't want every open tab editing the
      // same Discord message independently.
      syncDiscordMessage();
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
    panel.innerHTML = '';

    const header = document.createElement('div');
    header.style.cssText = 'font-weight:bold;margin-bottom:4px;';
    header.textContent = '📍 Location Watch';
    panel.appendChild(header);

    const list = getWatchList();
    const lastStatus = GM_getValue(LS.lastStatus, {});

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.style.opacity = '0.7';
      empty.textContent = 'No players watched.';
      panel.appendChild(empty);
      return;
    }

    list.forEach((entry) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:6px;padding:2px 0;';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = entry.enabled;
      checkbox.title = entry.enabled ? 'Uncheck to stop monitoring' : 'Check to resume monitoring';
      checkbox.style.cssText = 'cursor:pointer;flex-shrink:0;margin-top:2px;';
      checkbox.addEventListener('change', () => toggleWatched(entry.id, checkbox.checked));

      const s = lastStatus[entry.id];
      const name = escapeHtml((s && s.name) || `#${entry.id}`);
      const line = s
        ? escapeHtml(formatStatusLine(s.state, s.description))
        : '<span style="opacity:0.7">checking...</span>';

      const label = document.createElement('div');
      label.style.cssText = entry.enabled ? '' : 'opacity:0.4;text-decoration:line-through;';
      label.innerHTML = `<b>${name}</b>: ${line}`;

      row.appendChild(checkbox);
      row.appendChild(label);
      panel.appendChild(row);
    });
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
