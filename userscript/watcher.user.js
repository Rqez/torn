// ==UserScript==
// @name         Torn Player Location Watcher
// @namespace    tc-location-watch
// @version      4.1
// @description  Always-on: polls the Torn API for a fixed list of player IDs and notifies you when their status changes (Okay/Traveling/Abroad/Hospital/Jail). Also tracks Canada's Xanax stock via YATA and Prombot and pings Discord on restock. Runs as part of a hivemind where a self-hosted watcher server (embedded URL, see torn-watcher-server/) arbitrates which single device leads — API keys/watch list only sync via explicit Push/Pull panel buttons.
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
// @connect      yata.yt
// @connect      prombot.co.uk
// @connect      canadaxanax.duckdns.org
// @downloadURL  https://github.com/Rqez/torn/blob/main/userscript/watcher.user.js
// @updateURL    https://github.com/Rqez/torn/blob/main/userscript/watcher.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════
  //  CONFIG
  // ════════════════════════════════════════════════════════════

  const CONFIG = {
    checkGapMs: 1_000,       // gap between checking one profile and the next (not per full cycle)
    minApiCallGapMs: 1_000,  // hard floor between ANY two Torn API calls, regardless of key — see apiGet()
    maxApiKeys: 20,
    // How often this device heartbeats the watcher server (if one is
    // configured) to refresh/attempt the cross-device lock. This is our own
    // server now, not a third-party quota-limited store, so it's fine to be
    // frequent — just needs to stay comfortably under the server's own
    // DEVICE_LOCK_TTL_MS (20s) so a healthy device's lease never lapses.
    deviceHeartbeatMs: 7_000,
    // How often to poll YATA for the Canada Xanax stock check further down.
    // Unrelated to minApiCallGapMs — YATA is a separate, unauthenticated,
    // unrated endpoint, not a Torn API call.
    yataPollMs: 15_000,
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

  // Separate webhook, posted to whenever Canada's Xanax hits 0 — its whole
  // purpose is for a reminder bot sitting in that channel to pick up the
  // plain-text "command" below. NOTE: a webhook can only ever post plain
  // message text — it cannot actually invoke a real Discord slash command
  // (those are interactions only a user/authorized bot can trigger). This
  // only does anything if the target bot is specifically built to also
  // parse that exact text pattern from a plain message.
  const EMBEDDED_REMINDER_WEBHOOK = 'https://discord.com/api/webhooks/1525506946466058350/I8LeeLYkRSnxdVD4ursdciW8P3qJERPP4L5NxFWI-5NfV3cZL5ojibyD6AoEXTD2CilO';

  // Embedded directly — no more "Set Watcher Server URL" menu command.
  // Served over HTTPS via Caddy (reverse-proxying to the Node server on
  // localhost:8787, with an auto-renewing Let's Encrypt cert) rather than
  // hitting the VM's raw IP:port directly. Update this constant (and the
  // @connect entry above, and re-save the script in Tampermonkey) if the
  // domain or VM ever changes.
  const EMBEDDED_SERVER_URL = 'https://canadaxanax.duckdns.org';

  // Default shared secret — must match config.txt's sharedSecret= on the
  // server for anything to actually be enforced. Editable via the "🔒 Set
  // Server Shared Secret" menu command below without touching this file.
  const DEFAULT_SERVER_SECRET = '24a9c856ec1fea1c455ef4f84eb6472fada87c9b46ba9096';

  const LS = {
    apiKeys: 'tlw_api_keys', // array of up to CONFIG.maxApiKeys key strings, all on your own account
    watchList: 'tlw_watch_list',   // array of { id, enabled }
    lastStatus: 'tlw_last_status', // { [id]: { name, state, description } }
    lock: 'tlw_lock',
    // Separate lock, independent of `lock` above — the Xanax poll runs on
    // its own timer, completely independent of the main player-watching
    // loop, so it can't rely on that loop's tab lock. Ensures only one tab
    // (on THIS device) does the Xanax->Discord sync even with multiple
    // tabs open.
    xanaxLock: 'tlw_xanax_lock',
    lastDiscordCreateAt: 'tlw_last_discord_create_at', // safety net — see postNewDiscordMessage()
    xanaxStock: 'tlw_xanax_stock', // { quantity, cost, updatedAt, zeroAt, spawnAt, source } — last known Canada Xanax stock (source: 'yata' or 'prombot', whichever was freshest)
    showDisabled: 'tlw_show_disabled', // panel-only: whether unchecked players are shown at all
    lastApiCallAt: 'tlw_last_api_call_at', // GM-stored (not in-memory) so the gate holds even across multiple tabs
    serverSecret: 'tlw_server_secret', // must match the server's config.txt sharedSecret= — editable via menu
    notifySuppressUntil: 'tlw_notify_suppress_until', // set by checkAllPlayersNow() — see CHECK_ALL_NOTIFY_SUPPRESS_MS
    deviceId: 'tlw_device_id',
    deviceName: 'tlw_device_name',
    devicePriority: 'tlw_device_priority', // lower number = higher priority; default (unset) = 100
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

  // Always watched, regardless of inactivity — see checkInactivity() below —
  // and always rendered last (both on-page panel and Discord dashboard),
  // regardless of enabled/disabled state or storage order.
  const PINNED_PLAYER_IDS = [2209950, 2670154];

  // Display-only ordering (doesn't touch storage): moves any pinned ids to
  // the very end, after whatever other ordering (e.g. sortEnabledFirst)
  // already ran.
  function withPinnedLast(list) {
    const rest = list.filter((e) => !PINNED_PLAYER_IDS.includes(e.id));
    const pinned = list.filter((e) => PINNED_PLAYER_IDS.includes(e.id));
    return [...rest, ...pinned];
  }

  // Adds any pinned id missing from the watch list (enabled by default) —
  // runs once at script load so the pinned players are always present
  // without needing to be added manually.
  function ensurePinnedPlayersWatched() {
    const list = getWatchList();
    let changed = false;
    for (const id of PINNED_PLAYER_IDS) {
      if (!list.some((e) => e.id === id)) {
        list.push({ id, enabled: true });
        changed = true;
      }
    }
    if (changed) setWatchList(list);
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
  //  DEVICE IDENTITY — used by the cross-device lock below to tell devices
  //  apart and decide who leads.
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
    const name = prompt('Give this device a name (shown in logs/Discord, e.g. "Laptop 1"):', getDeviceName());
    if (name == null) return;
    GM_setValue(LS.deviceName, name.trim() || getDeviceId());
  });

  function getDevicePriority() {
    return GM_getValue(LS.devicePriority, DEFAULT_DEVICE_PRIORITY);
  }

  GM_registerMenuCommand('🏆 Set Device Priority', () => {
    const input = prompt(
      `Lower number = higher priority. A device with a better priority than whoever currently holds the lead takes over immediately, without waiting for their heartbeat to go stale. Leave all devices at the default (${DEFAULT_DEVICE_PRIORITY}) for plain "whoever's active keeps it" behavior.`,
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

  // ════════════════════════════════════════════════════════════
  //  WATCHER SERVER SYNC — talks to a self-hosted torn-watcher-server
  //  hivemind instance (see torn-watcher-server/) purely to arbitrate
  //  leadership: whichever device reports the best priority and keeps
  //  heartbeating is the one allowed to actually poll Torn/post to Discord;
  //  everyone else stands by. The server does NOT automatically sync API
  //  keys/watch list anymore — that only happens when you explicitly click
  //  the panel's Push/Pull buttons (see pushToServer()/pullFromServer()
  //  below), so nothing changes on either side unless you ask for it.
  // ════════════════════════════════════════════════════════════

  function getServerUrl() {
    return EMBEDDED_SERVER_URL;
  }

  function getServerSecret() {
    return GM_getValue(LS.serverSecret, DEFAULT_SERVER_SECRET);
  }

  GM_registerMenuCommand('🔒 Set Server Shared Secret', () => {
    const secret = prompt(
      "Shared secret sent as X-Shared-Secret to the watcher server — must match config.txt's sharedSecret= on the server exactly, or requests get rejected. Leave blank to disable sending one:",
      getServerSecret()
    );
    if (secret == null) return;
    GM_setValue(LS.serverSecret, secret.trim());
    alert(secret.trim() ? 'Server shared secret updated.' : 'Server shared secret cleared — requests will be sent with no secret header.');
  });

  function serverRequest(path, body) {
    const base = getServerUrl();
    if (!base) return Promise.resolve(null);
    const secret = getServerSecret();
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${base}${path}`,
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { 'X-Shared-Secret': secret } : {}),
        },
        data: JSON.stringify(body),
        onload: (r) => {
          if (r.status < 200 || r.status >= 300) {
            console.warn(`[TLW] Watcher server ${path} failed: HTTP ${r.status} — ${r.responseText.slice(0, 200)}`);
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(r.responseText));
          } catch {
            resolve(null);
          }
        },
        onerror: () => { console.warn(`[TLW] Watcher server ${path} request failed (network error).`); resolve(null); },
      });
    });
  }

  // True unless another device currently holds the lead — gates whether
  // this device's loop actually polls.
  //
  // Starts false and stays false until the FIRST successful heartbeat
  // confirms otherwise — deliberately NOT defaulting to true, because if
  // this device can never actually reach the server (wrong URL, firewall,
  // Tampermonkey never approved the connection, etc.), heartbeatTick()
  // never gets a chance to correct it, and it would otherwise sit there
  // believing it's the leader forever — running head-to-head with whatever
  // the server or another device is doing, with neither one ever standing
  // down.
  let isDeviceActive = false;
  let hasEverHeartbeatSucceeded = false;

  // Runs on its OWN independent timer (see setInterval below) rather than
  // being awaited inline in the main player-checking loop — a heartbeat is
  // a real network round trip to the watcher server, and awaiting it there
  // meant that whenever it happened to be slow (a cold TLS handshake, a
  // brief network hiccup), the ENTIRE player-checking loop stalled right
  // along with it, producing exactly the periodic multi-second gaps
  // between Torn API calls that this was supposed to prevent. Now a slow
  // or failed heartbeat only delays this function's own next tick, and
  // never touches the per-player check cadence at all.
  async function heartbeatTick() {
    const wasActive = isDeviceActive;
    const res = await serverRequest('/api/heartbeat', {
      deviceId: getDeviceId(),
      name: getDeviceName(),
      priority: getDevicePriority(),
    });
    if (!res) {
      if (!hasEverHeartbeatSucceeded) {
        // Never once reached the server — almost certainly a wrong URL,
        // firewall, or an unapproved cross-origin request, not a transient
        // blip. Standing by (isDeviceActive was never set true to begin
        // with) rather than guessing active, so this device can't end up
        // fighting the server or another device for the lead.
        console.warn('[TLW] Heartbeat has never succeeded — check the watcher server URL/connectivity (Tampermonkey may be prompting for a connection permission). Standing by until it can be confirmed.');
      } else {
        // Server unreachable — keep doing whatever we were already doing
        // rather than guessing; the next heartbeat will sort it out.
        console.warn('[TLW] Heartbeat failed — watcher server unreachable.');
      }
      return;
    }
    hasEverHeartbeatSucceeded = true;
    isDeviceActive = res.active;

    if (isDeviceActive && !wasActive) {
      console.log('[TLW] This device is now the active instance.');
    } else if (!isDeviceActive && wasActive) {
      console.log(`[TLW] Another device (${res.owner ? res.owner.name : 'unknown'}) is active — standing by.`);
    }
    if (wasActive !== isDeviceActive) renderPanel();
  }

  async function heartbeatLoop() {
    while (true) {
      try {
        await heartbeatTick();
      } catch (e) {
        console.error('[TLW] Heartbeat tick failed:', e.message);
      }
      await sleep(CONFIG.deviceHeartbeatMs);
    }
  }

  heartbeatLoop();

  // Explicit, button-triggered overwrite of the server's copy — the server
  // also enforces leader-only server-side (see handlePush() in server.js),
  // this check just gives immediate feedback instead of waiting on a 403.
  async function pushToServer() {
    if (!isDeviceActive) {
      alert('Only the currently active/leading device can push. This device is standing by.');
      return;
    }
    const apiKeys = getApiKeys();
    const watchList = getWatchList();
    const res = await serverRequest('/api/push', { deviceId: getDeviceId(), apiKeys, watchList });
    if (res && res.ok) {
      alert(`Pushed ${apiKeys.length} key(s) and ${watchList.length} player(s) to the server, overwriting what was there.`);
    } else {
      alert('Push failed — see the browser console for details.');
    }
  }

  // Explicit, button-triggered overwrite of THIS device's local list — no
  // leadership requirement, any device can pull the server's current copy.
  async function pullFromServer() {
    const res = await serverRequest('/api/pull', { deviceId: getDeviceId() });
    if (!res) {
      alert('Pull failed — see the browser console for details.');
      return;
    }
    const apiKeys = Array.isArray(res.apiKeys) ? res.apiKeys : [];
    const watchList = Array.isArray(res.watchList) ? res.watchList : [];
    GM_setValue(LS.apiKeys, apiKeys);
    GM_setValue(LS.watchList, watchList);
    renderPanel();
    alert(`Pulled ${apiKeys.length} key(s) and ${watchList.length} player(s) from the server, overwriting this device's list.`);
  }

  // ════════════════════════════════════════════════════════════
  //  DISCORD RELAY — keeps ONE message alive and edits it in place instead
  //  of posting a new one per update, so a friend watching that channel sees
  //  an always-current dashboard rather than a growing feed of alerts. The
  //  message id lives on the watcher server (if configured) so leadership
  //  can switch devices without ending up with two separate dashboard
  //  messages — falls back to local storage in single-device mode.
  // ════════════════════════════════════════════════════════════

  function getDiscordWebhook() {
    return EMBEDDED_DISCORD_WEBHOOK;
  }

  function buildXanaxStockLine() {
    const xanax = GM_getValue(LS.xanaxStock, null);
    if (!xanax) return '🇨🇦 Xanax: checking...';
    const costPart = xanax.quantity > 0 ? ` @ $${xanax.cost.toLocaleString()}` : '';
    const sourceTag = xanax.source ? ` (${xanax.source})` : '';
    let line = `🇨🇦 Xanax: **${xanax.quantity.toLocaleString()}**${costPart}${sourceTag}`;
    const flyTimer = xanaxFlyTimer(xanax);
    if (flyTimer) line += `\nHit 0 at ${flyTimer.zeroTimeStr} — Fly at ${flyTimer.flyTimeStr}`;
    return line;
  }

  // Unlike the on-page panel (which shows disabled players dimmed, since it
  // needs to display their checkbox), unchecked/disabled players are left
  // out of this entirely — Discord only shows who's actually being
  // monitored right now.
  function buildDiscordContent() {
    const list = withPinnedLast(getWatchList().filter((e) => e.enabled));
    const footer = `_from: ${getDeviceName()}_`;
    const xanaxLine = buildXanaxStockLine();
    if (list.length === 0) return `📍 **Location Watch** — no players currently checked.\n${xanaxLine}\n${footer}`;
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
    return `📍 **Location Watch**\n${lines.join('\n')}\n\n${xanaxLine}\n${footer}`;
  }

  // Reads/writes the watcher server's shared discordMessageId, so
  // leadership can hand off between devices without ending up with two
  // separate dashboard messages. Deliberately no caching — always asks the
  // server fresh — since a stale local cache getting out of sync with the
  // server's actual value is exactly what caused a new dashboard message to
  // get created on every single check in the past. This server is on the
  // same LAN/personal box, so an extra request per check is cheap;
  // correctness matters far more here than saving a round trip.
  // Returns undefined (not null) when the server couldn't be reached at
  // all — distinct from a successful response confirming no message id yet.
  // Collapsing both cases to the same falsy value is what caused duplicate
  // dashboard messages: a transient server hiccup would look identical to
  // "no message exists", so the caller would create a brand new one instead
  // of just skipping that sync and retrying shortly after.
  async function getSharedDiscordMessageId() {
    const res = await serverRequest('/api/discord-message-id', { deviceId: getDeviceId() });
    if (!res) return undefined;
    return res.discordMessageId || null;
  }

  async function setSharedDiscordMessageId(id) {
    const res = await serverRequest('/api/discord-message-id', { deviceId: getDeviceId(), messageId: id });
    if (!res || !res.ok) {
      console.warn('[TLW] Failed to update the shared Discord message id on the server.');
    }
  }

  // Safety net: even if something above keeps thinking no dashboard message
  // exists, this caps it at one new message per MIN_DISCORD_CREATE_GAP_MS
  // instead of spamming a fresh one on every check.
  const MIN_DISCORD_CREATE_GAP_MS = 30_000;

  // Sent as an embed (not plain `content`) because Discord only renders
  // masked markdown links ([text](url)) inside embeds — plain message
  // content shows the literal "[text](url)" text instead of a hyperlink.
  function postNewDiscordMessage(webhook, content) {
    const lastCreateAt = GM_getValue(LS.lastDiscordCreateAt, 0);
    if (Date.now() - lastCreateAt < MIN_DISCORD_CREATE_GAP_MS) {
      console.warn('[TLW] Skipping new Discord dashboard message — one was already created recently; will retry next check.');
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${webhook}?wait=true`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ embeds: [{ description: content }] }),
        onload: async (r) => {
          if (r.status < 200 || r.status >= 300) {
            console.warn(`[TLW] Discord post failed: HTTP ${r.status} — ${r.responseText.slice(0, 200)}`);
            resolve();
            return;
          }
          try {
            const msg = JSON.parse(r.responseText);
            if (msg.id) {
              GM_setValue(LS.lastDiscordCreateAt, Date.now());
              await setSharedDiscordMessageId(msg.id);
            }
          } catch {
            console.warn('[TLW] Discord post succeeded but response could not be parsed for message id.');
          }
          resolve();
        },
        onerror: () => { console.warn('[TLW] Discord post request failed (network error).'); resolve(); },
      });
    });
  }

  // The main player-watching loop AND the independent Xanax poll (see
  // pollCanadaXanaxStock() further down) both call this — they run on
  // completely separate timers with no coordination between them, so
  // without this guard they can genuinely overlap (most likely right at
  // startup, before any dashboard message exists yet): both see "no
  // messageId" at the same moment and both create their own message. This
  // just serializes calls WITHIN this one tab; skipping (rather than
  // queuing) is fine since whichever call loses just gets picked up by
  // its own next cycle a moment later.
  let discordSyncInFlight = false;

  async function syncDiscordMessage() {
    if (discordSyncInFlight) return;
    discordSyncInFlight = true;
    try {
      await syncDiscordMessageInner();
    } finally {
      discordSyncInFlight = false;
    }
  }

  async function syncDiscordMessageInner() {
    const webhook = getDiscordWebhook();
    if (!webhook) return;
    const content = buildDiscordContent();
    const messageId = await getSharedDiscordMessageId();

    if (messageId === undefined) {
      console.warn('[TLW] Could not reach the watcher server for the dashboard message id — skipping this sync rather than risking a duplicate message.');
      return;
    }

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
  //  FOREIGN STOCK — Canada's Xanax stock only, cross-checked from two
  //  independent public sources (YATA and Prombot — neither needs a Torn API
  //  key). Whichever reports the more recent "last updated" time is treated
  //  as current. Shown in the on-page panel and the Discord dashboard
  //  (tagged with which source it came from), and pings the Discord webhook
  //  when stock jumps from 0 to something else (a restock). Polls on its own
  //  timer, independent of the Start/Stop player-watching loop below.
  // ════════════════════════════════════════════════════════════

  const YATA_EXPORT_URL = 'https://yata.yt/api/v1/travel/export/';
  const PROMBOT_TRAVEL_URL = 'https://prombot.co.uk:8443/api/travel';
  // How long after Canada's Xanax hits 0 the "Fly at" timer points to — 1h23m.
  const XANAX_FLY_DELAY_MS = ((1 * 60) + 23) * 60 * 1000;
  // Once stock is confirmed at 0, hold that reading (and zeroAt) for this
  // long before trusting a new candidate again — see the comment in
  // pollCanadaXanaxStock() below for why.
  const XANAX_ZERO_LOCK_MS = 10 * 60 * 1000;
  // Same race, opposite direction: once Xanax is confirmed to have spawned
  // (0 -> nonzero), hold that reading (and spawnAt) for this long even if a
  // candidate still reports 0 — whichever source hasn't caught up to the
  // real restock yet can otherwise flip the display straight back to 0
  // moments after it was correctly detected.
  const XANAX_SPAWN_LOCK_MS = 2 * 60 * 1000;

  function gmFetchJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (r) => {
          if (r.status < 200 || r.status >= 300) {
            reject(new Error(`HTTP ${r.status}`));
            return;
          }
          try {
            resolve(JSON.parse(r.responseText));
          } catch {
            reject(new Error('Non-JSON response'));
          }
        },
        onerror: () => reject(new Error('network_error')),
      });
    });
  }

  // YATA's export and Prombot's travel API happen to share this exact shape:
  // { stocks: { [countryKey]: { update: unixSeconds, stocks: [{ name, quantity, cost }] } } }
  function extractCanadaXanax(data) {
    const canada = data && data.stocks && data.stocks.can;
    if (!canada || !Array.isArray(canada.stocks)) return null;
    const xanax = canada.stocks.find((it) => it.name === 'Xanax');
    if (!xanax) return null;
    const quantity = xanax.quantity ?? xanax.stock ?? xanax.qty ?? 0;
    return { quantity, cost: xanax.cost, updatedAt: canada.update };
  }

  async function fetchYataCanadaXanax() {
    const info = extractCanadaXanax(await gmFetchJson(YATA_EXPORT_URL));
    return info ? { ...info, source: 'yata' } : null;
  }

  async function fetchPrombotCanadaXanax() {
    const info = extractCanadaXanax(await gmFetchJson(PROMBOT_TRAVEL_URL));
    return info ? { ...info, source: 'prombot' } : null;
  }

  // Renders the "Hit 0 at / Fly at" timer pair for a stored xanaxStock
  // record, or null while there's no known zero-timestamp (or stock is
  // currently in stock, at which point the timer is no longer relevant).
  function xanaxFlyTimer(xanax) {
    if (!xanax || xanax.quantity !== 0 || !xanax.zeroAt) return null;
    return {
      zeroTimeStr: new Date(xanax.zeroAt).toLocaleTimeString(),
      flyTimeStr: new Date(xanax.zeroAt + XANAX_FLY_DELAY_MS).toLocaleTimeString(),
    };
  }

  // 24-hour HH:MM, e.g. "18:52" — the reminder bot's time: parameter needs
  // this specific format, distinct from the 12-hour-with-seconds string
  // used for the on-page panel/Discord dashboard display elsewhere.
  function formatTime24(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // Fired once, right when Xanax hits 0 (not on every poll during the
  // zero-lock window). Posts two plain messages to the separate reminder
  // webhook: the reminder-bot "command" text, and Discord's own <t:...:F>
  // timestamp token (which Discord renders as a localized date/time for
  // anyone viewing it — this one needs Unix seconds specifically, not a
  // locale string).
  function fireXanaxFlyReminder(flyTimeMs) {
    const flyTimeStr = formatTime24(flyTimeMs);
    const unixSeconds = Math.floor(flyTimeMs / 1000);

    const commandText = `/reminder add reason:Xanax time:${flyTimeStr} ping:@Farming Bozos message_content: FLY BOZOS`;
    const timestampText = `<t:${unixSeconds}:F>`;

    for (const content of [commandText, timestampText]) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${EMBEDDED_REMINDER_WEBHOOK}?wait=true`,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ content }),
        onload: (r) => {
          if (r.status < 200 || r.status >= 300) {
            console.warn(`[TLW] Reminder webhook post failed: HTTP ${r.status} — ${r.responseText.slice(0, 200)}`);
          }
        },
        onerror: () => console.warn('[TLW] Reminder webhook post failed (network error).'),
      });
    }
  }

  async function pollCanadaXanaxStock() {
    const [yataResult, prombotResult] = await Promise.allSettled([
      fetchYataCanadaXanax(),
      fetchPrombotCanadaXanax(),
    ]);
    if (yataResult.status === 'rejected') console.warn('[TLW] YATA Canada Xanax fetch failed:', yataResult.reason.message);
    if (prombotResult.status === 'rejected') console.warn('[TLW] Prombot Canada Xanax fetch failed:', prombotResult.reason.message);

    const candidates = [yataResult, prombotResult]
      .filter((r) => r.status === 'fulfilled' && r.value)
      .map((r) => r.value);
    if (candidates.length === 0) return;

    const prev = GM_getValue(LS.xanaxStock, null);

    // YATA and Prombot scrape/update independently, so right after a real
    // restock-to-zero event one of them often keeps reporting its last-known
    // NONZERO count for a bit before catching up — with a timestamp that can
    // still look "newer" than the other source's already-correct zero
    // report. Picking "whichever source updated most recently" in that
    // window would flip back to nonzero, and then re-detect "hitting zero"
    // again later than it actually happened — falsifying the zeroAt the
    // "Fly at" timer is based on. So once zero is confirmed, hold it (and
    // zeroAt) for XANAX_ZERO_LOCK_MS and ignore whatever the sources say
    // until that lock expires.
    if (prev && prev.quantity === 0 && prev.zeroAt && Date.now() - prev.zeroAt < XANAX_ZERO_LOCK_MS) {
      return;
    }
    if (prev && prev.quantity > 0 && prev.spawnAt && Date.now() - prev.spawnAt < XANAX_SPAWN_LOCK_MS) {
      return;
    }

    // Prefer whichever source reports the more recently updated stock.
    const best = candidates.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));

    // Stamp the exact moment stock hits 0 so the panel/Discord can show a
    // "Fly at" timer off of it. Carries the previous zeroAt forward
    // otherwise, so it isn't lost between polls.
    let zeroAt = prev ? (prev.zeroAt ?? null) : null;
    if (prev && prev.quantity > 0 && best.quantity === 0) {
      zeroAt = Date.now();
    }
    // Same idea, opposite direction — stamped once when it spawns.
    let spawnAt = prev ? (prev.spawnAt ?? null) : null;
    if (prev && prev.quantity === 0 && best.quantity > 0) {
      spawnAt = Date.now();
    }

    GM_setValue(LS.xanaxStock, { quantity: best.quantity, cost: best.cost, updatedAt: best.updatedAt, zeroAt, spawnAt, source: best.source });
    renderPanel();

    // The local GM_setValue/panel update above runs on every device/tab
    // regardless of leadership (harmless, purely local display) — but the
    // Discord side must not: this poll runs on its own timer, completely
    // independent of the Start/Stop loop and its isDeviceActive gating, so
    // without these checks every device AND every tab on the leading
    // device would independently detect the same restock and post its own
    // duplicate alert, all fighting over editing the same dashboard
    // message.
    if (!isDeviceActive) return;
    if (!claimXanaxLock()) return;

    // Nonzero -> 0 only, fired exactly once per zero event (the
    // XANAX_ZERO_LOCK_MS guard above prevents this branch from being
    // reached again until the lock expires).
    if (prev && prev.quantity > 0 && best.quantity === 0) {
      fireXanaxFlyReminder(zeroAt + XANAX_FLY_DELAY_MS);
    }

    // 0 -> nonzero only — repeated nonzero counts don't re-fire, and a
    // stale/repeated 0 doesn't either.
    if (prev && prev.quantity === 0 && best.quantity > 0) {
      sendTransientDiscordAlert(`💊 **Xanax restocked in Canada** — ${best.quantity.toLocaleString()} available @ $${best.cost.toLocaleString()} each`);
    }
    // Keep the persistent dashboard message current too, not just the
    // on-page panel — otherwise it'd only pick up the new count on the
    // next player check.
    await syncDiscordMessage();
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

  // Parses Torn's own human-readable last_action.relative string ("3 minutes
  // ago", "7 hours ago", "2 days ago") into approximate elapsed seconds —
  // fallback for checkInactivity() below, for profiles where .timestamp
  // comes back 0/missing while .relative is still populated (observed on
  // some accounts, seemingly privacy-setting-related).
  function parseRelativeToSeconds(relative) {
    if (!relative) return null;
    const match = /^(\d+)\s*(second|minute|hour|day|month|year)/i.exec(relative.trim());
    if (!match) return null;
    const perUnitSec = { second: 1, minute: 60, hour: 3600, day: 86400, month: 30 * 86400, year: 365 * 86400 };
    return Number(match[1]) * (perUnitSec[match[2].toLowerCase()] || 0);
  }

  // Auto-disables (unchecks) a player once they've been inactive for over an
  // hour — they still stay on the list (and can be manually re-checked
  // anytime), just stop consuming a check-slot in the round-robin. Doesn't
  // re-enable them automatically if they come back online, since a disabled
  // player is no longer being checked at all.
  function checkInactivity(curr) {
    if (PINNED_PLAYER_IDS.includes(curr.id)) return;

    // Based on elapsed time since last_action.timestamp, not the
    // last_action.status label — a player can sit as "Idle" (tab open,
    // no interaction) for hours without ever reporting "Offline", so
    // gating on the "Offline" label specifically missed those entirely.
    // Falls back to parsing .relative when .timestamp itself is falsy —
    // some profiles report a real relative string ("7 hours ago") but a
    // zeroed/missing raw timestamp, which otherwise silently bypassed this
    // check forever regardless of actual elapsed time.
    let inactiveSec = null;
    if (curr.lastActionTimestamp) {
      inactiveSec = Date.now() / 1000 - curr.lastActionTimestamp;
    } else if (curr.lastActionRelative) {
      inactiveSec = parseRelativeToSeconds(curr.lastActionRelative);
    }
    if (inactiveSec == null || inactiveSec <= INACTIVITY_TTL_SEC) return;

    const list = getWatchList();
    const entry = list.find((e) => e.id === curr.id);
    if (entry && entry.enabled) {
      entry.enabled = false;
      setWatchList(list);
      console.log(`[TLW] Auto-unchecked ${curr.name} (#${curr.id}) — inactive for over 1 hour.`);
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

  // "Check all" force-checks every watched player at once (see
  // checkAllPlayersNow() below), which can surface a whole burst of status
  // changes/baselines simultaneously — one per player, all firing within a
  // couple of seconds. Suppressing notifications for a couple of minutes
  // right after using it avoids spamming Discord (and your desktop) with
  // that burst, without needing to change how the normal background loop
  // behaves the rest of the time.
  const CHECK_ALL_NOTIFY_SUPPRESS_MS = 2 * 60 * 1000;

  function isNotifySuppressed() {
    return Date.now() < GM_getValue(LS.notifySuppressUntil, 0);
  }

  function notifyChange(prev, curr) {
    console.log(`[TLW] ${curr.name} (${curr.id}): ${prev.state} -> ${curr.state} — ${curr.description}`);
    if (isNotifySuppressed()) {
      console.log(`[TLW] Suppressing Discord alert for ${curr.name} — recent "Check all" cooldown active.`);
      return;
    }
    sendTransientDiscordAlert(`🔔 **${curr.name}**: ${prev.state} → ${curr.state}${curr.description ? ` (${curr.description})` : ''}`);
  }

  // Fired for the first observation of a player (on Start, or when newly
  // added to the watch list) — confirms the script is actually running and
  // reaching the API, rather than silently doing nothing until a change.
  function notifyBaseline(curr) {
    if (isNotifySuppressed()) {
      console.log(`[TLW] Suppressing baseline notification for ${curr.name} — recent "Check all" cooldown active.`);
      return;
    }
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

    GM_setValue(LS.notifySuppressUntil, Date.now() + CHECK_ALL_NOTIFY_SUPPRESS_MS);
    console.log(`[TLW] Manually checking all ${list.length} player(s)... (notifications suppressed for ${CHECK_ALL_NOTIFY_SUPPRESS_MS / 60_000} minutes)`);
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

  // Same idea as claimLock() above, but for the Xanax poll specifically —
  // see LS.xanaxLock's comment for why it needs its own separate lock
  // rather than reusing this one.
  const XANAX_LOCK_TTL_MS = CONFIG.yataPollMs * 4;

  function claimXanaxLock() {
    const lock = GM_getValue(LS.xanaxLock, null);
    const now = Date.now();
    if (lock && lock.owner !== TAB_ID && now - lock.ts < XANAX_LOCK_TTL_MS) return false;
    GM_setValue(LS.xanaxLock, { owner: TAB_ID, ts: now });
    return true;
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

    const xanax = GM_getValue(LS.xanaxStock, null);
    const stockRow = document.createElement('div');
    stockRow.style.cssText = 'margin-bottom:6px;padding:3px 6px;background:rgba(255,255,255,0.05);border-radius:4px;';
    if (xanax) {
      const stockColor = xanax.quantity > 0 ? '#7CFC9A' : '#ff6b6b';
      const costPart = xanax.quantity > 0 ? ` @ $${escapeHtml(xanax.cost.toLocaleString())}` : '';
      const sourceTag = xanax.source ? ` <span style="opacity:0.5;">(${escapeHtml(xanax.source)})</span>` : '';
      stockRow.innerHTML = `🇨🇦 Xanax: <b style="color:${stockColor}">${escapeHtml(xanax.quantity.toLocaleString())}</b>${costPart}${sourceTag}`
        + ` <span style="opacity:0.55;font-size:10px;">(${timeAgo(xanax.updatedAt)})</span>`;
    } else {
      stockRow.innerHTML = '<span style="opacity:0.7;">🇨🇦 Xanax: checking...</span>';
    }
    panel.appendChild(stockRow);

    const flyTimer = xanaxFlyTimer(xanax);
    if (flyTimer) {
      const flyRow = document.createElement('div');
      flyRow.style.cssText = 'margin-bottom:6px;padding:3px 6px;background:rgba(255,255,255,0.05);border-radius:4px;font-size:11px;opacity:0.85;';
      flyRow.innerHTML = `Hit 0 at <b>${escapeHtml(flyTimer.zeroTimeStr)}</b> — Fly at <b>${escapeHtml(flyTimer.flyTimeStr)}</b>`;
      panel.appendChild(flyRow);
    }

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
    actionsRow.appendChild(makeActionButton('⬆️ Push', "Push this device's API keys/watch list to the watcher server, overwriting it (only works while this device is leading)", pushToServer));
    actionsRow.appendChild(makeActionButton('⬇️ Pull', "Pull the API keys/watch list from the watcher server, overwriting this device's list", pullFromServer));
    panel.appendChild(actionsRow);

    const fullList = getWatchList();
    const list = withPinnedLast(sortEnabledFirst(fullList)).filter((e) => e.enabled || showDisabled);
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

  ensurePinnedPlayersWatched();

  // Any tab re-renders whenever the shared state changes, so the panel
  // stays live even in tabs that aren't doing the polling.
  GM_addValueChangeListener(LS.lastStatus, renderPanel);
  GM_addValueChangeListener(LS.watchList, renderPanel);
  GM_addValueChangeListener(LS.xanaxStock, renderPanel);
  renderPanel();

  pollCanadaXanaxStock();
  setInterval(pollCanadaXanaxStock, CONFIG.yataPollMs);

  // ════════════════════════════════════════════════════════════
  //  MAIN LOOP — always runs once the page loads. No more Start/Stop menu:
  //  if there's nothing to check yet (no keys, no watch list), it just
  //  idles and logs a warning until you add some via the panel/menu.
  // ════════════════════════════════════════════════════════════

  async function loop() {
    while (true) {
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
      // heartbeatLoop() (see above) maintains isDeviceActive on its own
      // independent timer — just read the latest value here, never await
      // the heartbeat request itself on this path.
      if (!isDeviceActive) {
        await sleep(CONFIG.checkGapMs);
        continue;
      }
      if (!claimLock()) {
        await sleep(CONFIG.checkGapMs);
        continue;
      }
      refreshLock();
      const tickStart = Date.now();
      const id = nextPlayerId();
      if (id != null) {
        try {
          await checkOnePlayer(id);
        } catch (e) {
          console.error('[TLW] Check failed:', e.message);
        }
      }
      // Elapsed-time-aware: checkOnePlayer() also does its own network work
      // (the Torn API call, plus syncing the Discord message id with the
      // watcher server and PATCHing Discord itself) that can easily take
      // over a second on its own — sleeping a FULL checkGapMs on top of that
      // unconditionally is what caused the irregular 1-3s gaps between
      // calls. Only sleep out whatever's left of the target interval.
      const wait = CONFIG.checkGapMs - (Date.now() - tickStart);
      if (wait > 0) await sleep(wait);
    }
  }

  loop();
})();
