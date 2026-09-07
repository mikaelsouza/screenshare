import { DurableObject } from "cloudflare:workers";
import {
  type ErrorCode,
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

/**
 * Sockets one IP may hold in a single room. Must be at least MAX_ROOM_SIZE: a
 * household, office or CGNAT block shares one address, and a limit below the room
 * cap would make a full room unreachable for exactly the friends most likely to be
 * sitting next to each other. MAX_SOCKETS above still bounds the room overall.
 */
const MAX_SOCKETS_PER_IP = MAX_ROOM_SIZE;

/** Storage key holding the room password, if the room has one. */
const PASSWORD_KEY = "password";

/**
 * How long an empty room keeps its password before the object erases itself.
 *
 * The password cannot be dropped the moment the room empties: a lone peer whose
 * socket blips leaves the room empty for the length of a reconnect, and clearing
 * then would let whoever connects next claim the room and lock the owner out (their
 * retry would fail the password check and be closed 1008, which the client treats
 * as terminal). Holding it for a generous window makes reconnects safe while still
 * bounding what a room code costs in storage.
 */
const EMPTY_ROOM_TTL_MS = 12 * 60 * 60 * 1000;

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

/**
 * Constant-time string comparison, so the password check does not leak the length or
 * the position of the first mismatching character through response timing. A room
 * code is public-ish (it gets pasted into chats) and the password is the only thing
 * standing behind it, so it is worth not handing out a byte-by-byte oracle.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  // Compare over a fixed length so the loop count does not depend on the input, and
  // fold the length difference into the result rather than returning early.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Refuse a connection in a way the browser can actually report.
 *
 * Answering the upgrade with a non-101 status makes the handshake fail, and all the
 * page sees is close code 1006 with no body — indistinguishable from a network blip,
 * so SignalingClient reconnects forever at the backoff cap, burning a Worker request
 * and a Durable Object wake-up per cycle. Completing the handshake and closing with
 * 1008 instead gives the client the terminal signal it already understands, and lets
 * us say why first.
 *
 * The server side is taken with `accept()`, not `ctx.acceptWebSocket()`, so it never
 * enters getWebSockets() and a rejection cannot itself consume room capacity.
 */
function rejectUpgrade(code: ErrorCode, message: string): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  sendSafe(server, { t: "error", code, message });
  try {
    server.close(1008, message);
  } catch {
    // Already gone; the client still gets the close.
  }
  return new Response(null, { status: 101, webSocket: client });
}

export class RoomDO extends DurableObject<Env> {
  /** TURN credentials are identical for everyone here, so mint once per room. */
  private readonly iceCache: { current: { iceServers: IceServerConfig[]; expiresAt: number } | null } = {
    current: null,
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /**
   * The room's password, or null if it has none.
   *
   * Read from durable storage on every join rather than held in an instance field.
   * Everything here runs under the WebSocket Hibernation API — pings are auto-answered
   * without waking the object, so a room goes dormant as soon as signalling quiets
   * down, which is within seconds of ICE completing. An in-memory password would read
   * back as null on the next wake while the original peers were still joined, and
   * because the "first peer sets it" branch only fires on an empty room it would never
   * be re-armed: the room would silently become permanently unprotected. Joins are
   * rare and the read is cheap, so going to storage each time is the honest fix.
   */
  private async getRoomPassword(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(PASSWORD_KEY)) ?? null;
  }

  /**
   * Erase an abandoned room. Armed when the last peer leaves and cancelled the moment
   * anyone joins, so a reconnect never trips it.
   */
  async alarm(): Promise<void> {
    for (const s of this.ctx.getWebSockets()) {
      const att = getAttachment(s);
      if (att?.joined) {
        // Someone is still here; the room is not abandoned after all.
        await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
        return;
      }
    }
    await this.ctx.storage.deleteAll();
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
      let ipCount = 0;
      for (const s of this.ctx.getWebSockets()) {
        const att = getAttachment(s);
        if (att && att.ip === clientIp) {
          ipCount++;
        }
      }
      if (ipCount >= MAX_SOCKETS_PER_IP) {
        return rejectUpgrade("rate-limited", "Too many connections from your network");
      }
    }

    // The room cap counts only *joined* peers, so without a ceiling here a client
    // could open unbounded sockets that never send `join`. They would never be
    // rejected, and every subsequent signalling message in the room would have to
    // walk all of them. Allow headroom for sockets mid-handshake or mid-reconnect.
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return rejectUpgrade("rate-limited", "Too many connections to this room");
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
        const roomPassword = await this.getRoomPassword();
        if (roomPassword !== null) {
          if (!clientMsg.password || !timingSafeEqual(clientMsg.password, roomPassword)) {
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

        // The first peer into an unprotected room may set its password. Guarded on
        // roomPassword being null as well as the room being empty: if one is already
        // stored, the check above has just validated it and rewriting it here would be
        // a no-op at best and a way to change it at worst.
        if (otherPeers.length === 0 && roomPassword === null && clientMsg.password) {
          await this.ctx.storage.put(PASSWORD_KEY, clientMsg.password);
        }

        // Someone is in the room, so it is not abandoned. Cancel any pending erasure.
        await this.ctx.storage.deleteAlarm();

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
    await this.handleLeave(ws);
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
    await this.handleLeave(ws);
    try {
      ws.close(1011, "socket error");
    } catch {
      // Already fully closed.
    }
  }

  private async handleLeave(ws: WebSocket): Promise<void> {
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

    // Do NOT clear the password here. The room is empty for the duration of any
    // reconnect, and dropping it in that window would let the next connection claim
    // the room out from under the peer who is coming back. Arm an erasure far enough
    // out that only a genuinely abandoned room reaches it.
    if (remainingJoined === 0) {
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
    }
  }
}
