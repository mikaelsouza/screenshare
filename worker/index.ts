import { generateRoomCode, isValidRoomCode } from "@shared/protocol";
import { RoomDO } from "./room";

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<RoomDO>;
  TURN_KEY_ID: string;        // wrangler secret
  TURN_API_TOKEN: string;     // wrangler secret
}

export { RoomDO };

const roomCreationLimit = new Map<string, { count: number; resetAt: number }>();

function checkRoomRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = roomCreationLimit.get(ip);
  if (!entry || entry.resetAt <= now) {
    roomCreationLimit.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 20) {
    return false;
  }
  entry.count++;
  return true;
}

function applySecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss: ws: https://rtc.live.cloudflare.com; frame-ancestors 'none';",
  );
  headers.set("Permissions-Policy", "display-capture=(self), camera=(), microphone=()");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // GET /ws/:code -> validate with isValidRoomCode(); 400 if bad.
    // Forward the request unchanged to the Durable Object stub.
    const wsPrefix = "/ws/";
    if (request.method === "GET" && (url.pathname.startsWith(wsPrefix) || url.pathname === "/ws")) {
      const code = url.pathname.startsWith(wsPrefix) ? url.pathname.slice(wsPrefix.length) : "";
      if (!isValidRoomCode(code)) {
        return new Response(JSON.stringify({ error: "Invalid room code" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    // GET /api/room -> { code: generateRoomCode() } as JSON.
    if (request.method === "GET" && url.pathname === "/api/room") {
      const clientIp = request.headers.get("CF-Connecting-IP");
      if (clientIp && !checkRoomRateLimit(clientIp)) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "60" },
        });
      }
      return Response.json({ code: generateRoomCode() });
    }

    // Fallthrough to static assets with security headers applied
    const assetRes = await env.ASSETS.fetch(request);
    return applySecurityHeaders(assetRes);
  },
};
