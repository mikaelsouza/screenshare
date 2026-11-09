/**
 * App bootstrap: wires signalling -> mesh -> DOM tiles.
 *
 * Everything latency-critical lives in mesh.ts / quality.ts. This file is glue.
 */

import {
  MAX_ROOM_SIZE,
  isValidRoomCode,
  parseNewRoomResponse,
  type PeerId,
  type PeerInfo,
} from "@shared/protocol";
import {
  windowAudioSupport,
  QUALITY_PRESETS,
  DEFAULT_PRESET,
  type CaptureResult,
  type QualityPresetName,
} from "./capture";
import { Mesh } from "./mesh";
import { createCaptureController } from "./platform";
import type { EndReason, FollowState } from "./platform/types";
import { DEFAULT_CODEC, type CodecName } from "./quality";
import { SignalingClient } from "./signaling";
import { LinkMonitor, summarize } from "./stats";
import {
  computeVolumeState,
  deriveOutboundAudioState,
  deriveViewState,
  nextPopoverState,
  shouldRequestRemoteVideo,
  sortAndFormatRoster,
  type PopoverKind,
  type RosterEntry,
  type RosterSummary,
  type ViewState,
  type VolumeState,
} from "./ui-model";

function el<T extends HTMLElement>(id: string): T {
  const selector = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? `#${CSS.escape(id)}` : `#${id}`;
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`missing element #${id}`);
  return node;
}

const ui = {
  lobby: el<HTMLElement>("lobby"),
  nameInput: el<HTMLInputElement>("display-name"),
  roomNameInput: el<HTMLInputElement>("room-name"),
  roomInput: el<HTMLInputElement>("room-code"),
  joinBtn: el<HTMLButtonElement>("join"),
  createBtn: el<HTMLButtonElement>("create"),
  brandHomeBtn: el<HTMLButtonElement>("brand-home"),
  roomBar: el<HTMLElement>("room-bar"),
  copyLinkBtn: el<HTMLButtonElement>("copy-link"),
  rosterBtn: el<HTMLButtonElement>("roster-btn"),
  roster: el<HTMLElement>("roster"),
  rosterTitle: el<HTMLElement>("roster-title"),
  rosterList: el<HTMLUListElement>("roster-list"),
  lockBtn: el<HTMLButtonElement>("lock-btn"),
  followChip: el<HTMLElement>("follow-chip"),
  followDot: el<HTMLElement>("follow-dot"),
  followChipText: el<HTMLElement>("follow-chip-text"),
  status: el<HTMLElement>("status"),
  stage: el<HTMLDivElement>("stage"),
  stageEmpty: el<HTMLElement>("stage-empty"),
  stageEmptyTitle: el<HTMLElement>("stage-empty-title"),
  stageEmptySub: el<HTMLElement>("stage-empty-sub"),
  controls: el<HTMLElement>("controls"),
  liveControls: el<HTMLElement>("live-controls"),
  presetBtn: el<HTMLButtonElement>("preset-btn"),
  presetBtnLabel: el<HTMLElement>("preset-btn-label"),
  presetMenu: el<HTMLElement>("preset-menu"),
  presetList: el<HTMLElement>("preset-list"),
  codecBtn: el<HTMLButtonElement>("codec-btn"),
  codecBtnLabel: el<HTMLElement>("codec-btn-label"),
  codecMenu: el<HTMLElement>("codec-menu"),
  codecList: el<HTMLElement>("codec-list"),
  togglePreviewBtn: el<HTMLButtonElement>("toggle-preview"),
  muteAudioBtn: el<HTMLButtonElement>("mute-audio"),
  shareBtn: el<HTMLButtonElement>("share"),
};

const SVG_NS = "http://www.w3.org/2000/svg";

type IconName =
  | "play"
  | "pause"
  | "volumeOn"
  | "volumeOff"
  | "fitContain"
  | "fitCover"
  | "focus"
  | "unfocus"
  | "pip"
  | "stats"
  | "fullscreen"
  | "exitFullscreen";

const pendingTasks = new Set<Promise<unknown>>();

function runBackground(task: Promise<unknown>): void {
  const tracked = task
    .catch((err: unknown) => {
      console.warn("[main] background task failed", err);
    })
    .finally(() => {
      pendingTasks.delete(tracked);
    });
  pendingTasks.add(tracked);
}

const ICON_PATHS: Record<IconName, readonly string[]> = {
  play: ["M6 4l14 8-14 8V4z"],
  pause: ["M6 4h4v16H6zM14 4h4v16h-4z"],
  volumeOn: [
    "M11 5L6 9H2v6h4l5 4V5z",
    "M15.54 8.46a5 5 0 0 1 0 7.07",
    "M19.07 4.93a10 10 0 0 1 0 14.14",
  ],
  volumeOff: ["M11 5L6 9H2v6h4l5 4V5z", "M22 9l-6 6", "M16 9l6 6"],
  fitContain: ["M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"],
  fitCover: ["M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4"],
  focus: ["M12 2v8M8 6h8M6 14h12l-2 6H8l-2-6z"],
  unfocus: ["M4 12h16"],
  pip: ["M3 5h18v14H3z", "M12 11h7v6h-7z"],
  stats: ["M18 20V10M12 20V4M6 20v-6"],
  fullscreen: [
    "M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3",
  ],
  exitFullscreen: [
    "M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3",
  ],
};

/**
 * Trusted-Types-safe SVG icon factory using createElementNS (never innerHTML).
 */
function createIcon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");

  for (const pathData of ICON_PATHS[name]) {
    const pathEl = document.createElementNS(SVG_NS, "path");
    pathEl.setAttribute("d", pathData);
    svg.append(pathEl);
  }
  return svg;
}

function setButtonIcon(btn: HTMLButtonElement, icon: IconName): void {
  btn.replaceChildren(createIcon(icon));
}

let client: SignalingClient | null = null;
let mesh: Mesh | null = null;
let capture: CaptureResult | null = null;
/** Whether the sharer hid their own preview tile on stage. */
let selfPreviewHidden = false;
/** Which header or footer popover is currently open, if any. */
let activePopover: PopoverKind | null = null;

const names = new Map<PeerId, string>();
/** Everyone else in the room and whether they are sharing, for the participant list. */
const members = new Map<PeerId, { name: string; sharing: boolean; host: boolean }>();
/** Whether we are this room's host, and whether the room refuses new joins. */
let isHost = false;
let roomLocked = false;
/** Our own id in the current room, once welcomed. */
let selfId: PeerId | null = null;
/** The room of the current connection, so it can be redone in place. */
let lastJoin: { code: string } | null = null;

const tiles = new Map<PeerId, HTMLVideoElement>();
const healthEls = new Map<PeerId, HTMLElement>();
const inboundMonitors = new Map<PeerId, LinkMonitor>();
const outboundMonitors = new Map<PeerId, LinkMonitor>();
const peerOutboundText = new Map<PeerId, string>();
let totalOutboundMbps = 0;
let activeViewerCount = 0;
const statsOpen = new Set<PeerId>();
const observers = new Map<PeerId, IntersectionObserver>();
const unmutePrompts = new Map<PeerId, HTMLElement>();
let healthTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Per-stream volume and mute, chosen by the viewer. Kept per peer rather than per tile,
 * so a sharer who stops and starts again comes back at the volume they were left at.
 */
const listening = new Map<PeerId, { volume: number; muted: boolean }>();
/**
 * Streams the viewer paused. The sharer is asked to stop sending us video (the same
 * send-side pause an off-screen tile gets) and the audio is silenced locally.
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
    statsBtn: HTMLButtonElement;
    fullscreenBtn: HTMLButtonElement;
    pipBtn?: HTMLButtonElement | undefined;
  }
>();

/** Tile id of our own screen preview. */
const SELF_TILE = "__self";

function visibleTileCount(): number {
  let count = 0;
  for (const [id, video] of tiles.entries()) {
    const wrap = video.closest<HTMLElement>(".tile");
    if (wrap && !wrap.hidden && !(id === SELF_TILE && selfPreviewHidden)) {
      count++;
    }
  }
  return count;
}

function syncViewState(): ViewState {
  const connected = selfId !== null && client !== null;
  const sharing = capture !== null;
  const state = deriveViewState(connected, sharing, selfPreviewHidden, visibleTileCount());

  ui.lobby.hidden = state.lobbyHidden;
  ui.brandHomeBtn.disabled = !state.lobbyHidden;
  ui.brandHomeBtn.title = state.lobbyHidden ? "Return to lobby" : "";
  ui.stage.hidden = !state.lobbyHidden;
  ui.stageEmpty.hidden = state.stageEmptyHidden;
  ui.stageEmptyTitle.textContent = state.stageEmptyTitle;
  ui.stageEmptySub.textContent = state.stageEmptySubtitle;
  ui.roomBar.hidden = state.roomBarHidden;
  ui.copyLinkBtn.hidden = state.roomBarHidden;
  ui.controls.hidden = state.controlsHidden;
  ui.liveControls.hidden = state.liveControlsHidden;
  ui.muteAudioBtn.hidden = state.muteAudioHidden;
  ui.togglePreviewBtn.hidden = state.togglePreviewHidden;
  ui.shareBtn.textContent = state.shareButtonText;
  ui.shareBtn.className = `ui-btn ${state.shareButtonVariant}`;

  if (client === null) {
    applyPopoverState(null);
  } else if (!sharing && (activePopover === "preset" || activePopover === "codec")) {
    applyPopoverState(null);
  }

  for (const ctrl of tileControls.values()) {
    ctrl.focusBtn.hidden = !state.showFocusButtons;
  }
  if (!state.showFocusButtons && focusedPeerId !== null) {
    setFocusedTile(null);
  }

  return state;
}

function setFocusedTile(peerId: PeerId | null): void {
  if (focusedPeerId === peerId) focusedPeerId = null;
  else focusedPeerId = peerId;

  for (const [id, tileVideo] of tiles.entries()) {
    const wrap = tileVideo.closest(".tile");
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
  ui.status.hidden = kind === "info" || text.length === 0;
}

let copyFeedbackTimeout: ReturnType<typeof setTimeout> | null = null;

function defaultCopyLinkLabel(): string {
  const code = lastJoin?.code ?? ui.roomInput.value.trim().toUpperCase();
  return code ? `${code} · Copy link` : "Copy link";
}

function syncCopyLinkButton(): void {
  if (copyFeedbackTimeout !== null) return;
  ui.copyLinkBtn.textContent = defaultCopyLinkLabel();
}

/**
 * STUN server for NAT traversal on the direct peer-to-peer path.
 */
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

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
  video.muted = peerId === SELF_TILE;

  const label = document.createElement("span");
  label.className = "tile-label";
  label.textContent = names.get(peerId) ?? peerId.slice(0, 6);

  const health = document.createElement("span");
  health.className = "tile-health";
  health.hidden = !statsOpen.has(peerId);
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
    if (ev.target instanceof Element && ev.target.closest("button, input")) return;
    if (visibleTileCount() >= 2) setFocusedTile(peerId);
  });
  wrap.addEventListener("click", (ev) => {
    if (focusedPeerId !== null && focusedPeerId !== peerId) {
      if (ev.target instanceof Element && ev.target.closest("button, input")) return;
      setFocusedTile(peerId);
    }
  });
  tiles.set(peerId, video);
  if (peerId === SELF_TILE) {
    buildSelfTileControls(wrap);
    wrap.hidden = selfPreviewHidden;
  } else {
    buildTileControls(peerId, wrap);
  }
  ui.stage.append(wrap);
  applyAudio(peerId);
  syncViewState();

  if (peerId !== SELF_TILE) {
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
  }

  return video;
}

function buildSelfTileControls(wrap: HTMLElement): void {
  const bar = document.createElement("div");
  bar.className = "tile-controls";

  const hideBtn = document.createElement("button");
  hideBtn.type = "button";
  hideBtn.className = "tile-hide-self";
  hideBtn.textContent = "Hide preview";
  hideBtn.title = "Hide your local preview tile";
  hideBtn.addEventListener("click", () => {
    selfPreviewHidden = true;
    wrap.hidden = true;
    if (focusedPeerId === SELF_TILE) setFocusedTile(null);
    syncViewState();
  });

  bar.append(hideBtn);
  wrap.append(bar);
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
 */
function applyViewing(peerId: PeerId): void {
  const isPip = document.pictureInPictureElement === tiles.get(peerId);
  const want = shouldRequestRemoteVideo(onScreen.get(peerId), isPip, paused.has(peerId));
  if (want === null) return;
  mesh?.setViewing(peerId, want);
}

interface BoostAudioPipe {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  compressor?: DynamicsCompressorNode;
}
const boostPipes = new Map<PeerId, BoostAudioPipe>();
let sharedAudioCtx: AudioContext | null = null;

function getSharedAudioContext(): AudioContext | null {
  const AudioContextClass = window.AudioContext;
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

  video.volume = Math.max(0, Math.min(1, s.volume));

  if (s.volume > 1 && !isSilent && stream && stream.getAudioTracks().length > 0) {
    const pipe = setupBoostPipe(peerId, stream);
    if (pipe) {
      video.muted = true;
      pipe.gain.gain.value = s.volume;
      const ctx = getSharedAudioContext();
      if (ctx?.state === "suspended") {
        void ctx.resume().catch(() => {});
      }
      return;
    }
  }

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
    dismissUnmutePrompt(peerId, false);
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
    const volState: VolumeState = computeVolumeState(Number(volume.value), s.volume);
    if (volState.muted) {
      s.muted = true;
    } else {
      s.volume = volState.volume;
      s.muted = false;
    }
    dismissUnmutePrompt(peerId, false);
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

  const statsBtn = document.createElement("button");
  statsBtn.type = "button";
  statsBtn.className = "tile-stats";
  statsBtn.addEventListener("click", () => {
    if (statsOpen.has(peerId)) statsOpen.delete(peerId);
    else statsOpen.add(peerId);
    const hEl = healthEls.get(peerId);
    if (hEl) hEl.hidden = !statsOpen.has(peerId);
    renderTileControls(peerId);
  });

  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.type = "button";
  fullscreenBtn.className = "tile-fullscreen";
  fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement === wrap) {
      void document.exitFullscreen().catch(() => {});
    } else if (typeof wrap.requestFullscreen === "function") {
      void wrap.requestFullscreen().catch(() => {});
    }
  });

  let pipBtn: HTMLButtonElement | undefined;
  if ("pictureInPictureEnabled" in document && document.pictureInPictureEnabled) {
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
        void v.requestPictureInPicture().catch((err: unknown) => {
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

  bar.append(
    pauseBtn,
    muteBtn,
    volume,
    fitBtn,
    focusBtn,
    ...(pipBtn ? [pipBtn] : []),
    statsBtn,
    fullscreenBtn,
  );

  const resume = document.createElement("button");
  resume.type = "button";
  resume.className = "tile-paused";
  resume.textContent = "Paused · Click to resume";
  resume.addEventListener("click", () => setPaused(peerId, false));

  wrap.append(resume, bar);
  tileControls.set(peerId, {
    wrap,
    pauseBtn,
    muteBtn,
    volume,
    fitBtn,
    focusBtn,
    statsBtn,
    fullscreenBtn,
    pipBtn,
  });
  renderTileControls(peerId);
}

type TileControlElements = {
  wrap: HTMLElement;
  pauseBtn: HTMLButtonElement;
  muteBtn: HTMLButtonElement;
  volume: HTMLInputElement;
  fitBtn: HTMLButtonElement;
  focusBtn: HTMLButtonElement;
  statsBtn: HTMLButtonElement;
  fullscreenBtn: HTMLButtonElement;
  pipBtn?: HTMLButtonElement | undefined;
};

function renderTileAudioControls(
  ctrl: TileControlElements,
  audioState: { volume: number; muted: boolean },
  isPaused: boolean,
  name: string,
): void {
  setButtonIcon(ctrl.pauseBtn, isPaused ? "play" : "pause");
  ctrl.pauseBtn.title = isPaused ? `Resume ${name}` : `Pause ${name}. Stops their video being sent to you.`;
  ctrl.pauseBtn.setAttribute("aria-label", isPaused ? `Resume ${name}` : `Pause ${name}`);

  const silent = audioState.muted || isPaused;
  setButtonIcon(ctrl.muteBtn, silent ? "volumeOff" : "volumeOn");
  let muteTitle = `Mute ${name}`;
  if (isPaused) muteTitle = `${name} is paused`;
  else if (audioState.muted) muteTitle = `Unmute ${name}`;
  ctrl.muteBtn.title = muteTitle;
  ctrl.muteBtn.setAttribute("aria-label", ctrl.muteBtn.title);
  ctrl.muteBtn.disabled = isPaused;

  const sliderVal = audioState.muted ? 0 : Math.round(audioState.volume * 100);
  const volState = computeVolumeState(sliderVal, audioState.volume);
  ctrl.volume.value = String(sliderVal);
  const isBoosted = !isPaused && volState.boosted;
  ctrl.volume.dataset["boosted"] = String(isBoosted);
  ctrl.volume.title = `${name} ${volState.label.toLowerCase()}${isBoosted ? " (boosted)" : ""}`;
  ctrl.volume.setAttribute("aria-label", `${name} volume`);
  ctrl.volume.disabled = isPaused;
}

function renderTileViewControls(ctrl: TileControlElements, peerId: PeerId, name: string): void {
  const isCover = ctrl.wrap.dataset["fit"] === "cover";
  setButtonIcon(ctrl.fitBtn, isCover ? "fitContain" : "fitCover");
  ctrl.fitBtn.title = isCover ? `Fit ${name} to window (show whole screen)` : `Fill window with ${name} (crop black bars)`;
  ctrl.fitBtn.setAttribute("aria-label", ctrl.fitBtn.title);
  ctrl.fitBtn.setAttribute("aria-pressed", String(isCover));

  const isFocused = focusedPeerId === peerId;
  setButtonIcon(ctrl.focusBtn, isFocused ? "unfocus" : "focus");
  ctrl.focusBtn.title = isFocused ? `Unfocus ${name}` : `Focus ${name} (double-click also focuses)`;
  ctrl.focusBtn.setAttribute("aria-label", ctrl.focusBtn.title);
  ctrl.focusBtn.setAttribute("aria-pressed", String(isFocused));
  ctrl.focusBtn.hidden = visibleTileCount() < 2;

  if (ctrl.pipBtn) {
    const videoEl = tiles.get(peerId);
    const isPip = document.pictureInPictureElement === videoEl;
    setButtonIcon(ctrl.pipBtn, "pip");
    ctrl.pipBtn.title = isPip ? `Exit Picture-in-Picture for ${name}` : `Picture-in-Picture for ${name}`;
    ctrl.pipBtn.setAttribute("aria-label", ctrl.pipBtn.title);
    ctrl.pipBtn.setAttribute("aria-pressed", String(isPip));
  }

  const isStats = statsOpen.has(peerId);
  setButtonIcon(ctrl.statsBtn, "stats");
  ctrl.statsBtn.title = isStats ? `Hide stream stats for ${name}` : `Show stream stats for ${name}`;
  ctrl.statsBtn.setAttribute("aria-label", ctrl.statsBtn.title);
  ctrl.statsBtn.setAttribute("aria-pressed", String(isStats));

  const isFs = document.fullscreenElement === ctrl.wrap;
  setButtonIcon(ctrl.fullscreenBtn, isFs ? "exitFullscreen" : "fullscreen");
  ctrl.fullscreenBtn.title = isFs ? `Exit full screen for ${name}` : `Full screen ${name}`;
  ctrl.fullscreenBtn.setAttribute("aria-label", ctrl.fullscreenBtn.title);
  ctrl.fullscreenBtn.setAttribute("aria-pressed", String(isFs));
}

function renderTileControls(peerId: PeerId): void {
  const ctrl = tileControls.get(peerId);
  if (!ctrl) return;
  const audioState = listeningFor(peerId);
  const isPaused = paused.has(peerId);
  const name = names.get(peerId) ?? "this stream";
  ctrl.wrap.dataset["paused"] = String(isPaused);

  renderTileAudioControls(ctrl, audioState, isPaused, name);
  renderTileViewControls(ctrl, peerId, name);
}

function setPaused(peerId: PeerId, value: boolean): void {
  if (value) paused.add(peerId);
  else paused.delete(peerId);
  const video = tiles.get(peerId);
  const target = healthEls.get(peerId);
  if (value && target) {
    target.textContent = "paused";
  }
  dismissUnmutePrompt(peerId);
  applyAudio(peerId);
  if (video) {
    if (value) {
      video.pause();
    } else {
      startPlayback(video, peerId);
    }
  }
  applyViewing(peerId);
  renderTileControls(peerId);
}

function startPlayback(video: HTMLVideoElement, peerId: PeerId): void {
  if (paused.has(peerId)) {
    video.pause();
    return;
  }
  runBackground(
    video.play().catch(() => {
      video.muted = true;
      return video.play().then(
        () => {
          if (tiles.get(peerId) === video) showUnmutePrompt(video, peerId, false);
        },
        () => {
          if (tiles.get(peerId) === video) showUnmutePrompt(video, peerId, true);
        },
      );
    }),
  );
}

function showUnmutePrompt(video: HTMLVideoElement, peerId: PeerId, playbackBlocked = false): void {
  const wrap = video.closest(".tile");
  if (!wrap || wrap.querySelector(".tile-unmute")) return;
  if (!playbackBlocked && listeningFor(peerId).muted) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tile-unmute";
  btn.dataset["blocked"] = String(playbackBlocked);
  const pill = document.createElement("span");
  pill.className = "tile-unmute-pill";
  pill.append(createIcon(playbackBlocked ? "play" : "volumeOff"));
  const txt = document.createElement("span");
  txt.textContent = playbackBlocked ? "Click to play" : "Click to unmute";
  pill.append(txt);
  btn.append(pill);
  btn.addEventListener("click", () => {
    dismissUnmutePrompt(peerId);
    if (!playbackBlocked) {
      const audioState = listeningFor(peerId);
      audioState.muted = false;
    }
    applyAudio(peerId);
    renderTileControls(peerId);
    startPlayback(video, peerId);
  });
  wrap.append(btn);
  unmutePrompts.set(peerId, btn);
}

function dismissUnmutePrompt(peerId: PeerId, includeBlocked = true): void {
  const btn = unmutePrompts.get(peerId);
  if (!btn) return;
  if (!includeBlocked && btn.dataset["blocked"] === "true") return;
  btn.remove();
  unmutePrompts.delete(peerId);
}

function removeTile(peerId: PeerId): void {
  const video = tiles.get(peerId);
  if (!video) return;
  observers.get(peerId)?.disconnect();
  observers.delete(peerId);
  dismissUnmutePrompt(peerId);
  if (document.pictureInPictureElement === video) {
    runBackground(document.exitPictureInPicture());
  }
  teardownBoostPipe(peerId);
  video.srcObject = null;
  video.closest(".tile")?.remove();
  tiles.delete(peerId);
  healthEls.delete(peerId);
  inboundMonitors.delete(peerId);
  statsOpen.delete(peerId);
  tileControls.delete(peerId);
  onScreen.delete(peerId);
  paused.delete(peerId);
  if (focusedPeerId === peerId) setFocusedTile(null);
  syncViewState();
}

document.addEventListener("fullscreenchange", () => {
  for (const id of tileControls.keys()) renderTileControls(id);
});

/**
 * Poll inbound link health for each watched remote tile, and outbound link health
 * for each connected viewer in the roster while we are streaming.
 */
function startHealthPolling(): void {
  stopHealthPolling();
  healthTimer = setInterval(() => {
    if (!mesh) return;
    const activeMesh = mesh;

    // 1. Inbound stats for watched tiles
    for (const peerId of activeMesh.peers()) {
      const pc = activeMesh.getConnection(peerId);
      const target = healthEls.get(peerId);
      if (pc && target) {
        if (paused.has(peerId)) {
          target.textContent = "paused";
        } else {
          let monitor = inboundMonitors.get(peerId);
          if (!monitor) {
            monitor = new LinkMonitor(pc, "inbound");
            inboundMonitors.set(peerId, monitor);
          }
          runBackground(
            monitor.read().then((health) => {
              if (!health || paused.has(peerId)) return;
              target.textContent = summarize(health, true);
            }),
          );
        }
      }
    }

    // 2. Outbound stats per viewer for the roster while streaming
    if (capture) {
      const peerIds = [...members.keys()];
      runBackground(
        Promise.all(
          peerIds.map(async (peerId) => {
            const pc = activeMesh.getConnection(peerId);
            if (!pc) {
              peerOutboundText.delete(peerId);
              return { viewing: false, bps: 0 };
            }
            const viewing = activeMesh.isPeerViewing(peerId);
            if (!viewing) {
              peerOutboundText.set(peerId, "↑ paused");
              return { viewing: false, bps: 0 };
            }
            let outMon = outboundMonitors.get(peerId);
            if (!outMon) {
              outMon = new LinkMonitor(pc, "outbound");
              outboundMonitors.set(peerId, outMon);
            }
            const health = await outMon.read();
            if (!health) {
              peerOutboundText.set(peerId, "↑ connecting…");
              return { viewing: true, bps: 0 };
            }
            peerOutboundText.set(peerId, `↑ ${summarize(health, false)}`);
            return { viewing: true, bps: health.bitrate ?? 0 };
          }),
        ).then((results) => {
          if (!capture) return;
          activeViewerCount = results.filter((res) => res.viewing).length;
          const sumBps = results.reduce((acc, res) => acc + res.bps, 0);
          totalOutboundMbps = sumBps / 1e6;
          updateRosterStatsInPlace();
        }),
      );
    } else {
      peerOutboundText.clear();
      totalOutboundMbps = 0;
      activeViewerCount = 0;
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
    selfPreviewHidden = false;
    removeTile(id);
    return;
  }
  names.set(id, "You");
  const videoEl = tileFor(id);
  videoEl.muted = true;
  videoEl.srcObject = stream;
  const wrap = videoEl.closest<HTMLElement>(".tile");
  if (wrap) wrap.hidden = selfPreviewHidden;
  runBackground(videoEl.play());
  syncViewState();
}

// ---- participants --------------------------------------------------------

function hostTokenFor(code: string): string | undefined {
  try {
    return sessionStorage.getItem(`host:${code}`) ?? undefined;
  } catch {
    return undefined;
  }
}

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
    /* sessionStorage unavailable */
  }
}

function saveHostToken(code: string, token: string): void {
  try {
    sessionStorage.setItem(`host:${code}`, token);
  } catch {
    /* sessionStorage unavailable */
  }
}

function formatRosterHeaderTitle(totalCount: number): string {
  const lockSuffix = roomLocked ? ", locked" : "";
  if (capture) {
    const othersCount = Math.max(0, totalCount - 1);
    const mbpsPart = totalOutboundMbps > 0 ? ` · ↑ ${totalOutboundMbps.toFixed(1)} Mbps` : "";
    return `In this room (${totalCount}${lockSuffix})${mbpsPart} (${activeViewerCount}/${othersCount} watching)`;
  }
  return `In this room (${totalCount}${lockSuffix})`;
}

function updateRosterStatsInPlace(): void {
  if (!client || selfId === null) return;
  ui.rosterTitle.textContent = formatRosterHeaderTitle(members.size + 1);
  for (const elNode of ui.rosterList.querySelectorAll<HTMLElement>(".peer-stats")) {
    const pid = elNode.dataset["peer"];
    if (!pid) continue;
    elNode.textContent = capture ? (peerOutboundText.get(pid) ?? "") : "";
  }
}

function renderRoster(): void {
  if (!client || selfId === null) {
    ui.roster.hidden = true;
    ui.rosterList.replaceChildren();
    return;
  }
  const summary: RosterSummary = sortAndFormatRoster(
    selfId,
    currentName(),
    capture !== null,
    isHost,
    roomLocked,
    members,
  );

  ui.roster.hidden = activePopover !== "roster";
  ui.rosterBtn.textContent = summary.buttonLabel;
  ui.rosterTitle.textContent = formatRosterHeaderTitle(summary.totalCount);
  ui.lockBtn.hidden = !isHost;
  ui.lockBtn.textContent = roomLocked ? "Unlock room" : "Lock room";

  const items: HTMLLIElement[] = summary.entries.map((entry: RosterEntry) => {
    const li = document.createElement("li");

    const left = document.createElement("div");
    left.className = "roster-peer";

    const dot = document.createElement("span");
    dot.className = "ui-dot";
    if (entry.sharing) dot.dataset["state"] = "live";

    const nameEl = document.createElement("span");
    nameEl.className = "peer-name";
    nameEl.textContent = `${entry.name}${entry.self ? " (you)" : ""}${entry.host ? " (host)" : ""}`;

    const idEl = document.createElement("span");
    idEl.className = "peer-id";
    idEl.textContent = entry.shortId;

    left.append(dot, nameEl, idEl);

    if (entry.sharing) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "sharing";
      left.append(badge);
    }

    const right = document.createElement("div");
    right.className = "roster-meta";

    if (!entry.self) {
      const statsSpan = document.createElement("span");
      statsSpan.className = "peer-stats";
      statsSpan.dataset["peer"] = entry.id;
      statsSpan.textContent = capture ? (peerOutboundText.get(entry.id) ?? "") : "";
      right.append(statsSpan);
    }

    if (entry.canKick) {
      const kick = document.createElement("button");
      kick.type = "button";
      kick.className = "ui-btn kick-btn";
      kick.textContent = "Remove";
      kick.title = `Remove ${entry.name} from the room. They can't rejoin for 15 minutes.`;
      kick.addEventListener("click", () => client?.kick(entry.id));
      right.append(kick);
    }

    li.append(left, right);
    return li;
  });

  ui.rosterList.replaceChildren(...items);
}

// ---- sharing -------------------------------------------------------------

function isQualityPresetName(val: string | null): val is QualityPresetName {
  return val !== null && Object.hasOwn(QUALITY_PRESETS, val);
}

function currentPreset(): QualityPresetName {
  const stored = localStorage.getItem("preset");
  return isQualityPresetName(stored) ? stored : DEFAULT_PRESET;
}

const CODEC_NAMES = ["h264", "av1"] as const;

function isCodecName(val: string | null): val is CodecName {
  return val !== null && (CODEC_NAMES as readonly string[]).includes(val);
}

function currentCodec(): CodecName {
  const stored = localStorage.getItem("codec");
  return isCodecName(stored) ? stored : DEFAULT_CODEC;
}

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

function syncMuteAudioButton(): void {
  const audioState = deriveOutboundAudioState(
    capture !== null,
    Boolean(capture?.audio),
    Boolean(capture?.audio?.enabled),
  );
  ui.muteAudioBtn.disabled = audioState.disabled;
  ui.muteAudioBtn.classList.toggle("muted-active", audioState.muted);
  ui.muteAudioBtn.setAttribute("aria-pressed", audioState.ariaPressed);
  ui.muteAudioBtn.title = audioState.title;
  ui.muteAudioBtn.replaceChildren(
    createIcon(audioState.icon),
    document.createTextNode(audioState.text),
  );
}

function watchAudioEnded(track: MediaStreamTrack): void {
  track.addEventListener("ended", () => {
    if (capture?.audio !== track) return;
    capture.audio = null;
    if (mesh) runBackground(mesh.setAudioTrack(null));
    syncMuteAudioButton();
  });
}

const captureController = createCaptureController({
  onEnded: (reason: EndReason) => {
    runBackground(
      stopSharing().then(() => {
        if (reason === "follow-ended") setStatus("The game closed, so sharing stopped.", "warn");
      }),
    );
  },
  onVideoTrackSwapped: async (track, stream) => {
    if (!capture) return;
    await mesh?.setVideoTrack(track);
    renderSelfPreview(stream);
  },
  onFollowState: (state) => renderFollowChip(state),
});

function renderFollowChip(state: FollowState | null): void {
  if (!state) {
    ui.followChip.hidden = true;
    return;
  }
  ui.followChip.hidden = false;
  ui.followDot.dataset["state"] = state.role === "waiting" ? "warn" : "live";
  ui.followChipText.textContent =
    state.role === "waiting"
      ? `Following ${state.profile}: waiting…`
      : `Following ${state.profile}: ${state.role === "game" ? "in game" : "lobby"}`;
  ui.followChip.title = state.title ?? "";
}

let sharingPending = false;

async function startSharing(): Promise<void> {
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

  if (captureController.kind === "web") {
    const audio = windowAudioSupport();
    if (!audio.supported && audio.reason) setStatus(audio.reason, "warn");
  }

  try {
    capture = await captureController.start(QUALITY_PRESETS[currentPreset()]);
  } catch (err) {
    console.warn("[main] capture cancelled or failed", err);
    return;
  }

  selfPreviewHidden = false;
  if (capture.audio) watchAudioEnded(capture.audio);
  renderSelfPreview(capture.stream);

  client?.setSharing(true);
  try {
    await mesh.setCapture(capture);
  } catch (err) {
    console.error("[main] failed to attach capture to peers", err);
    setStatus("Could not start sharing to peers. Screen capture stopped.", "error");
    await stopSharing();
    return;
  }

  syncMuteAudioButton();
  syncViewState();
  renderRoster();
}

let stoppingShare = false;

async function stopSharing(): Promise<void> {
  if (!capture || stoppingShare) return;
  stoppingShare = true;
  try {
    await mesh?.setCapture(null);
  } finally {
    captureController.stop();
    capture = null;
    stoppingShare = false;
  }
  outboundMonitors.clear();
  peerOutboundText.clear();
  totalOutboundMbps = 0;
  activeViewerCount = 0;
  renderSelfPreview(null);
  client?.setSharing(false);
  syncMuteAudioButton();
  syncViewState();
  renderRoster();
}

// ---- room ----------------------------------------------------------------

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

function syncNameInputs(value: string): void {
  const clean = value.trim().slice(0, 32);
  ui.nameInput.value = clean;
  ui.roomNameInput.value = clean;
  if (clean) localStorage.setItem("name", clean);
  if (selfId !== null) {
    renderRoster();
  }
}

let joinGeneration = 0;
let reopenRosterOnWelcome = false;

const RECONNECT_GRACE_MS = 8_000;
const peerLeftTimers = new Map<PeerId, ReturnType<typeof setTimeout>>();

function teardownPeer(peerId: PeerId): void {
  const timer = peerLeftTimers.get(peerId);
  if (timer) {
    clearTimeout(timer);
    peerLeftTimers.delete(peerId);
  }
  mesh?.removeMember(peerId);
  names.delete(peerId);
  members.delete(peerId);
  listening.delete(peerId);
  outboundMonitors.delete(peerId);
  peerOutboundText.delete(peerId);
  removeTile(peerId);
  renderRoster();
}

async function joinRoom(code: string): Promise<void> {
  if (!isValidRoomCode(code)) {
    setStatus("That doesn't look like a valid room code.", "error");
    return;
  }

  const codeToJoin = code;
  if (capture && lastJoin && lastJoin.code !== code) await stopSharing();
  leaveRoom();
  const generation = ++joinGeneration;
  if (generation !== joinGeneration) return;
  const displayName = currentName();
  lastJoin = { code };
  syncCopyLinkButton();

  client = new SignalingClient(
    code,
    displayName,
    {
      onStatus: (status) => {
        if (status === "open") {
          setStatus(`In room ${code}`, "info");
        } else {
          setStatus(`Connection ${status}…`, "warn");
        }
      },

      onWelcome: (selfIdFromServer, peers, room) => {
        for (const timer of peerLeftTimers.values()) clearTimeout(timer);
        peerLeftTimers.clear();

        if (
          mesh !== null &&
          selfId !== null &&
          selfId === selfIdFromServer
        ) {
          const activeMesh = mesh;
          if (room.hostToken) saveHostToken(code, room.hostToken);
          saveRejoinToken(code, room.rejoinToken);
          isHost = room.host;
          roomLocked = room.locked;

          const welcomePeerIds = new Set(peers.map((p) => p.id));
          for (const id of [...members.keys()]) {
            if (!welcomePeerIds.has(id)) {
              teardownPeer(id);
            }
          }

          for (const p of peers) {
            names.set(p.id, p.name);
            members.set(p.id, { name: p.name, sharing: p.sharing, host: p.host === true });
            const existingVideo = tiles.get(p.id);
            if (existingVideo) {
              const label = existingVideo.closest(".tile")?.querySelector(".tile-label");
              if (label) label.textContent = p.name;
              if (!p.sharing) removeTile(p.id);
            }
            activeMesh.setMemberSharing(p.id, p.sharing);
          }

          if (capture) {
            client?.setSharing(true);
            if (!tiles.has(SELF_TILE)) renderSelfPreview(capture.stream);
          }

          setStatus(`In room ${code} — ${peers.length + 1}/${MAX_ROOM_SIZE} connected`, "info");
          syncCopyLinkButton();
          syncViewState();
          startHealthPolling();
          renderRoster();
          if (reopenRosterOnWelcome) {
            reopenRosterOnWelcome = false;
            applyPopoverState("roster");
          }
          return;
        }

        mesh?.close();
        inboundMonitors.clear();
        outboundMonitors.clear();
        peerOutboundText.clear();
        members.clear();
        listening.clear();
        selfId = null;
        if (room.hostToken) saveHostToken(code, room.hostToken);
        saveRejoinToken(code, room.rejoinToken);

        for (const id of [...tiles.keys()]) {
          if (id !== SELF_TILE) removeTile(id);
        }
        if (tiles.has(SELF_TILE)) names.set(SELF_TILE, "You");
        isHost = room.host;
        roomLocked = room.locked;

        mesh = new Mesh(
          selfIdFromServer,
          {
            iceServers: ICE_SERVERS,
            preset: QUALITY_PRESETS[currentPreset()],
            codec: currentCodec(),
            jitterBufferTargetMs: 150,
          },
          (to, data) => client?.signal(to, data),
          {
            onRemoteStream: (peerId, stream) => {
              const video = tileFor(peerId);
              if (video.srcObject !== stream) {
                video.srcObject = stream;
                stream.addEventListener("addtrack", () => applyAudio(peerId));
                stream.addEventListener("removetrack", () => applyAudio(peerId));
              }
              applyAudio(peerId);
              startPlayback(video, peerId);
              syncViewState();
            },
            onRemoteStreamGone: (peerId) => removeTile(peerId),
            onConnectionState: (peerId, state) => {
              if ((state === "failed" || state === "closed") && peerLeftTimers.has(peerId)) {
                teardownPeer(peerId);
              }
              if (state === "failed") {
                console.warn(`[main] connection to ${peerId} failed`);
              }
            },
          },
        );

        selfId = selfIdFromServer;
        for (const p of peers) {
          names.set(p.id, p.name);
          members.set(p.id, { name: p.name, sharing: p.sharing, host: p.host === true });
          mesh.addMember(p.id, p.sharing);
        }
        setStatus(`In room ${code} — ${peers.length + 1}/${MAX_ROOM_SIZE} connected`, "info");
        if (capture) {
          client?.setSharing(true);
          if (!tiles.has(SELF_TILE)) renderSelfPreview(capture.stream);
          void mesh.setCapture(capture);
        }
        syncCopyLinkButton();
        syncViewState();
        startHealthPolling();
        renderRoster();
        if (reopenRosterOnWelcome) {
          reopenRosterOnWelcome = false;
          applyPopoverState("roster");
        }
      },

      onPeerJoined: (peer: PeerInfo) => {
        if (peerLeftTimers.has(peer.id)) {
          clearTimeout(peerLeftTimers.get(peer.id));
          peerLeftTimers.delete(peer.id);
        }
        names.set(peer.id, peer.name);
        members.set(peer.id, { name: peer.name, sharing: peer.sharing, host: peer.host === true });
        mesh?.addMember(peer.id, peer.sharing);
        setStatus(`${peer.name} joined room ${code}`, "info");
        renderRoster();
      },
      onPeerLeft: (id) => {
        if (mesh?.hasConnectedLink(id)) {
          if (peerLeftTimers.has(id)) {
            clearTimeout(peerLeftTimers.get(id));
          }
          const timer = setTimeout(() => {
            teardownPeer(id);
          }, RECONNECT_GRACE_MS);
          peerLeftTimers.set(id, timer);
        } else {
          teardownPeer(id);
        }
      },
      onSignal: (from, data) => void mesh?.handleSignal(from, data),
      onPeerState: (id, sharing) => {
        if (peerLeftTimers.has(id)) {
          clearTimeout(peerLeftTimers.get(id));
          peerLeftTimers.delete(id);
        }
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
      onError: (codeErr, message) => {
        if (codeErr === "kicked") {
          void stopSharing();
          saveRejoinToken(codeToJoin, undefined);
          lastJoin = null;
          leaveRoom();
          setStatus("You were removed from this room by its host.", "error");
          return;
        }
        if (codeErr === "room-locked") {
          void stopSharing();
          lastJoin = null;
          leaveRoom();
          setStatus(`Room ${codeToJoin} is locked. Ask its host to unlock it.`, "error");
          return;
        }
        if (codeErr === "not-host") {
          setStatus(message, "warn");
          return;
        }
        if (codeErr === "unknown-peer" || codeErr === "not-sharing") {
          return;
        }
        setStatus(`${codeErr}: ${message}`, "error");
      },
    },
    () => ({ hostToken: hostTokenFor(code), rejoinToken: rejoinTokenFor(code) }),
  );

  client.connect();
  location.hash = code;
}

function leaveRoom(): void {
  joinGeneration++;
  reopenRosterOnWelcome = false;
  for (const timer of peerLeftTimers.values()) clearTimeout(timer);
  peerLeftTimers.clear();
  stopHealthPolling();
  if (capture) client?.setSharing(false);
  client?.close();
  client = null;
  mesh?.close();
  mesh = null;
  inboundMonitors.clear();
  outboundMonitors.clear();
  peerOutboundText.clear();
  totalOutboundMbps = 0;
  activeViewerCount = 0;
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
  syncViewState();
}

// ---- quality & audio controls --------------------------------------------

const CODEC_META: Record<CodecName, { title: string; hint: string }> = {
  h264: { title: "H.264", hint: "Hardware · Best for gaming" },
  av1: { title: "AV1", hint: "Best quality · Modern GPU" },
};

function applyPopoverState(target: PopoverKind | null): void {
  const previous = activePopover;
  const state = nextPopoverState(
    activePopover,
    target,
    selfId !== null && client !== null,
    capture !== null,
  );
  activePopover = state.active;
  ui.roster.hidden = !state.rosterOpen;
  ui.presetMenu.hidden = !state.presetOpen;
  ui.codecMenu.hidden = !state.codecOpen;
  ui.rosterBtn.setAttribute("aria-expanded", String(state.rosterOpen));
  ui.presetBtn.setAttribute("aria-expanded", String(state.presetOpen));
  ui.codecBtn.setAttribute("aria-expanded", String(state.codecOpen));
  if (previous !== null && previous !== state.active) {
    const menu = previous === "roster" ? ui.roster : previous === "preset" ? ui.presetMenu : ui.codecMenu;
    const trigger = previous === "roster" ? ui.rosterBtn : previous === "preset" ? ui.presetBtn : ui.codecBtn;
    if (menu.contains(document.activeElement)) trigger.focus();
  }
}

function closeAllPopovers(): void {
  applyPopoverState(null);
}

function togglePopover(which: PopoverKind): void {
  applyPopoverState(which);
}

function syncPresetMenuSelection(selected: QualityPresetName): void {
  ui.presetBtnLabel.textContent = QUALITY_PRESETS[selected].label;
  for (const btn of ui.presetList.querySelectorAll<HTMLButtonElement>(".popover-item")) {
    const active = btn.dataset["preset"] === selected;
    btn.setAttribute("aria-pressed", String(active));
    const dot = btn.querySelector<HTMLElement>(".ui-dot");
    if (dot) {
      if (active) dot.dataset["state"] = "active";
      else delete dot.dataset["state"];
    }
  }
}

function syncCodecMenuSelection(selected: CodecName): void {
  ui.codecBtnLabel.textContent = CODEC_META[selected].title;
  for (const btn of ui.codecList.querySelectorAll<HTMLButtonElement>(".popover-item")) {
    const active = btn.dataset["codec"] === selected;
    btn.setAttribute("aria-pressed", String(active));
    const dot = btn.querySelector<HTMLElement>(".ui-dot");
    if (dot) {
      if (active) dot.dataset["state"] = "active";
      else delete dot.dataset["state"];
    }
  }
}

function initQualityControls(): void {
  localStorage.removeItem("audio_mode");
  for (const [name, preset] of Object.entries(QUALITY_PRESETS)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "popover-item";
    btn.dataset["preset"] = name;

    const left = document.createElement("span");
    left.className = "popover-item-left";
    const dot = document.createElement("span");
    dot.className = "ui-dot";
    left.append(dot, document.createTextNode(preset.label));

    const right = document.createElement("span");
    right.className = "popover-item-right";
    right.textContent = `${(preset.maxBitrate / 1e6).toFixed(0)} Mbps`;

    btn.append(left, right);
    btn.addEventListener("click", () => {
      if (!isQualityPresetName(name)) return;
      localStorage.setItem("preset", name);
      syncPresetMenuSelection(name);
      closeAllPopovers();
      captureController.setPreset(QUALITY_PRESETS[name]);
      if (mesh) runBackground(mesh.setPreset(QUALITY_PRESETS[name]));
    });
    ui.presetList.append(btn);
  }
  syncPresetMenuSelection(currentPreset());

  for (const [name, meta] of Object.entries(CODEC_META)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "popover-item";
    btn.dataset["codec"] = name;

    const left = document.createElement("span");
    left.className = "popover-item-left";
    const dot = document.createElement("span");
    dot.className = "ui-dot";
    left.append(dot, document.createTextNode(meta.title));

    const right = document.createElement("span");
    right.className = "popover-item-right";
    right.textContent = meta.hint;

    btn.append(left, right);
    btn.addEventListener("click", () => {
      if (!isCodecName(name)) return;
      localStorage.setItem("codec", name);
      syncCodecMenuSelection(name);
      closeAllPopovers();
      mesh?.setCodec(name);
    });
    ui.codecList.append(btn);
  }
  syncCodecMenuSelection(currentCodec());

  ui.presetBtn.addEventListener("click", () => {
    togglePopover("preset");
  });

  ui.codecBtn.addEventListener("click", () => {
    togglePopover("codec");
  });

  ui.muteAudioBtn.addEventListener("click", () => {
    if (!capture?.audio) return;
    capture.audio.enabled = !capture.audio.enabled;
    syncMuteAudioButton();
  });
  syncMuteAudioButton();

  ui.togglePreviewBtn.addEventListener("click", () => {
    selfPreviewHidden = false;
    const videoEl = tiles.get(SELF_TILE);
    const wrap = videoEl?.closest<HTMLElement>(".tile");
    if (wrap) wrap.hidden = false;
    syncViewState();
  });
}

initQualityControls();

// ---- roster & header controls --------------------------------------------

ui.rosterBtn.addEventListener("click", () => {
  togglePopover("roster");
});

document.addEventListener("click", (ev) => {
  if (activePopover === null) return;
  if (ev.target instanceof Element && ev.target.closest(".popover-anchor")) return;
  closeAllPopovers();
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && activePopover !== null) {
    closeAllPopovers();
  }
});

ui.lockBtn.addEventListener("click", () => {
  client?.setLocked(!roomLocked);
});

ui.brandHomeBtn.addEventListener("click", () => {
  if (!client && !lastJoin && !capture) return;
  closeAllPopovers();
  runBackground(stopSharing());
  lastJoin = null;
  leaveRoom();
  history.replaceState(null, "", location.pathname + location.search);
  setStatus("", "info");
});

const initialStoredName = localStorage.getItem("name") ?? "";
ui.nameInput.value = initialStoredName;
ui.roomNameInput.value = initialStoredName;

ui.nameInput.addEventListener("change", () => {
  syncNameInputs(ui.nameInput.value);
});

ui.roomNameInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    ui.roomNameInput.blur();
  }
});

ui.roomNameInput.addEventListener("change", () => {
  syncNameInputs(ui.roomNameInput.value);
  // Only reconnect in place when not actively sharing so renaming never interrupts an active stream.
  if (client && lastJoin && !capture) {
    const wasOpen = activePopover === "roster";
    runBackground(joinRoom(lastJoin.code));
    reopenRosterOnWelcome = wasOpen;
  }
});

{
  const blocked = captureBlockedReason();
  if (blocked) {
    setStatus(blocked, "error");
    ui.shareBtn.title = blocked;
  }
}

// ---- lobby & deep-link wiring --------------------------------------------

ui.joinBtn.addEventListener("click", () => {
  runBackground(joinRoom(ui.roomInput.value.trim().toUpperCase()));
});

ui.roomInput.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  const code = ui.roomInput.value.trim().toUpperCase();
  runBackground(joinRoom(code));
});

ui.createBtn.addEventListener("click", () => {
  runBackground(
    (async () => {
      try {
        const res = await fetch("/api/room");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseNewRoomResponse(await res.json());
        if (!parsed) throw new Error("server returned an invalid room code");
        const { code } = parsed;
        ui.roomInput.value = code;
        await joinRoom(code);
      } catch (err) {
        console.error("[main] could not create a room", err);
        setStatus("Could not create a room. Check your connection and try again.", "error");
      }
    })(),
  );
});

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
    } catch {
      /* execCommand fallback failed */
    }
  }
  if (copied) {
    if (copyFeedbackTimeout !== null) clearTimeout(copyFeedbackTimeout);
    ui.copyLinkBtn.textContent = `${code} · Copied!`;
    ui.copyLinkBtn.classList.add("copied");
    setStatus(`Copied room link: ${url}`, "info");
    copyFeedbackTimeout = setTimeout(() => {
      ui.copyLinkBtn.classList.remove("copied");
      copyFeedbackTimeout = null;
      syncCopyLinkButton();
    }, 2000);
  } else {
    setStatus(`Could not copy link automatically. Room link: ${url}`, "warn");
  }
}

ui.copyLinkBtn.addEventListener("click", () => {
  runBackground(copyRoomLink());
});

ui.shareBtn.addEventListener("click", () => {
  runBackground(capture ? stopSharing() : startSharing());
});

window.addEventListener("beforeunload", () => leaveRoom());
window.addEventListener("pagehide", () => leaveRoom());

function joinFromHash(): void {
  const fromHash = location.hash.replace(/^#/, "").toUpperCase();
  if (!isValidRoomCode(fromHash)) return;
  if (lastJoin?.code === fromHash && client) return;
  ui.roomInput.value = fromHash;
  runBackground(joinRoom(fromHash));
}

syncViewState();
joinFromHash();
window.addEventListener("hashchange", joinFromHash);
