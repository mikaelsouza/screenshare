import { DurableObject } from "cloudflare:workers";
import {
  MAX_ROOM_SIZE,
  MIN_PASSWORD_LENGTH,
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

/** Storage key holding the salted hash of the room password, if the room has one. */
const PASSWORD_KEY = "passwordHash";

/**
 * Storage key marking that this room has been joined at least once.
 *
 * Only the join that creates the room may set its password. Without this, an
 * *unprotected* room could be claimed by anyone holding the code: the room is empty
 * for the whole duration of any reconnect (and forever after the session ends, while
 * the code lives on in location.hash and in whatever link was shared), so a stranger
 * could join first, set a password, and lock the real occupants out.
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

/** Storage key holding the room's failed-password-attempt counter. */
const PW_FAIL_KEY = "pwFail";

/** Longest password accepted. Bounds the storage write and the hashing work. */
const MAX_PASSWORD_LENGTH = 128;

/** Window over which failed password attempts accumulate. */
const PW_FAIL_WINDOW_MS = 15 * 60 * 1000;

/**
 * Failures after which joins are refused outright rather than merely delayed.
 *
 * The delay below is the real throttle; this exists so an attacker cannot convert the
 * delay into a billing attack by holding the object awake indefinitely. Far beyond
 * typo territory, so legitimate users never reach it.
 */
const PW_FAIL_HARD_LIMIT = 50;

/** Storage key and ceiling for wrong guesses per day, on top of the 15-minute window. */
const PW_FAIL_DAY_KEY = "pwFailDay";
const PW_FAIL_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * 50 per 15 minutes alone allows ~4,800 guesses a day, enough to walk through every
 * 4-digit PIN in two days. 200 a day is still far past anyone mistyping.
 */
const PW_FAIL_DAY_LIMIT = 200;

/** Ceiling on the per-attempt delay, for the same billing reason. */
const PW_FAIL_MAX_DELAY_MS = 2_000;

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
  private async getRoomPasswordHash(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(PASSWORD_KEY)) ?? null;
  }

  /**
   * Salted SHA-256, hex. The Durable Object id is a stable, room-specific salt, and the
   * host/rejoin tokens get their own prefix so they never equal a password hash.
   */
  private async hashSecret(secret: string, kind?: "host" | "rejoin"): Promise<string> {
    const prefix = kind ? `${this.ctx.id.toString()}:${kind}` : this.ctx.id.toString();
    const data = new TextEncoder().encode(`${prefix}:${secret}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Throttle for wrong-password joins.
   *
   * Refusing a guess only closes that one socket, so without this an attacker holding
   * the room code can guess at whatever rate they can open sockets — MAX_SOCKETS_PER_IP
   * bounds concurrency, never attempts over time. The password is the only thing
   * between them and the room's media.
   *
   * Delay rather than lockout, so an attacker cannot deny the room to its actual users
   * by burning attempts. A legitimate typo or two costs a few hundred milliseconds
   * nobody notices; sustained guessing runs into the cap and then the hard limit.
   *
   * Returns the delay to serve before answering, or null to refuse immediately.
   */
  private async notePasswordFailure(): Promise<number | null> {
    const now = Date.now();
    const entry = (await this.ctx.storage.get<{ count: number; resetAt: number }>(PW_FAIL_KEY)) ?? null;
    const next =
      entry && entry.resetAt > now
        ? { count: entry.count + 1, resetAt: entry.resetAt }
        : { count: 1, resetAt: now + PW_FAIL_WINDOW_MS };
    const day = (await this.ctx.storage.get<{ count: number; resetAt: number }>(PW_FAIL_DAY_KEY)) ?? null;
    const nextDay =
      day && day.resetAt > now
        ? { count: day.count + 1, resetAt: day.resetAt }
        : { count: 1, resetAt: now + PW_FAIL_DAY_WINDOW_MS };
    await this.ctx.storage.put({ [PW_FAIL_KEY]: next, [PW_FAIL_DAY_KEY]: nextDay });
    if (next.count > PW_FAIL_HARD_LIMIT || nextDay.count > PW_FAIL_DAY_LIMIT) return null;
    return Math.min(next.count * 250, PW_FAIL_MAX_DELAY_MS);
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
    switch (clientMsg.t) {
      case "join":
        await this.onJoinMessage(ws, attachment, clientMsg);
        return;
      case "kick":
        await this.handleKick(ws, attachment, clientMsg);
        return;
      case "lock":
        await this.handleLock(ws, attachment, clientMsg);
        return;
      case "signal":
        this.handleSignal(ws, attachment, clientMsg);
        return;
      case "state":
        await this.handleState(ws, attachment, clientMsg);
        return;
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
    const members = await this.getMembers(now);
    if (target.att.rejoinHash) delete members[target.att.rejoinHash];
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
    } catch {}
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
    } catch {}
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

  /** The join handshake, split out of webSocketMessage; see the call site. */
  private async handleJoin(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "join" }>,
  ): Promise<void> {
    // Clamp before anything touches storage. displayName is clamped below for the
    // same reason; an unbounded password would exceed the 128 KiB Durable Object
    // value limit, and the rejected put would propagate out of webSocketMessage
    // and kill the socket with 1006 — which the client then retries forever.
    const offered = clientMsg.password?.slice(0, MAX_PASSWORD_LENGTH);

    // Hash before touching storage, and never between a storage read and the write
    // that depends on it. Durable Object input gates only hold across storage
    // operations; a crypto.subtle await lets another join run in the middle. With
    // the hash computed between reading `claimed` and writing it, two joins racing
    // on a fresh room could both see it unclaimed, so one could slip in without
    // the password the other was setting, or a stranger's password could win.
    // The same goes for the host and rejoin tokens: those offered, and those this
    // join would be issued.
    const offeredHash = offered ? await this.hashSecret(offered) : null;
    const offeredHostHash = clientMsg.hostToken ? await this.hashSecret(clientMsg.hostToken, "host") : null;
    const offeredRejoinHash = clientMsg.rejoinToken
      ? await this.hashSecret(clientMsg.rejoinToken, "rejoin")
      : null;
    const newHostToken = crypto.randomUUID();
    const newHostHash = await this.hashSecret(newHostToken, "host");
    const newRejoinToken = crypto.randomUUID();
    const newRejoinHash = await this.hashSecret(newRejoinToken, "rejoin");

    // Verify room password if one has been set
    const roomPasswordHash = await this.getRoomPasswordHash();
    if (roomPasswordHash !== null) {
      if (offeredHash === null) {
        // No password supplied at all. This is the ordinary first contact — a
        // shared /#CODE link, or a refresh — not an attempt at the password, so it
        // must not feed the brute-force counter or pay its delay. Counting it made
        // eight friends reloading a few times each throttle their own room.
        sendSafe(ws, {
          t: "error",
          code: "bad-password",
          message: "This room needs a password",
        });
        try {
          ws.close(1008, "Password required");
        } catch {}
        return;
      }
      if (!timingSafeEqual(offeredHash, roomPasswordHash)) {
        const delayMs = await this.notePasswordFailure();
        if (delayMs === null) {
          // Past the hard limit: refuse without delay and without hashing, so the
          // throttle cannot be turned into a way to hold this object awake. 1013,
          // not 1008, because the window expires and someone with the real
          // password must be able to get in afterwards.
          sendSafe(ws, {
            t: "error",
            code: "rate-limited",
            message: "Too many password attempts. Try again later.",
          });
          try {
            ws.close(TRY_AGAIN_LATER, "Too many password attempts");
          } catch {}
          return;
        }
        await scheduler.wait(delayMs);
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

    const tokens = { offered, offeredHostHash, offeredRejoinHash, ip: attachment.ip };

    // ---- commit. From here to the broadcast, only storage awaits: input gates
    // hold across those, so nothing else in the room runs in between.
    if (this.gone.has(attachment.id)) return;
    const admission = await this.admit(tokens);
    if (!admission.ok) {
      this.refuse(ws, admission.code, admission.message);
      return;
    }
    const superseded = this.joinedPeers(ws).filter(
      ({ att }) =>
        (offeredRejoinHash !== null &&
          att.rejoinHash !== undefined &&
          timingSafeEqual(att.rejoinHash, offeredRejoinHash)) ||
        (admission.isHost && att.host === true),
    );

    const isResume =
      clientMsg.resume === true &&
      (admission.returning ||
        superseded.some(
          ({ att }) =>
            offeredRejoinHash !== null &&
            att.rejoinHash !== undefined &&
            timingSafeEqual(att.rejoinHash, offeredRejoinHash),
        ));

    const supersededSocket = superseded[0];
    if (isResume) {
      const preservedId = supersededSocket?.att.id ?? admission.memberTicket?.id;
      if (preservedId) {
        attachment.id = preservedId;
        this.gone.delete(preservedId);
      }
      if (typeof clientMsg.sharing === "boolean") {
        attachment.sharing = clientMsg.sharing;
      } else if (supersededSocket?.att.sharing !== undefined) {
        attachment.sharing = supersededSocket.att.sharing;
      } else if (admission.memberTicket?.sharing !== undefined) {
        attachment.sharing = admission.memberTicket.sharing;
      }
    }

    if (isResume && superseded.length > 0) {
      for (const { ws: oldWs, att: oldAtt } of superseded) {
        oldAtt.id = crypto.randomUUID();
        this.forgetBudget(oldWs);
        oldAtt.joined = false;
        try {
          oldWs.serializeAttachment(oldAtt);
        } catch {}
        try {
          oldWs.close(1008, "Session replaced");
        } catch {}
      }
      this.gone.delete(attachment.id);
    } else {
      for (const { ws: oldWs } of superseded) {
        this.forgetBudget(oldWs);
        await this.handleLeave(oldWs);
        try {
          oldWs.close(1008, "Session replaced");
        } catch {}
      }
    }

    const others = this.joinedPeers(ws);
    if (others.length >= MAX_ROOM_SIZE) {
      this.refuse(ws, "room-full", "Room is full");
      return;
    }

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
      // Only the join that creates the room may set its password (see CLAIMED_KEY).
      ...(admission.creates
        ? {
            ...(offeredHash !== null ? { [PASSWORD_KEY]: offeredHash } : {}),
            [HOST_KEY]: newHostHash,
            [CLAIMED_KEY]: true,
          }
        : {}),
    });
    if (admission.isHost) await this.ctx.storage.delete(HOST_GONE_KEY);
    // Someone is in the room, so it is not abandoned. Cancel any pending erasure.
    await this.ctx.storage.deleteAlarm();

    if (!admission.creates && offered && roomPasswordHash === null) {
      // The room already exists and has no password, and this peer supplied one.
      // Silently dropping it let someone believe they had protected a room that
      // was in fact open to anyone with the code — the worst possible outcome for
      // a security control. Say so instead; the join itself still succeeds.
      sendSafe(ws, {
        t: "error",
        code: "password-ignored",
        message: "This room has no password. Yours was ignored — create a new room to set one.",
      });
    }

    attachment.name = sanitiseName(clientMsg.displayName);
    attachment.joined = true;
    if (!isResume) {
      attachment.sharing = false;
    }
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

    if (isResume && superseded.length > 0) {
      if (supersededSocket && attachment.sharing !== supersededSocket.att.sharing) {
        const stateMsg: ServerMessage = {
          t: "peer-state",
          id: attachment.id,
          sharing: attachment.sharing,
        };
        for (const { ws: s } of others) {
          sendSafe(s, stateMsg);
        }
      }
    } else {
      // After the welcome, so the newcomer is set up before anyone signals it.
      const joinedMsg: ServerMessage = {
        t: "peer-joined",
        peer: {
          id: attachment.id,
          name: attachment.name,
          sharing: attachment.sharing,
          ...(admission.isHost ? { host: true } : {}),
        },
      };
      for (const { ws: s } of others) {
        sendSafe(s, joinedMsg);
      }
    }
    return;
  }

  /**
   * Whether a join may enter, evaluated against storage directly before commit.
   * Storage reads hold the input gate, so the admission check and the commit that
   * follows it see the same room state.
   */
  private async admit(tokens: {
    offered: string | undefined;
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
      // Only a new room's password is checked: rooms created before this rule keep
      // working with whatever they were given. Refused before anything is stored,
      // so the room stays unclaimed and the creator can simply try again.
      if (tokens.offered && tokens.offered.length < MIN_PASSWORD_LENGTH) {
        return {
          ok: false,
          code: "weak-password",
          message: `Room passwords need at least ${MIN_PASSWORD_LENGTH} characters.`,
        };
      }
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
    const all = (await this.ctx.storage.get<Record<string, MemberEntry>>(MEMBERS_KEY)) ?? {};
    const live: Record<string, MemberEntry> = {};
    for (const [k, val] of Object.entries(all)) {
      if (val && typeof val.until === "number" && val.until > now) {
        live[k] = val;
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
