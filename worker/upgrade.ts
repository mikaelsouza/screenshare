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

export interface UpgradeServerSocket {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface UpgradeRuntime<TClient = unknown, TResponse = Response> {
  createPair(): readonly [TClient, UpgradeServerSocket];
  createUpgradeResponse(client: TClient): TResponse;
}

function isServerSocket(value: unknown): value is UpgradeServerSocket {
  return (
    typeof value === "object" &&
    value !== null &&
    "accept" in value &&
    typeof value.accept === "function" &&
    "send" in value &&
    typeof value.send === "function" &&
    "close" in value &&
    typeof value.close === "function"
  );
}

function createGlobalPair(): readonly [unknown, UpgradeServerSocket] {
  const ctor: unknown = Reflect.get(globalThis, "WebSocketPair");
  if (typeof ctor !== "function") {
    throw new Error("WebSocketPair is not available in this runtime");
  }
  const pair: unknown = Reflect.construct(ctor, []);
  if (typeof pair !== "object" || pair === null) {
    throw new Error("Invalid WebSocketPair instance");
  }
  const client: unknown = Reflect.get(pair, 0);
  const server: unknown = Reflect.get(pair, 1);
  if (!isServerSocket(server)) {
    throw new Error("Invalid WebSocketPair server socket");
  }
  return [client, server];
}

function createGlobalUpgradeResponse(client: unknown): Response {
  const res: unknown = Reflect.construct(Response, [null, { status: 101, webSocket: client }]);
  if (res instanceof Response) return res;
  throw new Error("Failed to construct WebSocket upgrade response");
}

function defaultRuntime(): UpgradeRuntime<unknown, Response> {
  return {
    createPair: createGlobalPair,
    createUpgradeResponse: createGlobalUpgradeResponse,
  };
}

/**
 * Refuse a WebSocket connection in a way the browser can actually report.
 *
 * Completing the handshake lets us say what happened and pick a close code
 * that says whether coming back is worth trying. The server side is taken with
 * `accept()`, not `ctx.acceptWebSocket()`, so a rejection never enters
 * `getWebSockets()` and cannot itself consume room capacity.
 */
export function rejectUpgrade(code: ErrorCode, message: string, closeCode?: number): Response;
export function rejectUpgrade<TClient, TResponse>(
  code: ErrorCode,
  message: string,
  closeCode: number,
  runtime: UpgradeRuntime<TClient, TResponse>,
): TResponse;
export function rejectUpgrade(
  code: ErrorCode,
  message: string,
  closeCode = 1008,
  runtime?: UpgradeRuntime<unknown, unknown>,
): unknown {
  const rt = runtime ?? defaultRuntime();
  const [client, server] = rt.createPair();
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
  return rt.createUpgradeResponse(client);
}

/** True when this request is a WebSocket upgrade, so a refusal can be spoken over one. */
export function isUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}
