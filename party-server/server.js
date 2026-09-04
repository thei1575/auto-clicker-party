import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const port = Number(process.env.PORT || 8080);
const rooms = new Map();
const clientInfo = new Map();
const httpClients = new Map();
const roomCodePattern = /^[A-Z2-9]{6,16}$/;
const browserIdPattern = /^B-[A-Z2-9]{6}$/;
const MAX_MESSAGE_SIZE = 8 * 1024;
// Tampermonkey's request bridge is more reliable with frequent poll completion.
// Commands are still delivered immediately when a poll is held open.
const LONG_POLL_MS = 2_000;
const HTTP_CLIENT_TTL_MS = 70_000;
const MEMBER_STATUS_FLUSH_MS = 1_000;
const RECONNECT_GRACE_MS = 5 * 60_000;
let nextMemberId = 1;
let acceptedConnectionsTotal = 0;
let metricsScrapesTotal = 0;
const commandTotals = { config: 0, start: 0, stop: 0, countdown: 0 };

function writeJson(response, status, payload) {
    response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
    });
    response.end(payload === undefined ? '' : JSON.stringify(payload));
}

function writeMetrics(response) {
    metricsScrapesTotal++;
    let connectedClients = 0;
    let joinedClients = 0;
    let scheduledStarts = 0;
    for (const room of rooms.values()) {
        connectedClients += room.clients.size;
        joinedClients += room.members.size;
        if (room.state.scheduledStartAt) scheduledStarts++;
    }
    const lines = [
        '# HELP auto_clicker_party_rooms Active party rooms.',
        '# TYPE auto_clicker_party_rooms gauge',
        `auto_clicker_party_rooms ${rooms.size}`,
        '# HELP auto_clicker_party_connected_clients Connected host and joined clients.',
        '# TYPE auto_clicker_party_connected_clients gauge',
        `auto_clicker_party_connected_clients ${connectedClients}`,
        '# HELP auto_clicker_party_joined_clients Connected non-host clients.',
        '# TYPE auto_clicker_party_joined_clients gauge',
        `auto_clicker_party_joined_clients ${joinedClients}`,
        '# HELP auto_clicker_party_scheduled_starts Party countdowns waiting to start.',
        '# TYPE auto_clicker_party_scheduled_starts gauge',
        `auto_clicker_party_scheduled_starts ${scheduledStarts}`,
        '# HELP auto_clicker_party_connections_total Accepted party connections since service start.',
        '# TYPE auto_clicker_party_connections_total counter',
        `auto_clicker_party_connections_total ${acceptedConnectionsTotal}`,
        '# HELP auto_clicker_party_commands_total Host commands received since service start.',
        '# TYPE auto_clicker_party_commands_total counter',
        ...Object.entries(commandTotals).map(([command, total]) => `auto_clicker_party_commands_total{command="${command}"} ${total}`),
        '# HELP auto_clicker_party_metrics_scrapes_total Prometheus metrics endpoint scrapes.',
        '# TYPE auto_clicker_party_metrics_scrapes_total counter',
        `auto_clicker_party_metrics_scrapes_total ${metricsScrapesTotal}`
    ];
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`${lines.join('\n')}\n`);
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => {
            body += chunk;
            if (body.length > MAX_MESSAGE_SIZE) {
                reject(new Error('Request body is too large.'));
                request.destroy();
            }
        });
        request.on('end', () => {
            try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON message.')); }
        });
        request.on('error', reject);
    });
}

function send(client, message) {
    if (client.kind === 'http') {
        if (client.waiting) {
            const response = client.waiting;
            client.waiting = null;
            clearTimeout(client.waitTimer);
            client.waitTimer = null;
            writeJson(response, 200, { messages: [message], state: partyState(client) });
        } else {
            client.queue.push(message);
        }
        return;
    }
    if (client.readyState === WebSocket.OPEN) {
        try { client.send(JSON.stringify(message)); } catch { /* A concurrently closed socket needs no further action. */ }
    }
}

function partyState(client) {
    const info = clientInfo.get(client);
    const room = info && rooms.get(info.roomCode);
    return room ? room.state : null;
}

function broadcast(room, message, except = null) {
    for (const client of room.clients) if (client !== except) send(client, message);
}

function closeHttpWait(client) {
    if (!client?.waiting) return;
    const response = client.waiting;
    client.waiting = null;
    clearTimeout(client.waitTimer);
    client.waitTimer = null;
    writeJson(response, 204);
}

function endRoom(room, message = 'The host disconnected. This party has ended.') {
    clearTimeout(room.countdownTimer);
    clearTimeout(room.memberStatusFlushTimer);
    clearTimeout(room.hostReconnectTimer);
    for (const member of room.membersById.values()) clearTimeout(member.reconnectTimer);
    broadcast(room, { type: 'party-ended', message });
    for (const connectedClient of room.clients) {
        clientInfo.delete(connectedClient);
        if (connectedClient.kind === 'http') {
            httpClients.delete(connectedClient.token);
            closeHttpWait(connectedClient);
        } else {
            connectedClient.close(4001, 'Host disconnected');
        }
    }
    rooms.delete(room.code);
}

function suspendClient(client) {
    const info = clientInfo.get(client);
    if (!info?.roomCode) return;

    const room = rooms.get(info.roomCode);
    if (!room) return;

    room.clients.delete(client);
    if (room.host === client) {
        room.host = null;
        broadcast(room, { type: 'host-reconnecting' });
        clearTimeout(room.hostReconnectTimer);
        room.hostReconnectTimer = setTimeout(() => {
            if (!room.host && rooms.get(room.code) === room) endRoom(room, 'The host did not reconnect. This party has ended.');
        }, RECONNECT_GRACE_MS);
    } else {
        room.members.delete(client);
        const member = room.membersById.get(info.memberId);
        if (member) {
            member.client = null;
            clearTimeout(member.reconnectTimer);
            member.reconnectTimer = setTimeout(() => {
                if (member.client || rooms.get(room.code) !== room) return;
                room.membersById.delete(member.memberId);
                room.membersByBrowserId.delete(member.browserId);
                room.pendingMemberStatuses.delete(member.memberId);
                if (room.host) send(room.host, { type: 'member-left', memberId: member.memberId });
            }, RECONNECT_GRACE_MS);
        }
        if (room.host) send(room.host, { type: 'member-reconnecting', memberId: info.memberId });
    }
    clientInfo.delete(client);
}

function removeFromRoom(client) {
    const info = clientInfo.get(client);
    if (!info?.roomCode) return;
    const room = rooms.get(info.roomCode);
    if (!room) return;
    room.clients.delete(client);
    clientInfo.delete(client);
    if (room.host === client) return endRoom(room);
    room.members.delete(client);
    const member = room.membersById.get(info.memberId);
    if (member) {
        clearTimeout(member.reconnectTimer);
        room.membersById.delete(member.memberId);
        room.membersByBrowserId.delete(member.browserId);
    }
    room.pendingMemberStatuses.delete(info.memberId);
    if (room.host) send(room.host, { type: 'member-left', memberId: info.memberId });
}

function flushMemberStatuses(room) {
    room.memberStatusFlushTimer = null;
    if (!room.host || room.pendingMemberStatuses.size === 0) return;
    for (const [memberId, status] of room.pendingMemberStatuses) {
        send(room.host, { type: 'member-status', memberId, ...status });
    }
    room.pendingMemberStatuses.clear();
}

function queueMemberStatus(room, memberId, message) {
    const status = {
        state: message.state,
        clicks: message.clicks,
        total: message.total,
        clockOffsetMs: message.clockOffsetMs
    };
    room.pendingMemberStatuses.set(memberId, status);
    const member = room.membersById.get(memberId);
    if (member) member.status = status;
    if (room.memberStatusFlushTimer === null) {
        room.memberStatusFlushTimer = setTimeout(() => flushMemberStatuses(room), MEMBER_STATUS_FLUSH_MS);
    }
}

function validConfig(message) {
    if (!message.settings) return false;
    const { delay, randomization, count } = message.settings;
    return Number.isFinite(delay) && delay >= 20 &&
        Number.isFinite(randomization) && randomization >= 0 &&
        Number.isInteger(count) && count >= 0 &&
        typeof message.targetSelector === 'string' && message.targetSelector.length <= 2048;
}

function validRun(run) {
    return run && Number.isInteger(run.seed) && run.seed >= 0 && run.seed <= 0xFFFFFFFF;
}

function validCommand(message) {
    if (message.type !== 'command') return false;
    if (message.command === 'stop') return true;
    if (message.command === 'config') return validConfig(message);
    if (message.command === 'start') return !message.settings || validConfig(message);
    return message.command === 'countdown' && validConfig(message) && validRun(message.run) &&
        Number.isInteger(message.delayMs) && message.delayMs >= 1_000 && message.delayMs <= 60_000;
}

function validMemberStatus(message) {
    return message.type === 'client-status' &&
        typeof message.state === 'string' && message.state.length <= 80 &&
        Number.isInteger(message.clicks) && message.clicks >= 0 &&
        (message.total === null || (Number.isInteger(message.total) && message.total >= 0)) &&
        Number.isFinite(message.clockOffsetMs) && Math.abs(message.clockOffsetMs) <= 300_000;
}

function supersedeClient(client) {
    if (!client) return;
    suspendClient(client);
    if (client.kind === 'http') {
        httpClients.delete(client.token);
        closeHttpWait(client);
    } else {
        client.close(4002, 'Reconnected from another page');
    }
}

function connectClient(client, message) {
    if ((message.type !== 'host' && message.type !== 'join') || !roomCodePattern.test(message.roomCode || '')) {
        send(client, { type: 'error', message: 'Invalid party code.' });
        return;
    }
    if (clientInfo.has(client)) {
        send(client, { type: 'error', message: 'Already connected to a party.' });
        return;
    }

    const code = message.roomCode;
    const browserId = browserIdPattern.test(message.browserId || '') ? message.browserId : null;
    if (message.type === 'host') {
        const existingRoom = rooms.get(code);
        if (existingRoom) {
            if (!browserId || existingRoom.hostBrowserId !== browserId) {
                send(client, { type: 'error', message: 'That party code is already in use.' });
                return;
            }
            if (existingRoom.host) supersedeClient(existingRoom.host);
            clearTimeout(existingRoom.hostReconnectTimer);
            existingRoom.hostReconnectTimer = null;
            existingRoom.host = client;
            existingRoom.clients.add(client);
            clientInfo.set(client, { roomCode: code, role: 'host', browserId });
            acceptedConnectionsTotal++;
            send(client, { type: 'welcome', role: 'host', roomCode: code, participants: existingRoom.clients.size, browserId });
            for (const member of existingRoom.membersById.values()) {
                send(client, { type: 'member-joined', memberId: member.memberId, browserId: member.browserId, status: member.status });
            }
            broadcast(existingRoom, { type: 'host-reconnected' }, client);
            return;
        }
        rooms.set(code, {
            code,
            host: client,
            hostBrowserId: browserId || `HOST-${crypto.randomUUID()}`,
            clients: new Set([client]),
            members: new Map(),
            membersById: new Map(),
            membersByBrowserId: new Map(),
            state: { revision: 0, running: false, config: null, run: null, scheduledStartAt: null },
            countdownTimer: null,
            pendingMemberStatuses: new Map(),
            memberStatusFlushTimer: null,
            hostReconnectTimer: null
        });
        clientInfo.set(client, { roomCode: code, role: 'host', browserId });
        acceptedConnectionsTotal++;
        send(client, { type: 'welcome', role: 'host', roomCode: code, participants: 1, browserId });
        return;
    }

    const room = rooms.get(code);
    if (!room) {
        send(client, { type: 'error', message: 'No active party has that code.' });
        return;
    }
    const persistedBrowserId = browserId || `SESSION-${nextMemberId}`;
    let member = room.membersByBrowserId.get(persistedBrowserId);
    if (member?.client) supersedeClient(member.client);
    if (!member) {
        member = { memberId: nextMemberId++, browserId: persistedBrowserId, client: null, reconnectTimer: null, status: null };
        room.membersById.set(member.memberId, member);
        room.membersByBrowserId.set(member.browserId, member);
    }
    clearTimeout(member.reconnectTimer);
    member.reconnectTimer = null;
    member.client = client;
    room.clients.add(client);
    room.members.set(client, member.memberId);
    clientInfo.set(client, { roomCode: code, role: 'join', memberId: member.memberId, browserId: member.browserId });
    acceptedConnectionsTotal++;
    send(client, { type: 'welcome', role: 'join', roomCode: code, participants: room.clients.size, memberId: member.memberId, browserId: member.browserId });
    if (room.host) {
        send(room.host, {
            type: member.status ? 'member-reconnected' : 'member-joined',
            memberId: member.memberId,
            browserId: member.browserId,
            status: member.status
        });
    }
}

function handleMessage(client, message) {
    if (message.type === 'host' || message.type === 'join') return connectClient(client, message);
    const info = clientInfo.get(client);
    const room = info && rooms.get(info.roomCode);
    if (!room) return send(client, { type: 'error', message: 'Join a party first.' });
    if (message.type === 'time-sync') {
        if (!Number.isFinite(message.clientSentAt)) return send(client, { type: 'error', message: 'Invalid time sync request.' });
        const serverReceivedAt = Date.now();
        return {
            type: 'time-sync',
            clientSentAt: message.clientSentAt,
            serverReceivedAt,
            serverSentAt: Date.now()
        };
    }
    if (message.type === 'time-sync-ack') return;
    if (info.role === 'join' && validMemberStatus(message)) {
        queueMemberStatus(room, info.memberId, message);
        return;
    }
    if (info.role !== 'host') return send(client, { type: 'error', message: 'Only the host can send party commands.' });
    if (!validCommand(message)) return send(client, { type: 'error', message: 'Invalid party command.' });
    commandTotals[message.command]++;

    if (message.command === 'config') {
        room.state.config = { settings: message.settings, targetSelector: message.targetSelector };
    } else if (message.command === 'start') {
        clearTimeout(room.countdownTimer);
        room.countdownTimer = null;
        room.state.scheduledStartAt = null;
        room.state.run = message.run || null;
        if (message.settings && typeof message.targetSelector === 'string') {
            room.state.config = { settings: message.settings, targetSelector: message.targetSelector };
        }
        room.state.running = true;
    } else if (message.command === 'stop') {
        clearTimeout(room.countdownTimer);
        room.countdownTimer = null;
        room.state.scheduledStartAt = null;
        room.state.run = null;
        room.state.running = false;
    } else if (message.command === 'countdown') {
        clearTimeout(room.countdownTimer);
        room.state.config = { settings: message.settings, targetSelector: message.targetSelector };
        room.state.running = false;
        room.state.scheduledStartAt = Date.now() + message.delayMs;
        room.state.run = { ...message.run, startAt: room.state.scheduledStartAt };
        room.countdownTimer = setTimeout(() => {
            if (rooms.get(info.roomCode) !== room || !room.state.scheduledStartAt) return;
            room.countdownTimer = null;
            room.state.scheduledStartAt = null;
            room.state.running = true;
            room.state.revision++;
            broadcast(room, {
                type: 'command',
                command: 'start',
                settings: room.state.config.settings,
                targetSelector: room.state.config.targetSelector,
                run: room.state.run,
                revision: room.state.revision
            });
        }, message.delayMs);
    }

    room.state.revision++;
    broadcast(room, {
        ...message,
        ...(message.command === 'countdown' ? { startAt: room.state.scheduledStartAt, run: room.state.run } : {}),
        revision: room.state.revision
    }, client);
    if (message.command === 'countdown') return { startAt: room.state.scheduledStartAt, run: room.state.run };
}

const httpServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
        response.end();
        return;
    }
    if (url.pathname === '/health') return writeJson(response, 200, { ok: true, rooms: rooms.size });
    if (url.pathname === '/metrics') return writeMetrics(response);
    if (!url.pathname.startsWith('/api/party/')) return writeJson(response, 404, { error: 'Not found.' });

    try {
        if (url.pathname === '/api/party/connect' && request.method === 'POST') {
            const message = await readJson(request);
            const client = { kind: 'http', token: crypto.randomUUID(), queue: [], waiting: null, waitTimer: null, lastSeen: Date.now() };
            httpClients.set(client.token, client);
            connectClient(client, message);
            const firstMessage = client.queue.shift();
            if (firstMessage?.type === 'error') {
                httpClients.delete(client.token);
                return writeJson(response, 400, firstMessage);
            }
            return writeJson(response, 200, { token: client.token, message: firstMessage, state: partyState(client) });
        }

        const token = url.searchParams.get('token');
        const client = token && httpClients.get(token);
        if (!client) return writeJson(response, 401, { error: 'Party session expired.' });
        client.lastSeen = Date.now();

        if (url.pathname === '/api/party/message' && request.method === 'POST') {
            const result = handleMessage(client, await readJson(request));
            return writeJson(response, 200, result || {});
        }
        if (url.pathname === '/api/party/disconnect' && request.method === 'POST') {
            removeFromRoom(client);
            httpClients.delete(token);
            closeHttpWait(client);
            return writeJson(response, 204);
        }
        if (url.pathname === '/api/party/events' && request.method === 'GET') {
            if (client.queue.length) return writeJson(response, 200, { messages: client.queue.splice(0), state: partyState(client) });
            closeHttpWait(client);
            client.waiting = response;
            client.waitTimer = setTimeout(() => {
                if (client.waiting === response) {
                    client.waiting = null;
                    client.waitTimer = null;
                    writeJson(response, 200, { messages: [], state: partyState(client) });
                }
            }, LONG_POLL_MS);
            response.on('close', () => {
                if (client.waiting === response) {
                    client.waiting = null;
                    clearTimeout(client.waitTimer);
                    client.waitTimer = null;
                    // A browser reload or navigation aborts its active long poll.
                    // Keep its logical party identity briefly so the reloaded script can resume it.
                    suspendClient(client);
                    httpClients.delete(client.token);
                }
            });
            return;
        }
        return writeJson(response, 404, { error: 'Not found.' });
    } catch (error) {
        return writeJson(response, 400, { error: error.message || 'Invalid request.' });
    }
});

// Keep connections warm across successive long-poll requests. This avoids a TCP/TLS
// reconnect storm when a large party is idle, while the proxy remains the public edge.
httpServer.keepAliveTimeout = 60_000;
httpServer.headersTimeout = 65_000;
httpServer.requestTimeout = 60_000;

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_SIZE, perMessageDeflate: false });
wss.on('connection', socket => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('error', () => {});
    socket.on('message', (data, isBinary) => {
        if (isBinary || data.length > MAX_MESSAGE_SIZE) return socket.close(1003, 'Text messages only');
        try {
            const result = handleMessage(socket, JSON.parse(data.toString()));
            if (result) send(socket, result);
        } catch { send(socket, { type: 'error', message: 'Invalid JSON message.' }); }
    });
    socket.on('close', () => suspendClient(socket));
});

const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
        if (!socket.isAlive) socket.terminate();
        else { socket.isAlive = false; socket.ping(); }
    }
    const oldest = Date.now() - HTTP_CLIENT_TTL_MS;
    for (const client of httpClients.values()) {
        if (client.lastSeen < oldest) {
            suspendClient(client);
            httpClients.delete(client.token);
            closeHttpWait(client);
        }
    }
}, 15_000);
wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(port, '0.0.0.0', () => console.log(`Auto Clicker party relay listening on port ${port}`));
