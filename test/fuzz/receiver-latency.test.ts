import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { tuneReceiverLatency } from "@src/quality";

describe("Fuzz: Receiver Latency Tuning (Feature 23)", () => {
  it("safely handles arbitrary integer and float latency targets", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false, noDefaultInfinity: false }), (targetMs) => {
        const receiver = {
          jitterBufferTarget: null,
          playoutDelayHint: null,
        } as unknown as RTCRtpReceiver;

        expect(() => tuneReceiverLatency(receiver, targetMs)).not.toThrow();
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it("safely handles corrupt receiver object shapes and prototypes", () => {
    const corruptReceiverArb = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.constant({}),
      fc.constant({ jitterBufferTarget: "string-value" }),
      fc.constant({ playoutDelayHint: {} }),
      fc.record({
        jitterBufferTarget: fc.oneof(fc.string(), fc.boolean(), fc.constant(null)),
        playoutDelayHint: fc.oneof(fc.string(), fc.boolean(), fc.constant(null)),
      })
    );

    fc.assert(
      fc.property(corruptReceiverArb, fc.integer({ min: -1000, max: 10000 }), (corruptReceiver, targetMs) => {
        if (!corruptReceiver || typeof corruptReceiver !== "object") return true;
        expect(() => tuneReceiverLatency(corruptReceiver as unknown as RTCRtpReceiver, targetMs)).not.toThrow();
        return true;
      }),
      { numRuns: 1000 }
    );
  });
});
