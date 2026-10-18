/**
 * NAT mapping diagnostics.
 *
 * Gathering and rendering live here; the comparison itself is the pure
 * `classifyNatMapping()` in stats.ts. Chrome redacts a server-reflexive
 * candidate's base (`raddr 0.0.0.0 rport 0`) by default, so grouping by base is
 * usually impossible and the row is deliberately informational.
 */

import {
  normalizeAddress,
  parseCandidate,
  type HostSockets,
  type NatClassification,
  type ParsedCandidate,
} from "./stats";

/**
 * Whether a same-base port change is reported as symmetric NAT.
 *
 * Off until a controlled probe confirms Chrome emits multiple `srflx` candidates
 * for one base and that `getStats().url` shows both STUN servers were queried.
 * With the gate off, a `symmetric` classification is rendered as inconclusive.
 */
export const SYMMETRIC_DETECTION = false;

export type NatStatus = "pass" | "warn" | "info";

export interface NatRow {
  status: NatStatus;
  details: string;
}

export interface GatherResult {
  candidates: ParsedCandidate[];
  hostSockets: HostSockets;
}

interface StatsHost {
  address: string;
  port: number | null;
  protocol: string;
}

interface SocketKeys {
  v4: Set<string>;
  v6: Set<string>;
  unknown: Set<string>;
}

const EMPTY_KEYS = (): SocketKeys => ({ v4: new Set(), v6: new Set(), unknown: new Set() });

function addHostSocket(keys: SocketKeys, host: StatsHost): void {
  if (host.protocol && host.protocol.toLowerCase() !== "udp") return;
  const normalized = normalizeAddress(host.address);
  const address = normalized?.address ?? host.address.trim().toLowerCase();
  const key = `${address}|${host.port ?? ""}`;
  if (!normalized) keys.unknown.add(key);
  else if (normalized.family === "v4") keys.v4.add(key);
  else keys.v6.add(key);
}

function countSockets(events: SocketKeys, stats: SocketKeys): HostSockets {
  // Events and getStats() can disagree (and getStats() may see a socket the
  // gathering event never surfaced), so take the larger count per family.
  return {
    v4: Math.max(events.v4.size, stats.v4.size),
    v6: Math.max(events.v6.size, stats.v6.size),
    unknown: Math.max(events.unknown.size, stats.unknown.size),
  };
}

async function readStatsHosts(pc: RTCPeerConnection): Promise<StatsHost[]> {
  const report = await pc.getStats();
  const hosts: StatsHost[] = [];
  report.forEach((entry) => {
    const s = entry as unknown as Record<string, unknown>;
    if (String(s["type"]).toLowerCase() !== "local-candidate") return;
    if (String(s["candidateType"]).toLowerCase() !== "host") return;
    hosts.push({
      address: typeof s["address"] === "string" ? s["address"] : "",
      port: typeof s["port"] === "number" ? s["port"] : null,
      protocol: typeof s["protocol"] === "string" ? s["protocol"] : "",
    });
  });
  return hosts;
}

/**
 * Gather ICE candidates for a throwaway connection. Always resolves.
 *
 * `getStats()` must settle before `pc.close()`: closing first makes the host
 * socket snapshot empty and silently disables the single-socket inference.
 */
export async function gatherCandidates(
  config: RTCConfiguration,
  timeoutMs = 15000,
  createPc: (config: RTCConfiguration) => RTCPeerConnection = (c) => new RTCPeerConnection(c),
): Promise<GatherResult> {
  const pc = createPc(config);
  const found: ParsedCandidate[] = [];
  const eventKeys = EMPTY_KEYS();
  let statsHosts: StatsHost[] = [];

  try {
    // A data channel gives ICE a reason to gather; without media or data there is
    // nothing to negotiate and Chrome gathers nothing.
    pc.createDataChannel("probe");
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const c = parseCandidate(ev.candidate);
        if (!c) return;
        found.push(c);
        if (c.type.toLowerCase() === "host") {
          addHostSocket(eventKeys, { address: c.address, port: c.port, protocol: c.protocol });
        }
      };
    });

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await done;
    } catch {
      // Fall through with whatever was gathered.
    }
  } finally {
    statsHosts = await readStatsHosts(pc).catch(() => []);
    pc.onicecandidate = null;
    pc.close();
  }

  const statsKeys = EMPTY_KEYS();
  for (const host of statsHosts) addHostSocket(statsKeys, host);

  return { candidates: found, hostSockets: countSockets(eventKeys, statsKeys) };
}

function inconclusiveRow(result: NatClassification): NatRow {
  const paths = result.multiplePaths ? " Multiple local paths detected." : "";
  return {
    status: "info",
    details:
      `Not determinable: ${result.srflxCount} reflexive candidates, ` +
      `${result.unbasedCount} without usable base (\`raddr 0.0.0.0 rport 0\`).${paths} ` +
      "No TURN conclusion.",
  };
}

/**
 * The only verdict-to-text mapping. A `symmetric` verdict is reported as a
 * warning only when `SYMMETRIC_DETECTION` is enabled; otherwise it falls back to
 * the same informational copy as an inconclusive result.
 */
export function natRow(
  result: NatClassification,
  options: { symmetricDetection?: boolean } = {},
): NatRow {
  const detection = options.symmetricDetection ?? SYMMETRIC_DETECTION;

  if (result.verdict === "symmetric") {
    if (!detection) return inconclusiveRow(result);
    return {
      status: "warn",
      details:
        `Address/port-dependent mapping observed on ${result.base ?? "a local socket"}: ` +
        `${result.ports} external ports. TURN may be required.`,
    };
  }

  if (result.verdict === "no-evidence") {
    return {
      status: "pass",
      details:
        `No evidence of address-dependent mapping (${result.observations} same-base observations); ` +
        "one observation per base is not proof of endpoint-independent mapping.",
    };
  }

  if (result.verdict === "no-srflx") {
    return {
      status: "warn",
      details: "No server-reflexive candidates; NAT mapping was not tested. See the STUN row.",
    };
  }

  return inconclusiveRow(result);
}
