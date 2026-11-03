// @ts-nocheck
// 
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Constants matching shared/protocol.ts
const MAX_ROOM_SIZE = 20;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 8;
const MIN_PASSWORD_LENGTH = 8;
const PING = 'ping';
const PONG = 'pong';

/**
 * Generate an 8-character room code using rejection sampling to eliminate modulo bias.
 */
export function generateRoomCode() {
  const alphabetLen = ROOM_CODE_ALPHABET.length;
  const limit = Math.floor(256 / alphabetLen) * alphabetLen;
  const buffer = crypto.randomBytes(ROOM_CODE_LENGTH * 2);
  let code = '';
  let byteIndex = 0;

  while (code.length < ROOM_CODE_LENGTH) {
    if (byteIndex >= buffer.length) {
      crypto.randomFillSync(buffer);
      byteIndex = 0;
    }
    const byte = buffer[byteIndex++];
    if (byte < limit) {
      code += ROOM_CODE_ALPHABET[byte % alphabetLen];
    }
  }
  return code;
}

/**
 * Validate room code format.
 */
export function isValidRoomCode(code) {
  if (typeof code !== 'string' || code.length !== ROOM_CODE_LENGTH) {
    return false;
  }
  for (let i = 0; i < code.length; i++) {
    if (!ROOM_CODE_ALPHABET.includes(code[i])) {
      return false;
    }
  }
  return true;
}

/**
 * Sanitise participant name.
 */
function sanitiseName(raw) {
  if (typeof raw !== 'string') return 'Anonymous';
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return [...cleaned].slice(0, 32).join('').trim() || 'Anonymous';
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Lightweight RFC 6455 WebSocket Connection Wrapper using Node.js stream.Duplex.
 */
class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.isClosed = false;
    this.onMessageCallback = null;
    this.onCloseCallback = null;

    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('close', () => this._onClose());
    this.socket.on('error', () => {
      this._onClose();
    });
  }

  get remoteAddress() {
    return this.socket.remoteAddress;
  }

  onMessage(cb) {
    this.onMessageCallback = cb;
  }

  onClose(cb) {
    this.onCloseCallback = cb;
  }

  send(data) {
    if (this.isClosed || this.socket.destroyed) return;
    const payload = Buffer.from(data, 'utf8');
    const length = payload.length;
    let header;

    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text opcode (1)
      header[1] = length;
    } else if (length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this._onClose();
    }
  }

  close(code = 1000, reason = '') {
    if (this.isClosed) return;
    this.isClosed = true;
    try {
      const reasonBuf = Buffer.from(reason, 'utf8');
      const closePayload = Buffer.alloc(2 + reasonBuf.length);
      closePayload.writeUInt16BE(code, 0);
      reasonBuf.copy(closePayload, 2);

      const header = Buffer.alloc(2);
      header[0] = 0x88; // FIN + close opcode (8)
      header[1] = closePayload.length;
      this.socket.write(Buffer.concat([header, closePayload]));
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
  }

  _onClose() {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.onCloseCallback) {
      this.onCloseCallback();
      this.onCloseCallback = null;
    }
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const byte1 = this.buffer[0];
      const byte2 = this.buffer[1];
      const opcode = byte1 & 0x0f;
      const isMasked = (byte2 & 0x80) !== 0;
      let payloadLength = byte2 & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < 4) return;
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        payloadLength = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let maskKey = null;
      if (isMasked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + payloadLength) return;

      const payload = this.buffer.subarray(offset, offset + payloadLength);
      this.buffer = this.buffer.subarray(offset + payloadLength);

      if (isMasked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x1) {
        // Text frame
        const text = payload.toString('utf8');
        if (this.onMessageCallback) {
          this.onMessageCallback(text);
        }
      } else if (opcode === 0x8) {
        // Close frame
        this.close();
        return;
      } else if (opcode === 0x9) {
        // Ping frame -> send Pong
        const pongHeader = Buffer.alloc(2);
        pongHeader[0] = 0x8a; // Pong opcode (10)
        pongHeader[1] = payload.length;
        this.socket.write(Buffer.concat([pongHeader, payload]));
      }
    }
  }
}

/**
 * In-memory room manager for local signaling mesh.
 */
class LocalRoom {
  constructor(code) {
    this.code = code;
    this.peers = new Map(); // peerId -> { id, name, sharing, host, ws, rejoinToken, ip }
    this.password = null;
    this.hasBeenClaimed = false;
    this.hostToken = null;
    this.rejoinTokens = new Map(); // token -> { id, sharing, host, until }
    this.bannedIps = new Map(); // ip -> expireTimestamp
    this.locked = false;
    this.cleanupTimer = null;
  }

  scheduleCleanup(onExpire, ttlMs = 15 * 60 * 1000) {
    this.cancelCleanup();
    this.cleanupTimer = setTimeout(onExpire, ttlMs);
    this.cleanupTimer.unref?.();
  }

  cancelCleanup() {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  sendSafe(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  handleJoin(ws, clientMsg) {
    this.cancelCleanup();
    const clientIp = ws.remoteAddress || ws.socket?.remoteAddress || '127.0.0.1';

    let creates = false;
    // 1. Password check
    if (!this.hasBeenClaimed) {
      if (clientMsg.password && clientMsg.password.length < MIN_PASSWORD_LENGTH) {
        this.sendSafe(ws, {
          t: 'error',
          code: 'weak-password',
          message: `Room passwords need at least ${MIN_PASSWORD_LENGTH} characters.`,
        });
        ws.close(1008, 'Weak password');
        return;
      }
      if (clientMsg.password) {
        this.password = clientMsg.password;
      }
      this.hasBeenClaimed = true;
      this.hostToken = crypto.randomUUID();
      creates = true;
    } else {
      if (this.password !== null) {
        if (!clientMsg.password) {
          this.sendSafe(ws, {
            t: 'error',
            code: 'bad-password',
            message: 'This room needs a password',
          });
          ws.close(1008, 'Password required');
          return;
        }
        if (clientMsg.password !== this.password) {
          this.sendSafe(ws, {
            t: 'error',
            code: 'bad-password',
            message: 'Incorrect or missing room password',
          });
          ws.close(1008, 'Incorrect password');
          return;
        }
      } else if (clientMsg.password) {
        this.sendSafe(ws, {
          t: 'error',
          code: 'password-ignored',
          message: 'This room has no password. Yours was ignored — create a new room to set one.',
        });
      }
    }

    const returningTicket = clientMsg.rejoinToken ? this.rejoinTokens.get(clientMsg.rejoinToken) : null;
    const isReturning = Boolean(returningTicket && (!returningTicket.until || returningTicket.until > Date.now()));

    const isHost =
      creates ||
      Boolean(clientMsg.hostToken && clientMsg.hostToken === this.hostToken) ||
      Boolean(isReturning && returningTicket?.host);

    // 2. Kick ban check (hosts and returning peers are not barred by IP)
    if (!isHost && !isReturning) {
      const banUntil = this.bannedIps.get(clientIp);
      if (banUntil && banUntil > Date.now()) {
        this.sendSafe(ws, {
          t: 'error',
          code: 'kicked',
          message: 'You were removed from this room.',
        });
        ws.close(1008, 'Banned');
        return;
      }
    }

    // 3. Lock check
    if (this.locked && !isHost && !isReturning) {
      this.sendSafe(ws, {
        t: 'error',
        code: 'room-locked',
        message: 'This room is locked. Ask the host to unlock it.',
      });
      ws.close(1008, 'Room locked');
      return;
    }

    // 3. Capacity check
    if (this.peers.size >= MAX_ROOM_SIZE) {
      this.sendSafe(ws, {
        t: 'error',
        code: 'room-full',
        message: 'Room is full',
      });
      ws.close(1008, 'Room full');
      return;
    }

    // 4. Register peer
    const peerId = (clientMsg.resume && isReturning && returningTicket?.id) || crypto.randomUUID();
    const rejoinToken = crypto.randomUUID();
    const name = sanitiseName(clientMsg.displayName);
    const sharing = clientMsg.sharing === true;

    if (clientMsg.rejoinToken) {
      this.rejoinTokens.delete(clientMsg.rejoinToken);
    }
    this.rejoinTokens.set(rejoinToken, {
      id: peerId,
      sharing,
      host: isHost,
      until: Date.now() + 12 * 3600 * 1000,
    });

    const peerInfo = {
      id: peerId,
      name,
      sharing,
      host: isHost,
      ws,
      rejoinToken,
      ip: clientIp,
    };

    const existingPeers = [];
    for (const p of this.peers.values()) {
      if (p.id !== peerId) {
        existingPeers.push({
          id: p.id,
          name: p.name,
          sharing: p.sharing,
          ...(p.host ? { host: true } : {}),
        });
      }
    }

    this.peers.set(peerId, peerInfo);

    // 5. Send welcome
    this.sendSafe(ws, {
      t: 'welcome',
      selfId: peerId,
      peers: existingPeers,
      host: isHost,
      ...(isHost && this.hostToken ? { hostToken: this.hostToken } : {}),
      rejoinToken,
      locked: this.locked,
    });

    // 6. Broadcast peer-joined
    const joinedMsg = {
      t: 'peer-joined',
      peer: {
        id: peerId,
        name,
        sharing,
        ...(isHost ? { host: true } : {}),
      },
    };

    for (const p of this.peers.values()) {
      if (p.id !== peerId) {
        this.sendSafe(p.ws, joinedMsg);
      }
    }
  }

  handleSignal(senderId, clientMsg) {
    const target = this.peers.get(clientMsg.to);
    if (!target) {
      const sender = this.peers.get(senderId);
      if (sender) {
        this.sendSafe(sender.ws, {
          t: 'error',
          code: 'unknown-peer',
          message: 'Peer not found',
        });
      }
      return;
    }
    this.sendSafe(target.ws, {
      t: 'signal',
      from: senderId,
      data: clientMsg.data,
    });
  }

  handleState(senderId, clientMsg) {
    const sender = this.peers.get(senderId);
    if (!sender) return;
    sender.sharing = Boolean(clientMsg.sharing);

    const stateMsg = {
      t: 'peer-state',
      id: senderId,
      sharing: sender.sharing,
    };
    for (const p of this.peers.values()) {
      if (p.id !== senderId) {
        this.sendSafe(p.ws, stateMsg);
      }
    }
  }

  handleLock(senderId, clientMsg) {
    const sender = this.peers.get(senderId);
    if (!sender || !sender.host) {
      if (sender) {
        this.sendSafe(sender.ws, { t: 'error', code: 'not-host', message: 'Only the host can lock the room' });
      }
      return;
    }
    this.locked = Boolean(clientMsg.locked);
    const lockMsg = { t: 'room-state', locked: this.locked };
    for (const p of this.peers.values()) {
      this.sendSafe(p.ws, lockMsg);
    }
  }

  handleKick(senderId, clientMsg) {
    const sender = this.peers.get(senderId);
    if (!sender || !sender.host) {
      if (sender) {
        this.sendSafe(sender.ws, { t: 'error', code: 'not-host', message: 'Only the host can remove people' });
      }
      return;
    }
    if (clientMsg.id === senderId) {
      // Prevent self-kick
      return;
    }
    const target = this.peers.get(clientMsg.id);
    if (!target) {
      this.sendSafe(sender.ws, { t: 'error', code: 'unknown-peer', message: 'Peer not found' });
      return;
    }

    // Revoke rejoin ticket
    if (target.rejoinToken) {
      this.rejoinTokens.delete(target.rejoinToken);
    }

    // Ban IP for 15 minutes (KICK_BAN_MS)
    if (target.ip) {
      this.bannedIps.set(target.ip, Date.now() + 15 * 60 * 1000);
    }

    this.sendSafe(target.ws, { t: 'error', code: 'kicked', message: 'You were removed from this room.' });
    target.ws.close(1008, 'Kicked');
    this.handleLeave(target.id);
  }

  handleLeave(peerId) {
    if (!this.peers.has(peerId)) return;
    this.peers.delete(peerId);

    const leftMsg = { t: 'peer-left', id: peerId };
    for (const p of this.peers.values()) {
      this.sendSafe(p.ws, leftMsg);
    }
  }
}

/**
 * Embedded HTTP and WebSocket server for local screenshare application.
 */
export async function startLocalServer(options = {}) {
  const distPath = options.distPath || path.resolve(__dirname, '../dist');
  const port = options.port !== undefined ? options.port : (process.env.PORT ? parseInt(process.env.PORT, 10) : 0);
  const host = options.host || '127.0.0.1';

  const rooms = new Map(); // roomCode -> LocalRoom
  const activeSockets = new Set();

  function applySecurityHeaders(res) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
    );
    res.setHeader(
      'Permissions-Policy',
      'display-capture=(self), camera=(), microphone=(), geolocation=(), usb=(), payment=()',
    );
  }

  const server = http.createServer((req, res) => {
    applySecurityHeaders(res);

    const parsedUrl = new URL(req.url, `http://${host}`);
    const pathname = parsedUrl.pathname;

    // GET /api/room
    if (req.method === 'GET' && pathname === '/api/room') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ code: generateRoomCode() }));
      return;
    }

    // Static asset serving from dist/
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    let relativePath = decodeURIComponent(pathname);
    if (relativePath === '/' || relativePath === '') {
      relativePath = '/index.html';
    }

    const safePath = path.normalize(path.join(distPath, relativePath));
    if (!safePath.startsWith(distPath)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.stat(safePath, (err, stats) => {
      let filePathToServe = safePath;
      if (err || !stats.isFile()) {
        // SPA Fallback: if not an asset request (no file extension), serve index.html
        if (!path.extname(pathname)) {
          filePathToServe = path.join(distPath, 'index.html');
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
      }

      fs.stat(filePathToServe, (statErr, finalStats) => {
        if (statErr || !finalStats.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }

        const ext = path.extname(filePathToServe).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': finalStats.size,
        });

        if (req.method === 'HEAD') {
          res.end();
          return;
        }

        const stream = fs.createReadStream(filePathToServe);
        stream.pipe(res);
      });
    });
  });

  // WebSocket upgrade handler on /ws/:code
  server.on('upgrade', (req, socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));

    const parsedUrl = new URL(req.url, `http://${host}`);
    const wsPrefix = '/ws/';
    let code = '';
    if (parsedUrl.pathname.startsWith(wsPrefix)) {
      code = parsedUrl.pathname.slice(wsPrefix.length).trim().toUpperCase();
    }

    if (!isValidRoomCode(code)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"error":"Invalid room code"}');
      socket.destroy();
      return;
    }

    const upgradeHeader = req.headers.upgrade;
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const secKey = req.headers['sec-websocket-key'];
    if (!secKey) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // RFC 6455 Handshake
    const acceptKey = crypto
      .createHash('sha1')
      .update(secKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    );

    const ws = new WebSocketConnection(socket);
    let assignedRoom = rooms.get(code);
    if (!assignedRoom) {
      assignedRoom = new LocalRoom(code);
      rooms.set(code, assignedRoom);
    }

    let joinedPeerId = null;

    ws.onMessage((raw) => {
      if (raw === PING) {
        ws.send(PONG);
        return;
      }
      if (raw === PONG) {
        return;
      }

      let clientMsg;
      try {
        clientMsg = JSON.parse(raw);
      } catch {
        return;
      }

      if (!clientMsg || typeof clientMsg !== 'object') return;

      switch (clientMsg.t) {
        case 'join': {
          assignedRoom.handleJoin(ws, clientMsg);
          for (const [id, peer] of assignedRoom.peers.entries()) {
            if (peer.ws === ws) {
              joinedPeerId = id;
              break;
            }
          }
          break;
        }
        case 'signal': {
          if (joinedPeerId) {
            assignedRoom.handleSignal(joinedPeerId, clientMsg);
          }
          break;
        }
        case 'state': {
          if (joinedPeerId) {
            assignedRoom.handleState(joinedPeerId, clientMsg);
          }
          break;
        }
        case 'lock': {
          if (joinedPeerId) {
            assignedRoom.handleLock(joinedPeerId, clientMsg);
          }
          break;
        }
        case 'kick': {
          if (joinedPeerId) {
            assignedRoom.handleKick(joinedPeerId, clientMsg);
          }
          break;
        }
      }
    });

    ws.onClose(() => {
      if (joinedPeerId) {
        assignedRoom.handleLeave(joinedPeerId);
      }
      if (assignedRoom.peers.size === 0) {
        assignedRoom.scheduleCleanup(() => {
          if (assignedRoom.peers.size === 0) {
            rooms.delete(code);
          }
        });
      }
    });
  });

  await new Promise((resolve) => {
    server.listen(port, host, () => resolve());
  });

  const actualPort = server.address().port;
  const url = `http://${host}:${actualPort}`;

  return {
    server,
    port: actualPort,
    url,
    close: async () => {
      for (const r of rooms.values()) {
        r.cancelCleanup();
      }
      rooms.clear();
      for (const s of activeSockets) {
        try {
          s.destroy();
        } catch {}
      }
      activeSockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
