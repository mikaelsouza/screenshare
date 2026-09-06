import { describe, expect, it } from "vitest";
import { LinkMonitor, isDirect, parseCandidate, summarize } from "@src/stats";
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
    availableOutgoingBitrate: 9_000_000,
  },
  L: { type: "local-candidate", candidateType: "srflx" },
  R: { type: "remote-candidate", candidateType: "srflx" },
  O: {
    type: "outbound-rtp", kind: "video", bytesSent: 1_000_000, packetsSent: 1000,
    framesPerSecond: 60, frameWidth: 1920, frameHeight: 1080,
    encoderImplementation: "ExternalEncoder (NVENC)",
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

  it("averages jitter buffer delay per emitted frame", async () => {
    const h = await new LinkMonitor(fakePc([{
      I: { type: "inbound-rtp", kind: "video", jitterBufferDelay: 1.5, jitterBufferEmittedCount: 100 },
    }])).read();
    expect(h?.jitterBufferDelayMs).toBeCloseTo(15); // 1.5s / 100 frames = 15ms
  });

  it("surfaces the encoder implementation, which reveals software fallback", async () => {
    const h = await new LinkMonitor(fakePc([DIRECT_REPORT])).read();
    expect(h?.encoderImplementation).toContain("NVENC");
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
    availableOutgoingBitrate: null, packetLossRatio: null, outboundBitrate: null,
    framesPerSecond: null, frameWidth: null, frameHeight: null,
    encoderImplementation: null, jitterBufferDelayMs: null,
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

  // Regression: isDirect used to be `!== "relay"` on both fields, so the "unknown"
  // sentinel returned before ICE nominates a pair reported as direct — rendering
  // `direct (unknown)` and suppressing the relay warning on a possibly-relayed link.
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
});

describe("parseCandidate", () => {
  const line = "candidate:842163049 1 udp 1677729535 203.0.113.5 54321 typ srflx raddr 192.168.1.5 rport 49152";

  it("reads the parsed fields when the browser provides them", () => {
    const c = parseCandidate({
      candidate: line, type: "srflx", address: "203.0.113.5", port: 54321, protocol: "udp",
    } as RTCIceCandidate);
    expect(c).toMatchObject({ type: "srflx", address: "203.0.113.5", port: 54321, protocol: "udp" });
  });

  it("falls back to parsing the SDP line when fields are null", () => {
    // Older Chromium leaves these null even though the line is well-formed.
    const c = parseCandidate({
      candidate: line, type: null, address: null, port: null, protocol: null,
    } as unknown as RTCIceCandidate);
    expect(c).toMatchObject({ type: "srflx", address: "203.0.113.5", port: 54321, protocol: "udp" });
  });

  it("parses relay and host candidates", () => {
    const relay = "candidate:1 1 udp 41885439 198.51.100.9 60000 typ relay raddr 0.0.0.0 rport 0";
    expect(parseCandidate({ candidate: relay } as unknown as RTCIceCandidate)?.type).toBe("relay");
    const host = "candidate:2 1 tcp 2105524479 192.168.1.5 9 typ host tcptype active";
    expect(parseCandidate({ candidate: host } as unknown as RTCIceCandidate)).toMatchObject({
      type: "host", protocol: "tcp",
    });
  });

  it("returns null for an empty candidate (the end-of-gathering sentinel)", () => {
    expect(parseCandidate({ candidate: "" } as RTCIceCandidate)).toBeNull();
  });
});
