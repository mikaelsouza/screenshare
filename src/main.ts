/**
 * App bootstrap: wires signalling -> mesh -> DOM tiles.
 *
 * Everything latency-critical lives in mesh.ts / quality.ts. This file is glue.
 */

import { hasTurnServer } from "@shared/ice";
import {
  MAX_ROOM_SIZE,
  MIN_PASSWORD_LENGTH,
  ROOM_CODE_ALPHABET,
  isValidRoomCode,
  type PeerId,
  type PeerInfo,
} from "@shared/protocol";
import {
  captureAudioOnly,
  captureScreen,
  isAudioMode,
  onCaptureEnded,
  stopAudioSource,
  stopCapture,
  systemAudioSupport,
  windowAudioSupport,
  DEFAULT_AUDIO_MODE,
  QUALITY_PRESETS,
  DEFAULT_PRESET,
  type AudioMode,
  type AudioSource,
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
  nameInput: el<HTMLInputElement>("display-name"),
  roomInput: el<HTMLInputElement>("room-code"),
  passInput: el<HTMLInputElement>("room-pass"),
  genPassBtn: el<HTMLButtonElement>("gen-pass"),
  relayOnly: el<HTMLInputElement>("relay-only"),
  joinBtn: el<HTMLButtonElement>("join"),
  createBtn: el<HTMLButtonElement>("create"),
  copyLinkBtn: el<HTMLButtonElement>("copy-link"),
  shareBtn: el<HTMLButtonElement>("share"),
  muteAudioBtn: el<HTMLButtonElement>("mute-audio"),
  audioMode: el<HTMLSelectElement>("audio-mode"),
  audioChip: el<HTMLElement>("audio-chip"),
  audioChipText: el<HTMLElement>("audio-chip-text"),
  audioChangeBtn: el<HTMLButtonElement>("audio-change"),
  audioPrompt: el<HTMLElement>("audio-prompt"),
  audioPromptText: el<HTMLElement>("audio-prompt-text"),
  audioPickAppBtn: el<HTMLButtonElement>("audio-pick-app"),
  audioPickSystemBtn: el<HTMLButtonElement>("audio-pick-system"),
  audioPickNoneBtn: el<HTMLButtonElement>("audio-pick-none"),
  stage: el<HTMLDivElement>("stage"),
  roster: el<HTMLElement>("roster"),
  rosterTitle: el<HTMLElement>("roster-title"),
  rosterList: el<HTMLUListElement>("roster-list"),
  lockBtn: el<HTMLButtonElement>("lock-btn"),
  surfaceWarning: el<HTMLElement>("surface-warning"),
  status: el<HTMLElement>("status"),
  preset: el<HTMLSelectElement>("preset"),
  codec: el<HTMLSelectElement>("codec"),
};

let client: SignalingClient | null = null;
let mesh: Mesh | null = null;
/**
 * Whether relay-only is actually in force on the live mesh.
 *
 * Not the same as the checkbox. The status line used to read the checkbox directly, so
 * it announced "(Privacy Mode)" from the moment the socket opened — before the welcome
 * carrying the ICE servers had arrived, and therefore before anything had verified a
 * relay was even available.
 */
let relayActive = false;
let capture: CaptureResult | null = null;
let stopCaptureListener: (() => void) | null = null;
/** A second, audio-only capture (picker #2) whose audio replaced the screen's own. */
let audioSource: AudioSource | null = null;
/** Survives audio swaps, so a new source doesn't unmute what the user muted. */
let audioMuted = false;
/** Set when the audio being sent ended by itself, e.g. the game window closed. */
let audioLost = false;

const names = new Map<PeerId, string>();
/** Everyone else in the room and whether they are sharing, for the participant list. */
const members = new Map<PeerId, { name: string; sharing: boolean; host: boolean }>();
/** Whether we are this room's host, and whether the room refuses new joins. */
let isHost = false;
let roomLocked = false;
/** Our own id in the current room, once welcomed. */
let selfId: PeerId | null = null;
/** The room and password of the current connection, so it can be redone in place. */
let lastJoin: { code: string; password: string | undefined } | null = null;
const tiles = new Map<PeerId, HTMLVideoElement>();
const healthEls = new Map<PeerId, HTMLElement>();
const monitors = new Map<PeerId, LinkMonitor>();
const observers = new Map<PeerId, IntersectionObserver>();
const unmutePrompts = new Map<PeerId, HTMLElement>();
let healthTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Per-stream volume and mute, chosen by the viewer. Kept per peer rather than per tile,
 * so a sharer who stops and starts again comes back at the volume they were left at.
 * `volume` is never 0: dragging the slider to 0 sets `muted` instead, so unmuting
 * returns to where it was.
 */
const listening = new Map<PeerId, { volume: number; muted: boolean }>();
/**
 * Streams the viewer paused. The sharer is asked to stop sending us video (the same
 * send-side pause an off-screen tile gets) and the audio is silenced locally. Cleared
 * with the tile: a sharer who stops and shares again is a new stream.
 */
const paused = new Set<PeerId>();
/** Whether each tile is on screen, as last reported by its IntersectionObserver. */
const onScreen = new Map<PeerId, boolean>();
/** Stream currently pinned/focused by the viewer, if any. */
let focusedPeerId: PeerId | null = null;
/** The per-tile controls, so they can be redrawn when their state changes. */
const tileControls = new Map<
  PeerId,
  {
    wrap: HTMLElement;
    pauseBtn: HTMLButtonElement;
    muteBtn: HTMLButtonElement;
    volume: HTMLInputElement;
    fitBtn: HTMLButtonElement;
    focusBtn: HTMLButtonElement;
    fullscreenBtn: HTMLButtonElement;
    pipBtn?: HTMLButtonElement;
  }
>();

function setFocusedTile(peerId: PeerId | null): void {
  if (focusedPeerId === peerId) focusedPeerId = null;
  else focusedPeerId = peerId;

  for (const [id, t] of tiles.entries()) {
    const wrap = t.closest(".tile");
    if (!wrap) continue;
    if (focusedPeerId === id) wrap.classList.add("tile-focused");
    else wrap.classList.remove("tile-focused");
    renderTileControls(id);
  }
  if (focusedPeerId !== null) {
    ui.stage.classList.add("has-focused");
  } else {
    ui.stage.classList.remove("has-focused");
  }
}

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

/** Tile id of our own screen preview. */
const SELF_TILE = "__self";

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
  const updateAspect = () => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      wrap.style.setProperty("--tile-aspect", `${video.videoWidth} / ${video.videoHeight}`);
    }
  };
  video.addEventListener("loadedmetadata", updateAspect);
  video.addEventListener("resize", updateAspect);
  wrap.addEventListener("dblclick", (ev) => {
    if ((ev.target as HTMLElement).closest("button, input")) return;
    setFocusedTile(peerId);
  });
  wrap.addEventListener("click", (ev) => {
    if (focusedPeerId !== null && focusedPeerId !== peerId) {
      if ((ev.target as HTMLElement).closest("button, input")) return;
      setFocusedTile(peerId);
    }
  });
  tiles.set(peerId, video);
  // Our own preview is always muted and never paused, so it gets no controls.
  if (peerId !== SELF_TILE) buildTileControls(peerId, wrap);
  ui.stage.append(wrap);
  applyAudio(peerId);

  // Send-side pausing: tell the sharer to stop encoding for us when their tile
  // isn't on screen. This is the biggest bandwidth lever in a multi-sharer room.
  // Ignore callbacks for a tile we have already torn down: removal itself queues an
  // intersection change, and acting on it would tell a peer to pause a sender that a
  // freshly-created tile has just asked to resume.
  const io = new IntersectionObserver(
    (entries) => {
      if (observers.get(peerId) !== io) return;
      for (const e of entries) onScreen.set(peerId, e.isIntersecting);
      applyViewing(peerId);
    },
    { threshold: 0.1 },
  );
  io.observe(wrap);
  observers.set(peerId, io);

  return video;
}

function listeningFor(peerId: PeerId): { volume: number; muted: boolean } {
  let s = listening.get(peerId);
  if (!s) {
    s = { volume: 1, muted: false };
    listening.set(peerId, s);
  }
  return s;
}

/**
 * Ask the sharer for video only while the tile is both on screen and not paused.
 * One place decides, so scrolling a paused tile into view can't resume it, and
 * resuming a tile that is scrolled away doesn't start the upload either.
 */
function applyViewing(peerId: PeerId): void {
  const isPip = document.pictureInPictureElement === tiles.get(peerId);
  const visible = onScreen.get(peerId);
  // Before the first observer callback, leave the far end at its default (sending).
  if (visible === undefined && !isPip && !paused.has(peerId)) return;
  mesh?.setViewing(peerId, (visible === true || isPip) && !paused.has(peerId));
}

interface BoostAudioPipe {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  compressor?: DynamicsCompressorNode;
}
const boostPipes = new Map<PeerId, BoostAudioPipe>();
(window as any).__boostPipes = boostPipes;
let sharedAudioCtx: AudioContext | null = null;

function getSharedAudioContext(): AudioContext | null {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    try {
      sharedAudioCtx = new AudioContextClass({ latencyHint: "interactive" });
    } catch {
      sharedAudioCtx = new AudioContextClass();
    }
  }
  if (sharedAudioCtx.state === "suspended") {
    void sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

function setupBoostPipe(peerId: PeerId, stream: MediaStream): BoostAudioPipe | null {
  const existing = boostPipes.get(peerId);
  if (existing) {
    if (existing.stream === stream) return existing;
    teardownBoostPipe(peerId);
  }

  if (stream.getAudioTracks().length === 0) return null;

  try {
    const ctx = getSharedAudioContext();
    if (!ctx) return null;
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -6;
    compressor.knee.value = 6;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.1;

    source.connect(gain);
    gain.connect(compressor);
    compressor.connect(ctx.destination);

    const pipe: BoostAudioPipe = { stream, source, gain, compressor };
    boostPipes.set(peerId, pipe);
    return pipe;
  } catch (err) {
    console.warn(`[main] Web Audio boost setup failed for ${peerId}`, err);
    return null;
  }
}

function teardownBoostPipe(peerId: PeerId): void {
  const pipe = boostPipes.get(peerId);
  if (!pipe) return;
  try {
    pipe.gain.disconnect();
    pipe.source.disconnect();
    pipe.compressor?.disconnect();
  } catch {}
  boostPipes.delete(peerId);
}

/** Put the tile's audio where the viewer left it: volume, mute, pause and autoplay. */
function applyAudio(peerId: PeerId): void {
  if (peerId === SELF_TILE) return;
  const video = tiles.get(peerId);
  if (!video) return;
  const s = listeningFor(peerId);
  const isSilent = s.muted || paused.has(peerId) || unmutePrompts.has(peerId);
  const stream = video.srcObject instanceof MediaStream ? video.srcObject : null;

  // HTMLMediaElement volume is strictly clamped to [0, 1].
  video.volume = Math.max(0, Math.min(1, s.volume));

  if (s.volume > 1 && !isSilent && stream && stream.getAudioTracks().length > 0) {
    const pipe = setupBoostPipe(peerId, stream);
    if (pipe) {
      // Mute the video element so Web Audio is the single output path (avoids comb filtering / echo).
      video.muted = true;
      pipe.gain.gain.value = s.volume;
      const ctx = getSharedAudioContext();
      if (ctx?.state === "suspended") {
        void ctx.resume().catch(() => {});
      }
      return;
    }
  }

  // Volume <= 1 or muted or paused: native video handles playback.
  video.muted = isSilent;
  const pipe = boostPipes.get(peerId);
  if (pipe) {
    pipe.gain.gain.value = 0;
  }
}

function buildTileControls(peerId: PeerId, wrap: HTMLElement): void {
  const bar = document.createElement("div");
  bar.className = "tile-controls";

  const pauseBtn = document.createElement("button");
  pauseBtn.type = "button";
  pauseBtn.className = "tile-pause";
  pauseBtn.addEventListener("click", () => setPaused(peerId, !paused.has(peerId)));

  const muteBtn = document.createElement("button");
  muteBtn.type = "button";
  muteBtn.className = "tile-mute";
  muteBtn.addEventListener("click", () => {
    const s = listeningFor(peerId);
    s.muted = !s.muted;
    // Any click on the tile is the gesture the autoplay policy was waiting for.
    dismissUnmutePrompt(peerId);
    applyAudio(peerId);
    renderTileControls(peerId);
  });

  const volume = document.createElement("input");
  volume.type = "range";
  volume.className = "tile-volume";
  volume.min = "0";
  volume.max = "200";
  volume.step = "1";
  volume.addEventListener("input", () => {
    const s = listeningFor(peerId);
    const v = Number(volume.value);
    if (v === 0) {
      s.muted = true;
    } else {
      s.volume = v / 100;
      s.muted = false;
    }
    dismissUnmutePrompt(peerId);
    applyAudio(peerId);
    renderTileControls(peerId);
  });

  const fitBtn = document.createElement("button");
  fitBtn.type = "button";
  fitBtn.className = "tile-fit";
  fitBtn.addEventListener("click", () => {
    const isCover = wrap.dataset["fit"] === "cover";
    wrap.dataset["fit"] = isCover ? "contain" : "cover";
    renderTileControls(peerId);
  });

  const focusBtn = document.createElement("button");
  focusBtn.type = "button";
  focusBtn.className = "tile-focus";
  focusBtn.addEventListener("click", () => setFocusedTile(peerId));

  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.type = "button";
  fullscreenBtn.className = "tile-fullscreen";
  fullscreenBtn.addEventListener("click", () => {
    const isFs = document.fullscreenElement === wrap || (document as any).webkitFullscreenElement === wrap;
    if (isFs) {
      if (typeof document.exitFullscreen === "function") {
        void document.exitFullscreen().catch(() => {});
      } else if (typeof (document as any).webkitExitFullscreen === "function") {
        (document as any).webkitExitFullscreen();
      }
    } else if (typeof wrap.requestFullscreen === "function") {
      void wrap.requestFullscreen().catch(() => {});
    } else if (typeof (wrap as any).webkitRequestFullscreen === "function") {
      (wrap as any).webkitRequestFullscreen();
    }
  });

  let pipBtn: HTMLButtonElement | undefined;
  if ("pictureInPictureEnabled" in document && (document as any).pictureInPictureEnabled) {
    const video = tiles.get(peerId);
    pipBtn = document.createElement("button");
    pipBtn.type = "button";
    pipBtn.className = "tile-pip";
    pipBtn.addEventListener("click", () => {
      const v = tiles.get(peerId);
      if (!v) return;
      if (document.pictureInPictureElement === v) {
        void document.exitPictureInPicture().catch(() => {});
      } else if (typeof v.requestPictureInPicture === "function") {
        void v.requestPictureInPicture().catch((err) => {
          console.warn(`[main] PiP request failed for ${peerId}`, err);
        });
      }
    });
    if (video) {
      video.addEventListener("enterpictureinpicture", () => {
        applyViewing(peerId);
        renderTileControls(peerId);
      });
      video.addEventListener("leavepictureinpicture", () => {
        applyViewing(peerId);
        renderTileControls(peerId);
      });
    }
  }

  bar.append(pauseBtn, muteBtn, volume, fitBtn, focusBtn, ...(pipBtn ? [pipBtn] : []), fullscreenBtn);

  // Over the frozen last frame while paused, so it is obvious why nothing moves.
  const resume = document.createElement("button");
  resume.type = "button";
  resume.className = "tile-paused";
  resume.textContent = "Paused. Click to resume";
  resume.addEventListener("click", () => setPaused(peerId, false));

  wrap.append(resume, bar);
  tileControls.set(peerId, { wrap, pauseBtn, muteBtn, volume, fitBtn, focusBtn, fullscreenBtn, pipBtn });
  renderTileControls(peerId);
}

function renderTileControls(peerId: PeerId): void {
  const c = tileControls.get(peerId);
  if (!c) return;
  const s = listeningFor(peerId);
  const isPaused = paused.has(peerId);
  const name = names.get(peerId) ?? "this stream";
  c.wrap.dataset["paused"] = String(isPaused);

  c.pauseBtn.textContent = isPaused ? "▶" : "⏸";
  c.pauseBtn.title = isPaused ? `Resume ${name}` : `Pause ${name}. Stops their video being sent to you.`;
  c.pauseBtn.setAttribute("aria-label", isPaused ? `Resume ${name}` : `Pause ${name}`);

  const silent = s.muted || isPaused;
  c.muteBtn.textContent = silent ? "🔇" : "🔊";
  c.muteBtn.title = isPaused ? `${name} is paused` : s.muted ? `Unmute ${name}` : `Mute ${name}`;
  c.muteBtn.setAttribute("aria-label", c.muteBtn.title);
  c.muteBtn.disabled = isPaused;

  c.volume.value = String(s.muted ? 0 : Math.round(s.volume * 100));
  const isBoosted = !s.muted && !isPaused && s.volume > 1;
  c.volume.dataset["boosted"] = String(isBoosted);
  c.volume.title = `${name} volume: ${c.volume.value}%${isBoosted ? " (boosted)" : ""}`;
  c.volume.setAttribute("aria-label", `${name} volume`);
  c.volume.disabled = isPaused;

  const isCover = c.wrap.dataset["fit"] === "cover";
  c.fitBtn.textContent = isCover ? "⊡" : "⤢";
  c.fitBtn.title = isCover ? `Fit ${name} to window (show whole screen)` : `Fill window with ${name} (crop black bars)`;
  c.fitBtn.setAttribute("aria-label", c.fitBtn.title);
  c.fitBtn.setAttribute("aria-pressed", String(isCover));

  const isFocused = focusedPeerId === peerId;
  c.focusBtn.textContent = isFocused ? "🗕" : "📌";
  c.focusBtn.title = isFocused ? `Unfocus ${name}` : `Focus ${name} (double-click also focuses)`;
  c.focusBtn.setAttribute("aria-label", c.focusBtn.title);
  c.focusBtn.setAttribute("aria-pressed", String(isFocused));

  if (c.pipBtn) {
    const v = tiles.get(peerId);
    const isPip = document.pictureInPictureElement === v;
    c.pipBtn.textContent = isPip ? "🗗" : "⧉";
    c.pipBtn.title = isPip ? `Exit Picture-in-Picture for ${name}` : `Picture-in-Picture for ${name}`;
    c.pipBtn.setAttribute("aria-label", c.pipBtn.title);
    c.pipBtn.setAttribute("aria-pressed", String(isPip));
  }

  const isFs = document.fullscreenElement === c.wrap || (document as any).webkitFullscreenElement === c.wrap;
  c.fullscreenBtn.textContent = isFs ? "🗗" : "⛶";
  c.fullscreenBtn.title = isFs ? `Exit full screen for ${name}` : `Full screen ${name}`;
  c.fullscreenBtn.setAttribute("aria-label", c.fullscreenBtn.title);
  c.fullscreenBtn.setAttribute("aria-pressed", String(isFs));
}

/**
 * Pause or resume one stream. Paused: the sharer stops encoding video for us, the
 * audio goes silent and the frame freezes. Nothing changes for anyone else.
 */
function setPaused(peerId: PeerId, value: boolean): void {
  if (value) paused.add(peerId);
  else paused.delete(peerId);
  const video = tiles.get(peerId);
  const target = healthEls.get(peerId);
  if (value && target) {
    target.textContent = "paused";
    delete target.dataset["direct"];
  }
  dismissUnmutePrompt(peerId);
  applyAudio(peerId);
  if (video) {
    if (value) {
      video.pause();
    } else {
      void video.play().catch(() => {});
    }
  }
  applyViewing(peerId);
  renderTileControls(peerId);
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
  // A paused stream stays paused even if its tracks are renegotiated.
  if (paused.has(peerId)) {
    video.pause();
    return;
  }
  void video.play().catch(() => {
    video.muted = true;
    void video.play().then(
      () => showUnmutePrompt(video, peerId),
      () => {
        // play() rejects when the tile is torn down mid-attempt, e.g. on being
        // removed from the room; that must not overwrite the status saying so.
        if (tiles.get(peerId) !== video) return;
        setStatus("The browser blocked video playback. Click the tile to start it.", "warn");
      },
    );
  });
}

/** Click-to-unmute affordance shown when the autoplay policy forced muted playback. */
function showUnmutePrompt(video: HTMLVideoElement, peerId: PeerId): void {
  const wrap = video.closest(".tile");
  if (!wrap || wrap.querySelector(".tile-unmute")) return;
  // The viewer muted this stream on purpose: there is nothing to unmute.
  if (listeningFor(peerId).muted) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tile-unmute";
  btn.textContent = "Click to unmute";
  btn.addEventListener("click", () => {
    dismissUnmutePrompt(peerId);
    const s = listeningFor(peerId);
    s.muted = false;
    applyAudio(peerId);
    renderTileControls(peerId);
    void video.play().catch(() => {});
  });
  wrap.append(btn);
  unmutePrompts.set(peerId, btn);
}

function dismissUnmutePrompt(peerId: PeerId): void {
  unmutePrompts.get(peerId)?.remove();
  unmutePrompts.delete(peerId);
}

function removeTile(peerId: PeerId): void {
  const video = tiles.get(peerId);
  if (!video) return;
  // Disconnect before removing: an observer left attached to a detached subtree
  // leaks both the observer and the <video> with its former srcObject, and keeps
  // firing stale callbacks.
  observers.get(peerId)?.disconnect();
  observers.delete(peerId);
  dismissUnmutePrompt(peerId);
  if (document.pictureInPictureElement === video) {
    void document.exitPictureInPicture().catch(() => {});
  }
  teardownBoostPipe(peerId);
  video.srcObject = null;
  video.closest(".tile")?.remove();
  tiles.delete(peerId);
  healthEls.delete(peerId);
  monitors.delete(peerId);
  tileControls.delete(peerId);
  onScreen.delete(peerId);
  paused.delete(peerId);
  if (focusedPeerId === peerId) setFocusedTile(null);
}

for (const evName of ["fullscreenchange", "webkitfullscreenchange"]) {
  document.addEventListener(evName, () => {
    for (const id of tileControls.keys()) renderTileControls(id);
  });
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
      if (paused.has(peerId)) {
        target.textContent = "paused";
        delete target.dataset["direct"];
        continue;
      }
      let monitor = monitors.get(peerId);
      if (!monitor) {
        monitor = new LinkMonitor(pc);
        monitors.set(peerId, monitor);
      }
      void monitor.read().then((health) => {
        if (!health || paused.has(peerId)) return;
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
  const id = SELF_TILE;
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

// ---- participants --------------------------------------------------------

/**
 * The host token for a room, kept per tab. sessionStorage survives a refresh, so the
 * host stays host; a new tab or a friend's browser does not have it, so a forwarded
 * link never makes anyone else the host.
 */
function hostTokenFor(code: string): string | undefined {
  try {
    return sessionStorage.getItem(`host:${code}`) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The rejoin ticket from this tab's last welcome in a room; see RoomInfo.rejoinToken. */
function rejoinTokenFor(code: string): string | undefined {
  try {
    return sessionStorage.getItem(`rejoin:${code}`) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveRejoinToken(code: string, token: string | undefined): void {
  try {
    if (token) sessionStorage.setItem(`rejoin:${code}`, token);
    else sessionStorage.removeItem(`rejoin:${code}`);
  } catch {
    // Storage blocked: a reconnect into a locked room will be refused, nothing worse.
  }
}

function saveHostToken(code: string, token: string): void {
  try {
    sessionStorage.setItem(`host:${code}`, token);
  } catch {
    // Storage blocked: still host for this connection, just not after a refresh.
  }
}

/** First four characters of a peer id, so two people with the same name can be told apart. */
function shortId(id: PeerId): string {
  return id.slice(0, 4);
}

/**
 * The participant list. Everyone in the room is on it, including people who only
 * watch: they never get a video tile, and before this list existed a sharer had no
 * way to know they were there.
 */
function renderRoster(): void {
  if (!client || selfId === null) {
    ui.roster.hidden = true;
    ui.rosterList.replaceChildren();
    return;
  }
  ui.roster.hidden = false;
  const others = [...members.entries()];
  const title = capture
    ? `Sharing to ${others.length} ${others.length === 1 ? "person" : "people"}`
    : `In this room (${others.length + 1})`;
  ui.rosterTitle.textContent = `${title}${roomLocked ? ", locked" : ""}:`;
  ui.lockBtn.hidden = !isHost;
  ui.lockBtn.textContent = roomLocked ? "Unlock room" : "Lock room";

  const items: HTMLLIElement[] = [];
  const add = (id: PeerId, name: string, sharing: boolean, self: boolean, host: boolean): void => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${name}${self ? " (you)" : ""}${host ? " (host)" : ""}`;
    const idEl = document.createElement("span");
    idEl.className = "peer-id";
    idEl.textContent = shortId(id);
    li.append(label, idEl);
    if (sharing) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "sharing";
      li.append(badge);
    }
    if (isHost && !self) {
      const kick = document.createElement("button");
      kick.type = "button";
      kick.textContent = "Remove";
      kick.title = `Remove ${name} from the room. They can't rejoin for 15 minutes.`;
      kick.addEventListener("click", () => client?.kick(id));
      li.append(kick);
    }
    items.push(li);
  };
  add(selfId, currentName(), capture !== null, true, isHost);
  for (const [id, m] of others) add(id, m.name, m.sharing, false, m.host);
  ui.rosterList.replaceChildren(...items);
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

function currentAudioMode(): AudioMode {
  const stored = localStorage.getItem("audio_mode");
  return isAudioMode(stored) ? stored : DEFAULT_AUDIO_MODE;
}

// ---- audio source --------------------------------------------------------

/** Describe the audio currently being sent, for the chip next to Stop sharing. */
function audioDescription(): { text: string; kind: "ok" | "warn" | "off" } {
  if (audioLost) return { text: "Audio stopped: that window closed", kind: "warn" };
  if (!capture?.audio) return { text: "No audio", kind: "off" };
  if (audioSource) {
    return audioSource.kind === "window"
      ? { text: `Game audio: ${audioSource.label ?? "game window"}`, kind: "ok" }
      : { text: "All system audio", kind: "ok" };
  }
  if (capture.surface === "browser") return { text: "Tab audio", kind: "ok" };
  if (capture.surface === "window" && currentAudioMode() === "app") {
    return { text: "Game audio: shared window", kind: "ok" };
  }
  return { text: "All system audio", kind: "ok" };
}

function renderAudioControls(): void {
  if (!capture) {
    ui.audioChip.hidden = true;
    ui.audioPrompt.hidden = true;
    ui.muteAudioBtn.style.display = "none";
    ui.audioMode.disabled = false;
    return;
  }
  const { text, kind } = audioDescription();
  ui.audioChip.hidden = false;
  ui.audioChip.dataset["kind"] = kind;
  ui.audioChipText.textContent = text;
  ui.audioChangeBtn.textContent = audioLost ? "Pick again" : "Change";
  ui.audioMode.disabled = true;
  if (capture.audio) {
    ui.muteAudioBtn.style.display = "inline-block";
    ui.muteAudioBtn.textContent = audioMuted ? "Unmute audio" : "Mute audio";
  } else {
    ui.muteAudioBtn.style.display = "none";
  }
}

const AUDIO_PROMPT_TEXT = {
  screen:
    "You're sharing your whole screen. Pick the game's window and only its sound is sent. " +
    "Discord and music stay private.",
  missing:
    "No audio came with that pick. Pick the game's window to send only its sound, or use all system audio.",
  empty: "That window had no audio Chrome could share. Try another window, or use all system audio.",
  lost: "The audio you were sharing stopped, probably because that window closed. Pick where it should come from now.",
  change: "Pick where the audio comes from. The video keeps going while you choose.",
} as const;

function showAudioPrompt(reason: keyof typeof AUDIO_PROMPT_TEXT): void {
  ui.audioPromptText.textContent = AUDIO_PROMPT_TEXT[reason];
  ui.audioPrompt.hidden = false;
}

/** Send `track` to every peer, replacing whatever audio was going before. */
async function useAudioTrack(track: MediaStreamTrack | null): Promise<void> {
  if (!capture) return;
  // Stop the audio being replaced so nothing keeps capturing it in the background.
  // The screen's own track goes too: once replaced there is no way back to it
  // without a new pick anyway.
  const previous = capture.audio;
  if (previous && previous !== track) previous.stop();
  if (track) track.enabled = !audioMuted;
  capture.audio = track;
  audioLost = false;
  if (mesh) await mesh.setAudioTrack(track);
  if (track) watchAudioEnded(track);
  renderAudioControls();
}

function watchAudioEnded(track: MediaStreamTrack): void {
  // "ended" fires only when the source goes away (the window closes, or the user
  // hits Chrome's own stop button for that capture), never for our own stop().
  track.addEventListener("ended", () => {
    if (capture?.audio !== track) return;
    audioLost = true;
    capture.audio = null;
    void mesh?.setAudioTrack(null);
    if (audioSource?.track === track) {
      stopAudioSource(audioSource);
      audioSource = null;
    }
    renderAudioControls();
    showAudioPrompt("lost");
  });
}

let audioPickPending = false;

/** Picker #2. Must run straight from a click: Chrome needs a fresh gesture for it. */
async function pickAudio(kind: "window" | "system"): Promise<void> {
  if (!capture || audioPickPending) return;
  audioPickPending = true;
  try {
    let source: AudioSource | null;
    try {
      source = await captureAudioOnly(kind);
    } catch (err) {
      // Usually the user cancelling the picker. Leave everything as it was.
      console.warn("[main] audio pick cancelled or failed", err);
      return;
    }
    if (!capture) {
      // Sharing stopped while the picker was open.
      if (source) stopAudioSource(source);
      return;
    }
    if (!source) {
      showAudioPrompt("empty");
      return;
    }
    const old = audioSource;
    audioSource = source;
    await useAudioTrack(source.track);
    if (old) stopAudioSource(old);
    ui.audioPrompt.hidden = true;
  } finally {
    audioPickPending = false;
  }
}

async function chooseNoAudio(): Promise<void> {
  const old = audioSource;
  audioSource = null;
  await useAudioTrack(null);
  if (old) stopAudioSource(old);
  ui.audioPrompt.hidden = true;
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

  const mode = currentAudioMode();
  if (mode !== "none") {
    const audio = mode === "app" ? windowAudioSupport() : systemAudioSupport();
    if (!audio.supported && audio.reason) setStatus(audio.reason, "warn");
  }

  try {
    capture = await captureScreen(QUALITY_PRESETS[currentPreset()], mode);
  } catch (err) {
    // Includes the user simply cancelling the picker, which isn't an error.
    console.warn("[main] capture cancelled or failed", err);
    return;
  }

  stopCaptureListener = onCaptureEnded(capture, () => void stopSharing());
  if (capture.audio) watchAudioEnded(capture.audio);
  renderSelfPreview(capture.stream);

  // Announced before any offer goes out: viewers connect only to sharers, and the
  // server refuses an offer when neither side is sharing.
  client?.setSharing(true);
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

  ui.shareBtn.textContent = "Stop sharing";
  // A whole-screen share shows notifications, chat pop-ups and every other window.
  ui.surfaceWarning.hidden = capture.surface !== "monitor";
  renderRoster();
  audioMuted = false;
  audioLost = false;
  renderAudioControls();

  // A whole-screen pick in "Game only" mode comes back silent on purpose; any other
  // pick that should have had audio but didn't (unticked, or the window has none)
  // gets the same offer, including the fallback to all system audio.
  if (mode !== "none" && !capture.audio) {
    showAudioPrompt(capture.surface === "monitor" && mode === "app" ? "screen" : "missing");
  }
}

async function stopSharing(): Promise<void> {
  if (!capture) return;
  stopCaptureListener?.();
  stopCaptureListener = null;
  await mesh?.setCapture(null);
  stopCapture(capture);
  capture = null;
  if (audioSource) stopAudioSource(audioSource);
  audioSource = null;
  audioLost = false;
  renderSelfPreview(null);
  client?.setSharing(false);
  ui.shareBtn.textContent = "Share screen";
  ui.surfaceWarning.hidden = true;
  renderRoster();
  renderAudioControls();
}

// ---- room ----------------------------------------------------------------

/** The display name to join with: what the user typed, else a remembered or random one. */
function currentName(): string {
  const typed = ui.nameInput.value.trim().slice(0, 32);
  if (typed) return typed;
  let stored = localStorage.getItem("name");
  if (!stored) {
    stored = `guest-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem("name", stored);
  }
  return stored;
}

/** Incremented per join so a superseded in-flight join can detect it lost the race. */
let joinGeneration = 0;

async function joinRoom(code: string, password?: string): Promise<void> {
  if (!isValidRoomCode(code)) {
    setStatus("That doesn't look like a valid room code.", "error");
    return;
  }

  const codeToJoin = code;
  // A share carries over a reconnect to the same room, never into a different one.
  if (capture && lastJoin && lastJoin.code !== code) await stopSharing();
  const generation = ++joinGeneration;
  leaveRoom();
  if (generation !== joinGeneration) return;
  const displayName = currentName();
  lastJoin = { code, password };

  client = new SignalingClient(
    code,
    displayName,
    {
      onStatus: (s) =>
        setStatus(
          s === "open"
            ? `In room ${code}${relayActive ? " (Privacy Mode)" : ""}`
            : `Connection ${s}…`,
        ),

      onWelcome: (selfIdFromServer, peers, iceServers, room) => {
        // The signalling socket reconnects on any network blip, and the server issues
        // a fresh peer id each time, so onWelcome fires again. Without closing the old
        // Mesh its RTCPeerConnections stay open and keep encoding and uploading to
        // peers that have already replaced us — a silent bandwidth leak that compounds
        // with every reconnect.
        mesh?.close();
        monitors.clear();
        members.clear();
        listening.clear();
        selfId = null;
        if (room.hostToken) saveHostToken(code, room.hostToken);
        saveRejoinToken(code, room.rejoinToken);
        // Tiles from before a reconnect belong to links that no longer exist; anyone
        // still sharing is connected afresh and gets a new tile.
        for (const id of [...tiles.keys()]) removeTile(id);
        isHost = room.host;
        roomLocked = room.locked;

        // Minted by the Durable Object and delivered with the welcome, so holding a
        // joined WebSocket is what authorises them.
        const servers: RTCIceServer[] = iceServers.length > 0 ? iceServers : FALLBACK_ICE;

        // Fall back to a normal connection rather than a broken one. Privacy mode is a
        // preference; silently connecting nobody is not a way to honour it.
        // Privacy mode must fail closed. Downgrading to iceTransportPolicy "all"
        // signals host and srflx candidates — the user's real IP — to every peer,
        // which is precisely what the checkbox promises to prevent. A security
        // control that quietly turns itself off is worse than one that is absent,
        // because the user goes on believing it is working.
        const relayOnly = ui.relayOnly.checked;
        relayActive = false;
        if (relayOnly && !hasTurnServer(servers)) {
          setStatus(
            "Privacy mode is on but no TURN relay is configured, so your IP cannot be hidden. " +
              "Not connecting. Untick Hide IP to join without it.",
            "error",
          );
          client?.close();
          client = null;
          return;
        }

        relayActive = relayOnly;
        mesh = new Mesh(
          selfIdFromServer,
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
              stream.addEventListener("addtrack", () => applyAudio(peerId));
              stream.addEventListener("removetrack", () => applyAudio(peerId));
              applyAudio(peerId);
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
        // Connect only to the people who are sharing (and to everyone once we share);
        // see Mesh.members for why viewers never connect to each other.
        selfId = selfIdFromServer;
        for (const p of peers) {
          names.set(p.id, p.name);
          members.set(p.id, { name: p.name, sharing: p.sharing, host: p.host === true });
          mesh.addMember(p.id, p.sharing);
        }
        setStatus(
          `In room ${code}${relayOnly ? " (Privacy Mode)" : ""} — ${peers.length + 1}/${MAX_ROOM_SIZE} connected`,
        );
        if (capture) {
          // Still sharing across a reconnect or a Hide my IP switch. The server has
          // this socket down as not sharing, so say so first: others connect only to
          // sharers, and the server relays an offer only when one side shares.
          client?.setSharing(true);
          void mesh.setCapture(capture);
        }
        startHealthPolling();
        renderRoster();
      },

      onPeerJoined: (peer: PeerInfo) => {
        names.set(peer.id, peer.name);
        members.set(peer.id, { name: peer.name, sharing: peer.sharing, host: peer.host === true });
        mesh?.addMember(peer.id, peer.sharing);
        setStatus(`${peer.name} joined room ${code}`, "info");
        renderRoster();
      },
      onPeerLeft: (id) => {
        mesh?.removeMember(id);
        names.delete(id);
        members.delete(id);
        listening.delete(id);
        removeTile(id);
        renderRoster();
      },
      onSignal: (from, data) => void mesh?.handleSignal(from, data),
      onPeerState: (id, sharing) => {
        if (!sharing) removeTile(id);
        const m = members.get(id);
        if (m) m.sharing = sharing;
        mesh?.setMemberSharing(id, sharing);
        renderRoster();
      },
      onRoomState: (locked) => {
        roomLocked = locked;
        renderRoster();
      },
      onError: (code, message) => {
        // Both close the socket for good. Tear the room down too: a kicked peer's
        // connections to others would otherwise linger until they time out.
        if (code === "kicked") {
          // Stop the capture too. Left running, the browser kept sharing the screen
          // and the next room joined would have been sent it without asking.
          void stopSharing();
          saveRejoinToken(codeToJoin, undefined);
          lastJoin = null;
          leaveRoom();
          setStatus("You were removed from this room by its host.", "error");
          return;
        }
        if (code === "room-locked") {
          void stopSharing();
          lastJoin = null;
          leaveRoom();
          setStatus(`Room ${codeToJoin} is locked. Ask its host to unlock it.`, "error");
          return;
        }
        if (code === "not-host") {
          setStatus(message, "warn");
          return;
        }
        // A wrong password is the one error the user can actually fix from here, so
        // say so in plain language and put the cursor where the fix goes. The socket
        // is closed with 1008 and will not retry by itself, but joinRoom() builds a
        // fresh SignalingClient, so pressing Join (or Enter) genuinely retries.
        if (code === "password-ignored") {
          setStatus(message, "warn");
          return;
        }
        if (code === "weak-password") {
          setStatus(message, "warn");
          ui.passInput.focus();
          return;
        }
        if (code === "bad-password") {
          setStatus(`Room ${codeToJoin} needs a password. Enter it and press Join.`, "warn");
          // Do NOT clear the field. The rejection can arrive while the user is already
          // typing — the server deliberately delays a wrong guess — and wiping it then
          // destroys what they were halfway through entering.
          ui.passInput.focus();
          return;
        }
        setStatus(`${code}: ${message}`, "error");
      },
    },
    password,
    () => ({ hostToken: hostTokenFor(code), rejoinToken: rejoinTokenFor(code) }),
  );

  client.connect();
  location.hash = code;
}

function leaveRoom(): void {
  stopHealthPolling();
  if (capture) client?.setSharing(false);
  client?.close();
  client = null;
  mesh?.close();
  mesh = null;
  relayActive = false;
  monitors.clear();
  for (const id of [...tiles.keys()]) removeTile(id);
  for (const id of [...boostPipes.keys()]) teardownBoostPipe(id);
  names.clear();
  members.clear();
  listening.clear();
  selfId = null;
  isHost = false;
  roomLocked = false;
  setFocusedTile(null);
  renderRoster();
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
    // Apply it now by reconnecting, not "next time": every new connection made until
    // then would hand out the address the user just asked to hide.
    // lastJoin, not client: after Hide my IP refused to connect there is no client,
    // and unticking it is exactly how the status line says to get in.
    if (lastJoin) {
      void joinRoom(lastJoin.code, lastJoin.password);
      setStatus(ui.relayOnly.checked ? "Reconnecting with your IP hidden…" : "Reconnecting…", "info");
    }
  });

  // Mute audio button for active sharer
  ui.muteAudioBtn.addEventListener("click", () => {
    if (capture?.audio) {
      audioMuted = !audioMuted;
      capture.audio.enabled = !audioMuted;
      renderAudioControls();
      setStatus(audioMuted ? "Game audio muted" : "Game audio live", "info");
    }
  });

  ui.audioMode.value = currentAudioMode();
  ui.audioMode.addEventListener("change", () => {
    if (isAudioMode(ui.audioMode.value)) localStorage.setItem("audio_mode", ui.audioMode.value);
  });
  ui.audioChangeBtn.addEventListener("click", () => showAudioPrompt(audioLost ? "lost" : "change"));
  ui.audioPickAppBtn.addEventListener("click", () => void pickAudio("window"));
  ui.audioPickSystemBtn.addEventListener("click", () => void pickAudio("system"));
  ui.audioPickNoneBtn.addEventListener("click", () => void chooseNoAudio());
}

initQualityControls();

ui.lockBtn.addEventListener("click", () => {
  // The button flips when the server confirms with room-state, not before.
  client?.setLocked(!roomLocked);
});

ui.nameInput.value = localStorage.getItem("name") ?? "";
ui.nameInput.addEventListener("change", () => {
  const name = ui.nameInput.value.trim().slice(0, 32);
  if (name) localStorage.setItem("name", name);
  // Takes effect on the next join: the server learns a name only from `join`.
  if (client) setStatus("Your new name shows the next time you join.", "info");
});

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
    // Always the input, never a remembered code: the user may have typed a different
    // room while the "needs a password" prompt was still showing, and Enter must go
    // where the Join button next to it would go.
    const code = ui.roomInput.value.trim().toUpperCase();
    void joinRoom(code, ui.passInput.value.trim() || undefined);
  });
}

/**
 * A random password friends can read out: 12 characters from the room-code alphabet,
 * which has no look-alikes, in groups of four. About 59 bits.
 */
function generatePassword(): string {
  const out: string[] = [];
  const limit = Math.floor(256 / ROOM_CODE_ALPHABET.length) * ROOM_CODE_ALPHABET.length;
  const buf = new Uint8Array(32);
  while (out.length < 12) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < 12) out.push(ROOM_CODE_ALPHABET.charAt(b % ROOM_CODE_ALPHABET.length));
    }
  }
  return [out.slice(0, 4), out.slice(4, 8), out.slice(8)].map((g) => g.join("")).join("-");
}

ui.genPassBtn.addEventListener("click", () => {
  ui.passInput.value = generatePassword();
  // Shown, not masked: the point is to copy it to friends.
  ui.passInput.type = "text";
  ui.passInput.select();
});
ui.passInput.addEventListener("input", () => {
  if (ui.passInput.value === "") ui.passInput.type = "password";
});

ui.createBtn.addEventListener("click", () => {
  const pass = ui.passInput.value.trim();
  if (pass && pass.length < MIN_PASSWORD_LENGTH) {
    setStatus(`Room passwords need at least ${MIN_PASSWORD_LENGTH} characters. Or press Generate.`, "warn");
    ui.passInput.focus();
    return;
  }
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

let copyFeedbackTimeout: ReturnType<typeof setTimeout> | null = null;

async function copyRoomLink(): Promise<void> {
  const code = (lastJoin?.code ?? ui.roomInput.value.trim()).toUpperCase();
  if (!isValidRoomCode(code)) {
    setStatus("Enter or create a room first to copy its link.", "warn");
    ui.roomInput.focus();
    return;
  }
  const url = `${location.origin}/#${code}`;
  let copied = false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(url);
      copied = true;
    }
  } catch (err) {
    console.warn("[main] clipboard.writeText failed, using fallback", err);
  }
  if (!copied) {
    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.left = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      copied = document.execCommand("copy");
      ta.remove();
    } catch {}
  }
  if (copied) {
    if (copyFeedbackTimeout !== null) clearTimeout(copyFeedbackTimeout);
    ui.copyLinkBtn.textContent = "Copied!";
    ui.copyLinkBtn.classList.add("copied");
    setStatus(`Copied room link: ${url}`, "info");
    copyFeedbackTimeout = setTimeout(() => {
      ui.copyLinkBtn.textContent = "Copy link";
      ui.copyLinkBtn.classList.remove("copied");
      copyFeedbackTimeout = null;
    }, 2000);
  } else {
    setStatus(`Could not copy link automatically. Room link: ${url}`, "warn");
  }
}

ui.copyLinkBtn.addEventListener("click", () => void copyRoomLink());

ui.shareBtn.addEventListener("click", () => {
  void (capture ? stopSharing() : startSharing());
});

window.addEventListener("beforeunload", () => leaveRoom());
window.addEventListener("pagehide", () => leaveRoom());

// Deep link: /#ROOMCODE joins the room straight away.
//
// It used to only fill in the code and wait for Join, so a first-time visitor saw the
// Hide my IP option before anything connected. In practice nobody understood that
// they had to press Join, so opening a link now joins. Hide my IP is remembered across
// visits and is applied before this runs; ticking it once inside the room reconnects
// through the relay at once (see the relay-only change handler above).
//
// A password-protected room cannot be entered from the link alone: the server answers
// with bad-password, the status line asks for it, and Enter or Join retries.
function joinFromHash(): void {
  const fromHash = location.hash.replace(/^#/, "").toUpperCase();
  if (!isValidRoomCode(fromHash)) return;
  // joinRoom itself writes the hash, which fires hashchange; don't rejoin for that.
  if (lastJoin?.code === fromHash && client) return;
  // Any password in the field was typed for some other room. Sending it here would
  // claim an empty room with it, or count as a wrong guess against a protected one.
  if (ui.roomInput.value.trim().toUpperCase() !== fromHash) {
    ui.passInput.value = "";
    ui.passInput.type = "password";
  }
  ui.roomInput.value = fromHash;
  void joinRoom(fromHash, ui.passInput.value.trim() || undefined);
}

joinFromHash();
// Pasting a different room link into an open tab changes only the hash, which does
// not reload the page, so it would otherwise do nothing.
window.addEventListener("hashchange", joinFromHash);
