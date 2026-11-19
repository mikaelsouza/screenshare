import { describe, expect, it, vi } from "vitest";
import {
  TRY_AGAIN_LATER,
  isUpgrade,
  rejectUpgrade,
  type UpgradeRuntime,
  type UpgradeServerSocket,
} from "@worker/upgrade";

describe("worker/upgrade", () => {
  it("isUpgrade detects case-insensitive Upgrade: websocket header", () => {
    expect(isUpgrade(new Request("https://example.com/ws/ABCD2345", { headers: { Upgrade: "websocket" } }))).toBe(true);
    expect(isUpgrade(new Request("https://example.com/ws/ABCD2345", { headers: { Upgrade: "WebSocket" } }))).toBe(true);
    expect(isUpgrade(new Request("https://example.com/ws/ABCD2345", { headers: { Upgrade: "h2c" } }))).toBe(false);
    expect(isUpgrade(new Request("https://example.com/ws/ABCD2345"))).toBe(false);
  });

  it("rejectUpgrade accepts server socket, sends error JSON, closes with code, and returns upgrade response", () => {
    const sent: string[] = [];
    const closed: Array<{ code: number | undefined; reason: string | undefined }> = [];
    const clientToken = { client: true };
    const accept = vi.fn();
    const send = vi.fn((data: string) => sent.push(data));
    const close = vi.fn((code?: number, reason?: string) => closed.push({ code, reason }));
    const server: UpgradeServerSocket = { accept, send, close };
    const runtime: UpgradeRuntime<typeof clientToken, { status: number; client: typeof clientToken }> = {
      createPair: () => [clientToken, server],
      createUpgradeResponse: (client) => ({ status: 101, client }),
    };

    const res = rejectUpgrade("rate-limited", "Slow down", TRY_AGAIN_LATER, runtime);
    expect(res).toEqual({ status: 101, client: clientToken });
    expect(accept).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([JSON.stringify({ t: "error", code: "rate-limited", message: "Slow down" })]);
    expect(closed).toEqual([{ code: 1013, reason: "Slow down" }]);
  });

  it("rejectUpgrade tolerates send() and close() throwing on already-closed sockets", () => {
    const accept = vi.fn();
    const send = vi.fn(() => {
      throw new Error("send failed");
    });
    const close = vi.fn(() => {
      throw new Error("close failed");
    });
    const server: UpgradeServerSocket = { accept, send, close };
    const runtime: UpgradeRuntime<string, string> = {
      createPair: () => ["client-ws", server],
      createUpgradeResponse: (client) => `101:${client}`,
    };

    expect(rejectUpgrade("forbidden-origin", "Nope", 1008, runtime)).toBe("101:client-ws");
    expect(accept).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(1008, "Nope");
  });

  it("rejectUpgrade default runtime throws cleanly when WebSocketPair is absent and uses global WebSocketPair when present", () => {
    expect(() => rejectUpgrade("bad-room-code", "Invalid")).toThrow("WebSocketPair is not available");

    const accept = vi.fn();
    const send = vi.fn();
    const close = vi.fn();
    const origResponse = globalThis.Response;
    class FakePair {
      0 = { fakeClient: true };
      1 = { accept, send, close };
    }
    class FakeResponse extends origResponse {
      readonly upgradeStatus: number;
      readonly upgradeSocket: unknown;
      constructor(_body: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
        super(null, { status: 200 });
        this.upgradeStatus = init?.status ?? 200;
        this.upgradeSocket = init?.webSocket;
      }
    }
    Object.defineProperty(globalThis, "WebSocketPair", { value: FakePair, configurable: true, writable: true });
    Object.defineProperty(globalThis, "Response", { value: FakeResponse, configurable: true, writable: true });
    try {
      const res = rejectUpgrade("bad-room-code", "Bad code");
      expect(res).toBeInstanceOf(FakeResponse);
      expect((res as FakeResponse).upgradeStatus).toBe(101);
      expect((res as FakeResponse).upgradeSocket).toEqual({ fakeClient: true });
      expect(accept).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(JSON.stringify({ t: "error", code: "bad-room-code", message: "Bad code" }));
      expect(close).toHaveBeenCalledWith(1008, "Bad code");
    } finally {
      Reflect.deleteProperty(globalThis, "WebSocketPair");
      Object.defineProperty(globalThis, "Response", { value: origResponse, configurable: true, writable: true });
    }
  });

  it("rejectUpgrade default runtime validates WebSocketPair shape, server socket methods, and Response instance", () => {
    const origResponse = globalThis.Response;
    const baseSocket = { accept: vi.fn(), send: vi.fn(), close: vi.fn() };
    const invalidServers: unknown[] = [
      null,
      "not-an-object",
      { send: vi.fn(), close: vi.fn() },
      { accept: "nope", send: vi.fn(), close: vi.fn() },
      { accept: vi.fn(), close: vi.fn() },
      { accept: vi.fn(), send: 123, close: vi.fn() },
      { accept: vi.fn(), send: vi.fn() },
      { accept: vi.fn(), send: vi.fn(), close: null },
    ];

    try {
      // Malformed WebSocketPair returning a primitive
      function PrimitivePair(): unknown {
        return null;
      }
      Object.defineProperty(globalThis, "WebSocketPair", { value: PrimitivePair, configurable: true, writable: true });
      expect(() => rejectUpgrade("bad-room-code", "Bad")).toThrow("Invalid WebSocketPair server socket");

      // Invalid server socket shapes
      for (const badServer of invalidServers) {
        class BadServerPair {
          0 = { client: true };
          1 = badServer;
        }
        Object.defineProperty(globalThis, "WebSocketPair", { value: BadServerPair, configurable: true, writable: true });
        expect(() => rejectUpgrade("bad-room-code", "Bad")).toThrow("Invalid WebSocketPair server socket");
      }

      // Constructor must receive zero arguments and Response must be a real Response instance
      let receivedArgs: unknown[] = ["sentinel"];
      class ValidPair {
        0 = { client: true };
        1 = baseSocket;
        constructor(...args: unknown[]) {
          receivedArgs = args;
        }
      }
      function NonResponse(): object {
        return { fake: true };
      }
      Object.defineProperty(globalThis, "WebSocketPair", { value: ValidPair, configurable: true, writable: true });
      Object.defineProperty(globalThis, "Response", { value: NonResponse, configurable: true, writable: true });
      expect(() => rejectUpgrade("bad-room-code", "Bad")).toThrow("Failed to construct WebSocket upgrade response");
      expect(receivedArgs).toEqual([]);
    } finally {
      Reflect.deleteProperty(globalThis, "WebSocketPair");
      Object.defineProperty(globalThis, "Response", { value: origResponse, configurable: true, writable: true });
    }
  });
});

