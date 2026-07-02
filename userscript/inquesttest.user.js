// ==UserScript==
// @name         InQuest Target Caller
// @namespace    inquest-target-caller
// @version      2.0.0
// @description  Faction war overlay: enemy status list + call/claim coordination, backed by your own sync server
// @author       you
// @match        https://www.torn.com/factions.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.com
// @connect      torn-kgyr.onrender.com
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
        serverError: null,
        widgetOpen: GM_getValue('twh_widget_open', false),
    };

    // TornPDA (Android/iOS webview) exposes one of these globals — used only to
    // bump touch-target sizing, never to change how requests are made.
    const isPDA = typeof window.flutter_inappwebview !== 'undefined' || typeof window.PDA_httpGet !== 'undefined';

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

    function tornApiWithKey(key, path) {
        return gmFetch(`https://api.torn.com${path}${path.includes('?') ? '&' : '?'}key=${key}`);
    }

    function serverFetch(path, opts = {}) {
        const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
        if (state.serverSecret) headers['Authorization'] = `Bearer ${state.serverSecret}`;
        return gmFetch(`${state.serverUrl}${path}`, Object.assign({}, opts, { headers }));
    }

    function isConfigured() {
        return !!(state.apiKey && state.serverUrl);
    }

    function escapeAttr(s) {
        return String(s || '').replace(/"/g, '&quot;');
    }

    // ---- Styles ----

    function injectStyles() {
        if (document.getElementById('iq-styles')) return;
        const style = document.createElement('style');
        style.id = 'iq-styles';
        style.textContent = `
            .iq-call-btn {
                all: unset !important;
                box-sizing: border-box !important;
                position: absolute !important;
                top: 50% !important;
                right: calc(100% + 6px) !important;
                transform: translateY(-50%) !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                z-index: 10 !important;
                padding: 2px 7px !important;
                min-width: 22px !important;
                width: max-content !important;
                max-width: none !important;
                height: 18px !important;
                font-family: Arial, sans-serif !important;
                font-size: 12px !important;
                font-weight: 800 !important;
                line-height: 1 !important;
                text-transform: none !important;
                letter-spacing: 0 !important;
                text-align: center !important;
                text-indent: 0 !important;
                text-overflow: clip !important;
                text-decoration: none !important;
                overflow: visible !important;
                border-radius: 3px !important;
                border: 1px solid #163a1a !important;
                cursor: pointer !important;
                background: linear-gradient(180deg, #5fcf5f 0%, #3a9a3a 60%, #257a25 100%) !important;
                color: #fff !important;
                box-shadow: 0 1px 4px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.25) !important;
                text-shadow: 0 1px 1px rgba(0,0,0,0.5) !important;
                transition: background 0.15s ease, opacity 0.15s ease !important;
                white-space: nowrap !important;
            }
            .iq-call-btn:active:not(:disabled) {
                transform: translateY(-50%) translateY(1px) !important;
            }
            .iq-call-btn:hover:not(:disabled) {
                background: linear-gradient(180deg, #6fdf6f 0%, #4aaa4a 60%, #358a35 100%) !important;
            }
            .iq-call-btn.iq-mine {
                background: linear-gradient(180deg, #e06a6a 0%, #b53a3a 60%, #7a1f1f 100%) !important;
                border-color: #4a1010 !important;
                color: #fff !important;
            }
            .iq-call-btn.iq-mine:hover {
                background: linear-gradient(180deg, #f07a7a 0%, #c54a4a 60%, #8a2f2f 100%) !important;
            }
            .iq-call-btn.iq-other {
                background: linear-gradient(180deg, #e06a6a 0%, #b53a3a 60%, #7a1f1f 100%) !important;
                border-color: #4a1010 !important;
                color: #fff !important;
                cursor: not-allowed !important;
                opacity: 0.9 !important;
            }
            body.iq-pda .iq-call-btn {
                min-width: 28px !important;
                height: 24px !important;
                font-size: 14px !important;
                padding: 3px 9px !important;
            }
            .iq-call-btn .iq-tooltip {
                all: unset !important;
                position: absolute !important;
                top: calc(100% + 6px) !important;
                left: 50% !important;
                transform: translateX(-50%) !important;
                display: block !important;
                background: #16171b !important;
                color: #eee !important;
                padding: 4px 9px !important;
                border: 1px solid rgba(255,255,255,0.12) !important;
                border-radius: 4px !important;
                font-family: Arial, sans-serif !important;
                font-size: 11px !important;
                font-weight: 400 !important;
                text-transform: none !important;
                letter-spacing: normal !important;
                white-space: nowrap !important;
                pointer-events: none !important;
                z-index: 999 !important;
                opacity: 0 !important;
                transition: opacity 0.1s ease !important;
                box-shadow: 0 4px 14px rgba(0,0,0,0.5) !important;
            }
            .iq-call-btn:hover .iq-tooltip {
                opacity: 1 !important;
            }

            #iq-launcher {
                position: fixed;
                bottom: 16px;
                right: 16px;
                z-index: 99999;
                width: 42px;
                height: 42px;
                border-radius: 50%;
                background: linear-gradient(145deg, #2c3038, #14161a);
                border: 1px solid rgba(255,255,255,0.12);
                box-shadow: 0 4px 16px rgba(0,0,0,0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                color: #8fd3ff;
                font-family: Arial, sans-serif;
                font-weight: 700;
                font-size: 12px;
                user-select: none;
            }
            body.iq-pda #iq-launcher {
                width: 50px;
                height: 50px;
                bottom: 20px;
                right: 20px;
                font-size: 14px;
            }
            #iq-launcher .iq-dot {
                position: absolute;
                top: 1px;
                right: 1px;
                width: 9px;
                height: 9px;
                border-radius: 50%;
                background: #666;
                border: 1px solid #14161a;
            }
            #iq-launcher .iq-dot.ok { background: #5adf6b; }
            #iq-launcher .iq-dot.err { background: #e06060; }

            #iq-widget {
                position: fixed;
                bottom: 66px;
                right: 16px;
                z-index: 99999;
                width: 230px;
                max-width: calc(100vw - 32px);
                background: linear-gradient(180deg, #1c1e24, #15161a);
                color: #ddd;
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 10px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.55);
                font-family: Arial, sans-serif;
                font-size: 12px;
                overflow: hidden;
            }
            #iq-widget-header {
                padding: 10px 12px;
                background: rgba(255,255,255,0.04);
                border-bottom: 1px solid rgba(255,255,255,0.08);
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            #iq-widget-header strong { font-size: 12px; color: #8fd3ff; }
            #iq-widget-body { padding: 10px 12px; }
            #iq-widget-body p { margin: 0 0 8px; color: #aaa; line-height: 1.5; }
            .iq-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
            .iq-icon-btn {
                background: none; border: none; color: #999; cursor: pointer; font-size: 14px;
                padding: 2px 4px; border-radius: 4px;
            }
            .iq-icon-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }
            .iq-btn {
                padding: 6px 12px;
                border-radius: 6px;
                border: 1px solid rgba(255,255,255,0.12);
                background: linear-gradient(180deg, #3d3d3d, #202020);
                color: #eee;
                cursor: pointer;
                font-size: 12px;
                width: 100%;
                box-sizing: border-box;
            }
            .iq-btn:hover { background: linear-gradient(180deg, #4d4d4d, #282828); }
            .iq-btn-primary {
                background: linear-gradient(180deg, #6bb300, #3f6000);
                border-color: #1a3000;
                color: #fff;
            }
            .iq-btn-primary:hover { background: linear-gradient(180deg, #7bc300, #4f7000); }
            #iq-settings-modal {
                position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100000;
                display: flex; align-items: center; justify-content: center; font-family: Arial, sans-serif;
            }
            #iq-settings-modal .iq-modal-card {
                background: linear-gradient(160deg, #20232b, #14151a);
                color: #eee;
                padding: 22px 24px;
                border-radius: 12px;
                width: 360px;
                max-width: calc(100vw - 40px);
                box-shadow: 0 20px 60px rgba(0,0,0,0.55);
                border: 1px solid rgba(143, 211, 255, 0.25);
            }
            #iq-settings-modal h3 { margin: 0 0 14px; font-size: 15px; color: #8fd3ff; }
            #iq-settings-modal label {
                display: block; font-size: 10px; color: #999; margin-bottom: 4px;
                text-transform: uppercase; letter-spacing: 0.4px;
            }
            #iq-settings-modal input {
                width: 100%; box-sizing: border-box; padding: 8px 10px; margin-bottom: 14px;
                background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.12);
                color: #eee; border-radius: 6px; font-family: 'Monaco','Menlo',monospace; font-size: 12px;
            }
            #iq-settings-modal input:focus { outline: none; border-color: #8fd3ff; }
        `;
        document.head.appendChild(style);
    }

    // ---- Settings modal ----

    function openSettings() {
        const existing = document.getElementById('iq-settings-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'iq-settings-modal';
        overlay.innerHTML = `
            <div class="iq-modal-card">
                <h3>InQuest Target Caller Settings</h3>
                <label>Torn Public API Key</label>
                <input id="twh-set-apikey" type="text" value="${escapeAttr(state.apiKey)}">
                <div id="twh-set-error" style="color:#f77;font-size:11px;margin-bottom:8px;display:none;"></div>
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    <button id="twh-set-cancel" class="iq-btn" style="width:auto;">Cancel</button>
                    <button id="twh-set-save" class="iq-btn iq-btn-primary" style="width:auto;">Save</button>
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
            state.serverError = null;
        } catch (e) {
            // server unreachable — keep last known calls, surface via widget status
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
            render();
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
            render();
        } catch (e) {
            alert(`Uncall failed: ${e.message}`);
        }
    }

    function handleCallClick(memberId) {
        const call = state.calls.find((c) => String(c.memberId) === String(memberId));
        if (call) {
            if (String(call.callerId) === String(state.playerId)) uncallMember(call);
            return;
        }
        const member = state.members.find((m) => m.id === String(memberId)) || { id: String(memberId), name: `#${memberId}` };
        callMember(member);
    }

    // ---- Auto-uncall: release a claimed target 1 minute after it goes/stays Okay ----

    const callOkaySince = {};

    async function autoUncallMember(call) {
        try {
            await serverFetch(`/api/call/${call.id}/cancel`, {
                method: 'POST',
                body: JSON.stringify({ factionId: state.userFactionId }),
            });
            await fetchCalls();
            render();
        } catch (e) {
            console.log('[InQuest Target Caller] auto-uncall failed', e);
        }
    }

    function checkAutoUncall() {
        const now = Date.now();
        state.calls.forEach((call) => {
            const member = state.members.find((m) => m.id === call.memberId);
            const isOkay = member && member.status.toLowerCase().includes('okay');
            if (isOkay) {
                if (!callOkaySince[call.id]) {
                    callOkaySince[call.id] = now;
                } else if (now - callOkaySince[call.id] >= 60000) {
                    delete callOkaySince[call.id];
                    autoUncallMember(call);
                }
            } else {
                delete callOkaySince[call.id];
            }
        });
        Object.keys(callOkaySince).forEach((id) => {
            if (!state.calls.some((c) => c.id === id)) delete callOkaySince[id];
        });
    }

    // ---- Badges anchored inside Torn's native war page ----
    //
    // Every attackable enemy member on the war page renders a real Torn link
    // like `page.php?sid=attack&user2ID=12345`. We anchor off that link (a
    // stable, functional URL — not a hashed CSS-module class name Torn could
    // rename on any deploy).
    //
    // Two earlier approaches both fought coordinate math: inserting the
    // button in-flow made it count toward the row's flex width (pushing the
    // other faction's column below once the row overflowed), and a
    // getBoundingClientRect-based floating overlay broke the moment
    // something in Torn's page changed the containing block for
    // position:fixed elements. This version sidesteps both: the badge is a
    // real child of the Attack column, but `position: absolute` pulls it out
    // of flex flow (zero footprint on layout, can't push anything), and it's
    // placed with pure CSS (`right: 100%` of its own column) instead of any
    // JS-computed pixel coordinates — nothing to get wrong.

    const ATTACK_HREF_RE = /(?:user2ID|XID)=(\d+)/;
    const callSeenAt = {}; // callId -> first time we observed it (for the "called Xs ago" fallback)

    function findAttackLinks() {
        return Array.from(document.querySelectorAll('a[href*="sid=attack"]'));
    }

    // Walk up from the Attack link to whichever ancestor is a direct child of
    // the row — i.e. the Attack column itself — so the badge can anchor to
    // that column instead of squeezing inside it.
    function findAttackColumn(link) {
        const row = link.closest('li') || link.parentElement;
        if (!row) return link;
        let col = link;
        while (col.parentElement && col.parentElement !== row) col = col.parentElement;
        return col.parentElement === row ? col : link;
    }

    function createBadge(memberId) {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'iq-call-btn';
        badge.dataset.id = memberId;
        badge.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleCallClick(badge.dataset.id);
        });

        const label = document.createElement('span');
        label.className = 'iq-label';
        badge.appendChild(label);

        const tip = document.createElement('span');
        tip.className = 'iq-tooltip';
        badge.appendChild(tip);
        badge.addEventListener('mouseenter', () => startTooltipTicker(badge, tip));
        badge.addEventListener('mouseleave', stopTooltipTicker);

        return badge;
    }

    function scanAndInject() {
        if (!state.enemyFactionId) return;

        findAttackLinks().forEach((link) => {
            const href = link.getAttribute('href') || '';
            const match = href.match(ATTACK_HREF_RE);
            if (!match) return;
            const memberId = match[1];

            const column = findAttackColumn(link);
            if (getComputedStyle(column).position === 'static') {
                column.style.position = 'relative';
            }

            let badge = column.querySelector(':scope > .iq-call-btn');
            if (!badge) {
                badge = createBadge(memberId);
                column.appendChild(badge);
            }
            badge.dataset.id = memberId;
        });

        refreshButtonStates();
    }

    function refreshButtonStates() {
        const callsByMember = new Map(state.calls.map((c) => [String(c.memberId), c]));
        callsByMember.forEach((c) => {
            if (!callSeenAt[c.id]) callSeenAt[c.id] = Date.now();
        });
        Object.keys(callSeenAt).forEach((id) => {
            if (!state.calls.some((c) => String(c.id) === id)) delete callSeenAt[id];
        });

        document.querySelectorAll('.iq-call-btn').forEach((btn) => {
            const id = btn.dataset.id;
            const call = callsByMember.get(id);
            const label = btn.querySelector('.iq-label');
            btn.classList.remove('iq-mine', 'iq-other');
            if (call) {
                const isMine = String(call.callerId) === String(state.playerId);
                btn.classList.add(isMine ? 'iq-mine' : 'iq-other');
                label.textContent = 'X';
                btn.disabled = !isMine;
            } else {
                label.textContent = 'O';
                btn.disabled = false;
            }
        });
    }

    // ---- Tooltip with a live countdown ----
    //
    // Shown/hidden with pure CSS (:hover), nested inside the badge so it
    // inherits the same anchoring — no coordinates computed in JS at all.
    // JS only handles ticking the text once a second while it's visible,
    // since a live countdown needs updates a static `title` can't give.

    let tooltipTimer = null;

    function tooltipTextFor(badge) {
        const id = badge.dataset.id;
        const call = state.calls.find((c) => String(c.memberId) === String(id));
        if (!call) {
            const member = state.members.find((m) => m.id === id);
            return member ? `Available — click to call ${member.name}` : 'Available — click to call';
        }
        const isMine = String(call.callerId) === String(state.playerId);
        const base = isMine ? 'You called this target — click to release' : `Claimed by ${call.callerName}`;

        const okaySince = callOkaySince[call.id];
        if (okaySince) {
            const remaining = Math.max(0, 60 - Math.floor((Date.now() - okaySince) / 1000));
            return `${base} · auto-release in ${remaining}s`;
        }
        const seenAt = callSeenAt[call.id];
        if (seenAt) {
            const elapsed = Math.floor((Date.now() - seenAt) / 1000);
            return `${base} · called ${elapsed}s ago`;
        }
        return base;
    }

    function startTooltipTicker(badge, tip) {
        tip.textContent = tooltipTextFor(badge);
        if (tooltipTimer) clearInterval(tooltipTimer);
        tooltipTimer = setInterval(() => {
            if (!document.body.contains(badge)) {
                clearInterval(tooltipTimer);
                return;
            }
            tip.textContent = tooltipTextFor(badge);
        }, 1000);
    }

    function stopTooltipTicker() {
        if (tooltipTimer) clearInterval(tooltipTimer);
        tooltipTimer = null;
    }

    // ---- Launcher + status widget ----

    function ensureLauncher() {
        let launcher = document.getElementById('iq-launcher');
        if (launcher) return launcher;
        launcher = document.createElement('div');
        launcher.id = 'iq-launcher';
        launcher.innerHTML = `IQ<span class="iq-dot"></span>`;
        launcher.title = 'InQuest Target Caller';
        launcher.onclick = () => {
            state.widgetOpen = !state.widgetOpen;
            GM_setValue('twh_widget_open', state.widgetOpen);
            renderWidget();
        };
        document.body.appendChild(launcher);
        return launcher;
    }

    function renderWidget() {
        const launcher = ensureLauncher();
        const dot = launcher.querySelector('.iq-dot');
        dot.classList.remove('ok', 'err');
        if (isConfigured()) dot.classList.add(state.serverError ? 'err' : 'ok');

        let widget = document.getElementById('iq-widget');
        if (!state.widgetOpen) {
            if (widget) widget.remove();
            return;
        }
        if (!widget) {
            widget = document.createElement('div');
            widget.id = 'iq-widget';
            document.body.appendChild(widget);
        }

        if (!isConfigured()) {
            widget.innerHTML = `
                <div id="iq-widget-header"><strong>InQuest Target Caller</strong></div>
                <div id="iq-widget-body">
                    <p>Set your Torn public API key to get started.</p>
                    <button id="iq-open-settings" class="iq-btn iq-btn-primary">Open Settings</button>
                </div>
            `;
            widget.querySelector('#iq-open-settings').onclick = openSettings;
            return;
        }

        const warLine = state.enemyFactionId
            ? `vs <strong style="color:#e88;">${escapeAttr(state.enemyFactionName || state.enemyFactionId)}</strong>`
            : 'No active ranked war detected.';
        const syncLine = state.serverError
            ? `<span style="color:#f77;">Sync error: ${escapeAttr(state.serverError)}</span>`
            : '<span style="color:#5adf6b;">Synced</span>';

        widget.innerHTML = `
            <div id="iq-widget-header">
                <strong>InQuest Target Caller</strong>
                <button class="iq-icon-btn" id="iq-widget-close" title="Close">&times;</button>
            </div>
            <div id="iq-widget-body">
                <p>${warLine}</p>
                <div class="iq-row"><span>${syncLine}</span></div>
                <div class="iq-row" style="gap:8px;">
                    <button id="iq-widget-refresh" class="iq-btn">Refresh</button>
                    <button id="iq-widget-settings" class="iq-btn">Settings</button>
                </div>
            </div>
        `;
        widget.querySelector('#iq-widget-close').onclick = () => {
            state.widgetOpen = false;
            GM_setValue('twh_widget_open', false);
            renderWidget();
        };
        widget.querySelector('#iq-widget-refresh').onclick = () => refreshAll();
        widget.querySelector('#iq-widget-settings').onclick = openSettings;
    }

    function render() {
        refreshButtonStates();
        renderWidget();
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
        scanAndInject();
        render();
    }

    function startPolling() {
        if (warPollTimer) clearInterval(warPollTimer);
        if (callPollTimer) clearInterval(callPollTimer);
        warPollTimer = setInterval(async () => {
            try {
                await fetchWarInfo();
                await fetchEnemyMembers();
            } catch (e) { /* keep last known data */ }
            scanAndInject();
            render();
        }, 20000);
        callPollTimer = setInterval(async () => {
            await fetchCalls();
            render();
        }, 3000);

        // fast local tick: re-scan for newly rendered rows (Torn's SPA reflows
        // the list on tab switches/pagination) + auto-uncall check, no network
        setInterval(() => {
            scanAndInject();
            checkAutoUncall();
        }, 1500);
    }

    async function init() {
        injectStyles();
        if (isPDA) document.body.classList.add('iq-pda');
        ensureLauncher();
        renderWidget();
        if (!isConfigured()) return;
        await refreshAll();
        startPolling();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
