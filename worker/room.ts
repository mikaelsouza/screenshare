import { DurableObject } from "cloudflare:workers";
import {
  z,
  MAX_ROOM_SIZE,
  PING,
  PONG,
  generateRoomPassword,
  isValidRoomCode,
  type ErrorCode,
  type ServerMessage,
  type ClientMessage,
  parseClientMessage,
} from "@shared/protocol";
import type { Env } from "./index";
import { ipKey } from "./ipkey";
import { RateLimiter } from "./ratelimit";
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
 * Storage key marking that this room has been initialized by POST /api/room.
 *
 * Only rooms initialized via /init (never arbitrary GET /ws/:code scans) exist.
 */
const CLAIMED_KEY = "claimed";

/** Storage key holding the canonical 8-character room code for /ws/:code binding checks. */
const ROOM_CODE_KEY = "roomCode";

/** Storage key holding the salted SHA-256 hex digest of the active room invite secret. */
const PASSWORD_KEY = "passwordHash";

/** Storage key holding the current plaintext room invite secret (cleared on alarm expiry or rotated). */
const ROOM_PASSWORD_KEY = "roomPassword";

/**
 * Storage key holding the salted hash of the host token. The token itself is minted on
 * room creation (or promoted after HOST_GRACE_MS); whoever presents it is the host.
 */
const HOST_KEY = "hostTokenHash";

/**
 * Storage key: rejoin tickets, as salted hash to MemberEntry. Every welcome hands out a
 * fresh one; presenting it gets a returning member past a lock (and valid disconnect TTL).
 */
const MEMBERS_KEY = "members";

/** Storage key: when the last host socket left, for 5-minute universal host promotion. */
const HOST_GONE_KEY = "hostGoneAt";

/** Storage key: when the last joined peer left, for 12-hour room expiration. */
const EMPTY_SINCE_KEY = "emptySince";

/** How long an occupied room waits for its host to return before promoting the earliest member. */
const HOST_GRACE_MS = 5 * 60 * 1000;

/** How long a disconnected peer's rejoin ticket remains valid before expiring. */
const DISCONNECTED_REJOIN_TTL_MS = 5 * 60 * 1000;

/** Short overlap window so peers with in-flight reconnects survive an invite rotation. */
const ROTATION_REJOIN_GRACE_MS = 15_000;

/** Hard cap on stored ticket/deny maps so a single DO key stays well below Cloudflare's 128 KiB limit. */
const MAX_STORED_ENTRIES = 128;

/** Storage key: true while the host has locked the room to new joins. */
const LOCKED_KEY = "locked";

/** Storage key: rate-limit keys of kicked peers, each mapped to when its ban ends. */
const DENY_KEY = "deny";

/**
 * How long a kicked address is refused. Short on purpose: it is by address, so on a
 * shared connection (a household, CGNAT) it also shuts out whoever sits behind the
 * same one. Invite rotation + lock handles stronger enforcement.
 */
const KICK_BAN_MS = 15 * 60 * 1000;

/**
 * How long an empty room keeps its state before the object erases itself.
 */
const EMPTY_ROOM_TTL_MS = 12 * 60 * 60 * 1000;

/** Fixed-length sentinel hex digest so uninitialized rooms still run constant-time comparison. */
const DUMMY_HASH_HEX = "0".repeat(64);

/**
 * Largest raw frame accepted, checked before JSON.parse. A legitimate frame is at most
 * a 64 KB SDP plus a little JSON around it; the platform itself would accept far more.
 */
const MAX_FRAME_LENGTH = 80 * 1024;

/**
 * Per-socket message budget: a token bucket of MESSAGE_BURST, refilled at
 * MESSAGE_REFILL_PER_SEC.
 */
const MESSAGE_BURST = 200;
const MESSAGE_REFILL_PER_SEC = 20;

/**
 * How long a socket may stay open without joining. A real client sends `join` the
 * moment the socket opens; one that has not after this long is holding a slot.
 */
const JOIN_DEADLINE_MS = 10_000;

/** Unparseable messages a socket may send before it is closed. */
const MAX_BAD_MESSAGES = 5;

const TEXT_ENCODER = new TextEncoder();

interface MemberEntry {
  until: number;
  id?: string;
  sharing?: boolean;
  ip?: string;
}

const MemberEntrySchema: z.ZodType<MemberEntry> = z
  .object({
    until: z.number(),
    id: z.string().optional(),
    sharing: z.boolean().optional(),
    ip: z.string().optional(),
  })
  .transform(
    ({ until, id, sharing, ip }): MemberEntry => ({
      until,
      ...(id !== undefined ? { id } : {}),
      ...(sharing !== undefined ? { sharing } : {}),
      ...(ip !== undefined ? { ip } : {}),
    }),
  );

interface PeerAttachment {
  id: string;
  name: string;
  sharing: boolean;
  joined: boolean;
  /** Rate-limit key for the client address: IPv4 as is, IPv6 as its /64. */
  ip?: string;
  /** Room code from the WebSocket upgrade path (`/ws/:code`), for join binding checks. */
  roomCode?: string;
  /** When the socket was accepted, for the join deadline and host promotion ordering. */
  openedAt?: number;
  /** Presented the room's host token or was promoted to host. */
  host?: boolean;
  /** Hash of the rejoin ticket this socket was issued. */
  rejoinHash?: string;
}

const PeerAttachmentSchema: z.ZodType<PeerAttachment> = z
  .object({
    id: z.string(),
    name: z.string(),
    sharing: z.boolean(),
    joined: z.boolean(),
    ip: z.string().optional(),
    roomCode: z.string().optional(),
    openedAt: z.number().optional(),
    host: z.boolean().optional(),
    rejoinHash: z.string().optional(),
  })
  .transform(
    ({ id, name, sharing, joined, ip, roomCode, openedAt, host, rejoinHash }): PeerAttachment => ({
      id,
      name,
      sharing,
      joined,
      ...(ip !== undefined ? { ip } : {}),
      ...(roomCode !== undefined ? { roomCode } : {}),
      ...(openedAt !== undefined ? { openedAt } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(rejoinHash !== undefined ? { rejoinHash } : {}),
    }),
  );

const InitBodySchema: z.ZodType<{ code: string }> = z.object({
  code: z.string().refine(isValidRoomCode),
});

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
 * NFKC-folds look-alikes, strips control/format characters, and caps both Unicode
 * code points and UTF-16 code units at <= 32 so PeerInfoSchema never rejects astral
 * characters on the client.
 */
function sanitiseName(raw: string): string {
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  let out = "";
  let codePoints = 0;
  for (const ch of cleaned) {
    if (codePoints >= 32 || out.length + ch.length > 32) break;
    out += ch;
    codePoints++;
  }
  return out.trim() || "Anonymous";
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
 * Native constant-time comparison over UTF-8 encoded buffers. Because all compared
 * secrets here are 64-char SHA-256 hex digests, byteLength is fixed at 64.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = TEXT_ENCODER.encode(a);
  const bb = TEXT_ENCODER.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

/** Evict oldest-expiring entries when a persisted map exceeds MAX_STORED_ENTRIES. */
function capByExpiry<T>(
  map: Record<string, T>,
  getUntil: (value: T) => number,
  maxEntries: number = MAX_STORED_ENTRIES,
): Record<string, T> {
  const entries = Object.entries(map);
  if (entries.length <= maxEntries) return map;
  entries.sort((a, b) => getUntil(a[1]) - getUntil(b[1]));
  return Object.fromEntries(entries.slice(entries.length - maxEntries));
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
  replacesId: string | undefined,
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
    ...(replacesId !== undefined ? { replaces: replacesId } : {}),
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
  /** Sockets that closed while a join is in flight, deleted once that join unwinds. */
  private readonly gone = new Set<string>();
  /** Per-IP failed room-password attempts inside this DO (15/min/IP). */
  private readonly passwordFailures = new RateLimiter(15, 60_000, 2_048);

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
   * host/rejoin/password secrets get their own domain prefix.
   */
  private async hashSecret(secret: string, kind: "host" | "rejoin" | "password"): Promise<string> {
    const prefix = `${this.ctx.id.toString()}:${kind}`;
    const data = TEXT_ENCODER.encode(`${prefix}:${secret}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Multiplex the 12-hour empty-room expiration alarm and the 5-minute universal
   * host-promotion alarm into Durable Object's single alarm slot.
   */
  private async syncAlarm(now: number): Promise<void> {
    const peers = this.joinedPeers();
    if (peers.length === 0) {
      let emptySince = await this.ctx.storage.get<number>(EMPTY_SINCE_KEY);
      if (emptySince === undefined) {
        emptySince = now;
        await this.ctx.storage.put(EMPTY_SINCE_KEY, emptySince);
      }
      await this.ctx.storage.setAlarm(Math.max(now, emptySince + EMPTY_ROOM_TTL_MS));
      return;
    }

    if (peers.some(({ att }) => att.host)) {
      await this.ctx.storage.delete([EMPTY_SINCE_KEY, HOST_GONE_KEY]);
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.delete(EMPTY_SINCE_KEY);
    let goneAt = await this.ctx.storage.get<number>(HOST_GONE_KEY);
    if (goneAt === undefined) {
      goneAt = now;
      await this.ctx.storage.put(HOST_GONE_KEY, goneAt);
    }
    await this.ctx.storage.setAlarm(Math.max(now, goneAt + HOST_GRACE_MS));
  }

  /**
   * Erase an abandoned room after 12h empty, or promote the earliest connected
   * non-host member to host after 5m without any host socket.
   */
  override async alarm(): Promise<void> {
    // Pre-compute replacement host credentials outside blockConcurrencyWhile so no
    // crypto await ever runs mid-storage transaction.
    const newHostToken = crypto.randomUUID();
    const newHostHash = await this.hashSecret(newHostToken, "host");

    await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const peers = this.joinedPeers();
      if (peers.length === 0) {
        const emptySince = await this.ctx.storage.get<number>(EMPTY_SINCE_KEY);
        if (emptySince !== undefined && now - emptySince < EMPTY_ROOM_TTL_MS) {
          await this.ctx.storage.setAlarm(Math.max(now, emptySince + EMPTY_ROOM_TTL_MS));
          return;
        }
        await this.ctx.storage.deleteAll();
        return;
      }

      if (peers.some(({ att }) => att.host)) {
        await this.ctx.storage.delete([EMPTY_SINCE_KEY, HOST_GONE_KEY]);
        await this.ctx.storage.deleteAlarm();
        return;
      }

      const goneAt = await this.ctx.storage.get<number>(HOST_GONE_KEY);
      if (goneAt === undefined) {
        await this.ctx.storage.put(HOST_GONE_KEY, now);
        await this.ctx.storage.setAlarm(now + HOST_GRACE_MS);
        return;
      }
      if (now - goneAt < HOST_GRACE_MS) {
        await this.ctx.storage.setAlarm(Math.max(now, goneAt + HOST_GRACE_MS));
        return;
      }

      // Promote earliest connected peer by socket openedAt (never auto-unlock locked rooms).
      const candidate = [...peers].sort(
        (a, b) =>
          (a.att.openedAt ?? Number.MAX_SAFE_INTEGER) - (b.att.openedAt ?? Number.MAX_SAFE_INTEGER) ||
          a.att.id.localeCompare(b.att.id),
      )[0];
      if (!candidate) return;

      await this.ctx.storage.put({ [HOST_KEY]: newHostHash });
      await this.ctx.storage.delete([EMPTY_SINCE_KEY, HOST_GONE_KEY]);
      await this.ctx.storage.deleteAlarm();

      candidate.att.host = true;
      try {
        candidate.ws.serializeAttachment(candidate.att);
      } catch {
        /* ignore attachment serialization failure */
      }

      const roomPassword = await this.ctx.storage.get<string>(ROOM_PASSWORD_KEY);
      sendSafe(candidate.ws, {
        t: "host-promoted",
        hostId: candidate.att.id,
        hostToken: newHostToken,
        ...(roomPassword ? { password: roomPassword } : {}),
      });
      const publicAnnouncement: ServerMessage = {
        t: "host-promoted",
        hostId: candidate.att.id,
      };
      for (const { ws } of peers) {
        if (ws !== candidate.ws) sendSafe(ws, publicAnnouncement);
      }
    });
  }

  override fetch(request: Request): Promise<Response> {
    return this.handleFetch(request);
  }

  private async handleInit(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid request" }), { status: 400 });
    }
    const parsed = InitBodySchema.safeParse(body);
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: "Invalid room code" }), { status: 400 });
    }

    const password = generateRoomPassword();
    const hostToken = crypto.randomUUID();
    const passwordHash = await this.hashSecret(password, "password");
    const hostHash = await this.hashSecret(hostToken, "host");

    return this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.get<boolean>(CLAIMED_KEY)) === true) {
        return new Response(JSON.stringify({ error: "Room already initialized" }), { status: 409 });
      }
      const now = Date.now();
      await this.ctx.storage.put({
        [CLAIMED_KEY]: true,
        [ROOM_CODE_KEY]: parsed.data.code,
        [PASSWORD_KEY]: passwordHash,
        [ROOM_PASSWORD_KEY]: password,
        [HOST_KEY]: hostHash,
        [LOCKED_KEY]: false,
        [EMPTY_SINCE_KEY]: now,
      });
      await this.syncAlarm(now);
      return new Response(JSON.stringify({ code: parsed.data.code, password, hostToken }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    });
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "internal" && url.pathname === "/init" && request.method === "POST") {
      return this.handleInit(request);
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    // Origin check against request host to prevent Cross-Site WebSocket Hijacking
    const origin = request.headers.get("Origin");
    if (origin) {
      try {
        const originHost = new URL(origin).host;
        const reqHost = url.host;
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
    // could open unbounded sockets that never send `join`.
    if (live.length >= MAX_SOCKETS) {
      return rejectUpgrade("rate-limited", "Too many connections to this room", TRY_AGAIN_LATER);
    }

    const wsPathMatch = /^\/ws\/([A-Za-z0-9]+)$/i.exec(url.pathname);
    const pathRoomCode = wsPathMatch?.[1]?.toUpperCase();

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
      ...(pathRoomCode ? { roomCode: pathRoomCode } : {}),
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
        break;
      case "kick":
        await this.handleKick(ws, attachment, clientMsg);
        break;
      case "lock":
        await this.handleLock(ws, attachment, clientMsg);
        break;
      case "rotate-password":
        await this.handleRotatePassword(ws, attachment);
        break;
      case "rename":
        await this.handleRename(ws, attachment, clientMsg);
        break;
      case "signal":
        this.handleSignal(ws, attachment, clientMsg);
        break;
      case "state":
        await this.handleState(ws, attachment, clientMsg);
        break;
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
      this.gone.delete(joinId);
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

    let kicked = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      const target = this.joinedPeers(ws).find(({ att }) => att.id === clientMsg.id);
      if (!target) {
        sendSafe(ws, { t: "error", code: "unknown-peer", message: "Peer not found" });
        return;
      }
      const now = Date.now();
      const rawMembers = await this.getMembers(now);
      // Keep tickets still attached to other active sockets behind the same CGNAT/household IP.
      const activeHashes = new Set(
        this.joinedPeers(target.ws)
          .map(({ att }) => att.rejoinHash)
          .filter((h): h is string => h !== undefined),
      );
      const members = Object.fromEntries(
        Object.entries(rawMembers).filter(([hash, entry]) => {
          if (hash === target.att.rejoinHash) return false;
          if (target.att.ip !== undefined && entry.ip === target.att.ip && !activeHashes.has(hash)) {
            return false;
          }
          return true;
        }),
      );
      const writes: Record<string, unknown> = { [MEMBERS_KEY]: capByExpiry(members, (m) => m.until) };
      if (target.att.ip) {
        const deny = await this.getDenyList(now);
        deny[target.att.ip] = now + KICK_BAN_MS;
        writes[DENY_KEY] = capByExpiry(deny, (u) => u);
      }
      await this.ctx.storage.put(writes);
      sendSafe(target.ws, { t: "error", code: "kicked", message: "You were removed from this room." });
      await this.handleLeaveInternal(target.ws, { kicked: true, skipAlarmSync: true });
      try {
        target.ws.close(1008, "Kicked");
      } catch {
        /* socket already closed */
      }
      kicked = true;
    });

    if (kicked) {
      await this.rotatePasswordInternal();
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
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.put(LOCKED_KEY, clientMsg.locked);
      const password = !clientMsg.locked ? await this.ctx.storage.get<string>(ROOM_PASSWORD_KEY) : undefined;
      const stateMsg: ServerMessage = {
        t: "room-state",
        locked: clientMsg.locked,
        ...(password ? { password } : {}),
      };
      sendSafe(ws, stateMsg);
      for (const { ws: s } of this.joinedPeers(ws)) sendSafe(s, stateMsg);
    });
  }

  private async handleRotatePassword(ws: WebSocket, attachment: PeerAttachment): Promise<void> {
    if (!attachment.joined || !attachment.host) {
      sendSafe(ws, { t: "error", code: "not-host", message: "Only the host can rotate the invite code" });
      return;
    }
    await this.rotatePasswordInternal();
  }

  private async rotatePasswordInternal(): Promise<void> {
    const newPassword = generateRoomPassword();
    const newPasswordHash = await this.hashSecret(newPassword, "password");

    // Pre-generate enough per-peer rejoin credentials outside blockConcurrencyWhile.
    const currentCount = this.joinedPeers().length;
    const preMinted: Array<{ token: string; hash: string }> = [];
    for (let i = 0; i < currentCount + 4; i++) {
      const token = crypto.randomUUID();
      preMinted.push({ token, hash: await this.hashSecret(token, "rejoin") });
    }

    await this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.get<boolean>(CLAIMED_KEY)) !== true) return;
      const now = Date.now();
      const locked = await this.lockedNow();
      const peers = this.joinedPeers();
      const members = await this.getMembers(now);

      // Clamp all previous rejoin tickets (disconnected or pre-rotation) to a short 15s grace.
      for (const entry of Object.values(members)) {
        entry.until = Math.min(entry.until, now + ROTATION_REJOIN_GRACE_MS);
      }

      const pendingNotifications: Array<{ ws: WebSocket; msg: ServerMessage }> = [];
      let ticketIdx = 0;
      for (const { ws: peerWs, att } of peers) {
        const minted = preMinted[ticketIdx++];
        if (!minted) continue;
        members[minted.hash] = {
          until: now + EMPTY_ROOM_TTL_MS,
          id: att.id,
          ...(att.sharing ? { sharing: true } : {}),
          ...(att.ip ? { ip: att.ip } : {}),
        };
        att.rejoinHash = minted.hash;
        try {
          peerWs.serializeAttachment(att);
        } catch {
          /* ignore attachment serialization failure */
        }
        const canSeeSecret = att.host === true || !locked;
        pendingNotifications.push({
          ws: peerWs,
          msg: {
            t: "room-password",
            ...(canSeeSecret ? { password: newPassword } : {}),
            rejoinToken: minted.token,
          },
        });
      }

      await this.ctx.storage.put({
        [PASSWORD_KEY]: newPasswordHash,
        [ROOM_PASSWORD_KEY]: newPassword,
        [MEMBERS_KEY]: capByExpiry(members, (m) => m.until),
      });
      await this.syncAlarm(now);

      for (const { ws: peerWs, msg } of pendingNotifications) {
        sendSafe(peerWs, msg);
      }
    });
  }

  private async handleRename(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "rename" }>,
  ): Promise<void> {
    if (!attachment.joined) return;
    const cleaned = sanitiseName(clientMsg.displayName);
    if (cleaned === attachment.name) return;
    attachment.name = cleaned;
    try {
      ws.serializeAttachment(attachment);
    } catch {
      /* ignore attachment serialization failure */
    }
    const renameMsg: ServerMessage = {
      t: "peer-renamed",
      id: attachment.id,
      name: attachment.name,
    };
    for (const { ws: s } of this.joinedPeers()) {
      sendSafe(s, renameMsg);
    }
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
      await this.ctx.blockConcurrencyWhile(async () => {
        const now = Date.now();
        const members = await this.getMembers(now);
        const rejoinKey = attachment.rejoinHash;
        if (!rejoinKey) return;
        const member = members[rejoinKey];
        if (member) {
          member.sharing = attachment.sharing;
          await this.ctx.storage.put({ [MEMBERS_KEY]: capByExpiry(members, (m) => m.until) });
        }
      });
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
          timingSafeEqualStr(att.rejoinHash, offeredRejoinHash)) ||
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
      sendSafe(oldWs, {
        t: "error",
        code: "session-replaced",
        message: "Your session was replaced from another tab.",
      });
      await this.handleLeaveInternal(oldWs, { skipAlarmSync: true });
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
      ...(attachment.ip ? { ip: attachment.ip } : {}),
    };
    await this.ctx.storage.put({
      [MEMBERS_KEY]: capByExpiry(members, (m) => m.until),
    });
    if (isHost) await this.ctx.storage.delete(HOST_GONE_KEY);
  }

  /** The join handshake, split out of webSocketMessage; see the call site. */
  private async handleJoin(
    ws: WebSocket,
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "join" }>,
  ): Promise<void> {
    // Reject mismatched room codes before consulting storage when bound to /ws/:code.
    const msgRoom = clientMsg.room.toUpperCase();
    if (attachment.roomCode !== undefined && msgRoom !== attachment.roomCode) {
      this.refuse(ws, "bad-room-code", "Wrong room code for this connection");
      return;
    }

    // Hash before touching storage, and never between a storage read and the write
    // that depends on it. Durable Object input gates only hold across storage
    // operations; a crypto.subtle await lets another join run in the middle.
    const normalizedPassword = clientMsg.password?.trim().toUpperCase();
    const offeredPasswordHash = normalizedPassword
      ? await this.hashSecret(normalizedPassword, "password")
      : null;
    const offeredHostHash = clientMsg.hostToken ? await this.hashSecret(clientMsg.hostToken, "host") : null;
    const offeredRejoinHash = clientMsg.rejoinToken
      ? await this.hashSecret(clientMsg.rejoinToken, "rejoin")
      : null;
    const newRejoinToken = crypto.randomUUID();
    const newRejoinHash = await this.hashSecret(newRejoinToken, "rejoin");

    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.gone.has(attachment.id)) return;

      const hasActiveSocketMatch =
        offeredRejoinHash !== null &&
        this.joinedPeers(ws).some(
          ({ att }) => att.rejoinHash !== undefined && timingSafeEqualStr(att.rejoinHash, offeredRejoinHash),
        );

      const admission = await this.admit({
        msgRoom,
        pathRoomCode: attachment.roomCode,
        offeredPasswordHash,
        offeredHostHash,
        offeredRejoinHash,
        hasActiveSocketMatch,
        ip: attachment.ip,
      });
      if (!admission.ok) {
        this.refuse(ws, admission.code, admission.message);
        return;
      }

      const superseded = this.findSupersededPeers(ws, offeredRejoinHash, admission.isHost);
      const isResume = clientMsg.resume === true && admission.returning;
      const supersededSocket = superseded[0];
      const replacesId = supersededSocket?.att.id ?? admission.memberTicket?.id;

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

      await this.syncAlarm(Date.now());

      const canSeePassword = admission.isHost || !admission.locked;
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
        ...(canSeePassword && admission.roomPassword ? { password: admission.roomPassword } : {}),
        rejoinToken: newRejoinToken,
        locked: admission.locked,
      });

      broadcastJoinOutcome(
        attachment,
        isResume,
        superseded.length,
        supersededSocket,
        admission.isHost,
        replacesId,
        others,
      );
    });
  }

  /**
   * Whether a join may enter, evaluated against storage directly before commit.
   * Performs zero storage writes when unclaimed or authentication fails, and runs
   * constant-time password verification BEFORE locked/deny/rate-limit checks.
   */
  private async admit(tokens: {
    msgRoom: string;
    pathRoomCode: string | undefined;
    offeredPasswordHash: string | null;
    offeredHostHash: string | null;
    offeredRejoinHash: string | null;
    hasActiveSocketMatch: boolean;
    ip: string | undefined;
  }): Promise<
    | {
        ok: true;
        isHost: boolean;
        locked: boolean;
        returning: boolean;
        roomPassword?: string | undefined;
        memberTicket?: MemberEntry | undefined;
      }
    | { ok: false; code: ErrorCode; message: string }
  > {
    const claimed = (await this.ctx.storage.get<boolean>(CLAIMED_KEY)) === true;
    const expectedPasswordHash = claimed
      ? ((await this.ctx.storage.get<string>(PASSWORD_KEY)) ?? DUMMY_HASH_HEX)
      : DUMMY_HASH_HEX;
    const passwordMatch =
      timingSafeEqualStr(tokens.offeredPasswordHash ?? DUMMY_HASH_HEX, expectedPasswordHash) &&
      tokens.offeredPasswordHash !== null;

    if (!claimed) {
      const rateIp = tokens.ip ?? "unknown";
      if (!this.passwordFailures.check(rateIp)) {
        return {
          ok: false,
          code: "rate-limited",
          message: "Too many wrong invite codes. Wait a minute before trying again.",
        };
      }
      return {
        ok: false,
        code: "bad-password",
        message: "Invalid or expired room invite.",
      };
    }

    const storedRoomCode = await this.ctx.storage.get<string>(ROOM_CODE_KEY);
    if (
      storedRoomCode !== undefined &&
      (tokens.msgRoom !== storedRoomCode ||
        (tokens.pathRoomCode !== undefined && tokens.pathRoomCode !== storedRoomCode))
    ) {
      return { ok: false, code: "bad-room-code", message: "Wrong room code for this connection" };
    }

    const hostHash = (await this.ctx.storage.get<string>(HOST_KEY)) ?? null;
    const isHost =
      tokens.offeredHostHash !== null &&
      hostHash !== null &&
      timingSafeEqualStr(tokens.offeredHostHash, hostHash);
    const now = Date.now();
    const locked = await this.lockedNow();
    const members = await this.getMembers(now);
    const memberTicket = tokens.offeredRejoinHash !== null ? members[tokens.offeredRejoinHash] : undefined;
    const returning = memberTicket !== undefined || tokens.hasActiveSocketMatch;

    if (!passwordMatch && !isHost && !returning) {
      const rateIp = tokens.ip ?? "unknown";
      if (!this.passwordFailures.check(rateIp)) {
        return {
          ok: false,
          code: "rate-limited",
          message: "Too many wrong invite codes. Wait a minute before trying again.",
        };
      }
      return {
        ok: false,
        code: "bad-password",
        message: "Invalid or expired room invite.",
      };
    }

    const roomPassword = await this.ctx.storage.get<string>(ROOM_PASSWORD_KEY);
    if (isHost) return { ok: true, isHost, locked, returning, roomPassword, memberTicket };
    if (returning) return { ok: true, isHost, locked, returning: true, roomPassword, memberTicket };

    if (locked) {
      return { ok: false, code: "room-locked", message: "This room is locked. Ask the host to unlock it." };
    }
    if (tokens.ip) {
      const deny = await this.getDenyList(now);
      if (deny[tokens.ip] !== undefined) {
        return { ok: false, code: "kicked", message: "You were removed from this room." };
      }
    }
    return { ok: true, isHost, locked, returning: false, roomPassword };
  }

  /** Whether the room is currently locked (never auto-unlocked on host absence). */
  private async lockedNow(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>(LOCKED_KEY)) === true;
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
    // Remembered only while a join on this socket is in flight (cleaned up in onJoinMessage finally).
    if (this.joining.has(att.id)) {
      this.gone.add(att.id);
    }
  }

  private async handleLeave(ws: WebSocket): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.handleLeaveInternal(ws);
    });
  }

  private async handleLeaveInternal(
    ws: WebSocket,
    opts?: { kicked?: boolean; skipAlarmSync?: boolean },
  ): Promise<void> {
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
      ...(opts?.kicked ? { kicked: true } : {}),
    };

    for (const s of this.ctx.getWebSockets()) {
      if (s === ws) continue;
      const att = getAttachment(s);
      if (att && att.joined) {
        sendSafe(s, leftMsg);
      }
    }

    // Shrink disconnected non-kicked rejoin ticket TTL to 5 minutes from disconnect.
    if (!opts?.kicked && attachment.rejoinHash) {
      const now = Date.now();
      const members = await this.getMembers(now);
      const entry = members[attachment.rejoinHash];
      if (entry) {
        entry.until = Math.min(entry.until, now + DISCONNECTED_REJOIN_TTL_MS);
        await this.ctx.storage.put({ [MEMBERS_KEY]: capByExpiry(members, (m) => m.until) });
      }
    }

    if (!opts?.skipAlarmSync) {
      await this.syncAlarm(Date.now());
    }
  }
}
