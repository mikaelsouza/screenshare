import { describe, expect, it } from "vitest";
import { LinkMonitor, summarize } from "@src/stats";
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

const OUTBOUND_REPORT = {
  T: { type: "transport", selectedCandidatePairId: "CP" },
  CP: {
    type: "candidate-pair",
    currentRoundTripTime: 0.024,
  },
  O: {
    type: "outbound-rtp",
    kind: "video",
    bytesSent: 1_000_000,
    packetsSent: 1000,
    framesPerSecond: 60,
    frameWidth: 1920,
    frameHeight: 1080,
  },
  RI: { type: "remote-inbound-rtp", kind: "video", packetsLost: 10 },
};

const INBOUND_REPORT = {
  CP: {
    type: "candidate-pair",
    state: "succeeded",
    nominated: true,
    currentRoundTripTime: 0.018,
  },
  I: {
    type: "inbound-rtp",
    kind: "video",
    bytesReceived: 2_000_000,
    packetsReceived: 2000,
    packetsLost: 5,
    framesPerSecond: 60,
    frameWidth: 2560,
    frameHeight: 1440,
  },
};

describe("LinkMonitor", () => {
  it("converts RTT from seconds to milliseconds via transport or nominated pair", async () => {
    const hOut = await new LinkMonitor(fakePc([OUTBOUND_REPORT]), "outbound").read();
    expect(hOut?.rttMs).toBeCloseTo(24);

    const hIn = await new LinkMonitor(fakePc([INBOUND_REPORT]), "inbound").read();
    expect(hIn?.rttMs).toBeCloseTo(18);
  });

  it("reports no bitrate or loss on the first sample, since rates require two samples", async () => {
    const health = await new LinkMonitor(fakePc([OUTBOUND_REPORT])).read();
    expect(health?.bitrate).toBeNull();
    expect(health?.packetLossRatio).toBeNull();
  });

  it("computes outbound bitrate and loss from counter deltas across samples", async () => {
    const second = structuredClone(OUTBOUND_REPORT);
    second.O["bytesSent"] = 1_750_000; // +750 kB
    second.O["packetsSent"] = 1600; // +600
    second.RI["packetsLost"] = 40; // +30 -> 5%
    const monitor = new LinkMonitor(fakePc([OUTBOUND_REPORT, second]), "outbound");

    await monitor.read();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const health = await monitor.read();

    expect(health?.bitrate).toBeGreaterThan(1_000_000);
    expect(health?.packetLossRatio).toBeCloseTo(30 / 600, 5);
  });

  it("computes inbound bitrate and loss from inbound-rtp deltas across samples", async () => {
    const second = structuredClone(INBOUND_REPORT);
    second.I["bytesReceived"] = 2_500_000; // +500 kB
    second.I["packetsReceived"] = 2475; // +475 received
    second.I["packetsLost"] = 30; // +25 lost -> 25 / (475 + 25) = 5%
    const monitor = new LinkMonitor(fakePc([INBOUND_REPORT, second]), "inbound");

    await monitor.read();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const health = await monitor.read();

    expect(health?.bitrate).toBeGreaterThan(1_000_000);
    expect(health?.packetLossRatio).toBeCloseTo(25 / 500, 5);
    expect(health?.frameWidth).toBe(2560);
    expect(health?.frameHeight).toBe(1440);
  });

  it("returns null instead of throwing when getStats rejects", async () => {
    const pc = {
      getStats: () => Promise.reject(new Error("closed")),
    } as unknown as RTCPeerConnection;
    expect(await new LinkMonitor(pc).read()).toBeNull();
  });

  it("degrades gracefully on an empty report across multiple samples", async () => {
    const monitor = new LinkMonitor(fakePc([{}, {}]));
    const first = await monitor.read();
    const second = await monitor.read();
    expect(first?.rttMs).toBeNull();
    expect(first?.bitrate).toBeNull();
    expect(second?.bitrate).toBeNull();
    expect(second?.packetLossRatio).toBeNull();
  });

  it("sanitizes non-finite numbers (NaN, Infinity) to null", async () => {
    const pc = {
      getStats: () =>
        Promise.resolve(
          new Map([
            [
              "CP",
              {
                type: "candidate-pair",
                state: "succeeded",
                nominated: true,
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
        ),
    } as unknown as RTCPeerConnection;

    const health = await new LinkMonitor(pc).read();
    expect(health?.rttMs).toBeNull();
    expect(health?.framesPerSecond).toBeNull();
  });
});

describe("summarize", () => {
  const base: LinkHealth = {
    rttMs: 19.2,
    packetLossRatio: 0,
    bitrate: 8_000_000,
    framesPerSecond: 60,
    frameWidth: 1920,
    frameHeight: 1080,
  };

  it("formats compact 1-line telemetry with and without resolution", () => {
    expect(summarize(base, true)).toBe("19ms · 8.0 Mbps · 60fps · 1920x1080");
    expect(summarize(base, false)).toBe("19ms · 8.0 Mbps · 60fps");
  });

  it("includes packet loss percentage when loss is significant (> 0.1%)", () => {
    expect(summarize({ ...base, packetLossRatio: 0.045 }, false)).toBe(
      "19ms · 8.0 Mbps · 60fps · 4.5% loss",
    );
  });

  it("returns connecting… when no metrics are available yet", () => {
    expect(
      summarize({
        rttMs: null,
        packetLossRatio: null,
        bitrate: null,
        framesPerSecond: null,
        frameWidth: null,
        frameHeight: null,
      }),
    ).toBe("connecting…");
  });
});
