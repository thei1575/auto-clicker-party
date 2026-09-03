import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const port = Number(process.env.PORT || 8080);
const rooms = new Map();
const clientInfo = new WeakMap();
const roomCodePattern = /^[A-Z2-9]{6,16}$/;
const MAX_MESSAGE_SIZE = 8 * 1024;
let nextMemberId = 1;

const httpServer = http.createServer((request, response) => {
    if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
        return;
    }

    response.writeHead(404);
    response.end();
});

const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_MESSAGE_SIZE,
    perMessageDeflate: false
});

function send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

function broadcast(room, message, except = null) {
    for (const client of room.clients) {
        if (client !== except) {
            send(client, message);
        }
    }
}

function announcePresence(room) {
    broadcast(room, {
        type: 'presence',
        participants: room.clients.size
    });
}

function removeFromRoom(socket) {
    const info = clientInfo.get(socket);

    if (!info?.roomCode) {
        return;
    }

    const room = rooms.get(info.roomCode);

    if (!room) {
        return;
    }

    room.clients.delete(socket);

    if (room.host === socket) {
        broadcast(room, {
            type: 'party-ended',
            message: 'The host disconnected. This party has ended.'
        });

        for (const client of room.clients) {
            clientInfo.delete(client);
            client.close(4001, 'Host disconnected');
        }

        rooms.delete(info.roomCode);
    } else {
        room.members.delete(socket);
        send(room.host, { type: 'member-left', memberId: info.memberId });
        announcePresence(room);
    }

    clientInfo.delete(socket);
}

function validCommand(message) {
    if (message.type !== 'command') {
        return false;
    }

    if (message.command === 'start' || message.command === 'stop') {
        return true;
    }

    if (message.command !== 'config' || !message.settings) {
        return false;
    }

    const { delay, randomization, count } = message.settings;

    return Number.isFinite(delay) && delay >= 20 &&
        Number.isFinite(randomization) && randomization >= 0 &&
        Number.isInteger(count) && count >= 0 &&
        typeof message.targetSelector === 'string' &&
        message.targetSelector.length <= 2048;
}

function validMemberStatus(message) {
    return message.type === 'client-status' &&
        typeof message.state === 'string' && message.state.length <= 80 &&
        Number.isInteger(message.clicks) && message.clicks >= 0 &&
        (message.total === null || (Number.isInteger(message.total) && message.total >= 0));
}

wss.on('connection', socket => {
    socket.isAlive = true;

    socket.on('pong', () => {
        socket.isAlive = true;
    });

    socket.on('error', () => {
        // Closing the socket below handles cleanup; avoid crashing on a client error.
    });

    socket.on('message', (data, isBinary) => {
        if (isBinary || data.length > MAX_MESSAGE_SIZE) {
            socket.close(1003, 'Text messages only');
            return;
        }

        let message;

        try {
            message = JSON.parse(data.toString());
        } catch {
            send(socket, { type: 'error', message: 'Invalid JSON message.' });
            return;
        }

        if (message.type === 'host' || message.type === 'join') {
            if (!roomCodePattern.test(message.roomCode || '')) {
                send(socket, { type: 'error', message: 'Invalid party code.' });
                return;
            }

            if (clientInfo.has(socket)) {
                send(socket, { type: 'error', message: 'Already connected to a party.' });
                return;
            }

            const code = message.roomCode;

            if (message.type === 'host') {
                if (rooms.has(code)) {
                    send(socket, { type: 'error', message: 'That party code is already in use.' });
                    return;
                }

                const room = { host: socket, clients: new Set([socket]), members: new Map() };
                rooms.set(code, room);
                clientInfo.set(socket, { roomCode: code, role: 'host' });
                send(socket, { type: 'welcome', role: 'host', roomCode: code, participants: 1 });
                return;
            }

            const room = rooms.get(code);

            if (!room) {
                send(socket, { type: 'error', message: 'No active party has that code.' });
                return;
            }

            room.clients.add(socket);
            const memberId = nextMemberId++;
            room.members.set(socket, memberId);
            clientInfo.set(socket, { roomCode: code, role: 'join', memberId });
            send(socket, { type: 'welcome', role: 'join', roomCode: code, participants: room.clients.size, memberId });
            send(room.host, { type: 'member-joined', memberId });
            announcePresence(room);
            return;
        }

        const info = clientInfo.get(socket);
        const room = info && rooms.get(info.roomCode);

        if (!room) {
            send(socket, { type: 'error', message: 'Join a party first.' });
            return;
        }

        if (info.role === 'join' && validMemberStatus(message)) {
            send(room.host, {
                type: 'member-status',
                memberId: info.memberId,
                state: message.state,
                clicks: message.clicks,
                total: message.total
            });
            return;
        }

        if (info.role !== 'host') {
            send(socket, { type: 'error', message: 'Only the host can send party commands.' });
            return;
        }

        if (!validCommand(message)) {
            send(socket, { type: 'error', message: 'Invalid party command.' });
            return;
        }

        // The host already acts locally; relay the command only to joined sessions.
        broadcast(room, message, socket);
    });

    socket.on('close', () => removeFromRoom(socket));
});

const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
        if (!socket.isAlive) {
            socket.terminate();
            continue;
        }

        socket.isAlive = false;
        socket.ping();
    }
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Auto Clicker party relay listening on port ${port}`);
});
