// ==UserScript==
// @name         Torn Player Location Watcher
// @namespace    tc-location-watch
// @version      5.0
// @description  Thin remote control for the server-side Torn Watcher (see torn-watcher-server/). Edit your API keys and watched player IDs locally, then Push/Pull them to the server and trigger an on-demand Canada-filtered Check All. All actual monitoring — Torn API polling, Xanax stock tracking, Discord posting — now runs 24/7 on the server itself, not in this browser tab.
// @match        https://weav3r.dev/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
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
    maxApiKeys: 20,
  };

  function tornProfileUrl(id) {
    return `https://www.torn.com/profiles.php?XID=${id}`;
  }

  // Embedded directly — no more "Set Watcher Server URL" menu command.
  // Served over HTTPS via Caddy (reverse-proxying to the Node server on
  // localhost:8787, with an auto-renewing Let's Encrypt cert) rather than
  // hitting the VM's raw IP:port directly. Update this constant (and the
  // @connect entry above, and re-save the script in Tampermonkey) if the
  // domain or VM ever changes.
  const EMBEDDED_SERVER_URL = 'https://canadaxanax.duckdns.org';

  // Default shared secret — must match config.txt's sharedSecret= on the
  // server for anything to actually be accepted. Editable via the "🔒 Set
  // Server Shared Secret" menu command below without touching this file.
  const DEFAULT_SERVER_SECRET = '24a9c856ec1fea1c455ef4f84eb6472fada87c9b46ba9096';

  const LS = {
    apiKeys: 'tlw_api_keys', // array of up to CONFIG.maxApiKeys key strings, staged locally until you Push
    watchList: 'tlw_watch_list', // array of { id, enabled }, staged locally until you Push
    showDisabled: 'tlw_show_disabled', // panel-only: whether unchecked players are shown at all
    serverSecret: 'tlw_server_secret', // must match the server's config.txt sharedSecret= — editable via menu
  };

  // ════════════════════════════════════════════════════════════
  //  API KEYS — staged locally, only take effect on the server once Pushed.
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
      `Enter up to ${CONFIG.maxApiKeys} Torn API keys, comma-separated (all from your own account — generate more at torn.com/preferences.php#tab=api). Remember to click Push afterwards:`,
      current
    );
    if (input == null) return;
    const keys = input.split(',').map((s) => s.trim()).filter(Boolean).slice(0, CONFIG.maxApiKeys);
    setApiKeys(keys);
    renderPanel();
    alert(keys.length ? `Saved ${keys.length} API key(s) locally. Click Push to send them to the server.` : 'API keys cleared locally.');
  });

  // Quicker than editing the full comma-separated list above — just types
  // one new key into a fresh, empty prompt. Lives as a button in the on-page
  // panel rather than the Tampermonkey menu.
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
    renderPanel();
    alert(`Added. Now have ${keys.length} key(s) staged locally — click Push to send them to the server.`);
  }

  // ════════════════════════════════════════════════════════════
  //  WATCH LIST — staged locally, only take effect on the server once Pushed.
  // ════════════════════════════════════════════════════════════

  function getWatchList() {
    return GM_getValue(LS.watchList, []);
  }

  function setWatchList(list) {
    GM_setValue(LS.watchList, list);
  }

  // Display-only ordering (doesn't touch storage): enabled entries first,
  // disabled ones sink to the bottom, each group keeping its original
  // relative order.
  function sortEnabledFirst(list) {
    return [...list].sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0));
  }

  GM_registerMenuCommand('📋 Set Watched Player IDs', () => {
    const current = getWatchList().map((e) => e.id).join(', ');
    const input = prompt('Enter player IDs to watch, comma-separated (e.g. 1234567, 2345678). Remember to click Push afterwards:', current);
    if (input == null) return;
    const ids = input.split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);

    // Preserve each existing player's enabled/disabled toggle; new entries
    // default to enabled.
    const existingEnabled = new Map(getWatchList().map((e) => [e.id, e.enabled]));
    const newList = ids.map((id) => ({ id, enabled: existingEnabled.has(id) ? existingEnabled.get(id) : true }));
    setWatchList(newList);
    renderPanel();
    alert(ids.length ? `Watching ${ids.length} player(s) locally: ${ids.join(', ')} — click Push to send this to the server.` : 'Watch list cleared locally.');
  });

  // Quicker than editing the full comma-separated list above — just types
  // one new ID into a fresh, empty prompt, enabled by default.
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
    renderPanel();
    alert(`Added #${id}. Now watching ${list.length} player(s) locally — click Push to send this to the server.`);
  }

  function toggleWatched(id, enabled) {
    const list = getWatchList();
    const entry = list.find((e) => e.id === id);
    if (!entry) return;
    entry.enabled = enabled;
    setWatchList(list);
  }

  function removeWatched(id) {
    const list = getWatchList().filter((e) => e.id !== id);
    setWatchList(list);
    renderPanel();
  }

  function getShowDisabled() {
    return GM_getValue(LS.showDisabled, true);
  }

  // ════════════════════════════════════════════════════════════
  //  SERVER — the server does ALL the actual monitoring/posting now; this
  //  device only pushes/pulls config and can trigger an on-demand Check All.
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

  async function pushToServer() {
    const apiKeys = getApiKeys();
    const watchList = getWatchList();
    const res = await serverRequest('/api/push', { apiKeys, watchList });
    if (res && res.ok) {
      alert(`Pushed ${apiKeys.length} key(s) and ${watchList.length} player(s) to the server, overwriting what was there.`);
    } else {
      alert('Push failed — see the browser console for details.');
    }
  }

  async function pullFromServer() {
    const res = await serverRequest('/api/pull', {});
    if (!res) {
      alert('Pull failed — see the browser console for details.');
      return;
    }
    const apiKeys = Array.isArray(res.apiKeys) ? res.apiKeys : [];
    const watchList = Array.isArray(res.watchList) ? res.watchList : [];
    GM_setValue(LS.apiKeys, apiKeys);
    GM_setValue(LS.watchList, watchList);
    renderPanel();
    alert(`Pulled ${apiKeys.length} key(s) and ${watchList.length} player(s) from the server, overwriting this device's local list.`);
  }

  // Fire-and-forget — the server checks everyone (rate-gated, one player per
  // second) and re-applies the Canada filter on its OWN currently-stored
  // config, not necessarily whatever's staged locally on this device. Push
  // first if you want your local edits included.
  async function requestCheckAll() {
    const res = await serverRequest('/api/check-all', {});
    if (res && res.ok) {
      alert('Check All requested — the server will check everyone and re-apply the Canada filter shortly.');
    } else {
      alert('Check All request failed — see the browser console for details.');
    }
  }

  // ════════════════════════════════════════════════════════════
  //  ON-PAGE PANEL — local staging area for API keys/watch list, plus
  //  Push/Pull/Check All buttons. Doesn't show live player status — this
  //  device doesn't know it anymore; see the Discord dashboard for that.
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
    panel.innerHTML = '';

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px;gap:6px;';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;';
    title.textContent = '📍 Torn Watcher (server-side)';
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

    const note = document.createElement('div');
    note.style.cssText = 'font-size:10px;opacity:0.6;margin-bottom:6px;';
    note.textContent = 'Edits here are local until you click Push. Live status/alerts are on the server\'s Discord dashboard.';
    panel.appendChild(note);

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
    actionsRow.appendChild(makeActionButton('🔄 Check All', 'Ask the server to check everyone and re-apply the Canada filter now', requestCheckAll));
    actionsRow.appendChild(makeActionButton('⬆️ Push', "Push this device's local API keys/watch list to the server, overwriting it", pushToServer));
    actionsRow.appendChild(makeActionButton('⬇️ Pull', "Pull the API keys/watch list from the server, overwriting this device's local list", pullFromServer));
    actionsRow.appendChild(makeActionButton('🔑 +Key', 'Add one Torn API key (local, then Push)', addOneApiKey));
    actionsRow.appendChild(makeActionButton('➕ +ID', 'Add one watched player ID (local, then Push)', addOneWatchedId));
    panel.appendChild(actionsRow);

    const fullList = getWatchList();
    const list = sortEnabledFirst(fullList).filter((e) => e.enabled || showDisabled);

    if (fullList.length === 0) {
      const empty = document.createElement('div');
      empty.style.opacity = '0.7';
      empty.textContent = 'No players staged locally.';
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
      checkbox.title = entry.enabled ? 'Uncheck to exclude from next Push' : 'Check to include in next Push';
      checkbox.style.cssText = 'cursor:pointer;flex-shrink:0;margin-top:2px;';
      checkbox.addEventListener('change', () => toggleWatched(entry.id, checkbox.checked));

      const label = document.createElement('div');
      label.style.cssText = (entry.enabled ? '' : 'opacity:0.4;text-decoration:line-through;') + 'flex:1;min-width:0;';
      label.innerHTML = `<a href="${tornProfileUrl(entry.id)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;"><b>#${escapeHtml(entry.id)}</b></a>`;

      const trash = document.createElement('span');
      trash.textContent = '🗑️';
      trash.title = 'Remove from local watch list';
      trash.style.cssText = 'cursor:pointer;flex-shrink:0;margin-left:auto;opacity:0.6;';
      trash.addEventListener('click', () => {
        if (confirm(`Remove #${entry.id} from the local watch list?`)) removeWatched(entry.id);
      });

      row.appendChild(checkbox);
      row.appendChild(label);
      row.appendChild(trash);
      panel.appendChild(row);
    });
  }

  // Any tab re-renders whenever the shared local state changes, so the
  // panel stays live across tabs on this device.
  GM_addValueChangeListener(LS.watchList, renderPanel);
  GM_addValueChangeListener(LS.apiKeys, renderPanel);
  renderPanel();
})();
