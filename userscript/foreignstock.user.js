// ==UserScript==
// @name         Torn Foreign Stock - Auto Max Xanax
// @namespace    local.torn.foreign-stock-automax
// @version      3.0.0
// @description  On the travel/foreign stock page, sets Xanax's Qty box to max so all that's left is your own Buy click. Nothing else - no clicking, no fallback to other items.
// @match        https://www.torn.com/page.php?sid=travel*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://github.com/Rqez/torn/edit/main/userscript/foreignstock.user.js
// @updateURL    https://github.com/Rqez/torn/edit/main/userscript/foreignstock.user.js
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    targetItemNames: ['xanax'], // lowercase; add more names here if you ever want a different item

    // Confirmed convention (Torn PDA's bundled Item Market script + TornTools'
    // abroad-auto-fill-max.ts both key off this exact placeholder).
    qtySelector: "input[placeholder='Qty']",

    // Row container from TornTools' abroad-auto-fill-max.ts. Torn's hashed
    // class names drift between deploys, so getRows() below falls back to
    // walking up from item icons if this ever stops matching anything.
    rowSelectorPrimary: "[class*='stockTableWrapper___'] [class*='row___']",

    highlightColor: 'gold',
    debounceMs: 200,
  };

  let lastLoggedState = null; // only log on state change, not on every debounce tick

  function getRows() {
    const primary = Array.from(document.querySelectorAll(CONFIG.rowSelectorPrimary));
    if (primary.length > 0) return primary;

    const seen = new Set();
    document.querySelectorAll('img[alt]').forEach((img) => {
      const row = img.closest('li, tr') || img.parentElement?.parentElement?.parentElement;
      if (row) seen.add(row);
    });
    return Array.from(seen);
  }

  function isTargetRow(row) {
    // Match on the row's own visible text rather than an <img alt="">, since
    // Torn's item icons on this page turned out to have blank alt text.
    const text = row.textContent.toLowerCase();
    return CONFIG.targetItemNames.some((name) => text.includes(name));
  }

  function fillMax(input) {
    if (input.dataset.tornMaxed) return;
    input.value = 'max';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dataset.tornMaxed = '1';
  }

  function log(state, message) {
    if (state === lastLoggedState) return;
    lastLoggedState = state;
    console.log(`[TornMax] ${message}`);
  }

  function run() {
    const row = getRows().find(isTargetRow);

    if (!row) {
      log('absent', 'No Xanax row on this page right now.');
      return;
    }

    const input = row.querySelector(CONFIG.qtySelector);
    if (!input || input.disabled) {
      log('unavailable', 'Xanax is on this page but not purchasable right now (out of stock?).');
      return;
    }

    fillMax(input);
    input.style.outline = `2px solid ${CONFIG.highlightColor}`;
    log('ready', 'Xanax qty set to max — just press Buy.');
  }

  // Shop tabs (General Store / Arms Dealer / Black Market) and restocks swap
  // content via client-side re-render, not a full page load, so keep
  // re-running instead of a single pass on load.
  let debounceTimer = null;
  new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, CONFIG.debounceMs);
  }).observe(document.body, { childList: true, subtree: true });

  run();
})();
