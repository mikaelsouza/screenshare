import { type PeerId, z } from "@shared/protocol";
import type { QualityPreset } from "./capture";
import { type CodecName, type DegradationMode, mungeOpusSdp, mungeVideoSdp } from "./quality";

export function mungeSdp(sdp: string): string {
  return mungeVideoSdp(mungeOpusSdp(sdp));
}

export interface MeshOptions {
  iceServers: RTCIceServer[];
  preset: QualityPreset;
  codec: CodecName;
  degradation?: DegradationMode;
  /** Receive-side jitter buffer target, ms. 0 = lowest latency. */
  jitterBufferTargetMs: number;
}

export interface MeshCallbacks {
  onRemoteStream: (peerId: PeerId, stream: MediaStream) => void;
  onRemoteStreamGone: (peerId: PeerId) => void;
  onConnectionState: (peerId: PeerId, state: RTCPeerConnectionState) => void;
}

/** Peer-to-peer control traffic. Deliberately NOT routed through the server. */
export type ControlMessage = { c: "view"; want: boolean };

/** Real control messages are ~25 bytes. Anything far larger is not ours. */
const MAX_CONTROL_MESSAGE_LENGTH = 256;

/** Per-peer inbound DataChannel control budget (view toggles) to drop high-frequency floods. */
const CONTROL_RATE_LIMIT_MAX = 20;
const CONTROL_RATE_LIMIT_WINDOW_MS = 1_000;

const ControlMessageSchema: z.ZodType<ControlMessage> = z.object({
  c: z.literal("view"),
  want: z.boolean(),
});

/**
 * Parse a control message from the far end, or null if it is not one.
 *
 * The far end is another browser in the room, not something we control, so the shape
 * is checked rather than cast: a `want` that is not a boolean would otherwise flow
 * straight into `encodings[0].active`.
 */
export function parseControlMessage(data: unknown): ControlMessage | null {
  if (typeof data !== "string" || data.length > MAX_CONTROL_MESSAGE_LENGTH) return null;
  try {
    const parsed = ControlMessageSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class ControlRateLimiter {
  private windowStart = 0;
  private messageCount = 0;
  private deferredParseCount = 0;
  private deferredMsg: ControlMessage | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  allow(now: number = Date.now()): boolean {
    if (now < this.windowStart || now - this.windowStart >= CONTROL_RATE_LIMIT_WINDOW_MS) {
      this.windowStart = now;
      this.messageCount = 0;
      this.deferredParseCount = 0;
    }
    if (this.messageCount >= CONTROL_RATE_LIMIT_MAX) return false;
    this.messageCount++;
    return true;
  }

  msUntilReset(now: number = Date.now()): number {
    if (now < this.windowStart) return 0;
    return Math.max(0, CONTROL_RATE_LIMIT_WINDOW_MS - (now - this.windowStart));
  }

  /**
   * Process an inbound control payload within the rate limit. Excess valid
   * messages are coalesced (with a bounded parse cap per window) until the
   * window resets, so the final valid state is preserved and never clobbered
   * by subsequent invalid payloads.
   */
  handle(data: unknown, apply: (msg: ControlMessage) => void): void {
    if (this.allow()) {
      const msg = parseControlMessage(data);
      if (msg) {
        this.clearDeferred();
        apply(msg);
      }
      return;
    }
    if (this.deferredParseCount >= CONTROL_RATE_LIMIT_MAX) return;
    this.deferredParseCount++;
    const msg = parseControlMessage(data);
    if (!msg) return;
    this.deferredMsg = msg;
    this.scheduleFlush(apply);
  }

  private scheduleFlush(apply: (msg: ControlMessage) => void): void {
    if (this.timer !== null) return;
    const delay = Math.max(1, this.msUntilReset());
    this.timer = setTimeout(() => {
      this.timer = null;
      const msg = this.deferredMsg;
      if (msg === null) return;
      if (!this.allow()) {
        this.scheduleFlush(apply);
        return;
      }
      this.deferredMsg = null;
      apply(msg);
    }, delay);
  }

  private clearDeferred(): void {
    this.deferredMsg = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  close(): void {
    this.clearDeferred();
  }
}
