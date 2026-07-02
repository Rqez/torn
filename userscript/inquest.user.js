// ==UserScript==
// @name         InQuest Target Caller
// @namespace    inquest-target-caller
// @version      1.0.0
// @description  Faction war overlay: enemy status list + call/claim coordination, backed by your own sync server
// @author       you
// @match        https://www.torn.com/factions.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const state = {
        apiKey: GM_getValue('twh_api_key', ''),
        serverUrl: GM_getValue('twh_server_url', 'https://torn-kgyr.onrender.com'),
        serverSecret: GM_getValue('twh_server_secret', '6b2c7acfe19b84a2a8fa82b7eaf353c33f4c51149a65f2bf'),
        playerId: null,
        playerName: null,
        userFactionId: null,
        enemyFactionId: null,
        enemyFactionName: null,
        members: [],
        calls: [],
        panelMinimized: GM_getValue('twh_minimized', false),
    };

    function gmFetch(url, opts = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: opts.method || 'GET',
                url,
                headers: opts.headers || {},
                data: opts.body || undefined,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        try {
                            resolve(res.responseText ? JSON.parse(res.responseText) : {});
                        } catch (e) {
                            reject(e);
                        }
                    } else {
                        try {
                            resolve(JSON.parse(res.responseText));
                        } catch (e) {
                            reject(new Error(`HTTP ${res.status}`));
                        }
                    }
                },
                onerror: () => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    function tornApi(path) {
        return gmFetch(`https://api.torn.com${path}${path.includes('?') ? '&' : '?'}key=${state.apiKey}`);
    }

    function serverFetch(path, opts = {}) {
        const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        if (state.serverSecret) headers['Authorization'] = `Bearer ${state.serverSecret}`;
        return gmFetch(`${state.serverUrl}${path}`, Object.assign({}, opts, { headers }));
    }

    function isConfigured() {
        return !!(state.apiKey && state.serverUrl);
    }

    // ---- Settings modal ----

    function openSettings() {
        const existing = document.getElementById('twh-settings-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'twh-settings-modal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100000;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;';
        overlay.innerHTML = `
            <div style="background:#222;color:#eee;padding:20px 24px;border-radius:8px;width:380px;box-shadow:0 8px 30px rgba(0,0,0,0.5);">
                <h3 style="margin:0 0 12px;font-size:16px;">InQuest Target Caller Settings</h3>
                <label style="display:block;font-size:11px;color:#999;margin-bottom:4px;">Torn Public API Key</label>
                <input id="twh-set-apikey" type="text" value="${escapeAttr(state.apiKey)}"
                    style="width:100%;box-sizing:border-box;padding:6px 8px;margin-bottom:16px;background:#111;border:1px solid #444;color:#eee;border-radius:4px;">
                <div id="twh-set-error" style="color:#f66;font-size:12px;margin-bottom:8px;display:none;"></div>
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    <button id="twh-set-cancel" style="padding:6px 14px;background:#444;color:#eee;border:none;border-radius:4px;cursor:pointer;">Cancel</button>
                    <button id="twh-set-save" style="padding:6px 14px;background:#4a7a00;color:#fff;border:none;border-radius:4px;cursor:pointer;">Save</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#twh-set-cancel').onclick = () => overlay.remove();
        overlay.querySelector('#twh-set-save').onclick = async () => {
            const apiKey = overlay.querySelector('#twh-set-apikey').value.trim();
            const errEl = overlay.querySelector('#twh-set-error');
            errEl.style.display = 'none';

            if (!apiKey) {
                errEl.textContent = 'API key is required.';
                errEl.style.display = 'block';
                return;
            }
            try {
                const check = await tornApiWithKey(apiKey, '/v2/user?selections=profile');
                if (!check.profile || !check.profile.id) {
                    throw new Error(check.error ? check.error.error : 'Invalid response');
                }
            } catch (e) {
                errEl.textContent = `Could not validate API key: ${e.message}`;
                errEl.style.display = 'block';
                return;
            }

            GM_setValue('twh_api_key', apiKey);
            state.apiKey = apiKey;
            overlay.remove();
            init();
        };
    }

    function tornApiWithKey(key, path) {
        return gmFetch(`https://api.torn.com${path}${path.includes('?') ? '&' : '?'}key=${key}`);
    }

    function escapeAttr(s) {
        return String(s || '').replace(/"/g, '&quot;');
    }

    // ---- Data fetching ----

    async function fetchOwnInfo() {
        const data = await tornApi('/v2/user?selections=profile');
        if (!data.profile) throw new Error('Failed to load profile');
        state.playerId = String(data.profile.id);
        state.playerName = data.profile.name;
        state.userFactionId = data.profile.faction_id ? String(data.profile.faction_id) : null;
    }

    async function fetchWarInfo() {
        if (!state.userFactionId) return;
        const data = await tornApi(`/v2/faction/${state.userFactionId}/rankedwars`);
        const wars = Array.isArray(data.rankedwars)
            ? data.rankedwars
            : (data.rankedwars ? Object.values(data.rankedwars) : []);
        const activeWar = wars.find((w) => !w.end && !w.winner);
        if (!activeWar) {
            state.enemyFactionId = null;
            state.enemyFactionName = null;
            return;
        }
        const factions = Array.isArray(activeWar.factions) ? activeWar.factions : Object.values(activeWar.factions || {});
        const enemy = factions.find((f) => String(f.id) !== state.userFactionId);
        if (enemy) {
            state.enemyFactionId = String(enemy.id);
            state.enemyFactionName = enemy.name;
        }
    }

    async function fetchEnemyMembers() {
        if (!state.enemyFactionId) {
            state.members = [];
            return;
        }
        const data = await tornApi(`/v2/faction/${state.enemyFactionId}?selections=basic,members`);
        const raw = data.members;
        const list = Array.isArray(raw) ? raw : (raw ? Object.values(raw) : []);
        state.members = list.map((m) => {
            const status = m.status || {};
            const stateText = status.description || status.state || 'Unknown';
            const until = status.until || null;
            return {
                id: String(m.id ?? m.player_id ?? m.user_id),
                name: m.name || m.player_name || `#${m.id}`,
                level: m.level ?? 0,
                status: stateText,
                until,
            };
        }).filter((m) => m.id && m.id !== 'undefined');
        if (!state.enemyFactionName && data.basic && data.basic.name) {
            state.enemyFactionName = data.basic.name;
        }
    }

    async function fetchCalls() {
        if (!state.userFactionId) return;
        try {
            const data = await serverFetch(`/api/calls?factionId=${state.userFactionId}`);
            state.calls = data.calls || [];
        } catch (e) {
            // server unreachable — keep last known calls, surface via panel status
            state.serverError = e.message;
        }
    }

    async function callMember(member) {
        try {
            const data = await serverFetch('/api/call', {
                method: 'POST',
                body: JSON.stringify({
                    factionId: state.userFactionId,
                    memberId: member.id,
                    memberName: member.name,
                    callerId: state.playerId,
                    callerName: state.playerName,
                }),
            });
            if (data.error === 'already_called') {
                alert(`${member.name} is already called by ${data.call.callerName}`);
                return;
            }
            await fetchCalls();
            renderPanel();
        } catch (e) {
            alert(`Call failed: ${e.message}`);
        }
    }

    async function uncallMember(call) {
        try {
            await serverFetch(`/api/call/${call.id}/cancel`, {
                method: 'POST',
                body: JSON.stringify({ factionId: state.userFactionId }),
            });
            await fetchCalls();
            renderPanel();
        } catch (e) {
            alert(`Uncall failed: ${e.message}`);
        }
    }

    // ---- UI ----

    function statusRank(text) {
        const t = (text || '').toLowerCase();
        if (t.includes('okay')) return 0;
        if (t.includes('traveling') || t.includes('abroad')) return 1;
        if (t.includes('jail')) return 2;
        if (t.includes('hospital')) return 3;
        return 4;
    }

    function formatHospTimer(untilTs) {
        if (!untilTs) return '';
        const remaining = untilTs * 1000 - Date.now();
        if (remaining <= 0) return '';
        const totalSec = Math.floor(remaining / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function ensurePanel() {
        let panel = document.getElementById('twh-panel');
        if (panel) return panel;

        panel = document.createElement('div');
        panel.id = 'twh-panel';
        panel.style.cssText = `
            position:fixed;top:80px;right:20px;width:340px;max-height:70vh;
            background:#1a1a1a;color:#ddd;border:1px solid #444;border-radius:8px;
            font-family:Arial,sans-serif;font-size:12px;z-index:99999;
            box-shadow:0 6px 24px rgba(0,0,0,0.5);display:flex;flex-direction:column;overflow:hidden;
        `;
        panel.innerHTML = `
            <div id="twh-header" style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#2a2a2a;cursor:move;border-bottom:1px solid #444;">
                <strong style="font-size:12px;">InQuest Target Caller</strong>
                <div style="display:flex;gap:6px;">
                    <button id="twh-refresh" title="Refresh now" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:14px;">&#8635;</button>
                    <button id="twh-settings-btn" title="Settings" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:14px;">&#9881;</button>
                    <button id="twh-minimize" title="Minimize" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:14px;">&#8722;</button>
                </div>
            </div>
            <div id="twh-body" style="overflow-y:auto;padding:8px 10px;flex:1;"></div>
        `;
        document.body.appendChild(panel);

        panel.querySelector('#twh-settings-btn').onclick = openSettings;
        panel.querySelector('#twh-refresh').onclick = () => refreshAll();
        panel.querySelector('#twh-minimize').onclick = () => {
            state.panelMinimized = !state.panelMinimized;
            GM_setValue('twh_minimized', state.panelMinimized);
            renderPanel();
        };
        makeDraggable(panel, panel.querySelector('#twh-header'));
        return panel;
    }

    function makeDraggable(panel, handle) {
        let dragging = false, offX = 0, offY = 0;
        handle.addEventListener('mousedown', (e) => {
            dragging = true;
            const rect = panel.getBoundingClientRect();
            offX = e.clientX - rect.left;
            offY = e.clientY - rect.top;
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            panel.style.left = `${e.clientX - offX}px`;
            panel.style.top = `${e.clientY - offY}px`;
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    }

    function renderPanel() {
        const panel = ensurePanel();
        const body = panel.querySelector('#twh-body');

        if (state.panelMinimized) {
            body.style.display = 'none';
            return;
        }
        body.style.display = 'block';

        if (!isConfigured()) {
            body.innerHTML = `<p>Set your Torn API key to get started.</p>
                <button id="twh-open-settings" style="padding:6px 12px;background:#4a7a00;color:#fff;border:none;border-radius:4px;cursor:pointer;">Open Settings</button>`;
            body.querySelector('#twh-open-settings').onclick = openSettings;
            return;
        }

        if (!state.enemyFactionId) {
            body.innerHTML = `<p>No active ranked war detected for your faction.</p>`;
            return;
        }

        const callsByMember = new Map(state.calls.map((c) => [c.memberId, c]));
        const sorted = [...state.members].sort((a, b) => statusRank(a.status) - statusRank(b.status));

        const rows = sorted.map((m) => {
            const call = callsByMember.get(m.id);
            const hospTimer = m.status.toLowerCase().includes('hospital') ? formatHospTimer(m.until) : '';
            const statusLabel = hospTimer ? `Hospital ${hospTimer}` : m.status;
            const isMine = call && String(call.callerId) === String(state.playerId);
            const calledByLabel = call ? `${escapeAttr(call.callerName)}` : '—';
            const calledByColor = call ? (isMine ? '#8f8' : '#ffb84d') : '#555';

            const actionCell = call
                ? (isMine
                    ? `<button class="twh-uncall" data-callid="${call.id}" style="background:#4a7a00;color:#fff;border:none;border-radius:3px;padding:3px 6px;cursor:pointer;font-size:10px;">Uncall</button>`
                    : '')
                : `<button class="twh-call" data-id="${m.id}" style="background:#333;color:#eee;border:1px solid #555;border-radius:3px;padding:3px 6px;cursor:pointer;font-size:10px;">Call</button>`;
            return `
                <tr style="border-bottom:1px solid #2a2a2a;">
                    <td style="padding:4px 2px;"><a href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank" style="color:#8cf;text-decoration:none;">${escapeAttr(m.name)}</a></td>
                    <td style="padding:4px 2px;text-align:center;color:#fff;">${m.level}</td>
                    <td style="padding:4px 2px;color:#fff;">${escapeAttr(statusLabel)}</td>
                    <td style="padding:4px 2px;text-align:center;"><a href="https://www.torn.com/page.php?sid=attack&user2ID=${m.id}" target="_blank" style="color:#8f8;text-decoration:none;">Atk</a></td>
                    <td style="padding:4px 2px;color:${calledByColor};">${calledByLabel}</td>
                    <td style="padding:4px 2px;text-align:right;">${actionCell}</td>
                </tr>
            `;
        }).join('');

        body.innerHTML = `
            <div style="margin-bottom:6px;font-size:11px;color:#999;">
                vs <strong style="color:#e66;">${escapeAttr(state.enemyFactionName || state.enemyFactionId)}</strong>
                ${state.serverError ? `<span style="color:#f66;"> — sync error: ${escapeAttr(state.serverError)}</span>` : ''}
            </div>
            <table style="width:100%;border-collapse:collapse;">
                <thead>
                    <tr style="color:#888;font-size:10px;text-transform:uppercase;">
                        <th style="text-align:left;padding:2px;">Name</th>
                        <th style="text-align:center;padding:2px;">Lvl</th>
                        <th style="text-align:left;padding:2px;">Status</th>
                        <th style="padding:2px;"></th>
                        <th style="text-align:left;padding:2px;">Called By</th>
                        <th style="padding:2px;"></th>
                    </tr>
                </thead>
                <tbody>${rows || '<tr><td colspan="6" style="padding:8px 2px;color:#888;">No members loaded yet.</td></tr>'}</tbody>
            </table>
        `;

        body.querySelectorAll('.twh-call').forEach((btn) => {
            btn.onclick = () => {
                const member = state.members.find((m) => m.id === btn.dataset.id);
                if (member) callMember(member);
            };
        });
        body.querySelectorAll('.twh-uncall').forEach((btn) => {
            btn.onclick = () => {
                const call = state.calls.find((c) => c.id === btn.dataset.callid);
                if (call) uncallMember(call);
            };
        });
    }

    // ---- Polling loops ----

    let warPollTimer = null;
    let callPollTimer = null;

    async function refreshAll() {
        try {
            state.serverError = null;
            if (!state.userFactionId) await fetchOwnInfo();
            await fetchWarInfo();
            await fetchEnemyMembers();
            await fetchCalls();
        } catch (e) {
            console.log('[InQuest Target Caller] refresh error', e);
        }
        renderPanel();
    }

    function startPolling() {
        if (warPollTimer) clearInterval(warPollTimer);
        if (callPollTimer) clearInterval(callPollTimer);
        warPollTimer = setInterval(async () => {
            try {
                await fetchWarInfo();
                await fetchEnemyMembers();
            } catch (e) { /* keep last known data */ }
            renderPanel();
        }, 20000);
        callPollTimer = setInterval(async () => {
            await fetchCalls();
            renderPanel();
        }, 3000);

        // fast local countdown re-render for hospital timers, no network
        setInterval(() => {
            if (!state.panelMinimized && state.members.some((m) => m.status.toLowerCase().includes('hospital'))) {
                renderPanel();
            }
        }, 1000);
    }

    async function init() {
        ensurePanel();
        if (!isConfigured()) {
            renderPanel();
            return;
        }
        await refreshAll();
        startPolling();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
