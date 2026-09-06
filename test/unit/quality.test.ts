import { describe, expect, it } from "vitest";
import { applyVideoEncoding, mungeOpusSdp } from "@src/quality";

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

/** Minimal RTCRtpSender double that records what setParameters received. */
function fakeSender(initial: Record<string, unknown>) {
  let params: Record<string, unknown> = { encodings: [{ ...initial }] };
  return {
    sender: {
      getParameters: () => structuredClone(params),
      setParameters: async (p: Record<string, unknown>) => { params = structuredClone(p); },
    } as unknown as RTCRtpSender,
    current: () => (params["encodings"] as Array<Record<string, unknown>>)[0],
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
});
