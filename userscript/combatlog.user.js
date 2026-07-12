// ==UserScript==
// @name         Torn Fight Log Watcher
// @namespace    local.torn.fight-logger
// @version      0.1.0
// @description  Watches an open attack page and logs visible fight activity (joins, hits, results) as they happen. Only reads what Torn already renders on screen.
// @match        https://www.torn.com/page.php?sid=attack&user2ID=*
// @match        https://www.torn.com/loader.php?sid=attack&user2ID=*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // CONFIG — adjust SELECTORS if the fallback scanner warns that it can't
  // find a known log container. Open devtools on the attack page, find the
  // element that wraps the round-by-round fight log, and add its selector
  // here (most specific match first).
  // ---------------------------------------------------------------------
  const CONFIG = {
    candidateSelectors: [
      '.chatLogWrapper',            // old attack page log wrapper (historical)
      '[class*="logWrapper"]',
      '[class*="log-wrap"]',
      '[class*="attackLog"]',
      '[class*="fightLog"]',
      '[class*="chat-log"]',
      'main',                       // last-resort broad fallback
    ],
    profileLinkPattern: /profiles\.php\?XID=(\d+)/i,
    pollMs: 1000, // fallback poller in case MutationObserver misses SPA route swaps
  };

  const STORAGE_KEY = 'tornFightLog:' + (new URLSearchParams(location.search).get('user2ID') || 'unknown');

  /** @type {Array<{t:string, name:string, id:string|null, text:string}>} */
  let entries = [];
  try {
    entries = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
  } catch (_) {
    entries = [];
  }

  const seenText = new Set(entries.map(e => e.text));

  function persist() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (_) {
      /* storage full or unavailable — logging continues in memory only */
    }
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function extractFromNode(node) {
    if (!(node instanceof Element)) return;
    const text = node.textContent.trim();
    if (!text || text.length > 500) return; // skip empty / huge blobs
    if (seenText.has(text)) return;

    // Only treat this as a log line if it looks like an event: mentions an
    // attack/hit/join/leave/result word, or contains a profile link.
    const link = node.querySelector && node.querySelector('a[href*="profiles.php?XID="]');
    const looksLikeEvent = /attack|hit|joined|left|hospitali[sz]ed|mugged|assist|defeat|knocked out|fled|surrender/i.test(text);

    if (!link && !looksLikeEvent) return;

    let name = null, id = null;
    if (link) {
      name = link.textContent.trim();
      const m = link.getAttribute('href').match(CONFIG.profileLinkPattern);
      if (m) id = m[1];
    }

    seenText.add(text);
    const entry = { t: nowIso(), name, id, text };
    entries.push(entry);
    persist();
    renderPanel();
    console.log('[TornFightLog]', entry);
  }

  function scanAddedNode(node) {
    if (!(node instanceof Element)) return;
    extractFromNode(node);
    node.querySelectorAll('*').forEach(extractFromNode);
  }

  let observedRoot = null;

  function findRoot() {
    for (const sel of CONFIG.candidateSelectors) {
      const el = document.querySelector(sel);
      if (el) return { el, sel };
    }
    return null;
  }

  function attachObserver() {
    const found = findRoot();
    if (!found) {
      console.warn('[TornFightLog] No known log container found yet. Retrying...');
      return false;
    }
    if (observedRoot === found.el) return true; // already watching this node

    observedRoot = found.el;
    console.log('[TornFightLog] Watching container:', found.sel, found.el);

    const observer = new MutationObserver(mutations => {
      for (const mut of mutations) {
        mut.addedNodes.forEach(scanAddedNode);
      }
    });
    observer.observe(found.el, { childList: true, subtree: true });

    // pick up anything already on screen when we attach
    scanAddedNode(found.el);
    return true;
  }

  // Retry attaching (attack pages are SPA-ish; the log container may not
  // exist at document-idle yet, or gets replaced on route changes).
  const attachTimer = setInterval(() => {
    attachObserver();
  }, CONFIG.pollMs);

  // ---------------------------------------------------------------------
  // On-page panel: shows captured entries, lets you copy/export/clear.
  // ---------------------------------------------------------------------
  let panel, logDiv;

  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText = `
      position: fixed; bottom: 10px; right: 10px; width: 340px; max-height: 400px;
      background: #1e1e1e; color: #eee; font: 12px/1.4 monospace; z-index: 999999;
      border: 1px solid #555; border-radius: 6px; box-shadow: 0 2px 10px rgba(0,0,0,.5);
      display: flex; flex-direction: column; overflow: hidden;
    `;

    const header = document.createElement('div');
    header.style.cssText = 'padding:6px 8px; background:#333; display:flex; justify-content:space-between; align-items:center; cursor:move;';
    header.innerHTML = '<b>Fight Log Watcher</b>';

    const btnRow = document.createElement('div');
    ['Copy', 'Export JSON', 'Clear'].forEach(label => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'margin-left:4px; font-size:11px; cursor:pointer;';
      b.onclick = () => {
        if (label === 'Copy') {
          const text = entries.map(e => `[${e.t}] ${e.name ? e.name + ' (' + e.id + ')' : ''} ${e.text}`).join('\n');
          navigator.clipboard.writeText(text).catch(() => {});
        } else if (label === 'Export JSON') {
          navigator.clipboard.writeText(JSON.stringify(entries, null, 2)).catch(() => {});
        } else if (label === 'Clear') {
          entries = [];
          seenText.clear();
          persist();
          renderPanel();
        }
      };
      btnRow.appendChild(b);
    });
    header.appendChild(btnRow);

    logDiv = document.createElement('div');
    logDiv.style.cssText = 'padding:6px 8px; overflow-y:auto; flex:1;';

    panel.appendChild(header);
    panel.appendChild(logDiv);
    document.body.appendChild(panel);
  }

  function renderPanel() {
    if (!panel) buildPanel();
    logDiv.innerHTML = entries
      .slice(-200) // keep the DOM light
      .map(e => {
        const who = e.name ? `<b>${escapeHtml(e.name)}</b>${e.id ? ' [' + e.id + ']' : ''}` : '';
        const time = e.t.slice(11, 19);
        return `<div style="border-bottom:1px solid #333; padding:2px 0;">
          <span style="color:#888;">${time}</span> ${who}<br>${escapeHtml(e.text)}
        </div>`;
      })
      .join('');
    logDiv.scrollTop = logDiv.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  buildPanel();
  renderPanel();
  attachObserver();

  window.addEventListener('beforeunload', () => clearInterval(attachTimer));
})();
