import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  MAX_ROOM_SIZE,
  PING,
  PONG,
  type ErrorCode,
  type ServerMessage,
  type ClientMessage,
  parseClientMessage,
} from "@shared/protocol";
import type { Env } from "./index";
import { ipKey } from "./ipkey";
import { TRY_AGAIN_LATER, rejectUpgrade } from "./upgrade";

/**
 * Ceiling on total sockets held by one room, joined or not. Generous relative to
 * MAX_ROOM_SIZE so reconnects and half-open sockets are not turned into failures.
 */
const MAX_SOCKETS = MAX_ROOM_SIZE * 4;

/**
 * Sockets one IP may hold in a single room.
 *
 * Must be comfortably above MAX_ROOM_SIZE. A household, office or CGNAT block shares
 * one address, so a limit at the room cap would make a full room unreachable for
 * exactly the friends most likely to be sitting next to each other — and worse, it
 * counts half-open sockets the runtime has not yet reaped, so a single reconnect
 * inside a full room would be refused. Same 2x reasoning as MAX_SOCKETS above.
 */
const MAX_SOCKETS_PER_IP = MAX_ROOM_SIZE * 2;

/**
 * Storage key marking that this room has been joined at least once.
 *
 * Only the join that creates the room becomes its host.
 */
const CLAIMED_KEY = "claimed";

/**
 * Storage key holding the salted hash of the host token. The token itself is handed
 * to the creating join only; whoever presents it later is the host again.
 */
const HOST_KEY = "hostTokenHash";

/**
 * Storage key: rejoin tickets, as salted hash to expiry. Every welcome hands out a
 * fresh one; presenting it gets a returning member past the lock and a kick ban.
 */
const MEMBERS_KEY = "members";

/** Storage key: when the last host socket left, for dropping an orphaned lock. */
const HOST_GONE_KEY = "hostGoneAt";

/** How long a locked room waits for its host to come back before it unlocks. */
const HOST_GRACE_MS = 5 * 60 * 1000;

/** Storage key: true while the host has locked the room to new joins. */
const LOCKED_KEY = "locked";

/** Storage key: rate-limit keys of kicked peers, each mapped to when its ban ends. */
const DENY_KEY = "deny";

/**
 * How long a kicked address is refused. Short on purpose: it is by address, so on a
 * shared connection (a household, CGNAT) it also shuts out whoever sits behind the
 * same one. Locking the room is the lasting answer.
 */
const KICK_BAN_MS = 15 * 60 * 1000;

/**
 * How long an empty room keeps its state before the object erases itself.
 */
const EMPTY_ROOM_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Largest raw frame accepted, checked before JSON.parse. A legitimate frame is at most
 * a 64 KB SDP plus a little JSON around it; the platform itself would accept far more.
 */
const MAX_FRAME_LENGTH = 80 * 1024;

/**
 * Per-socket message budget: a token bucket of MESSAGE_BURST, refilled at
 * MESSAGE_REFILL_PER_SEC.
 *
 * The burst has to cover the worst honest case, which is joining a full room:
 * seven links, each an offer or answer plus trickled candidates, all
 * within a second or two. Sustained traffic after that is a handful of messages per
 * renegotiation. A flood well past both is not a browser doing WebRTC.
 */
const MESSAGE_BURST = 200;
const MESSAGE_REFILL_PER_SEC = 20;

/**
 * How long a socket may stay open without joining. A real client sends `join` the
 * moment the socket opens; one that has not after this long is holding a slot.
 * Keepalive pings are answered without waking the object, so an idle unjoined
 * socket costs its holder nothing and would otherwise count against the room forever.
 */
const JOIN_DEADLINE_MS = 10_000;

/** Unparseable messages a socket may send before it is closed. */
const MAX_BAD_MESSAGES = 5;

interface MemberEntry {
  until: number;
  id?: string;
  sharing?: boolean;
}

const MemberEntrySchema: z.ZodType<MemberEntry> = z
  .object({
    until: z.number(),
    id: z.string().optional(),
    sharing: z.boolean().optional(),
  })
  .transform(
    ({ until, id, sharing }): MemberEntry => ({
      until,
      ...(id !== undefined ? { id } : {}),
      ...(sharing !== undefined ? { sharing } : {}),
    }),
  );

interface PeerAttachment {
  id: string;
  name: string;
  sharing: boolean;
  joined: boolean;
  /** Rate-limit key for the client address: IPv4 as is, IPv6 as its /64. */
  ip?: string;
  /** When the socket was accepted, for the join deadline. */
  openedAt?: number;
  /** Presented the room's host token. */
  host?: boolean;
  /** Hash of the rejoin ticket this socket was issued, deleted if it is kicked. */
  rejoinHash?: string;
}

const PeerAttachmentSchema: z.ZodType<PeerAttachment> = z
  .object({
    id: z.string(),
    name: z.string(),
    sharing: z.boolean(),
    joined: z.boolean(),
    ip: z.string().optional(),
    openedAt: z.number().optional(),
    host: z.boolean().optional(),
    rejoinHash: z.string().optional(),
  })
  .transform(
    ({ id, name, sharing, joined, ip, openedAt, host, rejoinHash }): PeerAttachment => ({
      id,
      name,
      sharing,
      joined,
      ...(ip !== undefined ? { ip } : {}),
      ...(openedAt !== undefined ? { openedAt } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(rejoinHash !== undefined ? { rejoinHash } : {}),
    }),
  );

function getAttachment(ws: WebSocket): PeerAttachment | null {
  try {
    const parsed = PeerAttachmentSchema.safeParse(ws.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  } catch {
    // Corrupted or missing attachment
    return null;
  }
}

/**
 * A display name safe to show other people.
 *
 * Rendering already goes through textContent, so this is not about markup. It is
 * about impersonation: control and format characters (bidi overrides such as U+202E,
 * zero-width joiners and spaces) let "alice" and "al\u200Bice" look identical, or
 * make a name render backwards. NFKC folds compatibility look-alikes such as
 * full-width letters into their plain forms. Cut to 32 after cleaning, so invisible
 * characters cannot eat the budget.
 */
function sanitiseName(raw: string): string {
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(cleaned).slice(0, 32).join("").trim() || "Anonymous";
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
 * Token bucket for one socket.
 *
 * Held in memory, not in the attachment: hibernation resets it, which is harmless
 * because a hibernating object is by definition not being flooded.
 */
interface MessageBudget {
  tokens: number;
  updatedAt: number;
}

function broadcastJoinOutcome(
  attachment: PeerAttachment,
  isResume: boolean,
  supersededCount: number,
  supersededSocket: { ws: WebSocket; att: PeerAttachment } | undefined,
  isHost: boolean,
  others: Array<{ ws: WebSocket; att: PeerAttachment }>,
): void {
  if (isResume && supersededCount > 0) {
    if (supersededSocket && attachment.sharing !== supersededSocket.att.sharing) {
      const stateMsg: ServerMessage = {
        t: "peer-state",
        id: attachment.id,
        sharing: attachment.sharing,
      };
      for (const { ws: peerWs } of others) {
        sendSafe(peerWs, stateMsg);
      }
    }
    return;
  }
  const joinedMsg: ServerMessage = {
    t: "peer-joined",
    peer: {
      id: attachment.id,
      name: attachment.name,
      sharing: attachment.sharing,
      ...(isHost ? { host: true } : {}),
    },
  };
  for (const { ws: peerWs } of others) {
    sendSafe(peerWs, joinedMsg);
  }
}

export class RoomDO extends DurableObject<Env> {
  private readonly budgets = new Map<string, MessageBudget>();
  /** Unparseable messages per socket. In memory, like the budgets, for the same reason. */
  private readonly badMessages = new Map<string, number>();
  /** Sockets with a join in flight, so a second join on the same socket is ignored. */
  private readonly joining = new Set<string>();
  /** Sockets that closed, so a join still in flight knows not to commit. */
  private readonly gone = new Set<string>();

  /**
   * Close every socket that has been open longer than the join deadline without
   * joining. Returns the ones it closed, which may still be listed by getWebSockets()
   * until their close completes and must not be counted.
   */
  private closeStaleUnjoined(now: number): Set<WebSocket> {
    const closed = new Set<WebSocket>();
    for (const s of this.ctx.getWebSockets()) {
      const att = getAttachment(s);
      if (!att || att.joined || att.openedAt === undefined) continue;
      if (now - att.openedAt < JOIN_DEADLINE_MS) continue;
      this.refuse(s, "join-timeout", "Did not join in time");
      closed.add(s);
    }
    return closed;
  }

  /** Spend one message from this socket's budget. False when it is exhausted. */
  private spendMessage(peerId: string, now: number = Date.now()): boolean {
    const b = this.budgets.get(peerId) ?? { tokens: MESSAGE_BURST, updatedAt: now };
    b.tokens = Math.min(MESSAGE_BURST, b.tokens + ((now - b.updatedAt) / 1000) * MESSAGE_REFILL_PER_SEC);
    b.updatedAt = now;
    this.budgets.set(peerId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Refuse a socket that broke the protocol's limits. 1008: the client should not retry. */
  private refuse(ws: WebSocket, code: ErrorCode, message: string, closeCode = 1008): void {
    sendSafe(ws, { t: "error", code, message });
    try {
      ws.close(closeCode, message);
    } catch {}
  }

  /** Joined sockets other than `except`, with their attachments. */
  private joinedPeers(except?: WebSocket): { ws: WebSocket; att: PeerAttachment }[] {
    const out: { ws: WebSocket; att: PeerAttachment }[] = [];
    for (const s of this.ctx.getWebSockets()) {
      if (s === except) continue;
      const att = getAttachment(s);
      if (att?.joined) out.push({ ws: s, att });
    }
    return out;
  }

  /** Addresses currently banned by a kick, with expired entries dropped. */
  private async getDenyList(now: number): Promise<Record<string, number>> {
    const all = (await this.ctx.storage.get<Record<string, number>>(DENY_KEY)) ?? {};
    const live: Record<string, number> = {};
    for (const [k, until] of Object.entries(all)) if (until > now) live[k] = until;
    return live;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /**
   * Salted SHA-256, hex. The Durable Object id is a stable, room-specific salt, and the
   * host/rejoin tokens get their own prefix.
   */
  private async hashSecret(secret: string, kind: "host" | "rejoin"): Promise<string> {
    const prefix = `${this.ctx.id.toString()}:${kind}`;
    const data = new TextEncoder().encode(`${prefix}:${secret}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Erase an abandoned room. Armed when the last peer leaves and cancelled the moment
   * anyone joins, so a reconnect never trips it.
   */
  override async alarm(): Promise<void> {
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

  override fetch(request: Request): Promise<Response> {
    return Promise.resolve(this.handleFetch(request));
  }

  private handleFetch(request: Request): Response {
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
          return rejectUpgrade("forbidden-origin", "Connections from this origin are not allowed");
        }
      } catch {
        return rejectUpgrade("forbidden-origin", "Malformed Origin header");
      }
    }

    // Free the slots held by sockets that never joined before counting anything.
    const now = Date.now();
    const justClosed = this.closeStaleUnjoined(now);
    const live = this.ctx.getWebSockets().filter((s) => !justClosed.has(s));

    // Limit sockets per IP if connecting from Cloudflare (prevents single-IP uplink/mesh DoS).
    // Keyed by ipKey, so an IPv6 client cannot sidestep it by rotating within its /64.
    const rawIp = request.headers.get("CF-Connecting-IP");
    const clientIp = rawIp ? ipKey(rawIp) : null;
    if (clientIp) {
      let ipCount = 0;
      for (const s of live) {
        const att = getAttachment(s);
        if (att && att.ip === clientIp) {
          ipCount++;
        }
      }
      if (ipCount >= MAX_SOCKETS_PER_IP) {
        return rejectUpgrade(
          "rate-limited",
          "Too many connections from your network",
          TRY_AGAIN_LATER,
        );
      }
    }

    // The room cap counts only *joined* peers, so without a ceiling here a client
    // could open unbounded sockets that never send `join`. They would never be
    // rejected, and every subsequent signalling message in the room would have to
    // walk all of them. Allow headroom for sockets mid-handshake or mid-reconnect.
    if (live.length >= MAX_SOCKETS) {
      return rejectUpgrade("rate-limited", "Too many connections to this room", TRY_AGAIN_LATER);
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
      ...(clientIp ? { ip: clientIp } : {}),
      openedAt: now,
    };
    server.serializeAttachment(attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = getAttachment(ws);
    if (!attachment) {
      return;
    }

    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > MAX_FRAME_LENGTH) {
      // 1009: "message too big".
      this.refuse(ws, "bad-message", "Message too large", 1009);
      return;
    }

    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (raw === PING) {
      try {
        ws.send(PONG);
      } catch {}
      return;
    }
    if (raw === PONG) {
      return;
    }

    if (!this.spendMessage(attachment.id)) {
      this.refuse(ws, "rate-limited", "Too many messages");
      return;
    }

    const clientMsg = parseClientMessage(raw);
    if (!clientMsg) {
      this.recordBadMessage(ws, attachment.id);
      return;
    }
    await this.dispatchClientMessage(ws, attachment, clientMsg);
  }

  private recordBadMessage(ws: WebSocket, peerId: string): void {
    const bad = (this.badMessages.get(peerId) ?? 0) + 1;
    this.badMessages.set(peerId, bad);
    if (bad > MAX_BAD_MESSAGES) {
      this.refuse(ws, "bad-message", "Too many invalid messages");
      return;
    }
    sendSafe(ws, {
      t: "error",
      code: "bad-message",
      message: "Invalid or malformed client message",
    });
  }

  private async dispatchClientMessage(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: ClientMessage,
  ): Promise<void> {
    if (clientMsg.t === "join") {
      await this.onJoinMessage(ws, attachment, clientMsg);
    } else if (clientMsg.t === "kick") {
      await this.handleKick(ws, attachment, clientMsg);
    } else if (clientMsg.t === "lock") {
      await this.handleLock(ws, attachment, clientMsg);
    } else if (clientMsg.t === "signal") {
      this.handleSignal(ws, attachment, clientMsg);
    } else {
      await this.handleState(ws, attachment, clientMsg);
    }
  }

  private async onJoinMessage(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "join" }>,
  ): Promise<void> {
    if (attachment.joined || this.joining.has(attachment.id) || this.gone.has(attachment.id)) {
      return;
    }
    const joinId = attachment.id;
    this.joining.add(joinId);
    try {
      await this.handleJoin(ws, attachment, clientMsg);
    } finally {
      this.joining.delete(joinId);
    }
  }

  private async handleKick(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "kick" }>,
  ): Promise<void> {
    if (!attachment.joined || !attachment.host) {
      sendSafe(ws, { t: "error", code: "not-host", message: "Only the host can remove people" });
      return;
    }
    if (clientMsg.id === attachment.id) return;
    const target = this.joinedPeers(ws).find(({ att }) => att.id === clientMsg.id);
    if (!target) {
      sendSafe(ws, { t: "error", code: "unknown-peer", message: "Peer not found" });
      return;
    }
    const now = Date.now();
    const rawMembers = await this.getMembers(now);
    const members = target.att.rejoinHash
      ? Object.fromEntries(Object.entries(rawMembers).filter(([hash]) => hash !== target.att.rejoinHash))
      : rawMembers;
    const writes: Record<string, unknown> = { [MEMBERS_KEY]: members };
    if (target.att.ip) {
      const deny = await this.getDenyList(now);
      deny[target.att.ip] = now + KICK_BAN_MS;
      writes[DENY_KEY] = deny;
    }
    await this.ctx.storage.put(writes);
    sendSafe(target.ws, { t: "error", code: "kicked", message: "You were removed from this room." });
    await this.handleLeave(target.ws);
    try {
      target.ws.close(1008, "Kicked");
    } catch {
      /* socket already closed */
    }
  }

  private async handleLock(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "lock" }>,
  ): Promise<void> {
    if (!attachment.joined || !attachment.host) {
      sendSafe(ws, { t: "error", code: "not-host", message: "Only the host can lock the room" });
      return;
    }
    await this.ctx.storage.put(LOCKED_KEY, clientMsg.locked);
    const stateMsg: ServerMessage = { t: "room-state", locked: clientMsg.locked };
    sendSafe(ws, stateMsg);
    for (const { ws: s } of this.joinedPeers(ws)) sendSafe(s, stateMsg);
  }

  private handleSignal(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "signal" }>,
  ): void {
    if (!attachment.joined) {
      sendSafe(ws, {
        t: "error",
        code: "unknown-peer",
        message: "Must join room before sending signals",
      });
      return;
    }
    const target = this.joinedPeers().find(({ att }) => att.id === clientMsg.to);
    if (!target) {
      sendSafe(ws, {
        t: "error",
        code: "unknown-peer",
        message: "Peer not found",
      });
      return;
    }
    if (clientMsg.data.k === "offer" && !attachment.sharing && !target.att.sharing) {
      sendSafe(ws, { t: "error", code: "not-sharing", message: "Neither of you is sharing" });
      return;
    }
    sendSafe(target.ws, {
      t: "signal",
      from: attachment.id,
      data: clientMsg.data,
    });
  }

  private async handleState(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "state" }>,
  ): Promise<void> {
    if (!attachment.joined) return;
    attachment.sharing = clientMsg.sharing;
    try {
      ws.serializeAttachment(attachment);
    } catch {
      /* ignore attachment serialization failure */
    }
    if (attachment.rejoinHash) {
      const now = Date.now();
      const members = await this.getMembers(now);
      const member = members[attachment.rejoinHash];
      if (member) {
        member.sharing = attachment.sharing;
        await this.ctx.storage.put({ [MEMBERS_KEY]: members });
      }
    }
    const stateMsg: ServerMessage = {
      t: "peer-state",
      id: attachment.id,
      sharing: attachment.sharing,
    };
    for (const { ws: s } of this.joinedPeers(ws)) {
      sendSafe(s, stateMsg);
    }
  }

  private findSupersededPeers(
    ws: WebSocket,
    offeredRejoinHash: string | null,
    isHost: boolean,
  ): Array<{ ws: WebSocket; att: PeerAttachment }> {
    return this.joinedPeers(ws).filter(
      ({ att }) =>
        (offeredRejoinHash !== null &&
          att.rejoinHash !== undefined &&
          timingSafeEqual(att.rejoinHash, offeredRejoinHash)) ||
        (isHost && att.host === true),
    );
  }

  private applyResumeAttachment(
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "join" }>,
    supersededSocket: { ws: WebSocket; att: PeerAttachment } | undefined,
    memberTicket: MemberEntry | undefined,
  ): void {
    const preservedId = supersededSocket?.att.id ?? memberTicket?.id;
    if (preservedId) {
      attachment.id = preservedId;
      this.gone.delete(preservedId);
    }
    if (typeof clientMsg.sharing === "boolean") {
      attachment.sharing = clientMsg.sharing;
    } else if (supersededSocket?.att.sharing !== undefined) {
      attachment.sharing = supersededSocket.att.sharing;
    } else if (memberTicket?.sharing !== undefined) {
      attachment.sharing = memberTicket.sharing;
    }
  }

  private async evictSupersededPeers(
    attachment: PeerAttachment,
    isResume: boolean,
    superseded: Array<{ ws: WebSocket; att: PeerAttachment }>,
  ): Promise<void> {
    if (isResume && superseded.length > 0) {
      for (const { ws: oldWs, att: oldAtt } of superseded) {
        oldAtt.id = crypto.randomUUID();
        this.forgetBudget(oldWs);
        oldAtt.joined = false;
        try {
          oldWs.serializeAttachment(oldAtt);
        } catch {
          /* ignore */
        }
        try {
          oldWs.close(1008, "Session replaced");
        } catch {
          /* ignore */
        }
      }
      this.gone.delete(attachment.id);
      return;
    }
    for (const { ws: oldWs } of superseded) {
      this.forgetBudget(oldWs);
      await this.handleLeave(oldWs);
      try {
        oldWs.close(1008, "Session replaced");
      } catch {
        /* ignore */
      }
    }
  }

  private async persistMemberRecord(
    attachment: PeerAttachment,
    offeredRejoinHash: string | null,
    newRejoinHash: string,
    newHostHash: string,
    creates: boolean,
    isHost: boolean,
    superseded: Array<{ ws: WebSocket; att: PeerAttachment }>,
  ): Promise<void> {
    const now = Date.now();
    const members = await this.getMembers(now);
    if (offeredRejoinHash) delete members[offeredRejoinHash];
    for (const { att } of superseded) {
      if (att.rejoinHash) delete members[att.rejoinHash];
    }
    members[newRejoinHash] = {
      until: now + EMPTY_ROOM_TTL_MS,
      id: attachment.id,
      ...(attachment.sharing ? { sharing: true } : {}),
    };
    await this.ctx.storage.put({
      [MEMBERS_KEY]: members,
      ...(creates ? { [HOST_KEY]: newHostHash, [CLAIMED_KEY]: true } : {}),
    });
    if (isHost) await this.ctx.storage.delete(HOST_GONE_KEY);
    // Someone is in the room, so it is not abandoned. Cancel any pending erasure.
    await this.ctx.storage.deleteAlarm();
  }

  /** The join handshake, split out of webSocketMessage; see the call site. */
  private async handleJoin(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "join" }>,
  ): Promise<void> {
    // Hash before touching storage, and never between a storage read and the write
    // that depends on it. Durable Object input gates only hold across storage
    // operations; a crypto.subtle await lets another join run in the middle.
    const offeredHostHash = clientMsg.hostToken ? await this.hashSecret(clientMsg.hostToken, "host") : null;
    const offeredRejoinHash = clientMsg.rejoinToken
      ? await this.hashSecret(clientMsg.rejoinToken, "rejoin")
      : null;
    const newHostToken = crypto.randomUUID();
    const newHostHash = await this.hashSecret(newHostToken, "host");
    const newRejoinToken = crypto.randomUUID();
    const newRejoinHash = await this.hashSecret(newRejoinToken, "rejoin");

    if (this.gone.has(attachment.id)) return;
    const admission = await this.admit({ offeredHostHash, offeredRejoinHash, ip: attachment.ip });
    if (!admission.ok) {
      this.refuse(ws, admission.code, admission.message);
      return;
    }
    const superseded = this.findSupersededPeers(ws, offeredRejoinHash, admission.isHost);
    const hasMatchingRejoin = superseded.some(
      ({ att }) =>
        offeredRejoinHash !== null &&
        att.rejoinHash !== undefined &&
        timingSafeEqual(att.rejoinHash, offeredRejoinHash),
    );
    const isResume = clientMsg.resume === true && (admission.returning || hasMatchingRejoin);
    const supersededSocket = superseded[0];
    if (isResume) {
      this.applyResumeAttachment(attachment, clientMsg, supersededSocket, admission.memberTicket);
    }

    await this.evictSupersededPeers(attachment, isResume, superseded);

    const others = this.joinedPeers(ws);
    if (others.length >= MAX_ROOM_SIZE) {
      this.refuse(ws, "room-full", "Room is full");
      return;
    }

    await this.persistMemberRecord(
      attachment,
      offeredRejoinHash,
      newRejoinHash,
      newHostHash,
      admission.creates,
      admission.isHost,
      superseded,
    );

    attachment.name = sanitiseName(clientMsg.displayName);
    attachment.joined = true;
    if (!isResume) attachment.sharing = false;
    attachment.host = admission.isHost;
    attachment.rejoinHash = newRejoinHash;
    try {
      ws.serializeAttachment(attachment);
    } catch {
      return;
    }

    sendSafe(ws, {
      t: "welcome",
      selfId: attachment.id,
      peers: others.map(({ att }) => ({
        id: att.id,
        name: att.name,
        sharing: att.sharing,
        ...(att.host ? { host: true } : {}),
      })),
      host: admission.isHost,
      ...(admission.creates ? { hostToken: newHostToken } : {}),
      rejoinToken: newRejoinToken,
      locked: admission.locked,
    });

    broadcastJoinOutcome(
      attachment,
      isResume,
      superseded.length,
      supersededSocket,
      admission.isHost,
      others,
    );
  }

  /**
   * Whether a join may enter, evaluated against storage directly before commit.
   * Storage reads hold the input gate, so the admission check and the commit that
   * follows it see the same room state.
   */
  private async admit(tokens: {
    offeredHostHash: string | null;
    offeredRejoinHash: string | null;
    ip: string | undefined;
  }): Promise<
    | {
        ok: true;
        creates: boolean;
        isHost: boolean;
        locked: boolean;
        returning: boolean;
        memberTicket?: MemberEntry | undefined;
      }
    | { ok: false; code: ErrorCode; message: string }
  > {
    const claimed = (await this.ctx.storage.get<boolean>(CLAIMED_KEY)) === true;
    if (!claimed) {
      return { ok: true, creates: true, isHost: true, locked: false, returning: false };
    }

    const hostHash = (await this.ctx.storage.get<string>(HOST_KEY)) ?? null;
    const isHost =
      tokens.offeredHostHash !== null && hostHash !== null && timingSafeEqual(tokens.offeredHostHash, hostHash);
    const now = Date.now();
    const locked = await this.lockedNow(now);
    const members = await this.getMembers(now);
    const memberTicket = tokens.offeredRejoinHash !== null ? members[tokens.offeredRejoinHash] : undefined;
    const returning = memberTicket !== undefined;

    if (isHost) return { ok: true, creates: false, isHost, locked, returning, memberTicket };
    if (returning) return { ok: true, creates: false, isHost, locked, returning: true, memberTicket };

    if (locked) return { ok: false, code: "room-locked", message: "This room is locked. Ask the host to unlock it." };
    if (tokens.ip) {
      const deny = await this.getDenyList(now);
      if (deny[tokens.ip] !== undefined) {
        return { ok: false, code: "kicked", message: "You were removed from this room." };
      }
    }
    return { ok: true, creates: false, isHost, locked, returning: false };
  }

  /**
   * The lock flag, dropping a lock the host has left behind. The host token lives in
   * one browser tab, so a host who closes it leaves a locked room nobody can open.
   * A refresh must not unlock it, so only a host absence past HOST_GRACE_MS does.
   */
  private async lockedNow(now: number): Promise<boolean> {
    if ((await this.ctx.storage.get<boolean>(LOCKED_KEY)) !== true) return false;
    if (this.joinedPeers().some(({ att }) => att.host)) return true;
    const goneAt = await this.ctx.storage.get<number>(HOST_GONE_KEY);
    if (goneAt === undefined) {
      await this.ctx.storage.put(HOST_GONE_KEY, now);
      return true;
    }
    if (now - goneAt < HOST_GRACE_MS) return true;
    await this.ctx.storage.put(LOCKED_KEY, false);
    const unlocked: ServerMessage = { t: "room-state", locked: false };
    for (const { ws } of this.joinedPeers()) sendSafe(ws, unlocked);
    return false;
  }

  /** Live rejoin tickets, hash to expiry, with expired ones dropped. */
  private async getMembers(now: number): Promise<Record<string, MemberEntry>> {
    const all = (await this.ctx.storage.get<Record<string, unknown>>(MEMBERS_KEY)) ?? {};
    const live: Record<string, MemberEntry> = {};
    for (const [k, val] of Object.entries(all)) {
      const parsed = MemberEntrySchema.safeParse(val);
      if (parsed.success && parsed.data.until > now) {
        live[k] = parsed.data;
      }
    }
    return live;
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.forgetBudget(ws);
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

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.forgetBudget(ws);
    await this.handleLeave(ws);
    try {
      ws.close(1011, "socket error");
    } catch {
      // Already fully closed.
    }
  }

  private forgetBudget(ws: WebSocket): void {
    const att = getAttachment(ws);
    if (!att) return;
    this.budgets.delete(att.id);
    this.badMessages.delete(att.id);
    // Remembered so a concurrent close does not commit a socket that is already gone.
    // Ids are UUIDs and never reused, so this only needs to outlive that one join.
    this.gone.add(att.id);
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
    // The clock for an orphaned lock (see lockedNow) starts when the last host leaves.
    if (attachment.host && !this.joinedPeers(ws).some(({ att }) => att.host)) {
      await this.ctx.storage.put(HOST_GONE_KEY, Date.now());
    }
  }
}
