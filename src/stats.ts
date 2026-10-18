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

/** Candidate types that represent a genuine peer-to-peer path. */
const DIRECT_CANDIDATE_TYPES = ["host", "srflx", "prflx"];

/**
 * True when the connection is provably direct — the outcome this project exists for.
 *
 * Requires a positively direct candidate type rather than merely "not relay": both
 * fields fall back to the sentinel "unknown" before ICE nominates a pair, and
 * treating that as direct would render `direct (unknown)` and suppress the relay
 * warning on a connection that may well be relayed.
 */
export function isDirect(h: LinkHealth): boolean {
  return (
    DIRECT_CANDIDATE_TYPES.includes(h.candidateType) &&
    DIRECT_CANDIDATE_TYPES.includes(h.remoteCandidateType)
  );
}

/** True when the route is not yet known, as opposed to known-and-relayed. */
export function isRouteUnknown(h: LinkHealth): boolean {
  return h.candidateType === "unknown" || h.remoteCandidateType === "unknown";
}

/** Compact one-line summary for a tile label or console log. */
export function summarize(h: LinkHealth): string {
  const bits: string[] = [];
  bits.push(
    isRouteUnknown(h) ? "connecting…" : isDirect(h) ? `direct (${h.candidateType})` : "relayed (TURN)",
  );
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
  /**
   * The local socket behind a server-reflexive candidate, as reported by
   * `raddr`/`rport`. Chrome redacts both to `0.0.0.0`/`0` unless run with
   * `--disable-features=WebRtcHideLocalIpsWithMdns`.
   */
  relatedAddress: string | null;
  relatedPort: number | null;
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
  const m =
    /candidate:\S+\s+\d+\s+(\S+)\s+\d+\s+(\S+)\s+(\d+)\s+typ\s+(\S+)(?:\s+raddr\s+(\S+)\s+rport\s+(\d+))?/i.exec(raw);
  const portText = m?.[3];
  const relatedPortText = m?.[6];
  return {
    type: c.type ?? m?.[4] ?? "unknown",
    address: c.address ?? m?.[2] ?? "",
    port: c.port ?? (portText !== undefined ? Number(portText) : null),
    protocol: c.protocol ?? m?.[1] ?? "",
    relatedAddress:
      typeof c.relatedAddress === "string" ? c.relatedAddress : m?.[5] ?? null,
    relatedPort:
      typeof c.relatedPort === "number"
        ? c.relatedPort
        : relatedPortText !== undefined
          ? Number(relatedPortText)
          : null,
  };
}

// ---- NAT mapping ----------------------------------------------------------

export type IpFamily = "v4" | "v6";

export interface NormalizedAddress {
  /** Lowercase, canonical form: dotted-quad for IPv4, eight hextets for IPv6. */
  address: string;
  family: IpFamily;
}

/** Distinct UDP host sockets seen per family. `unknown` blocks inference. */
export interface HostSockets {
  v4: number;
  v6: number;
  unknown: number;
}

export type NatVerdict = "symmetric" | "no-evidence" | "inconclusive" | "no-srflx";

/**
 * What the gathered candidates actually prove about NAT mapping.
 *
 * `verdict` is deliberately not a UI status: `src/nat.ts` owns the gate and copy.
 * The counts are carried along so the renderer does not have to redo the grouping.
 */
export interface NatClassification {
  verdict: NatVerdict;
  /** Server-reflexive candidates considered (relays and hosts are ignored). */
  srflxCount: number;
  /** Candidates with no usable base after inference. */
  unbasedCount: number;
  /** Candidates that could be attributed to a base socket. */
  observations: number;
  /** Distinct base groups. */
  baseCount: number;
  /** Base whose external port changed, when the verdict is `symmetric`. */
  base: string | null;
  /** Distinct external ports on that base. */
  ports: number;
  /** Whether more than one local path (interface/family) is visible. */
  multiplePaths: boolean;
}

function ipv4Bytes(addr: string): [number, number, number, number] | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes as [number, number, number, number];
}

/** Eight hextets without leading zeros, or null if this is not an IPv6 literal. */
function ipv6Hextets(addr: string): string[] | null {
  let head = addr;
  if (head.includes(".")) {
    const colon = head.lastIndexOf(":");
    if (colon < 0) return null;
    const bytes = ipv4Bytes(head.slice(colon + 1));
    if (!bytes) return null;
    const hi = ((bytes[0] << 8) | bytes[1]).toString(16);
    const lo = ((bytes[2] << 8) | bytes[3]).toString(16);
    head = `${head.slice(0, colon + 1)}${hi}:${lo}`;
  }

  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [
    ...left,
    ...Array<string>(halves.length === 2 ? missing : 0).fill("0"),
    ...right,
  ];
  if (!all.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => h.replace(/^0+(?=.)/, ""));
}

/**
 * Canonicalize an address used as a NAT base.
 *
 * Returns null for anything that cannot identify a socket: unspecified addresses,
 * mDNS `.local` names, zones, and malformed input. IPv4-mapped IPv6 is the IPv4
 * address in disguise, so it normalizes to IPv4 rather than becoming a second base.
 */
export function normalizeAddress(raw: string | null | undefined): NormalizedAddress | null {
  if (typeof raw !== "string") return null;
  let addr = raw.trim().toLowerCase();
  if (!addr) return null;
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  if (!addr || addr.endsWith(".local") || addr.endsWith(".local.")) return null;

  if (!addr.includes(":")) {
    const bytes = ipv4Bytes(addr);
    if (!bytes) return null;
    if (bytes.every((b) => b === 0)) return null;
    return { address: bytes.join("."), family: "v4" };
  }

  const hextets = ipv6Hextets(addr);
  if (!hextets) return null;
  if (hextets.every((h) => h === "0")) return null;

  // ::ffff:a.b.c.d (including the fully expanded 0:0:0:0:0:ffff: form).
  if (hextets.slice(0, 5).every((h) => h === "0") && hextets[5] === "ffff") {
    const hi = parseInt(hextets[6] ?? "0", 16);
    const lo = parseInt(hextets[7] ?? "0", 16);
    const bytes = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
    if (bytes.every((b) => b === 0)) return null;
    return { address: bytes.join("."), family: "v4" };
  }

  return { address: hextets.join(":"), family: "v6" };
}

interface CandidateBase {
  key: string;
  label: string;
}

function explicitBase(c: ParsedCandidate): CandidateBase | null {
  const address = normalizeAddress(c.relatedAddress);
  if (!address) return null;
  const port = c.relatedPort;
  if (port === null || port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  const label = address.family === "v6" ? `[${address.address}]:${port}` : `${address.address}:${port}`;
  return { key: `${address.address}|${port}`, label };
}

function inferredBase(c: ParsedCandidate, hosts: HostSockets): CandidateBase | null {
  // A single visible socket of a literal family can stand in for an explicit
  // raddr/rport. Any `.local` entry is unknown and blocks inference everywhere.
  if (hosts.unknown > 0) return null;
  const external = normalizeAddress(c.address);
  if (!external) return null;
  const count = external.family === "v4" ? hosts.v4 : hosts.v6;
  if (count !== 1) return null;
  return {
    key: `host:${external.family}`,
    label: `the inferred ${external.family === "v4" ? "IPv4" : "IPv6"} host socket`,
  };
}

function externalAddress(c: ParsedCandidate): string {
  return normalizeAddress(c.address)?.address ?? c.address.trim().toLowerCase();
}

function usablePort(port: number | null): port is number {
  return port !== null && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Classify NAT mapping per local base socket.
 *
 * Symmetric NAT is keyed by the internal `(IP, port)`, so only candidates that
 * share a base are comparable. Different interfaces therefore get different
 * external ports behind an ordinary cone NAT and must not be pooled.
 *
 * The verdict follows this order: no srflx -> no-srflx; any candidate without a
 * base, any base whose external address changed, or any unreadable port ->
 * inconclusive; a same-base port change -> symmetric; otherwise no-evidence.
 * A single observation per base is never treated as proof of a cone NAT.
 */
export function classifyNatMapping(
  candidates: ParsedCandidate[],
  hostSockets: HostSockets,
): NatClassification {
  const srflx = candidates.filter((c) => c.type.toLowerCase() === "srflx");
  const multiplePaths = hostSockets.v4 + hostSockets.v6 + hostSockets.unknown > 1;

  if (srflx.length === 0) {
    return {
      verdict: "no-srflx",
      srflxCount: 0,
      unbasedCount: 0,
      observations: 0,
      baseCount: 0,
      base: null,
      ports: 0,
      multiplePaths,
    };
  }

  const explicit = srflx.map((c) => explicitBase(c));
  const hasExplicit = explicit.some((base) => base !== null);

  interface Group {
    base: CandidateBase;
    ports: Set<number>;
    addresses: Set<string>;
  }
  const groups = new Map<string, Group>();
  let unbasedCount = 0;
  let observations = 0;
  let unreadablePorts = 0;

  for (let i = 0; i < srflx.length; i++) {
    const candidate = srflx[i]!;
    // Mixed explicit/unbased is inconclusive: inference is all-or-nothing.
    const base = explicit[i] ?? (hasExplicit ? null : inferredBase(candidate, hostSockets));
    if (!base) {
      unbasedCount++;
      continue;
    }
    observations++;
    let group = groups.get(base.key);
    if (!group) {
      group = { base, ports: new Set<number>(), addresses: new Set<string>() };
      groups.set(base.key, group);
    }
    if (usablePort(candidate.port)) group.ports.add(candidate.port);
    else unreadablePorts++;
    const external = externalAddress(candidate);
    if (external) group.addresses.add(external);
  }

  let base: string | null = null;
  let ports = 0;
  for (const group of groups.values()) {
    if (group.ports.size > ports) {
      ports = group.ports.size;
      base = group.base.label;
    }
  }
  const multiAddress = [...groups.values()].some((g) => g.addresses.size > 1);

  return {
    verdict:
      unbasedCount > 0 || multiAddress || unreadablePorts > 0
        ? "inconclusive"
        : ports > 1
          ? "symmetric"
          : "no-evidence",
    srflxCount: srflx.length,
    unbasedCount,
    observations,
    baseCount: groups.size,
    base: ports > 1 ? base : null,
    ports: ports > 1 ? ports : 0,
    multiplePaths: multiplePaths || groups.size > 1,
  };
}
