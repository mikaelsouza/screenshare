/**
 * getStats() extraction.
 *
 * The one number that matters most here is `candidateType`: "srflx" or "host" means
 * the connection is direct peer-to-peer, which is the entire premise of this project.
 * "relay" means the stream is being bounced through Cloudflare's TURN servers, which
 * works but costs latency. Without this module that distinction is invisible.
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
  bytesSent: number | null;
  packetsSent: number | null;
  packetsLost: number | null;
  timestampMs: number;
}

/**
 * Polls one RTCPeerConnection and turns raw stats into LinkHealth.
 *
 * Stateful because the interesting quantities are rates, not counters: WebRTC reports
 * cumulative `bytesSent`, so bitrate only exists as a delta between two samples.
 */
export class LinkMonitor {
  private prev: Sample | null = null;

  constructor(private readonly pc: RTCPeerConnection) {}

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

    const localId = pair ? str(pair["localCandidateId"]) : null;
    const remoteId = pair ? str(pair["remoteCandidateId"]) : null;
    const local = localId ? byId.get(localId) : undefined;
    const remote = remoteId ? byId.get(remoteId) : undefined;

    let outbound: Stat | null = null;
    let remoteInbound: Stat | null = null;
    let inbound: Stat | null = null;
    for (const s of byId.values()) {
      if (s["kind"] !== "video") continue;
      if (s["type"] === "outbound-rtp") outbound = s;
      else if (s["type"] === "remote-inbound-rtp") remoteInbound = s;
      else if (s["type"] === "inbound-rtp") inbound = s;
    }

    // Rates from counter deltas.
    const now = performance.now();
    const sample: Sample = {
      bytesSent: outbound ? num(outbound["bytesSent"]) : null,
      packetsSent: outbound ? num(outbound["packetsSent"]) : null,
      packetsLost: remoteInbound ? num(remoteInbound["packetsLost"]) : null,
      timestampMs: now,
    };

    let outboundBitrate: number | null = null;
    let packetLossRatio: number | null = null;
    const prev = this.prev;
    if (prev) {
      const dt = (sample.timestampMs - prev.timestampMs) / 1000;
      if (dt > 0 && sample.bytesSent !== null && prev.bytesSent !== null) {
        outboundBitrate = Math.max(0, ((sample.bytesSent - prev.bytesSent) * 8) / dt);
      }
      if (
        sample.packetsSent !== null && prev.packetsSent !== null &&
        sample.packetsLost !== null && prev.packetsLost !== null
      ) {
        const dSent = sample.packetsSent - prev.packetsSent;
        const dLost = sample.packetsLost - prev.packetsLost;
        if (dSent > 0) packetLossRatio = Math.max(0, dLost) / dSent;
      }
    }
    this.prev = sample;

    // jitterBufferDelay is cumulative seconds; divide by the emitted-count to get
    // the current average delay per frame, which is the actual latency contribution.
    let jitterBufferDelayMs: number | null = null;
    if (inbound) {
      const delay = num(inbound["jitterBufferDelay"]);
      const count = num(inbound["jitterBufferEmittedCount"]);
      if (delay !== null && count !== null && count > 0) {
        jitterBufferDelayMs = (delay / count) * 1000;
      }
    }

    const rttSec = pair ? num(pair["currentRoundTripTime"]) : null;

    return {
      candidateType: (local ? str(local["candidateType"]) : null) ?? "unknown",
      remoteCandidateType: (remote ? str(remote["candidateType"]) : null) ?? "unknown",
      rttMs: rttSec === null ? null : rttSec * 1000,
      availableOutgoingBitrate: pair ? num(pair["availableOutgoingBitrate"]) : null,
      packetLossRatio,
      outboundBitrate,
      framesPerSecond: outbound ? num(outbound["framesPerSecond"]) : null,
      frameWidth: outbound ? num(outbound["frameWidth"]) : null,
      frameHeight: outbound ? num(outbound["frameHeight"]) : null,
      encoderImplementation: outbound ? str(outbound["encoderImplementation"]) : null,
      jitterBufferDelayMs,
    };
  }
}

/** True when the connection is direct — the outcome this project is designed for. */
export function isDirect(h: LinkHealth): boolean {
  return h.candidateType !== "relay" && h.remoteCandidateType !== "relay";
}

/** Compact one-line summary for a tile label or console log. */
export function summarize(h: LinkHealth): string {
  const bits: string[] = [];
  bits.push(isDirect(h) ? `direct (${h.candidateType})` : "relayed (TURN)");
  if (h.rttMs !== null) bits.push(`${Math.round(h.rttMs)}ms rtt`);
  if (h.outboundBitrate !== null) bits.push(`${(h.outboundBitrate / 1e6).toFixed(1)} Mbps`);
  if (h.framesPerSecond !== null) bits.push(`${Math.round(h.framesPerSecond)}fps`);
  if (h.frameWidth !== null && h.frameHeight !== null) bits.push(`${h.frameWidth}x${h.frameHeight}`);
  if (h.packetLossRatio !== null && h.packetLossRatio > 0.001) {
    bits.push(`${(h.packetLossRatio * 100).toFixed(1)}% loss`);
  }
  return bits.join(" · ");
}

// ---- ICE candidate parsing ------------------------------------------------

export interface ParsedCandidate {
  type: string;
  address: string;
  port: number | null;
  protocol: string;
}

/**
 * Read type/address/port off an ICE candidate.
 *
 * Prefers the parsed RTCIceCandidate fields but falls back to the SDP text, because
 * older Chromium builds leave `.type`, `.address` and `.port` null even though the
 * candidate line itself is well-formed. Line shape:
 *   candidate:<foundation> <component> <proto> <priority> <addr> <port> typ <type> ...
 */
export function parseCandidate(c: RTCIceCandidate): ParsedCandidate | null {
  const raw = c.candidate;
  if (!raw) return null;
  const m = /candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)/i.exec(raw);
  const portText = m?.[3];
  return {
    type: c.type ?? m?.[4] ?? "unknown",
    address: c.address ?? m?.[2] ?? "",
    port: c.port ?? (portText !== undefined ? Number(portText) : null),
    protocol: c.protocol ?? m?.[1] ?? "",
  };
}
