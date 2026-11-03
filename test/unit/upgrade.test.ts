// @ts-nocheck
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

let TRY_AGAIN_LATER: any;
let isUpgrade: any;
let rejectUpgrade: any;

class MockWebSocket {
  sent: string[] = [];
  closedWith: { code: number; reason?: string } | null = null;
  accepted = false;

  accept() {
    this.accepted = true;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code: number, reason?: string) {
    this.closedWith = { code, reason };
  }
}

class MockWebSocketPair {
  [0]: MockWebSocket;
  [1]: MockWebSocket;
  constructor() {
    this[0] = new MockWebSocket();
    this[1] = new MockWebSocket();
  }
}

const OriginalResponse = globalThis.Response;

class WorkerMockResponse extends OriginalResponse {
  override webSocket?: any;
  private _status = 200;
  private _statusText = "";

  constructor(body?: any, init?: ResponseInit & { webSocket?: any }) {
    if (init && init.status === 101) {
      super(null, { ...init, status: 200 });
      this._status = 101;
      this._statusText = init.statusText ?? "Switching Protocols";
      this.webSocket = init.webSocket;
    } else {
      super(body, init);
      this._status = init?.status ?? 200;
      this._statusText = init?.statusText ?? "OK";
    }
  }

  override get status(): number {
    return this._status;
  }

  override get statusText(): string {
    return this._statusText;
  }
}

describe("worker/upgrade", () => {
  beforeAll(async () => {
    const mod = await import(String("@worker/upgrade"));
    TRY_AGAIN_LATER = mod.TRY_AGAIN_LATER;
    isUpgrade = mod.isUpgrade;
    rejectUpgrade = mod.rejectUpgrade;
  });

  beforeEach(() => {
    (globalThis as any).WebSocketPair = MockWebSocketPair;
    (globalThis as any).Response = WorkerMockResponse;
  });

  afterEach(() => {
    (globalThis as any).Response = OriginalResponse;
  });

  describe("TRY_AGAIN_LATER", () => {
    it("is RFC close code 1013", () => {
      expect(TRY_AGAIN_LATER).toBe(1013);
    });
  });

  describe("isUpgrade", () => {
    it("returns true for Upgrade: websocket (case-insensitive)", () => {
      const req1 = new Request("http://localhost/ws/ABCDEFGH", {
        headers: { Upgrade: "websocket" },
      });
      const req2 = new Request("http://localhost/ws/ABCDEFGH", {
        headers: { Upgrade: "WebSocket" },
      });
      const req3 = new Request("http://localhost/ws/ABCDEFGH", {
        headers: { UPGRADE: "WEBSOCKET" },
      });
      expect(isUpgrade(req1)).toBe(true);
      expect(isUpgrade(req2)).toBe(true);
      expect(isUpgrade(req3)).toBe(true);
    });

    it("returns false when Upgrade header is missing", () => {
      const req = new Request("http://localhost/ws/ABCDEFGH");
      expect(isUpgrade(req)).toBe(false);
    });

    it("returns false for non-websocket upgrade headers", () => {
      const req = new Request("http://localhost/ws/ABCDEFGH", {
        headers: { Upgrade: "h2c" },
      });
      expect(isUpgrade(req)).toBe(false);
    });
  });

  describe("rejectUpgrade", () => {
    it("returns a 101 Response carrying the client socket", () => {
      const res = rejectUpgrade("bad-room-code", "Invalid room code", 1008);
      expect(res.status).toBe(101);
      expect((res as any).webSocket).toBeDefined();
    });

    it("accepts server socket, sends error payload, and closes with specified code and message", () => {
      let createdPair: MockWebSocketPair | null = null;
      (globalThis as any).WebSocketPair = class extends MockWebSocketPair {
        constructor() {
          super();
          createdPair = this;
        }
      };

      const res = rejectUpgrade("rate-limited", "Too many attempts", TRY_AGAIN_LATER);
      expect(res.status).toBe(101);
      expect(createdPair).not.toBeNull();
      const serverWs = createdPair![1];

      expect(serverWs.accepted).toBe(true);
      expect(serverWs.sent.length).toBe(1);
      expect(JSON.parse(serverWs.sent[0]!)).toEqual({
        t: "error",
        code: "rate-limited",
        message: "Too many attempts",
      });
      expect(serverWs.closedWith).toEqual({
        code: 1013,
        reason: "Too many attempts",
      });
    });

    it("defaults closeCode to 1008 when omitted", () => {
      let createdPair: MockWebSocketPair | null = null;
      (globalThis as any).WebSocketPair = class extends MockWebSocketPair {
        constructor() {
          super();
          createdPair = this;
        }
      };

      rejectUpgrade("room-locked", "Room is locked");
      const serverWs = createdPair![1];
      expect(serverWs.closedWith?.code).toBe(1008);
      expect(serverWs.closedWith?.reason).toBe("Room is locked");
    });

    it("handles socket send or close throwing gracefully without uncaught exceptions", () => {
      (globalThis as any).WebSocketPair = class {
        [0] = new MockWebSocket();
        [1] = {
          accepted: false,
          accept() {
            this.accepted = true;
          },
          send: vi.fn(() => {
            throw new Error("Socket broken");
          }),
          close: vi.fn(() => {
            throw new Error("Socket already closed");
          }),
        };
      };

      expect(() => rejectUpgrade("bad-message", "Malformed")).not.toThrow();
    });
  });
});
