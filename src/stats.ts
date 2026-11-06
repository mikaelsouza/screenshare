/**
 * getStats() extraction for inbound (viewer tile) and outbound (sharer-to-viewer) links.
 */

import type { LinkHealth } from "./quality";

/** Narrow a raw stats entry to a plain record so index access is checkable. */
type Stat = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

interface Sample {
  bytes: number | null;
  packets: number | null;
  packetsLost: number | null;
  timestampMs: number;
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
    report.forEach((entry, id) => byId.set(id, entry as unknown as Stat));

    // Prefer the transport's nominated pair; fall back to scanning for a succeeded
    // one, because the transport entry isn't present in every browser version.
    let pair: Stat | null = null;
    for (const s of byId.values()) {
      if (s["type"] === "transport") {
        const sel = str(s["selectedCandidatePairId"]);
        const found = sel ? byId.get(sel) : undefined;
        if (found) {
          pair = found;
          break;
        }
      }
    }
    if (!pair) {
      for (const s of byId.values()) {
        if (s["type"] === "candidate-pair" && s["state"] === "succeeded" && s["nominated"] === true) {
          pair = s;
          break;
        }
      }
    }

    let rtp: Stat | null = null;
    let remoteInbound: Stat | null = null;
    for (const s of byId.values()) {
      if (s["kind"] !== "video") continue;
      if (this.direction === "outbound") {
        if (s["type"] === "outbound-rtp") rtp = s;
        else if (s["type"] === "remote-inbound-rtp") remoteInbound = s;
      } else {
        if (s["type"] === "inbound-rtp") rtp = s;
      }
    }

    const now = performance.now();
    const bytesKey = this.direction === "outbound" ? "bytesSent" : "bytesReceived";
    const packetsKey = this.direction === "outbound" ? "packetsSent" : "packetsReceived";
    const lostSource = this.direction === "outbound" ? remoteInbound : rtp;

    const sample: Sample = {
      bytes: rtp ? num(rtp[bytesKey]) : null,
      packets: rtp ? num(rtp[packetsKey]) : null,
      packetsLost: lostSource ? num(lostSource["packetsLost"]) : null,
      timestampMs: now,
    };

    let bitrate: number | null = null;
    let packetLossRatio: number | null = null;
    const prev = this.prev;
    if (prev) {
      const dt = (sample.timestampMs - prev.timestampMs) / 1000;
      if (dt > 0 && sample.bytes !== null && prev.bytes !== null) {
        bitrate = Math.max(0, ((sample.bytes - prev.bytes) * 8) / dt);
      }
      if (
        sample.packets !== null && prev.packets !== null &&
        sample.packetsLost !== null && prev.packetsLost !== null
      ) {
        const dPackets = sample.packets - prev.packets;
        const dLost = sample.packetsLost - prev.packetsLost;
        const denom = this.direction === "inbound" ? dPackets + Math.max(0, dLost) : dPackets;
        if (denom > 0) packetLossRatio = Math.max(0, dLost) / denom;
      }
    }
    this.prev = sample;

    const rttSec = pair ? num(pair["currentRoundTripTime"]) : null;

    return {
      rttMs: rttSec === null ? null : rttSec * 1000,
      packetLossRatio,
      bitrate,
      framesPerSecond: rtp ? num(rtp["framesPerSecond"]) : null,
      frameWidth: rtp ? num(rtp["frameWidth"]) : null,
      frameHeight: rtp ? num(rtp["frameHeight"]) : null,
    };
  }
}

/** Compact one-line summary for a tile overlay or roster row. */
export function summarize(h: LinkHealth, includeResolution = true): string {
  const bits: string[] = [];
  if (h.rttMs !== null) bits.push(`${Math.round(h.rttMs)}ms`);
  if (h.bitrate !== null) bits.push(`${(h.bitrate / 1e6).toFixed(1)} Mbps`);
  if (h.framesPerSecond !== null) bits.push(`${Math.round(h.framesPerSecond)}fps`);
  if (includeResolution && h.frameWidth !== null && h.frameHeight !== null) {
    bits.push(`${h.frameWidth}x${h.frameHeight}`);
  }
  if (h.packetLossRatio !== null && h.packetLossRatio > 0.001) {
    bits.push(`${(h.packetLossRatio * 100).toFixed(1)}% loss`);
  }
  if (bits.length === 0) return "connecting…";
  return bits.join(" · ");
}
