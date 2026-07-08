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
// @connect      api.jsonbin.io
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
    deviceHeartbeatMs: 15_000, // how often the active device refreshes the shared cross-device lock
    deviceLockTtlMs: 45_000,   // if the active device hasn't refreshed this long, another laptop takes over
  };

  const API_BASE = 'https://api.torn.com/v2';
  const JSONBIN_BASE = 'https://api.jsonbin.io/v3/b';

  const LS = {
    apiKeys: 'tlw_api_keys', // array of up to CONFIG.maxApiKeys key strings, all on your own account
    apiKeysUpdatedAt: 'tlw_api_keys_updated_at',
    watchList: 'tlw_watch_list',   // array of numeric player IDs
    watchListUpdatedAt: 'tlw_watch_list_updated_at',
    lastStatus: 'tlw_last_status', // { [id]: { state, description } }
    running: 'tlw_running',
    lock: 'tlw_lock',
    discordWebhook: 'tlw_discord_webhook',
    discordMessageId: 'tlw_discord_message_id',
    deviceId: 'tlw_device_id',
    deviceName: 'tlw_device_name',
    devicePriority: 'tlw_device_priority', // lower number = higher priority; default (unset) = 100
    jsonbinId: 'tlw_jsonbin_id',
    jsonbinKey: 'tlw_jsonbin_key',
    showDisabled: 'tlw_show_disabled', // panel-only: whether unchecked players are shown at all
  };

  const DEFAULT_DEVICE_PRIORITY = 100;

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

  // Central setter (instead of calling GM_setValue directly) so every write
  // stamps a timestamp and pushes to the shared jsonbin record, letting
  // other devices pick up the change automatically. See pushConfigToShared()
  // / pullConfigFromRemote() further down.
  function setApiKeys(keys) {
    GM_setValue(LS.apiKeys, keys);
    GM_setValue(LS.apiKeysUpdatedAt, Date.now());
    pushConfigToShared();
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
  //  DISCORD RELAY — optional. Instead of posting a new message per event,
  //  this keeps ONE message alive and edits it in place, mirroring the
  //  on-page panel — a friend watching that Discord channel sees the same
  //  always-current dashboard, not a growing feed of separate alerts.
  // ════════════════════════════════════════════════════════════

  function getDiscordWebhook() {
    return GM_getValue(LS.discordWebhook, '');
  }

  GM_registerMenuCommand('🔔 Set Discord Webhook (for friend)', async () => {
    const current = getDiscordWebhook();
    const url = prompt(
      "Enter a Discord webhook URL to relay a live status dashboard to a friend's channel (Discord: Channel Settings → Integrations → Webhooks → New Webhook → Copy URL). Leave blank to disable:",
      current
    );
    if (url == null) return;
    GM_setValue(LS.discordWebhook, url.trim());
    await setSharedDiscordMessageId(null); // start a fresh message under the new webhook
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

  // Builds the Discord dashboard content. Unlike the on-page panel (which
  // shows disabled players dimmed, since it needs to display their checkbox),
  // unchecked/disabled players are left out of this entirely — a friend
  // watching Discord only sees who's actually being monitored right now.
  function buildDiscordContent() {
    const list = getWatchList().filter((e) => e.enabled);
    const footer = `_from: ${getDeviceName()}_`;
    if (list.length === 0) return `📍 **Location Watch** — no players currently checked.\n${footer}`;
    const lastStatus = GM_getValue(LS.lastStatus, {});
    const lines = list.map((entry) => {
      const s = lastStatus[entry.id];
      const name = (s && s.name) || `#${entry.id}`;
      const line = s ? formatStatusLine(s.state, s.description) : 'checking...';
      return `**${name}**: ${line}`;
    });
    return `📍 **Location Watch**\n${lines.join('\n')}\n\n${footer}`;
  }

  // The message ID to edit has to be shared across devices too, not just
  // the polling lock — otherwise each device remembers its own separate
  // message from whenever it was last active, and you end up with one
  // dashboard message per device instead of one overall. When a
  // cross-device lock is configured, this piggybacks on the same shared
  // jsonbin record (alongside owner/name/ts) instead of local GM storage.
  //
  // It deliberately does NOT fetch jsonbin on every call — sharedRecordCache
  // (populated by the lock heartbeat in refreshDeviceLockIfDue, which already
  // reads the same record every ~15s) is reused instead, since a message id
  // essentially never changes and jsonbin's free tier has a tight request
  // quota. A stale-by-up-to-15s read of the id is harmless.
  async function getSharedDiscordMessageId() {
    if (!GM_getValue(LS.jsonbinId, '') || !GM_getValue(LS.jsonbinKey, '')) {
      return GM_getValue(LS.discordMessageId, null);
    }
    if (!sharedRecordCache) sharedRecordCache = await jsonbinGet();
    return (sharedRecordCache && sharedRecordCache.discordMessageId) || null;
  }

  // Only called when the id actually needs to change (first-ever post, or
  // after a 404) — rare, so an extra jsonbin round trip here is fine. Merges
  // into the cached record rather than overwriting it, so it doesn't clobber
  // the owner/name/ts fields the lock heartbeat also lives in.
  async function setSharedDiscordMessageId(id) {
    if (!GM_getValue(LS.jsonbinId, '') || !GM_getValue(LS.jsonbinKey, '')) {
      GM_setValue(LS.discordMessageId, id);
      return;
    }
    const record = sharedRecordCache || (await jsonbinGet()) || {};
    record.discordMessageId = id;
    await jsonbinPut(record);
    sharedRecordCache = record;
  }

  function postNewDiscordMessage(webhook, content) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${webhook}?wait=true`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ content }),
        onload: async (r) => {
          if (r.status < 200 || r.status >= 300) {
            console.warn(`[TLW] Discord post failed: HTTP ${r.status} — ${r.responseText.slice(0, 200)}`);
            resolve();
            return;
          }
          try {
            const msg = JSON.parse(r.responseText);
            if (msg.id) await setSharedDiscordMessageId(msg.id);
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
    const messageId = await getSharedDiscordMessageId();

    if (!messageId) {
      await postNewDiscordMessage(webhook, content);
      return;
    }

    await new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'PATCH',
        url: `${webhook}/messages/${messageId}`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ content }),
        onload: async (r) => {
          if (r.status === 404) {
            // The message was deleted on Discord's side — start a new one.
            await setSharedDiscordMessageId(null);
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

  // Central setter — same reasoning as setApiKeys() above: stamps a
  // timestamp and pushes to the shared record so other devices sync it.
  function setWatchList(list) {
    GM_setValue(LS.watchList, list);
    GM_setValue(LS.watchListUpdatedAt, Date.now());
    pushConfigToShared();
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
  //
  // Also reads profile.last_action = { status: "Online"|"Idle"|"Offline",
  // timestamp, relative } — another long-standing, well-documented part of
  // Torn's API — to drive the auto-uncheck-after-inactivity feature below.
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
      checkInactivity(curr);
      // Runs from this tab only (the poll loop's leader), so it can't
      // double-fire the way a cross-tab GM_addValueChangeListener would —
      // unlike the on-page panel, we don't want every open tab editing the
      // same Discord message independently. Awaited since it now round-trips
      // through the shared jsonbin record to resolve the shared message id.
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
  // Runs regardless of Start/Stop or which device is active, since it's a
  // one-off manual action, not the background polling loop. Lives as a
  // button in the on-page panel rather than the Tampermonkey menu.
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
  //  CROSS-DEVICE LOCK — same idea as the tab lock above, but backed by
  //  jsonbin.io (a small free JSON storage API) instead of local
  //  GM_setValue, since GM storage doesn't sync between separate laptops.
  //  Whichever device currently holds a fresh lock is the only one that
  //  actually polls; others idle and take over either when the holder's
  //  heartbeat goes stale (it closed its browser, lost network, etc), OR
  //  immediately if a device with a better (lower-numbered) priority comes
  //  online — see getDevicePriority(). Devices left at the default priority
  //  never preempt each other, so with no priorities set this degrades to
  //  plain "whoever claims it first keeps it."
  //
  //  Caveat: jsonbin's plain GET/PUT has no atomic compare-and-swap, so two
  //  devices racing to preempt at the same instant could each briefly think
  //  they won. With a 15s heartbeat this self-corrects within a cycle or
  //  two — acceptable for a couple of personal laptops, not a real consensus
  //  protocol.
  // ════════════════════════════════════════════════════════════

  function getDeviceId() {
    let id = GM_getValue(LS.deviceId, null);
    if (!id) {
      id = 'device-' + Math.random().toString(36).slice(2, 10);
      GM_setValue(LS.deviceId, id);
    }
    return id;
  }

  function getDeviceName() {
    return GM_getValue(LS.deviceName, getDeviceId());
  }

  GM_registerMenuCommand('💻 Name This Device', () => {
    const name = prompt('Give this laptop a name (shown in logs/Discord, e.g. "Laptop 1"):', getDeviceName());
    if (name == null) return;
    GM_setValue(LS.deviceName, name.trim() || getDeviceId());
  });

  function getDevicePriority() {
    return GM_getValue(LS.devicePriority, DEFAULT_DEVICE_PRIORITY);
  }

  GM_registerMenuCommand('🏆 Set Device Priority', () => {
    const input = prompt(
      `Lower number = higher priority. A device with a better priority than whoever currently holds the lock takes over immediately, without waiting for their heartbeat to go stale. Leave all devices at the default (${DEFAULT_DEVICE_PRIORITY}) for the old "whoever's active keeps it" behavior.`,
      String(getDevicePriority())
    );
    if (input == null) return;
    const priority = parseInt(input.trim(), 10);
    if (!Number.isFinite(priority)) {
      alert('That\'s not a valid number.');
      return;
    }
    GM_setValue(LS.devicePriority, priority);
    alert(`This device's priority is now ${priority}.`);
  });

  GM_registerMenuCommand('🌐 Set Cross-Device Lock (jsonbin.io)', async () => {
    const binId = prompt(
      'jsonbin.io Bin ID — create a free account at jsonbin.io, create a bin containing {}, and paste its ID here:',
      GM_getValue(LS.jsonbinId, '')
    );
    if (binId == null) return;
    const apiKey = prompt(
      'jsonbin.io X-Master-Key — from your jsonbin.io account\'s API Keys page:',
      GM_getValue(LS.jsonbinKey, '')
    );
    if (apiKey == null) return;
    GM_setValue(LS.jsonbinId, binId.trim());
    GM_setValue(LS.jsonbinKey, apiKey.trim());

    if (!binId.trim() || !apiKey.trim()) {
      alert('Cross-device lock cleared — this device will always run when Start is clicked, with no other-laptop awareness.');
      return;
    }

    sharedRecordCache = null; // force a fresh read under the newly-set bin
    // API keys / watch list sync as "last full write wins" — the first push
    // under a fresh bin becomes what every other device adopts. Ask which
    // way this device should go, instead of silently picking a winner.
    const pushNow = confirm(
      "Push this device's current API keys and watch list as the shared baseline?\n\n"
      + 'Choose OK on the FIRST device you set this up on, so its list becomes what every other device syncs to.\n'
      + "Choose Cancel on additional devices, so you don't overwrite what the first device just pushed."
    );
    if (pushNow) {
      GM_setValue(LS.apiKeysUpdatedAt, Date.now());
      GM_setValue(LS.watchListUpdatedAt, Date.now());
      await pushConfigToShared();
      alert("Cross-device lock configured, and this device's config pushed as the shared baseline.");
    } else {
      alert('Cross-device lock configured. This device will adopt the shared config on its next check.');
    }
  });

  function jsonbinGet() {
    return new Promise((resolve) => {
      const binId = GM_getValue(LS.jsonbinId, '');
      const apiKey = GM_getValue(LS.jsonbinKey, '');
      if (!binId || !apiKey) { resolve(null); return; }
      GM_xmlhttpRequest({
        method: 'GET',
        url: `${JSONBIN_BASE}/${binId}/latest`,
        headers: { 'X-Master-Key': apiKey },
        onload: (r) => {
          if (r.status < 200 || r.status >= 300) {
            console.warn(`[TLW] Cross-device lock read failed: HTTP ${r.status}`);
            resolve(null);
            return;
          }
          try {
            const data = JSON.parse(r.responseText);
            resolve(data.record || null);
          } catch {
            resolve(null);
          }
        },
        onerror: () => { console.warn('[TLW] Cross-device lock read failed (network error).'); resolve(null); },
      });
    });
  }

  function jsonbinPut(record) {
    return new Promise((resolve) => {
      const binId = GM_getValue(LS.jsonbinId, '');
      const apiKey = GM_getValue(LS.jsonbinKey, '');
      if (!binId || !apiKey) { resolve(false); return; }
      GM_xmlhttpRequest({
        method: 'PUT',
        url: `${JSONBIN_BASE}/${binId}`,
        headers: { 'X-Master-Key': apiKey, 'Content-Type': 'application/json' },
        data: JSON.stringify(record),
        onload: (r) => resolve(r.status >= 200 && r.status < 300),
        onerror: () => { console.warn('[TLW] Cross-device lock write failed (network error).'); resolve(false); },
      });
    });
  }

  // True unless a cross-device lock is configured and another device
  // currently holds it — gates whether this device's loop actually polls.
  // Only re-checked every deviceHeartbeatMs (not every 3s tick) to stay
  // well within jsonbin's free-tier request limits.
  let isDeviceActive = true;
  let lastDeviceLockCheckAt = 0;

  // Last-known copy of the shared jsonbin record (owner/name/ts/
  // discordMessageId), refreshed here every deviceHeartbeatMs. Shared with
  // getSharedDiscordMessageId() above so it doesn't need its own separate
  // (much more frequent) jsonbin reads.
  let sharedRecordCache = null;

  async function refreshDeviceLockIfDue() {
    if (Date.now() - lastDeviceLockCheckAt < CONFIG.deviceHeartbeatMs) return;
    lastDeviceLockCheckAt = Date.now();

    if (!GM_getValue(LS.jsonbinId, '') || !GM_getValue(LS.jsonbinKey, '')) {
      isDeviceActive = true; // no cross-device lock configured — behave as a single device
      return;
    }

    const remote = await jsonbinGet();
    sharedRecordCache = remote;
    pullConfigFromRemote(remote); // adopt newer API keys / watch list from another device, if any
    const now = Date.now();
    const deviceId = getDeviceId();
    const myPriority = getDevicePriority();
    const remotePriority = remote && remote.priority != null ? remote.priority : DEFAULT_DEVICE_PRIORITY;
    const isFree = !remote || !remote.owner;
    const isOurs = remote && remote.owner === deviceId;
    const isStale = remote && now - remote.ts > CONFIG.deviceLockTtlMs;
    // Lower number wins. With everyone left at the default priority this is
    // always false (equal, not strictly less), preserving the original
    // "whoever's active keeps it" behavior unless priorities are actually set.
    const hasBetterPriority = !isOurs && myPriority < remotePriority;

    const wasActive = isDeviceActive;
    if (isFree || isOurs || isStale || hasBetterPriority) {
      // Spread the existing record first so this heartbeat write doesn't
      // clobber discordMessageId (set independently, only when it changes).
      const updated = { ...(remote || {}), owner: deviceId, name: getDeviceName(), priority: myPriority, ts: now };
      const ok = await jsonbinPut(updated);
      if (ok) {
        sharedRecordCache = updated;
        if (!isOurs) {
          const reason = hasBetterPriority && !isFree && !isStale ? ' (higher priority)' : '';
          console.log(`[TLW] This device (${getDeviceName()}) is now the active instance${reason}.`);
        }
      }
      isDeviceActive = ok;
    } else {
      if (isDeviceActive) {
        console.log(`[TLW] Another device (${remote.name || remote.owner}) is active — standing by.`);
      }
      isDeviceActive = false;
    }
    // Nothing else re-renders the panel on a standby device (it never
    // touches lastStatus), so trigger it directly on any state flip.
    if (wasActive !== isDeviceActive) renderPanel();
  }

  // ════════════════════════════════════════════════════════════
  //  CONFIG SYNC — API keys and the watch list piggyback on the same
  //  shared jsonbin record as the lock. Each is "last full write wins":
  //  whichever device most recently changed its list pushes the whole list
  //  + a timestamp; every device (active or standby) adopts it wholesale
  //  whenever the remote timestamp is newer than what it last saw. This
  //  handles both additions AND removals correctly (an item you delete
  //  won't reappear), at the cost of the usual last-write-wins risk: if two
  //  devices edit within the same ~15s window, whichever push lands second
  //  wins outright and the other's edit is silently overwritten. Fine for a
  //  couple of personal laptops, not a real merge/conflict-resolution system.
  // ════════════════════════════════════════════════════════════

  async function pushConfigToShared() {
    if (!GM_getValue(LS.jsonbinId, '') || !GM_getValue(LS.jsonbinKey, '')) return;
    const record = sharedRecordCache || (await jsonbinGet()) || {};
    record.apiKeys = getApiKeys();
    record.apiKeysUpdatedAt = GM_getValue(LS.apiKeysUpdatedAt, 0);
    record.watchList = getWatchList();
    record.watchListUpdatedAt = GM_getValue(LS.watchListUpdatedAt, 0);
    const ok = await jsonbinPut(record);
    if (ok) sharedRecordCache = record;
  }

  function pullConfigFromRemote(remote) {
    if (!remote) return;

    const localApiKeysAt = GM_getValue(LS.apiKeysUpdatedAt, 0);
    if (Array.isArray(remote.apiKeys) && remote.apiKeysUpdatedAt > localApiKeysAt) {
      GM_setValue(LS.apiKeys, remote.apiKeys);
      GM_setValue(LS.apiKeysUpdatedAt, remote.apiKeysUpdatedAt);
      console.log(`[TLW] Synced ${remote.apiKeys.length} API key(s) from another device.`);
    }

    const localWatchListAt = GM_getValue(LS.watchListUpdatedAt, 0);
    if (Array.isArray(remote.watchList) && remote.watchListUpdatedAt > localWatchListAt) {
      GM_setValue(LS.watchList, remote.watchList);
      GM_setValue(LS.watchListUpdatedAt, remote.watchListUpdatedAt);
      console.log(`[TLW] Synced watch list (${remote.watchList.length} player(s)) from another device.`);
      renderPanel(); // reflect the newly-synced list immediately, not just on the next poll
    }
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
    title.textContent = isDeviceActive ? '📍 Location Watch' : '📍 Location Watch (standing by)';
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
      const line = s
        ? escapeHtml(formatStatusLine(s.state, s.description))
        : '<span style="opacity:0.7">checking...</span>';

      const label = document.createElement('div');
      label.style.cssText = (entry.enabled ? '' : 'opacity:0.4;text-decoration:line-through;') + 'flex:1;min-width:0;';
      label.innerHTML = `<b>${name}</b>: ${line}`;

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
      await refreshDeviceLockIfDue();
      if (!isDeviceActive) {
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
