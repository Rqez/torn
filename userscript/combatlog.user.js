// ==UserScript==
// @name         Torn Fight Log Watcher
// @namespace    local.torn.fight-logger
// @version      0.2.0
// @description  Watches an open attack page and logs visible fight activity (joins, hits, results) as they happen. Only reads what Torn already renders on screen.
// @match        https://www.torn.com/page.php?sid=attack&user2ID=*
// @match        https://www.torn.com/loader.php?sid=attack&user2ID=*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    profileLinkPattern: /profiles\.php\?XID=(\d+)/i,
    // Phrasing lifted directly from the real Action log (see screenshot):
    // "X hit Y with his Bat in the Groin for 14", "X fired 7 rounds ... hitting Y ... for 451",
    // "X initiated an attack against Y".
    eventPattern: /\b(hit|hitting|fired|missed|initiated an attack|joined|left the fight|hospitali[sz]ed|mugged|defeated|knocked \w+ out|fled|surrender(?:ed)?)\b/i,
    panelMarker: 'data-torn-fight-log-ui',
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

  function depth(el) {
    let d = 0;
    while (el.parentElement) {
      d++;
      el = el.parentElement;
    }
    return d;
  }

  function extractFromNode(node) {
    if (!(node instanceof Element)) return;
    if (node.closest('[' + CONFIG.panelMarker + ']')) return; // ignore our own panel

    const text = node.textContent.trim().replace(/\s+/g, ' ');
    if (!text || text.length > 300) return; // skip empty / huge blobs
    if (seenText.has(text)) return;

    const link = node.querySelector && node.querySelector('a[href*="profiles.php?XID="]');
    const looksLikeEvent = CONFIG.eventPattern.test(text);
    if (!link && !looksLikeEvent) return;

    // Skip wrapper elements whose text is just an already-logged line plus
    // extra stuff (e.g. a <tr> wrapping an already-captured <td>).
    for (const e of entries) {
      if (text.length > e.text.length && text.includes(e.text)) return;
    }

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
    const all = [node, ...node.querySelectorAll('*')];
    all.sort((a, b) => depth(b) - depth(a)); // deepest/leaf elements first
    all.forEach(extractFromNode);
  }

  let currentObserver = null;
  let observedBody = null;

  function attachObserver() {
    if (observedBody === document.body && currentObserver) return;

    if (currentObserver) currentObserver.disconnect();
    observedBody = document.body;

    currentObserver = new MutationObserver(mutations => {
      for (const mut of mutations) {
        mut.addedNodes.forEach(scanAddedNode);
        // Some frameworks mutate text/attributes in place instead of adding
        // nodes; re-scan the mutation target too so edits aren't missed.
        if (mut.type === 'characterData' && mut.target.parentElement) {
          extractFromNode(mut.target.parentElement);
        }
      }
    });
    currentObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    console.log('[TornFightLog] Watching document.body for fight activity.');

    scanAddedNode(document.body); // pick up anything already on screen
  }

  // document.body can in principle be swapped by a framework; cheap safety net.
  const rebindTimer = setInterval(attachObserver, 2000);

  // ---------------------------------------------------------------------
  // On-page panel: shows captured entries, lets you copy/export/clear.
  // ---------------------------------------------------------------------
  let panel, logDiv;

  function buildPanel() {
    panel = document.createElement('div');
    panel.setAttribute(CONFIG.panelMarker, '1');
    panel.style.cssText = `
      position: fixed; bottom: 10px; left: 10px; width: 340px; max-height: 400px;
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

  window.addEventListener('beforeunload', () => {
    clearInterval(rebindTimer);
    if (currentObserver) currentObserver.disconnect();
  });
})();
