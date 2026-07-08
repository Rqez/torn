// ==UserScript==
// @name         Torn Player Location Watcher
// @namespace    tc-location-watch
// @version      2.0
// @description  Polls the Torn API for a fixed list of player IDs and notifies you when their status changes (Okay/Traveling/Abroad/Hospital/Jail). Single-device only — no external services beyond the Torn API itself.
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
    minApiCallGapMs: 2_000,  // hard floor between ANY two Torn API calls, regardless of key — see apiGet()
    maxApiKeys: 20,
  };

  const API_BASE = 'https://api.torn.com/v2';

  function tornProfileUrl(id) {
    return `https://www.torn.com/profiles.php?XID=${id}`;
  }

  // Embedded directly rather than configured via the Tampermonkey menu.
  // NOTE: this is a live credential — anyone with a copy of this file can
  // post/edit/delete messages through this webhook. Don't commit this file
  // to a public repo.
  const EMBEDDED_DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1524111939754524672/NsekHui8ycey4215OFyDNCVxPOr5HxlJ7JE18y5ugvaIHmczAD91fV1L0zabVYo0DBa4';

  const LS = {
    apiKeys: 'tlw_api_keys', // array of up to CONFIG.maxApiKeys key strings, all on your own account
    watchList: 'tlw_watch_list',   // array of { id, enabled }
    lastStatus: 'tlw_last_status', // { [id]: { name, state, description } }
    running: 'tlw_running',
    lock: 'tlw_lock',
    discordMessageId: 'tlw_discord_message_id', // local-only now (single device, nothing to share)
    showDisabled: 'tlw_show_disabled', // panel-only: whether unchecked players are shown at all
    lastApiCallAt: 'tlw_last_api_call_at', // GM-stored (not in-memory) so the gate holds even across multiple tabs
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

  function setApiKeys(keys) {
    GM_setValue(LS.apiKeys, keys);
  }

  GM_registerMenuCommand(`🔑 Set Torn API Keys (up to ${CONFIG.maxApiKeys})`, () => {
    const current = getApiKeys().join(', ');
    const input = prompt(
      `Enter up to ${CONFIG.maxApiKeys} Torn API keys, comma-separated (all from your own account — generate more at torn.com/preferences.php#tab=api):`,
      current
    );
    if (input == null) return;
    const keys = input.split(',').map((s) => s.trim()).filter(Boolean).slice(0, CONFIG.maxApiKeys);
    setApiKeys(keys);
    alert(keys.length ? `Saved ${keys.length} API key(s).` : 'API keys cleared.');
  });

  // Quicker than editing the full comma-separated list above — just types
  // one new key into a fresh, empty prompt. Lives as a button in the on-page
  // panel rather than the Tampermonkey menu (see the panel's action row).
  function addOneApiKey() {
    const key = prompt('Enter one Torn API key to add:', '');
    if (key == null || !key.trim()) return;
    const keys = getApiKeys();
    if (keys.length >= CONFIG.maxApiKeys) {
      alert(`Already at the max of ${CONFIG.maxApiKeys} keys. Remove one via "Set Torn API Keys" first.`);
      return;
    }
    keys.push(key.trim());
    setApiKeys(keys);
    alert(`Added. Now have ${keys.length} key(s).`);
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

  function setWatchList(list) {
    GM_setValue(LS.watchList, list);
  }

  function getEnabledIds() {
    return getWatchList().filter((e) => e.enabled).map((e) => e.id);
  }

  // Display-only ordering (doesn't touch storage): enabled players first,
  // disabled ones (including auto-unchecked-for-inactivity) sink to the
  // bottom, each group keeping its original relative order.
  function sortEnabledFirst(list) {
    return [...list].sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0));
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
    setWatchList(newList);

    // Clear stale baselines for anyone no longer watched, so a re-added ID
    // starts fresh instead of comparing against very old state.
    const lastStatus = GM_getValue(LS.lastStatus, {});
    for (const key of Object.keys(lastStatus)) {
      if (!ids.includes(Number(key))) delete lastStatus[key];
    }
    GM_setValue(LS.lastStatus, lastStatus);
    alert(ids.length ? `Watching ${ids.length} player(s): ${ids.join(', ')}` : 'Watch list cleared.');
  });

  // Quicker than editing the full comma-separated list above — just types
  // one new ID into a fresh, empty prompt, enabled by default. Lives as a
  // button in the on-page panel rather than the Tampermonkey menu.
  function addOneWatchedId() {
    const input = prompt('Enter one player ID to add:', '');
    if (input == null || !input.trim()) return;
    const id = parseInt(input.trim(), 10);
    if (!Number.isFinite(id) || id <= 0) {
      alert('That doesn\'t look like a valid player ID.');
      return;
    }
    const list = getWatchList();
    if (list.some((e) => e.id === id)) {
      alert(`#${id} is already on the watch list.`);
      return;
    }
    list.push({ id, enabled: true });
    setWatchList(list);
    alert(`Added #${id}. Now watching ${list.length} player(s).`);
  }

  function toggleWatched(id, enabled) {
    const list = getWatchList();
    const entry = list.find((e) => e.id === id);
    if (!entry) return;
    entry.enabled = enabled;
    setWatchList(list);
    console.log(`[TLW] ${enabled ? 'Enabled' : 'Disabled'} monitoring for #${id}`);
  }

  function removeWatched(id) {
    const list = getWatchList().filter((e) => e.id !== id);
    setWatchList(list);
    const lastStatus = GM_getValue(LS.lastStatus, {});
    delete lastStatus[id];
    GM_setValue(LS.lastStatus, lastStatus);
    console.log(`[TLW] Removed #${id} from the watch list.`);
  }

  function getShowDisabled() {
    return GM_getValue(LS.showDisabled, true);
  }

  // ════════════════════════════════════════════════════════════
  //  DISCORD RELAY — keeps ONE message alive and edits it in place instead
  //  of posting a new one per update, so a friend watching that channel sees
  //  an always-current dashboard rather than a growing feed of alerts. The
  //  message id is stored locally (GM_setValue) — fine now that this only
  //  ever runs on one device, so there's nothing to keep in sync.
  // ════════════════════════════════════════════════════════════

  function getDiscordWebhook() {
    return EMBEDDED_DISCORD_WEBHOOK;
  }

  // Unlike the on-page panel (which shows disabled players dimmed, since it
  // needs to display their checkbox), unchecked/disabled players are left
  // out of this entirely — Discord only shows who's actually being
  // monitored right now.
  function buildDiscordContent() {
    const list = getWatchList().filter((e) => e.enabled);
    if (list.length === 0) return '📍 **Location Watch** — no players currently checked.';
    const lastStatus = GM_getValue(LS.lastStatus, {});
    const lines = list.map((entry) => {
      const s = lastStatus[entry.id];
      const name = (s && s.name) || `#${entry.id}`;
      const lastAction = formatLastAction(s);
      // Only the name itself is the link text — the last-action part stays
      // outside the [ ](url) span so it isn't clickable too.
      // Masked markdown links ([text](url)) only render in Discord embeds,
      // not in plain message content — see postNewDiscordMessage/
      // syncDiscordMessage below, which send this as an embed description.
      const namePart = `[${name}](${tornProfileUrl(entry.id)})${lastAction ? ` (${lastAction})` : ''}`;
      const line = s ? formatStatusLine(s.state, s.description) : 'checking...';
      return `**${namePart}**: ${line}`;
    });
    return `📍 **Location Watch**\n${lines.join('\n')}`;
  }

  function getDiscordMessageId() {
    return GM_getValue(LS.discordMessageId, null);
  }

  function setDiscordMessageId(id) {
    GM_setValue(LS.discordMessageId, id);
  }

  // Sent as an embed (not plain `content`) because Discord only renders
  // masked markdown links ([text](url)) inside embeds — plain message
  // content shows the literal "[text](url)" text instead of a hyperlink.
  function postNewDiscordMessage(webhook, content) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${webhook}?wait=true`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ embeds: [{ description: content }] }),
        onload: (r) => {
          if (r.status < 200 || r.status >= 300) {
            console.warn(`[TLW] Discord post failed: HTTP ${r.status} — ${r.responseText.slice(0, 200)}`);
            resolve();
            return;
          }
          try {
            const msg = JSON.parse(r.responseText);
            if (msg.id) setDiscordMessageId(msg.id);
          } catch {
            console.warn('[TLW] Discord post succeeded but response could not be parsed for message id.');
          }
          resolve();
        },
        onerror: () => { console.warn('[TLW] Discord post request failed (network error).'); resolve(); },
      });
    });
  }

  async function syncDiscordMessage() {
    const webhook = getDiscordWebhook();
    if (!webhook) return;
    const content = buildDiscordContent();
    const messageId = getDiscordMessageId();

    if (!messageId) {
      await postNewDiscordMessage(webhook, content);
      return;
    }

    await new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'PATCH',
        url: `${webhook}/messages/${messageId}`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ embeds: [{ description: content }] }),
        onload: async (r) => {
          if (r.status === 404) {
            // The message was deleted on Discord's side — start a new one.
            setDiscordMessageId(null);
            await postNewDiscordMessage(webhook, content);
          } else if (r.status < 200 || r.status >= 300) {
            console.warn(`[TLW] Discord edit failed: HTTP ${r.status} — ${r.responseText.slice(0, 200)}`);
          }
          resolve();
        },
        onerror: () => { console.warn('[TLW] Discord edit request failed (network error).'); resolve(); },
      });
    });
  }

  // Separate from the persistent dashboard message above — this posts a
  // one-off "something changed" ping that self-deletes ~10s later, so you
  // get an actual notification-style blip instead of only the
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

  // Plain content, not an embed — this is a quick transient ping, so it
  // shouldn't get the boxed embed treatment (which is also the only reason
  // the persistent dashboard message uses one, to render its masked link).
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
  //  RATE-GATED HTTP
  // ════════════════════════════════════════════════════════════

  let rotationIndex = 0;

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

  // Global floor, not per-key — every single Torn API call (whichever key
  // it uses, whichever code path triggered it: the background loop, the
  // manual "Check all" button, or — in the unexpected case the tab lock
  // ever fails to exclude it — a second tab) waits for at least
  // minApiCallGapMs since the LAST call of any kind. Backed by GM storage
  // rather than an in-memory timestamp so the floor holds across tabs, not
  // just within one.
  async function apiGet(path) {
    const key = nextApiKey();
    if (!key) throw new Error('no_api_keys');

    const lastCallAt = GM_getValue(LS.lastApiCallAt, 0);
    const wait = CONFIG.minApiCallGapMs - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    GM_setValue(LS.lastApiCallAt, Date.now());

    const keySlot = getApiKeys().indexOf(key) + 1;
    console.log(`[TLW] API call: ${path} @ ${new Date().toLocaleTimeString()} (key #${keySlot})`);

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
  // Abroad, Federal.
  //
  // Also reads profile.last_action = { status: "Online"|"Idle"|"Offline",
  // timestamp, relative } to drive the auto-uncheck-after-inactivity feature
  // below.
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
      lastActionStatus: profile.last_action ? profile.last_action.status : null,
      lastActionTimestamp: profile.last_action ? profile.last_action.timestamp : null,
      lastActionRelative: profile.last_action ? profile.last_action.relative : null,
    };
  }

  const INACTIVITY_TTL_SEC = 60 * 60; // auto-uncheck after this long offline

  // Auto-disables (unchecks) a player once they've been Offline for over an
  // hour — they still stay on the list (and can be manually re-checked
  // anytime), just stop consuming a check-slot in the round-robin. Doesn't
  // re-enable them automatically if they come back online, since a disabled
  // player is no longer being checked at all.
  function checkInactivity(curr) {
    if (curr.lastActionStatus !== 'Offline' || !curr.lastActionTimestamp) return;
    const offlineSec = Date.now() / 1000 - curr.lastActionTimestamp;
    if (offlineSec <= INACTIVITY_TTL_SEC) return;

    const list = getWatchList();
    const entry = list.find((e) => e.id === curr.id);
    if (entry && entry.enabled) {
      entry.enabled = false;
      setWatchList(list);
      console.log(`[TLW] Auto-unchecked ${curr.name} (#${curr.id}) — offline for over 1 hour.`);
    }
  }

  // Torn's description already says everything the state word would (e.g.
  // description="Traveling to Mexico", "In a hospital for 3 mins", "Okay") —
  // showing "Traveling — Traveling to Mexico" is redundant, so just use the
  // description, falling back to the bare state on the rare chance it's
  // missing.
  function formatStatusLine(state, description) {
    return description || state;
  }

  // Torn's own human-readable relative time ("3 minutes ago") — falls back
  // to a simple computed version from the raw timestamp if relative wasn't
  // present in the response for some reason.
  function timeAgo(unixSeconds) {
    const diffSec = Math.max(0, Date.now() / 1000 - unixSeconds);
    if (diffSec < 60) return 'just now';
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function formatLastAction(s) {
    if (!s) return null;
    if (s.lastActionRelative) return s.lastActionRelative;
    if (s.lastActionTimestamp) return timeAgo(s.lastActionTimestamp);
    return null;
  }

  function notifyChange(prev, curr) {
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
        lastStatus[id] = {
          name: curr.name,
          state: curr.state,
          description: curr.description,
          lastActionStatus: curr.lastActionStatus,
          lastActionTimestamp: curr.lastActionTimestamp,
          lastActionRelative: curr.lastActionRelative,
        };
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
        lastStatus[id] = {
          name: curr.name,
          state: curr.state,
          description: curr.description,
          lastActionStatus: curr.lastActionStatus,
          lastActionTimestamp: curr.lastActionTimestamp,
          lastActionRelative: curr.lastActionRelative,
        };
        GM_setValue(LS.lastStatus, lastStatus);
      }
      checkInactivity(curr);
      await syncDiscordMessage();
    } catch (e) {
      console.warn(`[TLW] Failed to fetch status for ${id}:`, e.message);
    }
  }

  // On-demand full refresh — checks every watched player right away instead
  // of waiting for the round-robin to reach them (which can take a while
  // with a long watch list). Re-checks (enables) EVERYONE first, including
  // players previously auto-unchecked for inactivity, so the API actually
  // re-evaluates them — checkInactivity() inside checkOnePlayer() then
  // unchecks anyone still offline for over an hour based on the fresh data.
  // Runs regardless of Start/Stop, since it's a one-off manual action, not
  // the background polling loop. Lives as a button in the on-page panel
  // rather than the Tampermonkey menu.
  async function checkAllPlayersNow() {
    if (getApiKeys().length === 0) {
      alert('Set at least one Torn API key first.');
      return;
    }
    const list = getWatchList();
    if (list.length === 0) {
      alert('No players on the watch list yet.');
      return;
    }

    list.forEach((e) => { e.enabled = true; });
    setWatchList(list);

    console.log(`[TLW] Manually checking all ${list.length} player(s)...`);
    for (const entry of list) {
      try {
        await checkOnePlayer(entry.id);
      } catch (e) {
        console.error(`[TLW] Manual check failed for #${entry.id}:`, e.message);
      }
    }
    console.log('[TLW] Manual check-all complete.');
  }

  // ════════════════════════════════════════════════════════════
  //  LEADER LOCK — avoid duplicate polling/API calls across multiple open
  //  tabs on THIS device (purely local GM storage, no network involved).
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
      max-width: 280px;
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

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px;gap:6px;';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;';
    title.textContent = '📍 Location Watch';
    headerRow.appendChild(title);

    const showDisabled = getShowDisabled();
    const toggleShow = document.createElement('span');
    toggleShow.textContent = showDisabled ? 'hide unchecked' : 'show unchecked';
    toggleShow.title = showDisabled ? 'Hide unchecked players from this panel' : 'Show unchecked players in this panel';
    toggleShow.style.cssText = 'cursor:pointer;font-weight:normal;font-size:10px;opacity:0.6;text-decoration:underline;flex-shrink:0;';
    toggleShow.addEventListener('click', () => {
      GM_setValue(LS.showDisabled, !showDisabled);
      renderPanel();
    });
    headerRow.appendChild(toggleShow);
    panel.appendChild(headerRow);

    const actionsRow = document.createElement('div');
    actionsRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;';
    const actionButtonStyle = 'cursor:pointer;font-size:10px;padding:2px 6px;border-radius:4px;'
      + 'border:1px solid #555;background:#333;color:#eee;';
    const makeActionButton = (label, title, onClick) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.title = title;
      btn.style.cssText = actionButtonStyle;
      btn.addEventListener('click', onClick);
      return btn;
    };
    actionsRow.appendChild(makeActionButton('🔄 Check all', 'Check every watched player right now', checkAllPlayersNow));
    actionsRow.appendChild(makeActionButton('🔑 +Key', 'Add one Torn API key', addOneApiKey));
    actionsRow.appendChild(makeActionButton('➕ +ID', 'Add one watched player ID', addOneWatchedId));
    panel.appendChild(actionsRow);

    const fullList = getWatchList();
    const list = sortEnabledFirst(fullList).filter((e) => e.enabled || showDisabled);
    const lastStatus = GM_getValue(LS.lastStatus, {});

    if (fullList.length === 0) {
      const empty = document.createElement('div');
      empty.style.opacity = '0.7';
      empty.textContent = 'No players watched.';
      panel.appendChild(empty);
      return;
    }
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.style.opacity = '0.7';
      empty.textContent = 'All unchecked (hidden — click "show unchecked" above).';
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
      const rawName = (s && s.name) || `#${entry.id}`;
      const name = escapeHtml(rawName);
      const lastAction = escapeHtml(formatLastAction(s) || '');
      const line = s
        ? escapeHtml(formatStatusLine(s.state, s.description))
        : '<span style="opacity:0.7">checking...</span>';

      const label = document.createElement('div');
      label.style.cssText = (entry.enabled ? '' : 'opacity:0.4;text-decoration:line-through;') + 'flex:1;min-width:0;';
      label.innerHTML = `<a href="${tornProfileUrl(entry.id)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;"><b>${name}</b></a>`
        + `${lastAction ? ` <span style="opacity:0.55;font-size:10px;">(${lastAction})</span>` : ''}: ${line}`;

      const trash = document.createElement('span');
      trash.textContent = '🗑️';
      trash.title = 'Remove from watch list';
      trash.style.cssText = 'cursor:pointer;flex-shrink:0;margin-left:auto;opacity:0.6;';
      trash.addEventListener('click', () => {
        if (confirm(`Remove ${rawName} (#${entry.id}) from the watch list?`)) removeWatched(entry.id);
      });

      row.appendChild(checkbox);
      row.appendChild(label);
      row.appendChild(trash);
      panel.appendChild(row);
    });
  }

  // Any tab re-renders whenever the shared state changes, so the panel
  // stays live even in tabs that aren't doing the polling.
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
