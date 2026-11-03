import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { mungeOpusSdp } from "@src/quality";

describe("Fuzzing Suite: Opus SDP Munging (Feature 42)", () => {
  /**
   * Feature 42: Fuzz: Opus SDP Munging
   * Invariant: mungeOpusSdp never throws, never hangs, and maintains idempotence.
   */
  it("never crashes on arbitrary strings, unicode, or binary fragments", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        let result: string | undefined;
        expect(() => {
          result = mungeOpusSdp(raw);
        }).not.toThrow();
        expect(typeof result).toBe("string");
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it("satisfies idempotence: munging an already munged SDP produces identical output", () => {
    const sdpChunkArb = fc.constantFrom(
      "v=0\r\no=- 12345 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\n",
      "a=rtpmap:111 opus/48000/2\r\n",
      "a=fmtp:111 minptime=10;useinbandfec=1\r\n",
      "a=fmtp:111 stereo=0;sprop-stereo=0\r\n",
      "a=rtpmap:96 VP8/90000\r\n",
      "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
    );

    const syntheticSdpArb = fc
      .array(sdpChunkArb, { minLength: 1, maxLength: 8 })
      .map((chunks) => chunks.join(""));

    fc.assert(
      fc.property(syntheticSdpArb, (sdp) => {
        const mungedOnce = mungeOpusSdp(sdp);
        const mungedTwice = mungeOpusSdp(mungedOnce);

        // Idempotence Invariant
        expect(mungedTwice).toBe(mungedOnce);

        // If opus was present, verify stereo & bitrate guarantees
        if (/^a=rtpmap:(\d+) opus\/48000\/2/m.test(sdp)) {
          expect(mungedOnce).toContain("stereo=1");
          expect(mungedOnce).toContain("sprop-stereo=1");
          expect(mungedOnce).toContain("maxaveragebitrate=256000");
          expect(mungedOnce).toContain("usedtx=0");
        }
        return true;
      }),
      { numRuns: 500 }
    );
  });

  it("preserves non-opus attributes when modifying existing fmtp lines", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 96, max: 127 }), // payload type
        fc.stringMatching(/^[a-z]{3,8}=[a-z0-9]{1,8}$/), // custom attribute to keep
        (pt, customAttr) => {
          const sdp = [
            "v=0",
            `m=audio 9 UDP/TLS/RTP/SAVPF ${pt}`,
            `a=rtpmap:${pt} opus/48000/2`,
            `a=fmtp:${pt} ${customAttr};stereo=0`,
          ].join("\r\n");

          const result = mungeOpusSdp(sdp);

          // Must retain the custom attribute
          expect(result).toContain(customAttr);
          // Must force stereo=1
          expect(result).toContain("stereo=1");
          expect(result).not.toMatch(/stereo=0/);
          return true;
        }
      ),
      { numRuns: 200 }
    );
  });
});
