// ==UserScript==
// @name         Universal Button Auto Clicker Party
// @namespace    https://tampermonkey.net/
// @version      3.6.2
// @description  Local auto-clicking or host-controlled synchronized click parties.
// @author       Theis
// @homepageURL   https://github.com/thei1575/auto-clicker-party
// @supportURL    https://github.com/thei1575/auto-clicker-party/issues
// @updateURL     https://raw.githubusercontent.com/thei1575/auto-clicker-party/main/Universal%20Button%20Auto%20Clicker%20Party.user.js
// @downloadURL   https://raw.githubusercontent.com/thei1575/auto-clicker-party/main/Universal%20Button%20Auto%20Clicker%20Party.user.js
// @match        http://*/*
// @match        https://*/*
// @noframes
// @run-at       document-idle
// @sandbox       DOM
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      clicker.oz1tnj.dk
// ==/UserScript==

(function () {
    'use strict';

    const MIN_DELAY = 20;
    const SETTINGS_KEY = 'universalAutoClickerPartySettings';
    const PANEL_POSITION_KEY = 'universalAutoClickerPartyPanelPosition';
    const BROWSER_ID_KEY = 'universalAutoClickerPartyBrowserId';
    const PARTY_SESSION_KEY = 'universalAutoClickerPartySession';
    const PARTY_HTTP_URL = 'https://clicker.oz1tnj.dk';
    const SYNC_COUNTDOWN_MS = 5_000;
    const INITIAL_CLOCK_SYNC_SAMPLES = 7;
    const RESYNC_CLOCK_SYNC_SAMPLES = 5;
    const PARTY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const TARGET_ATTRIBUTE = 'data-auto-clicker-target';
    const HOVER_ATTRIBUTE = 'data-auto-clicker-hover';

    let mode = null;
    let target = null;
    let targetSelector = '';
    let hoveredElement = null;
    let selecting = false;
    let timer = null;
    let countdownTimer = null;
    let countdownDisplayTimer = null;
    let countdownStartAt = null;
    let runPlan = null;
    let syncedRandomState = 0;
    let nextClickAt = null;
    let clicksCompleted = 0;
    let clicksPlanned = 0;
    let httpParty = null;
    let partyRole = null;
    let partyCode = '';
    let partySessionRunning = false;
    let connectionTimer = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let serverClockOffsetMs = 0;
    let clockSynced = false;
    let clockSyncRttMs = Infinity;
    let clockSyncTimer = null;
    let partySendChain = Promise.resolve();
    let lastGuestReport = { state: '', time: 0 };
    let lastPartyRevision = 0;
    let hostRateSample = { clicks: 0, time: Date.now(), rate: 0 };
    let dragOffset = null;
    const memberStats = new Map();

    const pageStyle = document.createElement('style');
    pageStyle.textContent = `
        [${TARGET_ATTRIBUTE}] { outline: 3px solid #22c55e !important; outline-offset: 2px !important; }
        [${HOVER_ATTRIBUTE}] { outline: 3px solid #f59e0b !important; outline-offset: 2px !important; }
    `;
    (document.head || document.documentElement).appendChild(pageStyle);

    const host = document.createElement('div');
    host.id = 'universal-auto-clicker-party-panel';
    host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const joinedTargetMarker = document.createElement('div');
    joinedTargetMarker.setAttribute('aria-hidden', 'true');
    joinedTargetMarker.style.cssText = 'all:initial;display:none;position:fixed;z-index:2147483646;box-sizing:border-box;border:3px solid #22c55e;border-radius:999px;box-shadow:0 0 0 3px rgba(34,197,94,.24),0 0 18px rgba(34,197,94,.8);pointer-events:none;';
    document.documentElement.appendChild(joinedTargetMarker);

    shadow.innerHTML = `
        <style>
            :host { all:initial; }
            * { box-sizing:border-box; }
            .panel { width:330px; padding:14px; color:#f8fafc; background:rgba(15,23,42,.98); border:1px solid #334155; border-radius:12px; box-shadow:0 14px 35px rgba(0,0,0,.38); font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; user-select:none; }
            .panel.minimized { width:190px; padding:9px 10px; }
            .panel.minimized .screen,.panel.minimized .footer { display:none; }
            .header { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
            #drag-handle { cursor:move; touch-action:none; }
            .panel.minimized #drag-handle { margin:0; }
            .title { font-size:15px; font-weight:700; }
            button { font:inherit; }
            .window-controls { display:flex; gap:2px; }
            .close,.minimize,.back { padding:5px 7px; color:#cbd5e1; background:transparent; border:0; border-radius:7px; cursor:pointer; }
            .close { font-size:18px; }
            .minimize { font-size:18px; line-height:1; }
            .close:hover,.minimize:hover,.back:hover { background:#334155; }
            .screen[hidden],.host-only[hidden],.join-only[hidden] { display:none; }
            .panel.joined-mode #selection-controls,.panel.joined-mode #control-settings { display:none !important; }
            .intro { margin:2px 0 12px; color:#94a3b8; }
            .mode-buttons { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
            .action { padding:10px; color:#fff; background:#2563eb; border:0; border-radius:8px; cursor:pointer; font-weight:700; }
            .action:hover { filter:brightness(1.12); }
            .action:disabled { opacity:.48; cursor:not-allowed; filter:none; }
            #choose-host { background:#7c3aed; }
            #stop { background:#dc2626; }
            .card { margin-bottom:10px; padding:10px; background:#111c31; border:1px solid #334155; border-radius:9px; }
            #join-form { margin-top:12px; margin-bottom:0; }
            #join-form .action { width:100%; margin-top:12px; }
            .card-title { display:flex; justify-content:space-between; align-items:center; margin-bottom:7px; color:#bfdbfe; font-weight:700; }
            .party-code-wrap { display:flex; align-items:center; gap:7px; }
            .copy-code { padding:3px 6px; color:#bfdbfe; background:#1e3a5f; border:1px solid #3b82f6; border-radius:5px; cursor:pointer; font-size:10px; }
            .copy-code:hover { background:#254b78; }
            .end-room { padding:3px 6px; color:#fecaca; background:#7f1d1d; border:1px solid #ef4444; border-radius:5px; cursor:pointer; font-size:10px; }
            .end-room:hover { background:#991b1b; }
            .target { min-height:34px; margin-bottom:9px; padding:8px 9px; overflow:hidden; color:#94a3b8; background:#0f172a; border:1px solid #334155; border-radius:8px; text-overflow:ellipsis; white-space:nowrap; }
            .target.selected { color:#a7f3d0; border-color:#059669; }
            .grid { display:grid; grid-template-columns:1fr 1fr; gap:9px; margin:10px 0; }
            .full { grid-column:1/-1; }
            label { display:block; color:#cbd5e1; font-size:12px; }
            input { width:100%; margin-top:4px; padding:8px; color:#f8fafc; background:#020617; border:1px solid #475569; border-radius:7px; outline:none; font:inherit; }
            input:focus { border-color:#60a5fa; }
            .hint { margin-top:3px; color:#64748b; font-size:10px; }
            .buttons { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
            #select { grid-column:1/-1; background:#475569; }
            #select.selecting { background:#d97706; }
            .status { min-height:19px; margin-top:10px; color:#94a3b8; }
            .status.running { color:#86efac; }
            .status.error { color:#fca5a5; }
            .party-status { color:#94a3b8; font-size:11px; }
            .member-list { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:6px; max-height:224px; margin-top:7px; padding-right:2px; overflow-y:auto; overscroll-behavior:contain; }
            .member { display:grid; gap:5px; padding:7px; color:#cbd5e1; background:#0f172a; border:1px solid #243247; border-radius:7px; font-size:11px; }
            .member-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
            .member-name { color:#e2e8f0; font-weight:700; }
            .member-state { max-width:145px; overflow:hidden; color:#a7f3d0; font-size:10px; text-align:right; text-overflow:ellipsis; white-space:nowrap; }
            .member-metrics { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:5px; }
            .member-metric { min-width:0; padding:5px 6px; background:#111c31; border-radius:5px; }
            .member-metric-label { display:block; color:#64748b; font-size:9px; letter-spacing:.04em; text-transform:uppercase; }
            .member-metric-value { display:block; margin-top:1px; overflow:hidden; color:#bfdbfe; font-size:10px; font-variant-numeric:tabular-nums; text-overflow:ellipsis; white-space:nowrap; }
            .client-id { padding:3px 6px; color:#bbf7d0; background:#14532d; border:1px solid #22c55e; border-radius:999px; font-size:10px; font-variant-numeric:tabular-nums; }
            .party-progress { color:#86efac; font-size:10px; font-weight:500; }
            .readonly { color:#94a3b8; }
            .footer { margin-top:11px; padding-top:9px; color:#64748b; border-top:1px solid #243247; font-size:10px; text-align:center; }
            .footer a { color:#93c5fd; text-decoration:none; }
            .footer a:hover { text-decoration:underline; }
        </style>
        <section class="panel" id="panel">
            <div class="header" id="drag-handle" title="Drag to move this window"><div class="title">Auto Clicker</div><div class="window-controls"><button class="minimize" id="minimize" title="Minimize" aria-label="Minimize">−</button><button class="close" id="hide" title="Hide panel" aria-label="Hide panel">×</button></div></div>

            <section class="screen" id="mode-screen">
                <p class="intro">Choose how this browser should participate.</p>
                <div class="mode-buttons">
                    <button class="action" id="choose-local">Local</button>
                    <button class="action" id="choose-host">Host</button>
                    <button class="action" id="choose-join">Join</button>
                </div>
                <div class="card" id="join-form" hidden>
                    <label>Party code<input id="join-code" maxlength="16" placeholder="Enter host code"></label>
                    <button class="action" id="connect-join">Join party</button>
                </div>
                <div class="status" id="mode-status">Local controls stay in this browser. Host controls sync to joined browsers.</div>
            </section>

            <section class="screen" id="control-screen" hidden>
                <div class="header"><button class="back" id="back">← Change mode</button><span id="mode-label"></span></div>
                <section class="card host-only" id="host-card" hidden>
                    <div class="card-title"><span>Party code</span><span class="party-code-wrap"><span id="party-code"></span><button class="copy-code" id="copy-code" title="Copy party code">Copy</button><button class="end-room" id="end-room" title="End this room for everyone">End room</button></span></div>
                    <div class="party-status" id="party-status">Connecting…</div>
                </section>
                <section class="card host-only" id="member-card" hidden>
                    <div class="card-title"><span>Party progress</span><span class="party-progress" id="party-progress">0 clicks · 0.0/s</span></div>
                    <div class="party-status">Joined browsers: <span id="member-count">0</span></div>
                    <div class="member-list" id="member-list"><div class="readonly">No browsers joined yet.</div></div>
                </section>
                <section class="card join-only" id="join-card" hidden>
                    <div class="card-title"><span>Joined party</span><span class="client-id" id="client-id">Connecting…</span></div>
                    <div class="readonly">The host selects the target and controls all settings. This browser will follow automatically.</div>
                </section>
                <div class="target" id="target">No button selected</div>
                <div class="buttons host-only" id="selection-controls"><button class="action" id="select">Select button</button></div>
                <div id="control-settings">
                    <div class="grid">
                        <label>Base delay (ms)<input id="delay" type="number" min="${MIN_DELAY}" step="10" value="1000"></label>
                        <label>Randomize ± (ms)<input id="randomization" type="number" min="0" step="10" value="0"></label>
                        <label class="full">Number of clicks<input id="count" type="number" min="0" step="1" value="10"><div class="hint">0 = unlimited clicks</div></label>
                    </div>
                    <div class="buttons"><button class="action" id="start">Start</button><button class="action" id="stop" disabled>Stop</button></div>
                </div>
                <div class="status" id="status">Ready</div>
            </section>
            <footer class="footer">© 2026 Theis N. Jensen · <a href="https://github.com/thei1575/auto-clicker-party" target="_blank" rel="noopener noreferrer">GitHub</a></footer>
        </section>`;

    const ui = Object.fromEntries([
        'panel', 'hide', 'minimize', 'drag-handle', 'mode-screen', 'control-screen', 'choose-local', 'choose-host', 'choose-join',
        'join-form', 'join-code', 'connect-join', 'mode-status', 'back', 'mode-label',
        'host-card', 'party-code', 'copy-code', 'end-room', 'party-status', 'member-card', 'member-count', 'party-progress', 'member-list',
        'join-card', 'client-id', 'target', 'selection-controls', 'select', 'control-settings', 'delay',
        'randomization', 'count', 'start', 'stop', 'status'
    ].map(id => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), shadow.getElementById(id)]));

    function setStatus(message, type = '') {
        ui.status.textContent = message;
        ui.status.className = `status ${type}`.trim();
    }

    function setModeStatus(message, type = '') {
        ui.modeStatus.textContent = message;
        ui.modeStatus.className = `status ${type}`.trim();
    }

    function startDragging(event) {
        if (event.button !== 0 || event.target.closest('button')) return;
        const rect = host.getBoundingClientRect();
        dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        host.style.left = `${rect.left}px`;
        host.style.top = `${rect.top}px`;
        host.style.right = 'auto';
        event.preventDefault();
        window.addEventListener('pointermove', dragWindow, true);
        window.addEventListener('pointerup', stopDragging, true);
        window.addEventListener('pointercancel', stopDragging, true);
    }

    function dragWindow(event) {
        if (!dragOffset) return;
        const width = host.offsetWidth;
        const height = host.offsetHeight;
        const left = Math.min(Math.max(0, event.clientX - dragOffset.x), Math.max(0, window.innerWidth - width));
        const top = Math.min(Math.max(0, event.clientY - dragOffset.y), Math.max(0, window.innerHeight - height));
        host.style.left = `${left}px`;
        host.style.top = `${top}px`;
    }

    function stopDragging() {
        if (dragOffset) savePanelPosition();
        dragOffset = null;
        window.removeEventListener('pointermove', dragWindow, true);
        window.removeEventListener('pointerup', stopDragging, true);
        window.removeEventListener('pointercancel', stopDragging, true);
    }

    function toggleMinimized() {
        const minimized = ui.panel.classList.toggle('minimized');
        ui.minimize.textContent = minimized ? '+' : '−';
        ui.minimize.title = minimized ? 'Restore' : 'Minimize';
        ui.minimize.setAttribute('aria-label', minimized ? 'Restore' : 'Minimize');
    }

    function getSettings() {
        return { delay: Number(ui.delay.value), randomization: Number(ui.randomization.value), count: Number(ui.count.value) };
    }

    function saveSettings() {
        GM_setValue(SETTINGS_KEY, getSettings());
    }

    function loadSettings() {
        const settings = GM_getValue(SETTINGS_KEY, {});
        ui.delay.value = Number.isFinite(settings.delay) ? settings.delay : 1000;
        ui.randomization.value = Number.isFinite(settings.randomization) ? settings.randomization : 0;
        ui.count.value = Number.isFinite(settings.count) ? settings.count : 10;
    }

    function savePanelPosition() {
        const rect = host.getBoundingClientRect();
        GM_setValue(PANEL_POSITION_KEY, { left: Math.round(rect.left), top: Math.round(rect.top) });
    }

    function loadPanelPosition() {
        const position = GM_getValue(PANEL_POSITION_KEY, null);
        if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return;
        host.style.left = `${Math.max(0, Math.min(position.left, window.innerWidth - 80))}px`;
        host.style.top = `${Math.max(0, Math.min(position.top, window.innerHeight - 40))}px`;
        host.style.right = 'auto';
    }

    function showModeScreen() {
        ui.panel.classList.remove('joined-mode');
        ui.modeScreen.hidden = false;
        ui.controlScreen.hidden = true;
        ui.joinForm.hidden = true;
        setModeStatus('Local controls stay in this browser. Host controls sync to joined browsers.');
    }

    function showControlScreen() {
        const isHost = mode === 'host';
        const isJoin = mode === 'join';
        ui.panel.classList.toggle('joined-mode', isJoin);
        ui.modeScreen.hidden = true;
        ui.controlScreen.hidden = false;
        ui.modeLabel.textContent = mode ? mode[0].toUpperCase() + mode.slice(1) : '';
        ui.hostCard.hidden = !isHost;
        ui.memberCard.hidden = !isHost;
        ui.joinCard.hidden = !isJoin;
        ui.selectionControls.hidden = isJoin;
        ui.controlSettings.hidden = isJoin;
        updateControls();
    }

    function updateControls() {
        const joined = mode === 'join';
        const running = timer !== null || countdownTimer !== null;
        const hostSessionRunning = mode === 'host' && partySessionRunning;
        const hostConnecting = mode === 'host' && (!partyConnected() || !clockSynced);
        ui.select.disabled = running || joined;
        ui.delay.disabled = running || joined;
        ui.randomization.disabled = running || joined;
        ui.count.disabled = running || joined;
        ui.start.disabled = running || joined || hostConnecting || hostSessionRunning;
        ui.stop.disabled = (!running && !hostSessionRunning) || joined;
    }

    function generatePartyCode() {
        const values = new Uint32Array(8);
        crypto.getRandomValues(values);
        return Array.from(values, value => PARTY_CODE_ALPHABET[value % PARTY_CODE_ALPHABET.length]).join('');
    }

    function getBrowserId() {
        const savedId = GM_getValue(BROWSER_ID_KEY, '');
        if (/^B-[A-Z2-9]{6}$/.test(savedId)) return savedId;
        const values = new Uint32Array(6);
        crypto.getRandomValues(values);
        const browserId = `B-${Array.from(values, value => PARTY_CODE_ALPHABET[value % PARTY_CODE_ALPHABET.length]).join('')}`;
        GM_setValue(BROWSER_ID_KEY, browserId);
        return browserId;
    }

    function getSavedPartySession() {
        const session = GM_getValue(PARTY_SESSION_KEY, null);
        if (!session || (session.role !== 'host' && session.role !== 'join') || !/^[A-Z2-9]{6,16}$/.test(session.roomCode || '')) return null;
        return session.origin === location.origin ? session : null;
    }

    function savePartySession(role, roomCode) {
        GM_setValue(PARTY_SESSION_KEY, { role, roomCode, origin: location.origin });
    }

    function clearSavedPartySession() {
        GM_setValue(PARTY_SESSION_KEY, null);
    }

    function copyPartyCode() {
        if (!partyCode) return;
        try {
            GM_setClipboard(partyCode, 'text');
            ui.copyCode.textContent = 'Copied';
        } catch (_) {
            ui.copyCode.textContent = 'Copy failed';
        }
        setTimeout(() => { ui.copyCode.textContent = 'Copy'; }, 1_500);
    }

    function partyConnected() {
        return Boolean(httpParty && partyRole);
    }

    function clearConnectionTimer() {
        if (connectionTimer !== null) {
            clearTimeout(connectionTimer);
            connectionTimer = null;
        }
    }

    function disconnectParty(clearSavedSession = true) {
        clearConnectionTimer();
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        reconnectAttempt = 0;
        cancelCountdown();
        const currentHttpParty = httpParty;
        httpParty = null;
        if (currentHttpParty) {
            currentHttpParty.closed = true;
            partyRequest('POST', `/api/party/disconnect?token=${encodeURIComponent(currentHttpParty.token)}`).catch(() => {});
        }
        partyRole = null;
        partyCode = '';
        partySessionRunning = false;
        lastGuestReport = { state: '', time: 0 };
        lastPartyRevision = 0;
        serverClockOffsetMs = 0;
        clockSynced = false;
        clockSyncRttMs = Infinity;
        if (clockSyncTimer !== null) clearInterval(clockSyncTimer);
        clockSyncTimer = null;
        hideJoinedTargetMarker();
        memberStats.clear();
        if (clearSavedSession) clearSavedPartySession();
    }

    function leaveToModePicker() {
        if (partyRole === 'host' && (timer !== null || countdownTimer !== null)) sendParty({ type: 'command', command: 'stop' });
        stopClicking('Stopped');
        disconnectParty();
        mode = null;
        showModeScreen();
    }

    function sendParty(message) {
        if (httpParty && partyRole) {
            const session = httpParty;
            partySendChain = partySendChain
                .catch(() => {})
                .then(() => {
                    if (httpParty === session && !session.closed) {
                        return partyRequest('POST', `/api/party/message?token=${encodeURIComponent(session.token)}`, message);
                    }
                })
                .catch(() => {});
        }
    }

    function getPartyConfig() {
        return { type: 'command', command: 'config', settings: getSettings(), targetSelector };
    }

    function getPartyStartCommand() {
        return { type: 'command', command: 'start', settings: getSettings(), targetSelector };
    }

    function getPartyCountdownCommand(delayMs, run) {
        return { type: 'command', command: 'countdown', delayMs, settings: getSettings(), targetSelector, run };
    }

    function cancelCountdown() {
        if (countdownTimer !== null) clearTimeout(countdownTimer);
        if (countdownDisplayTimer !== null) clearInterval(countdownDisplayTimer);
        countdownTimer = null;
        countdownDisplayTimer = null;
        countdownStartAt = null;
    }

    function refreshCountdownStatus() {
        if (countdownStartAt === null) return;
        const remaining = Math.max(0, countdownStartAt - serverClockOffsetMs - Date.now());
        setStatus(`Synchronized start in ${Math.ceil(remaining / 1_000)}…`, 'running');
    }

    function scheduleCountdown(serverStartAt, plan) {
        cancelCountdown();
        const delay = Math.max(0, serverStartAt - serverClockOffsetMs - Date.now());
        countdownStartAt = serverStartAt;
        refreshCountdownStatus();
        countdownDisplayTimer = setInterval(refreshCountdownStatus, 100);
        countdownTimer = setTimeout(() => {
            cancelCountdown();
            startClicking(true, plan);
        }, delay);
        updateControls();
    }

    async function startSynchronizedCountdown() {
        if (!httpParty || !partyRole || !clockSynced) return;
        const session = httpParty;
        const seed = new Uint32Array(1);
        crypto.getRandomValues(seed);
        const run = { seed: seed[0] };
        setStatus('Scheduling synchronized start…', 'running');
        updateControls();
        try {
            const response = await partyRequest('POST', `/api/party/message?token=${encodeURIComponent(session.token)}`, getPartyCountdownCommand(SYNC_COUNTDOWN_MS, run));
            const result = JSON.parse(response.responseText || '{}');
            if (httpParty !== session || !Number.isFinite(result.startAt) || !result.run) throw new Error('Invalid countdown response');
            partySessionRunning = true;
            scheduleCountdown(result.startAt, result.run);
        } catch (_) {
            partySessionRunning = false;
            setStatus('Could not schedule the synchronized start.', 'error');
            updateControls();
        }
    }

    function syncHostConfig() {
        if (partyRole === 'host') sendParty(getPartyConfig());
    }

    function connectToParty(role, roomCode) {
        partyCode = roomCode;
        mode = role;
        savePartySession(role, roomCode);
        showControlScreen();
        if (role === 'host') {
            ui.partyCode.textContent = roomCode;
            ui.partyStatus.textContent = 'Connecting…';
        } else {
            setStatus('Connecting to host…');
        }

        startHttpParty(role, roomCode);
    }

    function connectionFailed(message) {
        disconnectParty();
        setStatus(message, 'error');
        showModeScreen();
        setModeStatus(message, 'error');
    }

    function schedulePartyReconnect(role = mode, roomCode = partyCode) {
        if (reconnectTimer !== null || !role || !roomCode) return;
        const previousSession = httpParty;
        if (previousSession) previousSession.closed = true;
        httpParty = null;
        partyRole = null;
        lastPartyRevision = 0;
        clockSynced = false;
        if (clockSyncTimer !== null) clearInterval(clockSyncTimer);
        clockSyncTimer = null;
        if (mode === 'join') stopClicking('Connection lost. Reconnecting…');
        if (role === 'host') ui.partyStatus.textContent = 'Reconnecting…';
        else setStatus('Connection lost. Reconnecting…', 'error');
        updateControls();
        const delay = Math.min(10_000, 1_000 * (2 ** Math.min(reconnectAttempt, 4)));
        reconnectAttempt++;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startHttpParty(role, roomCode, true);
        }, delay);
    }

    function partyRequest(method, path, data) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url: PARTY_HTTP_URL + path,
                headers: data ? { 'Content-Type': 'application/json' } : undefined,
                data: data ? JSON.stringify(data) : undefined,
                timeout: 35_000,
                onload: response => {
                    if (response.status >= 200 && response.status < 300) resolve(response);
                    else {
                        const error = new Error(`Party server returned ${response.status}`);
                        error.status = response.status;
                        reject(error);
                    }
                },
                onerror: () => reject(new Error('Party request failed')),
                ontimeout: () => reject(new Error('Party request timed out'))
            });
        });
    }

    async function synchronizePartyClock(session, sampleCount = clockSynced ? RESYNC_CLOCK_SYNC_SAMPLES : INITIAL_CLOCK_SYNC_SAMPLES) {
        const samples = [];
        for (let index = 0; index < sampleCount; index++) {
            const clientSentAt = Date.now();
            try {
                const response = await partyRequest('POST', `/api/party/message?token=${encodeURIComponent(session.token)}`, {
                    type: 'time-sync',
                    clientSentAt
                });
                const clientReceivedAt = Date.now();
                const result = JSON.parse(response.responseText || '{}');
                const serverReceivedAt = result.serverReceivedAt ?? result.serverTime;
                const serverSentAt = result.serverSentAt ?? result.serverTime;
                if (result.type !== 'time-sync' || !Number.isFinite(serverReceivedAt) || !Number.isFinite(serverSentAt)) continue;
                const rtt = Math.max(0, (clientReceivedAt - clientSentAt) - (serverSentAt - serverReceivedAt));
                samples.push({
                    rtt,
                    offset: ((serverReceivedAt - clientSentAt) + (serverSentAt - clientReceivedAt)) / 2
                });
            } catch (_) {}
        }
        if (samples.length === 0) throw new Error('Clock synchronization failed');

        // NTP-style sync: use the median offset of the three fastest round trips.
        // Keeping the best-quality estimate prevents a delayed browser request from
        // making the visible clock difference jump by hundreds of milliseconds.
        const fastest = samples.sort((a, b) => a.rtt - b.rtt).slice(0, Math.min(3, samples.length));
        const offsets = fastest.map(sample => sample.offset).sort((a, b) => a - b);
        const candidateOffset = offsets[Math.floor(offsets.length / 2)];
        const candidateRtt = fastest[0].rtt;
        if (!clockSynced || candidateRtt < clockSyncRttMs) {
            serverClockOffsetMs = candidateOffset;
            clockSyncRttMs = candidateRtt;
        }
        clockSynced = true;
        if (partyRole === 'host') ui.partyStatus.textContent = 'Synchronized — ready.';
        if (partyRole === 'host') renderMemberStats();
        if (partyRole === 'join') reportGuest(timer !== null || countdownTimer !== null ? 'Running' : 'Ready');
        updateControls();
    }

    function beginClockResync(session) {
        if (clockSyncTimer !== null) clearInterval(clockSyncTimer);
        clockSyncTimer = setInterval(() => {
            if (httpParty !== session || session.closed || !partyRole) return;
            synchronizePartyClock(session).catch(() => {});
        }, 15_000);
    }

    async function startHttpParty(role, roomCode, reconnecting = false) {
        if (partyRole || httpParty) return;
        clearConnectionTimer();
        if (role === 'host') ui.partyStatus.textContent = 'Connecting…';
        else setStatus('Connecting to host…');
        try {
            const response = await partyRequest('POST', '/api/party/connect', { type: role, roomCode, browserId: getBrowserId() });
            const result = JSON.parse(response.responseText);
            if (!result.token || !result.message) throw new Error('Invalid party server response');
            const session = { token: result.token, closed: false };
            httpParty = session;
            handlePartyMessage(session, JSON.stringify(result.message));
            reconnectAttempt = 0;
            await synchronizePartyClock(session);
            applyPartyState(result.state);
            beginClockResync(session);
            pollHttpParty(session);
        } catch (_) {
            if (reconnecting) schedulePartyReconnect(role, roomCode);
            else connectionFailed('Could not connect to the party server.');
        }
    }

    async function pollHttpParty(session) {
        while (httpParty === session && !session.closed && partyRole) {
            try {
                const response = await partyRequest('GET', `/api/party/events?token=${encodeURIComponent(session.token)}`);
                if (!response.responseText) continue;
                const result = JSON.parse(response.responseText);
                for (const message of result.messages || []) handlePartyMessage(session, JSON.stringify(message));
                applyPartyState(result.state);
            } catch (error) {
                if (httpParty === session && !session.closed) {
                    if (error.status === 401) {
                        schedulePartyReconnect(mode, partyCode);
                        break;
                    }
                    setStatus('Party connection interrupted. Retrying…', 'error');
                    await new Promise(resolve => setTimeout(resolve, 1_000));
                }
            }
        }
    }

    function renderMemberStats() {
        ui.memberCount.textContent = String(memberStats.size);
        const members = Array.from(memberStats.values());
        const totalClicks = clicksCompleted + members.reduce((total, stats) => total + stats.clicks, 0);
        const hasUnlimited = clicksPlanned === 0 || members.some(stats => stats.total === null);
        const totalPlanned = clicksPlanned + members.reduce((total, stats) => total + (stats.total || 0), 0);
        const clickRate = hostRateSample.rate + members.reduce((total, stats) => total + (stats.rate || 0), 0);
        ui.partyProgress.textContent = `${totalClicks}${hasUnlimited ? ' / ∞' : ` / ${totalPlanned}`} clicks · ${clickRate.toFixed(1)}/s`;
        ui.memberList.replaceChildren();
        if (memberStats.size === 0) {
            const empty = document.createElement('div');
            empty.className = 'readonly';
            empty.textContent = 'No browsers joined yet.';
            ui.memberList.appendChild(empty);
            return;
        }
        for (const [id, stats] of memberStats) {
            const row = document.createElement('div');
            row.className = 'member';
            const header = document.createElement('div');
            header.className = 'member-head';
            const name = document.createElement('span');
            name.className = 'member-name';
            name.textContent = stats.browserId || `Session ${id}`;
            const state = document.createElement('span');
            state.className = 'member-state';
            state.textContent = stats.state;
            const total = stats.total === null ? '∞' : stats.total;
            const clock = Number.isFinite(stats.timeDiffMs)
                ? `${stats.timeDiffMs >= 0 ? '+' : ''}${Math.round(stats.timeDiffMs)} ms`
                : '—';
            const metrics = document.createElement('div');
            metrics.className = 'member-metrics';
            for (const [label, value] of [
                ['Progress', `${stats.clicks} / ${total}`],
                ['Rate', `${(stats.rate || 0).toFixed(1)}/s`],
                ['Clock', clock],
            ]) {
                const metric = document.createElement('div');
                metric.className = 'member-metric';
                const metricLabel = document.createElement('span');
                metricLabel.className = 'member-metric-label';
                metricLabel.textContent = label;
                const metricValue = document.createElement('span');
                metricValue.className = 'member-metric-value';
                metricValue.textContent = value;
                metric.append(metricLabel, metricValue);
                metrics.appendChild(metric);
            }
            header.append(name, state);
            row.append(header, metrics);
            ui.memberList.appendChild(row);
        }
    }

    function recordHostClick() {
        if (mode !== 'host') return;
        const now = Date.now();
        const elapsed = now - hostRateSample.time;
        const clickDelta = clicksCompleted - hostRateSample.clicks;
        if (elapsed > 0 && clickDelta >= 0) hostRateSample.rate = clickDelta * 1_000 / elapsed;
        hostRateSample.clicks = clicksCompleted;
        hostRateSample.time = now;
        renderMemberStats();
    }

    function reportGuest(state) {
        if (partyRole !== 'join') return;
        const now = Date.now();
        if (state === 'Running' && lastGuestReport.state === state && now - lastGuestReport.time < 500) return;
        lastGuestReport = { state, time: now };
        sendParty({ type: 'client-status', state, clicks: clicksCompleted, total: clicksPlanned === 0 ? null : clicksPlanned, clockOffsetMs: serverClockOffsetMs });
    }

    function handlePartyMessage(sourceSocket, rawMessage) {
        if (sourceSocket !== httpParty) return;
        let message;
        try { message = JSON.parse(rawMessage); } catch (_) { return; }

        if (message.type === 'welcome') {
            clearConnectionTimer();
            partyRole = message.role;
            partyCode = message.roomCode;
            if (partyRole === 'host') {
                ui.partyCode.textContent = partyCode;
                ui.partyStatus.textContent = 'Waiting for browsers to join.';
                renderMemberStats();
            } else {
                ui.clientId.textContent = message.browserId || getBrowserId();
                setStatus('Joined. Waiting for the host…');
                reportGuest('Waiting for host');
            }
            updateControls();
            return;
        }
        if (message.type === 'member-joined' && partyRole === 'host') {
            memberStats.set(message.memberId, {
                browserId: message.browserId || `Session ${message.memberId}`,
                state: message.status?.state || 'Joining…',
                clicks: message.status?.clicks || 0,
                total: message.status?.total ?? null,
                rate: 0,
                updatedAt: Date.now(),
                timeDiffMs: Number.isFinite(message.status?.clockOffsetMs) ? message.status.clockOffsetMs - serverClockOffsetMs : null
            });
            renderMemberStats();
            if (timer !== null) sendParty(getPartyStartCommand());
            else syncHostConfig();
            return;
        }
        if (message.type === 'member-left' && partyRole === 'host') {
            memberStats.delete(message.memberId);
            renderMemberStats();
            return;
        }
        if ((message.type === 'member-reconnecting' || message.type === 'member-reconnected') && partyRole === 'host') {
            const previous = memberStats.get(message.memberId);
            if (previous) {
                previous.state = message.type === 'member-reconnecting' ? 'Reconnecting…' : (message.status?.state || 'Ready');
                previous.updatedAt = Date.now();
                memberStats.set(message.memberId, previous);
                renderMemberStats();
            }
            return;
        }
        if (message.type === 'host-reconnecting' && partyRole === 'join') {
            setStatus('Host reconnecting…', 'running');
            return;
        }
        if (message.type === 'host-reconnected' && partyRole === 'join') {
            setStatus('Host reconnected. Synchronized.', 'running');
            return;
        }
        if (message.type === 'member-status' && partyRole === 'host') {
            const previous = memberStats.get(message.memberId);
            const now = Date.now();
            const elapsed = now - (previous?.updatedAt || now);
            const clickDelta = message.clicks - (previous?.clicks || 0);
            const rate = elapsed > 0 && clickDelta >= 0 ? clickDelta * 1_000 / elapsed : 0;
            memberStats.set(message.memberId, {
                browserId: previous?.browserId || `Session ${message.memberId}`,
                state: message.state,
                clicks: message.clicks,
                total: message.total,
                rate,
                updatedAt: now,
                timeDiffMs: Number.isFinite(message.clockOffsetMs) ? message.clockOffsetMs - serverClockOffsetMs : null
            });
            renderMemberStats();
            return;
        }
        if (message.type === 'command' && partyRole === 'join') {
            if (Number.isInteger(message.revision)) lastPartyRevision = Math.max(lastPartyRevision, message.revision);
            if (message.command === 'config') applyPartyConfig(message);
            if (message.command === 'start') {
                if (message.settings && typeof message.targetSelector === 'string') applyPartyConfig(message);
                startClicking(true, message.run || null);
            }
            if (message.command === 'countdown') {
                applyPartyConfig(message);
                if (Number.isFinite(message.startAt) && message.run) scheduleCountdown(message.startAt, message.run);
            }
            if (message.command === 'stop') stopClicking('Stopped by host');
            return;
        }
        if (message.type === 'party-ended') {
            stopClicking('Host ended the party.');
            disconnectParty();
            setStatus('Host ended the party.', 'error');
            return;
        }
        if (message.type === 'error') connectionFailed(message.message || 'Party error.');
    }

    function applyPartyState(state) {
        if (!state || !Number.isInteger(state.revision)) return;
        if (partyRole === 'host') {
            if (state.config) applyPartyConfig(state.config);
            partySessionRunning = Boolean(state.running || Number.isFinite(state.scheduledStartAt));
            if (state.running) setStatus('Room restored. Joined browsers are still running.', 'running');
            else if (Number.isFinite(state.scheduledStartAt)) setStatus('Room restored. A synchronized start is scheduled.', 'running');
            updateControls();
            return;
        }
        if (partyRole !== 'join' || state.revision <= lastPartyRevision) return;
        lastPartyRevision = state.revision;
        if (state.config) applyPartyConfig(state.config);
        if (state.running) startClicking(true, state.run || null);
        else if (Number.isFinite(state.scheduledStartAt) && state.run) scheduleCountdown(state.scheduledStartAt, state.run);
        else stopClicking('Stopped by host');
    }

    function applyPartyConfig(config) {
        const settings = config.settings;
        if (!settings || !Number.isFinite(settings.delay) || !Number.isFinite(settings.randomization) || !Number.isInteger(settings.count)) return;
        ui.delay.value = settings.delay;
        ui.randomization.value = settings.randomization;
        ui.count.value = settings.count;
        if (target) target.removeAttribute(TARGET_ATTRIBUTE);
        hideJoinedTargetMarker();
        targetSelector = config.targetSelector || '';
        target = null;
        if (!targetSelector) {
            clearTargetDisplay();
            setStatus('Waiting for the host to select a button.');
            reportGuest('Waiting for target');
            return;
        }
        const element = resolveTarget();
        if (element) {
            setTargetDisplay(element);
            if (partyRole === 'join') showJoinedTargetMarker(element);
            setStatus(partyRole === 'host' ? 'Room target restored.' : 'Ready — target received from host.');
            reportGuest('Ready');
        } else {
            clearTargetDisplay();
            setStatus('Host target was not found on this page.', 'error');
            reportGuest('Target not found');
        }
        saveSettings();
    }

    function escapeCSS(value) {
        return window.CSS && typeof window.CSS.escape === 'function' ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`);
    }

    function createSelector(element) {
        if (element.id) {
            const selector = `#${escapeCSS(element.id)}`;
            try { if (document.querySelectorAll(selector).length === 1) return selector; } catch (_) { /* use a path */ }
        }
        const parts = [];
        let current = element;
        while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
            let part = current.tagName.toLowerCase();
            if (current.parentElement) {
                const siblings = Array.from(current.parentElement.children).filter(item => item.tagName === current.tagName);
                if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
            }
            parts.unshift(part);
            const selector = parts.join(' > ');
            try { if (document.querySelectorAll(selector).length === 1) return selector; } catch (_) { /* continue */ }
            current = current.parentElement;
        }
        return parts.join(' > ');
    }

    function describeElement(element) {
        const text = (element.innerText || element.value || element.getAttribute('aria-label') || '').trim();
        return text ? `${element.tagName.toLowerCase()}: ${text.slice(0, 55)}` : element.tagName.toLowerCase();
    }

    function setTargetDisplay(element) {
        ui.target.textContent = describeElement(element);
        ui.target.title = targetSelector;
        ui.target.classList.add('selected');
    }

    function clearTargetDisplay() {
        ui.target.textContent = mode === 'join' ? 'Waiting for target from host' : 'No button selected';
        ui.target.title = '';
        ui.target.classList.remove('selected');
    }

    function showJoinedTargetMarker(element) {
        if (mode !== 'join' || !element?.isConnected) return;
        const rect = element.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return hideJoinedTargetMarker();
        const padding = 7;
        joinedTargetMarker.style.display = 'block';
        joinedTargetMarker.style.left = `${Math.max(0, rect.left - padding)}px`;
        joinedTargetMarker.style.top = `${Math.max(0, rect.top - padding)}px`;
        joinedTargetMarker.style.width = `${rect.width + padding * 2}px`;
        joinedTargetMarker.style.height = `${rect.height + padding * 2}px`;
    }

    function hideJoinedTargetMarker() {
        joinedTargetMarker.style.display = 'none';
    }

    function refreshJoinedTargetMarker() {
        if (mode === 'join' && target?.isConnected) showJoinedTargetMarker(target);
        else hideJoinedTargetMarker();
    }

    function clearHover() {
        if (hoveredElement) hoveredElement.removeAttribute(HOVER_ATTRIBUTE);
        hoveredElement = null;
    }

    function handleHover(event) {
        if (!selecting || host.contains(event.target)) return;
        clearHover();
        hoveredElement = event.target;
        hoveredElement.setAttribute(HOVER_ATTRIBUTE, '');
    }

    function endSelection(message = 'Selection cancelled') {
        selecting = false;
        clearHover();
        ui.select.textContent = 'Select button';
        ui.select.classList.remove('selecting');
        document.removeEventListener('mouseover', handleHover, true);
        document.removeEventListener('click', handleSelectionClick, true);
        if (message) setStatus(message);
    }

    function handleSelectionClick(event) {
        if (!selecting || host.contains(event.target)) return;
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
        if (target) target.removeAttribute(TARGET_ATTRIBUTE);
        target = event.target;
        targetSelector = createSelector(target);
        target.setAttribute(TARGET_ATTRIBUTE, '');
        setTargetDisplay(target);
        endSelection('Button selected');
        syncHostConfig();
    }

    function beginSelection() {
        stopClicking('Stopped for a new selection');
        selecting = true;
        ui.select.textContent = 'Click a button… (Esc to cancel)';
        ui.select.classList.add('selecting');
        setStatus('Move over the page and click your target');
        document.addEventListener('mouseover', handleHover, true);
        document.addEventListener('click', handleSelectionClick, true);
    }

    function resolveTarget() {
        if (target && target.isConnected) return target;
        if (!targetSelector) return null;
        try {
            target = document.querySelector(targetSelector);
            if (target) target.setAttribute(TARGET_ATTRIBUTE, '');
            return target;
        } catch (_) { return null; }
    }

    function getRandomDelay() {
        const minimum = Math.max(MIN_DELAY, Number(ui.delay.value) - Number(ui.randomization.value));
        const maximum = Math.max(minimum, Number(ui.delay.value) + Number(ui.randomization.value));
        if (!runPlan) return Math.round(minimum + Math.random() * (maximum - minimum));
        // xorshift32 gives every browser the same delay sequence from the shared run seed.
        syncedRandomState ^= syncedRandomState << 13;
        syncedRandomState ^= syncedRandomState >>> 17;
        syncedRandomState ^= syncedRandomState << 5;
        const fraction = (syncedRandomState >>> 0) / 0x100000000;
        return Math.round(minimum + fraction * (maximum - minimum));
    }

    function stopClicking(message = 'Stopped') {
        cancelCountdown();
        if (timer !== null) { clearTimeout(timer); timer = null; }
        runPlan = null;
        nextClickAt = null;
        updateControls();
        if (mode === 'host') renderMemberStats();
        if (message) setStatus(message);
        if (mode === 'join') reportGuest(message === 'Stopped by host' ? 'Stopped by host' : 'Stopped');
    }

    function scheduleNextClick() {
        const nextDelay = getRandomDelay();
        const total = clicksPlanned === 0 ? '∞' : clicksPlanned;
        let wait = nextDelay;
        if (runPlan) {
            nextClickAt += nextDelay;
            wait = Math.max(0, nextClickAt - serverClockOffsetMs - Date.now());
        }
        setStatus(`Running: ${clicksCompleted} / ${total} — next in ${Math.ceil(wait)} ms`, 'running');
        timer = setTimeout(performClick, wait);
        updateControls();
        if (mode === 'join') reportGuest('Running');
    }

    function performClick() {
        timer = null;
        const element = resolveTarget();
        if (!element) {
            stopClicking('The host target is no longer on this page');
            if (mode === 'join') reportGuest('Target not found');
            return;
        }
        refreshJoinedTargetMarker();
        element.click();
        clicksCompleted++;
        recordHostClick();
        if (clicksPlanned > 0 && clicksCompleted >= clicksPlanned) {
            if (mode === 'host') {
                partySessionRunning = false;
                sendParty({ type: 'command', command: 'stop' });
            }
            stopClicking(`Finished ${clicksCompleted} ${clicksCompleted === 1 ? 'click' : 'clicks'}`);
            if (mode === 'join') reportGuest('Finished');
            return;
        }
        scheduleNextClick();
    }

    function validateSettings() {
        const { delay, randomization, count } = getSettings();
        if (!Number.isFinite(delay) || delay < MIN_DELAY) return `Base delay must be at least ${MIN_DELAY} ms`;
        if (!Number.isFinite(randomization) || randomization < 0) return 'Randomization must be 0 or higher';
        if (!Number.isInteger(count) || count < 0) return 'Number of clicks must be a whole number';
        return '';
    }

    function startClicking(fromHost = false, synchronizedPlan = null) {
        if (timer !== null) return;
        if (mode === 'join' && !fromHost) return;
        cancelCountdown();
        const validationError = validateSettings();
        if (validationError) { setStatus(validationError, 'error'); if (mode === 'join') reportGuest('Invalid host settings'); return; }
        if (!resolveTarget()) { setStatus(mode === 'join' ? 'Host target not found on this page.' : 'Select a button first', 'error'); if (mode === 'join') reportGuest('Target not found'); return; }
        saveSettings();
        clicksCompleted = 0;
        clicksPlanned = Number(ui.count.value);
        runPlan = synchronizedPlan && Number.isInteger(synchronizedPlan.seed) && Number.isFinite(synchronizedPlan.startAt) ? synchronizedPlan : null;
        syncedRandomState = runPlan ? (runPlan.seed || 0x6D2B79F5) : 0;
        nextClickAt = runPlan ? runPlan.startAt : null;
        if (mode === 'host') {
            hostRateSample = { clicks: 0, time: Date.now(), rate: 0 };
            renderMemberStats();
        }
        scheduleNextClick();
    }

    ui.chooseLocal.addEventListener('click', () => {
        clearSavedPartySession();
        mode = 'local';
        target = null;
        targetSelector = '';
        clearTargetDisplay();
        showControlScreen();
        setStatus('Ready');
    });
    ui.chooseHost.addEventListener('click', () => {
        const savedSession = getSavedPartySession();
        connectToParty('host', savedSession?.role === 'host' ? savedSession.roomCode : generatePartyCode());
    });
    ui.chooseJoin.addEventListener('click', () => {
        ui.joinForm.hidden = false;
        ui.joinCode.focus();
    });
    ui.connectJoin.addEventListener('click', () => {
        const code = ui.joinCode.value.trim().toUpperCase();
        if (!/^[A-Z2-9]{6,16}$/.test(code)) { setModeStatus('Enter the valid party code from the host.', 'error'); return; }
        connectToParty('join', code);
    });
    ui.joinCode.addEventListener('keydown', event => { if (event.key === 'Enter') ui.connectJoin.click(); });
    ui.dragHandle.addEventListener('pointerdown', startDragging);
    ui.minimize.addEventListener('click', toggleMinimized);
    ui.copyCode.addEventListener('click', copyPartyCode);
    ui.endRoom.addEventListener('click', leaveToModePicker);
    ui.back.addEventListener('click', leaveToModePicker);
    ui.select.addEventListener('click', () => selecting ? endSelection() : beginSelection());
    ui.start.addEventListener('click', () => {
        const validationError = validateSettings();
        if (validationError) { setStatus(validationError, 'error'); return; }
        if (!resolveTarget()) { setStatus('Select a button first', 'error'); return; }
        if (mode === 'host') {
            startSynchronizedCountdown();
            return;
        }
        startClicking();
    });
    ui.stop.addEventListener('click', () => {
        if (mode === 'host') {
            partySessionRunning = false;
            sendParty({ type: 'command', command: 'stop' });
        }
        stopClicking();
    });
    [ui.delay, ui.randomization, ui.count].forEach(element => element.addEventListener('change', () => {
        saveSettings();
        syncHostConfig();
    }));
    ui.hide.addEventListener('click', () => { if (selecting) endSelection(); host.style.display = 'none'; });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (selecting) endSelection();
        else if (timer !== null || countdownTimer !== null) {
            if (mode === 'host') sendParty({ type: 'command', command: 'stop' });
            stopClicking();
        }
    }, true);

    window.addEventListener('scroll', refreshJoinedTargetMarker, true);
    window.addEventListener('resize', refreshJoinedTargetMarker);

    GM_registerMenuCommand('Show Auto Clicker', () => { host.style.display = 'block'; });
    loadSettings();
    loadPanelPosition();
    showModeScreen();
    const savedPartySession = getSavedPartySession();
    if (savedPartySession) {
        setModeStatus(`Restoring ${savedPartySession.role} session…`);
        setTimeout(() => connectToParty(savedPartySession.role, savedPartySession.roomCode), 0);
    }
})();
