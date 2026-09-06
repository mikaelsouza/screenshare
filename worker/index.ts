import { generateRoomCode, isValidRoomCode } from "@shared/protocol";
import { RoomDO } from "./room";

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<RoomDO>;
  TURN_KEY_ID: string;        // wrangler secret
  TURN_API_TOKEN: string;     // wrangler secret
}

export { RoomDO };

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

    // There is deliberately no /api/ice endpoint. TURN credentials let the bearer
    // relay traffic through our Cloudflare allocation on our bandwidth, and room
    // codes are client-forgeable (isValidRoomCode only checks the format), so
    // gating on one would authorise nothing. Credentials are instead issued by the
    // Durable Object in the `welcome` message, where holding an accepted WebSocket
    // in the room is the authorisation.

    // GET /api/room -> { code: generateRoomCode() } as JSON.
    if (request.method === "GET" && url.pathname === "/api/room") {
      return Response.json({ code: generateRoomCode() });
    }

    // Fallthrough to static assets
    return env.ASSETS.fetch(request);
  },
};
