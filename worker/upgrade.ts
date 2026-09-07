import type { ErrorCode, ServerMessage } from "@shared/protocol";

/**
 * "Try Again Later" — the standard close code for a transient capacity refusal.
 *
 * Capacity limits must NOT use 1008: the client treats that as terminal and stops
 * reconnecting, so anyone who briefly exceeded a cap would have to reload the page.
 * Nor can they fail the handshake, which reaches the page as 1006 and is retried
 * forever because it is indistinguishable from a network blip. 1013 is retried, with
 * backoff and a bounded number of attempts.
 */
export const TRY_AGAIN_LATER = 1013;

/**
 * Refuse a WebSocket connection in a way the browser can actually report.
 *
 * Answering the upgrade with a non-101 status makes the handshake fail, and all the
 * page sees is close code 1006 with no body — no status, no JSON body, no Retry-After,
 * nothing. SignalingClient cannot tell that from a network blip, so it reconnects
 * forever. Completing the handshake lets us say what happened and pick a close code
 * that says whether coming back is worth trying.
 *
 * The server side is taken with `accept()`, not `ctx.acceptWebSocket()`, so a rejection
 * never enters getWebSockets() and cannot itself consume room capacity.
 */
export function rejectUpgrade(code: ErrorCode, message: string, closeCode = 1008): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const msg: ServerMessage = { t: "error", code, message };
  try {
    server.send(JSON.stringify(msg));
  } catch {
    // Nothing to do; the close below still reaches the client.
  }
  try {
    server.close(closeCode, message);
  } catch {
    // Already gone.
  }
  return new Response(null, { status: 101, webSocket: client });
}

/** True when this request is a WebSocket upgrade, so a refusal can be spoken over one. */
export function isUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}
