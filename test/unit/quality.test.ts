import { describe, expect, it } from "vitest";
import { mungeOpusSdp } from "@src/quality";

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
