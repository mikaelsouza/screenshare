import { MAX_ROOM_SIZE, isValidRoomCode, z } from "@shared/protocol";

/**
 * Ceiling on total sockets held by one room, joined or not. Generous relative to
 * MAX_ROOM_SIZE so reconnects and half-open sockets are not turned into failures.
 */
export const MAX_SOCKETS: number = MAX_ROOM_SIZE * 4;

/** Sockets one IP may hold in a single room (2x room cap for CGNAT/household + reconnects). */
export const MAX_SOCKETS_PER_IP: number = MAX_ROOM_SIZE * 2;

/** Storage key marking that this room has been initialized by POST /api/room. */
export const CLAIMED_KEY = "claimed";

/** Storage key holding the canonical 8-character room code for /ws/:code binding checks. */
export const ROOM_CODE_KEY = "roomCode";

/** Storage key holding the salted SHA-256 hex digest of the active room invite secret. */
export const PASSWORD_KEY = "passwordHash";

/** Storage key holding the current plaintext room invite secret (cleared on alarm expiry or rotated). */
export const ROOM_PASSWORD_KEY = "roomPassword";

/** Storage key holding the salted hash of the current host token. */
export const HOST_KEY = "hostTokenHash";

/** Storage key holding the room creator's salted host token hash, restored after empty-session cleanup. */
export const CREATOR_HOST_KEY = "creatorHostTokenHash";

/** Storage key: rejoin tickets, as salted hash to MemberEntry. */
export const MEMBERS_KEY = "members";

/** Storage key: when the last host socket left, for 5-minute universal host promotion. */
export const HOST_GONE_KEY = "hostGoneAt";

/** Storage key: when the last joined peer left, for 15-minute session cleanup and room expiration. */
export const EMPTY_SINCE_KEY = "emptySince";

/** Storage key: true once empty-session state (members, bans, promotedHost, lock) has been cleared. */
export const SESSION_CLEANED_KEY = "sessionCleaned";

/** Storage key: true once at least one peer has successfully joined the room. */
export const EVER_JOINED_KEY = "everJoined";

/** Storage key: timestamp when the room creator was last active, capping non-host TTL sliding. */
export const LAST_HOST_ACTIVE_KEY = "lastHostActiveAt";

/** Storage key: host promotion credential waiting to be delivered on half-open resume. */
export const PROMOTED_HOST_KEY = "promotedHost";

/** Storage key: durable marker set whenever a mid-session host promotion occurs or is claimed, cleared on 15m reset. */
export const HOST_PROMOTED_KEY = "hostPromoted";

/** Storage key: true while the host has locked the room to new joins. */
export const LOCKED_KEY = "locked";

/** Storage key: rate-limit keys of kicked peers, each mapped to when its ban ends. */
export const DENY_KEY = "deny";

/** How long an occupied room waits for its host to return before promoting the earliest member. */
export const HOST_GRACE_MS: number = 5 * 60 * 1000;

/** How long a disconnected peer's rejoin ticket remains valid before expiring. */
export const DISCONNECTED_REJOIN_TTL_MS: number = 5 * 60 * 1000;

/** Overlap window exceeding max client reconnect backoff so in-flight reconnects survive manual rotation. */
export const ROTATION_REJOIN_GRACE_MS = 25_000;

/** Baseline TTL for connected rejoin tickets; live sockets stay valid past this. */
export const CONNECTED_TICKET_TTL_MS: number = 24 * 60 * 60 * 1000;

/** How long an empty room keeps ephemeral session state before resetting for the next session. */
export const EMPTY_SESSION_CLEANUP_MS: number = 15 * 60 * 1000;

/** Safety fallback alarm cadence while a room is occupied, catching missed close events within 15 minutes. */
export const OCCUPIED_FALLBACK_ALARM_MS: number = 15 * 60 * 1000;

/** How long an unused room created by POST /api/room survives without any join. */
export const UNUSED_ROOM_TTL_MS: number = 12 * 60 * 60 * 1000;

/** Hard cap on stored ticket/deny maps so a single DO key stays well below Cloudflare's 128 KiB limit. */
export const MAX_STORED_ENTRIES = 128;

/** How long a kicked address is refused. */
export const KICK_BAN_MS: number = 15 * 60 * 1000;

/** How long an empty room keeps its credentials before the object erases itself. */
export const EMPTY_ROOM_TTL_MS: number = 90 * 24 * 60 * 60 * 1000;

/** Fixed-length sentinel hex digest so uninitialized rooms still run constant-time comparison. */
export const DUMMY_HASH_HEX: string = "0".repeat(64);

/** Largest raw frame accepted, checked before JSON.parse. */
export const MAX_FRAME_LENGTH: number = 80 * 1024;

/** Per-socket message budget: a token bucket of MESSAGE_BURST, refilled at MESSAGE_REFILL_PER_SEC. */
export const MESSAGE_BURST = 320;
export const MESSAGE_REFILL_PER_SEC = 40;

/** How long a socket may stay open without joining. */
export const JOIN_DEADLINE_MS = 10_000;

/** Unparseable messages a socket may send before it is closed. */
export const MAX_BAD_MESSAGES = 5;

export interface MemberEntry {
  until: number;
  id?: string;
  sharing?: boolean;
  ip?: string;
  joinedAt?: number;
  rotationGrace?: boolean;
  creatorHost?: boolean;
}

export const MemberEntrySchema: z.ZodType<MemberEntry> = z
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

export interface PromotedHostRecord {
  id: string;
  token: string;
}

export const PromotedHostSchema: z.ZodType<PromotedHostRecord> = z.object({
  id: z.string().min(1),
  token: z.string().min(1),
});

export interface PeerAttachment {
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

export const PeerAttachmentSchema: z.ZodType<PeerAttachment> = z
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

export const InitBodySchema: z.ZodType<{ code: string }> = z.object({
  code: z.string().refine(isValidRoomCode),
});

export interface MessageBudget {
  tokens: number;
  updatedAt: number;
}

export interface PreMintedRotation {
  newPassword: string;
  newPasswordHash: string;
  tickets: Array<{ token: string; hash: string }>;
}

export interface PreMintedEmptyReset {
  password: string;
  passwordHash: string;
}

/**
 * A display name safe to show other people.
 *
 * NFKC-folds look-alikes, strips control/format characters, and caps both Unicode
 * code points and UTF-16 code units at <= 32 so PeerInfoSchema never rejects astral
 * characters on the client.
 */
export function sanitiseName(raw: string): string {
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

/** Evict oldest-expiring entries when a persisted map exceeds MAX_STORED_ENTRIES, protecting active keys. */
export function capByExpiry<T>(
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

/** Filter raw persisted member records to live or protected entries. */
export function filterLiveMembers(
  raw: Record<string, unknown>,
  now: number,
  activeHashes: ReadonlySet<string>,
  extraProtectedHashes?: ReadonlySet<string>,
): Record<string, MemberEntry> {
  const live: Record<string, MemberEntry> = {};
  for (const [k, val] of Object.entries(raw)) {
    const parsed = MemberEntrySchema.safeParse(val);
    if (parsed.success && (parsed.data.until > now || activeHashes.has(k) || extraProtectedHashes?.has(k))) {
      live[k] = parsed.data;
    }
  }
  return live;
}

/** Filter raw persisted deny-list entries to unexpired bans. */
export function filterLiveDenyList(
  raw: Record<string, number>,
  now: number,
): Record<string, number> {
  return Object.fromEntries(Object.entries(raw).filter(([, until]) => until > now));
}

/** Refill and spend one token from a per-socket message budget. */
export function spendBudget(
  existing: MessageBudget | undefined,
  now: number,
  burst: number = MESSAGE_BURST,
  refillPerSec: number = MESSAGE_REFILL_PER_SEC,
): { allowed: boolean; budget: MessageBudget } {
  const budget = existing ?? { tokens: burst, updatedAt: now };
  const elapsed = Math.max(0, (now - budget.updatedAt) / 1000);
  const refilled = Math.min(burst, budget.tokens + elapsed * refillPerSec);
  if (refilled < 1) {
    return { allowed: false, budget: { tokens: refilled, updatedAt: now } };
  }
  return { allowed: true, budget: { tokens: refilled - 1, updatedAt: now } };
}
