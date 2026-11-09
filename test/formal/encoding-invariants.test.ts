import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRESET,
  QUALITY_PRESETS,
  captureScreen,
  type QualityPresetName,
} from "@src/capture";
import {
  DEFAULT_START_BITRATE_KBPS,
  applyAudioEncoding,
  applyVideoEncoding,
} from "@src/quality";

describe("Formal Mathematical Proofs: Video Encoding & Quality Invariants", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("proves partial-order monotonicity and bitrate bounds across all QUALITY_PRESETS", () => {
    const entries = Object.entries(QUALITY_PRESETS) as Array<[QualityPresetName, (typeof QUALITY_PRESETS)[QualityPresetName]]>;
    expect(entries.length).toBeGreaterThanOrEqual(4);
    expect(QUALITY_PRESETS[DEFAULT_PRESET]).toBeDefined();

    const startBitrateBps = DEFAULT_START_BITRATE_KBPS * 1000;
    // Start bitrate must strictly exceed WebRTC's 300 kbps fallback floor
    expect(startBitrateBps).toBeGreaterThan(300_000);

    for (const [, p] of entries) {
      // Positivity & integrality of dimensions, framerate, and bitrate
      expect(Number.isInteger(p.width) && p.width > 0).toBe(true);
      expect(Number.isInteger(p.height) && p.height > 0).toBe(true);
      expect(Number.isInteger(p.frameRate) && p.frameRate > 0).toBe(true);
      expect(Number.isInteger(p.maxBitrate) && p.maxBitrate > 0).toBe(true);

      // Start bitrate must never exceed any preset's maxBitrate ceiling
      expect(startBitrateBps).toBeLessThanOrEqual(p.maxBitrate);
    }

    // Product partial-order monotonicity:
    // If preset A dominates preset B in both pixel count (width * height) and frameRate,
    // then A.maxBitrate >= B.maxBitrate.
    for (const [, a] of entries) {
      for (const [, b] of entries) {
        const pixelsA = a.width * a.height;
        const pixelsB = b.width * b.height;
        if (pixelsA >= pixelsB && a.frameRate >= b.frameRate) {
          expect(a.maxBitrate).toBeGreaterThanOrEqual(b.maxBitrate);
        }
        // Strict increase in framerate at identical resolution strictly increases bitrate ceiling
        if (pixelsA === pixelsB && a.frameRate > b.frameRate) {
          expect(a.maxBitrate).toBeGreaterThan(b.maxBitrate);
        }
      }
    }
  });

  it("exhaustively proves applyVideoEncoding ceiling projection, send-side pause invariance, Chrome default delegation, and idempotence", async () => {
    const presets = Object.values(QUALITY_PRESETS);
    const activeStates: Array<boolean | undefined> = [undefined, false, true];
    const degradationStates: Array<"balanced" | "maintain-resolution" | "maintain-framerate" | undefined> = [
      undefined,
      "balanced",
      "maintain-resolution",
      "maintain-framerate",
    ];
    const shapes = ["populated", "empty", "missing"] as const;

    for (const preset of presets) {
      for (const initialActive of activeStates) {
        for (const existingDegradation of degradationStates) {
          for (const shape of shapes) {
            let state: Record<string, unknown> = {};
            if (existingDegradation !== undefined) {
              state["degradationPreference"] = existingDegradation;
            }
            if (shape === "populated") {
              state["encodings"] = [
                initialActive === undefined ? { rid: "f" } : { active: initialActive, rid: "f" },
              ];
            } else if (shape === "empty") {
              state["encodings"] = [];
            }

            const sender = {
              getParameters: () => structuredClone(state),
              setParameters: async (next: Record<string, unknown>) => {
                state = structuredClone(next);
              },
            } as unknown as RTCRtpSender;

            await applyVideoEncoding(sender, preset);
            const afterFirst = structuredClone(state);
            const enc = (afterFirst["encodings"] as Array<Record<string, unknown>>)[0]!;

            // Invariant 1: Exact preset ceiling projection
            expect(enc["maxBitrate"]).toBe(preset.maxBitrate);
            expect(enc["maxFramerate"]).toBe(preset.frameRate);
            expect(enc["scaleResolutionDownBy"]).toBe(1);

            // Invariant 2: Send-side pause state (`active`) is never mutated by applyVideoEncoding
            const expectedActive = shape === "populated" ? initialActive : undefined;
            expect(enc["active"]).toBe(expectedActive);

            // Invariant 3: Chrome's default degradationPreference is never overridden
            expect(afterFirst["degradationPreference"]).toBe(existingDegradation);

            // Invariant 4: Idempotence — f(f(x, p), p) === f(x, p)
            await applyVideoEncoding(sender, preset);
            expect(state).toEqual(afterFirst);
          }
        }
      }
    }
  });

  it("exhaustively proves applyAudioEncoding idempotence and 256 kbps ceiling across all initial sender states", async () => {
    const activeStates: Array<boolean | undefined> = [undefined, false, true];
    const shapes = ["populated", "empty", "missing"] as const;

    for (const initialActive of activeStates) {
      for (const shape of shapes) {
        let state: Record<string, unknown> = {};
        if (shape === "populated") {
          state["encodings"] = [initialActive === undefined ? {} : { active: initialActive }];
        } else if (shape === "empty") {
          state["encodings"] = [];
        }

        const sender = {
          getParameters: () => structuredClone(state),
          setParameters: async (next: Record<string, unknown>) => {
            state = structuredClone(next);
          },
        } as unknown as RTCRtpSender;

        await applyAudioEncoding(sender);
        const afterFirst = structuredClone(state);
        const enc = (afterFirst["encodings"] as Array<Record<string, unknown>>)[0]!;

        expect(enc["active"]).toBe(true);
        expect(enc["maxBitrate"]).toBe(256_000);

        await applyAudioEncoding(sender);
        expect(state).toEqual(afterFirst);
      }
    }
  });

  it("exhaustively proves captureScreen preserves Chrome default video contentHint ('') and sets audio contentHint ('music') across all presets and surfaces", async () => {
    const presets = Object.values(QUALITY_PRESETS);
    const hasAudioStates = [false, true];
    const surfaces = ["monitor", "window", "browser", "other", undefined] as const;

    for (const preset of presets) {
      for (const hasAudio of hasAudioStates) {
        for (const displaySurface of surfaces) {
          const videoTrack = {
            kind: "video",
            contentHint: "",
            getSettings: () => (displaySurface ? { displaySurface } : {}),
            stop: vi.fn(),
          } as unknown as MediaStreamTrack;
          const audioTrack = hasAudio
            ? ({ kind: "audio", contentHint: "", stop: vi.fn() } as unknown as MediaStreamTrack)
            : null;
          const stream = {
            getVideoTracks: () => [videoTrack],
            getAudioTracks: () => (audioTrack ? [audioTrack] : []),
            getTracks: () => (audioTrack ? [videoTrack, audioTrack] : [videoTrack]),
          } as unknown as MediaStream;

          vi.stubGlobal("navigator", {
            mediaDevices: {
              getDisplayMedia: vi.fn().mockResolvedValue(stream),
            },
          });

          const res = await captureScreen(preset);

          // Invariant 1: video.contentHint stays "" so Chromium treats the capture as a native screenshare
          expect(res.video.contentHint).toBe("");

          // Invariant 2: audio.contentHint is "music" iff an audio track was captured
          if (hasAudio) {
            expect(res.audio?.contentHint).toBe("music");
          } else {
            expect(res.audio).toBeNull();
          }
        }
      }
    }
  });
});
