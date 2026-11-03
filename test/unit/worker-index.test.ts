// @ts-nocheck
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import { isValidRoomCode } from "@shared/protocol";

let worker: any;

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

function createMockEnv(): Env {
  const roomFetch = vi.fn(async (_req: Request) => new WorkerMockResponse("room-stub-response", { status: 200 }));
  const roomGet = vi.fn((_id: any) => ({
    fetch: roomFetch,
  }));
  const idFromName = vi.fn((name: string) => ({
    toString: () => `id-${name}`,
    name,
  }));

  const assetFetch = vi.fn(async (_req: Request) => new WorkerMockResponse("<html>index</html>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  }));

  return {
    ASSETS: { fetch: assetFetch } as any,
    ROOMS: {
      idFromName: idFromName as any,
      get: roomGet as any,
    } as any,
    WS_LIMITER: undefined,
    ROOM_LIMITER: undefined,
  };
}

describe("worker/index routing & security headers", () => {
  let env: any;

  beforeAll(async () => {
    const mod = await import(String("@worker/index"));
    worker = mod.default;
  });

  beforeEach(() => {
    (globalThis as any).WebSocketPair = MockWebSocketPair;
    (globalThis as any).Response = WorkerMockResponse;
    env = createMockEnv();
  });

  afterEach(() => {
    (globalThis as any).Response = OriginalResponse;
    vi.restoreAllMocks();
  });

  describe("Security Headers", () => {
    it("applies strict security headers to normal HTTP responses", async () => {
      const req = new Request("https://screenshare.example.com/assets/app.js");
      const res = await worker.fetch(req, env);

      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
      expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      expect(res.headers.get("Permissions-Policy")).toContain("display-capture=(self)");
      expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
      expect(res.headers.get("Permissions-Policy")).toContain("microphone=()");

      const csp = res.headers.get("Content-Security-Policy") || "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("img-src 'self' data:");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("require-trusted-types-for 'script'");
      expect(csp).toContain("trusted-types 'none'");
    });

    it("applies HSTS only for HTTPS on non-localhost/non-127.0.0.1 hosts", async () => {
      // Remote HTTPS -> HSTS present
      const reqHttps = new Request("https://screenshare.example.com/");
      const resHttps = await worker.fetch(reqHttps, env);
      expect(resHttps.headers.get("Strict-Transport-Security")).toBe(
        "max-age=63072000; includeSubDomains",
      );

      // HTTP -> HSTS omitted
      const reqHttp = new Request("http://screenshare.example.com/");
      const resHttp = await worker.fetch(reqHttp, env);
      expect(resHttp.headers.get("Strict-Transport-Security")).toBeNull();

      // Localhost HTTPS -> HSTS omitted
      const reqLocalhost = new Request("https://localhost:8787/");
      const resLocalhost = await worker.fetch(reqLocalhost, env);
      expect(resLocalhost.headers.get("Strict-Transport-Security")).toBeNull();

      // 127.0.0.1 HTTPS -> HSTS omitted
      const reqIpLocal = new Request("https://127.0.0.1:8787/");
      const resIpLocal = await worker.fetch(reqIpLocal, env);
      expect(resIpLocal.headers.get("Strict-Transport-Security")).toBeNull();
    });

    it("preserves 101 WebSocket responses without applying security headers that break upgrades", async () => {
      const req = new Request("http://localhost/ws/INVALIDCODE", {
        headers: { Upgrade: "websocket" },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(101);
      expect(res.webSocket).toBeDefined();
    });
  });

  describe("GET /api/room", () => {
    it("generates a fresh 8-char room code with Cache-Control: no-store", async () => {
      const req = new Request("http://localhost/api/room");
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const data = (await res.json()) as { code: string };
      expect(typeof data.code).toBe("string");
      expect(data.code.length).toBe(8);
      expect(isValidRoomCode(data.code)).toBe(true);
    });

    it("rate-limits room creation after 20 attempts from same IP within a minute", async () => {
      const clientIp = "198.51.100.42";
      for (let i = 0; i < 20; i++) {
        const req = new Request("http://localhost/api/room", {
          headers: { "CF-Connecting-IP": clientIp },
        });
        const res = await worker.fetch(req, env);
        expect(res.status).toBe(200);
      }

      // 21st request from same IP should be blocked
      const blockedReq = new Request("http://localhost/api/room", {
        headers: { "CF-Connecting-IP": clientIp },
      });
      const blockedRes = await worker.fetch(blockedReq, env);
      expect(blockedRes.status).toBe(429);
      expect(blockedRes.headers.get("Retry-After")).toBe("60");
      const body = (await blockedRes.json()) as { error: string };
      expect(body.error).toBe("Rate limit exceeded");

      // Different IP is still allowed
      const otherReq = new Request("http://localhost/api/room", {
        headers: { "CF-Connecting-IP": "198.51.100.99" },
      });
      const otherRes = await worker.fetch(otherReq, env);
      expect(otherRes.status).toBe(200);
    });

    it("respects Cloudflare ROOM_LIMITER binding when present", async () => {
      env.ROOM_LIMITER = {
        limit: vi.fn(async () => ({ success: false })),
      } as any;

      const req = new Request("http://localhost/api/room", {
        headers: { "CF-Connecting-IP": "203.0.113.10" },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(429);
    });

    it("fails open if Cloudflare ROOM_LIMITER binding throws", async () => {
      env.ROOM_LIMITER = {
        limit: vi.fn(async () => {
          throw new Error("Binding RPC error");
        }),
      } as any;

      const req = new Request("http://localhost/api/room", {
        headers: { "CF-Connecting-IP": "203.0.113.11" },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
    });
  });

  describe("GET /ws/:code", () => {
    const validCode = "ABCDEFGH";

    it("rejects invalid room code with HTTP 400 for normal HTTP requests", async () => {
      const req = new Request("http://localhost/ws/invalid-room-code");
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe("Invalid room code");
    });

    it("rejects invalid room code with 101 WebSocket rejectUpgrade for WebSocket requests", async () => {
      const req = new Request("http://localhost/ws/INVALID99", {
        headers: { Upgrade: "websocket" },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(101);
      expect(res.webSocket).toBeDefined();
    });

    it("forwards valid room code to Durable Object namespace", async () => {
      const req = new Request(`http://localhost/ws/${validCode}`, {
        headers: { Upgrade: "websocket" },
      });
      const res = await worker.fetch(req, env);
      expect(env.ROOMS.idFromName).toHaveBeenCalledWith(validCode);
      expect(env.ROOMS.get).toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("room-stub-response");
    });

    it("rate-limits excessive WebSocket upgrades from same IP", async () => {
      const clientIp = "192.0.2.1";
      for (let i = 0; i < 60; i++) {
        const req = new Request(`http://localhost/ws/${validCode}`, {
          headers: {
            "CF-Connecting-IP": clientIp,
            Upgrade: "websocket",
          },
        });
        const res = await worker.fetch(req, env);
        expect(res.status).toBe(200);
      }

      // 61st upgrade attempt fails with 101 rate-limited (TRY_AGAIN_LATER)
      const wsReq = new Request(`http://localhost/ws/${validCode}`, {
        headers: {
          "CF-Connecting-IP": clientIp,
          Upgrade: "websocket",
        },
      });
      const wsRes = await worker.fetch(wsReq, env);
      expect(wsRes.status).toBe(101);
      expect(wsRes.webSocket).toBeDefined();

      // 61st non-WS attempt fails with 429
      const httpReq = new Request(`http://localhost/ws/${validCode}`, {
        headers: { "CF-Connecting-IP": clientIp },
      });
      const httpRes = await worker.fetch(httpReq, env);
      expect(httpRes.status).toBe(429);
      expect(httpRes.headers.get("Retry-After")).toBe("60");
    });

    it("respects Cloudflare WS_LIMITER binding when present", async () => {
      env.WS_LIMITER = {
        limit: vi.fn(async () => ({ success: false })),
      } as any;

      const req = new Request(`http://localhost/ws/${validCode}`, {
        headers: {
          "CF-Connecting-IP": "192.0.2.200",
          Upgrade: "websocket",
        },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(101);
    });
  });

  describe("Fallback to ASSETS", () => {
    it("routes other paths to env.ASSETS.fetch", async () => {
      const req = new Request("http://localhost/index.html");
      const res = await worker.fetch(req, env);
      expect(env.ASSETS.fetch).toHaveBeenCalledWith(req);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<html>index</html>");
    });
  });
});
