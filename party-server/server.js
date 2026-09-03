import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const port = Number(process.env.PORT || 8080);
const rooms = new Map();
const clientInfo = new Map();
const httpClients = new Map();
const roomCodePattern = /^[A-Z2-9]{6,16}$/;
const MAX_MESSAGE_SIZE = 8 * 1024;
const LONG_POLL_MS = 25_000;
const HTTP_CLIENT_TTL_MS = 70_000;
let nextMemberId = 1;

function writeJson(response, status, payload) {
    response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*'
    });
    response.end(payload === undefined ? '' : JSON.stringify(payload));
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
            writeJson(response, 200, { messages: [message] });
        } else {
            client.queue.push(message);
        }
        return;
    }
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

function broadcast(room, message, except = null) {
    for (const client of room.clients) if (client !== except) send(client, message);
}

function announcePresence(room) {
    broadcast(room, { type: 'presence', participants: room.clients.size });
}

function closeHttpWait(client) {
    if (!client?.waiting) return;
    const response = client.waiting;
    client.waiting = null;
    clearTimeout(client.waitTimer);
    client.waitTimer = null;
    writeJson(response, 204);
}

function removeFromRoom(client) {
    const info = clientInfo.get(client);
    if (!info?.roomCode) return;

    const room = rooms.get(info.roomCode);
    if (!room) return;

    room.clients.delete(client);
    if (room.host === client) {
        broadcast(room, { type: 'party-ended', message: 'The host disconnected. This party has ended.' });
        for (const member of room.clients) {
            clientInfo.delete(member);
            if (member.kind === 'http') {
                httpClients.delete(member.token);
                closeHttpWait(member);
            } else {
                member.close(4001, 'Host disconnected');
            }
        }
        rooms.delete(info.roomCode);
    } else {
        room.members.delete(client);
        send(room.host, { type: 'member-left', memberId: info.memberId });
        announcePresence(room);
    }
    clientInfo.delete(client);
}

function validCommand(message) {
    if (message.type !== 'command') return false;
    if (message.command === 'start' || message.command === 'stop') return true;
    if (message.command !== 'config' || !message.settings) return false;
    const { delay, randomization, count } = message.settings;
    return Number.isFinite(delay) && delay >= 20 &&
        Number.isFinite(randomization) && randomization >= 0 &&
        Number.isInteger(count) && count >= 0 &&
        typeof message.targetSelector === 'string' && message.targetSelector.length <= 2048;
}

function validMemberStatus(message) {
    return message.type === 'client-status' &&
        typeof message.state === 'string' && message.state.length <= 80 &&
        Number.isInteger(message.clicks) && message.clicks >= 0 &&
        (message.total === null || (Number.isInteger(message.total) && message.total >= 0));
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
    if (message.type === 'host') {
        if (rooms.has(code)) {
            send(client, { type: 'error', message: 'That party code is already in use.' });
            return;
        }
        rooms.set(code, { host: client, clients: new Set([client]), members: new Map() });
        clientInfo.set(client, { roomCode: code, role: 'host' });
        send(client, { type: 'welcome', role: 'host', roomCode: code, participants: 1 });
        return;
    }

    const room = rooms.get(code);
    if (!room) {
        send(client, { type: 'error', message: 'No active party has that code.' });
        return;
    }
    room.clients.add(client);
    const memberId = nextMemberId++;
    room.members.set(client, memberId);
    clientInfo.set(client, { roomCode: code, role: 'join', memberId });
    send(client, { type: 'welcome', role: 'join', roomCode: code, participants: room.clients.size, memberId });
    send(room.host, { type: 'member-joined', memberId });
    announcePresence(room);
}

function handleMessage(client, message) {
    if (message.type === 'host' || message.type === 'join') return connectClient(client, message);
    const info = clientInfo.get(client);
    const room = info && rooms.get(info.roomCode);
    if (!room) return send(client, { type: 'error', message: 'Join a party first.' });
    if (info.role === 'join' && validMemberStatus(message)) {
        return send(room.host, { type: 'member-status', memberId: info.memberId, state: message.state, clicks: message.clicks, total: message.total });
    }
    if (info.role !== 'host') return send(client, { type: 'error', message: 'Only the host can send party commands.' });
    if (!validCommand(message)) return send(client, { type: 'error', message: 'Invalid party command.' });
    broadcast(room, message, client);
}

const httpServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
        response.end();
        return;
    }
    if (url.pathname === '/health') return writeJson(response, 200, { ok: true, rooms: rooms.size });
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
            return writeJson(response, 200, { token: client.token, message: firstMessage });
        }

        const token = url.searchParams.get('token');
        const client = token && httpClients.get(token);
        if (!client) return writeJson(response, 401, { error: 'Party session expired.' });
        client.lastSeen = Date.now();

        if (url.pathname === '/api/party/message' && request.method === 'POST') {
            handleMessage(client, await readJson(request));
            return writeJson(response, 204);
        }
        if (url.pathname === '/api/party/disconnect' && request.method === 'POST') {
            removeFromRoom(client);
            httpClients.delete(token);
            closeHttpWait(client);
            return writeJson(response, 204);
        }
        if (url.pathname === '/api/party/events' && request.method === 'GET') {
            if (client.queue.length) return writeJson(response, 200, { messages: client.queue.splice(0) });
            closeHttpWait(client);
            client.waiting = response;
            client.waitTimer = setTimeout(() => {
                if (client.waiting === response) {
                    client.waiting = null;
                    client.waitTimer = null;
                    writeJson(response, 204);
                }
            }, LONG_POLL_MS);
            response.on('close', () => {
                if (client.waiting === response) {
                    client.waiting = null;
                    clearTimeout(client.waitTimer);
                    client.waitTimer = null;
                }
            });
            return;
        }
        return writeJson(response, 404, { error: 'Not found.' });
    } catch (error) {
        return writeJson(response, 400, { error: error.message || 'Invalid request.' });
    }
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_SIZE, perMessageDeflate: false });
wss.on('connection', socket => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('error', () => {});
    socket.on('message', (data, isBinary) => {
        if (isBinary || data.length > MAX_MESSAGE_SIZE) return socket.close(1003, 'Text messages only');
        try { handleMessage(socket, JSON.parse(data.toString())); } catch { send(socket, { type: 'error', message: 'Invalid JSON message.' }); }
    });
    socket.on('close', () => removeFromRoom(socket));
});

const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
        if (!socket.isAlive) socket.terminate();
        else { socket.isAlive = false; socket.ping(); }
    }
    const oldest = Date.now() - HTTP_CLIENT_TTL_MS;
    for (const client of httpClients.values()) {
        if (client.lastSeen < oldest) {
            removeFromRoom(client);
            httpClients.delete(client.token);
            closeHttpWait(client);
        }
    }
}, 15_000);
wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(port, '0.0.0.0', () => console.log(`Auto Clicker party relay listening on port ${port}`));
