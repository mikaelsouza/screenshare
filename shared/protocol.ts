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

/**
 * Peer ids are server-issued crypto.randomUUID() values. Anything else in a `to` field
 * cannot name a peer, so it is rejected at parse time rather than carried further.
 */
const PEER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ROOM_CODE_REGEX = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

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

export type ClientMessage =
  | {
      t: "join";
      room: string;
      displayName: string;
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
  | { t: "lock"; locked: boolean };

export type ServerMessage =
  | {
      t: "welcome";
      selfId: PeerId;
      peers: PeerInfo[];
      /** Whether this socket is the room's host. */
      host: boolean;
      /** Issued once, to the join that creates the room. Keep it to stay host on reconnect. */
      hostToken?: string;
      /** Present it on the next join to get back in even if the room is locked. */
      rejoinToken?: string;
      locked: boolean;
    }
  | { t: "peer-joined"; peer: PeerInfo }
  | { t: "peer-left"; id: PeerId }
  | { t: "signal"; from: PeerId; data: SignalData }
  | { t: "peer-state"; id: PeerId; sharing: boolean }
  | { t: "room-state"; locked: boolean }
  | { t: "error"; code: ErrorCode; message: string };

export type ErrorCode =
  | "room-full"
  | "bad-message"
  | "unknown-peer"
  | "bad-room-code"
  | "forbidden-origin"
  | "rate-limited"
  | "join-timeout"
  | "kicked"
  | "room-locked"
  | "not-host"
  | "not-sharing";

/** Longest host token accepted. Real ones are UUIDs, 36 characters. */
const MAX_HOST_TOKEN_LENGTH = 64;

const RoomCodeSchema: z.ZodType<string> = z.string().regex(ROOM_CODE_REGEX);

const PeerUuidSchema: z.ZodType<PeerId> = z.string().regex(PEER_ID);

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
    displayName: z.string(),
    hostToken: z.string().max(MAX_HOST_TOKEN_LENGTH).optional().catch(undefined),
    rejoinToken: z.string().max(MAX_HOST_TOKEN_LENGTH).optional().catch(undefined),
    resume: z.literal(true).optional().catch(undefined),
    sharing: z.boolean().optional().catch(undefined),
  })
  .transform(({ t, room, displayName, hostToken, rejoinToken, resume, sharing }) => ({
    t,
    room,
    displayName,
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
]);

const PeerInfoSchema: z.ZodType<PeerInfo> = z
  .object({
    id: z.string().min(1),
    name: z.string(),
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
  "forbidden-origin",
  "rate-limited",
  "join-timeout",
  "kicked",
  "room-locked",
  "not-host",
  "not-sharing",
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
    hostToken: z.string().max(MAX_HOST_TOKEN_LENGTH).optional(),
    rejoinToken: z.string().max(MAX_HOST_TOKEN_LENGTH).optional(),
    locked: z.boolean().optional().default(false),
  })
  .transform(({ t, selfId, peers, host, hostToken, rejoinToken, locked }) => ({
    t,
    selfId,
    peers,
    host,
    ...(hostToken !== undefined ? { hostToken } : {}),
    ...(rejoinToken !== undefined ? { rejoinToken } : {}),
    locked,
  }));

// Server-originated peer IDs (`id`, `from`) intentionally accept any non-empty string
// to preserve backward compatibility with existing signaling tests.
const ServerMessageSchema: z.ZodType<ServerMessage> = z.discriminatedUnion("t", [
  WelcomeServerMessageSchema,
  z.object({
    t: z.literal("peer-joined"),
    peer: PeerInfoSchema,
  }),
  z.object({
    t: z.literal("peer-left"),
    id: z.string().min(1),
  }),
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
  z.object({
    t: z.literal("room-state"),
    locked: z.boolean(),
  }),
  z.object({
    t: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string(),
  }),
]);

const NewRoomResponseSchema: z.ZodType<{ code: string }> = z.object({
  code: RoomCodeSchema,
});

/**
 * Generate an 8-character room code using rejection sampling to eliminate modulo bias.
 * Works in both Cloudflare Workers and modern browsers.
 */
export function generateRoomCode(): string {
  const alphabetLen = ROOM_CODE_ALPHABET.length;
  // Largest multiple of alphabetLen <= 256 (31 * 8 = 248)
  const limit = Math.floor(256 / alphabetLen) * alphabetLen;
  const buffer = new Uint8Array(ROOM_CODE_LENGTH * 2);
  let code = "";

  while (code.length < ROOM_CODE_LENGTH) {
    crypto.getRandomValues(buffer);
    for (let i = 0; i < buffer.length && code.length < ROOM_CODE_LENGTH; i++) {
      const byte = buffer[i];
      if (byte !== undefined && byte < limit) {
        code += ROOM_CODE_ALPHABET.charAt(byte % alphabetLen);
      }
    }
  }

  return code;
}

/**
 * Validate that a value conforms to the room code specification (exact length and valid alphabet).
 */
export function isValidRoomCode(s: unknown): s is string {
  return RoomCodeSchema.safeParse(s).success;
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
 * Validate the JSON payload returned by POST /api/new-room.
 */
export function parseNewRoomResponse(data: unknown): { code: string } | null {
  const parsed = NewRoomResponseSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
