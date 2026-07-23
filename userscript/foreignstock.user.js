// ==UserScript==
// @name         Torn Foreign Stock - Auto Max Xanax
// @namespace    local.torn.foreign-stock-automax
// @version      2.0.0
// @description  On the travel/foreign stock page, sets Xanax's Qty to max and clicks its cart button so Buy is already showing - all that's left is your own Buy click. Falls back to prepping every other in-stock item if Xanax isn't there. Never clicks Buy itself.
// @match        https://www.torn.com/page.php?sid=travel*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    targetItemNames: ['xanax'], // lowercase; add more names here to change/extend the priority item(s)

    // Confirmed convention (Torn PDA's bundled Item Market script + TornTools'
    // abroad-auto-fill-max.ts both key off this exact placeholder).
    qtySelector: "input[placeholder='Qty']",

    // Row container from TornTools' abroad-auto-fill-max.ts. Torn's hashed
    // class names drift between deploys, so getRows() below falls back to
    // walking up from item icons if this ever stops matching anything.
    rowSelectorPrimary: "[class*='stockTableWrapper___'] [class*='row___']",

    xanaxColor: 'gold',
    fallbackColor: 'limegreen',
    debounceMs: 200,

    // Safety net: never click anything whose own visible text says it commits
    // the purchase. Only you press the real Buy button — this script only
    // clears the qty box and the reveal-cart-button out of the way first.
    forbiddenClickText: /^(buy|confirm|purchase|checkout)$/i,
  };

  const itemStatus = new Map(); // item name (lowercase) -> 'done' | 'unavailable'
  const clickedControls = new WeakSet(); // never click the same cart control twice

  function getRows() {
    const primary = Array.from(document.querySelectorAll(CONFIG.rowSelectorPrimary));
    if (primary.length > 0) return primary;

    // Fallback: every item is rendered with an <img alt="Item Name">; derive
    // "rows" from those icons if the hashed row class no longer matches.
    const seen = new Set();
    document.querySelectorAll('img[alt]').forEach((img) => {
      const row = img.closest('li, tr') || img.parentElement?.parentElement?.parentElement;
      if (row) seen.add(row);
    });
    return Array.from(seen);
  }

  function getItemName(row) {
    return row.querySelector('img[alt]')?.alt?.trim() || '';
  }

  function findCartControl(row, qtyInput) {
    const candidates = Array.from(row.querySelectorAll('button, a, [role="button"]'))
      .filter((el) => !CONFIG.forbiddenClickText.test(el.textContent.trim()) && !clickedControls.has(el));
    if (candidates.length === 0) return null;

    const hinted = candidates.find((el) =>
      /cart|add/i.test(`${el.className} ${el.getAttribute('aria-label') || ''} ${el.title || ''}`)
    );
    if (hinted) return hinted;

    // Otherwise prefer whichever candidate sits right after the qty box in
    // document order — that's typically where an inline action icon sits.
    const afterQty = qtyInput
      ? candidates.find((el) => qtyInput.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      : null;
    return afterQty || candidates[candidates.length - 1];
  }

  function fillMax(input) {
    if (input.dataset.tornMaxed) return;
    input.value = 'max';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dataset.tornMaxed = '1';
  }

  function processRow(row, color) {
    const name = getItemName(row).toLowerCase();

    if (name && itemStatus.get(name) === 'done') {
      // Already handled earlier; just refresh the value/highlight in case
      // this is a freshly re-rendered DOM node for the same item.
      const input = row.querySelector(CONFIG.qtySelector);
      if (input) {
        fillMax(input);
        input.style.outline = `2px solid ${color}`;
      }
      return 'done';
    }

    const input = row.querySelector(CONFIG.qtySelector);
    if (!input || input.disabled) {
      if (name) itemStatus.set(name, 'unavailable');
      return 'unavailable';
    }

    fillMax(input);
    input.style.outline = `2px solid ${color}`;

    const cartControl = findCartControl(row, input);
    if (cartControl) {
      clickedControls.add(cartControl);
      console.log(`[TornMax] ${name || '(unnamed item)'}: qty set to max, clicking cart button.`, cartControl);
      cartControl.click();
    } else {
      console.log(`[TornMax] ${name || '(unnamed item)'}: qty set to max, but no cart button found — check if Buy is already visible.`);
    }

    if (name) itemStatus.set(name, 'done');
    return 'done';
  }

  function run() {
    const rows = getRows();
    const xanaxRow = rows.find((row) =>
      CONFIG.targetItemNames.some((n) => getItemName(row).toLowerCase().includes(n))
    );

    if (xanaxRow) {
      const result = processRow(xanaxRow, CONFIG.xanaxColor);
      if (result === 'done') {
        console.log('[TornMax] Xanax ready — just press Buy.');
        return;
      }
      console.log('[TornMax] Xanax is on this page but not purchasable right now (out of stock?) — prepping other items instead.');
    } else {
      console.log('[TornMax] No Xanax on this page — prepping other items instead.');
    }

    let filled = 0;
    rows.filter((row) => row !== xanaxRow).forEach((row) => {
      if (processRow(row, CONFIG.fallbackColor) === 'done') filled++;
    });
    if (filled > 0) console.log(`[TornMax] Prepped ${filled} other item(s) — pick one and press its Buy.`);
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
