// @ts-nocheck
import { describe, it, expect } from "vitest";
import fc from "fast-check";

/**
 * Headless reproduction of WebSocketConnection RFC 6455 frame processing from electron/server.js
 */
class WebSocketFrameDecoder {
  private buffer = Buffer.alloc(0);
  public messages: string[] = [];
  public closed: { code: number; reason: string } | null = null;

  constructor() {}

  pushData(chunk: Buffer) {
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

      let maskKey: Buffer | null = null;
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

      if (opcode === 0x08) {
        let code = 1000;
        let reason = "";
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString("utf8");
        }
        this.closed = { code, reason };
        return;
      } else if (opcode === 0x01) {
        this.messages.push(payload.toString("utf8"));
      }
    }
  }
}

/**
 * Name sanitizer matching electron/server.js
 */
function sanitiseName(raw: unknown): string {
  if (typeof raw !== "string") return "Anonymous";
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return [...cleaned].slice(0, 32).join("").trim() || "Anonymous";
}

describe("Fuzzing Suite: RFC 6455 Frame Decoder & Name Sanitizer (Features 46, 47)", () => {
  /**
   * Feature 46: Fuzz: Electron Frame Decoder
   * Tests stream fragmentation: arbitrary chunks and packet boundaries.
   */
  describe("Feature 46: RFC 6455 Frame Decoder Fuzzing", () => {
    function buildFrame(text: string, masked = true): Buffer {
      const payload = Buffer.from(text, "utf8");
      const len = payload.length;
      let header: Buffer;
      let offset = 2;

      if (len < 126) {
        header = Buffer.alloc(masked ? 6 : 2);
        header[0] = 0x81;
        header[1] = (masked ? 0x80 : 0) | len;
      } else if (len <= 65535) {
        header = Buffer.alloc(masked ? 8 : 4);
        header[0] = 0x81;
        header[1] = (masked ? 0x80 : 0) | 126;
        header.writeUInt16BE(len, 2);
        offset = 4;
      } else {
        header = Buffer.alloc(masked ? 14 : 10);
        header[0] = 0x81;
        header[1] = (masked ? 0x80 : 0) | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
        offset = 10;
      }

      if (masked) {
        const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
        mask.copy(header, offset);
        const maskedPayload = Buffer.alloc(len);
        for (let i = 0; i < len; i++) {
          maskedPayload[i] = payload[i] ^ mask[i % 4];
        }
        return Buffer.concat([header, maskedPayload]);
      } else {
        return Buffer.concat([header, payload]);
      }
    }

    it("correctly decodes messages regardless of packet fragmentation boundaries", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 500 }),
          fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 50 }),
          (message, chunkSizes) => {
            const frame = buildFrame(message, true);
            const decoder = new WebSocketFrameDecoder();

            // Feed frame in arbitrary fragmented chunks
            let pos = 0;
            let chunkIdx = 0;
            while (pos < frame.length) {
              const size = chunkSizes[chunkIdx % chunkSizes.length]!;
              const end = Math.min(pos + size, frame.length);
              decoder.pushData(frame.subarray(pos, end));
              pos = end;
              chunkIdx++;
            }

            expect(decoder.messages.length).toBe(1);
            expect(decoder.messages[0]).toBe(message);
            return true;
          }
        ),
        { numRuns: 300 }
      );
    });

    it("never crashes on arbitrary corrupt byte chunks", () => {
      fc.assert(
        fc.property(fc.uint8Array({ minLength: 0, maxLength: 2048 }), (randomBytes) => {
          const decoder = new WebSocketFrameDecoder();
          expect(() => {
            decoder.pushData(Buffer.from(randomBytes));
          }).not.toThrow();
          return true;
        }),
        { numRuns: 500 }
      );
    });
  });

  /**
   * Feature 47: Fuzz: Name Sanitizer
   * Handles 1MB inputs, unicode bidi overrides, zero-width joiners, and emoji sequences.
   */
  describe("Feature 47: Participant Name Sanitizer Fuzzing", () => {
    it("never throws and returns string of <= 32 code points", () => {
      fc.assert(
        fc.property(fc.string(), (raw) => {
          let cleaned: string = "";
          expect(() => {
            cleaned = sanitiseName(raw);
          }).not.toThrow();

          expect(typeof cleaned).toBe("string");
          // Code points count invariant
          expect([...cleaned].length).toBeLessThanOrEqual(32);
          expect(cleaned.length).toBeGreaterThan(0);
          return true;
        }),
        { numRuns: 1000 }
      );
    });

    it("handles large 1MB string inputs efficiently without hanging", () => {
      const hugeName = "A".repeat(1024 * 1024);
      const cleaned = sanitiseName(hugeName);
      expect(cleaned).toBe("A".repeat(32));
    });

    it("strips bidirectional control overrides and zero-width characters", () => {
      const bidiName = "\u202E\u200BRobert\u200D\u202C";
      const cleaned = sanitiseName(bidiName);
      expect(cleaned).toBe("Robert");
      expect(cleaned).not.toContain("\u202E");
      expect(cleaned).not.toContain("\u200B");
      expect(cleaned).not.toContain("\u200D");
    });
  });
});
