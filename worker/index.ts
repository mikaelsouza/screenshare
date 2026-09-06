import { generateRoomCode, isValidRoomCode } from "@shared/protocol";
import { RoomDO } from "./room";
import { mintIceServers } from "./turn";

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

    // POST /api/ice -> return await mintIceServers(env) as JSON.
    // 500 -> a JSON error body, never a raw stack trace.
    if (request.method === "POST" && url.pathname === "/api/ice") {
      try {
        const ice = await mintIceServers(env);
        return Response.json(ice);
      } catch (err) {
        console.error("Error minting ICE servers:", err);
        return new Response(JSON.stringify({ error: "Failed to mint ICE servers" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // GET /api/room -> { code: generateRoomCode() } as JSON.
    if (request.method === "GET" && url.pathname === "/api/room") {
      return Response.json({ code: generateRoomCode() });
    }

    // Fallthrough to static assets
    return env.ASSETS.fetch(request);
  },
};
