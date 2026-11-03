// @ts-nocheck
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { startLocalServer, generateRoomCode } from "@electron/server.js";

describe("RFC 6455 WebSocket Frame Decoder (Feature 30)", () => {
  let serverInstance: Awaited<ReturnType<typeof startLocalServer>>;
  let port: number;
  let roomCode: string;

  beforeAll(async () => {
    serverInstance = await startLocalServer({ port: 0 });
    port = serverInstance.port;
    roomCode = generateRoomCode();
  });

  afterAll(async () => {
    await serverInstance.close();
  });

  function connectAndHandshake(customCode = generateRoomCode()): Promise<{ socket: net.Socket; reader: FrameReader; code: string }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
        socket.write(
          `GET /ws/${customCode} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
        );
      });

      let handshakeBuf = "";
      function onHandshakeData(data: Buffer) {
        handshakeBuf += data.toString("utf8");
        if (handshakeBuf.includes("\r\n\r\n")) {
          socket.off("data", onHandshakeData);
          if (handshakeBuf.includes("101 Switching Protocols")) {
            const reader = new FrameReader(socket);
            resolve({ socket, reader, code: customCode });
          } else {
            reject(new Error(`Handshake failed: ${handshakeBuf}`));
          }
        }
      }

      socket.on("data", onHandshakeData);
      socket.on("error", reject);
    });
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
  }

  describe("T1.1 - T1.3: 7-bit, 16-bit, and 64-bit Payload Lengths", () => {
    it("T1.1: decodes standard 7-bit length frame (< 126 bytes)", async () => {
      const { socket, reader, code } = await connectAndHandshake();
      const joinMsg = JSON.stringify({ t: "join", room: code, displayName: "Short" });
      const frame = buildMaskedFrame(0x1, joinMsg);

      const framePromise = reader.read();
      socket.write(frame);

      const { opcode, payload } = await framePromise;
      expect(opcode).toBe(0x1);
      const res = JSON.parse(payload.toString("utf8"));
      expect(res.t).toBe("welcome");
      socket.destroy();
    });

    it("T1.2: decodes 16-bit extended length frame (126 <= len <= 65535)", async () => {
      const { socket, reader, code } = await connectAndHandshake();
      // Join room first
      socket.write(buildMaskedFrame(0x1, JSON.stringify({ t: "join", room: code, displayName: "Host16" })));
      await reader.read();

      // Send 1KB signal payload (length = 1024)
      const bigSignal = JSON.stringify({
        t: "signal",
        to: "00000000-0000-0000-0000-000000000000",
        data: { k: "offer", sdp: "a".repeat(1000) },
      });
      expect(Buffer.byteLength(bigSignal)).toBeGreaterThan(125);

      const frame = buildMaskedFrame(0x1, bigSignal);
      const framePromise = reader.read();
      socket.write(frame);

      const { opcode, payload } = await framePromise;
      expect(opcode).toBe(0x1);
      const parsed = JSON.parse(payload.toString("utf8"));
      expect(parsed.code).toBe("unknown-peer");
      socket.destroy();
    });

    it("T1.3: decodes 64-bit extended length frame (> 65535 bytes)", async () => {
      const { socket, reader, code } = await connectAndHandshake();
      socket.write(buildMaskedFrame(0x1, JSON.stringify({ t: "join", room: code, displayName: "Host64" })));
      await reader.read();

      // Frame with length 65,536 bytes
      const bigSdp = JSON.stringify({
        t: "signal",
        to: "00000000-0000-0000-0000-000000000000",
        data: { k: "offer", sdp: "b".repeat(65540) },
      });
      expect(Buffer.byteLength(bigSdp)).toBeGreaterThan(65535);

      const frame = buildMaskedFrame(0x1, bigSdp);
      const framePromise = reader.read();
      socket.write(frame);

      const { opcode, payload } = await framePromise;
      expect(opcode).toBe(0x1);
      const parsed = JSON.parse(payload.toString("utf8"));
      expect(parsed.code).toBe("unknown-peer");
      socket.destroy();
    });
  });

  describe("T1.4 - T1.5: Masking Key Invariant & Unmasked Frames", () => {
    it("T1.4: unmasks payload correctly using various 4-byte masks", async () => {
      const masks = [
        Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
        Buffer.from([0xff, 0xff, 0xff, 0xff]),
        Buffer.from([0x42, 0x13, 0x9a, 0x7f]),
      ];

      for (const mask of masks) {
        const { socket, reader, code } = await connectAndHandshake();
        const msg = JSON.stringify({ t: "join", room: code, displayName: "MaskTester" });
        const frame = buildMaskedFrame(0x1, msg, mask);

        const framePromise = reader.read();
        socket.write(frame);

        const { payload } = await framePromise;
        const res = JSON.parse(payload.toString("utf8"));
        expect(res.t).toBe("welcome");
        socket.destroy();
      }
    });

    it("T1.5: parses unmasked client frames (mask bit = 0) without corruption", async () => {
      const { socket, reader, code } = await connectAndHandshake();
      const msg = JSON.stringify({ t: "join", room: code, displayName: "Unmasked" });
      const payloadBuf = Buffer.from(msg, "utf8");

      const unmaskedFrame = Buffer.concat([
        Buffer.from([0x81, payloadBuf.length]),
        payloadBuf,
      ]);

      const framePromise = reader.read();
      socket.write(unmaskedFrame);

      const { payload } = await framePromise;
      const res = JSON.parse(payload.toString("utf8"));
      expect(res.t).toBe("welcome");
      socket.destroy();
    });
  });

  describe("T1.6 - T1.7: Control Frames: Ping & Close", () => {
    it("T1.6: echoes Pong (0xA) immediately when Ping (0x9) is received", async () => {
      const { socket, reader } = await connectAndHandshake();
      const pingPayload = Buffer.from("pingData42", "utf8");
      const pingFrame = buildMaskedFrame(0x9, pingPayload);

      const framePromise = reader.read();
      socket.write(pingFrame);

      const { opcode, payload } = await framePromise;
      expect(opcode).toBe(0xa); // Pong opcode
      expect(payload.toString("utf8")).toBe("pingData42");
      socket.destroy();
    });

    it("T1.7: echoes Close (0x8) and terminates socket on Close frame", async () => {
      const { socket, reader } = await connectAndHandshake();
      const closePayload = Buffer.alloc(2);
      closePayload.writeUInt16BE(1000, 0); // Normal closure
      const closeFrame = buildMaskedFrame(0x8, closePayload);

      const framePromise = reader.read();
      socket.write(closeFrame);

      const { opcode } = await framePromise;
      expect(opcode).toBe(0x8);
      // Socket should close
      await new Promise((resolve) => socket.on("close", resolve));
      expect(socket.destroyed).toBe(true);
    });
  });

  describe("T1.8 - T1.9: Fragmentation & Pipelined Frames", () => {
    it("T1.8: buffers fragmented frames split across multiple TCP chunks", async () => {
      const { socket, reader } = await connectAndHandshake();
      const msg = JSON.stringify({ t: "join", room: roomCode, displayName: "Fragmented" });
      const frame = buildMaskedFrame(0x1, msg);

      // Split frame into 3 parts: byte 0, bytes 1-5, and remainder
      const chunk1 = frame.subarray(0, 1);
      const chunk2 = frame.subarray(1, 6);
      const chunk3 = frame.subarray(6);

      const framePromise = reader.read();

      socket.write(chunk1);
      await new Promise((r) => setTimeout(r, 20));
      socket.write(chunk2);
      await new Promise((r) => setTimeout(r, 20));
      socket.write(chunk3);

      const { payload } = await framePromise;
      const res = JSON.parse(payload.toString("utf8"));
      expect(res.t).toBe("welcome");
      socket.destroy();
    });

    it("T1.9: dispatches multiple pipelined frames batched in a single TCP chunk", async () => {
      const { socket, reader } = await connectAndHandshake();
      const msg1 = JSON.stringify({ t: "join", room: roomCode, displayName: "Batch" });
      const frame1 = buildMaskedFrame(0x1, msg1);

      const pingFrame = buildMaskedFrame(0x9, "pingBatch");

      // Concatenate both frames into single write
      const batched = Buffer.concat([frame1, pingFrame]);

      const promise1 = reader.read();
      socket.write(batched);

      const frameOut1 = await promise1;
      expect(frameOut1.opcode).toBe(0x1);
      expect(JSON.parse(frameOut1.payload.toString()).t).toBe("welcome");

      const frameOut2 = await reader.read();
      expect(frameOut2.opcode).toBe(0xa);
      expect(frameOut2.payload.toString()).toBe("pingBatch");

      socket.destroy();
    });
  });
});
