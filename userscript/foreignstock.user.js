// ==UserScript==
// @name         Torn Foreign Stock - Auto Max Qty
// @namespace    local.torn.foreign-stock-automax
// @version      1.0.0
// @description  On the travel/foreign stock page, fills every item's Qty box with "max" so all you need to do is click Buy. Never touches Buy itself.
// @match        https://www.torn.com/page.php?sid=travel*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    // Qty boxes are matched by placeholder="Qty", not a CSS class — Torn's hashed
    // class names drift across deploys (see torn-market-watcher.user.js CONFIG
    // comment for the same problem on Item Market). This placeholder convention
    // is confirmed against two independent real scripts that both key off it:
    //   - Torn PDA's own bundled "Item Market Auto Price" userscript
    //   - TornTools' abroad-auto-fill-max.ts (github.com/Mephiles/torntools_extension)
    qtySelector: "input[placeholder='Qty']",
    doneFlag: 'tornMaxed', // dataset key -> data-torn-maxed, marks a box already filled
    debounceMs: 200,
  };

  function fillInput(input) {
    // Set the literal text "max", not a computed number, and let Torn's own
    // React state resolve it. Torn's own resolution already accounts for cash
    // on hand, remaining stock, AND travel carry capacity at once, which is
    // more correct than re-deriving that arithmetic here from scraped text.
    input.value = 'max';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.style.outline = '2px solid limegreen';
  }

  function fillMaxQuantities() {
    const boxes = document.querySelectorAll(CONFIG.qtySelector);
    let filled = 0;
    boxes.forEach((input) => {
      if (input.disabled || input.dataset[CONFIG.doneFlag]) return;
      fillInput(input);
      input.dataset[CONFIG.doneFlag] = '1';
      filled++;
    });
    if (filled > 0) console.log(`[TornMax] Filled ${filled} Qty box(es) with max.`);
  }

  // The 3 shop tabs (General Store / Arms Dealer / Black Market) swap content
  // via client-side re-render, not a full page load, so keep watching for
  // newly-mounted Qty boxes instead of running once.
  let debounceTimer = null;
  new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fillMaxQuantities, CONFIG.debounceMs);
  }).observe(document.body, { childList: true, subtree: true });

  fillMaxQuantities();
})();
