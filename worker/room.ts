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
 * Storage key holding the room creator's salted host token hash, restored after
 * empty-session cleanup so temporary mid-session promotions never outlive the session.
 */
const CREATOR_HOST_KEY = "creatorHostTokenHash";

/**
 * Storage key: rejoin tickets, as salted hash to MemberEntry. Every welcome hands out a
 * fresh one; presenting it gets a returning member past a lock (and valid disconnect TTL).
 */
const MEMBERS_KEY = "members";

/** Storage key: when the last host socket left, for 5-minute universal host promotion. */
const HOST_GONE_KEY = "hostGoneAt";

/** Storage key: when the last joined peer left, for 15-minute session cleanup and room expiration. */
const EMPTY_SINCE_KEY = "emptySince";

/** Storage key: true once empty-session state (members, bans, promotedHost, lock) has been cleared. */
const SESSION_CLEANED_KEY = "sessionCleaned";

/** Storage key: true once at least one peer has successfully joined the room. */
const EVER_JOINED_KEY = "everJoined";

/** Storage key: timestamp when the room creator was last active, capping non-host TTL sliding. */
const LAST_HOST_ACTIVE_KEY = "lastHostActiveAt";

/** Storage key: host promotion credential waiting to be delivered on half-open resume. */
const PROMOTED_HOST_KEY = "promotedHost";

/** Storage key: durable marker set whenever a mid-session host promotion occurs or is claimed, cleared on 15m reset. */
const HOST_PROMOTED_KEY = "hostPromoted";

/** How long an occupied room waits for its host to return before promoting the earliest member. */
const HOST_GRACE_MS = 5 * 60 * 1000;

/** How long a disconnected peer's rejoin ticket remains valid before expiring. */
const DISCONNECTED_REJOIN_TTL_MS = 5 * 60 * 1000;

/** Overlap window exceeding max client reconnect backoff so in-flight reconnects survive manual rotation. */
const ROTATION_REJOIN_GRACE_MS = 25_000;

/** Baseline TTL for connected rejoin tickets; activeRejoinHashes() keeps live sockets valid past this, and handleLeaveInternal() shrinks disconnected tickets to 5m. */
const CONNECTED_TICKET_TTL_MS = 24 * 60 * 60 * 1000;

/** How long an empty room keeps ephemeral session state (tickets, IP bans, lock, pending host promotion) before resetting for the next session. */
const EMPTY_SESSION_CLEANUP_MS = 15 * 60 * 1000;

/** Safety fallback alarm cadence while a room is occupied, catching missed close events within 15 minutes. */
const OCCUPIED_FALLBACK_ALARM_MS = EMPTY_SESSION_CLEANUP_MS;

/** How long an unused room created by POST /api/room survives without any join. */
const UNUSED_ROOM_TTL_MS = 12 * 60 * 60 * 1000;

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
 * How long an empty room keeps its credentials before the object erases itself.
 */
const EMPTY_ROOM_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Fixed-length sentinel hex digest so uninitialized rooms still run constant-time comparison. */
const DUMMY_HASH_HEX = "0".repeat(64);

/**
 * Largest raw frame accepted, checked before JSON.parse. A legitimate frame is at most
 * a 64 KB SDP plus a little JSON around it; the platform itself would accept far more.
 */
const MAX_FRAME_LENGTH = 80 * 1024;

/**
 * Per-socket message budget: a token bucket of MESSAGE_BURST, refilled at
 * MESSAGE_REFILL_PER_SEC. Sized to allow 20-peer multi-homed ICE bursts while stopping floods.
 */
const MESSAGE_BURST = 320;
const MESSAGE_REFILL_PER_SEC = 40;

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
  joinedAt?: number;
  rotationGrace?: boolean;
  creatorHost?: boolean;
}

const MemberEntrySchema: z.ZodType<MemberEntry> = z
  .object({
    until: z.number(),
    id: z.string().optional(),
    sharing: z.boolean().optional(),
    ip: z.string().optional(),
    joinedAt: z.number().optional(),
    rotationGrace: z.boolean().optional(),
    creatorHost: z.boolean().optional(),
  })
  .transform(
    ({ until, id, sharing, ip, joinedAt, rotationGrace, creatorHost }): MemberEntry => ({
      until,
      ...(id !== undefined ? { id } : {}),
      ...(sharing !== undefined ? { sharing } : {}),
      ...(ip !== undefined ? { ip } : {}),
      ...(joinedAt !== undefined ? { joinedAt } : {}),
      ...(rotationGrace ? { rotationGrace: true } : {}),
      ...(creatorHost ? { creatorHost: true } : {}),
    }),
  );

const PromotedHostSchema = z.object({
  id: z.string().min(1),
  token: z.string().min(1),
});
type PromotedHostRecord = z.infer<typeof PromotedHostSchema>;

interface PeerAttachment {
  id: string;
  name: string;
  sharing: boolean;
  joined: boolean;
  /** Rate-limit key for the client address: IPv4 as is, IPv6 as its /64. */
  ip?: string;
  /** Room code from the WebSocket upgrade path (`/ws/:code`), for join binding checks. */
  roomCode?: string;
  /** When the socket was accepted, for the join deadline. */
  openedAt?: number;
  /** When this peer first joined the room (preserved across reconnects for host promotion). */
  joinedAt?: number;
  /** Presented the room's host token or was promoted to host. */
  host?: boolean;
  /** Presented the original room creator's host token (used to slide creator-anchored TTL). */
  creatorHost?: boolean;
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
    joinedAt: z.number().optional(),
    host: z.boolean().optional(),
    creatorHost: z.boolean().optional(),
    rejoinHash: z.string().optional(),
  })
  .transform(
    ({
      id,
      name,
      sharing,
      joined,
      ip,
      roomCode,
      openedAt,
      joinedAt,
      host,
      creatorHost,
      rejoinHash,
    }): PeerAttachment => ({
      id,
      name,
      sharing,
      joined,
      ...(ip !== undefined ? { ip } : {}),
      ...(roomCode !== undefined ? { roomCode } : {}),
      ...(openedAt !== undefined ? { openedAt } : {}),
      ...(joinedAt !== undefined ? { joinedAt } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(creatorHost !== undefined ? { creatorHost } : {}),
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
  // Slice before NFKC so oversized UTF-16 inputs cannot amplify CPU cost during normalization.
  const cleaned = raw
    .slice(0, 256)
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

/** Evict oldest-expiring entries when a persisted map exceeds MAX_STORED_ENTRIES, protecting active keys. */
function capByExpiry<T>(
  map: Record<string, T>,
  getUntil: (value: T) => number,
  maxEntries: number = MAX_STORED_ENTRIES,
  protectedKeys?: ReadonlySet<string>,
): Record<string, T> {
  const entries = Object.entries(map);
  if (entries.length <= maxEntries) return map;
  const sortKey = ([k, v]: [string, T]): number =>
    protectedKeys?.has(k) ? Number.MAX_SAFE_INTEGER : getUntil(v);
  entries.sort((a, b) => sortKey(a) - sortKey(b));
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

/**
 * Compute empty-room credential expiry:
 * - Already-joined pre-deploy rooms lacking `CREATOR_HOST_KEY` explicitly keep their
 *   pre-deploy 12-hour TTL (capped non-sliding by `lastHostActiveAt` once anchored) rather
 *   than upgrading to 90-day reusable retention.
 * - Never-joined rooms expire 12 hours after creation (`UNUSED_ROOM_TTL_MS`).
 * - Joined rooms with verified `CREATOR_HOST_KEY` expire 90 days after the earlier of
 *   `emptySince` and `lastHostActiveAt`.
 */
function computeCredentialExpiry(
  emptySince: number,
  everJoined: boolean,
  lastHostActiveAt: number | undefined,
  hasCreatorHost: boolean,
): number {
  if (!hasCreatorHost) {
    const legacyIdle = emptySince + UNUSED_ROOM_TTL_MS;
    return lastHostActiveAt !== undefined
      ? Math.min(legacyIdle, lastHostActiveAt + UNUSED_ROOM_TTL_MS)
      : legacyIdle;
  }
  if (!everJoined) return emptySince + UNUSED_ROOM_TTL_MS;
  const idleExpiry = emptySince + EMPTY_ROOM_TTL_MS;
  const hostExpiry = lastHostActiveAt !== undefined ? lastHostActiveAt + EMPTY_ROOM_TTL_MS : idleExpiry;
  return Math.min(idleExpiry, hostExpiry);
}

interface PreMintedRotation {
  newPassword: string;
  newPasswordHash: string;
  tickets: Array<{ token: string; hash: string }>;
}

function broadcastJoinOutcome(
  attachment: PeerAttachment,
  resumedInPlace: boolean,
  prevPeerState: { sharing: boolean; name: string; host: boolean } | undefined,
  isHost: boolean,
  replacesId: string | undefined,
  others: Array<{ ws: WebSocket; att: PeerAttachment }>,
): void {
  if (resumedInPlace && prevPeerState) {
    if (attachment.sharing !== prevPeerState.sharing) {
      const stateMsg: ServerMessage = {
        t: "peer-state",
        id: attachment.id,
        sharing: attachment.sharing,
      };
      for (const { ws: peerWs } of others) {
        sendSafe(peerWs, stateMsg);
      }
    }
    if (attachment.name !== prevPeerState.name) {
      const renameMsg: ServerMessage = {
        t: "peer-renamed",
        id: attachment.id,
        name: attachment.name,
      };
      for (const { ws: peerWs } of others) {
        sendSafe(peerWs, renameMsg);
      }
    }
    if (isHost && !prevPeerState.host) {
      const promoteMsg: ServerMessage = {
        t: "host-promoted",
        hostId: attachment.id,
      };
      for (const { ws: peerWs } of others) {
        sendSafe(peerWs, promoteMsg);
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
  /** Sockets already refused/evicted, so queued frames on the same socket are ignored. */
  private readonly refused = new WeakSet<WebSocket>();
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
      if (this.refused.has(s)) continue;
      const att = getAttachment(s);
      if (!att || att.joined || att.openedAt === undefined) continue;
      if (this.joining.has(att.id)) continue;
      if (now - att.openedAt < JOIN_DEADLINE_MS) continue;
      this.refuse(s, "join-timeout", "Did not join in time");
      closed.add(s);
    }
    return closed;
  }

  /** Sweep expired unjoined sockets and return the soonest remaining join-deadline timestamp, if any. */
  private earliestUnjoinedDeadline(now: number): number | null {
    const justClosed = this.closeStaleUnjoined(now);
    let earliest: number | null = null;
    for (const s of this.ctx.getWebSockets()) {
      if (justClosed.has(s) || this.refused.has(s)) continue;
      const att = getAttachment(s);
      if (!att || att.joined || att.openedAt === undefined) continue;
      const deadline = att.openedAt + JOIN_DEADLINE_MS;
      if (earliest === null || deadline < earliest) earliest = deadline;
    }
    return earliest;
  }

  private async scheduleAlarmWithUnjoined(now: number, lifecycleDeadline: number): Promise<void> {
    const unjoined = this.earliestUnjoinedDeadline(now);
    const target = unjoined !== null ? Math.min(lifecycleDeadline, unjoined) : lifecycleDeadline;
    await this.ctx.storage.setAlarm(Math.max(now, target));
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
    this.refused.add(ws);
    this.forgetBudget(ws);
    const att = getAttachment(ws);
    sendSafe(ws, { t: "error", code, message });
    try {
      ws.close(closeCode, message);
    } catch {}
    if (att?.joined) {
      void this.handleLeave(ws);
    }
  }

  private activeRejoinHashes(): Set<string> {
    const hashes = new Set<string>();
    for (const { att } of this.joinedPeers()) {
      if (att.rejoinHash) hashes.add(att.rejoinHash);
    }
    return hashes;
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

  private async preMintEmptyResetSecret(): Promise<{ password: string; passwordHash: string }> {
    const password = generateRoomPassword();
    const passwordHash = await this.hashSecret(password, "password");
    return { password, passwordHash };
  }

  /** Erase all room state and close remaining sockets when a room reaches its credential TTL. */
  private async expireRoom(exceptWs?: WebSocket): Promise<void> {
    for (const s of this.ctx.getWebSockets()) {
      if (s === exceptWs) continue;
      this.refused.add(s);
      this.forgetBudget(s);
      const att = getAttachment(s);
      if (att) {
        // Clear joined state before closing so asynchronous webSocketClose cannot rewrite storage.
        att.joined = false;
        att.host = false;
        att.creatorHost = false;
        delete att.rejoinHash;
        try {
          s.serializeAttachment(att);
        } catch {
          /* already closed */
        }
      }
      try {
        s.close(1001, "Room expired");
      } catch {
        /* already closed */
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Clear ephemeral session/IP maps, restore original creator host hash, and reset room lock
   * once empty past 15 minutes — rotating the invite secret if the room was locked when emptied.
   *
   * For already-joined pre-deploy rooms without `CREATOR_HOST_KEY`, revoke `HOST_KEY` whenever
   * durable promotion evidence (`PROMOTED_HOST_KEY` or `HOST_PROMOTED_KEY`) is present; otherwise
   * leave `HOST_KEY` intact solely within the room's non-sliding 12-hour pre-deploy TTL without
   * ever copying it to `CREATOR_HOST_KEY` or upgrading the room to 90-day retention.
   */
  private async resetEmptySessionState(
    now: number,
    preRotated: { password: string; passwordHash: string },
  ): Promise<void> {
    this.closeStaleUnjoined(now);
    const [wasLocked, creatorHostHash, promoted, hostPromoted] = await Promise.all([
      this.ctx.storage.get<boolean>(LOCKED_KEY),
      this.ctx.storage.get<string>(CREATOR_HOST_KEY),
      this.ctx.storage.get<unknown>(PROMOTED_HOST_KEY),
      this.ctx.storage.get<boolean>(HOST_PROMOTED_KEY),
    ]);
    const revokeLegacyPromotedHost =
      creatorHostHash === undefined && (promoted !== undefined || hostPromoted === true);
    await this.ctx.storage.delete([
      MEMBERS_KEY,
      DENY_KEY,
      PROMOTED_HOST_KEY,
      HOST_GONE_KEY,
      HOST_PROMOTED_KEY,
      ...(revokeLegacyPromotedHost ? [HOST_KEY] : []),
    ]);
    await this.ctx.storage.put({
      [LOCKED_KEY]: false,
      [SESSION_CLEANED_KEY]: true,
      ...(creatorHostHash !== undefined ? { [HOST_KEY]: creatorHostHash } : {}),
      ...(wasLocked === true
        ? { [PASSWORD_KEY]: preRotated.passwordHash, [ROOM_PASSWORD_KEY]: preRotated.password }
        : {}),
    });
  }

  /**
   * Backfill `CREATOR_HOST_KEY` and an initial `LAST_HOST_ACTIVE_KEY` baseline from `HOST_KEY`
   * only for pre-deploy rooms that have never been joined
   * (`!everJoined && !sessionCleaned && members === undefined && promotedHost === undefined && !hostPromoted`).
   */
  private async backfillUnjoinedLegacyCreatorHash(now: number): Promise<boolean> {
    if (this.joinedPeers().length > 0) return false;
    const [
      creatorHash,
      hostHash,
      everJoined,
      sessionCleaned,
      members,
      promoted,
      hostPromoted,
      emptySince,
      lastHostActiveAt,
    ] = await Promise.all([
      this.ctx.storage.get<string>(CREATOR_HOST_KEY),
      this.ctx.storage.get<string>(HOST_KEY),
      this.ctx.storage.get<boolean>(EVER_JOINED_KEY),
      this.ctx.storage.get<boolean>(SESSION_CLEANED_KEY),
      this.ctx.storage.get<unknown>(MEMBERS_KEY),
      this.ctx.storage.get<unknown>(PROMOTED_HOST_KEY),
      this.ctx.storage.get<boolean>(HOST_PROMOTED_KEY),
      this.ctx.storage.get<number>(EMPTY_SINCE_KEY),
      this.ctx.storage.get<number>(LAST_HOST_ACTIVE_KEY),
    ]);
    if (
      creatorHash === undefined &&
      hostHash !== undefined &&
      everJoined !== true &&
      sessionCleaned !== true &&
      members === undefined &&
      promoted === undefined &&
      hostPromoted !== true
    ) {
      await this.ctx.storage.put({
        [CREATOR_HOST_KEY]: hostHash,
        ...(lastHostActiveAt === undefined ? { [LAST_HOST_ACTIVE_KEY]: emptySince ?? now } : {}),
      });
      return true;
    }
    return false;
  }

  /**
   * For rooms lacking `CREATOR_HOST_KEY`, either migrate an unjoined pre-deploy room by
   * backfilling `CREATOR_HOST_KEY` + `LAST_HOST_ACTIVE_KEY`, or anchor an already-joined
   * pre-deploy room's `LAST_HOST_ACTIVE_KEY` so its 12-hour legacy TTL cannot slide.
   */
  private async reconcileLegacyCreatorState(
    now: number,
    emptySince: number,
    lastHostActiveAt: number | undefined,
  ): Promise<void> {
    const backfilled = await this.backfillUnjoinedLegacyCreatorHash(now);
    if (!backfilled && lastHostActiveAt === undefined) {
      await this.ctx.storage.put(LAST_HOST_ACTIVE_KEY, emptySince);
    }
  }

  /**
   * Return the creator-anchored credential cap for an occupied room (90d for rooms with verified
   * `CREATOR_HOST_KEY`, or non-sliding 12h for already-joined pre-deploy rooms without one),
   * refreshing `LAST_HOST_ACTIVE_KEY` whenever the room creator is currently connected.
   */
  private async creatorActivityCap(
    peers: Array<{ ws: WebSocket; att: PeerAttachment }>,
    now: number,
  ): Promise<number> {
    if (peers.some(({ att }) => att.creatorHost === true)) {
      await this.ctx.storage.put(LAST_HOST_ACTIVE_KEY, now);
      return now + EMPTY_ROOM_TTL_MS;
    }
    const [everJoinedRaw, lastHostActiveAt, creatorHostHash] = await Promise.all([
      this.ctx.storage.get<boolean>(EVER_JOINED_KEY),
      this.ctx.storage.get<number>(LAST_HOST_ACTIVE_KEY),
      this.ctx.storage.get<string>(CREATOR_HOST_KEY),
    ]);
    if (creatorHostHash === undefined) {
      const baseline = lastHostActiveAt ?? now;
      if (lastHostActiveAt === undefined) {
        await this.ctx.storage.put(LAST_HOST_ACTIVE_KEY, baseline);
      }
      return baseline + UNUSED_ROOM_TTL_MS;
    }
    if (everJoinedRaw === true) {
      const baseline = lastHostActiveAt ?? now;
      if (lastHostActiveAt === undefined) {
        await this.ctx.storage.put(LAST_HOST_ACTIVE_KEY, baseline);
      }
      return baseline + EMPTY_ROOM_TTL_MS;
    }
    return Number.POSITIVE_INFINITY;
  }

  /**
   * Multiplex the 15-minute empty-session reset, 12h/90d credential expiration, 5-minute
   * host-promotion, 15-minute occupied safety fallback, and 10s unjoined-socket sweep into one alarm slot.
   */
  private async syncAlarm(now: number): Promise<void> {
    const peers = this.joinedPeers();
    if (peers.length === 0) {
      await this.ctx.storage.delete(HOST_GONE_KEY);
      let emptySince = await this.ctx.storage.get<number>(EMPTY_SINCE_KEY);
      if (emptySince === undefined) {
        emptySince = now;
        await this.ctx.storage.put(EMPTY_SINCE_KEY, emptySince);
      }
      const [sessionCleanedRaw, everJoinedRaw, lastHostActiveAt, creatorHostHash] = await Promise.all([
        this.ctx.storage.get<boolean>(SESSION_CLEANED_KEY),
        this.ctx.storage.get<boolean>(EVER_JOINED_KEY),
        this.ctx.storage.get<number>(LAST_HOST_ACTIVE_KEY),
        this.ctx.storage.get<string>(CREATOR_HOST_KEY),
      ]);
      const sessionCleaned = sessionCleanedRaw === true;
      const everJoined = everJoinedRaw === true;
      const credentialExpiry = computeCredentialExpiry(
        emptySince,
        everJoined,
        lastHostActiveAt,
        creatorHostHash !== undefined,
      );
      const lifecycleDeadline = sessionCleaned
        ? credentialExpiry
        : Math.min(credentialExpiry, emptySince + EMPTY_SESSION_CLEANUP_MS);
      await this.scheduleAlarmWithUnjoined(now, lifecycleDeadline);
      return;
    }

    const creatorCap = await this.creatorActivityCap(peers, now);

    if (peers.some(({ att }) => att.host)) {
      await this.ctx.storage.delete([EMPTY_SINCE_KEY, HOST_GONE_KEY, SESSION_CLEANED_KEY]);
      // Keep a short 15m safety fallback alarm so missed last-leave events still clean up promptly,
      // bounded by the creator-activity 90d retention cap if non-creator guests stay indefinitely.
      await this.scheduleAlarmWithUnjoined(now, Math.min(now + OCCUPIED_FALLBACK_ALARM_MS, creatorCap));
      return;
    }

    await this.ctx.storage.delete([EMPTY_SINCE_KEY, SESSION_CLEANED_KEY]);
    let goneAt = await this.ctx.storage.get<number>(HOST_GONE_KEY);
    if (goneAt === undefined) {
      goneAt = now;
      await this.ctx.storage.put(HOST_GONE_KEY, goneAt);
    }
    await this.scheduleAlarmWithUnjoined(now, Math.min(goneAt + HOST_GRACE_MS, creatorCap));
  }

  /**
   * Clear ephemeral session state after 15m empty, erase an unused/expired room after
   * 12h/90d, sweep stale unjoined sockets, or promote the earliest joined member after 5m without a host.
   */
  override async alarm(): Promise<void> {
    // Pre-compute replacement host and rotation credentials outside blockConcurrencyWhile so no
    // crypto await ever runs mid-storage transaction.
    const newHostToken = crypto.randomUUID();
    const [newHostHash, preRotated] = await Promise.all([
      this.hashSecret(newHostToken, "host"),
      this.preMintEmptyResetSecret(),
    ]);

    await this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.get<boolean>(CLAIMED_KEY)) !== true) {
        await this.ctx.storage.deleteAlarm();
        return;
      }

      const now = Date.now();
      this.closeStaleUnjoined(now);
      const peers = this.joinedPeers();
      if (peers.length === 0) {
        let [emptySince, sessionCleanedRaw, everJoinedRaw, lastHostActiveAt, creatorHostHash] = await Promise.all([
          this.ctx.storage.get<number>(EMPTY_SINCE_KEY),
          this.ctx.storage.get<boolean>(SESSION_CLEANED_KEY),
          this.ctx.storage.get<boolean>(EVER_JOINED_KEY),
          this.ctx.storage.get<number>(LAST_HOST_ACTIVE_KEY),
          this.ctx.storage.get<string>(CREATOR_HOST_KEY),
        ]);
        const sessionCleaned = sessionCleanedRaw === true;
        const everJoined = everJoinedRaw === true;
        if (emptySince === undefined) {
          const capTtl = creatorHostHash !== undefined ? EMPTY_ROOM_TTL_MS : UNUSED_ROOM_TTL_MS;
          if (
            lastHostActiveAt !== undefined &&
            now >= lastHostActiveAt + capTtl &&
            (creatorHostHash === undefined || everJoined)
          ) {
            await this.expireRoom();
            return;
          }
          // Start the 15-minute grace window now when the leave marker is missing rather than
          // immediately clearing active rejoin tickets on a brief disconnect just before fallback.
          emptySince = now;
          await this.ctx.storage.put(EMPTY_SINCE_KEY, emptySince);
        }
        const credentialExpiry = computeCredentialExpiry(
          emptySince,
          everJoined,
          lastHostActiveAt,
          creatorHostHash !== undefined,
        );
        if (now >= credentialExpiry) {
          await this.expireRoom();
          return;
        }
        if (creatorHostHash === undefined) {
          await this.reconcileLegacyCreatorState(now, emptySince, lastHostActiveAt);
        }
        if (!sessionCleaned) {
          if (now - emptySince < EMPTY_SESSION_CLEANUP_MS) {
            await this.scheduleAlarmWithUnjoined(
              now,
              Math.min(credentialExpiry, emptySince + EMPTY_SESSION_CLEANUP_MS),
            );
            return;
          }
          await this.resetEmptySessionState(now, preRotated);
        }
        await this.scheduleAlarmWithUnjoined(now, credentialExpiry);
        return;
      }

      const creatorCap = await this.creatorActivityCap(peers, now);
      if (now >= creatorCap) {
        await this.expireRoom();
        return;
      }

      if (peers.some(({ att }) => att.host)) {
        await this.ctx.storage.delete([EMPTY_SINCE_KEY, HOST_GONE_KEY, SESSION_CLEANED_KEY]);
        await this.scheduleAlarmWithUnjoined(now, Math.min(now + OCCUPIED_FALLBACK_ALARM_MS, creatorCap));
        return;
      }

      const goneAt = await this.ctx.storage.get<number>(HOST_GONE_KEY);
      if (goneAt === undefined) {
        await this.ctx.storage.put(HOST_GONE_KEY, now);
        await this.scheduleAlarmWithUnjoined(now, Math.min(now + HOST_GRACE_MS, creatorCap));
        return;
      }
      if (now - goneAt < HOST_GRACE_MS) {
        await this.scheduleAlarmWithUnjoined(now, Math.min(goneAt + HOST_GRACE_MS, creatorCap));
        return;
      }

      // Promote earliest joined peer (preserving tenure across reconnects; never auto-unlock locked rooms).
      const candidate = [...peers].sort(
        (a, b) =>
          (a.att.joinedAt ?? a.att.openedAt ?? Number.MAX_SAFE_INTEGER) -
            (b.att.joinedAt ?? b.att.openedAt ?? Number.MAX_SAFE_INTEGER) ||
          a.att.id.localeCompare(b.att.id),
      )[0];
      if (!candidate) return;

      const promotedRecord: PromotedHostRecord = { id: candidate.att.id, token: newHostToken };
      await this.ctx.storage.put({
        [HOST_KEY]: newHostHash,
        [PROMOTED_HOST_KEY]: promotedRecord,
        [HOST_PROMOTED_KEY]: true,
      });
      await this.ctx.storage.delete([EMPTY_SINCE_KEY, HOST_GONE_KEY, SESSION_CLEANED_KEY]);
      await this.scheduleAlarmWithUnjoined(now, Math.min(now + OCCUPIED_FALLBACK_ALARM_MS, creatorCap));

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
        [CREATOR_HOST_KEY]: hostHash,
        [LOCKED_KEY]: false,
        [EMPTY_SINCE_KEY]: now,
        [SESSION_CLEANED_KEY]: true,
        [LAST_HOST_ACTIVE_KEY]: now,
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

    // Origin check against full origin (scheme + host + port) to prevent Cross-Site WebSocket Hijacking
    const origin = request.headers.get("Origin");
    if (origin) {
      try {
        if (new URL(origin).origin !== url.origin) {
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

    // Ensure stale unjoined sockets are swept after JOIN_DEADLINE_MS even in already-cleaned empty rooms.
    if ((await this.ctx.storage.get<boolean>(CLAIMED_KEY)) === true) {
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm === null || currentAlarm > now + JOIN_DEADLINE_MS) {
        await this.ctx.storage.setAlarm(now + JOIN_DEADLINE_MS);
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.refused.has(ws)) return;

    if (typeof message !== "string") {
      this.refuse(ws, "bad-message", "Binary frames are not supported");
      return;
    }

    const attachment = getAttachment(ws);
    if (!attachment) {
      return;
    }

    if (message.length > MAX_FRAME_LENGTH) {
      // 1009: "message too big".
      this.refuse(ws, "bad-message", "Message too large", 1009);
      return;
    }

    if (!attachment.joined && attachment.openedAt !== undefined && Date.now() - attachment.openedAt >= JOIN_DEADLINE_MS) {
      this.refuse(ws, "join-timeout", "Did not join in time");
      return;
    }

    if (!this.spendMessage(attachment.id)) {
      this.refuse(ws, "rate-limited", "Too many messages");
      return;
    }

    if (message === PING) {
      try {
        ws.send(PONG);
      } catch {}
      return;
    }
    if (message === PONG) {
      return;
    }

    const clientMsg = parseClientMessage(message);
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

  private async preMintRotationCredentials(): Promise<PreMintedRotation> {
    const newPassword = generateRoomPassword();
    const [newPasswordHash, tickets] = await Promise.all([
      this.hashSecret(newPassword, "password"),
      Promise.all(
        Array.from({ length: MAX_ROOM_SIZE }, async () => {
          const token = crypto.randomUUID();
          return { token, hash: await this.hashSecret(token, "rejoin") };
        }),
      ),
    ]);
    return { newPassword, newPasswordHash, tickets };
  }

  private async applyRotationInTransaction(
    now: number,
    locked: boolean,
    peers: Array<{ ws: WebSocket; att: PeerAttachment }>,
    rawMembers: Record<string, MemberEntry>,
    creds: PreMintedRotation,
    opts: { purgeDisconnected: boolean; extraWrites?: Record<string, unknown> },
  ): Promise<void> {
    const nextMembers: Record<string, MemberEntry> = {};
    if (!opts.purgeDisconnected) {
      // Manual rotation keeps previous tickets valid for 25s so in-flight reconnects survive.
      for (const [hash, entry] of Object.entries(rawMembers)) {
        nextMembers[hash] = {
          ...entry,
          until: Math.min(entry.until, now + ROTATION_REJOIN_GRACE_MS),
          rotationGrace: true,
        };
      }
    }

    const pendingNotifications: Array<{ ws: WebSocket; msg: ServerMessage }> = [];
    let ticketIdx = 0;
    for (const { ws: peerWs, att } of peers) {
      const minted = creds.tickets[ticketIdx++];
      if (!minted) continue;
      nextMembers[minted.hash] = {
        until: now + CONNECTED_TICKET_TTL_MS,
        id: att.id,
        ...(att.sharing ? { sharing: true } : {}),
        ...(att.ip ? { ip: att.ip } : {}),
        ...((att.joinedAt ?? att.openedAt) !== undefined ? { joinedAt: att.joinedAt ?? att.openedAt } : {}),
        ...(att.creatorHost ? { creatorHost: true } : {}),
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
          ...(canSeeSecret ? { password: creds.newPassword } : {}),
          rejoinToken: minted.token,
        },
      });
    }

    await this.ctx.storage.put({
      ...opts.extraWrites,
      [PASSWORD_KEY]: creds.newPasswordHash,
      [ROOM_PASSWORD_KEY]: creds.newPassword,
      [MEMBERS_KEY]: capByExpiry(nextMembers, (m) => m.until, MAX_STORED_ENTRIES, this.activeRejoinHashes()),
    });

    for (const { ws: peerWs, msg } of pendingNotifications) {
      sendSafe(peerWs, msg);
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
    if (!this.joinedPeers(ws).some(({ att }) => att.id === clientMsg.id)) {
      sendSafe(ws, { t: "error", code: "unknown-peer", message: "Peer not found" });
      return;
    }

    const creds = await this.preMintRotationCredentials();

    await this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.get<boolean>(CLAIMED_KEY)) !== true) return;
      const freshCaller = getAttachment(ws);
      if (!freshCaller?.joined || !freshCaller.host) {
        sendSafe(ws, { t: "error", code: "not-host", message: "Only the host can remove people" });
        return;
      }
      const target = this.joinedPeers(ws).find(({ att }) => att.id === clientMsg.id);
      if (!target) {
        sendSafe(ws, { t: "error", code: "unknown-peer", message: "Peer not found" });
        return;
      }
      const now = Date.now();
      const extraWrites: Record<string, unknown> = {};
      if (target.att.ip) {
        const deny = await this.getDenyList(now);
        deny[target.att.ip] = now + KICK_BAN_MS;
        extraWrites[DENY_KEY] = capByExpiry(deny, (u) => u);
      }

      this.refused.add(target.ws);
      sendSafe(target.ws, { t: "error", code: "kicked", message: "You were removed from this room." });
      await this.handleLeaveInternal(target.ws, { kicked: true, skipAlarmSync: true });
      try {
        target.ws.close(1008, "Kicked");
      } catch {
        /* socket already closed */
      }

      const locked = await this.lockedNow();
      // Purge all disconnected rejoin tickets atomically alongside kick + password rotation.
      await this.applyRotationInTransaction(now, locked, this.joinedPeers(), {}, creds, {
        purgeDisconnected: true,
        extraWrites,
      });
      await this.syncAlarm(now);
    });
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
    const creds = await this.preMintRotationCredentials();
    await this.ctx.blockConcurrencyWhile(async () => {
      if ((await this.ctx.storage.get<boolean>(CLAIMED_KEY)) !== true) return;
      const freshCaller = getAttachment(ws);
      if (!freshCaller?.joined || !freshCaller.host) {
        sendSafe(ws, { t: "error", code: "not-host", message: "Only the host can rotate the invite code" });
        return;
      }
      const now = Date.now();
      const locked = await this.lockedNow();
      const peers = this.joinedPeers();
      const rawMembers = await this.getMembers(now);
      await this.applyRotationInTransaction(now, locked, peers, rawMembers, creds, {
        purgeDisconnected: false,
      });
      await this.syncAlarm(now);
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
          await this.ctx.storage.put({
            [MEMBERS_KEY]: capByExpiry(members, (m) => m.until, MAX_STORED_ENTRIES, this.activeRejoinHashes()),
          });
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
    ticketPeerId?: string,
  ): Array<{ ws: WebSocket; att: PeerAttachment }> {
    return this.joinedPeers(ws).filter(
      ({ att }) =>
        (offeredRejoinHash !== null &&
          att.rejoinHash !== undefined &&
          timingSafeEqualStr(att.rejoinHash, offeredRejoinHash)) ||
        (ticketPeerId !== undefined && att.id === ticketPeerId) ||
        (isHost && att.host === true),
    );
  }

  private applyResumeAttachment(
    attachment: PeerAttachment,
    clientMsg: Extract<ClientMessage, { t: "join" }>,
    supersededSocket: { ws: WebSocket; att: PeerAttachment } | undefined,
    memberTicket: MemberEntry | undefined,
  ): void {
    const tempJoinId = attachment.id;
    const preservedId = supersededSocket?.att.id ?? memberTicket?.id;
    if (preservedId) {
      if (tempJoinId !== preservedId) {
        this.budgets.delete(tempJoinId);
        this.badMessages.delete(tempJoinId);
      }
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
    ws: WebSocket,
    attachment: PeerAttachment,
    isResume: boolean,
    superseded: Array<{ ws: WebSocket; att: PeerAttachment }>,
  ): Promise<void> {
    if (isResume && superseded.length > 0) {
      for (const { ws: oldWs, att: oldAtt } of superseded) {
        const origOldId = oldAtt.id;
        if (origOldId !== attachment.id) {
          this.budgets.delete(origOldId);
          this.badMessages.delete(origOldId);
          for (const { ws: peerWs } of this.joinedPeers(ws)) {
            if (peerWs !== oldWs) {
              sendSafe(peerWs, { t: "peer-left", id: origOldId });
            }
          }
        }
        // Replace oldAtt.id and mark unjoined BEFORE forgetBudget(oldWs) so preservedId's
        // rate-limit and badMessages counters survive in-place resume.
        oldAtt.id = crypto.randomUUID();
        oldAtt.joined = false;
        try {
          oldWs.serializeAttachment(oldAtt);
        } catch {
          /* ignore */
        }
        this.refused.add(oldWs);
        this.forgetBudget(oldWs);
        sendSafe(oldWs, {
          t: "error",
          code: "session-replaced",
          message: "Your session was replaced from another tab.",
        });
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
      this.refused.add(oldWs);
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
    now: number,
  ): Promise<void> {
    const members = await this.getMembers(now);
    if (offeredRejoinHash) delete members[offeredRejoinHash];
    for (const { att } of superseded) {
      if (att.rejoinHash) delete members[att.rejoinHash];
    }
    members[newRejoinHash] = {
      until: now + CONNECTED_TICKET_TTL_MS,
      id: attachment.id,
      ...(attachment.sharing ? { sharing: true } : {}),
      ...(attachment.ip ? { ip: attachment.ip } : {}),
      ...(attachment.joinedAt !== undefined ? { joinedAt: attachment.joinedAt } : {}),
      ...(attachment.creatorHost ? { creatorHost: true } : {}),
    };
    const protectedHashes = this.activeRejoinHashes();
    protectedHashes.add(newRejoinHash);
    await this.ctx.storage.put({
      [MEMBERS_KEY]: capByExpiry(members, (m) => m.until, MAX_STORED_ENTRIES, protectedHashes),
      [EVER_JOINED_KEY]: true,
      ...(attachment.creatorHost === true ? { [LAST_HOST_ACTIVE_KEY]: now } : {}),
    });
    if (isHost) await this.ctx.storage.delete(HOST_GONE_KEY);
  }

  /**
   * Enforce empty-room 15-minute session cleanup and 12h/90d credential expiry lazily
   * if an alarm was delayed, while performing zero storage writes on unclaimed rooms.
   */
  private async reconcileEmptyTimersBeforeAdmit(
    ws: WebSocket,
    now: number,
    preRotated: { password: string; passwordHash: string },
  ): Promise<"expired" | "ok"> {
    if ((await this.ctx.storage.get<boolean>(CLAIMED_KEY)) !== true) return "ok";
    const existingPeers = this.joinedPeers(ws);
    if (existingPeers.length > 0) {
      const creatorCap = await this.creatorActivityCap(existingPeers, now);
      if (now >= creatorCap) {
        await this.expireRoom(ws);
        return "expired";
      }
      return "ok";
    }
    const [emptySince, sessionCleanedRaw, everJoinedRaw, lastHostActiveAt, creatorHostHash] = await Promise.all([
      this.ctx.storage.get<number>(EMPTY_SINCE_KEY),
      this.ctx.storage.get<boolean>(SESSION_CLEANED_KEY),
      this.ctx.storage.get<boolean>(EVER_JOINED_KEY),
      this.ctx.storage.get<number>(LAST_HOST_ACTIVE_KEY),
      this.ctx.storage.get<string>(CREATOR_HOST_KEY),
    ]);
    const sessionCleaned = sessionCleanedRaw === true;
    const everJoined = everJoinedRaw === true;
    if (emptySince === undefined) {
      const capTtl = creatorHostHash !== undefined ? EMPTY_ROOM_TTL_MS : UNUSED_ROOM_TTL_MS;
      if (
        lastHostActiveAt !== undefined &&
        now >= lastHostActiveAt + capTtl &&
        (creatorHostHash === undefined || everJoined)
      ) {
        await this.expireRoom(ws);
        return "expired";
      }
      if (creatorHostHash === undefined) {
        await this.reconcileLegacyCreatorState(now, now, lastHostActiveAt);
      }
      await this.ctx.storage.put(EMPTY_SINCE_KEY, now);
      return "ok";
    }
    const credentialExpiry = computeCredentialExpiry(
      emptySince,
      everJoined,
      lastHostActiveAt,
      creatorHostHash !== undefined,
    );
    if (now >= credentialExpiry) {
      await this.expireRoom(ws);
      return "expired";
    }
    if (creatorHostHash === undefined) {
      await this.reconcileLegacyCreatorState(now, emptySince, lastHostActiveAt);
    }
    if (!sessionCleaned && now - emptySince >= EMPTY_SESSION_CLEANUP_MS) {
      await this.resetEmptySessionState(now, preRotated);
    }
    return "ok";
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
    const [newRejoinHash, preRotated] = await Promise.all([
      this.hashSecret(newRejoinToken, "rejoin"),
      this.preMintEmptyResetSecret(),
    ]);

    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.gone.has(attachment.id) || this.refused.has(ws)) return;

      const now = Date.now();
      if ((await this.reconcileEmptyTimersBeforeAdmit(ws, now, preRotated)) === "expired") {
        this.refuse(ws, "bad-password", "Invalid or expired room invite.");
        return;
      }

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

      const superseded = this.findSupersededPeers(
        ws,
        offeredRejoinHash,
        admission.isHost,
        admission.memberTicket?.id,
      );
      const isResume = clientMsg.resume === true && admission.returning;
      const supersededSocket = superseded[0];
      const replacesId = supersededSocket?.att.id ?? admission.memberTicket?.id;

      const rawPromoted = await this.ctx.storage.get<unknown>(PROMOTED_HOST_KEY);
      const promotedParsed = PromotedHostSchema.safeParse(rawPromoted);
      const promoted = promotedParsed.success ? promotedParsed.data : null;
      let effectiveIsHost = admission.isHost || supersededSocket?.att.host === true;
      let reissuedHostToken: string | undefined;
      if (admission.isHost) {
        if (rawPromoted !== undefined) {
          await this.ctx.storage.delete(PROMOTED_HOST_KEY);
          await this.ctx.storage.put(HOST_PROMOTED_KEY, true);
        }
      } else if (admission.returning && promoted && replacesId === promoted.id) {
        effectiveIsHost = true;
        reissuedHostToken = promoted.token;
        await this.ctx.storage.delete(PROMOTED_HOST_KEY);
        await this.ctx.storage.put(HOST_PROMOTED_KEY, true);
      }

      const prevPeerState = supersededSocket
        ? {
            sharing: supersededSocket.att.sharing,
            name: supersededSocket.att.name,
            host: supersededSocket.att.host === true,
          }
        : undefined;

      const joinNow = Date.now();
      attachment.joinedAt = supersededSocket?.att.joinedAt ?? admission.memberTicket?.joinedAt ?? joinNow;

      if (isResume) {
        this.applyResumeAttachment(attachment, clientMsg, supersededSocket, admission.memberTicket);
      }

      const resumedInPlace =
        isResume && superseded.length > 0 && (!supersededSocket || supersededSocket.att.id === attachment.id);

      await this.evictSupersededPeers(ws, attachment, isResume, superseded);

      const others = this.joinedPeers(ws);
      if (others.length >= MAX_ROOM_SIZE) {
        this.refuse(ws, "room-full", "Room is full");
        return;
      }

      attachment.name = sanitiseName(clientMsg.displayName);
      attachment.joined = true;
      if (!isResume) attachment.sharing = false;
      attachment.host = effectiveIsHost;
      attachment.creatorHost =
        admission.isCreatorHost ||
        admission.memberTicket?.creatorHost === true ||
        supersededSocket?.att.creatorHost === true;
      attachment.rejoinHash = newRejoinHash;

      await this.persistMemberRecord(
        attachment,
        offeredRejoinHash,
        newRejoinHash,
        effectiveIsHost,
        superseded,
        joinNow,
      );

      try {
        ws.serializeAttachment(attachment);
      } catch {
        return;
      }

      await this.syncAlarm(joinNow);

      const canSeePassword = effectiveIsHost || !admission.locked;
      sendSafe(ws, {
        t: "welcome",
        selfId: attachment.id,
        peers: others.map(({ att }) => ({
          id: att.id,
          name: att.name,
          sharing: att.sharing,
          ...(att.host ? { host: true } : {}),
        })),
        host: effectiveIsHost,
        ...(reissuedHostToken !== undefined ? { hostToken: reissuedHostToken } : {}),
        ...(canSeePassword && admission.roomPassword ? { password: admission.roomPassword } : {}),
        rejoinToken: newRejoinToken,
        locked: admission.locked,
      });

      broadcastJoinOutcome(
        attachment,
        resumedInPlace,
        prevPeerState,
        effectiveIsHost,
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
        isCreatorHost: boolean;
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
    const creatorHostHash = (await this.ctx.storage.get<string>(CREATOR_HOST_KEY)) ?? null;
    const isHost =
      tokens.offeredHostHash !== null &&
      hostHash !== null &&
      timingSafeEqualStr(tokens.offeredHostHash, hostHash);
    const isCreatorHost =
      tokens.offeredHostHash !== null &&
      creatorHostHash !== null &&
      timingSafeEqualStr(tokens.offeredHostHash, creatorHostHash);
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
    if (isHost) return { ok: true, isHost, isCreatorHost, locked, returning, roomPassword, memberTicket };
    if (returning) return { ok: true, isHost, isCreatorHost, locked, returning: true, roomPassword, memberTicket };

    if (locked) {
      return { ok: false, code: "room-locked", message: "This room is locked. Ask the host to unlock it." };
    }
    if (tokens.ip) {
      const deny = await this.getDenyList(now);
      if (deny[tokens.ip] !== undefined) {
        return { ok: false, code: "kicked", message: "You were removed from this room." };
      }
    }
    return { ok: true, isHost, isCreatorHost, locked, returning: false, roomPassword };
  }

  /** Whether the room is currently locked (occupied rooms never auto-unlock on host absence; empty rooms reset after 15m). */
  private async lockedNow(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>(LOCKED_KEY)) === true;
  }

  /** Live rejoin tickets, hash to expiry, retaining entries for still-connected sockets. */
  private async getMembers(now: number, extraProtectedHashes?: ReadonlySet<string>): Promise<Record<string, MemberEntry>> {
    const all = (await this.ctx.storage.get<Record<string, unknown>>(MEMBERS_KEY)) ?? {};
    const activeHashes = this.activeRejoinHashes();
    const live: Record<string, MemberEntry> = {};
    for (const [k, val] of Object.entries(all)) {
      const parsed = MemberEntrySchema.safeParse(val);
      if (parsed.success && (parsed.data.until > now || activeHashes.has(k) || extraProtectedHashes?.has(k))) {
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

    if ((await this.ctx.storage.get<boolean>(CLAIMED_KEY)) !== true) {
      return;
    }

    // Upsert/shrink disconnected non-kicked rejoin ticket TTL to 5 minutes from disconnect.
    if (!opts?.kicked && attachment.rejoinHash) {
      const now = Date.now();
      const members = await this.getMembers(now, new Set([attachment.rejoinHash]));
      const existing = members[attachment.rejoinHash];
      // Preserve an active short rotation-grace window, otherwise grant the full 5m disconnect TTL.
      const isRotationGrace = existing?.rotationGrace === true && existing.until > now;
      const nextUntil = isRotationGrace ? existing.until : now + DISCONNECTED_REJOIN_TTL_MS;
      const ip = existing?.ip ?? attachment.ip;
      const joinedAt = existing?.joinedAt ?? attachment.joinedAt ?? attachment.openedAt;
      const creatorHost = existing?.creatorHost === true || attachment.creatorHost === true;
      members[attachment.rejoinHash] = {
        until: nextUntil,
        id: attachment.id,
        ...(attachment.sharing ? { sharing: true } : {}),
        ...(ip !== undefined ? { ip } : {}),
        ...(joinedAt !== undefined ? { joinedAt } : {}),
        ...(isRotationGrace ? { rotationGrace: true } : {}),
        ...(creatorHost ? { creatorHost: true } : {}),
      };
      await this.ctx.storage.put({
        [MEMBERS_KEY]: capByExpiry(members, (m) => m.until, MAX_STORED_ENTRIES, this.activeRejoinHashes()),
      });
    }

    if (attachment.creatorHost === true) {
      await this.ctx.storage.put(LAST_HOST_ACTIVE_KEY, Date.now());
    }

    if (!opts?.skipAlarmSync) {
      await this.syncAlarm(Date.now());
    }
  }
}
