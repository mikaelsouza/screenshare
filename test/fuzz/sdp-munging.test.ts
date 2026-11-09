import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { DEFAULT_START_BITRATE_KBPS, mungeOpusSdp, mungeVideoSdp } from "@src/quality";

describe("Fuzzing Suite: Opus & Video SDP Munging (Feature 42)", () => {
  /**
   * Feature 42: Fuzz: Opus & Video SDP Munging
   * Invariant: mungeOpusSdp and mungeVideoSdp never throw, never hang, and maintain idempotence.
   */
  it("never crashes on arbitrary strings, unicode, or binary fragments", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        let opusResult: string | undefined;
        let videoResult: string | undefined;
        expect(() => {
          opusResult = mungeOpusSdp(raw);
          videoResult = mungeVideoSdp(raw);
        }).not.toThrow();
        expect(typeof opusResult).toBe("string");
        expect(typeof videoResult).toBe("string");
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
      "a=rtpmap:45 AV1/90000\r\n",
      "a=fmtp:45 level-idx=5;profile=0;tier=0\r\n",
      "m=video 9 UDP/TLS/RTP/SAVPF 96 45\r\n"
    );

    const syntheticSdpArb = fc
      .array(sdpChunkArb, { minLength: 1, maxLength: 8 })
      .map((chunks) => chunks.join(""));

    fc.assert(
      fc.property(syntheticSdpArb, (sdp) => {
        const mungedOnce = mungeOpusSdp(sdp);
        const mungedTwice = mungeOpusSdp(mungedOnce);

        // Idempotence Invariant (Opus)
        expect(mungedTwice).toBe(mungedOnce);

        // If opus was present, verify stereo & bitrate guarantees
        if (/^a=rtpmap:(\d+) opus\/48000\/2/m.test(sdp)) {
          expect(mungedOnce).toContain("stereo=1");
          expect(mungedOnce).toContain("sprop-stereo=1");
          expect(mungedOnce).toContain("maxaveragebitrate=256000");
          expect(mungedOnce).toContain("usedtx=0");
        }

        const videoOnce = mungeVideoSdp(sdp);
        const videoTwice = mungeVideoSdp(videoOnce);

        // Idempotence Invariant (Video)
        expect(videoTwice).toBe(videoOnce);

        if (/^a=rtpmap:(\d+) (?:VP8|VP9|H264|AV1)\/90000/im.test(sdp)) {
          expect(videoOnce).toContain(`x-google-start-bitrate=${DEFAULT_START_BITRATE_KBPS}`);
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

  it("preserves existing video fmtp attributes when injecting x-google-start-bitrate", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 35, max: 127 }),
        fc.constantFrom("VP8", "VP9", "H264", "AV1"),
        fc.stringMatching(/^[a-z]{3,8}=[a-z0-9]{1,8}$/),
        (pt, codec, customAttr) => {
          const sdp = [
            "v=0",
            `m=video 9 UDP/TLS/RTP/SAVPF ${pt}`,
            `a=rtpmap:${pt} ${codec}/90000`,
            `a=fmtp:${pt} ${customAttr};x-google-start-bitrate=300`,
          ].join("\r\n");

          const result = mungeVideoSdp(sdp);

          expect(result).toContain(customAttr);
          expect(result).toContain(`x-google-start-bitrate=${DEFAULT_START_BITRATE_KBPS}`);
          expect(result).not.toMatch(/x-google-start-bitrate=300\b/);
          return true;
        }
      ),
      { numRuns: 200 }
    );
  });

  it("satisfies idempotence and payload-type bounds [0, 127] for arbitrary startBitrateKbps values", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.constantFrom("VP8", "VP9", "H264", "AV1", "vp8", "h264"),
        fc.integer({ min: 300, max: 50_000 }),
        (pt, codec, startKbps) => {
          const sdp = `v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF ${pt}\r\na=rtpmap:${pt} ${codec}/90000\r\n`;
          const once = mungeVideoSdp(sdp, startKbps);
          const twice = mungeVideoSdp(once, startKbps);

          expect(twice).toBe(once);
          if (pt <= 127) {
            expect(once).toContain(`a=fmtp:${pt} x-google-start-bitrate=${startKbps}`);
          } else {
            expect(once).toBe(sdp);
          }
          return true;
        }
      ),
      { numRuns: 300 }
    );
  });

  it("fuzzes applyVideoEncoding and applyAudioEncoding across arbitrary presets and sender parameter structures", async () => {
    const { applyAudioEncoding, applyVideoEncoding } = await import("@src/quality");

    const presetArb = fc.record({
      label: fc.string({ minLength: 1, maxLength: 20 }),
      width: fc.integer({ min: 320, max: 7680 }),
      height: fc.integer({ min: 240, max: 4320 }),
      frameRate: fc.integer({ min: 1, max: 240 }),
      maxBitrate: fc.integer({ min: 100_000, max: 100_000_000 }),
    });

    const encodingArb = fc.record(
      {
        active: fc.boolean(),
        maxBitrate: fc.integer({ min: 1000, max: 50_000_000 }),
        maxFramerate: fc.integer({ min: 1, max: 120 }),
        scaleResolutionDownBy: fc.double({ min: 1, max: 4, noNaN: true }),
        rid: fc.string({ minLength: 1, maxLength: 4 }),
      },
      { requiredKeys: [] }
    );

    const paramsArb = fc.record(
      {
        encodings: fc.array(encodingArb, { minLength: 0, maxLength: 3 }),
        degradationPreference: fc.constantFrom("balanced", "maintain-framerate", "maintain-resolution"),
      },
      { requiredKeys: [] }
    );

    await fc.assert(
      fc.asyncProperty(presetArb, paramsArb, async (preset, initialParams) => {
        let state = structuredClone(initialParams) as Record<string, unknown>;
        const initialActive = (initialParams.encodings?.[0] as Record<string, unknown> | undefined)?.["active"];
        const initialDegradation = initialParams.degradationPreference;

        const sender = {
          getParameters: () => structuredClone(state),
          setParameters: async (next: Record<string, unknown>) => {
            state = structuredClone(next);
          },
        } as unknown as RTCRtpSender;

        await applyVideoEncoding(sender, preset);
        const firstVideo = structuredClone(state);
        const vEnc = (firstVideo["encodings"] as Array<Record<string, unknown>>)[0]!;

        expect(vEnc["maxBitrate"]).toBe(preset.maxBitrate);
        expect(vEnc["maxFramerate"]).toBe(preset.frameRate);
        expect(vEnc["scaleResolutionDownBy"]).toBe(1);
        expect(vEnc["active"]).toBe(initialActive);
        expect(firstVideo["degradationPreference"]).toBe(initialDegradation);

        // Idempotence
        await applyVideoEncoding(sender, preset);
        expect(state).toEqual(firstVideo);

        // Audio encoding ceiling & activation
        await applyAudioEncoding(sender);
        const aEnc = (state["encodings"] as Array<Record<string, unknown>>)[0]!;
        expect(aEnc["active"]).toBe(true);
        expect(aEnc["maxBitrate"]).toBe(256_000);
        return true;
      }),
      { numRuns: 200 }
    );
  });
});
