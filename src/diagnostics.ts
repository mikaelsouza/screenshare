/**
 * Connection diagnostics.
 *
 * Answers one question with facts instead of guesswork: will this browser, on this
 * network, hold a direct peer-to-peer connection? Roughly 10% of users sit behind
 * CGNAT or a symmetric NAT that forces a TURN relay, and when that happens the
 * symptom is just "their stream feels worse" — indistinguishable from a slow PC.
 * This page names the cause.
 */

import { PING, PONG, type ServerMessage } from "@shared/protocol";
import { systemAudioSupport, windowAudioSupport } from "./capture";
import { type ParsedCandidate as Cand, parseCandidate } from "./stats";

type Status = "pass" | "warn" | "fail" | "running";

const results = document.getElementById("results") as HTMLTableSectionElement | null;
const runBtn = document.getElementById("run-btn") as HTMLButtonElement | null;

const STATUS_STYLE: Record<Exclude<Status, "running">, { icon: string; color: string }> = {
  pass: { icon: "PASS", color: "#4ade80" },
  warn: { icon: "WARN", color: "#fbbf24" },
  fail: { icon: "FAIL", color: "#f87171" },
};

function addRow(test: string, status: Status, details: string): (s: Status, d: string) => void {
  if (!results) return () => {};
  const tr = document.createElement("tr");
  const tdTest = document.createElement("td");
  const tdStatus = document.createElement("td");
  const tdDetails = document.createElement("td");
  tdTest.textContent = test;
  tr.append(tdTest, tdStatus, tdDetails);
  results.append(tr);

  const update = (s: Status, d: string): void => {
    if (s === "running") {
      tdStatus.textContent = "…";
      tdStatus.style.color = "#8e8e99";
    } else {
      const style = STATUS_STYLE[s];
      tdStatus.textContent = style.icon;
      tdStatus.style.color = style.color;
      tdStatus.style.fontWeight = "600";
    }
    tdDetails.textContent = d;
  };
  update(status, details);
  return update;
}

// ---- ICE candidate gathering ---------------------------------------------

/** Gather ICE candidates for a throwaway connection. Always resolves. */
async function gather(config: RTCConfiguration, timeoutMs = 15000): Promise<Cand[]> {
  const pc = new RTCPeerConnection(config);
  const found: Cand[] = [];
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
        if (c) found.push(c);
      };
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await done;
  } catch {
    // Fall through with whatever was gathered.
  } finally {
    pc.onicecandidate = null;
    pc.close();
  }
  return found;
}

// Three distinct STUN endpoints. Distinctness is the point: a symmetric NAT assigns
// a different external port per destination, so identical ports across all three
// means endpoint-independent mapping (hole punching will work) and differing ports
// mean symmetric NAT (it won't, and TURN will be required).
// Deliberately no :53 endpoint here. UDP/53 is widely intercepted for DNS, and a
// black-holing STUN server does not merely get skipped — measured on a real network,
// including stun.cloudflare.com:53 produced srflx=0 across the whole gathering, so
// this check reported "UDP to STUN is blocked" on a connection where STUN worked fine.
// Two distinct hosts are still enough for the symmetric-NAT comparison below.
// Google's server is the second one, so this page (and only this page) shows Google
// your IP address; the page says so. The app itself only ever uses Cloudflare's.
const STUN_PROBES: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

// ---- individual checks ----------------------------------------------------

function checkBrowser(): void {
  const ua = navigator.userAgent;
  const isChromium = /Chrome|Chromium|Edg/i.test(ua);
  const hasDisplayMedia = typeof navigator.mediaDevices?.getDisplayMedia === "function";

  if (!hasDisplayMedia) {
    addRow("Browser", "fail", "getDisplayMedia is unavailable. Screen sharing cannot work here.");
  } else if (!isChromium) {
    addRow("Browser", "warn", "Not Chrome/Edge. Video should work; system audio capture will not.");
  } else {
    addRow("Browser", "pass", "Chromium-based with getDisplayMedia support.");
  }

  if (!window.isSecureContext) {
    addRow("Secure context", "fail", "Page is not in a secure context; getDisplayMedia is blocked. Use HTTPS.");
  } else {
    addRow("Secure context", "pass", "HTTPS or localhost.");
  }

  const audio = systemAudioSupport();
  addRow(
    "System audio",
    audio.supported ? "pass" : "warn",
    audio.reason ?? "System/game audio capture is available.",
  );

  // Only worth a row of its own when system audio works at all; otherwise it would
  // repeat the reason above.
  if (audio.supported) {
    const game = windowAudioSupport();
    addRow(
      "Game-only audio",
      game.supported ? "pass" : "warn",
      game.reason ??
        "This browser can be asked for just one window's audio. Whether it honours that is up to " +
          "Chrome and Windows; the app falls back to offering all system audio if not.",
    );
  }
}

/**
 * Fetch ICE servers the way the app does: open a real room WebSocket and read them
 * off the welcome. There is no public /api/ice to query — credentials are authorised
 * by holding a joined socket — so this also exercises the genuine path end to end.
 */
async function fetchIceViaRoom(timeoutMs = 10_000): Promise<RTCIceServer[]> {
  const res = await fetch("/api/room");
  if (!res.ok) throw new Error(`/api/room returned HTTP ${res.status}`);
  const { code } = (await res.json()) as { code: string };

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/${code}`);

  try {
    return await new Promise<RTCIceServer[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for welcome")), timeoutMs);
      // `diagnostics` asks for a five-minute credential and leaves the room unclaimed,
      // rather than creating a real room with a two-hour one on every run.
      ws.onopen = () =>
        ws.send(JSON.stringify({ t: "join", room: code, displayName: "diagnostics", diagnostics: true }));
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("signalling socket failed"));
      };
      ws.onmessage = (ev) => {
        const raw = String(ev.data);
        if (raw === PONG || raw === PING) return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(raw) as ServerMessage;
        } catch {
          return;
        }
        if (msg.t === "welcome") {
          clearTimeout(timer);
          resolve(msg.iceServers as RTCIceServer[]);
        } else if (msg.t === "error") {
          clearTimeout(timer);
          reject(new Error(`${msg.code}: ${msg.message}`));
        }
      };
    });
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}

async function checkIceConfig(): Promise<RTCIceServer[]> {
  const row = addRow("TURN credentials", "running", "Joining a temporary room to request them…");
  try {
    const servers = await fetchIceViaRoom();
    const hasTurn = servers.some((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.some((u) => typeof u === "string" && u.startsWith("turn"));
    });
    row(
      hasTurn ? "pass" : "warn",
      hasTurn
        ? `${servers.length} ICE server entries, including TURN relay credentials.`
        : "STUN only — no TURN credentials configured. Peers behind symmetric NAT or CGNAT will fail to connect.",
    );
    return servers;
  } catch (err) {
    row("warn", `Could not obtain ICE servers (${String(err)}). Falling back to public STUN.`);
    return STUN_PROBES;
  }
}

async function checkStun(): Promise<Cand[]> {
  const row = addRow("STUN / public address", "running", "Gathering candidates…");
  const cands = await gather({ iceServers: STUN_PROBES });
  const srflx = cands.filter((c) => c.type === "srflx");
  const host = cands.filter((c) => c.type === "host");

  if (srflx.length === 0) {
    row(
      "fail",
      host.length > 0
        ? "No server-reflexive candidate. UDP to STUN is likely blocked by a firewall; TURN over TCP/443 will be required."
        : "No candidates at all. WebRTC appears to be blocked entirely.",
    );
    return cands;
  }
  const addrs = [...new Set(srflx.map((c) => c.address).filter(Boolean))];
  row("pass", `Reachable. Public address seen as ${addrs.join(", ") || "(hidden)"}.`);
  return cands;
}

function checkNatMapping(cands: Cand[]): void {
  const row = addRow("NAT mapping", "running", "");
  const ports = [...new Set(cands.filter((c) => c.type === "srflx" && c.port !== null).map((c) => c.port))];

  if (ports.length === 0) {
    row("warn", "Could not determine — no reflexive candidates to compare.");
    return;
  }
  if (ports.length === 1) {
    row(
      "pass",
      "Endpoint-independent (cone) NAT: the same external port was used for every STUN server. " +
        "UDP hole punching will work, so connections should be direct.",
    );
    return;
  }
  row(
    "warn",
    `Address/port-dependent (symmetric) NAT: ${ports.length} different external ports were allocated. ` +
      "Hole punching will fail against another symmetric NAT, so a TURN relay will often be needed. " +
      "This is typical of CGNAT and corporate firewalls.",
  );
}

async function checkTurn(iceServers: RTCIceServer[]): Promise<void> {
  const turnOnly = iceServers.filter((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => typeof u === "string" && u.startsWith("turn"));
  });
  const row = addRow("TURN relay", "running", "Allocating a relay candidate…");
  if (turnOnly.length === 0) {
    row("warn", "Skipped — no TURN servers configured.");
    return;
  }

  // iceTransportPolicy "relay" discards host and reflexive candidates, so anything
  // gathered here proves the TURN allocation itself succeeded.
  const cands = await gather({ iceServers: turnOnly, iceTransportPolicy: "relay" });
  const relay = cands.filter((c) => c.type === "relay");
  if (relay.length === 0) {
    row("fail", "No relay candidate allocated. TURN credentials may be invalid or expired.");
    return;
  }
  const protos = [...new Set(relay.map((c) => c.protocol).filter(Boolean))];
  row("pass", `Relay allocated over ${protos.join(", ") || "udp"}. Fallback path is available.`);
}

async function checkLoopback(): Promise<void> {
  const row = addRow("WebRTC loopback", "running", "Connecting two local peers…");
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  try {
    // Candidates start arriving as soon as setLocalDescription runs — before the
    // peer has a remote description. Feeding them straight in makes addIceCandidate
    // reject with InvalidStateError, drops the candidate, and (being `void`ed)
    // surfaces as an unhandled rejection. Buffer until the remote description is set.
    const queues = new Map<RTCPeerConnection, RTCIceCandidate[]>([[a, []], [b, []]]);
    const deliver = (target: RTCPeerConnection, cand: RTCIceCandidate): void => {
      if (!target.remoteDescription) {
        queues.get(target)?.push(cand);
        return;
      }
      void target.addIceCandidate(cand).catch(() => {});
    };
    const drain = (target: RTCPeerConnection): void => {
      const queued = queues.get(target);
      if (!queued) return;
      for (const c of queued.splice(0)) void target.addIceCandidate(c).catch(() => {});
    };

    a.onicecandidate = (e) => { if (e.candidate) deliver(b, e.candidate); };
    b.onicecandidate = (e) => { if (e.candidate) deliver(a, e.candidate); };

    const ch = a.createDataChannel("loopback");
    const opened = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      ch.onopen = () => { clearTimeout(timer); resolve(true); };
    });

    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    drain(b);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    drain(a);

    const ok = await opened;
    row(
      ok ? "pass" : "fail",
      ok
        ? "Local peer connection established. The WebRTC stack is functional."
        : "Data channel never opened. WebRTC may be disabled by policy or an extension.",
    );
  } catch (err) {
    row("fail", `Loopback failed: ${String(err)}`);
  } finally {
    a.close();
    b.close();
  }
}

// ---- runner ---------------------------------------------------------------

async function runAll(): Promise<void> {
  if (!results || !runBtn) return;
  runBtn.disabled = true;
  runBtn.textContent = "Running…";
  results.replaceChildren();

  try {
    checkBrowser();
    await checkLoopback();
    const iceServers = await checkIceConfig();
    const cands = await checkStun();
    checkNatMapping(cands);
    await checkTurn(iceServers);
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = "Run test";
  }
}

runBtn?.addEventListener("click", () => void runAll());
