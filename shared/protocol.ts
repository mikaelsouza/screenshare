/**
 * Hard room cap.
 *
 * Upload cost is linear in room size and paid by the sharer's uplink: each viewer
 * receives one stream at the selected preset's maxBitrate (8 Mbps at the default
 * 1080p60, 6 Mbps for 1080p30/720p60). An 8-person room therefore needs ~56 Mbps up at
 * the default, and the 20-person cap ~152 Mbps — past ordinary home uplinks. Per-peer
 * bitrate adaptation (BitrateAdapter) and send-side pausing for unwatched tiles are what
 * keep the mesh viable at these sizes. The cap is where the mesh shape still holds;
 * beyond it an SFU is needed.
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
  | "bad-password"
  | "password-ignored"
  | "forbidden-origin"
  | "rate-limited"
  | "join-timeout"
  | "weak-password"
  | "kicked"
  | "room-locked"
  | "not-host"
  | "not-sharing";

/** Longest host token accepted. Real ones are UUIDs, 36 characters. */
const MAX_HOST_TOKEN_LENGTH = 64;

/** Shortest password a new room accepts. Enforced by the server on the claiming join. */
export const MIN_PASSWORD_LENGTH = 8;

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
    for (let i = 0; i < buffer.length; i++) {
      const byte = buffer[i];
      if (byte !== undefined && byte < limit) {
        code += ROOM_CODE_ALPHABET.charAt(byte % alphabetLen);
        if (code.length === ROOM_CODE_LENGTH) {
          return code;
        }
      }
    }
  }

  return code;
}

/**
 * Validate that a string conforms to the room code specification (exact length and valid alphabet).
 */
export function isValidRoomCode(s: string): boolean {
  if (typeof s !== "string" || s.length !== ROOM_CODE_LENGTH) {
    return false;
  }
  for (let i = 0; i < s.length; i++) {
    if (!ROOM_CODE_ALPHABET.includes(s.charAt(i))) {
      return false;
    }
  }
  return true;
}

/**
 * Safely parse and validate an incoming client WebSocket message string.
 * Returns null if the JSON is malformed or does not match any ClientMessage variant.
 * Guarantees no exceptions escape.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }

    const record = data as Record<string, unknown>;

    switch (record["t"]) {
      case "join": {
        const room = record["room"];
        const displayName = record["displayName"];
        if (typeof room === "string" && typeof displayName === "string") {
          const joinMsg: ClientMessage = {
            t: "join",
            room,
            displayName,
          };
          const password = record["password"];
          if (typeof password === "string") {
            joinMsg.password = password;
          }
          const hostToken = record["hostToken"];
          if (typeof hostToken === "string" && hostToken.length <= MAX_HOST_TOKEN_LENGTH) {
            joinMsg.hostToken = hostToken;
          }
          const rejoinToken = record["rejoinToken"];
          if (typeof rejoinToken === "string" && rejoinToken.length <= MAX_HOST_TOKEN_LENGTH) {
            joinMsg.rejoinToken = rejoinToken;
          }
          if (record["resume"] === true) {
            joinMsg.resume = true;
          }
          const sharing = record["sharing"];
          if (typeof sharing === "boolean") {
            joinMsg.sharing = sharing;
          }
          return joinMsg;
        }
        return null;
      }

      case "signal": {
        const to = record["to"];
        const sigData = record["data"];
        if (
          typeof to !== "string" ||
          !PEER_ID.test(to) ||
          typeof sigData !== "object" ||
          sigData === null ||
          Array.isArray(sigData)
        ) {
          return null;
        }

        const sig = sigData as Record<string, unknown>;
        const k = sig["k"];
        const sdp = sig["sdp"];

        if (k === "offer" && typeof sdp === "string" && sdp.length <= MAX_SDP_LENGTH) {
          return {
            t: "signal",
            to,
            data: { k: "offer", sdp },
          };
        }

        if (k === "answer" && typeof sdp === "string" && sdp.length <= MAX_SDP_LENGTH) {
          return {
            t: "signal",
            to,
            data: { k: "answer", sdp },
          };
        }

        const rawCandidate = sig["candidate"];
        if (
          k === "ice" &&
          typeof rawCandidate === "object" &&
          rawCandidate !== null &&
          !Array.isArray(rawCandidate)
        ) {
          const cand = rawCandidate as Record<string, unknown>;
          const candidateStr = cand["candidate"];
          if (typeof candidateStr !== "string" || candidateStr.length > MAX_CANDIDATE_LENGTH) {
            return null;
          }

          const sdpMid = cand["sdpMid"];
          const sdpMLineIndex = cand["sdpMLineIndex"];
          const usernameFragment = cand["usernameFragment"];

          const sdpMidValid = typeof sdpMid === "string" || sdpMid === null || sdpMid === undefined;
          const sdpMLineIndexValid =
            typeof sdpMLineIndex === "number" || sdpMLineIndex === null || sdpMLineIndex === undefined;
          const usernameFragmentValid =
            usernameFragment === undefined ||
            usernameFragment === null ||
            typeof usernameFragment === "string";

          if (!sdpMidValid || !sdpMLineIndexValid || !usernameFragmentValid) {
            return null;
          }

          const iceCandidate: IceCandidateInit = {
            candidate: candidateStr,
            sdpMid: typeof sdpMid === "string" ? sdpMid : null,
            sdpMLineIndex: typeof sdpMLineIndex === "number" ? sdpMLineIndex : null,
          };

          if (typeof usernameFragment === "string") {
            iceCandidate.usernameFragment = usernameFragment;
          } else if (usernameFragment === null) {
            iceCandidate.usernameFragment = null;
          }

          return {
            t: "signal",
            to,
            data: {
              k: "ice",
              candidate: iceCandidate,
            },
          };
        }

        return null;
      }

      case "kick": {
        const id = record["id"];
        if (typeof id === "string" && PEER_ID.test(id)) {
          return { t: "kick", id };
        }
        return null;
      }

      case "lock": {
        const locked = record["locked"];
        if (typeof locked === "boolean") {
          return { t: "lock", locked };
        }
        return null;
      }

      case "state": {
        const sharing = record["sharing"];
        if (typeof sharing === "boolean") {
          return {
            t: "state",
            sharing,
          };
        }
        return null;
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}
