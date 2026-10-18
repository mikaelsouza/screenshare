import { describe, expect, it } from "vitest";
import {
  LinkMonitor,
  classifyNatMapping,
  isDirect,
  normalizeAddress,
  parseCandidate,
  summarize,
  type HostSockets,
  type NatClassification,
  type ParsedCandidate,
} from "@src/stats";
import { gatherCandidates, natRow } from "@src/nat";
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

  it("includes packet loss percentage when loss is significant", () => {
    const s = summarize({
      candidateType: "srflx",
      remoteCandidateType: "srflx",
      rttMs: 15,
      availableOutgoingBitrate: 8_000_000,
      packetLossRatio: 0.045, // 4.5%
      outboundBitrate: 6_000_000,
      framesPerSecond: 60,
      frameWidth: 1920,
      frameHeight: 1080,
      encoderImplementation: "NVENC",
      jitterBufferDelayMs: 5,
    });
    expect(s).toContain("4.5% loss");
  });

  it("identifies unknown routes with isRouteUnknown", async () => {
    const { isRouteUnknown } = await import("@src/stats");
    expect(isRouteUnknown({ candidateType: "unknown", remoteCandidateType: "srflx" } as LinkHealth)).toBe(true);
    expect(isRouteUnknown({ candidateType: "srflx", remoteCandidateType: "unknown" } as LinkHealth)).toBe(true);
    expect(isRouteUnknown({ candidateType: "srflx", remoteCandidateType: "srflx" } as LinkHealth)).toBe(false);
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

  it("handles malformed candidate string gracefully", () => {
    expect(parseCandidate({ candidate: "invalid string" } as unknown as RTCIceCandidate)).toMatchObject({
      type: "unknown",
    });
  });

  it("reads the related base, preferring parsed fields over the SDP line", () => {
    const c = parseCandidate({
      candidate: line,
      relatedAddress: "10.1.2.3",
      relatedPort: 12345,
    } as unknown as RTCIceCandidate);
    expect(c).toMatchObject({ relatedAddress: "10.1.2.3", relatedPort: 12345 });
  });

  it("falls back to the SDP raddr/rport when the related fields are missing", () => {
    const missing = parseCandidate({
      candidate: line, relatedAddress: undefined, relatedPort: undefined,
    } as unknown as RTCIceCandidate);
    expect(missing).toMatchObject({ relatedAddress: "192.168.1.5", relatedPort: 49152 });

    const nulled = parseCandidate({
      candidate: line, relatedAddress: null, relatedPort: null,
    } as unknown as RTCIceCandidate);
    expect(nulled).toMatchObject({ relatedAddress: "192.168.1.5", relatedPort: 49152 });
  });

  it("keeps Chrome's redacted base as 0.0.0.0/0", () => {
    const redacted = "candidate:1 1 udp 1 203.0.113.5 6000 typ srflx raddr 0.0.0.0 rport 0";
    expect(parseCandidate({ candidate: redacted } as unknown as RTCIceCandidate)).toMatchObject({
      relatedAddress: "0.0.0.0", relatedPort: 0,
    });
  });

  it("keeps a real relatedAddress even when relatedPort is 0", () => {
    const c = parseCandidate({
      candidate: line, relatedAddress: "192.168.1.5", relatedPort: 0,
    } as unknown as RTCIceCandidate);
    expect(c).toMatchObject({ relatedAddress: "192.168.1.5", relatedPort: 0 });
  });

  it("parses related fields regardless of case and spacing", () => {
    const spaced =
      "candidate:7  1  UDP  1  203.0.113.5  6000  typ  srflx  RADDR  192.168.1.5  RPort  49152";
    expect(parseCandidate({ candidate: spaced } as unknown as RTCIceCandidate)).toMatchObject({
      type: "srflx", relatedAddress: "192.168.1.5", relatedPort: 49152,
    });
  });
});

describe("normalizeAddress", () => {
  it("trims, lowercases, and strips brackets and zones", () => {
    expect(normalizeAddress("  192.168.0.6 ")).toEqual({ address: "192.168.0.6", family: "v4" });
    expect(normalizeAddress("[2001:DB8::1]")).toEqual(normalizeAddress("2001:db8:0:0:0:0:0:1"));
    expect(normalizeAddress("fe80::1%eth0")).toEqual(normalizeAddress("fe80::1"));
  });

  it("rejects unspecified, redacted, and mDNS addresses", () => {
    for (const raw of [
      "0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0",
      "abc.local", "ABC.LOCAL.", "", "   ", "not-an-address",
    ]) {
      expect(normalizeAddress(raw)).toBeNull();
    }
  });

  it("normalizes IPv4-mapped IPv6 to the IPv4 address", () => {
    expect(normalizeAddress("::ffff:192.168.0.6")).toEqual({ address: "192.168.0.6", family: "v4" });
    expect(normalizeAddress("0:0:0:0:0:ffff:192.168.0.6")).toEqual({
      address: "192.168.0.6", family: "v4",
    });
  });
});

function srflx(overrides: Partial<ParsedCandidate> = {}): ParsedCandidate {
  return {
    type: "srflx",
    address: "203.0.113.5",
    port: 6000,
    protocol: "udp",
    relatedAddress: "192.168.0.6",
    relatedPort: 58735,
    ...overrides,
  };
}

const NO_HOSTS: HostSockets = { v4: 0, v6: 0, unknown: 0 };
const ONE_V4_HOST: HostSockets = { v4: 1, v6: 0, unknown: 0 };

function classify(cands: ParsedCandidate[], hosts: HostSockets = NO_HOSTS): NatClassification {
  return classifyNatMapping(cands, hosts);
}

describe("classifyNatMapping", () => {
  it("reports no-srflx when there is nothing reflexive to compare", () => {
    const host: ParsedCandidate = { ...srflx(), type: "host" };
    expect(classify([host]).verdict).toBe("no-srflx");
    expect(classify([]).verdict).toBe("no-srflx");
  });

  it("does not infer a base from default Chrome's redacted raddr/rport", () => {
    const result = classify([
      srflx({ relatedAddress: "0.0.0.0", relatedPort: 0, port: 6000 }),
      srflx({ relatedAddress: "0.0.0.0", relatedPort: 0, port: 6001 }),
    ], { v4: 0, v6: 0, unknown: 1 });
    expect(result.verdict).toBe("inconclusive");
    expect(result.unbasedCount).toBe(2);
  });

  it("is inconclusive when an unbased candidate exists beside a symmetric group", () => {
    const result = classify([
      srflx({ port: 6000 }),
      srflx({ port: 6001 }),
      srflx({ relatedAddress: "0.0.0.0", relatedPort: 0, port: 7000 }),
    ]);
    expect(result.verdict).toBe("inconclusive");
    expect(result.unbasedCount).toBe(1);
  });

  it("never partially infers a base", () => {
    const result = classify([
      srflx({ relatedAddress: "abc.local", relatedPort: 5000, port: 6000 }),
      srflx({ relatedAddress: "192.168.0.6", relatedPort: 58735, port: 6001 }),
    ], ONE_V4_HOST);
    expect(result.verdict).toBe("inconclusive");
  });

  it("reports no-evidence for one observation on a base", () => {
    const result = classify([
      srflx({ port: 6000 }),
      srflx({ port: 6000 }),
    ]);
    expect(result.verdict).toBe("no-evidence");
    expect(result.observations).toBe(2);
    expect(result.baseCount).toBe(1);
  });

  it("reports symmetric when one base uses two external ports", () => {
    const result = classify([
      srflx({ port: 6000 }),
      srflx({ port: 6001 }),
    ]);
    expect(result.verdict).toBe("symmetric");
    expect(result.base).toBe("192.168.0.6:58735");
    expect(result.ports).toBe(2);
  });

  // Issue #13 regression: each interface is its own base, so two ports behind an
  // endpoint-independent NAT are not a symmetric mapping.
  it("does not pool candidates across local base sockets", () => {
    const result = classify([
      srflx({ relatedAddress: "192.168.0.6", relatedPort: 58735, port: 6000 }),
      srflx({ relatedAddress: "192.168.1.10", relatedPort: 49152, port: 6001 }),
    ]);
    expect(result.verdict).toBe("no-evidence");
    expect(result.baseCount).toBe(2);
    expect(result.multiplePaths).toBe(true);
  });

  it("treats a same-base external address change as inconclusive", () => {
    const samePort = classify([
      srflx({ address: "198.51.100.1", port: 6000 }),
      srflx({ address: "198.51.100.2", port: 6000 }),
    ]);
    expect(samePort.verdict).toBe("inconclusive");

    const differentPorts = classify([
      srflx({ address: "198.51.100.1", port: 6000 }),
      srflx({ address: "198.51.100.2", port: 6001 }),
    ]);
    expect(differentPorts.verdict).toBe("inconclusive");
  });

  it("does not infer a base when a family has more than one host socket", () => {
    const result = classify([
      srflx({ relatedAddress: "0.0.0.0", relatedPort: 0, port: 6000 }),
      srflx({ relatedAddress: "0.0.0.0", relatedPort: 0, port: 6001 }),
    ], { v4: 2, v6: 0, unknown: 0 });
    expect(result.verdict).toBe("inconclusive");
  });

  it("infers a base from exactly one literal host socket", () => {
    const samePort = classify([
      srflx({ relatedAddress: "0.0.0.0", relatedPort: 0, port: 6000 }),
    ], ONE_V4_HOST);
    expect(samePort.verdict).toBe("no-evidence");

    const result = classify([
      srflx({ relatedAddress: "0.0.0.0", relatedPort: 0, port: 6000 }),
      srflx({ relatedAddress: "0.0.0.0", relatedPort: 0, port: 6001 }),
    ], ONE_V4_HOST);
    expect(result.verdict).toBe("symmetric");
    expect(result.base).toBe("the inferred IPv4 host socket");
  });

  it("lets an unknown host entry block inference for every family", () => {
    const result = classify([
      srflx({ relatedAddress: "0.0.0.0", relatedPort: 0, port: 6000 }),
      srflx({
        address: "2001:db8::5", relatedAddress: "0.0.0.0", relatedPort: 0, port: 6000,
      }),
    ], { v4: 0, v6: 0, unknown: 2 });
    expect(result.verdict).toBe("inconclusive");
    expect(result.unbasedCount).toBe(2);
    expect(result.multiplePaths).toBe(true);
  });

  it("treats a VPN path as its own base", () => {
    const result = classify([
      srflx({ relatedAddress: "192.168.0.6", relatedPort: 58735, port: 6000 }),
      srflx({ relatedAddress: "10.8.0.2", relatedPort: 50000, port: 6001 }),
    ]);
    expect(result.verdict).toBe("no-evidence");
  });

  it("ignores relay candidates, including TCP relays", () => {
    const relay = srflx({
      type: "relay", protocol: "tcp", relatedAddress: "198.51.100.9", relatedPort: 60000, port: 6002,
    });
    const result = classify([srflx({ port: 6000 }), relay]);
    expect(result.verdict).toBe("no-evidence");
    expect(result.srflxCount).toBe(1);
  });

  it("groups expanded and compressed IPv6 bases", () => {
    const result = classify([
      srflx({ relatedAddress: "2001:0DB8::1", relatedPort: 5000, port: 6000 }),
      srflx({ relatedAddress: "2001:db8:0:0:0:0:0:1", relatedPort: 5000, port: 6001 }),
    ]);
    expect(result.verdict).toBe("symmetric");
    expect(result.base).toBe("[2001:db8:0:0:0:0:0:1]:5000");
  });

  it("treats an IPv4-mapped base as the same base as plain IPv4", () => {
    const result = classify([
      srflx({ relatedAddress: "::ffff:192.168.0.6", relatedPort: 58735, port: 6000 }),
      srflx({ relatedAddress: "192.168.0.6", relatedPort: 58735, port: 6001 }),
    ]);
    expect(result.verdict).toBe("symmetric");
  });

  it("keeps native IPv6 and IPv4 bases distinct", () => {
    const result = classify([
      srflx({ relatedAddress: "2001:db8::1", relatedPort: 5000, port: 6000 }),
      srflx({ relatedAddress: "::ffff:192.168.0.6", relatedPort: 58735, port: 6001 }),
    ]);
    expect(result.verdict).toBe("no-evidence");
    expect(result.baseCount).toBe(2);
  });
});

function nat(
  verdict: NatClassification["verdict"],
  overrides: Partial<NatClassification> = {},
): NatClassification {
  return {
    verdict,
    srflxCount: 2,
    unbasedCount: 0,
    observations: 2,
    baseCount: 1,
    base: "192.168.0.6:58735",
    ports: 2,
    multiplePaths: false,
    ...overrides,
  };
}

describe("natRow", () => {
  it("folds a symmetric verdict to INFO while detection is gated off", () => {
    const row = natRow(nat("symmetric"));
    expect(row.status).toBe("info");
    expect(row.details).toMatch(/not determinable/i);
  });

  it("reports symmetric as WARN only when detection is enabled", () => {
    const row = natRow(nat("symmetric"), { symmetricDetection: true });
    expect(row.status).toBe("warn");
    expect(row.details).toMatch(
      /Address\/port-dependent mapping observed on 192\.168\.0\.6:58735: 2 external ports\. TURN may be required\./,
    );
  });

  it("reports no-evidence as PASS with the single-observation caveat", () => {
    const row = natRow(nat("no-evidence"));
    expect(row.status).toBe("pass");
    expect(row.details).toMatch(/no evidence/i);
    expect(row.details).toMatch(/same-base observations/);
  });

  it("reports inconclusive as INFO and mentions multiple local paths when seen", () => {
    const row = natRow(nat("inconclusive", { unbasedCount: 2, multiplePaths: true }));
    expect(row.status).toBe("info");
    expect(row.details).toMatch(/not determinable/i);
    expect(row.details).toMatch(/Multiple local paths detected\./);
    expect(row.details).toMatch(/No TURN conclusion\./);
  });

  it("reports no-srflx as WARN with its own message", () => {
    const row = natRow(nat("no-srflx", { srflxCount: 0 }));
    expect(row.status).toBe("warn");
    expect(row.details).toMatch(/no server-reflexive/i);
  });
});

interface FakeHost {
  address: string;
  port: number;
}

/** A fake RTCPeerConnection that records getStats()/close ordering. */
function fakeGatherPc(options: {
  hostEvents: FakeHost[];
  statsHosts: FakeHost[];
  calls: string[];
}): RTCPeerConnection {
  let statsSettled = false;
  const fake = {
    onicecandidate: null as ((ev: RTCPeerConnectionIceEvent) => void) | null,
    createDataChannel: () => ({}),
    createOffer: async () => ({ type: "offer", sdp: "" }),
    setLocalDescription: async () => {
      const emit = (candidate: unknown): void =>
        fake.onicecandidate?.({ candidate } as unknown as RTCPeerConnectionIceEvent);
      for (const host of options.hostEvents) {
        emit({
          candidate: `candidate:1 1 udp 1 ${host.address} ${host.port} typ host`,
          type: "host", address: host.address, port: host.port, protocol: "udp",
        });
      }
      emit({
        candidate: "candidate:2 1 udp 1 203.0.113.5 6000 typ srflx raddr 0.0.0.0 rport 0",
        type: "srflx", address: "203.0.113.5", port: 6000, protocol: "udp",
        relatedAddress: "0.0.0.0", relatedPort: 0,
      });
      emit(null);
    },
    getStats: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      statsSettled = true;
      options.calls.push("getStats");
      return new Map(options.statsHosts.map((host, i) => [
        `H${i}`,
        {
          type: "local-candidate", candidateType: "host",
          address: host.address, port: host.port, protocol: "udp",
        },
      ])) as unknown as RTCStatsReport;
    },
    close: () => {
      expect(statsSettled).toBe(true);
      options.calls.push("close");
    },
  };
  return fake as unknown as RTCPeerConnection;
}

describe("gatherCandidates", () => {
  it("takes host sockets from getStats() before closing", async () => {
    const calls: string[] = [];
    const pc = fakeGatherPc({
      hostEvents: [],
      statsHosts: [{ address: "192.168.0.6", port: 50000 }],
      calls,
    });

    const result = await gatherCandidates({ iceServers: [] }, 1000, () => pc);

    expect(result.hostSockets).toEqual({ v4: 1, v6: 0, unknown: 0 });
    expect(calls).toEqual(["getStats", "close"]);
  });

  it("takes the larger count when events and getStats() disagree", async () => {
    const calls: string[] = [];
    const pc = fakeGatherPc({
      hostEvents: [{ address: "192.168.0.6", port: 50000 }],
      statsHosts: [
        { address: "192.168.0.6", port: 50000 },
        { address: "10.0.0.2", port: 50001 },
      ],
      calls,
    });

    const result = await gatherCandidates({ iceServers: [] }, 1000, () => pc);

    expect(result.candidates).toHaveLength(2);
    expect(result.hostSockets).toEqual({ v4: 2, v6: 0, unknown: 0 });
    expect(calls).toEqual(["getStats", "close"]);
  });

  it("marks mDNS host entries as unknown so inference is blocked", async () => {
    const calls: string[] = [];
    const pc = fakeGatherPc({
      hostEvents: [{ address: "6f1b1c2d.local", port: 50000 }],
      statsHosts: [{ address: "6f1b1c2d.local", port: 50000 }],
      calls,
    });

    const result = await gatherCandidates({ iceServers: [] }, 1000, () => pc);

    expect(result.hostSockets).toEqual({ v4: 0, v6: 0, unknown: 1 });
  });
});
