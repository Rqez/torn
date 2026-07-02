// ==UserScript==
// @name         Torn War Stuff Enhanced + Target Caller
// @namespace    namespace
// @version      1.16-caller
// @description  Show travel status and hospital time and sort by hospital time on war page, plus a target call/claim system. Fork of https://greasyfork.org/en/scripts/448681-torn-war-stuff
// @author       xentac (base script), modified
// @match        https://www.torn.com/factions.php*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      torn-kgyr.onrender.com
// ==/UserScript==

(async function () {
  ("use strict");

  if (document.querySelector("div#FFScouterV2DisableWarMonitor")) {
    // We're already set up...
    return;
  }

  const ffScouterV2DisableWarMonitor = document.createElement("div");
  ffScouterV2DisableWarMonitor.id = "FFScouterV2DisableWarMonitor";
  ffScouterV2DisableWarMonitor.style.display = "none";
  document.documentElement.appendChild(ffScouterV2DisableWarMonitor);

  let apiKey =
    localStorage.getItem("xentac-torn_war_stuff_enhanced-apikey") ??
    "###PDA-APIKEY###";
  const sort_enemies = true;
  let ever_sorted = false;
  let ffscouter_sorting_deferred = false;
  const TRAVELING = "data-twse-traveling";
  const HIGHLIGHT = "data-twse-highlight";
  const STATUS_DIFFERS = "data-twse-status-differs";

  try {
    GM_registerMenuCommand("Set Api Key", function () {
      checkApiKey(false);
    });
  } catch (error) {
    // This is fine, but we need to handle torn pda too
  }

  function checkApiKey(checkExisting = true) {
    if (
      !checkExisting ||
      apiKey === null ||
      apiKey.indexOf("PDA-APIKEY") > -1 ||
      apiKey.length != 16
    ) {
      let userInput = prompt(
        "Please enter a PUBLIC Api Key, it will be used to get basic faction information:",
        apiKey ?? "",
      );
      if (userInput !== null && userInput.length == 16) {
        apiKey = userInput;
        localStorage.setItem(
          "xentac-torn_war_stuff_enhanced-apikey",
          userInput,
        );
      } else {
        console.error(
          "[TornWarStuffEnhanced] User cancelled the Api Key input.",
        );
      }
    }
  }

  // ---- Target Caller: config + state ----
  // Baked in rather than a settings prompt, so the sync server credentials
  // aren't casually visible in any UI. Same backend as InQuest Target Caller.
  const CALL_SERVER_URL = "https://torn-kgyr.onrender.com";
  const CALL_SERVER_SECRET = "6b2c7acfe19b84a2a8fa82b7eaf353c33f4c51149a65f2bf";
  const CALL_POLL_INTERVAL = 3000;

  let callerPlayerId = null;
  let callerPlayerName = null;
  let callerFactionId = null;
  const calls = new Map(); // memberId -> {id, memberId, memberName, callerId, callerName, createdAt}

  function gmFetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || "GET",
        url,
        headers: opts.headers || {},
        data: opts.body || undefined,
        onload: (res) => {
          try {
            resolve(res.responseText ? JSON.parse(res.responseText) : {});
          } catch (e) {
            reject(e);
          }
        },
        onerror: () => reject(new Error("network error")),
        ontimeout: () => reject(new Error("timeout")),
      });
    });
  }

  function callServerFetch(path, opts = {}) {
    const headers = Object.assign(
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CALL_SERVER_SECRET}`,
      },
      opts.headers || {},
    );
    return gmFetch(
      `${CALL_SERVER_URL}${path}`,
      Object.assign({}, opts, { headers }),
    );
  }

  async function initCallerIdentity() {
    if (callerPlayerId && callerFactionId) return;
    try {
      const data = await fetch(
        `https://api.torn.com/user/?selections=profile&key=${apiKey}&comment=TornWarStuffEnhanced`,
      ).then((r) => r.json());
      if (data.error) {
        console.error(
          "[TornWarStuffEnhanced] Target Caller: could not load own profile",
          data.error,
        );
        return;
      }
      callerPlayerId = String(data.player_id);
      callerPlayerName = data.name;
      // Torn's classic /user/?selections=profile nests faction info under
      // `faction.faction_id`, not a top-level `faction_id` field.
      const factionId = data.faction?.faction_id ?? data.faction_id ?? null;
      callerFactionId = factionId ? String(factionId) : null;
      if (!callerFactionId) {
        console.warn(
          "[TornWarStuffEnhanced] Target Caller: could not find a faction_id in the profile response — dumping raw response for debugging:",
          data,
        );
      }
    } catch (e) {
      console.error(
        "[TornWarStuffEnhanced] Target Caller: could not load own profile",
        e,
      );
    }
  }

  async function fetchCalls() {
    if (!callerFactionId) return;
    try {
      const data = await callServerFetch(
        `/api/calls?factionId=${callerFactionId}`,
      );
      calls.clear();
      (data.calls || []).forEach((c) => calls.set(c.memberId, c));
    } catch (e) {
      console.error("[TornWarStuffEnhanced] Target Caller: sync error", e);
    }
  }

  async function submitCall(memberId, memberName) {
    if (!callerPlayerId || !callerFactionId) {
      await initCallerIdentity();
      if (!callerPlayerId || !callerFactionId) return;
    }
    try {
      const data = await callServerFetch("/api/call", {
        method: "POST",
        body: JSON.stringify({
          factionId: callerFactionId,
          memberId,
          memberName,
          callerId: callerPlayerId,
          callerName: callerPlayerName,
        }),
      });
      if (data.call) {
        calls.set(memberId, data.call);
      }
      renderCallUI();
    } catch (e) {
      console.error("[TornWarStuffEnhanced] Target Caller: call failed", e);
    }
  }

  async function cancelCall(callId, memberId) {
    // optimistic: clear locally right away, reconcile with the server after
    calls.delete(memberId);
    renderCallUI();
    try {
      await callServerFetch(`/api/call/${callId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ factionId: callerFactionId }),
      });
    } catch (e) {
      console.error("[TornWarStuffEnhanced] Target Caller: uncall failed", e);
    }
    await fetchCalls();
    renderCallUI();
  }

  function autoUncallOnHospital(memberId) {
    const call = calls.get(memberId);
    if (!call) return;
    console.log(
      `[TornWarStuffEnhanced] Target Caller: auto-uncalling ${call.memberName} (sent to hospital)`,
    );
    cancelCall(call.id, memberId);
  }

  function getMemberDisplayName(li) {
    const a = li.querySelector("A[href^='/profiles.php']");
    const text = a ? a.textContent.trim() : "";
    return text || "Member";
  }

  function renderCallUI() {
    member_lis.forEach((entry, memberId) => {
      const li = entry.li;
      if (!li || !li.isConnected || !li.classList.contains("enemy")) return;
      if (!entry.div) return;

      // extract_all_member_lis() rebuilds `entry` objects (and clears the
      // Map) whenever the war panel re-renders, but any badge we already
      // inserted is still physically in the DOM. Reconcile against the DOM
      // itself, not just the in-memory reference, so we never end up with
      // more than one badge per row.
      const existingBadges = entry.div.querySelectorAll(
        ":scope > .twse-call-badge",
      );
      let badge = null;
      existingBadges.forEach((el, idx) => {
        if (idx === 0) {
          badge = el;
        } else {
          el.remove();
        }
      });
      if (!badge) {
        badge = document.createElement("div");
        badge.className = "twse-call-badge";
        entry.div.appendChild(badge);
      }
      entry.callBadge = badge;

      const call = calls.get(memberId);
      badge.innerHTML = "";

      if (!call) {
        const btn = document.createElement("button");
        btn.className = "twse-call-btn";
        btn.textContent = "Call";
        btn.onclick = () => submitCall(memberId, getMemberDisplayName(li));
        badge.appendChild(btn);
        return;
      }

      const isMine =
        callerPlayerId && String(call.callerId) === String(callerPlayerId);

      const label = document.createElement("span");
      label.className = isMine
        ? "twse-call-label twse-call-mine"
        : "twse-call-label twse-call-other";
      label.textContent = isMine
        ? "Called by you"
        : `Called by ${call.callerName || "?"}`;
      badge.appendChild(label);

      if (isMine) {
        const btn = document.createElement("button");
        btn.className = "twse-call-btn twse-uncall-btn";
        btn.textContent = "Uncall";
        btn.onclick = () => cancelCall(call.id, memberId);
        badge.appendChild(btn);
      }
    });
  }

  GM_addStyle(`
.members-list div.status {
  /* The badge below is a child of this element and absolutely positioned
     just past its bottom edge — make sure it isn't clipped. */
  overflow: visible !important;
}
.twse-call-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 6px;
  font-size: 10px;
  white-space: nowrap;
  vertical-align: middle;
}
.twse-call-btn {
  background: #333;
  color: #eee;
  border: 1px solid #555;
  border-radius: 3px;
  padding: 1px 6px;
  cursor: pointer;
  font-size: 10px;
  line-height: 1.4;
}
.twse-call-btn:hover {
  background: #444;
}
.twse-uncall-btn {
  background: #4a7a00;
  border-color: #6aa900;
  color: #fff;
}
.twse-uncall-btn:hover {
  background: #5a9a00;
}
.twse-call-label {
  font-weight: 600;
}
.twse-call-mine {
  color: #6adb6a;
}
.twse-call-other {
  color: #ffb84d;
}
:root .dark-mode .twse-call-mine {
  color: #8f8;
}
:root .dark-mode .twse-call-other {
  color: #ffd08a;
}
`);

  GM_addStyle(`
.members-list li:has(div.status[data-twse-highlight="true"]) {
  background-color: #99EB99 !important;
}
.members-list li:has(div.status[data-twse-status-differs="true"]) {
  background-color: #C4974C !important;
}
.members-list div.status[data-twse-traveling="true"]::after {
  color: #696026 !important;
}

:root .dark-mode .members-list li:has(div.status[data-twse-highlight="true"]) {
  background-color: #446944 !important;
}
:root .dark-mode .members-list li:has(div.status[data-twse-status-differs="true"]) {
  background-color: #795315 !important;
}
:root .dark-mode .members-list div.status[data-twse-traveling="true"]::after {
  color: #FFED76 !important;
}
`);

  GM_addStyle(`
.members-list div.status {
  position: relative !important;
  color: transparent !important;
}
.members-list div.status::after {
  content: var(--twse-content);
  position: absolute;
  top: 0;
  left: 0;
  width: calc(100% - 10px);
  height: 100%;
  background: inherit;
  display: flex;
  right: 10px;
  justify-content: flex-end;
  align-items: center;
}
.members-list .ok.status::after {
    color: var(--user-status-green-color);
}

.members-list .not-ok.status::after {
    color: var(--user-status-red-color);
}

.members-list .abroad.status::after, .members-list .traveling.status::after {
    color: var(--user-status-blue-color);
}
`);

  let running = true;
  let found_war = false;
  let pageVisible = !document.hidden;

  document.addEventListener("visibilitychange", () => {
    pageVisible = !document.hidden;
  });

  let member_lists = document.querySelectorAll("ul.members-list");

  const refresh_member_lists = () => {
    member_lists = document.querySelectorAll("ul.members-list");
  };

  function get_faction_ids() {
    refresh_member_lists();
    const nodes = get_member_lists();
    const faction_ids = [];
    nodes.forEach((elem) => {
      const q = elem.querySelector(`A[href^='/factions.php']`);
      if (!q) {
        return;
      }
      const s = q.href.split("ID=");
      if (s.length <= 1) {
        return;
      }
      const id = s[1];
      if (id) {
        faction_ids.push(id);
      }
    });
    return faction_ids;
  }

  function get_member_lists() {
    return member_lists;
  }

  function get_sorted_column(member_list) {
    const member_div = member_list.parentNode.querySelector("div.member div");
    const level_div = member_list.parentNode.querySelector("div.level div");
    const points_div = member_list.parentNode.querySelector("div.points div");
    const status_div = member_list.parentNode.querySelector("div.status div");

    let column = null;
    let order = null;

    let classname = "";

    if (member_div && member_div.className.match(/activeIcon__/)) {
      column = "member";
      classname = member_div.className;
    } else if (level_div && level_div.className.match(/activeIcon__/)) {
      column = "level";
      classname = level_div.className;
    } else if (points_div && points_div.className.match(/activeIcon__/)) {
      column = "points";
      classname = points_div.className;
    } else if (status_div && status_div.className.match(/activeIcon__/)) {
      column = "status";
      classname = status_div.className;
    }

    if (classname && classname.match(/asc__/)) {
      order = "asc";
    } else {
      order = "desc";
    }

    if (column != "score" && order != "desc") {
      ever_sorted = true;
    }

    return { column: column, order: order };
  }

  function pad_with_zeros(n) {
    if (n < 10) {
      return "0" + n;
    }
    return n;
  }

  const member_status = new Map();
  const member_lis = new Map();

  let last_request = null;
  const MIN_TIME_SINCE_LAST_REQUEST = 10000;

  const descriptions_observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.classList && node.classList.contains("descriptions")) {
          console.log("[TornWarStuffEnhanced] .descriptions added to DOM");
          faction_war_observer.observe(node, {
            childList: true,
            subtree: true,
          });
          // Check to see if the node already exists on add
          for (const child of node.childNodes) {
            faction_war_check(child);
          }
        }
      }
      for (const node of mutation.removedNodes) {
        if (node.classList && node.classList.contains("descriptions")) {
          console.log("[TornWarStuffEnhanced] .descriptions removed from DOM");
          faction_war_observer.disconnect();
        }
      }
    }
  });

  const faction_war_check = (node) => {
    if (node.classList && node.classList.contains("faction-war")) {
      console.log(
        "[TornWarStuffEnhanced] Observed mutation of .faction-war node",
      );
      found_war = true;
      extract_all_member_lis();
      for (const faction_id of get_faction_ids()) {
        // If we have a cached value for the members, pre-populate them
        populate_cached_status(faction_id);
      }
      update_statuses();
      initCallerIdentity().then(() => {
        fetchCalls().then(renderCallUI);
      });
      faction_war_observer.disconnect();
    }
  };

  const faction_war_observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        faction_war_check(node);
      }
    }
  });

  const found_faction_war_list = (factwarlist) => {
    console.log("[TornWarStuffEnhanced] Found #faction_war_list_id");
    if (factwarlist.querySelector(".faction-war")) {
      console.log("[TornWarStuffEnhanced] .faction-war already exists");
      found_war = true;
      extract_all_member_lis();
      for (const faction_id of get_faction_ids()) {
        // If we have a cached value for the members, pre-populate them
        populate_cached_status(faction_id);
      }
      update_statuses();
      initCallerIdentity().then(() => {
        fetchCalls().then(renderCallUI);
      });
      return;
    }
    if (found_war) {
      return;
    }
    console.log("[TornWarStuffEnhanced] Adding descriptions observer");
    descriptions_observer.observe(factwarlist, { childList: true });
    const descriptions = factwarlist.querySelector(".descriptions");
    if (descriptions) {
      console.log(
        "[TornWarStuffEnhanced] .descriptions already exists, adding .faction-war observer",
      );
      faction_war_observer.observe(descriptions, {
        childList: true,
        subtree: true,
      });
    }
  };

  const document_observer = new MutationObserver(() => {
    const factwarlist = document.querySelector("#faction_war_list_id");
    if (factwarlist) {
      console.log(
        "[TornWarStuffEnhanced] Found #faction_war_list_id within a mutation.",
      );
      found_faction_war_list(factwarlist);
      document_observer.disconnect();
    }
  });

  // Check to see if #faction_war_list_id already exists
  const factwarlist = document.querySelector("#faction_war_list_id");
  if (factwarlist) {
    console.log(
      "[TornWarStuffEnhanced] Found #faction_war_list_id in document already.",
    );
    found_faction_war_list(factwarlist);
    document_observer.disconnect();
  }

  // Observe all page changes till we find #faction_war_list_id
  document_observer.observe(document.body, {
    subtree: true,
    childList: true,
  });
  console.log(
    "[TornWarStuffEnhanced] #faction_war_list_id observer installed.",
  );

  // Wait 10 seconds and check one last time for #faction_war_list_id
  // Then remove the observer even if we don't find it
  setTimeout(() => {
    const factwarlist = document.querySelector("#faction_war_list_id");
    if (factwarlist) {
      console.log(
        "[TornWarStuffEnhanced] Found #faction_war_list_id in document after 10 seconds.",
      );
      found_faction_war_list(factwarlist);
    }
    document_observer.disconnect();
  }, 10000);

  function cache_status(faction_id, status) {
    localStorage.setItem(
      `xentac-torn_war_stuff_enhanced-status-${faction_id}`,
      JSON.stringify({ timestamp: new Date().getTime(), status: status }),
    );
  }

  function populate_cached_status(faction_id) {
    const status = get_cached_status(faction_id);
    if (!status) {
      return;
    }

    for (const [k, v] of Object.entries(status)) {
      member_status.set(k, v);
    }
    console.log(
      "[TornWarStuffEnhanced] Populated member_status with previously cached values",
    );
  }

  function get_cached_status(faction_id) {
    const cache = localStorage.getItem(
      `xentac-torn_war_stuff_enhanced-status-${faction_id}`,
    );
    if (!cache) {
      return null;
    }
    try {
      const parsed = JSON.parse(cache);
      const now = new Date().getTime();
      if (parsed && now - parsed.timestamp > MIN_TIME_SINCE_LAST_REQUEST) {
        return null;
      }

      return parsed.status;
    } catch (e) {
      return null;
    }
  }

  function clean_cached_statuses() {
    const now = new Date().getTime();
    let cleaned_count = 0;
    Object.keys(localStorage).forEach((key) => {
      if (!key.startsWith("xentac-torn_war_stuff_enhanced-status-")) {
        return;
      }
      const value = localStorage.getItem(key);
      try {
        const parsed = JSON.parse(value);
        if (now - parsed.timestamp > MIN_TIME_SINCE_LAST_REQUEST) {
          localStorage.removeItem(key);
          cleaned_count++;
        }
      } catch (e) {
        localStorage.removeItem(key);
        cleaned_count++;
      }
    });
    console.log(
      `[TornWarStuffEnhanced] Cleaned ${cleaned_count} expired cached values`,
    );
  }

  async function update_statuses() {
    if (!running) {
      return;
    }
    const faction_ids = get_faction_ids();
    // If the faction ids are not yet available, give up and let us request again next time
    if (faction_ids.length == 0) {
      return;
    }
    if (
      last_request &&
      new Date() - last_request < MIN_TIME_SINCE_LAST_REQUEST
    ) {
      return;
    }
    last_request = new Date();
    for (let i = 0; i < faction_ids.length; i++) {
      if (!update_status(faction_ids[i])) {
        return;
      }
    }
  }

  async function update_status(faction_id) {
    let error = false;
    const status = await fetch(
      `https://api.torn.com/faction/${faction_id}?selections=basic&key=${apiKey}&comment=TornWarStuffEnhanced`,
    )
      .then((r) => r.json())
      .catch((m) => {
        console.error("[TornWarStuffEnhanced] ", m);
        error = true;
      });
    if (error) {
      return true;
    }
    if (status.error) {
      console.log(
        "[TornWarStuffEnhanced] Received error from torn API ",
        status.error,
      );
      if (
        [0, 1, 2, 3, 4, 6, 7, 10, 12, 13, 14, 16, 18, 21].includes(status.error)
      ) {
        console.log(
          "[TornWarStuffEnhanced] Received a non-recoverable error. Giving up.",
        );
        running = false;
        return false;
      }
      if ([5, 8, 9].includes(status.error.code)) {
        // 5: Too many requests error code
        // 8: IP block
        // 9: API disabled
        // Try again in 30 + MIN_TIME_SINCE_LAST_REQUEST seconds
        console.log("[TornWarStuffEnhanced] Retrying in 40 seconds.");
        last_request = new Date() + 30000;
      }
      return false;
    }
    if (!status.members) {
      return false;
    }
    const req_time = Date.now();
    const faction_status = {};
    for (const [k, v] of Object.entries(status.members)) {
      const status = v.status;
      status.last_req_time = req_time;

      const prev = member_status.get(k);
      const prev_state = prev?.state ?? "Unknown";
      const prev_since = prev?.since ?? req_time;
      const prev_traveling_error_bar = prev?.traveling_error_bar ?? 0;
      const prev_last_req_time = prev?.last_req_time;

      // Target Caller: a claim on this target auto-clears the instant they're
      // sent to hospital. Claiming an already-hospitalized target is still
      // allowed elsewhere (submitCall has no status check) — this only fires
      // on the transition into Hospital, not while they remain there.
      if (prev_state !== "Hospital" && status.state === "Hospital") {
        autoUncallOnHospital(k);
      }

      if (prev_state == status.state) {
        // If our previous state is the same as our current state, pass since and traveling_error_bars forward
        status.since = prev_since;
        status.traveling_error_bar = prev_traveling_error_bar;
      } else {
        // Otherwise set them new
        status.since = Date.now();
        if (prev_state != "Traveling") {
          // If they weren't traveling before but are now
          // Set the error bar based on the last request (so we can maybe predict flight times)
          // TODO: This needs to be cached in local storage (and cleaned up) so that it persists over refreshes
          v.traveling_error_bar = Date.now() - (prev_last_req_time ?? 0);
        }
      }

      member_status.set(k, status);
      faction_status[k] = status;
    }
    cache_status(faction_id, faction_status);
  }

  function extract_all_member_lis() {
    member_lis.clear();
    refresh_member_lists();
    get_member_lists().forEach((ul) => {
      extract_member_lis(ul);
    });
  }

  function extract_member_lis(ul) {
    const lis = ul.querySelectorAll("LI.enemy, li.your");
    lis.forEach((li) => {
      const atag = li.querySelector(`A[href^='/profiles.php']`);
      if (!atag) {
        return;
      }
      const id = atag.href.split("ID=")[1];
      member_lis.set(id, {
        li: li,
        div: li.querySelector("DIV.status"),
      });
    });
  }

  function queue_until(deferredWrites, node, until, dirty) {
    if (node.getAttribute("data-until") != until) {
      deferredWrites.push([node, "data-until", until]);
      return true;
    }
    return dirty;
  }
  function queue_since(deferredWrites, node, since, dirty) {
    if (node.getAttribute("data-since") != since) {
      deferredWrites.push([node, "data-since", since]);
      return true;
    }
    return dirty;
  }
  function queue_sort(deferredWrites, node, level, dirty) {
    if (node.getAttribute("data-sortA") != level) {
      deferredWrites.push([node, "data-sortA", level]);
      return true;
    }
    return dirty;
  }

  const TIME_BETWEEN_FRAMES = 500;
  const deferredWrites = [];

  const traveling_regex = /Traveling from ([\S ]+) to ([\S ]+)/;

  function extract_destinations_from_description(description) {
    if (!description.startsWith("Traveling from")) {
      return null;
    }

    const match = traveling_regex.exec(description);
    if (!match) {
      return null;
    }

    return {
      from: shorten_destination(match[1]),
      to: shorten_destination(match[2]),
    };
  }

  const DEST_TABLE = new Map([
    ["mexico", "MX"],
    ["cayman islands", "CI"],
    ["canada", "CA"],
    ["hawaii", "HI"],
    ["united kingdom", "UK"],
    ["argentina", "AR"],
    ["switzerland", "SW"],
    ["japan", "JP"],
    ["china", "CN"],
    ["uae", "UAE"],
    ["south africa", "SA"],
    ["torn", "TC"],
  ]);

  function shorten_destination(dest) {
    return DEST_TABLE.get(dest.toLowerCase().trim(), dest);
  }

  function calc_delta(delta, include_seconds = true, pad_hour = true) {
    const s = Math.floor(delta % 60);
    const m = Math.floor((delta / 60) % 60);
    const h = Math.floor(delta / 60 / 60);
    const hour_minute = `${pad_hour ? pad_with_zeros(h) : h}:${pad_with_zeros(m)}`;

    return hour_minute + (include_seconds ? `:${pad_with_zeros(s)}` : "");
  }

  function calculate_flight_time_remaining(li) {
    const earliest_arrival = li.getAttribute("data-earliest-arrival");
    const earliest_arrival_int = parseInt(earliest_arrival, 10);
    const latest_arrival = li.getAttribute("data-latest-arrival");
    const latest_arrival_int = parseInt(latest_arrival, 10);
    let flight_tracked = "";
    let flight_time_remaining_earliest = null;
    let flight_time_remaining_latest = null;
    if (
      !Number.isNaN(earliest_arrival_int) ||
      !Number.isNaN(latest_arrival_int)
    ) {
      let now = new Date().getTime() / 1000;
      if (window.getCurrentTimestamp) {
        now = window.getCurrentTimestamp() / 1000;
      }

      if (!Number.isNaN(earliest_arrival_int)) {
        flight_time_remaining_earliest = Math.round(earliest_arrival_int - now);
      }
      if (!Number.isNaN(latest_arrival_int)) {
        flight_time_remaining_latest = Math.round(latest_arrival_int - now);
      }
      if (flight_time_remaining_earliest > 0) {
        flight_tracked = ` ${calc_delta(flight_time_remaining_earliest, false, false)}`;
      } else if (flight_time_remaining_latest > 0) {
        flight_tracked = ` <${calc_delta(flight_time_remaining_latest, false, false)}`;
      } else {
        flight_tracked = ` LATE`;
      }
    }
    return flight_tracked;
  }

  function watch() {
    let dirtySort = false;
    deferredWrites.length = 0;
    member_lis.forEach((elem, id) => {
      const li = elem.li;
      if (!li) {
        return;
      }
      const status = member_status.get(id);
      const status_DIV = elem.div;
      if (!status_DIV) {
        return;
      }
      if (!status || !running) {
        // Make sure the user sees something before we've downloaded state
        status_DIV.style.setProperty(
          "--twse-content",
          `"${status_DIV.textContent}"`,
        );
        return;
      }

      dirtySort = queue_until(deferredWrites, li, status.until, dirtySort);
      dirtySort = queue_since(deferredWrites, li, status.since, dirtySort);
      let data_location = "";
      switch (status.state) {
        case "Abroad":
        case "Traveling":
          // API says they're traveling but site has updated. Trust the site and sort them to the top.
          if (
            !(
              status_DIV.classList.contains("traveling") ||
              status_DIV.classList.contains("abroad")
            )
          ) {
            if (status_DIV.textContent == "Okay") {
              dirtySort = queue_sort(deferredWrites, li, 0, dirtySort);
              deferredWrites.push([status_DIV, STATUS_DIFFERS, "true"]);
            }
            status_DIV.style.setProperty(
              "--twse-content",
              `"${status_DIV.textContent}"`,
            );
            break;
          }
          deferredWrites.push([
            status_DIV,
            "data-traveling-error-bar",
            status.traveling_error_bar,
          ]);
          deferredWrites.push([status_DIV, STATUS_DIFFERS, "false"]);
          if (status.description.includes("In ")) {
            dirtySort = queue_sort(deferredWrites, li, 4, dirtySort);
            const content = shorten_destination(
              status.description.split("In ")[1],
            );
            data_location = content;
            status_DIV.style.setProperty("--twse-content", `"${content}"`);
            break;
          }

          const location = extract_destinations_from_description(
            status.description,
          );
          if (location?.from == "TC") {
            dirtySort = queue_sort(deferredWrites, li, 5, dirtySort);
            const content = "► " + location.to;
            data_location = content;
            const flight_tracked = calculate_flight_time_remaining(li);
            status_DIV.style.setProperty(
              "--twse-content",
              `"${content}${flight_tracked}"`,
            );
          } else if (location?.to == "TC") {
            dirtySort = queue_sort(deferredWrites, li, 3, dirtySort);
            const content = "◄ " + location.from;
            data_location = content;
            const flight_tracked = calculate_flight_time_remaining(li);
            status_DIV.style.setProperty(
              "--twse-content",
              `"${content}${flight_tracked}"`,
            );
          } else {
            dirtySort = queue_sort(deferredWrites, li, 6, dirtySort);
            const content = "Traveling";
            data_location = content;
            status_DIV.style.setProperty("--twse-content", `"${content}"`);
          }
          break;
        case "Hospital":
        case "Jail":
          let now = new Date().getTime() / 1000;
          if (window.getCurrentTimestamp) {
            now = window.getCurrentTimestamp() / 1000;
          }
          const hosp_time_remaining = Math.round(status.until - now);
          if (
            !(
              status_DIV.classList.contains("hospital") ||
              status_DIV.classList.contains("jail")
            )
          ) {
            // Catch the natural but special case where someone meds out.
            // Our API knowledge will be that they still have hospital time
            // but they will be Okay.
            if (hosp_time_remaining >= 0) {
              dirtySort = queue_sort(deferredWrites, li, 0, dirtySort);
              deferredWrites.push([status_DIV, STATUS_DIFFERS, "true"]);
            }
            status_DIV.style.setProperty(
              "--twse-content",
              `"${status_DIV.textContent}"`,
            );
            deferredWrites.push([status_DIV, TRAVELING, "false"]);
            deferredWrites.push([status_DIV, HIGHLIGHT, "false"]);
            break;
          }
          deferredWrites.push([status_DIV, STATUS_DIFFERS, "false"]);
          dirtySort = queue_sort(deferredWrites, li, 2, dirtySort);
          if (status.description.includes("In a")) {
            deferredWrites.push([status_DIV, TRAVELING, "true"]);
          } else {
            deferredWrites.push([status_DIV, TRAVELING, "false"]);
          }

          if (hosp_time_remaining <= 0) {
            deferredWrites.push([status_DIV, HIGHLIGHT, "false"]);
            return;
          }
          const time_string = calc_delta(hosp_time_remaining);

          status_DIV.style.setProperty("--twse-content", `"${time_string}"`);

          if (hosp_time_remaining < 300) {
            deferredWrites.push([status_DIV, HIGHLIGHT, "true"]);
          } else {
            deferredWrites.push([status_DIV, HIGHLIGHT, "false"]);
          }
          break;

        default:
          status_DIV.style.setProperty(
            "--twse-content",
            `"${status_DIV.textContent}"`,
          );
          dirtySort = queue_sort(deferredWrites, li, 1, dirtySort);
          deferredWrites.push([status_DIV, TRAVELING, "false"]);
          deferredWrites.push([status_DIV, HIGHLIGHT, "false"]);
          deferredWrites.push([status_DIV, STATUS_DIFFERS, "false"]);
          break;
      }
      if (li.getAttribute("data-location") != data_location) {
        deferredWrites.push([li, "data-location", data_location]);
        dirtySort = true;
      }
    });
    for (const [elem, attrib, value] of deferredWrites) {
      elem.setAttribute(attrib, value);
    }
    deferredWrites.length = 0;
    // If ff scouter sorted our stuff but is no longer, then we should force a sort
    if (ffscouter_sorting_deferred) {
      const nodes = get_member_lists();
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute("data-ffscouter-active-filter") !== "true") {
          dirtySort = true;
          continue;
        }
      }
    }
    if (sort_enemies && dirtySort) {
      // Only sort if Status is the field to be sorted
      const nodes = get_member_lists();
      for (let i = 0; i < nodes.length; i++) {
        let sorted_column = get_sorted_column(nodes[i]);
        if (!ever_sorted) {
          sorted_column = { column: "status", order: "asc" };
        }
        // If FF Scouter is sorting, don't bother sorting ourselves:
        if (nodes[i].getAttribute("data-ffscouter-active-filter") === "true") {
          ffscouter_sorting_deferred = true;
          continue;
        }
        if (sorted_column["column"] != "status") {
          continue;
        }
        let lis = nodes[i].childNodes;
        let sorted_lis = Array.from(lis).sort((a, b) => {
          let left = a;
          let right = b;
          if (sorted_column["order"] == "desc") {
            left = b;
            right = a;
          }
          const sorta =
            left.getAttribute("data-sortA") - right.getAttribute("data-sortA");
          if (sorta != 0) {
            return sorta;
          }
          const left_location = left.getAttribute("data-location");
          const right_location = right.getAttribute("data-location");
          if (left_location && right_location) {
            if (left_location < right_location) {
              return -1;
            } else if (left_location == right_location) {
              return 0;
            } else {
              return 1;
            }
          }
          const sort = left.getAttribute("data-sortA");
          // Differs and Okay status sorts since oldest first
          if (sort === "0" || sort === "1") {
            return (
              right.getAttribute("data-since") - left.getAttribute("data-since")
            );
            // Hospital timers sort until soonest first
          } else {
            return (
              left.getAttribute("data-until") - right.getAttribute("data-until")
            );
          }
        });
        let sorted = true;
        for (let j = 0; j < sorted_lis.length; j++) {
          if (nodes[i].children[j] !== sorted_lis[j]) {
            sorted = false;
            break;
          }
        }
        if (!sorted) {
          const fragment = document.createDocumentFragment();
          sorted_lis.forEach((li) => {
            fragment.appendChild(li);
          });
          nodes[i].appendChild(fragment);
        }
      }
    }
    for (const [id, ref] of member_lis) {
      if (!ref.li.isConnected) {
        member_lis.delete(id);
      }
    }
  }

  setInterval(() => {
    if (!running || !found_war) return;
    update_statuses();
  }, MIN_TIME_SINCE_LAST_REQUEST);

  setInterval(() => {
    if (!found_war || !running || !pageVisible) {
      return;
    }

    watch();
  }, TIME_BETWEEN_FRAMES);

  setInterval(() => {
    if (!found_war || !running) {
      return;
    }
    fetchCalls().then(renderCallUI);
  }, CALL_POLL_INTERVAL);

  console.log("[TornWarStuffEnhanced] Initialized");

  clean_cached_statuses();

  window.dispatchEvent(new Event("FFScouterV2DisableWarMonitor"));
})();
