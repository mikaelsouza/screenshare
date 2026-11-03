import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { tuneReceiverLatency } from "@src/quality";

describe("Formal Invariants: Latency & Degradation Tuning (Feature 23)", () => {
  /**
   * Feature 23: Latency & Degradation Tuning
   * Proves invariants around tuneReceiverLatency:
   * 1. Monotonic alignment: playoutDelayHint (in seconds) === targetMs / 1000 for any non-negative targetMs.
   * 2. Non-negative target guarantees targetMs >= 0.
   * 3. TargetMs assignment preserves exact millisecond values on standard jitterBufferTarget.
   */
  it("proves playoutDelayHint maintains exact seconds equivalence (targetMs / 1000)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10000 }), (targetMs) => {
        const receiver = {
          jitterBufferTarget: null,
          playoutDelayHint: null,
        } as unknown as RTCRtpReceiver;

        tuneReceiverLatency(receiver, targetMs);

        const r = receiver as unknown as { jitterBufferTarget: number; playoutDelayHint: number };
        expect(r.jitterBufferTarget).toBe(targetMs);
        expect(r.playoutDelayHint).toBeCloseTo(targetMs / 1000, 5);
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it("proves 150ms buffer target invariant matches ~9 frames at 60fps (~16.6ms per frame)", () => {
    const targetMs = 150;
    const frameDuration60fps = 1000 / 60; // 16.666... ms
    const framesBuffered = targetMs / frameDuration60fps;

    expect(framesBuffered).toBe(9);
    expect(targetMs / 1000).toBe(0.15);

    const receiver = {
      jitterBufferTarget: 0,
      playoutDelayHint: 0,
    } as unknown as RTCRtpReceiver;

    tuneReceiverLatency(receiver, targetMs);
    const r = receiver as unknown as { jitterBufferTarget: number; playoutDelayHint: number };
    expect(r.jitterBufferTarget).toBe(150);
    expect(r.playoutDelayHint).toBe(0.15);
  });

  it("proves fault tolerance: throwing receiver properties never uncaught exceptions", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.boolean(),
        fc.boolean(),
        (targetMs, throwJitter, throwPlayout) => {
          const receiver = {} as unknown as RTCRtpReceiver;
          Object.defineProperty(receiver, "jitterBufferTarget", {
            get: () => 0,
            set: () => {
              if (throwJitter) throw new Error("read only jitterBufferTarget");
            },
          });
          Object.defineProperty(receiver, "playoutDelayHint", {
            get: () => 0,
            set: () => {
              if (throwPlayout) throw new Error("read only playoutDelayHint");
            },
          });

          expect(() => tuneReceiverLatency(receiver, targetMs)).not.toThrow();
          return true;
        }
      ),
      { numRuns: 500 }
    );
  });
});
