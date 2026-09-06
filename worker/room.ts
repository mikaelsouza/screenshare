import { DurableObject } from "cloudflare:workers";
import {
  type IceServerConfig,
  MAX_ROOM_SIZE,
  PING,
  PONG,
  type PeerInfo,
  type ServerMessage,
  parseClientMessage,
} from "@shared/protocol";
import type { Env } from "./index";
import { getIceServers } from "./turn";

/**
 * Ceiling on total sockets held by one room, joined or not. Generous relative to
 * MAX_ROOM_SIZE so reconnects and half-open sockets are not turned into failures.
 */
const MAX_SOCKETS = MAX_ROOM_SIZE * 4;

interface PeerAttachment {
  id: string;
  name: string;
  sharing: boolean;
  joined: boolean;
  ip?: string;
}

function getAttachment(ws: WebSocket): PeerAttachment | null {
  try {
    const att = ws.deserializeAttachment() as PeerAttachment | null;
    if (
      att &&
      typeof att === "object" &&
      typeof att.id === "string" &&
      typeof att.name === "string" &&
      typeof att.sharing === "boolean" &&
      typeof att.joined === "boolean"
    ) {
      return att;
    }
  } catch {
    // Corrupted or missing attachment
  }
  return null;
}

function sendSafe(ws: WebSocket, msg: ServerMessage): boolean {
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

export class RoomDO extends DurableObject<Env> {
  /** TURN credentials are identical for everyone here, so mint once per room. */
  private readonly iceCache: { current: { iceServers: IceServerConfig[]; expiresAt: number } | null } = {
    current: null,
  };

  /** Optional room password set by the first peer to join. */
  private roomPassword: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    // Origin check against request host to prevent Cross-Site WebSocket Hijacking
    const origin = request.headers.get("Origin");
    if (origin) {
      try {
        const originHost = new URL(origin).host;
        const reqHost = new URL(request.url).host;
        if (originHost !== reqHost) {
          return new Response("Forbidden origin", { status: 403 });
        }
      } catch {
        return new Response("Invalid origin", { status: 403 });
      }
    }

    // Limit sockets per IP if connecting from Cloudflare (prevents single-IP uplink/mesh DoS)
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (clientIp) {
      const MAX_SOCKETS_PER_IP = 5;
      let ipCount = 0;
      for (const s of this.ctx.getWebSockets()) {
        const att = getAttachment(s);
        if (att && att.ip === clientIp) {
          ipCount++;
        }
      }
      if (ipCount >= MAX_SOCKETS_PER_IP) {
        return new Response("Too many connections from this IP", { status: 429 });
      }
    }

    // The room cap counts only *joined* peers, so without a ceiling here a client
    // could open unbounded sockets that never send `join`. They would never be
    // rejected, and every subsequent signalling message in the room would have to
    // walk all of them. Allow headroom for sockets mid-handshake or mid-reconnect.
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response("Too many connections to this room", { status: 429 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);

    const id = crypto.randomUUID();
    const attachment: PeerAttachment = {
      id,
      name: "",
      sharing: false,
      joined: false,
      ip: clientIp ?? undefined,
    };
    server.serializeAttachment(attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = getAttachment(ws);
    if (!attachment) {
      return;
    }

    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    const clientMsg = parseClientMessage(raw);
    if (!clientMsg) {
      sendSafe(ws, {
        t: "error",
        code: "bad-message",
        message: "Invalid or malformed client message",
      });
      return;
    }

    switch (clientMsg.t) {
      case "join": {
        // A second "join" on the same socket must be ignored, not duplicated.
        if (attachment.joined) {
          return;
        }

        // Verify room password if one has been set
        if (this.roomPassword !== null) {
          if (!clientMsg.password || clientMsg.password !== this.roomPassword) {
            sendSafe(ws, {
              t: "error",
              code: "bad-password",
              message: "Incorrect or missing room password",
            });
            try {
              ws.close(1008, "Incorrect password");
            } catch {}
            return;
          }
        }

        const otherPeers: PeerInfo[] = [];
        const otherSockets: WebSocket[] = [];

        for (const s of this.ctx.getWebSockets()) {
          if (s === ws) continue;
          const att = getAttachment(s);
          if (att && att.joined) {
            otherPeers.push({
              id: att.id,
              name: att.name,
              sharing: att.sharing,
            });
            otherSockets.push(s);
          }
        }

        // If this is the first peer to join and they provided a password, set it for the room
        if (otherPeers.length === 0 && clientMsg.password) {
          this.roomPassword = clientMsg.password;
        }

        // Reject with "room-full" and close(1008) if the count of ALREADY-JOINED sockets is >= MAX_ROOM_SIZE
        if (otherPeers.length >= MAX_ROOM_SIZE) {
          sendSafe(ws, {
            t: "error",
            code: "room-full",
            message: "Room is full",
          });
          try {
            ws.close(1008, "Room full");
          } catch {}
          return;
        }

        const sanitisedName = clientMsg.displayName.trim().slice(0, 32) || "Anonymous";

        attachment.name = sanitisedName;
        attachment.joined = true;
        attachment.sharing = false;
        try {
          ws.serializeAttachment(attachment);
        } catch {
          return;
        }

        // Mint TURN credentials here rather than from a public HTTP endpoint: reaching
        // this line requires a live WebSocket that has been accepted into the room, so
        // the socket itself is the authorisation. A failure must not block the join —
        // direct P2P is the common path and needs no TURN at all.
        let iceServers: IceServerConfig[] = [];
        try {
          iceServers = await getIceServers(this.env, this.iceCache);
        } catch (err) {
          console.error("[room] could not mint ICE servers", err);
        }

        sendSafe(ws, {
          t: "welcome",
          selfId: attachment.id,
          peers: otherPeers,
          iceServers,
        });

        // Broadcast to others: { t:"peer-joined", peer: { id, name, sharing:false } }
        const joinedMsg: ServerMessage = {
          t: "peer-joined",
          peer: {
            id: attachment.id,
            name: attachment.name,
            sharing: false,
          },
        };
        for (const s of otherSockets) {
          sendSafe(s, joinedMsg);
        }
        return;
      }

      case "signal": {
        if (!attachment.joined) {
          sendSafe(ws, {
            t: "error",
            code: "unknown-peer",
            message: "Must join room before sending signals",
          });
          return;
        }

        // Look up the target socket by attachment id among getWebSockets()
        let targetSocket: WebSocket | null = null;
        for (const s of this.ctx.getWebSockets()) {
          const att = getAttachment(s);
          if (att && att.joined && att.id === clientMsg.to) {
            targetSocket = s;
            break;
          }
        }

        // Unknown/!joined -> "unknown-peer" error back to sender
        if (!targetSocket) {
          sendSafe(ws, {
            t: "error",
            code: "unknown-peer",
            message: `Peer not found: ${clientMsg.to}`,
          });
          return;
        }

        // Otherwise forward { t:"signal", from: senderId, data } VERBATIM. Never parse or inspect `data`.
        sendSafe(targetSocket, {
          t: "signal",
          from: attachment.id,
          data: clientMsg.data,
        });
        return;
      }

      case "state": {
        if (!attachment.joined) {
          return;
        }

        // Update the sender's attachment sharing flag, broadcast { t:"peer-state", id, sharing }
        attachment.sharing = clientMsg.sharing;
        try {
          ws.serializeAttachment(attachment);
        } catch {}

        const stateMsg: ServerMessage = {
          t: "peer-state",
          id: attachment.id,
          sharing: attachment.sharing,
        };

        for (const s of this.ctx.getWebSockets()) {
          if (s === ws) continue;
          const att = getAttachment(s);
          if (att && att.joined) {
            sendSafe(s, stateMsg);
          }
        }
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.handleLeave(ws);
    // Cloudflare's hibernation contract requires the server to complete the closing
    // handshake. Without this the socket stays in getWebSockets() forever, so every
    // later join/signal/state does a deserializeAttachment() on a corpse and the
    // object never becomes evictable.
    try {
      // 1005/1006 are "no status" sentinels and are not valid to echo back.
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already fully closed.
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.handleLeave(ws);
    try {
      ws.close(1011, "socket error");
    } catch {
      // Already fully closed.
    }
  }

  private handleLeave(ws: WebSocket): void {
    const attachment = getAttachment(ws);
    if (!attachment || !attachment.joined) {
      return;
    }

    // Mark not joined to prevent duplicate peer-left broadcasts on close after error
    attachment.joined = false;
    try {
      ws.serializeAttachment(attachment);
    } catch {}

    const leftMsg: ServerMessage = {
      t: "peer-left",
      id: attachment.id,
    };

    let remainingJoined = 0;
    for (const s of this.ctx.getWebSockets()) {
      if (s === ws) continue;
      const att = getAttachment(s);
      if (att && att.joined) {
        remainingJoined++;
        sendSafe(s, leftMsg);
      }
    }

    if (remainingJoined === 0) {
      this.roomPassword = null;
    }
  }
}
