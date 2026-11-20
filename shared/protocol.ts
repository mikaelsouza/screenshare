import { z } from "zod";

// Disable Zod v4's `new Function` JIT probe once in the shared protocol entry so
// strict CSP + Trusted Types (`require-trusted-types-for 'script'`) never sees a
// `securitypolicyviolation`. Other modules import `{ z }` from `@shared/protocol`.
z.config({ jitless: true });
export { z };

/**
 * Hard room cap.
 *
 * Upload cost is linear in room size and paid by the sharer's uplink: each viewer
 * receives one stream at the selected preset's maxBitrate (12 Mbps at the default
 * 1080p60, 8 Mbps for 1080p30/720p60, 6 Mbps for 720p30). An 8-person room therefore
 * needs ~84 Mbps up at the default, and the 20-person cap ~228 Mbps — past ordinary home
 * uplinks. Per-peer WebRTC congestion control and send-side pausing for unwatched tiles
 * are what keep the mesh viable at these sizes. The cap is where the mesh shape still
 * holds; beyond it an SFU is needed.
 */
export const MAX_ROOM_SIZE = 20;
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no O/0/I/1/L
export const ROOM_CODE_LENGTH = 8;
const ROOM_PASSWORD_ALPHABET: string = ROOM_CODE_ALPHABET;
export const ROOM_PASSWORD_LENGTH = 16;

/**
 * Largest SDP blob accepted in a signal.
 *
 * A real offer for an 8-way mesh with a handful of codecs runs to a few KB; 64 KB is
 * far above anything legitimate. Without a cap, a joined peer can send a 1 MB `sdp`
 * in a tight loop: every frame wakes the Durable Object and is forwarded verbatim to
 * the victim's socket, which is server-mediated amplification against a peer plus
 * unbounded object CPU and wall-clock billing.
 */
export const MAX_SDP_LENGTH: number = 64 * 1024;

/** Largest ICE candidate line accepted. Real ones are a couple of hundred bytes. */
export const MAX_CANDIDATE_LENGTH = 1024;

/** Maximum UTF-16 code units allowed in a chat message. */
export const MAX_CHAT_LENGTH = 500;

/**
 * Peer ids are server-issued crypto.randomUUID() values. Anything else in a `to` field
 * cannot name a peer, so it is rejected at parse time rather than carried further.
 */
const PEER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ROOM_CODE_REGEX = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
const ROOM_PASSWORD_REGEX = new RegExp(`^[${ROOM_PASSWORD_ALPHABET}]{${ROOM_PASSWORD_LENGTH}}$`);

export const PING = "ping";
export const PONG = "pong";

export type PeerId = string;
export interface PeerInfo {
  id: PeerId;
  name: string;
  sharing: boolean;
  /** The room's creator, who can remove people and lock the room. */
  host?: boolean;
}
export interface IceCandidateInit {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}
export type SignalData =
  | { k: "offer"; sdp: string }
  | { k: "answer"; sdp: string }
  | { k: "ice"; candidate: IceCandidateInit };

export interface ChatMessage {
  id: string;
  from: PeerId;
  name: string;
  text: string;
  ts: number;
}

export type ClientMessage =
  | {
      t: "join";
      room: string;
      displayName: string;
      /** Room invite secret required for new admissions. */
      password?: string;
      /** Proof of being the room's creator, from an earlier welcome. */
      hostToken?: string;
      /** Proof of having been in this room, from the last welcome: rejoin past a lock. */
      rejoinToken?: string;
      /** In-place signaling reconnect: preserve selfId and active P2P links when rejoinToken is valid. */
      resume?: boolean;
      /** Current sharing state on an in-place resume, so peers do not see sharing drop to false. */
      sharing?: boolean;
    }
  | { t: "signal"; to: PeerId; data: SignalData }
  | { t: "state"; sharing: boolean }
  /** Host only: remove a peer from the room. */
  | { t: "kick"; id: PeerId }
  /** Host only: refuse (or allow again) new joins. */
  | { t: "lock"; locked: boolean }
  /** Host only: mint a fresh room invite secret and invalidate previous links. */
  | { t: "rotate-password" }
  /** Joined peer: update display name in place without dropping the room session. */
  | { t: "rename"; displayName: string }
  /** Joined peer: broadcast an ephemeral chat message to the room. */
  | { t: "chat"; text: string };

export type ServerMessage =
  | {
      t: "welcome";
      selfId: PeerId;
      peers: PeerInfo[];
      /** Whether this socket is the room's host. */
      host: boolean;
      /** Current room invite secret (omitted for non-hosts when room is locked). */
      password?: string;
      /** Issued once, to the join that creates the room. Keep it to stay host on reconnect. */
      hostToken?: string;
      /** Present it on the next join to get back in even if the room is locked. */
      rejoinToken?: string;
      locked: boolean;
    }
  | { t: "peer-joined"; peer: PeerInfo; replaces?: PeerId }
  | { t: "peer-left"; id: PeerId; kicked?: boolean }
  | { t: "signal"; from: PeerId; data: SignalData }
  | { t: "peer-state"; id: PeerId; sharing: boolean }
  | { t: "room-state"; locked: boolean; password?: string }
  | { t: "room-password"; password?: string; rejoinToken?: string }
  | { t: "peer-renamed"; id: PeerId; name: string }
  | { t: "host-promoted"; hostId: PeerId; hostToken?: string; password?: string }
  | ({ t: "chat" } & ChatMessage)
  | { t: "error"; code: ErrorCode; message: string };

export type ErrorCode =
  | "room-full"
  | "bad-message"
  | "unknown-peer"
  | "bad-room-code"
  | "bad-password"
  | "session-replaced"
  | "forbidden-origin"
  | "rate-limited"
  | "join-timeout"
  | "kicked"
  | "room-locked"
  | "not-host"
  | "not-sharing"
  | "chat-rate-limited";

/** Longest host token accepted. Real ones are UUIDs, 36 characters. */
const MAX_HOST_TOKEN_LENGTH = 64;

/** Longest invite secret accepted on the wire. */
const MAX_PASSWORD_WIRE_LENGTH = 128;

export interface NewRoomResponse {
  code: string;
  password: string;
  hostToken: string;
}

export type InviteParseFailureReason = "empty" | "url-missing-invite" | "missing-secret" | "invalid";

export type InviteParseResult =
  | { ok: true; code: string; password: string }
  | { ok: false; reason: InviteParseFailureReason };

const RoomCodeSchema: z.ZodType<string> = z.string().regex(ROOM_CODE_REGEX);

const PeerUuidSchema: z.ZodType<PeerId> = z.string().regex(PEER_ID);

const ChatTextSchema: z.ZodType<string> = z.string().min(1).refine((s) => s.length <= MAX_CHAT_LENGTH);

const IceCandidateInitSchema: z.ZodType<IceCandidateInit> = z
  .object({
    candidate: z.string().max(MAX_CANDIDATE_LENGTH),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().nullable().optional(),
    usernameFragment: z.string().nullable().optional(),
  })
  .transform(
    ({ candidate, sdpMid, sdpMLineIndex, usernameFragment }): IceCandidateInit => ({
      candidate,
      sdpMid: sdpMid ?? null,
      sdpMLineIndex: sdpMLineIndex ?? null,
      ...(usernameFragment !== undefined ? { usernameFragment } : {}),
    }),
  );

const SignalDataSchema: z.ZodType<SignalData> = z.discriminatedUnion("k", [
  z.object({
    k: z.literal("offer"),
    sdp: z.string().max(MAX_SDP_LENGTH),
  }),
  z.object({
    k: z.literal("answer"),
    sdp: z.string().max(MAX_SDP_LENGTH),
  }),
  z.object({
    k: z.literal("ice"),
    candidate: IceCandidateInitSchema,
  }),
]);

const JoinClientMessageSchema = z
  .object({
    t: z.literal("join"),
    room: z.string(),
    displayName: z.string().max(512),
    password: z.string().min(1).max(MAX_PASSWORD_WIRE_LENGTH).optional().catch(undefined),
    hostToken: z.string().min(1).max(MAX_HOST_TOKEN_LENGTH).optional().catch(undefined),
    rejoinToken: z.string().min(1).max(MAX_HOST_TOKEN_LENGTH).optional().catch(undefined),
    resume: z.literal(true).optional().catch(undefined),
    sharing: z.boolean().optional().catch(undefined),
  })
  .transform(({ t, room, displayName, password, hostToken, rejoinToken, resume, sharing }) => ({
    t,
    room,
    displayName,
    ...(password !== undefined ? { password } : {}),
    ...(hostToken !== undefined ? { hostToken } : {}),
    ...(rejoinToken !== undefined ? { rejoinToken } : {}),
    ...(resume === true ? { resume: true } : {}),
    ...(sharing !== undefined ? { sharing } : {}),
  }));

const ClientMessageSchema: z.ZodType<ClientMessage> = z.discriminatedUnion("t", [
  JoinClientMessageSchema,
  z.object({
    t: z.literal("signal"),
    to: PeerUuidSchema,
    data: SignalDataSchema,
  }),
  z.object({
    t: z.literal("state"),
    sharing: z.boolean(),
  }),
  z.object({
    t: z.literal("kick"),
    id: PeerUuidSchema,
  }),
  z.object({
    t: z.literal("lock"),
    locked: z.boolean(),
  }),
  z.object({
    t: z.literal("rotate-password"),
  }),
  z.object({
    t: z.literal("rename"),
    displayName: z.string().max(128),
  }),
  z.object({
    t: z.literal("chat"),
    text: ChatTextSchema,
  }),
]);

const PeerInfoSchema: z.ZodType<PeerInfo> = z
  .object({
    id: z.string().min(1),
    name: z.string().max(32),
    sharing: z.boolean(),
    host: z.boolean().optional(),
  })
  .transform(
    ({ id, name, sharing, host }): PeerInfo => ({
      id,
      name,
      sharing,
      ...(host !== undefined ? { host } : {}),
    }),
  );

const ErrorCodeSchema: z.ZodType<ErrorCode> = z.enum([
  "room-full",
  "bad-message",
  "unknown-peer",
  "bad-room-code",
  "bad-password",
  "session-replaced",
  "forbidden-origin",
  "rate-limited",
  "join-timeout",
  "kicked",
  "room-locked",
  "not-host",
  "not-sharing",
  "chat-rate-limited",
]);

const WelcomeServerMessageSchema = z
  .object({
    t: z.literal("welcome"),
    // Server-side peer IDs intentionally accept any non-empty string (`z.string().min(1)`)
    // rather than strict UUIDs, preserving compatibility with synthetic unit-test IDs on
    // the trusted-server boundary.
    selfId: z.string().min(1),
    peers: z.array(PeerInfoSchema).max(MAX_ROOM_SIZE),
    // Omitted `host` and `locked` fields intentionally resolve to `false` for backward
    // compatibility with older welcome payloads and unit tests; do not make them required.
    host: z.boolean().optional().default(false),
    password: z.string().min(1).max(MAX_PASSWORD_WIRE_LENGTH).optional(),
    hostToken: z.string().min(1).max(MAX_HOST_TOKEN_LENGTH).optional(),
    rejoinToken: z.string().min(1).max(MAX_HOST_TOKEN_LENGTH).optional(),
    locked: z.boolean().optional().default(false),
  })
  .transform(({ t, selfId, peers, host, password, hostToken, rejoinToken, locked }) => ({
    t,
    selfId,
    peers,
    host,
    ...(password !== undefined ? { password } : {}),
    ...(hostToken !== undefined ? { hostToken } : {}),
    ...(rejoinToken !== undefined ? { rejoinToken } : {}),
    locked,
  }));

const PeerJoinedServerMessageSchema = z
  .object({
    t: z.literal("peer-joined"),
    peer: PeerInfoSchema,
    replaces: z.string().min(1).optional(),
  })
  .transform(({ t, peer, replaces }) => ({
    t,
    peer,
    ...(replaces !== undefined ? { replaces } : {}),
  }));

const PeerLeftServerMessageSchema = z
  .object({
    t: z.literal("peer-left"),
    id: z.string().min(1),
    kicked: z.boolean().optional(),
  })
  .transform(({ t, id, kicked }) => ({
    t,
    id,
    ...(kicked !== undefined ? { kicked } : {}),
  }));

const RoomStateServerMessageSchema = z
  .object({
    t: z.literal("room-state"),
    locked: z.boolean(),
    password: z.string().min(1).max(MAX_PASSWORD_WIRE_LENGTH).optional(),
  })
  .transform(({ t, locked, password }) => ({
    t,
    locked,
    ...(password !== undefined ? { password } : {}),
  }));

const RoomPasswordServerMessageSchema = z
  .object({
    t: z.literal("room-password"),
    password: z.string().min(1).max(MAX_PASSWORD_WIRE_LENGTH).optional(),
    rejoinToken: z.string().min(1).max(MAX_HOST_TOKEN_LENGTH).optional(),
  })
  .transform(({ t, password, rejoinToken }) => ({
    t,
    ...(password !== undefined ? { password } : {}),
    ...(rejoinToken !== undefined ? { rejoinToken } : {}),
  }));

const HostPromotedServerMessageSchema = z
  .object({
    t: z.literal("host-promoted"),
    hostId: z.string().min(1),
    hostToken: z.string().min(1).max(MAX_HOST_TOKEN_LENGTH).optional(),
    password: z.string().min(1).max(MAX_PASSWORD_WIRE_LENGTH).optional(),
  })
  .transform(({ t, hostId, hostToken, password }) => ({
    t,
    hostId,
    ...(hostToken !== undefined ? { hostToken } : {}),
    ...(password !== undefined ? { password } : {}),
  }));

// Server-originated peer IDs (`id`, `from`) intentionally accept any non-empty string
// to preserve backward compatibility with existing signaling tests.
const ServerMessageSchema: z.ZodType<ServerMessage> = z.discriminatedUnion("t", [
  WelcomeServerMessageSchema,
  PeerJoinedServerMessageSchema,
  PeerLeftServerMessageSchema,
  z.object({
    t: z.literal("signal"),
    from: z.string().min(1),
    data: SignalDataSchema,
  }),
  z.object({
    t: z.literal("peer-state"),
    id: z.string().min(1),
    sharing: z.boolean(),
  }),
  RoomStateServerMessageSchema,
  RoomPasswordServerMessageSchema,
  z.object({
    t: z.literal("peer-renamed"),
    id: z.string().min(1),
    name: z.string().max(32),
  }),
  HostPromotedServerMessageSchema,
  z.object({
    t: z.literal("chat"),
    id: z.string().min(1).max(64),
    from: z.string().min(1),
    name: z.string().max(32),
    text: ChatTextSchema,
    ts: z.number().finite(),
  }),
  z.object({
    t: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string(),
  }),
]);

const RoomPasswordSchema: z.ZodType<string> = z.string().regex(ROOM_PASSWORD_REGEX);

const NewRoomResponseSchema: z.ZodType<NewRoomResponse> = z.object({
  code: RoomCodeSchema,
  password: RoomPasswordSchema,
  hostToken: z.string().min(1).max(MAX_HOST_TOKEN_LENGTH),
});

function randomFromAlphabet(alphabet: string, length: number): string {
  const alphabetLen = alphabet.length;
  // Largest multiple of alphabetLen <= 256 to avoid modulo bias
  const limit = Math.floor(256 / alphabetLen) * alphabetLen;
  const buffer = new Uint8Array(length * 2);
  let out = "";

  while (out.length < length) {
    crypto.getRandomValues(buffer);
    for (let i = 0; i < buffer.length && out.length < length; i++) {
      const byte = buffer[i];
      if (byte !== undefined && byte < limit) {
        out += alphabet.charAt(byte % alphabetLen);
      }
    }
  }

  return out;
}

/**
 * Generate an 8-character room code using rejection sampling to eliminate modulo bias.
 * Works in both Cloudflare Workers and modern browsers.
 */
export function generateRoomCode(): string {
  return randomFromAlphabet(ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH);
}

/**
 * Generate a 16-character room invite secret using rejection sampling (~79.3 bits entropy).
 */
export function generateRoomPassword(): string {
  return randomFromAlphabet(ROOM_PASSWORD_ALPHABET, ROOM_PASSWORD_LENGTH);
}

/**
 * Validate that a value conforms to the room code specification (exact length and valid alphabet).
 */
export function isValidRoomCode(s: unknown): s is string {
  return RoomCodeSchema.safeParse(s).success;
}

/**
 * Validate that a value conforms to the room invite secret specification.
 */
export function isValidRoomPassword(s: unknown): s is string {
  return RoomPasswordSchema.safeParse(s).success;
}

/**
 * Format the canonical single invite code shared in URL fragments and manual entry.
 */
export function formatInviteCode(code: string, password: string): string {
  return `${code}-${password}`;
}

/**
 * Parse a user-entered invite string or full invite URL (`https://.../#CODE-SECRET`).
 * Inspects URL fragments BEFORE uppercasing so hostnames or paths containing dots/hyphens
 * are never confused with invite separators.
 */
function decodeFragment(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw;
  }
}

function extractInviteCandidate(
  trimmed: string,
): { ok: true; candidate: string } | { ok: false; reason: InviteParseFailureReason } {
  if (/^https?:\/\//i.test(trimmed)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      return { ok: false, reason: "invalid" };
    }
    const fragment = parsedUrl.hash.replace(/^#+/, "").trim();
    if (!fragment) return { ok: false, reason: "url-missing-invite" };
    return { ok: true, candidate: decodeFragment(fragment) };
  }

  const hashIdx = trimmed.indexOf("#");
  if (hashIdx !== -1) {
    const beforeHash = trimmed.slice(0, hashIdx);
    const afterHash = trimmed.slice(hashIdx + 1).replace(/^#+/, "").trim();
    if (!afterHash) {
      return beforeHash.trim().length > 0
        ? { ok: false, reason: "url-missing-invite" }
        : { ok: false, reason: "empty" };
    }
    return { ok: true, candidate: decodeFragment(afterHash) };
  }

  if (/^(?:\/|[a-z0-9.-]+\.[a-z]{2,}\/)/i.test(trimmed)) {
    return { ok: false, reason: "url-missing-invite" };
  }
  return { ok: true, candidate: trimmed };
}

function parseInviteTokens(upper: string): InviteParseResult {
  const sepMatch = /^([A-Z0-9]+)[-.]([A-Z0-9]*)$/.exec(upper);
  if (sepMatch) {
    const codePart = sepMatch[1] ?? "";
    const passPart = sepMatch[2] ?? "";
    if (passPart.length === 0) {
      return isValidRoomCode(codePart) ? { ok: false, reason: "missing-secret" } : { ok: false, reason: "invalid" };
    }
    return isValidRoomCode(codePart) && isValidRoomPassword(passPart)
      ? { ok: true, code: codePart, password: passPart }
      : { ok: false, reason: "invalid" };
  }

  if (upper.length === ROOM_CODE_LENGTH + ROOM_PASSWORD_LENGTH) {
    const codePart = upper.slice(0, ROOM_CODE_LENGTH);
    const passPart = upper.slice(ROOM_CODE_LENGTH);
    return isValidRoomCode(codePart) && isValidRoomPassword(passPart)
      ? { ok: true, code: codePart, password: passPart }
      : { ok: false, reason: "invalid" };
  }

  return isValidRoomCode(upper) ? { ok: false, reason: "missing-secret" } : { ok: false, reason: "invalid" };
}

export function parseInviteInput(raw: string): InviteParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  const extracted = extractInviteCandidate(trimmed);
  if (!extracted.ok) return extracted;
  return parseInviteTokens(extracted.candidate.toUpperCase());
}

/**
 * Safely parse and validate an incoming client WebSocket message string.
 * Returns null if the JSON is malformed or does not match any ClientMessage variant.
 * Guarantees no exceptions escape.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed = ClientMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Safely parse and validate an incoming server WebSocket message string.
 * Returns null if the JSON is malformed or does not match any ServerMessage variant.
 * Guarantees no exceptions escape.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const parsed = ServerMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Validate the JSON payload returned by POST /api/room.
 */
export function parseNewRoomResponse(data: unknown): NewRoomResponse | null {
  const parsed = NewRoomResponseSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
