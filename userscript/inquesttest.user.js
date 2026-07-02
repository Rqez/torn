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
// @grant        unsafeWindow
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
            #iq-overlay-layer {
                position: fixed;
                top: 0;
                left: 0;
                width: 0;
                height: 0;
                z-index: 99998;
            }
            .iq-call-btn {
                all: unset !important;
                box-sizing: border-box !important;
                position: fixed !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                z-index: 99998 !important;
                padding: 2px 7px !important;
                min-width: 40px !important;
                width: auto !important;
                max-width: none !important;
                height: 18px !important;
                font-family: Arial, sans-serif !important;
                font-size: 9px !important;
                font-weight: 700 !important;
                line-height: 1 !important;
                text-transform: uppercase !important;
                letter-spacing: 0.3px !important;
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
                transition: background 0.15s ease, opacity 0.15s ease, transform 0.1s ease !important;
                vertical-align: middle !important;
                white-space: nowrap !important;
            }
            .iq-call-btn.iq-hidden {
                visibility: hidden !important;
                pointer-events: none !important;
            }
            .iq-call-btn:hover:not(:disabled) {
                background: linear-gradient(180deg, #6fdf6f 0%, #4aaa4a 60%, #358a35 100%) !important;
            }
            .iq-call-btn:active:not(:disabled) {
                transform: translateY(1px) !important;
            }
            .iq-call-btn.iq-mine {
                background: linear-gradient(180deg, #ffcf5f 0%, #d99a2a 60%, #a8710f 100%) !important;
                border-color: #6b4308 !important;
                color: #fff !important;
            }
            .iq-call-btn.iq-mine:hover {
                background: linear-gradient(180deg, #ffdf7f 0%, #e9aa3a 60%, #b8811f 100%) !important;
            }
            .iq-call-btn.iq-other {
                background: linear-gradient(180deg, #e06a6a 0%, #b53a3a 60%, #7a1f1f 100%) !important;
                border-color: #4a1010 !important;
                color: #fff !important;
                cursor: not-allowed !important;
                opacity: 0.9 !important;
            }
            body.iq-pda .iq-call-btn {
                min-width: 50px !important;
                height: 24px !important;
                font-size: 11px !important;
                padding: 3px 9px !important;
            }

            #iq-tooltip {
                position: fixed;
                transform: translate(-50%, -100%);
                background: #16171b;
                color: #eee;
                padding: 4px 9px;
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 4px;
                font-family: Arial, sans-serif;
                font-size: 11px;
                white-space: nowrap;
                pointer-events: none;
                z-index: 100001;
                opacity: 0;
                transition: opacity 0.1s ease;
                box-shadow: 0 4px 14px rgba(0,0,0,0.5);
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

    // ---- Overlay badges over Torn's native war page ----
    //
    // Every attackable enemy member on the war page renders a real Torn link
    // like `page.php?sid=attack&user2ID=12345`. We anchor off that link (a
    // stable, functional URL — not a hashed CSS-module class name Torn could
    // rename on any deploy).
    //
    // Earlier this inserted the O/X badge as a new DOM child next to that
    // link. Torn's war list is a React component that re-renders itself on
    // its own polling cycle; a foreign node left inside a subtree React
    // thinks it fully owns makes its next reconciliation pass throw, which
    // is what was silently wiping out the other faction's list. To avoid
    // touching Torn's DOM structurally at all, badges live in a layer we own
    // completely (appended straight to <body>) and are just visually
    // positioned on top of each Attack link via getBoundingClientRect — we
    // only ever *read* Torn's DOM, never mutate it.

    const ATTACK_HREF_RE = /(?:user2ID|XID)=(\d+)/;
    const badgesByLink = new Map(); // <a> element -> its overlay badge
    const callSeenAt = {}; // callId -> first time we observed it (for the "called Xs ago" fallback)
    let overlayLayer = null;
    let repositionQueued = false;

    function findAttackLinks() {
        return Array.from(document.querySelectorAll('a[href*="sid=attack"]'));
    }

    function ensureOverlayLayer() {
        if (overlayLayer && document.body.contains(overlayLayer)) return overlayLayer;
        overlayLayer = document.createElement('div');
        overlayLayer.id = 'iq-overlay-layer';
        document.body.appendChild(overlayLayer);
        return overlayLayer;
    }

    // Some Attack "links" are just a hit-target wrapping an icon/child element
    // (e.g. styled with display:contents), so the <a> itself reports a 0x0
    // box — fall back to a child's box in that case instead of hiding the
    // badge at (0,0), which is what was making it vanish.
    function measureRect(el) {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width || rect.height) return rect;
        const child = el.querySelector('*');
        return child ? child.getBoundingClientRect() : rect;
    }

    // Walk up from the Attack link to whichever ancestor is a direct child of
    // the row (i.e. the Attack column itself), purely to *read* its position
    // and its previous sibling's (the Status column) — no DOM writes here.
    function locateColumns(link) {
        const row = link.closest('li') || link.parentElement;
        if (!row) return { attackRect: measureRect(link), statusRect: null };
        let col = link;
        while (col.parentElement && col.parentElement !== row) col = col.parentElement;
        const attackCol = col.parentElement === row ? col : link;
        const statusCol = attackCol.previousElementSibling;
        return {
            attackRect: measureRect(attackCol),
            statusRect: statusCol ? measureRect(statusCol) : null,
        };
    }

    function positionBadge(link, badge) {
        const { attackRect, statusRect } = locateColumns(link);
        if (!attackRect || (attackRect.width === 0 && attackRect.height === 0)) {
            badge.classList.add('iq-hidden');
            return;
        }
        badge.classList.remove('iq-hidden');
        const bw = badge.offsetWidth || 46;
        const bh = badge.offsetHeight || 18;
        const centerX = (statusRect && statusRect.width)
            ? (statusRect.right + attackRect.left) / 2
            : attackRect.left - bw / 2 - 6;
        badge.style.left = `${Math.round(centerX - bw / 2)}px`;
        badge.style.top = `${Math.round(attackRect.top + attackRect.height / 2 - bh / 2)}px`;
    }

    function scheduleReposition() {
        if (repositionQueued) return;
        repositionQueued = true;
        requestAnimationFrame(() => {
            repositionQueued = false;
            badgesByLink.forEach((badge, link) => positionBadge(link, badge));
            if (tooltipTarget) positionTooltip(tooltipTarget);
        });
    }

    function scanAndInject() {
        if (!state.enemyFactionId) return;
        const layer = ensureOverlayLayer();

        findAttackLinks().forEach((link) => {
            const href = link.getAttribute('href') || '';
            const match = href.match(ATTACK_HREF_RE);
            if (!match) return;
            const memberId = match[1];

            let badge = badgesByLink.get(link);
            if (!badge) {
                badge = document.createElement('button');
                badge.type = 'button';
                badge.className = 'iq-call-btn';
                badge.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleCallClick(badge.dataset.id);
                });
                attachTooltip(badge);
                layer.appendChild(badge);
                badgesByLink.set(link, badge);
            }
            badge.dataset.id = memberId;
            positionBadge(link, badge);
        });

        // Torn re-renders rows (new tab, pagination, live status updates) which
        // replaces the underlying <a> nodes — drop badges whose link is gone.
        badgesByLink.forEach((badge, link) => {
            if (!document.body.contains(link)) {
                badge.remove();
                badgesByLink.delete(link);
            }
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

        badgesByLink.forEach((btn) => {
            const id = btn.dataset.id;
            const call = callsByMember.get(id);
            btn.classList.remove('iq-mine', 'iq-other');
            if (call) {
                const isMine = String(call.callerId) === String(state.playerId);
                btn.classList.add(isMine ? 'iq-mine' : 'iq-other');
                btn.textContent = isMine ? 'Uncall' : 'Called';
                btn.disabled = !isMine;
            } else {
                btn.textContent = 'Call';
                btn.disabled = false;
            }
        });
    }

    // ---- Custom tooltip with a live countdown ----
    //
    // Native `title` tooltips are static text — they can't tick down while
    // held open. This is a small floating element we update on an interval
    // for as long as the mouse stays over a badge.

    let tooltipEl = null;
    let tooltipTimer = null;
    let tooltipTarget = null;

    function ensureTooltipEl() {
        if (tooltipEl && document.body.contains(tooltipEl)) return tooltipEl;
        tooltipEl = document.createElement('div');
        tooltipEl.id = 'iq-tooltip';
        document.body.appendChild(tooltipEl);
        return tooltipEl;
    }

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

    function positionTooltip(badge) {
        const tip = ensureTooltipEl();
        const rect = badge.getBoundingClientRect();
        tip.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
        tip.style.top = `${Math.round(rect.top - 6)}px`;
    }

    function attachTooltip(badge) {
        badge.addEventListener('mouseenter', () => {
            tooltipTarget = badge;
            const tip = ensureTooltipEl();
            tip.textContent = tooltipTextFor(badge);
            positionTooltip(badge);
            tip.style.opacity = '1';
            if (tooltipTimer) clearInterval(tooltipTimer);
            tooltipTimer = setInterval(() => {
                if (tooltipTarget !== badge || !document.body.contains(badge)) {
                    clearInterval(tooltipTimer);
                    return;
                }
                tip.textContent = tooltipTextFor(badge);
                positionTooltip(badge);
            }, 1000);
        });
        badge.addEventListener('mouseleave', () => {
            if (tooltipTimer) clearInterval(tooltipTimer);
            tooltipTarget = null;
            if (tooltipEl) tooltipEl.style.opacity = '0';
        });
    }

    document.addEventListener('scroll', scheduleReposition, true);
    window.addEventListener('resize', scheduleReposition);

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

    // Run __iqDebug() in the browser console on the war page to dump the
    // real measurements for every badge — paste the output back so the
    // positioning logic can be fixed against actual numbers instead of
    // another guess at Torn's markup.
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    pageWindow.__iqDebug = window.__iqDebug = function () {
        const rows = findAttackLinks().map((link) => {
            const row = link.closest('li') || link.parentElement;
            const { attackRect, statusRect } = locateColumns(link);
            return {
                href: link.getAttribute('href'),
                linkRect: link.getBoundingClientRect(),
                attackRect,
                statusRect,
                rowTag: row && row.tagName,
                rowClass: row && row.className,
                rowOuterHTML: row ? row.outerHTML.slice(0, 400) : null,
            };
        });
        console.log('[InQuest debug] bodyTransform:', getComputedStyle(document.body).transform);
        console.log('[InQuest debug] htmlTransform:', getComputedStyle(document.documentElement).transform);
        console.log('[InQuest debug] rows:', rows);
        return rows;
    };

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
