'use strict';

// Always-on background poller for the Torn Player Location Watcher.
//
// Config (API keys, watch list, Discord webhook) is NOT hardcoded here —
// it lives entirely in the shared jsonbin.io bin, editable directly via
// jsonbin's own web dashboard. This process only needs two secrets to know
// WHERE that bin is: JSONBIN_ID and JSONBIN_KEY, set as environment
// variables on whatever host runs this (e.g. Render's dashboard).
//
// This participates in the SAME cross-device lock protocol as the
// Tampermonkey browser script (torn-player-location-watcher.user.js), with
// a fixed device id and the best possible priority, so it always wins over
// any laptop that happens to also be running — while still falling back
// gracefully to a laptop if this server ever goes down.
//
// IMPORTANT: jsonbin.io's free tier caps out at 10,000 requests total. A
// 24/7 process cannot use the browser script's original 15-second lock
// heartbeat (that alone would exhaust the quota in under 2 days). Every
// interval below is chosen so this process's OWN jsonbin usage stays well
// under budget even running continuously for a full month — see the
// comments on JSONBIN_SYNC_INTERVAL_MS. Torn API polling itself (every
// CHECK_GAP_MS) never touches jsonbin at all, so it isn't affected.

const http = require('http');

// ════════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════════

const JSONBIN_ID = process.env.JSONBIN_ID;
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const PORT = process.env.PORT || 3000;

const JSONBIN_BASE = 'https://api.jsonbin.io/v3/b';
const TORN_API_BASE = 'https://api.torn.com/v2';

const CHECK_GAP_MS = 3_000;        // gap between checking one Torn profile and the next
const PER_REQUEST_DELAY_MS = 800;  // gap between Torn API calls reusing the same key
const INACTIVITY_TTL_SEC = 60 * 60; // auto-uncheck a player after this long offline

// jsonbin sync cadence — deliberately conservative. At one read+maybe-write
// every 10 minutes, this process alone uses ~4,320 requests/month (144/day),
// leaving headroom under the 10,000 free-tier cap even if a couple of
// laptops also check in occasionally on the same bin. Config edits made via
// jsonbin's dashboard take up to this long to reach the server — that's the
// deliberate trade-off for staying on the free tier.
const JSONBIN_SYNC_INTERVAL_MS = 10 * 60_000;
const DEVICE_LOCK_TTL_MS = 3 * JSONBIN_SYNC_INTERVAL_MS; // 30 min grace before another device may take over

const DEFAULT_DEVICE_PRIORITY = 100; // matches the browser script's default
const SERVER_DEVICE_ID = 'render-server-1'; // FIXED — must survive restarts so it can immediately reclaim its own lock
const SERVER_DEVICE_NAME = 'Render Server';
const SERVER_PRIORITY = 1; // better (lower) than the browser script's default of 100 — this always wins when online

if (!JSONBIN_ID || !JSONBIN_KEY) {
  console.error('[FATAL] Set JSONBIN_ID and JSONBIN_KEY environment variables (Render dashboard → Environment).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════
//  JSONBIN — shared config + cross-device lock record
// ════════════════════════════════════════════════════════════

async function jsonbinGet() {
  try {
    const res = await fetch(`${JSONBIN_BASE}/${JSONBIN_ID}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_KEY },
    });
    if (!res.ok) {
      console.warn(`[jsonbin] read failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data.record || null;
  } catch (e) {
    console.warn('[jsonbin] read failed:', e.message);
    return null;
  }
}

async function jsonbinPut(record) {
  try {
    const res = await fetch(`${JSONBIN_BASE}/${JSONBIN_ID}`, {
      method: 'PUT',
      headers: { 'X-Master-Key': JSONBIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    return res.ok;
  } catch (e) {
    console.warn('[jsonbin] write failed:', e.message);
    return false;
  }
}

// Last-known copy of the shared record (owner/name/priority/ts, apiKeys,
// watchList, discordWebhook, discordMessageId, *UpdatedAt fields). Refreshed
// only every JSONBIN_SYNC_INTERVAL_MS — see the quota comment above.
let sharedRecord = null;

function getApiKeys() {
  return (sharedRecord && sharedRecord.apiKeys) || [];
}

function getWatchList() {
  return (sharedRecord && sharedRecord.watchList) || [];
}

function getDiscordWebhook() {
  return (sharedRecord && sharedRecord.discordWebhook) || '';
}

function getEnabledIds() {
  return getWatchList().filter((e) => e.enabled).map((e) => e.id);
}

// Writes the full shared record back (local watch-list mutations — right
// now just the auto-uncheck-for-inactivity path — need to push their
// change back so it isn't overwritten by the next pull, and so the
// jsonbin dashboard reflects it too).
async function pushSharedRecord() {
  if (!sharedRecord) return;
  const ok = await jsonbinPut(sharedRecord);
  if (!ok) console.warn('[jsonbin] Failed to push updated record.');
}

// ════════════════════════════════════════════════════════════
//  CROSS-DEVICE LOCK — same protocol as the browser script's
//  refreshDeviceLockIfDue(), just with a fixed identity and the best
//  possible priority, so this server always wins over a laptop whenever
//  it's online, and falls back to a laptop automatically if it ever goes
//  down for longer than DEVICE_LOCK_TTL_MS.
// ════════════════════════════════════════════════════════════

let isActive = true;

async function refreshLockAndConfig() {
  const remote = await jsonbinGet();
  if (!remote) {
    console.warn('[lock] Could not read the shared record this cycle — keeping previous state.');
    return;
  }
  sharedRecord = remote;

  const now = Date.now();
  const remotePriority = remote.priority != null ? remote.priority : DEFAULT_DEVICE_PRIORITY;
  const isFree = !remote.owner;
  const isOurs = remote.owner === SERVER_DEVICE_ID;
  const isStale = remote.ts != null && now - remote.ts > DEVICE_LOCK_TTL_MS;
  const hasBetterPriority = !isOurs && SERVER_PRIORITY < remotePriority;

  const wasActive = isActive;
  if (isFree || isOurs || isStale || hasBetterPriority) {
    sharedRecord = { ...remote, owner: SERVER_DEVICE_ID, name: SERVER_DEVICE_NAME, priority: SERVER_PRIORITY, ts: now };
    const ok = await jsonbinPut(sharedRecord);
    isActive = ok;
    if (ok && !isOurs) console.log('[lock] This server is now the active instance.');
  } else {
    isActive = false;
    if (wasActive) console.log(`[lock] Another device (${remote.name || remote.owner}) is active — standing by.`);
  }
}

// ════════════════════════════════════════════════════════════
//  TORN API — same per-key rate gating and round-robin as the browser
//  script's apiGet()/nextApiKey().
// ════════════════════════════════════════════════════════════

let rotationIndex = 0;
const lastRequestByKey = {};

function nextApiKey() {
  const keys = getApiKeys();
  if (keys.length === 0) return null;
  const key = keys[rotationIndex % keys.length];
  rotationIndex++;
  return key;
}

async function apiGet(path) {
  const key = nextApiKey();
  if (!key) throw new Error('no_api_keys');

  const lastForThisKey = lastRequestByKey[key] || 0;
  const wait = PER_REQUEST_DELAY_MS - (Date.now() - lastForThisKey);
  if (wait > 0) await sleep(wait);
  lastRequestByKey[key] = Date.now();

  const url = `${TORN_API_BASE}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  const data = await res.json();
  if (data && data.error) throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`);
  return data;
}

// Same fields as the browser script's fetchStatus(): profile.status (state,
// description) and profile.last_action (status, timestamp) for the
// inactivity auto-uncheck.
async function fetchStatus(id) {
  const data = await apiGet(`/user/${id}?selections=profile`);
  const profile = data.profile;
  if (!profile || !profile.status) {
    console.error(`[TLW] Unexpected profile response for ${id}:`, JSON.stringify(data).slice(0, 300));
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

// Same redundant-description fix as the browser script's formatStatusLine().
function formatStatusLine(state, description) {
  if (description === state) {
    const location = (state === 'Okay' || state === 'Jail' || state === 'Federal') ? 'Torn' : state;
    return `${location} — ${state}`;
  }
  return `${state}${description ? ' — ' + description : ''}`;
}

// ════════════════════════════════════════════════════════════
//  DISCORD — same persistent-dashboard + transient-alert pattern as the
//  browser script. The dashboard message id is stored on sharedRecord
//  (pushed immediately when it changes — rare, so this doesn't add to the
//  jsonbin quota concern above in any meaningful way).
//
//  NOTE: if you change "discordWebhook" via the jsonbin dashboard (pointing
//  it at a different channel), also manually clear "discordMessageId" to
//  null in that same edit — a message id from the old webhook's channel
//  isn't valid under a new one, and only a 404 auto-recovers (see
//  syncDiscordMessage below); other failure codes just log a warning.
// ════════════════════════════════════════════════════════════

function buildDiscordContent() {
  const list = getWatchList().filter((e) => e.enabled);
  const footer = `_from: ${SERVER_DEVICE_NAME}_`;
  if (list.length === 0) return `📍 **Location Watch** — no players currently checked.\n${footer}`;
  const lines = list.map((entry) => {
    const s = lastStatusById.get(entry.id);
    const name = (s && s.name) || `#${entry.id}`;
    const line = s ? formatStatusLine(s.state, s.description) : 'checking...';
    return `**${name}**: ${line}`;
  });
  return `📍 **Location Watch**\n${lines.join('\n')}\n\n${footer}`;
}

async function postNewDiscordMessage(webhook, content) {
  try {
    const res = await fetch(`${webhook}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      console.warn(`[discord] post failed: HTTP ${res.status}`);
      return;
    }
    const msg = await res.json();
    if (msg.id && sharedRecord) {
      sharedRecord.discordMessageId = msg.id;
      await pushSharedRecord();
    }
  } catch (e) {
    console.warn('[discord] post failed:', e.message);
  }
}

async function syncDiscordMessage() {
  const webhook = getDiscordWebhook();
  if (!webhook) return;
  const content = buildDiscordContent();
  const messageId = sharedRecord && sharedRecord.discordMessageId;

  if (!messageId) {
    await postNewDiscordMessage(webhook, content);
    return;
  }
  try {
    const res = await fetch(`${webhook}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (res.status === 404) {
      if (sharedRecord) sharedRecord.discordMessageId = null;
      await postNewDiscordMessage(webhook, content);
    } else if (!res.ok) {
      console.warn(`[discord] edit failed: HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn('[discord] edit failed:', e.message);
  }
}

async function deleteDiscordMessage(webhook, messageId) {
  try {
    const res = await fetch(`${webhook}/messages/${messageId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) console.warn(`[discord] alert delete failed: HTTP ${res.status}`);
  } catch (e) {
    console.warn('[discord] alert delete failed:', e.message);
  }
}

const TRANSIENT_ALERT_TTL_MS = 10_000;

async function sendTransientDiscordAlert(content) {
  const webhook = getDiscordWebhook();
  if (!webhook) return;
  try {
    const res = await fetch(`${webhook}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      console.warn(`[discord] alert post failed: HTTP ${res.status}`);
      return;
    }
    const msg = await res.json();
    if (msg.id) setTimeout(() => deleteDiscordMessage(webhook, msg.id), TRANSIENT_ALERT_TTL_MS);
  } catch (e) {
    console.warn('[discord] alert post failed:', e.message);
  }
}

// ════════════════════════════════════════════════════════════
//  POLLING — same round-robin-one-player-per-tick as the browser script's
//  nextPlayerId()/checkOnePlayer(). lastStatus is in-memory only (not
//  persisted to jsonbin, to avoid adding to the request quota) — a
//  restart causes one round of silent "baseline" resets, no alerts.
// ════════════════════════════════════════════════════════════

const lastStatusById = new Map();
let playerRotationIndex = 0;

function nextPlayerId() {
  const ids = getEnabledIds();
  if (ids.length === 0) return null;
  const id = ids[playerRotationIndex % ids.length];
  playerRotationIndex++;
  return id;
}

function checkInactivity(curr) {
  if (curr.lastActionStatus !== 'Offline' || !curr.lastActionTimestamp) return false;
  const offlineSec = Date.now() / 1000 - curr.lastActionTimestamp;
  if (offlineSec <= INACTIVITY_TTL_SEC) return false;

  const entry = getWatchList().find((e) => e.id === curr.id);
  if (entry && entry.enabled) {
    entry.enabled = false;
    console.log(`[TLW] Auto-unchecked ${curr.name} (#${curr.id}) — offline for over 1 hour.`);
    return true; // caller pushes the updated record
  }
  return false;
}

async function checkOnePlayer(id) {
  try {
    const curr = await fetchStatus(id);
    if (!curr) return;
    const prev = lastStatusById.get(id);

    if (!prev) {
      lastStatusById.set(id, curr);
      console.log(`[TLW] ${curr.name} (#${id}): baseline set — ${curr.state} (${curr.description})`);
    } else {
      if (prev.state !== curr.state) {
        console.log(`[TLW] ${curr.name} (#${id}): ${prev.state} -> ${curr.state} — ${curr.description}`);
        await sendTransientDiscordAlert(
          `🔔 **${curr.name}**: ${prev.state} → ${curr.state}${curr.description ? ` (${curr.description})` : ''}`
        );
      }
      lastStatusById.set(id, curr);
    }

    const watchListChanged = checkInactivity(curr);
    if (watchListChanged) await pushSharedRecord();

    await syncDiscordMessage();
  } catch (e) {
    console.warn(`[TLW] Failed to check #${id}:`, e.message);
  }
}

// ════════════════════════════════════════════════════════════
//  MAIN LOOP
// ════════════════════════════════════════════════════════════

async function mainLoop(initialSyncAt) {
  let lastSyncAt = initialSyncAt;
  while (true) {
    if (Date.now() - lastSyncAt >= JSONBIN_SYNC_INTERVAL_MS) {
      lastSyncAt = Date.now();
      await refreshLockAndConfig();
    }

    if (isActive && getApiKeys().length > 0 && getWatchList().length > 0) {
      const id = nextPlayerId();
      if (id != null) await checkOnePlayer(id);
    }

    await sleep(CHECK_GAP_MS);
  }
}

// ════════════════════════════════════════════════════════════
//  HTTP — trivial endpoint purely for an external keep-alive pinger (e.g.
//  UptimeRobot hitting this URL every ~10 min) to stop Render's free tier
//  from spinning the process down after 15 min of no traffic. The actual
//  polling loop above runs independently of any HTTP traffic.
// ════════════════════════════════════════════════════════════

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(isActive ? 'active' : 'standing by');
}).listen(PORT, () => {
  console.log(`[http] Keep-alive endpoint listening on port ${PORT}.`);
});

(async () => {
  console.log('[TLW] Starting. Doing an initial jsonbin sync before the first Torn check...');
  await refreshLockAndConfig();
  mainLoop(Date.now());
})();
