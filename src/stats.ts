/**
 * getStats() extraction for inbound (viewer tile) and outbound (sharer-to-viewer) links.
 */

import { z } from "@shared/protocol";
import type { LinkHealth } from "./quality";

const NullableFiniteNumber = z.number().nullable().catch(null);

const StatSchema = z.object({
  type: z.string().optional().catch(undefined),
  kind: z.string().optional().catch(undefined),
  selectedCandidatePairId: z.string().optional().catch(undefined),
  state: z.string().optional().catch(undefined),
  nominated: z.boolean().optional().catch(undefined),
  currentRoundTripTime: NullableFiniteNumber,
  bytesSent: NullableFiniteNumber,
  bytesReceived: NullableFiniteNumber,
  packetsSent: NullableFiniteNumber,
  packetsReceived: NullableFiniteNumber,
  packetsLost: NullableFiniteNumber,
  framesPerSecond: NullableFiniteNumber,
  frameWidth: NullableFiniteNumber,
  frameHeight: NullableFiniteNumber,
});

type Stat = z.infer<typeof StatSchema>;

interface Sample {
  bytes: number | null;
  packets: number | null;
  packetsLost: number | null;
  timestampMs: number;
}

function findSelectedPair(byId: Map<string, Stat>): Stat | null {
  for (const stat of byId.values()) {
    if (stat.type !== "transport") continue;
    const sel = stat.selectedCandidatePairId;
    const found = sel ? byId.get(sel) : undefined;
    if (found) return found;
  }
  for (const stat of byId.values()) {
    if (stat.type === "candidate-pair" && stat.state === "succeeded" && stat.nominated === true) {
      return stat;
    }
  }
  return null;
}

function findVideoStats(
  byId: Map<string, Stat>,
  direction: "inbound" | "outbound",
): { rtp: Stat | null; lostSource: Stat | null } {
  let rtp: Stat | null = null;
  let remoteInbound: Stat | null = null;
  for (const stat of byId.values()) {
    if (stat.kind !== "video") continue;
    if (direction === "outbound") {
      if (stat.type === "outbound-rtp") rtp = stat;
      else if (stat.type === "remote-inbound-rtp") remoteInbound = stat;
    } else if (stat.type === "inbound-rtp") {
      rtp = stat;
    }
  }
  return { rtp, lostSource: direction === "outbound" ? remoteInbound : rtp };
}

function computeBitrate(curr: Sample, prev: Sample): number | null {
  const dt = (curr.timestampMs - prev.timestampMs) / 1000;
  if (dt <= 0 || curr.bytes === null || prev.bytes === null) return null;
  return Math.max(0, ((curr.bytes - prev.bytes) * 8) / dt);
}

function computeLossRatio(
  curr: Sample,
  prev: Sample,
  direction: "inbound" | "outbound",
): number | null {
  if (
    curr.packets === null || prev.packets === null ||
    curr.packetsLost === null || prev.packetsLost === null
  ) {
    return null;
  }
  const dPackets = curr.packets - prev.packets;
  const dLost = curr.packetsLost - prev.packetsLost;
  const denom = direction === "inbound" ? dPackets + Math.max(0, dLost) : dPackets;
  return denom > 0 ? Math.max(0, dLost) / denom : null;
}

/**
 * Polls one RTCPeerConnection and turns raw stats into LinkHealth.
 *
 * Stateful because the interesting quantities are rates, not counters: WebRTC reports
 * cumulative byte/packet counts, so bitrate and loss only exist as deltas between two samples.
 */
export class LinkMonitor {
  private prev: Sample | null = null;

  private readonly pc: RTCPeerConnection;
  private readonly direction: "inbound" | "outbound";

  constructor(
    pc: RTCPeerConnection,
    direction: "inbound" | "outbound" = "outbound",
  ) {
    this.pc = pc;
    this.direction = direction;
  }

  async read(): Promise<LinkHealth | null> {
    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      return null;
    }

    const byId = new Map<string, Stat>();
    report.forEach((entry, id) => {
      const parsed = StatSchema.safeParse(entry);
      if (parsed.success) byId.set(id, parsed.data);
    });

    const pair = findSelectedPair(byId);
    const { rtp, lostSource } = findVideoStats(byId, this.direction);

    const sample: Sample = {
      bytes: rtp ? (this.direction === "outbound" ? rtp.bytesSent : rtp.bytesReceived) : null,
      packets: rtp ? (this.direction === "outbound" ? rtp.packetsSent : rtp.packetsReceived) : null,
      packetsLost: lostSource ? lostSource.packetsLost : null,
      timestampMs: performance.now(),
    };

    const prev = this.prev;
    const bitrate = prev ? computeBitrate(sample, prev) : null;
    const packetLossRatio = prev ? computeLossRatio(sample, prev, this.direction) : null;
    this.prev = sample;

    const rttSec = pair ? pair.currentRoundTripTime : null;

    return {
      rttMs: rttSec === null ? null : rttSec * 1000,
      packetLossRatio,
      bitrate,
      framesPerSecond: rtp ? rtp.framesPerSecond : null,
      frameWidth: rtp ? rtp.frameWidth : null,
      frameHeight: rtp ? rtp.frameHeight : null,
    };
  }
}

/** Compact one-line summary for a tile overlay or roster row. */
export function summarize(health: LinkHealth, includeResolution = true): string {
  const bits: string[] = [];
  if (health.rttMs !== null) bits.push(`${Math.round(health.rttMs)}ms`);
  if (health.bitrate !== null) bits.push(`${(health.bitrate / 1e6).toFixed(1)} Mbps`);
  if (health.framesPerSecond !== null) bits.push(`${Math.round(health.framesPerSecond)}fps`);
  if (includeResolution && health.frameWidth !== null && health.frameHeight !== null) {
    bits.push(`${health.frameWidth}x${health.frameHeight}`);
  }
  if (health.packetLossRatio !== null && health.packetLossRatio > 0.001) {
    bits.push(`${(health.packetLossRatio * 100).toFixed(1)}% loss`);
  }
  if (bits.length === 0) return "connecting…";
  return bits.join(" · ");
}
