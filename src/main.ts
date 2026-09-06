/**
 * App bootstrap: wires signalling -> mesh -> DOM tiles.
 *
 * Everything latency-critical lives in mesh.ts / quality.ts. This file is glue.
 */

import { MAX_ROOM_SIZE, isValidRoomCode, type PeerId, type PeerInfo } from "@shared/protocol";
import {
  captureScreen,
  onCaptureEnded,
  stopCapture,
  systemAudioSupport,
  QUALITY_PRESETS,
  DEFAULT_PRESET,
  type CaptureResult,
  type QualityPresetName,
} from "./capture";
import { Mesh } from "./mesh";
import { DEFAULT_CODEC, type CodecName } from "./quality";
import { SignalingClient } from "./signaling";
import { LinkMonitor, isDirect, summarize } from "./stats";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const ui = {
  roomInput: el<HTMLInputElement>("room-code"),
  joinBtn: el<HTMLButtonElement>("join"),
  createBtn: el<HTMLButtonElement>("create"),
  shareBtn: el<HTMLButtonElement>("share"),
  stage: el<HTMLDivElement>("stage"),
  status: el<HTMLElement>("status"),
  preset: el<HTMLSelectElement>("preset"),
  codec: el<HTMLSelectElement>("codec"),
};

let client: SignalingClient | null = null;
let mesh: Mesh | null = null;
let capture: CaptureResult | null = null;
let stopCaptureListener: (() => void) | null = null;

const names = new Map<PeerId, string>();
const tiles = new Map<PeerId, HTMLVideoElement>();
const healthEls = new Map<PeerId, HTMLElement>();
const monitors = new Map<PeerId, LinkMonitor>();
let healthTimer: ReturnType<typeof setInterval> | null = null;

function setStatus(text: string, kind: "info" | "warn" | "error" = "info"): void {
  ui.status.textContent = text;
  ui.status.dataset["kind"] = kind;
}

async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await fetch("/api/ice", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { iceServers?: RTCIceServer[] };
    return body.iceServers ?? [];
  } catch (err) {
    // A missing TURN config must not stop the app: direct P2P is the common path
    // and doesn't need TURN at all.
    console.warn("[main] /api/ice failed, continuing with public STUN only", err);
    return [{ urls: "stun:stun.cloudflare.com:3478" }];
  }
}

// ---- tiles ---------------------------------------------------------------

function tileFor(peerId: PeerId): HTMLVideoElement {
  const existing = tiles.get(peerId);
  if (existing) return existing;

  const wrap = document.createElement("div");
  wrap.className = "tile";
  wrap.dataset["peer"] = peerId;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  // Remote audio must NOT be muted (it's the game audio); our own preview must be,
  // or the sharer hears themselves.
  video.muted = false;

  const label = document.createElement("span");
  label.className = "tile-label";
  label.textContent = names.get(peerId) ?? peerId.slice(0, 6);

  const health = document.createElement("span");
  health.className = "tile-health";
  healthEls.set(peerId, health);

  wrap.append(video, label, health);
  ui.stage.append(wrap);
  tiles.set(peerId, video);

  // Send-side pausing: tell the sharer to stop encoding for us when their tile
  // isn't on screen. This is the biggest bandwidth lever in a multi-sharer room.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) mesh?.setViewing(peerId, e.isIntersecting);
    },
    { threshold: 0.1 },
  );
  io.observe(wrap);

  return video;
}

function removeTile(peerId: PeerId): void {
  const video = tiles.get(peerId);
  if (!video) return;
  video.srcObject = null;
  video.closest(".tile")?.remove();
  tiles.delete(peerId);
  healthEls.delete(peerId);
  monitors.delete(peerId);
}

/**
 * Surface per-peer link health on each tile. The point is to make a relayed
 * connection visible: it still works, but it means TURN is in the path instead of
 * a direct peer-to-peer route, and that is worth knowing without opening
 * chrome://webrtc-internals.
 */
function startHealthPolling(): void {
  stopHealthPolling();
  healthTimer = setInterval(() => {
    if (!mesh) return;
    for (const peerId of mesh.peers()) {
      const pc = mesh.getConnection(peerId);
      const target = healthEls.get(peerId);
      if (!pc || !target) continue;
      let monitor = monitors.get(peerId);
      if (!monitor) {
        monitor = new LinkMonitor(pc);
        monitors.set(peerId, monitor);
      }
      void monitor.read().then((health) => {
        if (!health) return;
        target.textContent = summarize(health);
        target.dataset["direct"] = String(isDirect(health));
      });
    }
  }, 2000);
}

function stopHealthPolling(): void {
  if (healthTimer !== null) clearInterval(healthTimer);
  healthTimer = null;
}

function renderSelfPreview(stream: MediaStream | null): void {
  const id = "__self";
  if (!stream) {
    removeTile(id);
    return;
  }
  names.set(id, "You");
  const v = tileFor(id);
  v.muted = true; // never monitor your own audio
  v.srcObject = stream;
}

// ---- sharing -------------------------------------------------------------

function currentPreset(): QualityPresetName {
  const stored = localStorage.getItem("preset");
  return stored && stored in QUALITY_PRESETS ? (stored as QualityPresetName) : DEFAULT_PRESET;
}

function currentCodec(): CodecName {
  return (localStorage.getItem("codec") as CodecName | null) ?? DEFAULT_CODEC;
}

/**
 * Screen capture requires a secure context. localhost counts; a bare LAN IP over
 * plain HTTP does not, and Chrome then leaves navigator.mediaDevices undefined
 * entirely. Without this check the capture call throws and gets swallowed as a
 * cancelled picker, so the Share button just does nothing with no explanation.
 */
function captureBlockedReason(): string | null {
  if (typeof navigator.mediaDevices?.getDisplayMedia === "function") return null;
  if (!window.isSecureContext) {
    return (
      `Screen sharing is blocked because ${location.origin} is not a secure context. ` +
      "Open chrome://flags/#unsafely-treat-insecure-origin-as-secure, add this exact " +
      "address, set it to Enabled, and restart Chrome. (Or reach this page over HTTPS.)"
    );
  }
  return "This browser does not support getDisplayMedia. Chrome or Edge on desktop is required.";
}

async function startSharing(): Promise<void> {
  if (!mesh || capture) return;

  const blocked = captureBlockedReason();
  if (blocked) {
    setStatus(blocked, "error");
    return;
  }

  const audio = systemAudioSupport();
  if (!audio.supported && audio.reason) setStatus(audio.reason, "warn");

  try {
    capture = await captureScreen(QUALITY_PRESETS[currentPreset()], true);
  } catch (err) {
    // Includes the user simply cancelling the picker, which isn't an error.
    console.warn("[main] capture cancelled or failed", err);
    return;
  }

  stopCaptureListener = onCaptureEnded(capture, () => void stopSharing());
  renderSelfPreview(capture.stream);
  await mesh.setCapture(capture);
  client?.setSharing(true);
  ui.shareBtn.textContent = "Stop sharing";
}

async function stopSharing(): Promise<void> {
  if (!capture) return;
  stopCaptureListener?.();
  stopCaptureListener = null;
  await mesh?.setCapture(null);
  stopCapture(capture);
  capture = null;
  renderSelfPreview(null);
  client?.setSharing(false);
  ui.shareBtn.textContent = "Share screen";
}

// ---- room ----------------------------------------------------------------

async function joinRoom(code: string): Promise<void> {
  if (!isValidRoomCode(code)) {
    setStatus("That doesn't look like a valid room code.", "error");
    return;
  }

  leaveRoom();
  const iceServers = await fetchIceServers();
  const displayName = localStorage.getItem("name") ?? `guest-${Math.random().toString(36).slice(2, 6)}`;
  localStorage.setItem("name", displayName);

  client = new SignalingClient(code, displayName, {
    onStatus: (s) => setStatus(s === "open" ? `In room ${code}` : `Connection ${s}…`),

    onWelcome: (selfId, peers) => {
      // The signalling socket reconnects on any network blip, and the server issues
      // a fresh peer id each time, so onWelcome fires again. Without closing the old
      // Mesh its RTCPeerConnections stay open and keep encoding and uploading to
      // peers that have already replaced us — a silent bandwidth leak that compounds
      // with every reconnect.
      mesh?.close();
      monitors.clear();
      mesh = new Mesh(
        selfId,
        {
          iceServers,
          preset: QUALITY_PRESETS[currentPreset()],
          codec: currentCodec(),
          jitterBufferTargetMs: 0,
        },
        (to, data) => client?.signal(to, data),
        {
          onRemoteStream: (peerId, stream) => {
            tileFor(peerId).srcObject = stream;
          },
          onRemoteStreamGone: (peerId) => removeTile(peerId),
          onConnectionState: (peerId, state) => {
            if (state === "failed") {
              console.warn(`[main] connection to ${peerId} failed`);
            }
          },
        },
      );
      for (const p of peers) {
        names.set(p.id, p.name);
        mesh.addPeer(p.id);
      }
      setStatus(`In room ${code} — ${peers.length + 1}/${MAX_ROOM_SIZE} connected`);
      if (capture) void mesh.setCapture(capture);
      startHealthPolling();
    },

    onPeerJoined: (peer: PeerInfo) => {
      names.set(peer.id, peer.name);
      mesh?.addPeer(peer.id);
    },
    onPeerLeft: (id) => {
      mesh?.removePeer(id);
      names.delete(id);
      removeTile(id);
    },
    onSignal: (from, data) => void mesh?.handleSignal(from, data),
    onPeerState: (id, sharing) => {
      if (!sharing) removeTile(id);
    },
    onError: (code, message) => setStatus(`${code}: ${message}`, "error"),
  });

  client.connect();
  location.hash = code;
}

function leaveRoom(): void {
  stopHealthPolling();
  client?.close();
  client = null;
  mesh?.close();
  mesh = null;
  monitors.clear();
  for (const id of [...tiles.keys()]) removeTile(id);
  names.clear();
}

// ---- quality controls ----------------------------------------------------

const CODEC_LABELS: Record<CodecName, string> = {
  h264: "H.264 (hardware, best for gaming)",
  vp9: "VP9 (better quality, more CPU)",
  av1: "AV1 (best quality, needs modern GPU)",
  vp8: "VP8 (compatibility fallback)",
};

function initQualityControls(): void {
  for (const [name, preset] of Object.entries(QUALITY_PRESETS)) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = `${preset.label} · ${(preset.maxBitrate / 1e6).toFixed(0)} Mbps`;
    ui.preset.append(opt);
  }
  ui.preset.value = currentPreset();

  for (const [name, label] of Object.entries(CODEC_LABELS)) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = label;
    ui.codec.append(opt);
  }
  ui.codec.value = currentCodec();

  // Bitrate and framerate are encoder parameters, so they can be re-applied on a
  // live sender with no renegotiation.
  ui.preset.addEventListener("change", () => {
    const name = ui.preset.value as QualityPresetName;
    if (!(name in QUALITY_PRESETS)) return;
    localStorage.setItem("preset", name);
    void mesh?.setPreset(QUALITY_PRESETS[name]);
  });

  // Codec choice only takes effect through setCodecPreferences on the next offer,
  // so it cannot be changed mid-stream without renegotiating.
  ui.codec.addEventListener("change", () => {
    localStorage.setItem("codec", ui.codec.value);
    if (capture) setStatus("Codec applies the next time you start sharing.", "warn");
  });
}

initQualityControls();

// Warn on load rather than only on click — a disabled-looking Share button with no
// explanation is the worst version of this.
{
  const blocked = captureBlockedReason();
  if (blocked) {
    setStatus(blocked, "error");
    ui.shareBtn.title = blocked;
  }
}

// ---- wiring --------------------------------------------------------------

ui.joinBtn.addEventListener("click", () => void joinRoom(ui.roomInput.value.trim().toUpperCase()));

ui.createBtn.addEventListener("click", () => {
  void (async () => {
    const res = await fetch("/api/room");
    const { code } = (await res.json()) as { code: string };
    ui.roomInput.value = code;
    await joinRoom(code);
  })();
});

ui.shareBtn.addEventListener("click", () => {
  void (capture ? stopSharing() : startSharing());
});

window.addEventListener("beforeunload", () => leaveRoom());

// Deep link: /#ROOMCODE joins straight away.
const fromHash = location.hash.replace(/^#/, "").toUpperCase();
if (fromHash) {
  ui.roomInput.value = fromHash;
  void joinRoom(fromHash);
}
