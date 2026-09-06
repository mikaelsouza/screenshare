/**
 * Hard room cap.
 *
 * Mesh upload cost is linear in room size and paid by the sharer's uplink: at 6 Mbps
 * a lone sharer pushes 6 x (N-1) Mbps, so 8 people means ~42 Mbps up. That is past a
 * typical cable uplink, which is why per-peer bitrate adaptation (BitrateAdapter) and
 * send-side pausing for unwatched tiles are load-bearing rather than nice-to-have at
 * this size. Beyond 8 the mesh stops being the right shape and an SFU is needed.
 */
export const MAX_ROOM_SIZE = 8;
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no O/0/I/1/L
export const ROOM_CODE_LENGTH = 8;

export const PING = "ping";
export const PONG = "pong";

/** Serializable subset of RTCIceServer, shared by the worker and the client. */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type PeerId = string;
export interface PeerInfo {
  id: PeerId;
  name: string;
  sharing: boolean;
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
  | { t: "join"; room: string; displayName: string }
  | { t: "signal"; to: PeerId; data: SignalData }
  | { t: "state"; sharing: boolean };

export type ServerMessage =
  // iceServers ride along with the welcome rather than being served from a public
  // endpoint: possession of a joined WebSocket is what authorises TURN credentials.
  | { t: "welcome"; selfId: PeerId; peers: PeerInfo[]; iceServers: IceServerConfig[] }
  | { t: "peer-joined"; peer: PeerInfo }
  | { t: "peer-left"; id: PeerId }
  | { t: "signal"; from: PeerId; data: SignalData }
  | { t: "peer-state"; id: PeerId; sharing: boolean }
  | { t: "error"; code: ErrorCode; message: string };

export type ErrorCode = "room-full" | "bad-message" | "unknown-peer" | "bad-room-code";

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

    switch (record.t) {
      case "join": {
        if (typeof record.room === "string" && typeof record.displayName === "string") {
          return {
            t: "join",
            room: record.room,
            displayName: record.displayName,
          };
        }
        return null;
      }

      case "signal": {
        if (
          typeof record.to !== "string" ||
          typeof record.data !== "object" ||
          record.data === null ||
          Array.isArray(record.data)
        ) {
          return null;
        }

        const sig = record.data as Record<string, unknown>;

        if (sig.k === "offer" && typeof sig.sdp === "string") {
          return {
            t: "signal",
            to: record.to,
            data: { k: "offer", sdp: sig.sdp },
          };
        }

        if (sig.k === "answer" && typeof sig.sdp === "string") {
          return {
            t: "signal",
            to: record.to,
            data: { k: "answer", sdp: sig.sdp },
          };
        }

        if (
          sig.k === "ice" &&
          typeof sig.candidate === "object" &&
          sig.candidate !== null &&
          !Array.isArray(sig.candidate)
        ) {
          const cand = sig.candidate as Record<string, unknown>;
          if (typeof cand.candidate !== "string") {
            return null;
          }

          const sdpMidValid = typeof cand.sdpMid === "string" || cand.sdpMid === null || cand.sdpMid === undefined;
          const sdpMLineIndexValid =
            typeof cand.sdpMLineIndex === "number" || cand.sdpMLineIndex === null || cand.sdpMLineIndex === undefined;
          const usernameFragmentValid =
            cand.usernameFragment === undefined ||
            cand.usernameFragment === null ||
            typeof cand.usernameFragment === "string";

          if (!sdpMidValid || !sdpMLineIndexValid || !usernameFragmentValid) {
            return null;
          }

          const iceCandidate: IceCandidateInit = {
            candidate: cand.candidate,
            sdpMid: typeof cand.sdpMid === "string" ? cand.sdpMid : null,
            sdpMLineIndex: typeof cand.sdpMLineIndex === "number" ? cand.sdpMLineIndex : null,
          };

          if (typeof cand.usernameFragment === "string") {
            iceCandidate.usernameFragment = cand.usernameFragment;
          } else if (cand.usernameFragment === null) {
            iceCandidate.usernameFragment = null;
          }

          return {
            t: "signal",
            to: record.to,
            data: {
              k: "ice",
              candidate: iceCandidate,
            },
          };
        }

        return null;
      }

      case "state": {
        if (typeof record.sharing === "boolean") {
          return {
            t: "state",
            sharing: record.sharing,
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
