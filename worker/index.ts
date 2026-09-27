import { generateRoomCode, isValidRoomCode } from "@shared/protocol";
import { ipKey } from "./ipkey";
import { RateLimiter } from "./ratelimit";
import { RoomDO } from "./room";
import { TRY_AGAIN_LATER, isUpgrade, rejectUpgrade } from "./upgrade";

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<RoomDO>;
  TURN_KEY_ID: string;        // wrangler secret
  TURN_API_TOKEN: string;     // wrangler secret
  /**
   * Cloudflare's rate-limiting bindings (wrangler.jsonc `ratelimits`). Unlike the
   * in-memory RateLimiter these are shared across isolates in a location, so a client
   * cannot dodge them by landing on a fresh isolate. Optional so a missing binding
   * degrades to the in-memory limiter rather than taking the Worker down.
   */
  WS_LIMITER?: RateLimit;
  ROOM_LIMITER?: RateLimit;
  /** TURN mints per client, checked by the room on each join (worker/room.ts). */
  TURN_LIMITER?: RateLimit;
  /** Kill switch for TURN; see worker/turn.ts. */
  TURN_DISABLED?: string;
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

/**
 * Both limits must pass: the platform binding (shared, approximate) and the in-memory
 * one (exact within this isolate, and the only one present where the binding is not
 * configured).
 */
async function allowed(binding: RateLimit | undefined, local: RateLimiter, key: string): Promise<boolean> {
  if (!local.check(key)) return false;
  if (!binding) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch (err) {
    // A limiter outage must not become a site outage.
    console.warn("[index] rate limit binding failed", err);
    return true;
  }
}

function applySecurityHeaders(res: Response, url: URL): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  // Room codes live in the URL fragment, which is never sent anyway; no-referrer makes
  // sure nothing about this page travels with a click on an outbound link either.
  headers.set("Referrer-Policy", "no-referrer");
  // Isolate the page from any window that opened it or that it opens, and keep other
  // sites from embedding its responses.
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  // Only over HTTPS, and never for localhost: HSTS on a dev origin would pin every
  // later http://localhost project in that browser to HTTPS for two years.
  if (url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
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
  //
  // Trusted Types with no policies at all: every DOM sink that parses a string as HTML
  // or script (innerHTML, insertAdjacentHTML, document.write, script.src...) throws.
  // The app renders everything peer-supplied through textContent and has no such sink,
  // so this costs nothing and turns any future one into a loud error instead of an XSS.
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
      "require-trusted-types-for 'script'",
      "trusted-types 'none'",
    ].join("; "),
  );
  headers.set(
    "Permissions-Policy",
    "display-capture=(self), camera=(), microphone=(), geolocation=(), usb=(), payment=()",
  );
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Every answer here goes out with the security headers, except a WebSocket upgrade:
    // a 101 carries its socket on the Response object and cannot be rebuilt.
    const res = await route(request, env, url);
    return res.webSocket ? res : applySecurityHeaders(res, url);
  },
};

async function route(request: Request, env: Env, url: URL): Promise<Response> {
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
    if (clientIp && !(await allowed(env.WS_LIMITER, wsUpgradeLimit, ipKey(clientIp)))) {
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
    if (clientIp && !(await allowed(env.ROOM_LIMITER, roomCreationLimit, ipKey(clientIp)))) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      });
    }
    // A fresh code per request; a cached one would hand two people the same room.
    return Response.json({ code: generateRoomCode() }, { headers: { "Cache-Control": "no-store" } });
  }

  return env.ASSETS.fetch(request);
}
