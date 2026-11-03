// @ts-nocheck
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { startLocalServer, isValidRoomCode, generateRoomCode } from "@electron/server.js";

describe("Embedded HTTP Server & Upgrade Validation (Feature 30)", () => {
  let serverInstance: Awaited<ReturnType<typeof startLocalServer>>;
  let baseUrl: string;
  let port: number;

  beforeAll(async () => {
    serverInstance = await startLocalServer({ port: 0 });
    baseUrl = serverInstance.url;
    port = serverInstance.port;
  });

  afterAll(async () => {
    await serverInstance.close();
  });

  function sendRawUpgrade(reqHeaders: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
        socket.write(reqHeaders);
      });

      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });

      socket.on("end", () => resolve(data));
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
    });
  }

  describe("T3.1: Security Headers Verification", () => {
    it("attaches all required security headers to HTTP responses", async () => {
      const res = await fetch(`${baseUrl}/api/room`);
      expect(res.status).toBe(200);

      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");

      const csp = res.headers.get("content-security-policy") || "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("connect-src 'self' ws: wss:");
      expect(csp).toContain("frame-ancestors 'none'");

      const permissions = res.headers.get("permissions-policy") || "";
      expect(permissions).toContain("display-capture=(self)");
      expect(permissions).toContain("camera=()");
      expect(permissions).toContain("microphone=()");
      expect(permissions).toContain("geolocation=()");
    });
  });

  describe("T3.2: /api/room Endpoint", () => {
    it("returns 200 with Cache-Control: no-store and a valid 8-char room code", async () => {
      const res = await fetch(`${baseUrl}/api/room`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");

      const data = (await res.json()) as { code: string };
      expect(typeof data.code).toBe("string");
      expect(data.code.length).toBe(8);
      expect(isValidRoomCode(data.code)).toBe(true);
    });

    it("generates distinct random room codes on consecutive calls", async () => {
      const res1 = await fetch(`${baseUrl}/api/room`);
      const res2 = await fetch(`${baseUrl}/api/room`);
      const data1 = (await res1.json()) as { code: string };
      const data2 = (await res2.json()) as { code: string };
      expect(data1.code).not.toBe(data2.code);
    });
  });

  describe("T3.3: Directory Traversal Defense", () => {
    it("blocks directory traversal attempts with HTTP 403 Forbidden", async () => {
      // %2f preserves slashes across URL parsing, which decodeURIComponent then resolves to .. traversal
      const res = await fetch(`${baseUrl}/static/..%2f..%2fetc/passwd`);
      expect(res.status).toBe(403);
    });
  });

  describe("T3.4: Static Serving & HTTP Method Restrictions", () => {
    it("rejects non-GET/HEAD methods with HTTP 405 Method Not Allowed", async () => {
      const resPost = await fetch(`${baseUrl}/api/room`, { method: "POST" });
      expect(resPost.status).toBe(405);

      const resPut = await fetch(`${baseUrl}/something`, { method: "PUT" });
      expect(resPut.status).toBe(405);
    });
  });

  describe("T3.5: WebSocket Upgrade Handshake Validation", () => {
    it("rejects invalid room code format with HTTP 400 Bad Request", async () => {
      const req =
        `GET /ws/INVALID-CODE HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`;

      const response = await sendRawUpgrade(req);
      expect(response).toContain("HTTP/1.1 400 Bad Request");
      expect(response).toContain("Invalid room code");
    });

    it("rejects upgrade when Upgrade header is not websocket", async () => {
      const code = generateRoomCode();
      const req =
        `GET /ws/${code} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: raw-socket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`;

      const response = await sendRawUpgrade(req);
      expect(response).toContain("HTTP/1.1 400 Bad Request");
    });

    it("rejects upgrade when Sec-WebSocket-Key header is missing", async () => {
      const code = generateRoomCode();
      const req =
        `GET /ws/${code} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`;

      const response = await sendRawUpgrade(req);
      expect(response).toContain("HTTP/1.1 400 Bad Request");
    });

    it("completes RFC 6455 101 Switching Protocols handshake for valid requests", async () => {
      const code = generateRoomCode();
      const key = "dGhlIHNhbXBsZSBub25jZQ==";
      const expectedAccept = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

      const req =
        `GET /ws/${code} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`;

      return new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
          socket.write(req);
        });

        socket.once("data", (chunk) => {
          const resp = chunk.toString();
          expect(resp).toContain("HTTP/1.1 101 Switching Protocols");
          expect(resp).toContain(`Sec-WebSocket-Accept: ${expectedAccept}`);
          socket.destroy();
          resolve();
        });

        socket.on("error", reject);
      });
    });
  });
});
