// ==UserScript==
// @name         Universal Button Auto Clicker Party
// @namespace    https://tampermonkey.net/
// @version      3.9.1
// @description  Local auto-clicking or host-controlled synchronized click parties, with optional human-like timing.
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
    // Bumped whenever the shared run plan changes shape, so a browser on an older script
    // refuses a plan it cannot reproduce instead of silently clicking to a different schedule.
    const RUN_PLAN_VERSION = 1;
    // Human clicking is bouts of clicks broken by short pauses, over a tempo that drifts and
    // slowly tires - not a flat distribution around one interval. These constants are tuned
    // for somebody spamming a button: long fast bursts, brief breathers between them.
    // Calibrated against a measured spam-clicker: 7 clicks/s nominal, topping out near 11 for
    // a ten-second stretch. Two properties have to hold at once. The spread of the tempo walk
    // (0.2 in log space, which is what the step and the decay give together) sets how fast a
    // sprint gets; the decay sets how long one lasts, here about fifty clicks, so a sprint can
    // run the better part of ten seconds before it pulls back instead of dying in three.
    const HUMAN_TEMPO_DECAY = 0.98;
    const HUMAN_TEMPO_STEP = 0.0398;
    const HUMAN_BURST_MIN = 10;
    const HUMAN_BURST_SCALE = 22;
    const HUMAN_REST_MEDIAN_MS = 260;
    const HUMAN_REST_SIGMA = 0.4;
    const HUMAN_LONG_REST_CHANCE = 0.04;
    const HUMAN_LONG_REST_MEDIAN_MS = 1_200;
    const HUMAN_LONG_REST_SIGMA = 0.5;
    const HUMAN_FATIGUE_MAX = 0.05;
    const HUMAN_FATIGUE_CLICKS = 6_000;
    const HUMAN_MIN_SIGMA = 0.05;
    // Human mode owns its own timing: these are the calibrated figures, not editable settings.
    const HUMAN_BASE_DELAY_MS = 136;
    const HUMAN_RANDOMIZATION_MS = 20;
    // Stationary variance of the tempo walk, and the pace of a sprint against the nominal one.
    const HUMAN_TEMPO_VARIANCE = HUMAN_TEMPO_STEP ** 2 / (1 - HUMAN_TEMPO_DECAY ** 2);
    const HUMAN_PEAK_SIGMAS = 1.645;
    const SETTINGS_KEY = 'universalAutoClickerPartySettings';
    const PANEL_POSITION_KEY = 'universalAutoClickerPartyPanelPosition';
    const BROWSER_ID_KEY = 'universalAutoClickerPartyBrowserId';
    const PARTY_SESSION_KEY = 'universalAutoClickerPartySession';
    const PARTY_HTTP_URL = 'https://clicker.oz1tnj.dk';
    const SYNC_COUNTDOWN_MS = 5_000;
    // A restored or dropped guest keeps retrying its old room for this long, so a host
    // that is still reloading does not force everybody to rejoin by hand.
    const PARTY_RESTORE_WINDOW_MS = 3 * 60_000;
    const PARTY_SESSION_TTL_MS = 12 * 60 * 60_000;
    const IDLE_POLL_INTERVAL_MS = 350;
    const INITIAL_CLOCK_SYNC_SAMPLES = 7;
    const RESYNC_CLOCK_SYNC_SAMPLES = 5;
    const PARTY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const TARGET_ATTRIBUTE = 'data-auto-clicker-target';
    const MARKER_ID = 'auto-clicker-target-marker';
    // The marker follows the target instead of waiting for a scroll or a click to notice that
    // the page moved it, and re-resolves the selector so an SPA re-render cannot strand it.
    const MARKER_TRACK_INTERVAL_MS = 100;
    const HOVER_ATTRIBUTE = 'data-auto-clicker-hover';
    const REJECTED_ATTRIBUTE = 'data-auto-clicker-rejected';
    // Elements the DOM itself reports as interactive.
    const INTERACTIVE_SELECTOR = [
        'button', 'a[href]', 'area[href]', 'input:not([type="hidden"])', 'select', 'textarea',
        'summary', 'label', '[onclick]',
        '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
        '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
        '[role="option"]', '[role="treeitem"]', '[role="combobox"]', '[role="spinbutton"]'
    ].join(',');
    const MAX_CLICKABLE_DEPTH = 12;

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
    let humanState = null;
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
    let clientDisplayId = '';
    let hostStateApplied = false;
    let partyRestoreDeadline = 0;
    let hostRateSample = { clicks: 0, time: Date.now(), rate: 0 };
    let dragOffset = null;
    let markerFrame = null;
    let markerRectKey = '';
    let markerCheckedAt = -Infinity;
    const memberStats = new Map();

    const pageStyle = document.createElement('style');
    pageStyle.textContent = `
        [${TARGET_ATTRIBUTE}] { outline: 3px solid #22c55e !important; outline-offset: 2px !important; }
        [${HOVER_ATTRIBUTE}] { outline: 3px solid #f59e0b !important; outline-offset: 2px !important; }
        [${REJECTED_ATTRIBUTE}] { outline: 3px dashed #ef4444 !important; outline-offset: 2px !important; cursor: not-allowed !important; }
        #${MARKER_ID} .chase { animation: auto-clicker-chase 1.15s linear infinite; }
        @keyframes auto-clicker-chase { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -100; } }
        @media (prefers-reduced-motion: reduce) {
            #${MARKER_ID} .chase { animation: none; stroke-dasharray: none; }
        }
    `;
    (document.head || document.documentElement).appendChild(pageStyle);

    const host = document.createElement('div');
    host.id = 'universal-auto-clicker-party-panel';
    host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    // A ring drawn as two SVG rounded rects: a faint full track so the button stays
    // identifiable at rest, and a bright arc chasing around it. pathLength normalises both to
    // 100 units, so one dash pattern and one animation fit a button of any size.
    const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
    const joinedTargetMarker = document.createElementNS(SVG_NAMESPACE, 'svg');
    joinedTargetMarker.id = MARKER_ID;
    joinedTargetMarker.setAttribute('aria-hidden', 'true');
    joinedTargetMarker.style.cssText = 'all:initial;display:none;position:fixed;z-index:2147483646;overflow:visible;pointer-events:none;filter:drop-shadow(0 0 5px rgba(34,197,94,.75));';
    const markerTrack = document.createElementNS(SVG_NAMESPACE, 'rect');
    const markerChase = document.createElementNS(SVG_NAMESPACE, 'rect');
    for (const ring of [markerTrack, markerChase]) {
        ring.setAttribute('pathLength', '100');
        ring.setAttribute('fill', 'none');
        ring.setAttribute('stroke-width', '3');
    }
    markerTrack.setAttribute('stroke', 'rgba(34,197,94,.3)');
    markerChase.setAttribute('class', 'chase');
    markerChase.setAttribute('stroke', '#22c55e');
    markerChase.setAttribute('stroke-linecap', 'round');
    markerChase.setAttribute('stroke-dasharray', '22 78');
    joinedTargetMarker.append(markerTrack, markerChase);
    document.documentElement.appendChild(joinedTargetMarker);

    shadow.innerHTML = `
        <style>
            :host { all:initial; }
            * { box-sizing:border-box; }
            .panel { display:flex; flex-direction:column; width:328px; max-height:calc(100vh - 28px); padding:12px; color:#f8fafc; background:rgba(15,23,42,.98); border:1px solid #334155; border-radius:12px; box-shadow:0 14px 35px rgba(0,0,0,.38); font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; user-select:none; }
            .panel.minimized { width:240px; max-height:none; padding:9px 10px; }
            .panel.minimized .title { font-size:13px; }
            .panel.minimized .screen,.panel.minimized .footer { display:none; }
            .header { display:flex; flex:0 0 auto; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; }
            #drag-handle { cursor:move; touch-action:none; }
            .panel.minimized #drag-handle { margin:0; }
            .title-wrap { display:flex; align-items:center; min-width:0; gap:6px; }
            .title { min-width:0; overflow:hidden; font-size:15px; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
            button { font:inherit; }
            .window-controls { display:flex; flex:0 0 auto; gap:2px; }
            .close,.minimize,.back { padding:5px 7px; color:#cbd5e1; background:transparent; border:0; border-radius:7px; cursor:pointer; }
            .close { font-size:18px; }
            .minimize { font-size:18px; line-height:1; }
            .close:hover,.minimize:hover,.back:hover { background:#334155; }
            .screen { display:flex; flex-direction:column; min-height:0; }
            .screen[hidden],.host-only[hidden],.join-only[hidden],#header-id[hidden],#run-buttons[hidden] { display:none; }
            .panel.joined-mode #selection-controls,.panel.joined-mode #control-settings,.panel.joined-mode #run-buttons { display:none !important; }
            .intro { margin:2px 0 12px; color:#94a3b8; }
            .mode-buttons { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
            .action { padding:10px; color:#fff; background:#2563eb; border:0; border-radius:8px; cursor:pointer; font-weight:700; }
            .action:hover { filter:brightness(1.12); }
            .action:disabled { opacity:.48; cursor:not-allowed; filter:none; }
            #choose-host { background:#7c3aed; }
            #stop { background:#dc2626; }
            .scroll-area { flex:1 1 auto; min-height:0; margin-right:-4px; padding-right:4px; overflow-y:auto; overscroll-behavior:contain; }
            .scroll-area::-webkit-scrollbar,.member-list::-webkit-scrollbar { width:7px; }
            .scroll-area::-webkit-scrollbar-thumb,.member-list::-webkit-scrollbar-thumb { background:#334155; border-radius:4px; }
            .card { margin-bottom:8px; padding:8px 9px; background:#111c31; border:1px solid #334155; border-radius:9px; }
            #host-card { border-color:#5b21b6; }
            #join-card { border-color:#0369a1; }
            #host-card,#join-card { position:sticky; top:0; z-index:2; box-shadow:0 6px 14px rgba(15,23,42,.6); }
            #join-form { margin-top:12px; margin-bottom:0; }
            #join-form .action { width:100%; margin-top:12px; }
            .card-title { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:5px; color:#bfdbfe; font-weight:700; }
            .badge { padding:2px 6px; border-radius:999px; font-size:9px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; }
            .badge.host,.header-id.host { color:#e9d5ff; background:#4c1d95; border:1px solid #7c3aed; }
            .badge.client,.header-id.client { color:#bae6fd; background:#0c4a6e; border:1px solid #0284c7; }
            .header-id { flex:0 0 auto; padding:2px 6px; border-radius:999px; font-size:9px; font-weight:700; font-variant-numeric:tabular-nums; white-space:nowrap; }
            .party-code-wrap { display:flex; flex:0 0 auto; align-items:center; gap:6px; font-variant-numeric:tabular-nums; }
            .copy-code { padding:3px 6px; color:#bfdbfe; background:#1e3a5f; border:1px solid #3b82f6; border-radius:5px; cursor:pointer; font-size:10px; }
            .copy-code:hover { background:#254b78; }
            .end-room { padding:3px 6px; color:#fecaca; background:#7f1d1d; border:1px solid #ef4444; border-radius:5px; cursor:pointer; font-size:10px; }
            .end-room:hover { background:#991b1b; }
            .id-row { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:5px 0; }
            .id-label { color:#64748b; font-size:10px; letter-spacing:.05em; text-transform:uppercase; }
            .id-value { color:#e2e8f0; font-weight:700; font-variant-numeric:tabular-nums; }
            .target { min-height:32px; margin-bottom:8px; padding:7px 9px; overflow:hidden; color:#94a3b8; background:#0f172a; border:1px solid #334155; border-radius:8px; text-overflow:ellipsis; white-space:nowrap; }
            .target.selected { color:#a7f3d0; border-color:#059669; }
            .grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:8px; margin:8px 0 0; }
            .full { grid-column:1/-1; }
            label { display:block; color:#cbd5e1; font-size:12px; }
            input,select { width:100%; margin-top:4px; padding:7px 8px; color:#f8fafc; background:#020617; border:1px solid #475569; border-radius:7px; outline:none; font:inherit; }
            input:focus,select:focus { border-color:#60a5fa; }
            select { appearance:none; background-image:linear-gradient(45deg,transparent 50%,#94a3b8 50%),linear-gradient(135deg,#94a3b8 50%,transparent 50%); background-position:calc(100% - 14px) 55%,calc(100% - 9px) 55%; background-size:5px 5px; background-repeat:no-repeat; cursor:pointer; }
            select:disabled { cursor:not-allowed; opacity:.55; }
            option { color:#f8fafc; background:#020617; }
            .hint { margin-top:3px; color:#64748b; font-size:10px; }
            [hidden] { display:none !important; }
            .buttons { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
            #select { grid-column:1/-1; background:#475569; }
            #select.selecting { background:#d97706; }
            .run-bar { flex:0 0 auto; margin-top:9px; padding-top:9px; border-top:1px solid #243247; }
            .run-progress { margin-bottom:7px; color:#86efac; font-size:11px; font-weight:600; font-variant-numeric:tabular-nums; text-align:center; }
            .status { min-height:17px; margin-top:8px; color:#94a3b8; font-size:12px; }
            .status.running { color:#86efac; }
            .status.error { color:#fca5a5; }
            #mode-status { margin-top:12px; }
            .party-status { color:#94a3b8; font-size:11px; }
            .party-status.ok { color:#86efac; }
            .party-status.warn { color:#fcd34d; }
            .party-status.error { color:#fca5a5; }
            .member-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(128px,1fr)); gap:5px; max-height:min(30vh,188px); margin-right:-4px; padding-right:4px; overflow-y:auto; overscroll-behavior:contain; }
            .member { display:grid; gap:2px; padding:5px 6px; background:#0f172a; border:1px solid #243247; border-radius:6px; font-size:10px; }
            .member.offline { border-color:#78350f; opacity:.72; }
            .member-head { display:flex; align-items:center; min-width:0; gap:5px; }
            .dot { flex:0 0 auto; width:6px; height:6px; border-radius:50%; background:#64748b; }
            .dot.ready { background:#38bdf8; }
            .dot.running { background:#22c55e; }
            .dot.warn { background:#f59e0b; }
            .dot.error { background:#ef4444; }
            .member-id { flex:1 1 auto; min-width:0; overflow:hidden; color:#e2e8f0; font-weight:700; font-variant-numeric:tabular-nums; text-overflow:ellipsis; white-space:nowrap; }
            .member-clock { flex:0 0 auto; color:#64748b; font-variant-numeric:tabular-nums; }
            .member-line { display:flex; align-items:center; justify-content:space-between; min-width:0; gap:6px; }
            .member-state { overflow:hidden; color:#93c5fd; text-overflow:ellipsis; white-space:nowrap; }
            .member-nums { flex:0 0 auto; color:#cbd5e1; font-variant-numeric:tabular-nums; }
            .client-id { flex:0 0 auto; padding:3px 6px; color:#bbf7d0; background:#14532d; border:1px solid #22c55e; border-radius:999px; font-size:10px; font-variant-numeric:tabular-nums; }
            .readonly { color:#94a3b8; font-size:11px; }
            .footer { flex:0 0 auto; margin-top:9px; padding-top:8px; color:#64748b; border-top:1px solid #243247; font-size:10px; text-align:center; }
            .footer a { color:#93c5fd; text-decoration:none; }
            .footer a:hover { text-decoration:underline; }
        </style>
        <section class="panel" id="panel">
            <div class="header" id="drag-handle" title="Drag to move this window"><div class="title-wrap"><div class="title">Auto Clicker</div><span class="header-id" id="header-id" hidden></span></div><div class="window-controls"><button class="minimize" id="minimize" title="Minimize" aria-label="Minimize">&minus;</button><button class="close" id="hide" title="Hide panel" aria-label="Hide panel">&times;</button></div></div>

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
                <div class="header"><button class="back" id="back">&larr; Change mode</button><span id="mode-label"></span></div>
                <div class="scroll-area">
                    <section class="card host-only" id="host-card" hidden>
                        <div class="card-title"><span>Party code <span class="badge host">Host</span></span><span class="party-code-wrap"><span id="party-code"></span><button class="copy-code" id="copy-code" title="Copy party code">Copy</button><button class="end-room" id="end-room" title="End this room for everyone">End</button></span></div>
                        <div class="id-row"><span class="id-label">This browser</span><span class="client-id" id="host-id">&mdash;</span></div>
                        <div class="party-status" id="party-status">Connecting&hellip;</div>
                    </section>
                    <section class="card host-only" id="member-card" hidden>
                        <div class="card-title"><span>Joined browsers</span><span class="party-status" id="member-summary">0 joined</span></div>
                        <div class="member-list" id="member-list"><div class="readonly">No browsers joined yet.</div></div>
                    </section>
                    <section class="card join-only" id="join-card" hidden>
                        <div class="card-title"><span>Joined party <span class="badge client">Client</span></span><span class="client-id" id="client-id">&mdash;</span></div>
                        <div class="id-row"><span class="id-label">Party code</span><span class="id-value" id="join-room-code">&mdash;</span></div>
                        <div class="party-status" id="join-connection">Connecting&hellip;</div>
                        <div class="readonly">The host selects the target and controls every setting.</div>
                    </section>
                    <div class="target" id="target">No button selected</div>
                    <div class="buttons host-only" id="selection-controls"><button class="action" id="select">Select button</button></div>
                    <div id="control-settings">
                        <div class="grid">
                            <label class="full">Timing<select id="timing-mode"><option value="human">Human-like</option><option value="manual">Manual</option></select></label>
                            <div class="hint full" id="rate-hint"></div>
                            <label id="delay-field">Base delay (ms)<input id="delay" type="number" min="${MIN_DELAY}" step="10" value="1000"></label>
                            <label id="randomization-field">Randomize &plusmn; (ms)<input id="randomization" type="number" min="0" step="10" value="0"></label>
                            <label class="full">Number of clicks<input id="count" type="number" min="0" step="1" value="10"><div class="hint">0 = unlimited clicks</div></label>
                        </div>
                    </div>
                </div>
                <div class="run-bar">
                    <div class="run-progress host-only" id="party-progress" hidden>0 clicks &middot; 0.0/s</div>
                    <div class="buttons" id="run-buttons"><button class="action" id="start">Start</button><button class="action" id="stop" disabled>Stop</button></div>
                    <div class="status" id="status">Ready</div>
                </div>
            </section>
            <footer class="footer">&copy; 2026 Theis N. Jensen &middot; <a href="https://github.com/thei1575/auto-clicker-party" target="_blank" rel="noopener noreferrer">GitHub</a></footer>
        </section>`;

    const ui = Object.fromEntries([
        'panel', 'hide', 'minimize', 'drag-handle', 'header-id', 'mode-screen', 'control-screen', 'choose-local', 'choose-host', 'choose-join',
        'join-form', 'join-code', 'connect-join', 'mode-status', 'back', 'mode-label',
        'host-card', 'party-code', 'copy-code', 'end-room', 'party-status', 'host-id',
        'member-card', 'member-summary', 'party-progress', 'member-list',
        'join-card', 'client-id', 'join-room-code', 'join-connection',
        'target', 'selection-controls', 'select', 'control-settings', 'delay',
        'randomization', 'count', 'timing-mode', 'delay-field', 'randomization-field', 'rate-hint',
        'run-buttons', 'start', 'stop', 'status'
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

    function humanTimingSelected() {
        return ui.timingMode.value === 'human';
    }

    // Human mode ignores the delay boxes and reports its calibrated pace instead, so the two
    // stay untouched in storage and come back as they were when manual timing is picked again.
    function getSettings() {
        const humanize = humanTimingSelected();
        return {
            delay: humanize ? HUMAN_BASE_DELAY_MS : Number(ui.delay.value),
            randomization: humanize ? HUMAN_RANDOMIZATION_MS : Number(ui.randomization.value),
            count: Number(ui.count.value),
            humanize
        };
    }

    function saveSettings() {
        GM_setValue(SETTINGS_KEY, {
            delay: Number(ui.delay.value),
            randomization: Number(ui.randomization.value),
            count: Number(ui.count.value),
            humanize: humanTimingSelected()
        });
    }

    function loadSettings() {
        const settings = GM_getValue(SETTINGS_KEY, null);
        ui.delay.value = Number.isFinite(settings?.delay) ? settings.delay : 1000;
        ui.randomization.value = Number.isFinite(settings?.randomization) ? settings.randomization : 0;
        ui.count.value = Number.isFinite(settings?.count) ? settings.count : 10;
        // A first install starts on the calibrated timing; an existing one keeps its own choice.
        ui.timingMode.value = (settings ? settings.humanize === true : true) ? 'human' : 'manual';
        updateTimingFields();
    }

    function updateTimingFields() {
        const humanize = humanTimingSelected();
        ui.delayField.hidden = humanize;
        ui.randomizationField.hidden = humanize;
        updateRateHint();
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
        updateIdentityDisplay();
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
        ui.runButtons.hidden = isJoin;
        ui.partyProgress.hidden = !isHost;
        if (isJoin) startJoinedTargetTracking();
        else stopJoinedTargetTracking();
        updateIdentityDisplay();
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
        ui.timingMode.disabled = running || joined;
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
        if (session.origin !== location.origin) return null;
        if (Number.isFinite(session.savedAt) && Date.now() - session.savedAt > PARTY_SESSION_TTL_MS) return null;
        return session;
    }

    function savePartySession(role, roomCode) {
        const previous = GM_getValue(PARTY_SESSION_KEY, null);
        const keptSelector = previous?.roomCode === roomCode ? previous.targetSelector : '';
        GM_setValue(PARTY_SESSION_KEY, {
            role,
            roomCode,
            origin: location.origin,
            browserId: getBrowserId(),
            targetSelector: targetSelector || keptSelector || '',
            savedAt: Date.now()
        });
    }

    function restoreHostTargetFromSession() {
        const session = getSavedPartySession();
        if (session?.role !== 'host' || typeof session.targetSelector !== 'string' || !session.targetSelector) return;
        targetSelector = session.targetSelector;
        target = null;
        if (resolveTarget()) {
            setTargetDisplay(target);
            setStatus('Room target restored.');
            syncHostConfig();
        } else {
            clearTargetDisplay();
            setStatus('The saved target is not on this page. Select a button.', 'error');
        }
    }

    function clearSavedPartySession() {
        GM_setValue(PARTY_SESSION_KEY, null);
    }

    function currentBrowserLabel() {
        return clientDisplayId || getBrowserId();
    }

    // The browser ID identifies this panel in every host dashboard, so it stays on screen
    // in the title bar as well - the panel is usually minimized on joined browsers.
    function updateIdentityDisplay() {
        const label = currentBrowserLabel();
        ui.hostId.textContent = label;
        ui.clientId.textContent = label;
        ui.joinRoomCode.textContent = partyCode || '\u2014';
        if (mode !== 'host' && mode !== 'join') {
            ui.headerId.hidden = true;
            return;
        }
        const isHost = mode === 'host';
        ui.headerId.hidden = false;
        ui.headerId.className = `header-id ${isHost ? 'host' : 'client'}`;
        ui.headerId.textContent = label;
        ui.headerId.title = `${isHost ? 'Host' : 'Client'} browser ID ${label}${partyCode ? ` \u00b7 party ${partyCode}` : ''}`;
    }

    function setPartyConnectionStatus(message, type = '') {
        for (const element of [ui.partyStatus, ui.joinConnection]) {
            element.textContent = message;
            element.className = `party-status ${type}`.trim();
        }
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
        stopJoinedTargetTracking();
        memberStats.clear();
        clientDisplayId = '';
        partyRestoreDeadline = 0;
        hostStateApplied = false;
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
        if (planTooNew(plan)) return;
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
        const run = { seed: seed[0], planVersion: RUN_PLAN_VERSION };
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

    function connectToParty(role, roomCode, restoring = false) {
        partyCode = roomCode;
        mode = role;
        clientDisplayId = '';
        partyRestoreDeadline = restoring ? Date.now() + PARTY_RESTORE_WINDOW_MS : 0;
        savePartySession(role, roomCode);
        showControlScreen();
        ui.partyCode.textContent = roomCode;
        setPartyConnectionStatus(restoring ? 'Restoring saved session…' : 'Connecting…');
        if (role === 'join') setStatus(restoring ? 'Restoring saved session…' : 'Connecting to host…');
        startHttpParty(role, roomCode);
    }

    function connectionFailed(message) {
        disconnectParty();
        setStatus(message, 'error');
        showModeScreen();
        setModeStatus(message, 'error');
    }

    function schedulePartyReconnect(role = mode, roomCode = partyCode, statusMessage = null) {
        if (reconnectTimer !== null || !role || !roomCode) return;
        const previousSession = httpParty;
        if (previousSession) previousSession.closed = true;
        httpParty = null;
        partyRole = null;
        lastPartyRevision = 0;
        hostStateApplied = false;
        clockSynced = false;
        if (clockSyncTimer !== null) clearInterval(clockSyncTimer);
        clockSyncTimer = null;
        if (mode === 'join') stopClicking('Connection lost. Reconnecting…');
        updateControls();
        const delay = Math.min(10_000, 1_000 * (2 ** Math.min(reconnectAttempt, 4)));
        reconnectAttempt++;
        setPartyConnectionStatus(statusMessage || `Connection lost. Reconnecting in ${Math.round(delay / 1_000)}s (attempt ${reconnectAttempt})…`, 'warn');
        if (role === 'join' && !statusMessage) setStatus('Connection lost. Reconnecting…', 'error');
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
                        error.body = response.responseText || '';
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
        if (partyRole === 'host') {
            setPartyConnectionStatus(memberStats.size
                ? `Synchronized · ${memberStats.size} browser${memberStats.size === 1 ? '' : 's'} joined.`
                : 'Synchronized. Waiting for browsers to join.', 'ok');
            renderMemberStats();
        } else if (partyRole === 'join') {
            setPartyConnectionStatus('Connected · clock synchronized with the host.', 'ok');
        }
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
        if (reconnecting) setPartyConnectionStatus('Reconnecting…', 'warn');
        else setPartyConnectionStatus('Connecting…');
        if (role === 'join' && !reconnecting) setStatus('Connecting to host…');
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
        } catch (error) {
            const missingRoom = /no active party/i.test(error?.body || '');
            if (/already in use/i.test(error?.body || '')) {
                connectionFailed('Another browser is already hosting that party code.');
                return;
            }
            // A restored or dropped session keeps its party code and retries: the relay may be
            // restarting, or the host may still be reloading its own page. Rejoining by hand
            // is only required once that window has passed.
            if (Date.now() < partyRestoreDeadline) {
                schedulePartyReconnect(role, roomCode, missingRoom
                    ? 'Party is not open yet. Waiting for the host…'
                    : 'Party server unreachable. Retrying…');
                if (role === 'join') setStatus(missingRoom ? 'Waiting for the host to reopen the party…' : 'Reconnecting…');
                return;
            }
            if (missingRoom) {
                connectionFailed(reconnecting ? 'That party is no longer open.' : 'No active party has that code.');
                return;
            }
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
                const messages = result.messages || [];
                for (const message of messages) handlePartyMessage(session, JSON.stringify(message));
                applyPartyState(result.state);
                if (messages.length === 0) await new Promise(resolve => setTimeout(resolve, IDLE_POLL_INTERVAL_MS));
            } catch (error) {
                if (httpParty === session && !session.closed) {
                    if (error.status === 401) {
                        schedulePartyReconnect(mode, partyCode);
                        break;
                    }
                    setPartyConnectionStatus('Connection interrupted. Retrying…', 'warn');
                    await new Promise(resolve => setTimeout(resolve, 1_000));
                }
            }
        }
    }

    const SHORT_MEMBER_STATES = {
        'Waiting for host': 'Awaiting host',
        'Waiting for target': 'Awaiting target',
        'Target not found': 'No target',
        'Invalid host settings': 'Bad settings',
        'Stopped by host': 'Stopped'
    };

    function memberTone(state, connected) {
        if (!connected) return 'warn';
        const text = String(state || '');
        if (/not found|invalid|failed/i.test(text)) return 'error';
        if (/^running/i.test(text)) return 'running';
        if (/reconnect|waiting|joining/i.test(text)) return 'warn';
        if (/^ready|^finished|^stopped/i.test(text)) return 'ready';
        return '';
    }

    function addMemberRow(id, stats) {
        const connected = stats.connected !== false;
        const label = stats.browserId || `Session ${id}`;
        const state = connected ? (stats.state || 'Ready') : 'Reconnecting…';
        const row = document.createElement('div');
        row.className = `member${connected ? '' : ' offline'}`;
        row.title = `${label} · ${state}`;

        const head = document.createElement('div');
        head.className = 'member-head';
        const dot = document.createElement('span');
        dot.className = `dot ${memberTone(state, connected)}`.trim();
        const name = document.createElement('span');
        name.className = 'member-id';
        name.textContent = label;
        const clock = document.createElement('span');
        clock.className = 'member-clock';
        clock.textContent = Number.isFinite(stats.timeDiffMs)
            ? `${stats.timeDiffMs >= 0 ? '+' : ''}${Math.round(stats.timeDiffMs)}ms`
            : '—';
        head.append(dot, name, clock);

        const line = document.createElement('div');
        line.className = 'member-line';
        const stateText = document.createElement('span');
        stateText.className = 'member-state';
        stateText.textContent = SHORT_MEMBER_STATES[state] || state;
        const numbers = document.createElement('span');
        numbers.className = 'member-nums';
        numbers.textContent = `${stats.clicks}/${stats.total === null ? '∞' : stats.total} · ${(stats.rate || 0).toFixed(1)}/s`;
        line.append(stateText, numbers);

        row.append(head, line);
        ui.memberList.appendChild(row);
    }

    function renderMemberStats() {
        const members = Array.from(memberStats.values());
        const offline = members.filter(stats => stats.connected === false).length;
        const running = members.filter(stats => stats.connected !== false && /^running/i.test(stats.state || '')).length;
        const summary = [`${members.length} joined`];
        if (running) summary.push(`${running} running`);
        if (offline) summary.push(`${offline} reconnecting`);
        ui.memberSummary.textContent = summary.join(' · ');
        ui.memberSummary.className = `party-status${offline ? ' warn' : ''}`;

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
        for (const [id, stats] of memberStats) addMemberRow(id, stats);
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
            clientDisplayId = message.browserId || '';
            reconnectAttempt = 0;
            savePartySession(partyRole, partyCode);
            // Refresh the grace window on every successful connect so a later drop also gets
            // a full retry budget before the saved room code is discarded.
            partyRestoreDeadline = Date.now() + PARTY_RESTORE_WINDOW_MS;
            updateIdentityDisplay();
            if (partyRole === 'host') {
                ui.partyCode.textContent = partyCode;
                setPartyConnectionStatus('Connected. Waiting for browsers to join.', 'ok');
                renderMemberStats();
            } else {
                setPartyConnectionStatus('Connected to the party. Waiting for the host…', 'ok');
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
                connected: message.connected !== false,
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
                const reconnecting = message.type === 'member-reconnecting';
                previous.connected = !reconnecting;
                previous.state = reconnecting ? 'Reconnecting…' : (message.status?.state || 'Ready');
                previous.updatedAt = Date.now();
                memberStats.set(message.memberId, previous);
                renderMemberStats();
            }
            return;
        }
        if (message.type === 'host-reconnecting' && partyRole === 'join') {
            setPartyConnectionStatus('The host is reconnecting…', 'warn');
            setStatus('Host reconnecting…', 'running');
            return;
        }
        if (message.type === 'host-reconnected' && partyRole === 'join') {
            setPartyConnectionStatus('Host reconnected · synchronized.', 'ok');
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
                connected: true,
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
            partySessionRunning = Boolean(state.running || Number.isFinite(state.scheduledStartAt));
            // The host owns the config, so it only pulls the room snapshot once per connection
            // to restore a reloaded room. Re-applying it on every poll would overwrite the
            // host's own status text and re-resolve the target several times a second.
            if (!hostStateApplied) {
                hostStateApplied = true;
                if (state.config) applyPartyConfig(state.config);
                else restoreHostTargetFromSession();
                if (state.running) setStatus('Room restored. Joined browsers are still running.', 'running');
                else if (Number.isFinite(state.scheduledStartAt)) setStatus('Room restored. A synchronized start is scheduled.', 'running');
                if (state.running || Number.isFinite(state.scheduledStartAt)) setPartyConnectionStatus('Room restored · party still active.', 'ok');
            }
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
        if (settings.humanize !== undefined && typeof settings.humanize !== 'boolean') return;
        ui.timingMode.value = settings.humanize === true ? 'human' : 'manual';
        // Human timing is the host's calibrated pace, so it never overwrites the local boxes.
        if (!settings.humanize) {
            ui.delay.value = settings.delay;
            ui.randomization.value = settings.randomization;
        }
        ui.count.value = settings.count;
        updateTimingFields();
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
        const tag = element.tagName.toLowerCase();
        const name = tag === 'input' ? `input[${element.type || 'text'}]` : tag;
        // A checkbox's value is the useless literal "on", so name it by its label instead.
        const toggle = tag === 'input' && (element.type === 'checkbox' || element.type === 'radio');
        const text = (element.innerText || (toggle ? '' : element.value) || element.getAttribute('aria-label') ||
            element.labels?.[0]?.innerText || element.title || '').replace(/\s+/g, ' ').trim();
        return text ? `${name}: ${text.slice(0, 55)}` : name;
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
        if (mode !== 'join' || !element?.isConnected) return hideJoinedTargetMarker();
        const rect = element.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return hideJoinedTargetMarker();
        // Clamping an off-screen target to zero used to park the ring in the top-left corner,
        // drawing it around whatever happened to be there.
        if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) {
            return hideJoinedTargetMarker();
        }
        const padding = 7;
        const inset = 2;
        const width = rect.width + padding * 2;
        const height = rect.height + padding * 2;
        joinedTargetMarker.style.display = 'block';
        joinedTargetMarker.style.left = `${rect.left - padding}px`;
        joinedTargetMarker.style.top = `${rect.top - padding}px`;
        joinedTargetMarker.style.width = `${width}px`;
        joinedTargetMarker.style.height = `${height}px`;
        joinedTargetMarker.setAttribute('viewBox', `0 0 ${width} ${height}`);
        for (const ring of [markerTrack, markerChase]) {
            ring.setAttribute('x', inset);
            ring.setAttribute('y', inset);
            ring.setAttribute('width', Math.max(0, width - inset * 2));
            ring.setAttribute('height', Math.max(0, height - inset * 2));
            ring.setAttribute('rx', Math.min(width, height) / 2);
        }
    }

    function hideJoinedTargetMarker() {
        joinedTargetMarker.style.display = 'none';
    }

    function refreshJoinedTargetMarker() {
        if (mode === 'join' && target?.isConnected) showJoinedTargetMarker(target);
        else hideJoinedTargetMarker();
    }

    // Scroll and resize are not the only ways a button moves: fonts finish loading, images
    // reflow, a framework re-renders the element entirely. Following it on a frame timer means
    // the ring is correct without waiting for the guest to touch anything.
    function trackJoinedTargetMarker(timestamp) {
        markerFrame = requestAnimationFrame(trackJoinedTargetMarker);
        if (mode !== 'join') return stopJoinedTargetTracking();
        if (timestamp - markerCheckedAt < MARKER_TRACK_INTERVAL_MS) return;
        markerCheckedAt = timestamp;
        const element = target?.isConnected ? target : resolveTarget();
        if (!element) {
            markerRectKey = '';
            hideJoinedTargetMarker();
            return;
        }
        const rect = element.getBoundingClientRect();
        const key = `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`;
        if (key === markerRectKey) return;
        markerRectKey = key;
        showJoinedTargetMarker(element);
    }

    function startJoinedTargetTracking() {
        if (markerFrame !== null || mode !== 'join') return;
        markerRectKey = '';
        markerCheckedAt = -Infinity;
        markerFrame = requestAnimationFrame(trackJoinedTargetMarker);
    }

    function stopJoinedTargetTracking() {
        if (markerFrame !== null) cancelAnimationFrame(markerFrame);
        markerFrame = null;
        markerRectKey = '';
        hideJoinedTargetMarker();
    }

    function isDisabledElement(element) {
        return element.disabled === true || element.getAttribute('aria-disabled') === 'true';
    }

    function canReceiveClicks(element, style) {
        if (element.getClientRects().length === 0) return false;
        return style.visibility !== 'hidden' && style.pointerEvents !== 'none';
    }

    function isInteractiveElement(element) {
        if (element.nodeType !== Node.ELEMENT_NODE || isDisabledElement(element)) return false;
        const style = window.getComputedStyle(element);
        if (!canReceiveClicks(element, style)) return false;
        try {
            if (element.matches(INTERACTIVE_SELECTOR)) return true;
        } catch (_) { /* fall through to the focusability check */ }
        const tabIndex = element.getAttribute('tabindex');
        return tabIndex !== null && Number(tabIndex) >= 0;
    }

    // Pages routinely attach their click handler with addEventListener, which the DOM cannot
    // report. A pointer cursor is the reliable signal for those. Because `cursor` is inherited,
    // the outermost element of a pointer region is the one that usually carries the handler.
    function findPointerCursorRoot(element) {
        if (element.nodeType !== Node.ELEMENT_NODE) return null;
        const style = window.getComputedStyle(element);
        if (style.cursor !== 'pointer' || !canReceiveClicks(element, style)) return null;
        let node = element;
        for (let depth = 0; depth < MAX_CLICKABLE_DEPTH; depth++) {
            const parent = node.parentElement;
            if (!parent || parent === document.body || parent === document.documentElement) break;
            if (window.getComputedStyle(parent).cursor !== 'pointer') break;
            node = parent;
        }
        return isDisabledElement(node) ? null : node;
    }

    // Resolves what a real click would actually activate: the innermost interactive ancestor,
    // so hovering the label inside a button still selects the button itself.
    function findClickableTarget(element) {
        let node = element;
        for (let depth = 0; node && depth < MAX_CLICKABLE_DEPTH; depth++) {
            if (node === document.body || node === document.documentElement || host.contains(node)) break;
            if (isInteractiveElement(node)) return node;
            node = node.parentElement;
        }
        return findPointerCursorRoot(element);
    }

    function clearHover() {
        if (hoveredElement) {
            hoveredElement.removeAttribute(HOVER_ATTRIBUTE);
            hoveredElement.removeAttribute(REJECTED_ATTRIBUTE);
        }
        hoveredElement = null;
    }

    function handleHover(event) {
        if (!selecting || host.contains(event.target)) return;
        clearHover();
        const clickable = findClickableTarget(event.target);
        hoveredElement = clickable || event.target;
        hoveredElement.setAttribute(clickable ? HOVER_ATTRIBUTE : REJECTED_ATTRIBUTE, '');
        if (clickable) setStatus(`Click to select ${describeElement(clickable)}`);
        else setStatus('Not clickable — hover a button, link, or control.', 'error');
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
        // Alt is the escape hatch for a handler no heuristic can see.
        const clickable = event.altKey ? event.target : findClickableTarget(event.target);
        if (!clickable) {
            setStatus('That is not clickable. Pick a button, link, or control — hold Alt to select it anyway.', 'error');
            return;
        }
        clearHover();
        if (target) target.removeAttribute(TARGET_ATTRIBUTE);
        target = clickable;
        targetSelector = createSelector(target);
        target.setAttribute(TARGET_ATTRIBUTE, '');
        setTargetDisplay(target);
        endSelection(event.altKey ? 'Target forced with Alt' : 'Button selected');
        syncHostConfig();
        if (partyRole) savePartySession(partyRole, partyCode);
    }

    function beginSelection() {
        stopClicking('Stopped for a new selection');
        selecting = true;
        ui.select.textContent = 'Click a button… (Esc to cancel)';
        ui.select.classList.add('selecting');
        setStatus('Hover a clickable element and click it');
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

    // A run plan this script cannot reproduce is refused outright rather than clicked to a
    // schedule of its own.
    function planTooNew(plan) {
        if (!plan || !Number.isFinite(plan.planVersion) || plan.planVersion <= RUN_PLAN_VERSION) return false;
        cancelCountdown();
        updateControls();
        setStatus('The host runs a newer version of this script. Update the userscript.', 'error');
        reportGuest('Update required');
        return true;
    }

    // FNV-1a over the browser ID, mixed into the shared seed.
    function mixSeed(seed, text) {
        let hash = 0x811c9dc5;
        for (let index = 0; index < text.length; index++) {
            hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
        }
        // xorshift32 is stuck on zero, so never hand it a zero state.
        return ((seed ^ hash) >>> 0) || 0x6d2b79f5;
    }

    function localSeed() {
        const values = new Uint32Array(1);
        crypto.getRandomValues(values);
        return values[0] || 0x6d2b79f5;
    }

    function nextBurstLength() {
        return HUMAN_BURST_MIN + Math.floor(-Math.log(Math.max(1e-9, nextRandomFraction())) * HUMAN_BURST_SCALE);
    }

    function resetHumanState() {
        // Open with a full burst: a run should start by clicking, not by resting.
        humanState = { logTempo: 0, burstLeft: 0, clicks: 0 };
        humanState.burstLeft = nextBurstLength();
    }

    function nextRandomFraction() {
        syncedRandomState ^= syncedRandomState << 13;
        syncedRandomState ^= syncedRandomState >>> 17;
        syncedRandomState ^= syncedRandomState << 5;
        return (syncedRandomState >>> 0) / 0x100000000;
    }

    // Box-Muller, drawn from the same seeded stream so a run stays reproducible.
    function nextRandomNormal() {
        const uniform = Math.max(1e-9, nextRandomFraction());
        return Math.sqrt(-2 * Math.log(uniform)) * Math.cos(2 * Math.PI * nextRandomFraction());
    }

    function expectedRestMs() {
        return (1 - HUMAN_LONG_REST_CHANCE) * HUMAN_REST_MEDIAN_MS * Math.exp(HUMAN_REST_SIGMA ** 2 / 2) +
            HUMAN_LONG_REST_CHANCE * HUMAN_LONG_REST_MEDIAN_MS * Math.exp(HUMAN_LONG_REST_SIGMA ** 2 / 2);
    }

    // Pauses and the right-skewed tail both cost time. Compressing the in-burst pace to pay for
    // them keeps the base delay meaning one thing in both modes: the sustained rate. A person
    // clicking 7 a second in bursts is going faster than that while the burst lasts.
    function humanPaceDelay(base, sigma) {
        const burst = HUMAN_BURST_MIN + HUMAN_BURST_SCALE;
        const inflation = Math.exp((sigma ** 2 + HUMAN_TEMPO_VARIANCE) / 2);
        return Math.max(MIN_DELAY, (burst * base - expectedRestMs()) / ((burst - 1) * inflation + 1));
    }

    function humanSigma(base, spread) {
        return Math.max(HUMAN_MIN_SIGMA, (Number.isFinite(spread) ? spread : 0) / base);
    }

    function getUniformDelay(base, spread) {
        const minimum = Math.max(MIN_DELAY, base - spread);
        const maximum = Math.max(minimum, base + spread);
        return Math.round(minimum + nextRandomFraction() * (maximum - minimum));
    }

    // Three things separate a person from a flat interval: the gaps are right-skewed rather
    // than symmetric, the tempo wanders over seconds instead of resetting every click, and
    // clicking comes in bouts that stop to refocus.
    function getHumanDelay(base, spread) {
        if (!humanState) resetHumanState();
        const state = humanState;
        const sigma = humanSigma(base, spread);
        const paced = humanPaceDelay(base, sigma);
        state.logTempo = state.logTempo * HUMAN_TEMPO_DECAY + nextRandomNormal() * HUMAN_TEMPO_STEP;
        const fatigue = 1 + Math.min(HUMAN_FATIGUE_MAX, state.clicks / HUMAN_FATIGUE_CLICKS);
        state.clicks++;
        if (state.burstLeft <= 0) {
            state.burstLeft = nextBurstLength();
            const longRest = nextRandomFraction() < HUMAN_LONG_REST_CHANCE;
            const rest = (longRest ? HUMAN_LONG_REST_MEDIAN_MS : HUMAN_REST_MEDIAN_MS) *
                Math.exp(nextRandomNormal() * (longRest ? HUMAN_LONG_REST_SIGMA : HUMAN_REST_SIGMA));
            return Math.round(Math.max(MIN_DELAY, paced * fatigue + rest));
        }
        state.burstLeft--;
        return Math.round(Math.max(MIN_DELAY, paced * Math.exp(nextRandomNormal() * sigma + state.logTempo) * fatigue));
    }

    function getRandomDelay() {
        const { delay, randomization, humanize } = getSettings();
        return humanize ? getHumanDelay(delay, randomization) : getUniformDelay(delay, randomization);
    }

    // Fatigue ramps to its cap over the first few hundred clicks, so a short run barely feels
    // it while a long one settles at the cap.
    function averageFatigue(clicks) {
        const rampClicks = HUMAN_FATIGUE_MAX * HUMAN_FATIGUE_CLICKS;
        if (clicks > 0 && clicks <= rampClicks) return 1 + clicks / (2 * HUMAN_FATIGUE_CLICKS);
        return 1 + HUMAN_FATIGUE_MAX - (clicks > 0 ? rampClicks * HUMAN_FATIGUE_MAX / (2 * clicks) : 0);
    }

    // Returns the sustained rate, and the rate a burst reaches while the tempo runs fast.
    function estimateClicksPerSecond() {
        const { delay, randomization, count, humanize } = getSettings();
        if (!Number.isFinite(delay) || delay < MIN_DELAY) return null;
        if (!humanize) return { sustained: 1_000 / delay, peak: null };
        const sigma = humanSigma(delay, randomization);
        const burst = HUMAN_BURST_MIN + HUMAN_BURST_SCALE;
        const finite = Number.isInteger(count) && count > 0;
        const paced = humanPaceDelay(delay, sigma) * averageFatigue(finite ? count : 0);
        const inBurst = paced * Math.exp((sigma ** 2 + HUMAN_TEMPO_VARIANCE) / 2);
        // A short run may finish inside its first burst and never pause at all.
        const clicks = finite ? count : burst;
        const rests = finite ? Math.max(0, count - HUMAN_BURST_MIN) / burst : 1;
        const cycle = clicks * inBurst + rests * (paced + expectedRestMs() - inBurst);
        return {
            sustained: clicks * 1_000 / cycle,
            peak: 1_000 / (paced * Math.exp(sigma ** 2 / 2 - HUMAN_PEAK_SIGMAS * Math.sqrt(HUMAN_TEMPO_VARIANCE)))
        };
    }

    function updateRateHint() {
        const rate = estimateClicksPerSecond();
        const show = value => value < 10 ? value.toFixed(1) : String(Math.round(value));
        if (!rate) {
            ui.rateHint.textContent = humanTimingSelected() ? 'Bursts and pauses' : 'Even rhythm';
            return;
        }
        ui.rateHint.textContent = humanTimingSelected()
            ? `Bursts and pauses \u00b7 \u2248${show(rate.sustained)}/s, sprints to \u2248${show(rate.peak)}/s`
            : `Even rhythm \u00b7 \u2248${show(rate.sustained)} clicks/s`;
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
        if (planTooNew(synchronizedPlan)) return;
        cancelCountdown();
        const validationError = validateSettings();
        if (validationError) { setStatus(validationError, 'error'); if (mode === 'join') reportGuest('Invalid host settings'); return; }
        if (!resolveTarget()) { setStatus(mode === 'join' ? 'Host target not found on this page.' : 'Select a button first', 'error'); if (mode === 'join') reportGuest('Target not found'); return; }
        saveSettings();
        clicksCompleted = 0;
        clicksPlanned = Number(ui.count.value);
        runPlan = synchronizedPlan && Number.isInteger(synchronizedPlan.seed) && Number.isFinite(synchronizedPlan.startAt) ? synchronizedPlan : null;
        // Each browser mixes its own ID into the shared seed: the party still starts on one
        // absolute millisecond, then every browser follows its own rhythm instead of pausing
        // and resuming in lockstep, which would itself look coordinated.
        syncedRandomState = runPlan ? mixSeed(runPlan.seed, getBrowserId()) : localSeed();
        resetHumanState();
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
        const resuming = savedSession?.role === 'host';
        connectToParty('host', resuming ? savedSession.roomCode : generatePartyCode(), resuming);
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
    [ui.delay, ui.randomization, ui.count, ui.timingMode].forEach(element => element.addEventListener('change', () => {
        updateTimingFields();
        saveSettings();
        syncHostConfig();
    }));
    [ui.delay, ui.randomization].forEach(element => element.addEventListener('input', updateRateHint));
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
        setTimeout(() => connectToParty(savedPartySession.role, savedPartySession.roomCode, true), 0);
    }
})();
