import { describe, expect, it } from "vitest";
import { LinkMonitor, isDirect, summarize } from "@src/stats";
import type { LinkHealth } from "@src/quality";

/** Build a fake RTCPeerConnection whose getStats() returns scripted reports. */
function fakePc(reports: Array<Record<string, Record<string, unknown>>>): RTCPeerConnection {
  let call = 0;
  return {
    getStats: async () => {
      const entry = reports[Math.min(call++, reports.length - 1)] ?? {};
      return new Map(Object.entries(entry)) as unknown as RTCStatsReport;
    },
  } as unknown as RTCPeerConnection;
}

const DIRECT_REPORT = {
  T: { type: "transport", selectedCandidatePairId: "CP" },
  CP: {
    type: "candidate-pair",
    localCandidateId: "L",
    remoteCandidateId: "R",
    currentRoundTripTime: 0.024,
  },
  L: { type: "local-candidate", candidateType: "srflx" },
  R: { type: "remote-candidate", candidateType: "srflx" },
  O: {
    type: "outbound-rtp", kind: "video", bytesSent: 1_000_000, packetsSent: 1000,
    framesPerSecond: 60, frameWidth: 1920, frameHeight: 1080,
  },
  RI: { type: "remote-inbound-rtp", kind: "video", packetsLost: 10 },
};

describe("LinkMonitor", () => {
  it("extracts the selected candidate pair via the transport entry", async () => {
    const h = await new LinkMonitor(fakePc([DIRECT_REPORT])).read();
    expect(h?.candidateType).toBe("srflx");
    expect(h?.remoteCandidateType).toBe("srflx");
  });

  it("converts RTT from seconds to milliseconds", async () => {
    const h = await new LinkMonitor(fakePc([DIRECT_REPORT])).read();
    expect(h?.rttMs).toBeCloseTo(24);
  });

  it("falls back to a nominated succeeded pair when no transport entry exists", async () => {
    const h = await new LinkMonitor(fakePc([{
      CP: {
        type: "candidate-pair", state: "succeeded", nominated: true,
        localCandidateId: "L", remoteCandidateId: "R",
      },
      L: { type: "local-candidate", candidateType: "relay" },
      R: { type: "remote-candidate", candidateType: "host" },
    }])).read();
    expect(h?.candidateType).toBe("relay");
  });

  it("reports no bitrate on the first sample, since a rate needs two", async () => {
    const h = await new LinkMonitor(fakePc([DIRECT_REPORT])).read();
    expect(h?.outboundBitrate).toBeNull();
    expect(h?.packetLossRatio).toBeNull();
  });

  it("computes bitrate and loss from counter deltas across samples", async () => {
    const second = structuredClone(DIRECT_REPORT);
    second.O["bytesSent"] = 1_750_000;   // +750 kB
    second.O["packetsSent"] = 1600;      // +600
    second.RI["packetsLost"] = 40;       // +30 -> 5%
    const monitor = new LinkMonitor(fakePc([DIRECT_REPORT, second]));

    await monitor.read();
    await new Promise((r) => setTimeout(r, 25));
    const h = await monitor.read();

    // 750 kB over the elapsed interval, as bits/sec. Timing is real, so assert a range.
    expect(h?.outboundBitrate).toBeGreaterThan(1_000_000);
    expect(h?.packetLossRatio).toBeCloseTo(30 / 600, 5);
  });

  it("returns null instead of throwing when getStats rejects", async () => {
    const pc = { getStats: async () => { throw new Error("closed"); } } as unknown as RTCPeerConnection;
    expect(await new LinkMonitor(pc).read()).toBeNull();
  });

  it("degrades gracefully on an empty report", async () => {
    const h = await new LinkMonitor(fakePc([{}])).read();
    expect(h?.candidateType).toBe("unknown");
    expect(h?.rttMs).toBeNull();
  });
});

describe("isDirect", () => {
  const base: LinkHealth = {
    candidateType: "srflx", remoteCandidateType: "srflx", rttMs: 20,
    packetLossRatio: null, outboundBitrate: null,
    framesPerSecond: null, frameWidth: null, frameHeight: null,
  };

  it("treats host and srflx pairs as direct", () => {
    expect(isDirect(base)).toBe(true);
    expect(isDirect({ ...base, candidateType: "host", remoteCandidateType: "host" })).toBe(true);
  });

  it("treats a relay on either end as not direct", () => {
    expect(isDirect({ ...base, candidateType: "relay" })).toBe(false);
    expect(isDirect({ ...base, remoteCandidateType: "relay" })).toBe(false);
  });

  it("labels a relayed link clearly in the summary", () => {
    expect(summarize({ ...base, candidateType: "relay" })).toContain("relayed");
    expect(summarize(base)).toContain("direct");
  });

  it("does not claim an unknown route is direct", () => {
    expect(isDirect({ ...base, candidateType: "unknown", remoteCandidateType: "unknown" })).toBe(false);
    expect(isDirect({ ...base, candidateType: "unknown" })).toBe(false);
    expect(isDirect({ ...base, remoteCandidateType: "unknown" })).toBe(false);
  });

  it("distinguishes 'not yet known' from 'known and relayed' in the summary", () => {
    const unknown = summarize({ ...base, candidateType: "unknown", remoteCandidateType: "unknown" });
    expect(unknown).toContain("connecting");
    expect(unknown).not.toContain("direct");
    expect(unknown).not.toContain("relayed");
  });

  it("accepts prflx, which is a legitimate direct path", () => {
    expect(isDirect({ ...base, candidateType: "prflx", remoteCandidateType: "host" })).toBe(true);
  });

  it("reports unknown routes for an empty stats report rather than claiming direct", async () => {
    const pc = { getStats: async () => new Map() as unknown as RTCStatsReport } as unknown as RTCPeerConnection;
    const h = await new LinkMonitor(pc).read();
    expect(h).not.toBeNull();
    expect(isDirect(h!)).toBe(false);
  });

  it("includes packet loss percentage when loss is significant", () => {
    const s = summarize({
      candidateType: "srflx",
      remoteCandidateType: "srflx",
      rttMs: 15,
      packetLossRatio: 0.045, // 4.5%
      outboundBitrate: 6_000_000,
      framesPerSecond: 60,
      frameWidth: 1920,
      frameHeight: 1080,
    });
    expect(s).toContain("4.5% loss");
  });

  it("identifies unknown routes with isRouteUnknown", async () => {
    const { isRouteUnknown } = await import("@src/stats");
    expect(isRouteUnknown({ candidateType: "unknown", remoteCandidateType: "srflx" } as LinkHealth)).toBe(true);
    expect(isRouteUnknown({ candidateType: "srflx", remoteCandidateType: "unknown" } as LinkHealth)).toBe(true);
    expect(isRouteUnknown({ candidateType: "srflx", remoteCandidateType: "srflx" } as LinkHealth)).toBe(false);
  });

  it("sanitizes non-finite numbers (NaN, Infinity) to null", async () => {
    const pc = {
      getStats: async () =>
        new Map([
          [
            "CP",
            {
              type: "candidate-pair",
              currentRoundTripTime: Infinity,
            },
          ],
          [
            "O",
            {
              type: "outbound-rtp",
              kind: "video",
              framesPerSecond: NaN,
            },
          ],
        ]) as unknown as RTCStatsReport,
    } as unknown as RTCPeerConnection;

    const h = await new LinkMonitor(pc).read();
    expect(h?.rttMs).toBeNull();
    expect(h?.framesPerSecond).toBeNull();
  });
});
