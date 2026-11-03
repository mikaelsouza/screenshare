// @ts-nocheck
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { startLocalServer, generateRoomCode } from "@electron/server.js";

class FrameReader {
  private buffer = Buffer.alloc(0);
  private waiting: { resolve: (f: any) => void; reject: (err: any) => void; timer: any } | null = null;

  constructor(private socket: net.Socket) {
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.check();
  }

  private check() {
    if (!this.waiting || this.buffer.length < 2) return;
    const byte1 = this.buffer[0]!;
    const opcode = byte1 & 0x0f;
    const byte2 = this.buffer[1]!;
    let payloadLen = byte2 & 0x7f;
    let offset = 2;
    if (payloadLen === 126) {
      if (this.buffer.length < 4) return;
      payloadLen = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (this.buffer.length < 10) return;
      payloadLen = Number(this.buffer.readBigUInt64BE(2));
      offset = 10;
    }
    if (this.buffer.length >= offset + payloadLen) {
      const payload = this.buffer.subarray(offset, offset + payloadLen);
      this.buffer = this.buffer.subarray(offset + payloadLen);
      const { resolve, timer } = this.waiting;
      clearTimeout(timer);
      this.waiting = null;
      resolve({ opcode, payload });
    }
  }

  read(timeoutMs = 2000): Promise<{ opcode: number; payload: Buffer }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error("Timeout waiting for frame"));
      }, timeoutMs);
      this.waiting = { resolve, reject, timer };
      this.check();
    });
  }

  async readJson(timeoutMs = 2000): Promise<any> {
    const { payload } = await this.read(timeoutMs);
    return JSON.parse(payload.toString("utf8"));
  }
}

function buildMaskedFrame(
  opcode: number,
  payload: Buffer | string,
  mask = Buffer.from([0x12, 0x34, 0x56, 0x78]),
): Buffer {
  const buf = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const len = buf.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | len;
  } else if (len <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const maskedPayload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    maskedPayload[i] = buf[i]! ^ mask[i % 4]!;
  }
  return Buffer.concat([header, mask, maskedPayload]);
}

describe("LocalRoom In-Memory Signaling State Machine (Feature 31)", () => {
  let serverInstance: Awaited<ReturnType<typeof startLocalServer>>;
  let port: number;

  beforeAll(async () => {
    serverInstance = await startLocalServer({ port: 0 });
    port = serverInstance.port;
  });

  afterAll(async () => {
    await serverInstance.close();
  });

  function connectClient(roomCode: string): Promise<{ socket: net.Socket; reader: FrameReader; sendJson: (msg: any) => void }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
        socket.write(
          `GET /ws/${roomCode} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
        );
      });

      let handshakeBuf = "";
      function onHandshake(data: Buffer) {
        handshakeBuf += data.toString("utf8");
        if (handshakeBuf.includes("\r\n\r\n")) {
          socket.off("data", onHandshake);
          if (handshakeBuf.includes("101 Switching Protocols")) {
            const reader = new FrameReader(socket);
            const sendJson = (msg: any) => {
              socket.write(buildMaskedFrame(0x1, JSON.stringify(msg)));
            };
            resolve({ socket, reader, sendJson });
          } else {
            reject(new Error(`Handshake failed: ${handshakeBuf}`));
          }
        }
      }

      socket.on("data", onHandshake);
      socket.on("error", reject);
    });
  }

  describe("T2.1 - T2.5: Claiming, Host Assignment & Password Validation", () => {
    it("T2.1: first join claims room and grants host privileges with tokens", async () => {
      const room = generateRoomCode();
      const client = await connectClient(room);
      client.sendJson({ t: "join", room, displayName: "HostUser" });

      const welcome = await client.reader.readJson();
      expect(welcome.t).toBe("welcome");
      expect(welcome.host).toBe(true);
      expect(typeof welcome.selfId).toBe("string");
      expect(typeof welcome.hostToken).toBe("string");
      expect(typeof welcome.rejoinToken).toBe("string");
      expect(welcome.locked).toBe(false);

      client.socket.destroy();
    });

    it("T2.2: rejects weak password (< 8 chars) on room creation", async () => {
      const room = generateRoomCode();
      const client = await connectClient(room);
      client.sendJson({ t: "join", room, displayName: "HostUser", password: "short" });

      const err = await client.reader.readJson();
      expect(err.t).toBe("error");
      expect(err.code).toBe("weak-password");

      // Verify socket is closed
      await new Promise((r) => client.socket.on("close", r));
      expect(client.socket.destroyed).toBe(true);
    });

    it("T2.3 & T2.4: sets password on first join and enforces it for subsequent peers", async () => {
      const room = generateRoomCode();
      const host = await connectClient(room);
      host.sendJson({ t: "join", room, displayName: "Host", password: "secretPassword123" });
      const hostWelcome = await host.reader.readJson();
      expect(hostWelcome.t).toBe("welcome");
      expect(hostWelcome.host).toBe(true);

      // Peer without password -> rejected
      const p1 = await connectClient(room);
      p1.sendJson({ t: "join", room, displayName: "P1" });
      const err1 = await p1.reader.readJson();
      expect(err1.code).toBe("bad-password");
      await new Promise((r) => p1.socket.on("close", r));

      // Peer with wrong password -> rejected
      const p2 = await connectClient(room);
      p2.sendJson({ t: "join", room, displayName: "P2", password: "wrong" });
      const err2 = await p2.reader.readJson();
      expect(err2.code).toBe("bad-password");
      await new Promise((r) => p2.socket.on("close", r));

      // Peer with correct password -> admitted
      const p3 = await connectClient(room);
      p3.sendJson({ t: "join", room, displayName: "P3", password: "secretPassword123" });
      const welcome3 = await p3.reader.readJson();
      expect(welcome3.t).toBe("welcome");
      expect(welcome3.host).toBe(false);

      host.socket.destroy();
      p3.socket.destroy();
    });

    it("T2.5: passwordless room emits password-ignored warning when password is sent", async () => {
      const room = generateRoomCode();
      const host = await connectClient(room);
      host.sendJson({ t: "join", room, displayName: "Host" });
      await host.reader.readJson(); // welcome

      const guest = await connectClient(room);
      guest.sendJson({ t: "join", room, displayName: "Guest", password: "unneededPassword" });

      const notice = await guest.reader.readJson();
      expect(notice.code).toBe("password-ignored");

      const welcome = await guest.reader.readJson();
      expect(welcome.t).toBe("welcome");

      host.socket.destroy();
      guest.socket.destroy();
    });
  });

  describe("T2.6 - T2.7: Host Privileges, Lock & Bypass", () => {
    it("T2.6: rejoins presenting original hostToken and retains host privileges", async () => {
      const room = generateRoomCode();
      const host1 = await connectClient(room);
      host1.sendJson({ t: "join", room, displayName: "Host" });
      const welcome1 = await host1.reader.readJson();
      const hostToken = welcome1.hostToken;
      host1.socket.destroy();

      // Host reconnects with hostToken
      const host2 = await connectClient(room);
      host2.sendJson({ t: "join", room, displayName: "HostReconnected", hostToken });
      const welcome2 = await host2.reader.readJson();
      expect(welcome2.host).toBe(true);

      host2.socket.destroy();
    });

    it("T2.7: host can lock room, broadcasts room-state, blocks strangers but allows returning tickets", async () => {
      const room = generateRoomCode();
      const host = await connectClient(room);
      host.sendJson({ t: "join", room, displayName: "Host" });
      await host.reader.readJson(); // welcome

      // Member joins before lock and acquires rejoinToken
      const member = await connectClient(room);
      member.sendJson({ t: "join", room, displayName: "Member" });
      const memberWelcome = await member.reader.readJson();
      const memberTicket = memberWelcome.rejoinToken;
      await host.reader.readJson(); // peer-joined

      // Host locks room
      host.sendJson({ t: "lock", locked: true });
      const hostLockState = await host.reader.readJson();
      expect(hostLockState).toEqual({ t: "room-state", locked: true });
      const memberLockState = await member.reader.readJson();
      expect(memberLockState).toEqual({ t: "room-state", locked: true });

      // Stranger tries to join locked room -> rejected with room-locked
      const stranger = await connectClient(room);
      stranger.sendJson({ t: "join", room, displayName: "Stranger" });
      const strangerErr = await stranger.reader.readJson();
      expect(strangerErr.code).toBe("room-locked");

      // Returning member presents valid rejoinToken -> admitted past lock
      const returning = await connectClient(room);
      returning.sendJson({ t: "join", room, displayName: "MemberReturning", rejoinToken: memberTicket, resume: true });
      const returningWelcome = await returning.reader.readJson();
      expect(returningWelcome.t).toBe("welcome");

      host.socket.destroy();
      member.socket.destroy();
      returning.socket.destroy();
    });
  });

  describe("T2.8: Host Kick & 15-Minute Ban", () => {
    it("host kicks peer, target receives kicked error, token revoked, IP banned", async () => {
      const room = generateRoomCode();
      const host = await connectClient(room);
      host.sendJson({ t: "join", room, displayName: "Host" });
      await host.reader.readJson();

      const target = await connectClient(room);
      target.sendJson({ t: "join", room, displayName: "Target" });
      const targetWelcome = await target.reader.readJson();
      const targetId = targetWelcome.selfId;
      const targetTicket = targetWelcome.rejoinToken;
      await host.reader.readJson(); // peer-joined

      // Host kicks target
      host.sendJson({ t: "kick", id: targetId });

      // Target receives kicked error and closes
      const kickErr = await target.reader.readJson();
      expect(kickErr.code).toBe("kicked");
      await new Promise((r) => target.socket.on("close", r));

      // Host receives peer-left
      const leftMsg = await host.reader.readJson();
      expect(leftMsg).toEqual({ t: "peer-left", id: targetId });

      // Target tries to rejoin with ticket -> rejected with kicked error
      const retry = await connectClient(room);
      retry.sendJson({ t: "join", room, displayName: "TargetRetry", rejoinToken: targetTicket });
      const retryErr = await retry.reader.readJson();
      expect(retryErr.code).toBe("kicked");

      host.socket.destroy();
    });
  });

  describe("T2.9 - T2.12: Capacity, Resumption, Signaling & State", () => {
    it("T2.9: enforces MAX_ROOM_SIZE (20 peers)", async () => {
      const room = generateRoomCode();
      const clients: any[] = [];

      for (let i = 0; i < 20; i++) {
        const c = await connectClient(room);
        c.sendJson({ t: "join", room, displayName: `User${i}` });
        const w = await c.reader.readJson();
        expect(w.t).toBe("welcome");
        clients.push(c);
      }

      // 21st join attempt fails with room-full
      const extra = await connectClient(room);
      extra.sendJson({ t: "join", room, displayName: "User21" });
      const err = await extra.reader.readJson();
      expect(err.code).toBe("room-full");

      for (const c of clients) c.socket.destroy();
    });

    it("T2.10: in-place resume with resume: true preserves selfId", async () => {
      const room = generateRoomCode();
      const c1 = await connectClient(room);
      c1.sendJson({ t: "join", room, displayName: "Alice", sharing: true });
      const w1 = await c1.reader.readJson();
      const selfId = w1.selfId;
      const ticket = w1.rejoinToken;
      c1.socket.destroy();

      // Resume on new connection
      const c2 = await connectClient(room);
      c2.sendJson({ t: "join", room, displayName: "Alice", rejoinToken: ticket, resume: true });
      const w2 = await c2.reader.readJson();
      expect(w2.selfId).toBe(selfId);

      c2.socket.destroy();
    });

    it("T2.11: relays signal to target peer and returns unknown-peer for non-existent target", async () => {
      const room = generateRoomCode();
      const p1 = await connectClient(room);
      p1.sendJson({ t: "join", room, displayName: "P1" });
      const w1 = await p1.reader.readJson();

      const p2 = await connectClient(room);
      p2.sendJson({ t: "join", room, displayName: "P2" });
      const w2 = await p2.reader.readJson();
      await p1.reader.readJson(); // peer-joined

      // Valid signal from P1 to P2
      p1.sendJson({ t: "signal", to: w2.selfId, data: { k: "answer", sdp: "v=0\r\n" } });
      const sig = await p2.reader.readJson();
      expect(sig).toEqual({
        t: "signal",
        from: w1.selfId,
        data: { k: "answer", sdp: "v=0\r\n" },
      });

      // Signal to unknown peer
      p1.sendJson({ t: "signal", to: "11111111-1111-1111-1111-111111111111", data: { k: "answer", sdp: "v=0\r\n" } });
      const err = await p1.reader.readJson();
      expect(err.code).toBe("unknown-peer");

      p1.socket.destroy();
      p2.socket.destroy();
    });

    it("T2.12: broadcasts peer-state when sharing flag changes", async () => {
      const room = generateRoomCode();
      const p1 = await connectClient(room);
      p1.sendJson({ t: "join", room, displayName: "Sharer" });
      const w1 = await p1.reader.readJson();

      const p2 = await connectClient(room);
      p2.sendJson({ t: "join", room, displayName: "Viewer" });
      await p2.reader.readJson(); // welcome
      await p1.reader.readJson(); // peer-joined

      p1.sendJson({ t: "state", sharing: true });
      const stateBroadcast = await p2.reader.readJson();
      expect(stateBroadcast).toEqual({
        t: "peer-state",
        id: w1.selfId,
        sharing: true,
      });

      p1.socket.destroy();
      p2.socket.destroy();
    });
  });
});
