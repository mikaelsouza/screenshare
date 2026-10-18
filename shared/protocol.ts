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
export const MAX_SDP_LENGTH = 64 * 1024;

/** Largest ICE candidate line accepted. Real ones are a couple of hundred bytes. */
export const MAX_CANDIDATE_LENGTH = 1024;

/**
 * Peer ids are server-issued crypto.randomUUID() values. Anything else in a `to` field
 * cannot name a peer, so it is rejected at parse time rather than carried further.
 */
export const PEER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
      /** The diagnostics page: a throwaway join that claims nothing and gets short-lived TURN. */
      diagnostics?: boolean;
    }
  | { t: "signal"; to: PeerId; data: SignalData }
  | { t: "state"; sharing: boolean }
  /** Host only: remove a peer from the room. */
  | { t: "kick"; id: PeerId }
  /** Host only: refuse (or allow again) new joins. */
  | { t: "lock"; locked: boolean };

export type ServerMessage =
  // iceServers ride along with the welcome rather than being served from a public
  // endpoint: possession of a joined WebSocket is what authorises TURN credentials.
  | {
      t: "welcome";
      selfId: PeerId;
      peers: PeerInfo[];
      iceServers: IceServerConfig[];
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
export const MAX_HOST_TOKEN_LENGTH = 64;

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

    switch (record.t) {
      case "join": {
        if (typeof record.room === "string" && typeof record.displayName === "string") {
          const joinMsg: ClientMessage = {
            t: "join",
            room: record.room,
            displayName: record.displayName,
          };
          if (typeof record.password === "string") {
            joinMsg.password = record.password;
          }
          if (typeof record.hostToken === "string" && record.hostToken.length <= MAX_HOST_TOKEN_LENGTH) {
            joinMsg.hostToken = record.hostToken;
          }
          if (typeof record.rejoinToken === "string" && record.rejoinToken.length <= MAX_HOST_TOKEN_LENGTH) {
            joinMsg.rejoinToken = record.rejoinToken;
          }
          if (record.resume === true) {
            joinMsg.resume = true;
          }
          if (typeof record.sharing === "boolean") {
            joinMsg.sharing = record.sharing;
          }
          if (record.diagnostics === true) {
            joinMsg.diagnostics = true;
          }
          return joinMsg;
        }
        return null;
      }

      case "signal": {
        if (
          typeof record.to !== "string" ||
          !PEER_ID.test(record.to) ||
          typeof record.data !== "object" ||
          record.data === null ||
          Array.isArray(record.data)
        ) {
          return null;
        }

        const sig = record.data as Record<string, unknown>;

        if (sig.k === "offer" && typeof sig.sdp === "string" && sig.sdp.length <= MAX_SDP_LENGTH) {
          return {
            t: "signal",
            to: record.to,
            data: { k: "offer", sdp: sig.sdp },
          };
        }

        if (sig.k === "answer" && typeof sig.sdp === "string" && sig.sdp.length <= MAX_SDP_LENGTH) {
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
          if (typeof cand.candidate !== "string" || cand.candidate.length > MAX_CANDIDATE_LENGTH) {
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

      case "kick": {
        if (typeof record.id === "string" && PEER_ID.test(record.id)) {
          return { t: "kick", id: record.id };
        }
        return null;
      }

      case "lock": {
        if (typeof record.locked === "boolean") {
          return { t: "lock", locked: record.locked };
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
