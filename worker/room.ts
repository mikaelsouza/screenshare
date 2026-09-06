import { DurableObject } from "cloudflare:workers";
import {
  MAX_ROOM_SIZE,
  PING,
  PONG,
  type PeerInfo,
  type ServerMessage,
  parseClientMessage,
} from "@shared/protocol";
import type { Env } from "./index";

interface PeerAttachment {
  id: string;
  name: string;
  sharing: boolean;
  joined: boolean;
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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
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

        // Send this socket: { t:"welcome", selfId, peers: [...other joined peers] }
        sendSafe(ws, {
          t: "welcome",
          selfId: attachment.id,
          peers: otherPeers,
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

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.handleLeave(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.handleLeave(ws);
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

    for (const s of this.ctx.getWebSockets()) {
      if (s === ws) continue;
      const att = getAttachment(s);
      if (att && att.joined) {
        sendSafe(s, leftMsg);
      }
    }
  }
}
