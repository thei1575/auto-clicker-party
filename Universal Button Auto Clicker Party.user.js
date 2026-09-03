// ==UserScript==
// @name         Universal Button Auto Clicker Party
// @namespace    https://tampermonkey.net/
// @version      3.0.1
// @description  Local auto-clicking or host-controlled synchronized click parties.
// @author       Theis
// @match        http://*/*
// @match        https://*/*
// @noframes
// @run-at       document-idle
// @sandbox       DOM
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      clicker.oz1tnj.dk
// ==/UserScript==

(function () {
    'use strict';

    const MIN_DELAY = 20;
    const SETTINGS_KEY = 'universalAutoClickerPartySettings';
    const PARTY_SERVER_URL = 'wss://clicker.oz1tnj.dk';
    const PARTY_HTTP_URL = 'https://clicker.oz1tnj.dk';
    const PARTY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const TARGET_ATTRIBUTE = 'data-auto-clicker-target';
    const HOVER_ATTRIBUTE = 'data-auto-clicker-hover';

    let mode = null;
    let target = null;
    let targetSelector = '';
    let hoveredElement = null;
    let selecting = false;
    let timer = null;
    let clicksCompleted = 0;
    let clicksPlanned = 0;
    let socket = null;
    let httpParty = null;
    let startingHttpFallback = false;
    let partyRole = null;
    let partyCode = '';
    let connectionTimer = null;
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

    shadow.innerHTML = `
        <style>
            :host { all:initial; }
            * { box-sizing:border-box; }
            .panel { width:330px; padding:14px; color:#f8fafc; background:rgba(15,23,42,.98); border:1px solid #334155; border-radius:12px; box-shadow:0 14px 35px rgba(0,0,0,.38); font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
            .header { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
            .title { font-size:15px; font-weight:700; }
            button { font:inherit; }
            .close,.back { padding:5px 7px; color:#cbd5e1; background:transparent; border:0; border-radius:7px; cursor:pointer; }
            .close { font-size:18px; }
            .close:hover,.back:hover { background:#334155; }
            .screen[hidden],.host-only[hidden],.join-only[hidden] { display:none; }
            .intro { margin:2px 0 12px; color:#94a3b8; }
            .mode-buttons { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
            .action { padding:10px; color:#fff; background:#2563eb; border:0; border-radius:8px; cursor:pointer; font-weight:700; }
            .action:hover { filter:brightness(1.12); }
            .action:disabled { opacity:.48; cursor:not-allowed; filter:none; }
            #choose-host { background:#7c3aed; }
            #stop { background:#dc2626; }
            .card { margin-bottom:10px; padding:10px; background:#111c31; border:1px solid #334155; border-radius:9px; }
            .card-title { display:flex; justify-content:space-between; align-items:center; margin-bottom:7px; color:#bfdbfe; font-weight:700; }
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
            .member-list { display:grid; gap:5px; }
            .member { display:flex; justify-content:space-between; padding:6px 7px; color:#cbd5e1; background:#0f172a; border-radius:6px; font-size:11px; }
            .readonly { color:#94a3b8; }
        </style>
        <section class="panel">
            <div class="header"><div class="title">Auto Clicker</div><button class="close" id="hide" title="Hide panel">×</button></div>

            <section class="screen" id="mode-screen">
                <p class="intro">Choose how this browser should participate.</p>
                <div class="mode-buttons">
                    <button class="action" id="choose-local">Local</button>
                    <button class="action" id="choose-host">Host</button>
                    <button class="action" id="choose-join">Join</button>
                </div>
                <div class="card" id="join-form" hidden>
                    <label>Party code<input id="join-code" maxlength="16" placeholder="Enter host code"></label>
                    <button class="action" id="connect-join" style="width:100%;margin-top:9px">Join party</button>
                </div>
                <div class="status" id="mode-status">Local controls stay in this browser. Host controls sync to joined browsers.</div>
            </section>

            <section class="screen" id="control-screen" hidden>
                <div class="header"><button class="back" id="back">← Change mode</button><span id="mode-label"></span></div>
                <section class="card host-only" id="host-card" hidden>
                    <div class="card-title"><span>Party code</span><span id="party-code"></span></div>
                    <div class="party-status" id="party-status">Connecting…</div>
                </section>
                <section class="card host-only" id="member-card" hidden>
                    <div class="card-title"><span>Joined browsers</span><span id="member-count">0</span></div>
                    <div class="member-list" id="member-list"><div class="readonly">No browsers joined yet.</div></div>
                </section>
                <section class="card join-only" id="join-card" hidden>
                    <div class="card-title">Joined party</div>
                    <div class="readonly">The host selects the target and controls all settings. This browser will follow automatically.</div>
                </section>
                <div class="target" id="target">No button selected</div>
                <div class="buttons" id="selection-controls"><button class="action" id="select">Select button</button></div>
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
        </section>`;

    const ui = Object.fromEntries([
        'hide', 'mode-screen', 'control-screen', 'choose-local', 'choose-host', 'choose-join',
        'join-form', 'join-code', 'connect-join', 'mode-status', 'back', 'mode-label',
        'host-card', 'party-code', 'party-status', 'member-card', 'member-count', 'member-list',
        'join-card', 'target', 'selection-controls', 'select', 'control-settings', 'delay',
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

    function showModeScreen() {
        ui.modeScreen.hidden = false;
        ui.controlScreen.hidden = true;
        ui.joinForm.hidden = true;
        setModeStatus('Local controls stay in this browser. Host controls sync to joined browsers.');
    }

    function showControlScreen() {
        const isHost = mode === 'host';
        const isJoin = mode === 'join';
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
        const running = timer !== null;
        const hostConnecting = mode === 'host' && !partyConnected();
        ui.select.disabled = running || joined;
        ui.delay.disabled = running || joined;
        ui.randomization.disabled = running || joined;
        ui.count.disabled = running || joined;
        ui.start.disabled = running || joined || hostConnecting;
        ui.stop.disabled = !running || joined;
    }

    function generatePartyCode() {
        const values = new Uint32Array(8);
        crypto.getRandomValues(values);
        return Array.from(values, value => PARTY_CODE_ALPHABET[value % PARTY_CODE_ALPHABET.length]).join('');
    }

    function partyConnected() {
        return (socket && socket.readyState === WebSocket.OPEN && partyRole) || (httpParty && partyRole);
    }

    function clearConnectionTimer() {
        if (connectionTimer !== null) {
            clearTimeout(connectionTimer);
            connectionTimer = null;
        }
    }

    function disconnectParty() {
        clearConnectionTimer();
        const currentHttpParty = httpParty;
        httpParty = null;
        startingHttpFallback = false;
        if (currentHttpParty) {
            currentHttpParty.closed = true;
            partyRequest('POST', `/api/party/disconnect?token=${encodeURIComponent(currentHttpParty.token)}`).catch(() => {});
        }
        if (socket) {
            const current = socket;
            socket = null;
            current.onclose = null;
            current.close();
        }
        partyRole = null;
        partyCode = '';
        memberStats.clear();
    }

    function leaveToModePicker() {
        if (partyRole === 'host' && timer !== null) sendParty({ type: 'command', command: 'stop' });
        stopClicking('Stopped');
        disconnectParty();
        mode = null;
        showModeScreen();
    }

    function sendParty(message) {
        if (socket && socket.readyState === WebSocket.OPEN && partyRole) {
            socket.send(JSON.stringify(message));
        } else if (httpParty && partyRole) {
            partyRequest('POST', `/api/party/message?token=${encodeURIComponent(httpParty.token)}`, message).catch(() => {});
        }
    }

    function getPartyConfig() {
        return { type: 'command', command: 'config', settings: getSettings(), targetSelector };
    }

    function syncHostConfig() {
        if (partyRole === 'host') sendParty(getPartyConfig());
    }

    function connectToParty(role, roomCode) {
        partyCode = roomCode;
        mode = role;
        showControlScreen();
        if (role === 'host') {
            ui.partyCode.textContent = roomCode;
            ui.partyStatus.textContent = 'Connecting…';
        } else {
            setStatus('Connecting to host…');
        }

        let newSocket;
        try {
            newSocket = new WebSocket(PARTY_SERVER_URL);
        } catch (_) {
            startHttpFallback(role, roomCode);
            return;
        }

        socket = newSocket;
        connectionTimer = setTimeout(() => {
            if (socket === newSocket && !partyRole) startHttpFallback(role, roomCode);
        }, 10_000);
        newSocket.onopen = () => newSocket.send(JSON.stringify({ type: role, roomCode }));
        newSocket.onmessage = event => handlePartyMessage(newSocket, event.data);
        newSocket.onerror = () => {
            if (!partyRole) setStatus('Trying compatible connection…');
        };
        newSocket.onclose = () => {
            if (socket !== newSocket) return;
            const hadParty = Boolean(partyRole);
            clearConnectionTimer();
            socket = null;
            if (!hadParty && !httpParty) {
                startHttpFallback(role, roomCode);
                return;
            }
            partyRole = null;
            if (hadParty) stopClicking('Party disconnected — stopped');
            if (mode === 'host') ui.partyStatus.textContent = 'Disconnected';
            if (mode === 'join') setStatus('Disconnected from host.', 'error');
        };
    }

    function connectionFailed(message) {
        disconnectParty();
        setStatus(message, 'error');
        showModeScreen();
        setModeStatus(message, 'error');
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
                    else reject(new Error(`Party server returned ${response.status}`));
                },
                onerror: () => reject(new Error('Party request failed')),
                ontimeout: () => reject(new Error('Party request timed out'))
            });
        });
    }

    async function startHttpFallback(role, roomCode) {
        if (partyRole || httpParty || startingHttpFallback) return;
        startingHttpFallback = true;
        clearConnectionTimer();
        if (socket) {
            const current = socket;
            socket = null;
            current.onclose = null;
            current.close();
        }
        if (role === 'host') ui.partyStatus.textContent = 'Connecting…';
        else setStatus('Connecting to host…');
        try {
            const response = await partyRequest('POST', '/api/party/connect', { type: role, roomCode });
            const result = JSON.parse(response.responseText);
            if (!result.token || !result.message) throw new Error('Invalid party server response');
            const session = { token: result.token, closed: false };
            httpParty = session;
            startingHttpFallback = false;
            handlePartyMessage(session, JSON.stringify(result.message));
            pollHttpParty(session);
        } catch (_) {
            startingHttpFallback = false;
            connectionFailed('Could not connect to the party server.');
        }
    }

    async function pollHttpParty(session) {
        while (httpParty === session && !session.closed && partyRole) {
            try {
                const response = await partyRequest('GET', `/api/party/events?token=${encodeURIComponent(session.token)}`);
                if (!response.responseText) continue;
                const result = JSON.parse(response.responseText);
                for (const message of result.messages || []) handlePartyMessage(session, JSON.stringify(message));
            } catch (_) {
                if (httpParty === session && !session.closed) {
                    setStatus('Party connection interrupted. Retrying…', 'error');
                    await new Promise(resolve => setTimeout(resolve, 1_000));
                }
            }
        }
    }

    function renderMemberStats() {
        ui.memberCount.textContent = String(memberStats.size);
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
            const name = document.createElement('span');
            const progress = document.createElement('span');
            name.textContent = `Browser ${id}: ${stats.state}`;
            progress.textContent = stats.total === null ? `${stats.clicks} / ∞` : `${stats.clicks} / ${stats.total}`;
            row.append(name, progress);
            ui.memberList.appendChild(row);
        }
    }

    function reportGuest(state) {
        if (partyRole !== 'join') return;
        sendParty({ type: 'client-status', state, clicks: clicksCompleted, total: clicksPlanned === 0 ? null : clicksPlanned });
    }

    function handlePartyMessage(sourceSocket, rawMessage) {
        if (sourceSocket !== socket && sourceSocket !== httpParty) return;
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
                setStatus('Joined. Waiting for the host…');
                reportGuest('Waiting for host');
            }
            updateControls();
            return;
        }
        if (message.type === 'member-joined' && partyRole === 'host') {
            memberStats.set(message.memberId, { state: 'Joining…', clicks: 0, total: null });
            renderMemberStats();
            syncHostConfig();
            if (timer !== null) sendParty({ type: 'command', command: 'start' });
            return;
        }
        if (message.type === 'member-left' && partyRole === 'host') {
            memberStats.delete(message.memberId);
            renderMemberStats();
            return;
        }
        if (message.type === 'member-status' && partyRole === 'host') {
            memberStats.set(message.memberId, { state: message.state, clicks: message.clicks, total: message.total });
            renderMemberStats();
            return;
        }
        if (message.type === 'command' && partyRole === 'join') {
            if (message.command === 'config') applyPartyConfig(message);
            if (message.command === 'start') startClicking(true);
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

    function applyPartyConfig(config) {
        const settings = config.settings;
        if (!settings || !Number.isFinite(settings.delay) || !Number.isFinite(settings.randomization) || !Number.isInteger(settings.count)) return;
        ui.delay.value = settings.delay;
        ui.randomization.value = settings.randomization;
        ui.count.value = settings.count;
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
            setStatus('Ready — target received from host.');
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
        return Math.round(minimum + Math.random() * (maximum - minimum));
    }

    function stopClicking(message = 'Stopped') {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        updateControls();
        if (message) setStatus(message);
        if (mode === 'join') reportGuest(message === 'Stopped by host' ? 'Stopped by host' : 'Stopped');
    }

    function scheduleNextClick() {
        const nextDelay = getRandomDelay();
        const total = clicksPlanned === 0 ? '∞' : clicksPlanned;
        setStatus(`Running: ${clicksCompleted} / ${total} — next in ${nextDelay} ms`, 'running');
        timer = setTimeout(performClick, nextDelay);
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
        element.click();
        clicksCompleted++;
        if (clicksPlanned > 0 && clicksCompleted >= clicksPlanned) {
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

    function startClicking(fromHost = false) {
        if (timer !== null) return;
        if (mode === 'join' && !fromHost) return;
        const validationError = validateSettings();
        if (validationError) { setStatus(validationError, 'error'); if (mode === 'join') reportGuest('Invalid host settings'); return; }
        if (!resolveTarget()) { setStatus(mode === 'join' ? 'Host target not found on this page.' : 'Select a button first', 'error'); if (mode === 'join') reportGuest('Target not found'); return; }
        saveSettings();
        clicksCompleted = 0;
        clicksPlanned = Number(ui.count.value);
        scheduleNextClick();
    }

    ui.chooseLocal.addEventListener('click', () => {
        mode = 'local';
        target = null;
        targetSelector = '';
        clearTargetDisplay();
        showControlScreen();
        setStatus('Ready');
    });
    ui.chooseHost.addEventListener('click', () => connectToParty('host', generatePartyCode()));
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
    ui.back.addEventListener('click', leaveToModePicker);
    ui.select.addEventListener('click', () => selecting ? endSelection() : beginSelection());
    ui.start.addEventListener('click', () => {
        const validationError = validateSettings();
        if (validationError) { setStatus(validationError, 'error'); return; }
        if (!resolveTarget()) { setStatus('Select a button first', 'error'); return; }
        if (mode === 'host') {
            syncHostConfig();
            sendParty({ type: 'command', command: 'start' });
        }
        startClicking();
    });
    ui.stop.addEventListener('click', () => {
        if (mode === 'host') sendParty({ type: 'command', command: 'stop' });
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
        else if (timer !== null) {
            if (mode === 'host') sendParty({ type: 'command', command: 'stop' });
            stopClicking();
        }
    }, true);

    GM_registerMenuCommand('Show Auto Clicker', () => { host.style.display = 'block'; });
    loadSettings();
    showModeScreen();
})();
