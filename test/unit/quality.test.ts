import { describe, expect, it } from "vitest";
import {
  applyVideoEncoding,
  DEFAULT_START_BITRATE_KBPS,
  mungeOpusSdp,
  mungeVideoSdp,
} from "@src/quality";

/** Minimal but realistic audio m-line, matching what Chrome actually emits. */
function sdpWith(fmtp: string | null, pt = "111"): string {
  const lines = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "m=audio 9 UDP/TLS/RTP/SAVPF " + pt,
    `a=rtpmap:${pt} opus/48000/2`,
  ];
  if (fmtp !== null) lines.push(`a=fmtp:${pt} ${fmtp}`);
  lines.push("a=rtcp-fb:" + pt + " transport-cc");
  return lines.join("\r\n") + "\r\n";
}

function fmtpOf(sdp: string, pt = "111"): string | null {
  return new RegExp(`^a=fmtp:${pt} (.*)$`, "m").exec(sdp)?.[1] ?? null;
}

describe("mungeOpusSdp", () => {
  it("inserts an fmtp line when none exists", () => {
    const out = mungeOpusSdp(sdpWith(null));
    const fmtp = fmtpOf(out);
    expect(fmtp).toContain("stereo=1");
    expect(fmtp).toContain("sprop-stereo=1");
    expect(fmtp).toContain("maxaveragebitrate=256000");
    expect(fmtp).toContain("usedtx=0");
  });

  it("keeps the inserted line attached to the opus rtpmap", () => {
    const out = mungeOpusSdp(sdpWith(null));
    expect(out).toMatch(/a=rtpmap:111 opus\/48000\/2\r\na=fmtp:111 /);
  });

  it("overrides conflicting values the browser chose", () => {
    // Chrome defaults to mono with DTX on, which gates out quiet game audio.
    const out = mungeOpusSdp(sdpWith("minptime=10;stereo=0;usedtx=1;maxaveragebitrate=32000"));
    const fmtp = fmtpOf(out) ?? "";
    expect(fmtp).toContain("stereo=1");
    expect(fmtp).toContain("usedtx=0");
    expect(fmtp).toContain("maxaveragebitrate=256000");
    expect(fmtp).not.toContain("stereo=0");
    expect(fmtp).not.toContain("usedtx=1");
    expect(fmtp).not.toContain("maxaveragebitrate=32000");
  });

  it("preserves unrelated fmtp parameters", () => {
    const out = mungeOpusSdp(sdpWith("minptime=10;useinbandfec=1"));
    const fmtp = fmtpOf(out) ?? "";
    expect(fmtp).toContain("minptime=10");
    expect(fmtp).toContain("useinbandfec=1");
  });

  it("does not confuse sprop-stereo with stereo when stripping", () => {
    const out = mungeOpusSdp(sdpWith("stereo=0;sprop-stereo=0"));
    const fmtp = fmtpOf(out) ?? "";
    expect(fmtp.split(";").filter((p) => p.startsWith("stereo="))).toEqual(["stereo=1"]);
    expect(fmtp.split(";").filter((p) => p.startsWith("sprop-stereo="))).toEqual(["sprop-stereo=1"]);
  });

  it("honours a non-default payload type", () => {
    const out = mungeOpusSdp(sdpWith(null, "96"));
    expect(fmtpOf(out, "96")).toContain("stereo=1");
  });

  it("leaves SDP without an opus track untouched", () => {
    const videoOnly = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n";
    expect(mungeOpusSdp(videoOnly)).toBe(videoOnly);
  });

  it("is idempotent", () => {
    const once = mungeOpusSdp(sdpWith("minptime=10"));
    expect(mungeOpusSdp(once)).toBe(once);
  });
});

describe("mungeVideoSdp", () => {
  const multiCodecVideoSdp = [
    "v=0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 102 45 46",
    "a=rtpmap:96 VP8/90000",
    "a=rtpmap:97 rtx/90000",
    "a=fmtp:97 apt=96",
    "a=rtpmap:98 VP9/90000",
    "a=fmtp:98 profile-id=0",
    "a=rtpmap:102 H264/90000",
    "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    "a=rtpmap:45 AV1/90000",
    "a=fmtp:45 level-idx=5;profile=0;tier=0",
    "a=rtpmap:46 red/90000",
    "",
  ].join("\r\n");

  it("inserts x-google-start-bitrate on video codecs without an existing fmtp line", () => {
    const out = mungeVideoSdp(multiCodecVideoSdp);
    expect(fmtpOf(out, "96")).toBe(`x-google-start-bitrate=${DEFAULT_START_BITRATE_KBPS}`);
    expect(out).toMatch(
      new RegExp(`a=rtpmap:96 VP8\\/90000\\r\\na=fmtp:96 x-google-start-bitrate=${DEFAULT_START_BITRATE_KBPS}`),
    );
  });

  it("appends x-google-start-bitrate to existing VP9, H264, and AV1 fmtp lines while preserving parameters", () => {
    const out = mungeVideoSdp(multiCodecVideoSdp);
    expect(fmtpOf(out, "98")).toBe(`profile-id=0;x-google-start-bitrate=${DEFAULT_START_BITRATE_KBPS}`);
    expect(fmtpOf(out, "102")).toBe(
      `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=${DEFAULT_START_BITRATE_KBPS}`,
    );
    expect(fmtpOf(out, "45")).toBe(
      `level-idx=5;profile=0;tier=0;x-google-start-bitrate=${DEFAULT_START_BITRATE_KBPS}`,
    );
  });

  it("does not munge auxiliary payload types (rtx, red, ulpfec) or audio tracks", () => {
    const out = mungeVideoSdp(multiCodecVideoSdp);
    expect(fmtpOf(out, "97")).toBe("apt=96");
    expect(fmtpOf(out, "46")).toBeNull();
    const audioOnly = sdpWith("minptime=10");
    expect(mungeVideoSdp(audioOnly)).toBe(audioOnly);
  });

  it("does not inject x-google-min-bitrate so congestion control can still adapt downward", () => {
    const out = mungeVideoSdp(multiCodecVideoSdp);
    expect(out).not.toContain("x-google-min-bitrate");
  });

  it("overrides an existing x-google-start-bitrate value and is idempotent", () => {
    const withOldStart = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 45",
      "a=rtpmap:45 AV1/90000",
      "a=fmtp:45 level-idx=5;x-google-start-bitrate=300;profile=0",
      "",
    ].join("\r\n");
    const once = mungeVideoSdp(withOldStart, 5000);
    expect(fmtpOf(once, "45")).toBe("level-idx=5;profile=0;x-google-start-bitrate=5000");
    expect(mungeVideoSdp(once, 5000)).toBe(once);
  });
});

/** Minimal RTCRtpSender double that records what setParameters received. */
function fakeSender(initial: Record<string, unknown>) {
  let params: Record<string, unknown> = { encodings: [{ ...initial }] };
  return {
    sender: {
      getParameters: () => structuredClone(params),
      setParameters: async (p: Record<string, unknown>) => { params = structuredClone(p); },
    } as unknown as RTCRtpSender,
    current: (): Record<string, unknown> => {
      const encodings = params["encodings"] as Array<Record<string, unknown>>;
      const first = encodings[0];
      if (!first) throw new Error("sender has no encodings");
      return first;
    },
  };
}

const PRESET = { label: "720p 60fps", width: 1280, height: 720, frameRate: 60, maxBitrate: 6_000_000 };

describe("applyVideoEncoding", () => {
  it("applies the preset's bitrate and framerate", async () => {
    const f = fakeSender({ active: true });
    await applyVideoEncoding(f.sender, PRESET);
    expect(f.current()["maxBitrate"]).toBe(6_000_000);
    expect(f.current()["maxFramerate"]).toBe(60);
  });

  it("honours a bitrate override from the adapter", async () => {
    const f = fakeSender({ active: true });
    await applyVideoEncoding(f.sender, PRESET, 2_000_000);
    expect(f.current()["maxBitrate"]).toBe(2_000_000);
  });

  // Regression: this used to set `active = true` unconditionally, so a BitrateAdapter
  // tick silently resumed a sender that send-side pausing had switched off — quietly
  // uploading video nobody was watching and defeating the main bandwidth lever.
  it("does not resurrect a sender that send-side pausing disabled", async () => {
    const f = fakeSender({ active: false });
    await applyVideoEncoding(f.sender, PRESET, 3_000_000);
    expect(f.current()["active"]).toBe(false);
    expect(f.current()["maxBitrate"]).toBe(3_000_000);
  });

  it("leaves an active sender active", async () => {
    const f = fakeSender({ active: true });
    await applyVideoEncoding(f.sender, PRESET);
    expect(f.current()["active"]).toBe(true);
  });

  it("handles an empty encodings array gracefully", async () => {
    let params: Record<string, unknown> = { encodings: [] };
    const sender = {
      getParameters: () => structuredClone(params),
      setParameters: async (p: Record<string, unknown>) => { params = structuredClone(p); },
    } as unknown as RTCRtpSender;

    await applyVideoEncoding(sender, PRESET);
    expect((params["encodings"] as Array<Record<string, unknown>>)[0]?.["maxBitrate"]).toBe(6_000_000);
  });
});

describe("applyAudioEncoding", () => {
  it("enables audio and sets high-fidelity bitrate ceiling", async () => {
    const f = fakeSender({ active: false });
    await (await import("@src/quality")).applyAudioEncoding(f.sender);
    expect(f.current()["active"]).toBe(true);
    expect(f.current()["maxBitrate"]).toBe(256_000);
  });

  it("handles empty encodings array on audio sender", async () => {
    let params: Record<string, unknown> = { encodings: [] };
    const sender = {
      getParameters: () => structuredClone(params),
      setParameters: async (p: Record<string, unknown>) => { params = structuredClone(p); },
    } as unknown as RTCRtpSender;

    await (await import("@src/quality")).applyAudioEncoding(sender);
    expect((params["encodings"] as Array<Record<string, unknown>>)[0]?.["active"]).toBe(true);
  });
});

describe("preferCodec", () => {
  it("does nothing if setCodecPreferences is not supported", async () => {
    const { preferCodec } = await import("@src/quality");
    expect(() => preferCodec({} as unknown as RTCRtpTransceiver, "h264")).not.toThrow();
  });

  it("does nothing if getCapabilities returns null or no codecs", async () => {
    const { preferCodec } = await import("@src/quality");
    const orig = (globalThis as unknown as { RTCRtpSender: { getCapabilities: unknown } }).RTCRtpSender;
    (globalThis as unknown as { RTCRtpSender: { getCapabilities: unknown } }).RTCRtpSender = {
      getCapabilities: () => null,
    };
    const tx = { setCodecPreferences: () => {} } as unknown as RTCRtpTransceiver;
    expect(() => preferCodec(tx, "h264")).not.toThrow();
    (globalThis as unknown as { RTCRtpSender: { getCapabilities: unknown } }).RTCRtpSender = orig;
  });

  it("reorders codecs with the preferred codec first", async () => {
    const { preferCodec } = await import("@src/quality");
    const codecs = [
      { mimeType: "video/VP8" },
      { mimeType: "video/H264" },
      { mimeType: "video/AV1" },
    ];
    (globalThis as unknown as { RTCRtpSender: { getCapabilities: unknown } }).RTCRtpSender = {
      getCapabilities: () => ({ codecs }),
    };

    let setPreferencesArg: Array<{ mimeType: string }> = [];
    const tx = {
      setCodecPreferences: (c: Array<{ mimeType: string }>) => {
        setPreferencesArg = c;
      },
    } as unknown as RTCRtpTransceiver;

    preferCodec(tx, "h264");
    expect(setPreferencesArg[0]?.mimeType).toBe("video/H264");
    expect(setPreferencesArg.map((c) => c.mimeType)).toEqual([
      "video/H264",
      "video/VP8",
      "video/AV1",
    ]);
  });

  it("handles when preferred codec is not offered by browser", async () => {
    const { preferCodec } = await import("@src/quality");
    const codecs = [{ mimeType: "video/VP8" }];
    (globalThis as unknown as { RTCRtpSender: { getCapabilities: unknown } }).RTCRtpSender = {
      getCapabilities: () => ({ codecs }),
    };

    let called = false;
    const tx = {
      setCodecPreferences: () => { called = true; },
    } as unknown as RTCRtpTransceiver;

    preferCodec(tx, "av1");
    expect(called).toBe(false);
  });

  it("swallows errors thrown by setCodecPreferences", async () => {
    const { preferCodec } = await import("@src/quality");
    const codecs = [{ mimeType: "video/H264" }];
    (globalThis as unknown as { RTCRtpSender: { getCapabilities: unknown } }).RTCRtpSender = {
      getCapabilities: () => ({ codecs }),
    };

    const tx = {
      setCodecPreferences: () => { throw new Error("unsupported codec order"); },
    } as unknown as RTCRtpTransceiver;

    expect(() => preferCodec(tx, "h264")).not.toThrow();
  });
});

describe("tuneReceiverLatency", () => {
  it("sets jitterBufferTarget in milliseconds", async () => {
    const { tuneReceiverLatency } = await import("@src/quality");
    const receiver = { jitterBufferTarget: 100 } as unknown as RTCRtpReceiver;
    tuneReceiverLatency(receiver, 20);
    expect((receiver as unknown as { jitterBufferTarget: number }).jitterBufferTarget).toBe(20);
  });

  it("sets playoutDelayHint in seconds", async () => {
    const { tuneReceiverLatency } = await import("@src/quality");
    const receiver = { playoutDelayHint: 1 } as unknown as RTCRtpReceiver;
    tuneReceiverLatency(receiver, 50);
    expect((receiver as unknown as { playoutDelayHint: number }).playoutDelayHint).toBe(0.05);
  });

  it("swallows errors if properties throw", async () => {
    const { tuneReceiverLatency } = await import("@src/quality");
    const receiver = {} as unknown as RTCRtpReceiver;
    Object.defineProperty(receiver, "jitterBufferTarget", {
      get: () => 0,
      set: () => { throw new Error("read only"); },
    });
    expect(() => tuneReceiverLatency(receiver, 10)).not.toThrow();
  });
});

describe("BitrateAdapter", () => {
  function makeSender(getStatsReport: () => RTCStatsReport) {
    let params: Record<string, unknown> = { encodings: [{ active: true, maxBitrate: PRESET.maxBitrate }] };
    return {
      getParameters: () => structuredClone(params),
      setParameters: async (p: Record<string, unknown>) => { params = structuredClone(p); },
      getStats: async () => getStatsReport(),
    } as unknown as RTCRtpSender;
  }

  it("backs off on sustained packet loss and climbs back on sustained good reception", async () => {
    const { BitrateAdapter } = await import("@src/quality");

    let packetsSent = 1000;
    let packetsLost = 0;
    const sender = makeSender(() => {
      const map = new Map<string, unknown>();
      map.set("outbound", { type: "outbound-rtp", kind: "video", packetsSent });
      map.set("remote-inbound", { type: "remote-inbound-rtp", kind: "video", packetsLost });
      return map as unknown as RTCStatsReport;
    });

    const adapter = new BitrateAdapter(sender, PRESET, 1_000_000);
    expect(adapter.bitrate).toBe(PRESET.maxBitrate);

    // First sample establishes baseline
    await (adapter as unknown as { tick: () => Promise<void> }).tick();
    expect(adapter.bitrate).toBe(PRESET.maxBitrate);

    // One bad sample (10% loss > 3% threshold): consecutiveBad = 1, should not drop yet
    packetsSent += 100;
    packetsLost += 10;
    await (adapter as unknown as { tick: () => Promise<void> }).tick();
    expect(adapter.bitrate).toBe(PRESET.maxBitrate);

    // Second bad sample (10% loss): consecutiveBad = 2 -> drops by 25% (0.75x)
    packetsSent += 100;
    packetsLost += 10;
    await (adapter as unknown as { tick: () => Promise<void> }).tick();
    const droppedBitrate = Math.round(PRESET.maxBitrate * 0.75);
    expect(adapter.bitrate).toBe(droppedBitrate);

    // Now 5 good samples with 0 loss: climbs back by 1.15x
    for (let i = 0; i < 4; i++) {
      packetsSent += 100;
      await (adapter as unknown as { tick: () => Promise<void> }).tick();
      expect(adapter.bitrate).toBe(droppedBitrate);
    }
    // 5th good sample:
    packetsSent += 100;
    await (adapter as unknown as { tick: () => Promise<void> }).tick();
    expect(adapter.bitrate).toBe(Math.round(droppedBitrate * 1.15));
  });

  it("handles missing or throwing getStats gracefully", async () => {
    const { BitrateAdapter } = await import("@src/quality");
    const brokenSender = {
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => {},
      getStats: async () => { throw new Error("network error"); },
    } as unknown as RTCRtpSender;

    const adapter = new BitrateAdapter(brokenSender, PRESET);
    await expect((adapter as unknown as { tick: () => Promise<void> }).tick()).resolves.not.toThrow();
  });

  it("handles start and stop timer", async () => {
    const { BitrateAdapter } = await import("@src/quality");
    const sender = makeSender(() => new Map() as unknown as RTCStatsReport);
    const adapter = new BitrateAdapter(sender, PRESET);
    adapter.start(100);
    adapter.stop();
    adapter.stop(); // idempotent
    expect(adapter.bitrate).toBe(PRESET.maxBitrate);
  });

  it("handles incomplete or non-advancing stats in sampleLossRatio", async () => {
    const { BitrateAdapter } = await import("@src/quality");

    // Case 1: missing packetsSent or packetsLost
    let map = new Map<string, unknown>();
    map.set("outbound", { type: "outbound-rtp", kind: "video" }); // no packetsSent
    map.set("remote-inbound", { type: "remote-inbound-rtp", kind: "video" }); // no packetsLost
    const sender1 = makeSender(() => map as unknown as RTCStatsReport);
    const adapter1 = new BitrateAdapter(sender1, PRESET);
    await (adapter1 as unknown as { tick: () => Promise<void> }).tick();
    expect(adapter1.bitrate).toBe(PRESET.maxBitrate);

    // Case 2: packetsSent doesn't advance (dSent <= 0)
    let packetsSent = 500;
    let packetsLost = 10;
    const sender2 = makeSender(() => {
      const m = new Map<string, unknown>();
      m.set("outbound", { type: "outbound-rtp", kind: "video", packetsSent });
      m.set("remote-inbound", { type: "remote-inbound-rtp", kind: "video", packetsLost });
      return m as unknown as RTCStatsReport;
    });
    const adapter2 = new BitrateAdapter(sender2, PRESET);
    await (adapter2 as unknown as { tick: () => Promise<void> }).tick(); // baseline
    // Tick again without incrementing packetsSent -> dSent == 0 -> returns null
    await (adapter2 as unknown as { tick: () => Promise<void> }).tick();
    expect(adapter2.bitrate).toBe(PRESET.maxBitrate);
  });
});
