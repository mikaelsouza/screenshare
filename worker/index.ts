import { generateRoomCode, isValidRoomCode } from "@shared/protocol";
import { RateLimiter } from "./ratelimit";
import { RoomDO } from "./room";
import { TRY_AGAIN_LATER, isUpgrade, rejectUpgrade } from "./upgrade";

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<RoomDO>;
  TURN_KEY_ID: string;        // wrangler secret
  TURN_API_TOKEN: string;     // wrangler secret
}

export { RoomDO };

/**
 * Per-IP room-creation throttle. See RateLimiter for the isolate-scoping caveat:
 * this blunts a trivial flood, it is not a global guarantee.
 */
const roomCreationLimit = new RateLimiter(20, 60_000, 10_000);

/**
 * Per-IP throttle on WebSocket upgrades.
 *
 * /api/room only returns a random string; /ws/:code is the expensive one, because
 * idFromName() instantiates a Durable Object for any format-valid code. Without a
 * limit here one client can spin up unbounded distinct Durable Objects by cycling
 * random codes, and the per-room MAX_SOCKETS_PER_IP cap cannot see it — that cap is
 * per-object, and this attack never uses the same object twice.
 *
 * Generous enough that reconnect backoff and a houseful of tabs never reach it.
 */
const wsUpgradeLimit = new RateLimiter(60, 60_000, 10_000);

function checkRoomRateLimit(ip: string): boolean {
  return roomCreationLimit.check(ip);
}

function applySecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // script-src has no 'unsafe-inline': neither page carries an inline <script> (both
  // load a module by src, and Vite emits external chunks), so allowing it would
  // re-open the main class of XSS that CSP exists to stop and buy nothing. style-src
  // keeps it, because both pages do have an inline <style> block.
  //
  // connect-src is 'self' rather than a blanket `wss: ws:`. The signalling socket is
  // same-origin, and in an app whose whole point is that media never leaves a direct
  // peer link, "any host, any WebSocket" is a ready-made exfiltration channel for
  // injected script. rtc.live.cloudflare.com is not listed because only the Worker
  // ever talks to it — the page never does.
  //
  // base-uri and form-action do not inherit from default-src, so they need saying.
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "object-src 'none'",
    ].join("; "),
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
      // A JSON body is unreadable by a WebSocket client: a non-101 answer reaches the
      // page as a bare 1006, which it retries forever. Speak the refusal over the
      // socket when one was asked for, and keep JSON only for a plain HTTP probe.
      if (!isValidRoomCode(code)) {
        return isUpgrade(request)
          ? rejectUpgrade("bad-room-code", "That room code is not valid")
          : new Response(JSON.stringify({ error: "Invalid room code" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
      }
      const clientIp = request.headers.get("CF-Connecting-IP");
      if (clientIp && !wsUpgradeLimit.check(clientIp)) {
        return isUpgrade(request)
          ? rejectUpgrade("rate-limited", "Too many connection attempts", TRY_AGAIN_LATER)
          : new Response(JSON.stringify({ error: "Too many connection attempts" }), {
              status: 429,
              headers: { "Content-Type": "application/json", "Retry-After": "60" },
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
