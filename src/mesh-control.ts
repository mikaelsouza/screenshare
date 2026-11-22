import { z } from "@shared/protocol";

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

  allow(now: number = Date.now()): boolean {
    if (now - this.windowStart >= CONTROL_RATE_LIMIT_WINDOW_MS) {
      this.windowStart = now;
      this.messageCount = 0;
    }
    if (this.messageCount >= CONTROL_RATE_LIMIT_MAX) return false;
    this.messageCount++;
    return true;
  }
}
