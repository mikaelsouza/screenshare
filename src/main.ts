/**
 * App bootstrap: wires signalling -> mesh -> DOM tiles.
 *
 * Everything latency-critical lives in mesh.ts / quality.ts. This file is glue.
 */

import { hasTurnServer } from "@shared/ice";
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
  passInput: el<HTMLInputElement>("room-pass"),
  relayOnly: el<HTMLInputElement>("relay-only"),
  joinBtn: el<HTMLButtonElement>("join"),
  createBtn: el<HTMLButtonElement>("create"),
  shareBtn: el<HTMLButtonElement>("share"),
  muteAudioBtn: el<HTMLButtonElement>("mute-audio"),
  stage: el<HTMLDivElement>("stage"),
  status: el<HTMLElement>("status"),
  preset: el<HTMLSelectElement>("preset"),
  codec: el<HTMLSelectElement>("codec"),
};

let client: SignalingClient | null = null;
let mesh: Mesh | null = null;
/** Room code whose join was rejected for a bad/missing password, awaiting a retry. */
let pendingPasswordCode: string | null = null;
let capture: CaptureResult | null = null;
let stopCaptureListener: (() => void) | null = null;

const names = new Map<PeerId, string>();
const tiles = new Map<PeerId, HTMLVideoElement>();
const healthEls = new Map<PeerId, HTMLElement>();
const monitors = new Map<PeerId, LinkMonitor>();
const observers = new Map<PeerId, IntersectionObserver>();
const unmutePrompts = new Map<PeerId, HTMLElement>();
let healthTimer: ReturnType<typeof setInterval> | null = null;

function setStatus(text: string, kind: "info" | "warn" | "error" = "info"): void {
  ui.status.textContent = text;
  ui.status.dataset["kind"] = kind;
}

/**
 * STUN-only fallback. Enough for the direct peer-to-peer path, which is the common
 * case; only the relay fallback needs the credentials the server mints.
 */
const FALLBACK_ICE: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];


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
  // Ignore callbacks for a tile we have already torn down: removal itself queues an
  // intersection change, and acting on it would tell a peer to pause a sender that a
  // freshly-created tile has just asked to resume.
  const io = new IntersectionObserver(
    (entries) => {
      if (observers.get(peerId) !== io) return;
      for (const e of entries) mesh?.setViewing(peerId, e.isIntersecting);
    },
    { threshold: 0.1 },
  );
  io.observe(wrap);
  observers.set(peerId, io);

  return video;
}

/**
 * Start playback explicitly instead of relying on the `autoplay` attribute.
 *
 * Confirmed against the live deployment: opening a shared /#ROOMCODE link with no
 * prior user gesture gets unmuted play() rejected by Chrome's autoplay policy, so
 * the attribute alone yields a silently black tile. Retrying muted always succeeds,
 * and the viewer is offered an explicit click to restore audio.
 *
 * The prompt is its own overlay rather than text in the health badge, because the
 * stats poller rewrites that badge every two seconds and would erase it.
 */
function startPlayback(video: HTMLVideoElement, peerId: PeerId): void {
  void video.play().catch(() => {
    video.muted = true;
    void video.play().then(
      () => showUnmutePrompt(video, peerId),
      () => setStatus("The browser blocked video playback. Click the tile to start it.", "warn"),
    );
  });
}

/** Click-to-unmute affordance shown when the autoplay policy forced muted playback. */
function showUnmutePrompt(video: HTMLVideoElement, peerId: PeerId): void {
  const wrap = video.closest(".tile");
  if (!wrap || wrap.querySelector(".tile-unmute")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tile-unmute";
  btn.textContent = "Click to unmute";
  btn.addEventListener("click", () => {
    video.muted = false;
    void video.play().catch(() => {});
    btn.remove();
  });
  wrap.append(btn);
  unmutePrompts.set(peerId, btn);
}

function removeTile(peerId: PeerId): void {
  const video = tiles.get(peerId);
  if (!video) return;
  // Disconnect before removing: an observer left attached to a detached subtree
  // leaks both the observer and the <video> with its former srcObject, and keeps
  // firing stale callbacks.
  observers.get(peerId)?.disconnect();
  observers.delete(peerId);
  unmutePrompts.get(peerId)?.remove();
  unmutePrompts.delete(peerId);
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
  // Muted playback is always permitted by the autoplay policy, but call play()
  // explicitly so the preview does not depend on the attribute alone.
  void v.play().catch(() => {});
}

// ---- sharing -------------------------------------------------------------

function currentPreset(): QualityPresetName {
  const stored = localStorage.getItem("preset");
  return stored && stored in QUALITY_PRESETS ? (stored as QualityPresetName) : DEFAULT_PRESET;
}

const CODEC_NAMES = ["h264", "vp9", "av1", "vp8"] as const;

function isCodecName(v: string | null): v is CodecName {
  return v !== null && (CODEC_NAMES as readonly string[]).includes(v);
}

function currentCodec(): CodecName {
  // Unlike the preset, this used to be an unchecked cast. A stale or hand-edited
  // value reached preferCodec, where the CODEC_MIME lookup returned undefined and
  // threw mid-share — leaving the screen captured but no peer ever told.
  const stored = localStorage.getItem("codec");
  return isCodecName(stored) ? stored : DEFAULT_CODEC;
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

/** Set for the whole of startSharing, including the await on the OS picker. */
let sharingPending = false;

async function startSharing(): Promise<void> {
  // `capture` is only assigned after getDisplayMedia resolves, which can take
  // seconds while the picker is open. Guarding on it alone lets a second click
  // open a second picker and orphan the first MediaStream, leaving Chrome's
  // "sharing your screen" bar attached to a stream nothing references.
  if (!mesh || capture || sharingPending) return;
  sharingPending = true;

  try {
    await startSharingInner();
  } finally {
    sharingPending = false;
  }
}

async function startSharingInner(): Promise<void> {
  if (!mesh) return;

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

  try {
    await mesh.setCapture(capture);
  } catch (err) {
    // Never leave the screen captured but no peer told: tear the whole thing down
    // so the UI and the browser's sharing indicator agree with reality.
    console.error("[main] failed to attach capture to peers", err);
    setStatus("Could not start sharing to peers. Screen capture stopped.", "error");
    await stopSharing();
    return;
  }

  client?.setSharing(true);
  ui.shareBtn.textContent = "Stop sharing";
  if (capture.audio) {
    ui.muteAudioBtn.style.display = "inline-block";
    ui.muteAudioBtn.textContent = "Mute audio";
  }
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
  ui.muteAudioBtn.style.display = "none";
}

// ---- room ----------------------------------------------------------------

/** Incremented per join so a superseded in-flight join can detect it lost the race. */
let joinGeneration = 0;

async function joinRoom(code: string, password?: string): Promise<void> {
  if (!isValidRoomCode(code)) {
    setStatus("That doesn't look like a valid room code.", "error");
    return;
  }

  const codeToJoin = code;
  const generation = ++joinGeneration;
  leaveRoom();
  if (generation !== joinGeneration) return;
  const displayName = localStorage.getItem("name") ?? `guest-${Math.random().toString(36).slice(2, 6)}`;
  localStorage.setItem("name", displayName);

  client = new SignalingClient(
    code,
    displayName,
    {
      onStatus: (s) =>
        setStatus(
          s === "open"
            ? `In room ${code}${ui.relayOnly.checked ? " (Privacy Mode)" : ""}`
            : `Connection ${s}…`,
        ),

      onWelcome: (selfId, peers, iceServers) => {
        // The signalling socket reconnects on any network blip, and the server issues
        // a fresh peer id each time, so onWelcome fires again. Without closing the old
        // Mesh its RTCPeerConnections stay open and keep encoding and uploading to
        // peers that have already replaced us — a silent bandwidth leak that compounds
        // with every reconnect.
        mesh?.close();
        monitors.clear();

        // Minted by the Durable Object and delivered with the welcome, so holding a
        // joined WebSocket is what authorises them.
        const servers: RTCIceServer[] = iceServers.length > 0 ? iceServers : FALLBACK_ICE;

        // Fall back to a normal connection rather than a broken one. Privacy mode is a
        // preference; silently connecting nobody is not a way to honour it.
        let relayOnly = ui.relayOnly.checked;
        const relayUnavailable = relayOnly && !hasTurnServer(servers);
        if (relayUnavailable) relayOnly = false;

        mesh = new Mesh(
          selfId,
          {
            iceServers: servers,
            preset: QUALITY_PRESETS[currentPreset()],
            codec: currentCodec(),
            jitterBufferTargetMs: 0,
            relayOnly,
          },
          (to, data) => client?.signal(to, data),
          {
            onRemoteStream: (peerId, stream) => {
              const video = tileFor(peerId);
              video.srcObject = stream;
              startPlayback(video, peerId);
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
        if (relayUnavailable) {
          setStatus(
            `In room ${code} — ${peers.length + 1}/${MAX_ROOM_SIZE} connected. Privacy mode is OFF: no TURN relay is configured here, and relay-only would have connected to nobody.`,
            "warn",
          );
        } else {
          setStatus(
            `In room ${code}${relayOnly ? " (Privacy Mode)" : ""} — ${peers.length + 1}/${MAX_ROOM_SIZE} connected`,
          );
        }
        pendingPasswordCode = null;
        if (capture) void mesh.setCapture(capture);
        startHealthPolling();
      },

      onPeerJoined: (peer: PeerInfo) => {
        names.set(peer.id, peer.name);
        mesh?.addPeer(peer.id);
        setStatus(`${peer.name} joined room ${code}`, "info");
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
      onError: (code, message) => {
        // A wrong password is the one error the user can actually fix from here, so
        // say so in plain language and put the cursor where the fix goes. The socket
        // is closed with 1008 and will not retry by itself, but joinRoom() builds a
        // fresh SignalingClient, so pressing Join (or Enter) genuinely retries.
        if (code === "bad-password") {
          pendingPasswordCode = codeToJoin;
          setStatus(`Room ${codeToJoin} needs a password. Enter it and press Join.`, "warn");
          ui.passInput.value = "";
          ui.passInput.focus();
          return;
        }
        setStatus(`${code}: ${message}`, "error");
      },
    },
    password,
  );

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
  ui.muteAudioBtn.style.display = "none";
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
  // Privacy toggle (Relay only)
  ui.relayOnly.checked = localStorage.getItem("relay_only") === "true";
  ui.relayOnly.addEventListener("change", () => {
    localStorage.setItem("relay_only", String(ui.relayOnly.checked));
    if (mesh) {
      setStatus("Privacy mode change will apply on next room connection.", "info");
    }
  });

  // Mute audio button for active sharer
  ui.muteAudioBtn.addEventListener("click", () => {
    if (capture?.audio) {
      capture.audio.enabled = !capture.audio.enabled;
      ui.muteAudioBtn.textContent = capture.audio.enabled ? "Mute audio" : "Unmute audio";
      setStatus(capture.audio.enabled ? "Game audio live" : "Game audio muted", "info");
    }
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

ui.joinBtn.addEventListener("click", () =>
  void joinRoom(ui.roomInput.value.trim().toUpperCase(), ui.passInput.value.trim() || undefined),
);

// Typing a password and pressing Enter is the natural retry after a bad-password
// rejection; without this the user has to notice the Join button to get back in.
for (const input of [ui.roomInput, ui.passInput]) {
  input.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const code = (pendingPasswordCode ?? ui.roomInput.value).trim().toUpperCase();
    void joinRoom(code, ui.passInput.value.trim() || undefined);
  });
}

ui.createBtn.addEventListener("click", () => {
  void (async () => {
    // Without the ok check a 500 or an HTML error page throws inside this voided
    // IIFE, so the button looks completely inert with the stale status still shown.
    try {
      const res = await fetch("/api/room");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { code } = (await res.json()) as { code: string };
      if (!isValidRoomCode(code)) throw new Error(`server returned an invalid code: ${code}`);
      ui.roomInput.value = code;
      await joinRoom(code, ui.passInput.value.trim() || undefined);
    } catch (err) {
      console.error("[main] could not create a room", err);
      setStatus("Could not create a room. Check your connection and try again.", "error");
    }
  })();
});

ui.shareBtn.addEventListener("click", () => {
  void (capture ? stopSharing() : startSharing());
});

window.addEventListener("beforeunload", () => leaveRoom());

// Deep link: /#ROOMCODE joins straight away.
//
// The password box is necessarily empty this early, so a link to a protected room
// gets rejected on this first attempt. That is fine, and better than not trying at
// all: the overwhelmingly common case is an unprotected room, and `bad-password` is
// handled as a recoverable prompt rather than a dead end, so the protected case turns
// into "enter the password and press Enter" instead of a silent failure.
const fromHash = location.hash.replace(/^#/, "").toUpperCase();
if (fromHash) {
  ui.roomInput.value = fromHash;
  void joinRoom(fromHash, ui.passInput.value.trim() || undefined);
}
