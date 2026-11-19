/**
 * App bootstrap: wires signalling -> mesh -> DOM tiles.
 *
 * Everything latency-critical lives in mesh.ts / quality.ts. This file is glue.
 */

import {
  MAX_ROOM_SIZE,
  formatInviteCode,
  isValidRoomCode,
  parseInviteInput,
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
import {
  HOST_ROOMS_STORAGE_KEY,
  clearAllPersistedHostTokens,
  clearLegacySessionHostTokens,
  hasAnyPersistedHostTokens,
  readPersistedHostToken,
  removePersistedHostTokenIfMatching,
  runWithHostRoomsLock,
  writePersistedHostToken,
} from "./host-tokens";
import { createCaptureController } from "./platform";
import type { EndReason, FollowState } from "./platform/types";
import {
  DEFAULT_CODEC,
  DEFAULT_DEGRADATION_MODE,
  type CodecName,
  type DegradationMode,
} from "./quality";
import { SignalingClient } from "./signaling";
import { LinkMonitor, summarize } from "./stats";
import {
  computeVolumeState,
  deriveInviteMenuState,
  deriveOutboundAudioState,
  deriveViewState,
  describeInviteParseFailure,
  formatJoinChipText,
  nextPopoverState,
  shouldRequestRemoteVideo,
  sortAndFormatRoster,
  type JoinChipArrival,
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
  lobbyError: el<HTMLElement>("lobby-error"),
  lobbyForgetHostsBtn: el<HTMLButtonElement>("lobby-forget-hosts"),
  joinBtn: el<HTMLButtonElement>("join"),
  createBtn: el<HTMLButtonElement>("create"),
  brandHomeBtn: el<HTMLButtonElement>("brand-home"),
  roomBar: el<HTMLElement>("room-bar"),
  inviteBtn: el<HTMLButtonElement>("invite-btn"),
  inviteMenu: el<HTMLElement>("invite-menu"),
  inviteRotateBtn: el<HTMLButtonElement>("invite-rotate-btn"),
  inviteLockedNote: el<HTMLElement>("invite-locked-note"),
  inviteCopyLinkBtn: el<HTMLButtonElement>("invite-copy-link"),
  inviteLinkFeedback: el<HTMLElement>("invite-link-feedback"),
  inviteCodeRow: el<HTMLElement>("invite-code-row"),
  inviteCodeValue: el<HTMLElement>("invite-code-value"),
  inviteShowBtn: el<HTMLButtonElement>("invite-show-btn"),
  inviteCopyCodeBtn: el<HTMLButtonElement>("invite-copy-code"),
  inviteForgetHostBtn: el<HTMLButtonElement>("invite-forget-host"),
  rosterBtn: el<HTMLButtonElement>("roster-btn"),
  rosterUnreadDot: el<HTMLElement>("roster-unread-dot"),
  rosterBtnLabel: el<HTMLElement>("roster-btn-label"),
  roster: el<HTMLElement>("roster"),
  rosterTitle: el<HTMLElement>("roster-title"),
  rosterList: el<HTMLUListElement>("roster-list"),
  lockBtn: el<HTMLButtonElement>("lock-btn"),
  followChip: el<HTMLElement>("follow-chip"),
  followDot: el<HTMLElement>("follow-dot"),
  followChipText: el<HTMLElement>("follow-chip-text"),
  status: el<HTMLElement>("status"),
  stage: el<HTMLDivElement>("stage"),
  joinChip: el<HTMLElement>("join-chip"),
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
  degradationBtn: el<HTMLButtonElement>("degradation-btn"),
  degradationBtnLabel: el<HTMLElement>("degradation-btn-label"),
  degradationMenu: el<HTMLElement>("degradation-menu"),
  degradationList: el<HTMLElement>("degradation-list"),
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
let roomPassword: string | null = null;
/** Our own id in the current room, once welcomed. */
let selfId: PeerId | null = null;
/** The room of the current connection, so it can be redone in place. */
let lastJoin: { code: string } | null = null;

/** Arrivals since `#roster` was last opened/viewed (cleared when closing roster). */
const unreadPeerIds = new Set<PeerId>();
/** Short departure window so reconnects / F5 reloads suppress duplicate join notifications. */
const recentDepartures = new Map<PeerId, number>();
const RECENT_DEPARTURE_MS = 8_000;
const joinChipArrivals: JoinChipArrival[] = [];
let joinChipTimer: ReturnType<typeof setTimeout> | null = null;
let joinChipMirror: HTMLElement | null = null;
const JOIN_CHIP_DURATION_MS = 2_800;

let inviteRevealed = false;
let inviteRevealTimer: ReturnType<typeof setTimeout> | null = null;
let linkFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
let codeFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
let rotateFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
let inviteRotatePending = false;
let inviteRotateTimeout: ReturnType<typeof setTimeout> | null = null;
const pendingKicks = new Map<PeerId, { name: string; timer: ReturnType<typeof setTimeout> }>();
let transientNoticeTimer: ReturnType<typeof setTimeout> | null = null;
let activeTransientNotice: string | null = null;

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
  ui.controls.hidden = state.controlsHidden;
  ui.liveControls.hidden = state.liveControlsHidden;
  ui.muteAudioBtn.hidden = state.muteAudioHidden;
  ui.togglePreviewBtn.hidden = state.togglePreviewHidden;
  ui.shareBtn.textContent = state.shareButtonText;
  ui.shareBtn.className = `ui-btn ${state.shareButtonVariant}`;

  if (client === null) {
    applyPopoverState(null);
  } else if (
    !sharing &&
    (activePopover === "preset" || activePopover === "codec" || activePopover === "degradation")
  ) {
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

function setLobbyError(message: string | null): void {
  ui.lobbyError.textContent = message ?? "";
  ui.lobbyError.hidden = message === null || message.length === 0;
  ui.roomInput.classList.toggle("input-error", message !== null && message.length > 0);
}

function formatTileLabel(peerId: PeerId, name: string): string {
  if (peerId === SELF_TILE) return "You";
  return `${name} #${peerId.slice(0, 4)}`;
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
  label.textContent = formatTileLabel(peerId, names.get(peerId) ?? "Peer");

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
  renderJoinChip();
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
      const peerIds = [...new Set([...members.keys(), ...activeMesh.peers()])];
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

const memorySession = new Map<string, string>();
const creatorHostTokens = new Map<string, string>();
const sessionHostTokens = new Map<string, string>();

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

function safeLocks(): LockManager | null {
  try {
    return typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : null;
  } catch {
    return null;
  }
}

function readSession(key: string): string | undefined {
  const cached = memorySession.get(key);
  if (cached !== undefined) return cached;
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeSession(key: string, value: string | undefined): void {
  if (value !== undefined) memorySession.set(key, value);
  else memorySession.delete(key);
  try {
    if (value !== undefined) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    /* sessionStorage unavailable */
  }
}

function activeRoomFor(): string | undefined {
  return readSession("activeRoom");
}

function saveActiveRoom(code: string | undefined): void {
  writeSession("activeRoom", code);
}

function hasSavedCreatorHostFor(code: string): boolean {
  return creatorHostTokens.has(code) || readPersistedHostToken(safeLocalStorage(), code) !== undefined;
}

function syncForgetHostUi(): void {
  const hasSaved = creatorHostTokens.size > 0 || hasAnyPersistedHostTokens(safeLocalStorage());
  ui.lobbyForgetHostsBtn.hidden = !hasSaved;
  if (lastJoin !== null) {
    ui.inviteForgetHostBtn.hidden = !hasSavedCreatorHostFor(lastJoin.code);
  } else {
    ui.inviteForgetHostBtn.hidden = true;
  }
}

function saveCreatorHostToken(code: string, token: string): void {
  creatorHostTokens.set(code, token);
  syncForgetHostUi();
  runBackground(
    runWithHostRoomsLock(safeLocks(), () => {
      writePersistedHostToken(safeLocalStorage(), code, token);
      syncForgetHostUi();
    }),
  );
}

function saveSessionHostToken(code: string, token: string): void {
  sessionHostTokens.set(code, token);
  syncForgetHostUi();
}

function forgetCreatorHostToken(code: string, onlyIfMatching?: string): void {
  if (onlyIfMatching === undefined || sessionHostTokens.get(code) === onlyIfMatching) {
    sessionHostTokens.delete(code);
  }
  if (onlyIfMatching === undefined || creatorHostTokens.get(code) === onlyIfMatching) {
    creatorHostTokens.delete(code);
  }
  if (onlyIfMatching === undefined) {
    writeSession(`host:${code}`, undefined);
  }
  syncForgetHostUi();
  runBackground(
    runWithHostRoomsLock(safeLocks(), () => {
      if (onlyIfMatching !== undefined) {
        removePersistedHostTokenIfMatching(safeLocalStorage(), code, onlyIfMatching);
      } else {
        writePersistedHostToken(safeLocalStorage(), code, undefined);
      }
      syncForgetHostUi();
    }),
  );
}

function hostTokenFor(code: string): string | undefined {
  const promoted = sessionHostTokens.get(code);
  if (promoted !== undefined) return promoted;
  const inMemoryCreator = creatorHostTokens.get(code);
  if (inMemoryCreator !== undefined) return inMemoryCreator;
  const persisted = readPersistedHostToken(safeLocalStorage(), code);
  if (persisted !== undefined) {
    creatorHostTokens.set(code, persisted);
    return persisted;
  }
  const legacy = readSession(`host:${code}`);
  if (legacy !== undefined) {
    writeSession(`host:${code}`, undefined);
    saveCreatorHostToken(code, legacy);
    return legacy;
  }
  return undefined;
}

function rejoinTokenFor(code: string): string | undefined {
  return readSession(`rejoin:${code}`);
}

function saveRejoinToken(code: string, token: string | undefined): void {
  writeSession(`rejoin:${code}`, token);
}

function clearRoomSession(code?: string): void {
  const target = code ?? lastJoin?.code ?? activeRoomFor();
  saveActiveRoom(undefined);
  if (!target) return;
  sessionHostTokens.delete(target);
  saveRejoinToken(target, undefined);
}

function scrubRoomUrl(): void {
  if (location.hash.length === 0) return;
  history.replaceState(null, "", location.pathname + location.search);
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn("[main] clipboard.writeText failed, using fallback", err);
  }
  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    prevFocus?.focus?.({ preventScroll: true });
    return ok;
  } catch {
    prevFocus?.focus?.({ preventScroll: true });
    return false;
  }
}

function clearRotatePendingTimer(): void {
  if (inviteRotateTimeout !== null) {
    clearTimeout(inviteRotateTimeout);
    inviteRotateTimeout = null;
  }
}

function resetInviteCopyFeedback(): void {
  if (linkFeedbackTimer !== null) {
    clearTimeout(linkFeedbackTimer);
    linkFeedbackTimer = null;
  }
  if (codeFeedbackTimer !== null) {
    clearTimeout(codeFeedbackTimer);
    codeFeedbackTimer = null;
  }
  ui.inviteLinkFeedback.textContent = "";
  ui.inviteLinkFeedback.classList.remove("invite-feedback-ok");
  ui.inviteCopyLinkBtn.classList.remove("invite-feedback-ok");
  ui.inviteCopyCodeBtn.textContent = "Copy";
  ui.inviteCopyCodeBtn.classList.remove("invite-feedback-ok");
}

function setInviteRevealed(revealed: boolean): void {
  if (inviteRevealTimer !== null) {
    clearTimeout(inviteRevealTimer);
    inviteRevealTimer = null;
  }
  inviteRevealed = revealed;
  if (revealed) {
    inviteRevealTimer = setTimeout(() => {
      inviteRevealTimer = null;
      inviteRevealed = false;
      renderInviteMenu();
    }, 10_000);
  }
  renderInviteMenu();
}

function renderInviteMenu(): void {
  const code = lastJoin?.code ?? null;
  const state = deriveInviteMenuState({
    roomCode: code,
    roomPassword,
    roomLocked,
    isHost,
    revealed: inviteRevealed,
    signalingReady: Boolean(client?.isReady),
    rotating: inviteRotatePending,
  });
  ui.inviteMenu.hidden = activePopover !== "invite";
  ui.inviteRotateBtn.hidden = !isHost || code === null;
  ui.inviteRotateBtn.disabled = !state.canRotate;
  if (!inviteRotatePending && ui.inviteRotateBtn.textContent === "Rotating\u2026") {
    ui.inviteRotateBtn.textContent = "Rotate";
  }
  ui.inviteLockedNote.hidden = !state.showLockedBanner;
  ui.inviteCopyLinkBtn.disabled = !state.canCopy;
  ui.inviteCodeRow.classList.toggle("is-disabled", !state.canCopy);
  ui.inviteCodeValue.textContent = state.displayCode;
  ui.inviteShowBtn.disabled = !state.canShow;
  ui.inviteShowBtn.textContent = inviteRevealed && state.canShow ? "Hide" : "Show";
  ui.inviteCopyCodeBtn.disabled = !state.canCopy;
  ui.inviteForgetHostBtn.hidden = !(code !== null && hasSavedCreatorHostFor(code));
}

function pruneDepartures(now: number): void {
  for (const [k, ts] of recentDepartures) {
    if (now - ts >= RECENT_DEPARTURE_MS) recentDepartures.delete(k);
  }
}

function recordDeparture(id: PeerId): void {
  const now = Date.now();
  pruneDepartures(now);
  recentDepartures.set(id, now);
}

function wasRecentDeparture(id: PeerId): boolean {
  const now = Date.now();
  pruneDepartures(now);
  return recentDepartures.has(id);
}

function renderRosterUnreadDot(): void {
  const hasUnread = unreadPeerIds.size > 0 && activePopover !== "roster";
  ui.rosterUnreadDot.hidden = !hasUnread;
  ui.rosterBtn.classList.toggle("has-unread", hasUnread);
}

function renderJoinChip(): void {
  if (joinChipMirror) {
    joinChipMirror.remove();
    joinChipMirror = null;
  }
  const text = formatJoinChipText(joinChipArrivals);
  if (!text || !client || selfId === null) {
    ui.joinChip.textContent = "";
    ui.joinChip.hidden = true;
    return;
  }
  ui.joinChip.textContent = text;
  ui.joinChip.hidden = false;

  const fsEl = typeof document !== "undefined" ? document.fullscreenElement : null;
  if (fsEl instanceof HTMLElement && fsEl.classList.contains("tile")) {
    const mirror = document.createElement("div");
    mirror.className = "join-chip join-chip-mirror";
    mirror.setAttribute("role", "status");
    mirror.setAttribute("aria-live", "polite");
    mirror.textContent = text;
    fsEl.append(mirror);
    joinChipMirror = mirror;
  }
}

function pauseJoinChipTimer(): void {
  if (joinChipTimer !== null) {
    clearTimeout(joinChipTimer);
    joinChipTimer = null;
  }
}

function clearJoinChip(): void {
  pauseJoinChipTimer();
  joinChipArrivals.length = 0;
  renderJoinChip();
}

function armJoinChipTimer(): void {
  pauseJoinChipTimer();
  if (joinChipArrivals.length === 0) return;
  if (typeof document !== "undefined" && (document.hidden || !document.hasFocus())) {
    return;
  }
  joinChipTimer = setTimeout(() => {
    joinChipTimer = null;
    joinChipArrivals.length = 0;
    renderJoinChip();
  }, JOIN_CHIP_DURATION_MS);
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
  const distinctPeers = new Set<string>([
    ...members.keys(),
    ...(mesh ? mesh.memberIds() : []),
    ...(mesh ? mesh.peers() : []),
  ]);
  distinctPeers.delete(selfId);
  ui.rosterTitle.textContent = formatRosterHeaderTitle(distinctPeers.size + 1);
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
    renderRosterUnreadDot();
    return;
  }
  const extraPeerIds = mesh ? [...mesh.memberIds(), ...mesh.peers()] : [];
  const summary: RosterSummary = sortAndFormatRoster(
    selfId,
    currentName(),
    capture !== null,
    isHost,
    roomLocked,
    members,
    {
      newPeerIds: unreadPeerIds,
      extraPeerIds,
    },
  );

  ui.roster.hidden = activePopover !== "roster";
  ui.rosterBtnLabel.textContent = summary.buttonLabel;
  renderRosterUnreadDot();
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
    nameEl.textContent = entry.name;

    left.append(dot, nameEl);

    if (entry.self) {
      const youBadge = document.createElement("span");
      youBadge.className = "role-badge";
      youBadge.textContent = "you";
      left.append(youBadge);
    }

    if (entry.host) {
      const hostBadge = document.createElement("span");
      hostBadge.className = "role-badge";
      hostBadge.textContent = "host";
      left.append(hostBadge);
    }

    const idEl = document.createElement("span");
    idEl.className = "peer-id";
    idEl.textContent = entry.shortId;
    left.append(idEl);

    if (entry.sharing) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "sharing";
      left.append(badge);
    }

    if (entry.isNew) {
      const newTag = document.createElement("span");
      newTag.className = "tag-new";
      newTag.textContent = "new";
      left.append(newTag);
    }

    if (entry.duplicateName) {
      const dupTag = document.createElement("span");
      dupTag.className = "tag-dup";
      dupTag.textContent = "same name";
      left.append(dupTag);
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
      kick.disabled = pendingKicks.has(entry.id);
      kick.title = `Remove ${entry.name} from the room and rotate the invite link (blocks their network for 15 minutes).`;
      kick.addEventListener("click", () => {
        if (!client?.isReady || pendingKicks.has(entry.id)) return;
        kick.disabled = true;
        const timer = setTimeout(() => {
          pendingKicks.delete(entry.id);
          renderRoster();
        }, 10_000);
        pendingKicks.set(entry.id, { name: entry.name, timer });
        client.kick(entry.id);
        if (!members.has(entry.id)) teardownPeer(entry.id);
      });
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

const DEGRADATION_MODES = ["framerate", "clarity"] as const;

function isDegradationMode(val: string | null): val is DegradationMode {
  return val !== null && (DEGRADATION_MODES as readonly string[]).includes(val);
}

function currentDegradation(): DegradationMode {
  const stored = localStorage.getItem("stream-degradation");
  return isDegradationMode(stored) ? stored : DEFAULT_DEGRADATION_MODE;
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
  const shareGen = joinGeneration;
  closeAllPopovers();
  setInviteRevealed(false);

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
  if (shareGen !== joinGeneration || !mesh) {
    captureController.stop();
    capture = null;
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
  if (shareGen !== joinGeneration || !mesh) {
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

const SESSION_WIPING_ERRORS: ReadonlySet<string> = new Set([
  "kicked",
  "room-locked",
  "bad-password",
  "bad-room-code",
  "session-replaced",
  "forbidden-origin",
]);

const CREATOR_TOKEN_WIPING_ERRORS: ReadonlySet<string> = new Set([
  "kicked",
  "bad-room-code",
]);

function connectedRoomStatusText(code: string): string {
  return `In room ${code} \u2014 ${members.size + 1}/${MAX_ROOM_SIZE} connected`;
}

function clearTransientNoticeTimer(): void {
  if (transientNoticeTimer !== null) {
    clearTimeout(transientNoticeTimer);
    transientNoticeTimer = null;
  }
}

function dismissTransientRoomNotice(): void {
  clearTransientNoticeTimer();
  if (
    activeTransientNotice !== null &&
    ui.status.textContent === activeTransientNotice &&
    client?.isReady === true &&
    selfId !== null &&
    lastJoin !== null
  ) {
    setStatus(connectedRoomStatusText(lastJoin.code), "info");
  }
  activeTransientNotice = null;
}

function showTransientRoomNotice(message: string, durationMs = 6_000): void {
  clearTransientNoticeTimer();
  activeTransientNotice = message;
  setStatus(message, "warn");
  transientNoticeTimer = setTimeout(() => {
    transientNoticeTimer = null;
    if (
      activeTransientNotice === message &&
      ui.status.textContent === message &&
      client?.isReady === true &&
      selfId !== null &&
      lastJoin !== null
    ) {
      setStatus(connectedRoomStatusText(lastJoin.code), "info");
    }
    if (activeTransientNotice === message) {
      activeTransientNotice = null;
    }
  }, durationMs);
}

function clearPendingKicks(): void {
  for (const pending of pendingKicks.values()) {
    clearTimeout(pending.timer);
  }
  pendingKicks.clear();
}

async function joinRoom(code: string, initialPassword?: string): Promise<void> {
  if (!isValidRoomCode(code)) {
    setLobbyError(describeInviteParseFailure("invalid"));
    return;
  }

  const codeToJoin = code;
  const preGen = ++joinGeneration;
  if (capture && lastJoin && lastJoin.code !== code) {
    await stopSharing();
    if (preGen !== joinGeneration) return;
  }
  const previousCode = lastJoin?.code;
  if (previousCode && previousCode !== code) {
    clearRoomSession(previousCode);
  }
  leaveRoom();
  const activeGen = ++joinGeneration;
  const displayName = currentName();
  lastJoin = { code };
  saveActiveRoom(code);
  roomPassword = initialPassword ?? null;
  inviteRotatePending = false;
  clearRotatePendingTimer();
  let hasWelcomed = false;
  let lastPresentedHostToken: string | undefined;

  const activeClient = new SignalingClient(
    code,
    displayName,
    {
      onStatus: (status) => {
        if (activeGen !== joinGeneration) return;
        clearTransientNoticeTimer();
        activeTransientNotice = null;
        if (status === "open") {
          setStatus(`In room ${code}`, "info");
        } else {
          clearPendingKicks();
          setStatus(`Connection ${status}…`, "warn");
        }
        if (selfId !== null) renderInviteMenu();
      },

      onWelcome: (selfIdFromServer, peers, room) => {
        if (activeGen !== joinGeneration) return;
        const wasFirstWelcome = !hasWelcomed;
        hasWelcomed = true;
        const rejectedStoredHostToken = !room.host && wasFirstWelcome && lastPresentedHostToken !== undefined;
        inviteRotatePending = false;
        clearRotatePendingTimer();
        clearTransientNoticeTimer();
        activeTransientNotice = null;
        ui.roomInput.value = "";
        setLobbyError(null);
        scrubRoomUrl();

        for (const timer of peerLeftTimers.values()) clearTimeout(timer);
        peerLeftTimers.clear();
        clearPendingKicks();

        if (!room.host) {
          sessionHostTokens.delete(code);
          syncForgetHostUi();
        } else if (room.hostToken) {
          saveSessionHostToken(code, room.hostToken);
        } else {
          const knownCreator = creatorHostTokens.get(code) ?? readPersistedHostToken(safeLocalStorage(), code);
          if (lastPresentedHostToken !== undefined && lastPresentedHostToken === knownCreator) {
            saveCreatorHostToken(code, knownCreator);
          }
        }
        saveRejoinToken(code, room.rejoinToken);
        if (room.password) {
          roomPassword = room.password;
        } else if (room.locked && !room.host) {
          roomPassword = null;
          setInviteRevealed(false);
        }

        if (
          mesh !== null &&
          selfId !== null &&
          selfId === selfIdFromServer
        ) {
          const activeMesh = mesh;
          isHost = room.host;
          roomLocked = room.locked;

          const prevMemberIds = new Set(members.keys());
          const prevMeshIds = new Set(activeMesh.memberIds());
          const welcomePeerIds = new Set(peers.map((p) => p.id));
          welcomePeerIds.delete(selfIdFromServer);
          const allTrackedIds = new Set([...prevMemberIds, ...prevMeshIds, ...activeMesh.peers()]);
          for (const id of allTrackedIds) {
            if (!welcomePeerIds.has(id)) {
              teardownPeer(id);
              unreadPeerIds.delete(id);
            }
          }

          members.clear();
          for (const p of peers) {
            if (p.id === selfIdFromServer) continue;
            const wasKnown = prevMemberIds.has(p.id) || prevMeshIds.has(p.id);
            names.set(p.id, p.name);
            members.set(p.id, { name: p.name, sharing: p.sharing, host: p.host === true });
            const existingVideo = tiles.get(p.id);
            if (existingVideo) {
              const label = existingVideo.closest(".tile")?.querySelector(".tile-label");
              if (label) label.textContent = formatTileLabel(p.id, p.name);
              if (!p.sharing) removeTile(p.id);
            }
            if (!prevMeshIds.has(p.id)) {
              activeMesh.addMember(p.id, p.sharing);
            } else {
              activeMesh.setMemberSharing(p.id, p.sharing);
            }
            if (!wasKnown && !wasRecentDeparture(p.id) && activePopover !== "roster") {
              unreadPeerIds.add(p.id);
              joinChipArrivals.push({
                name: p.name.trim() || "Anonymous",
                shortId: p.id.slice(0, 4),
              });
            }
          }
          renderJoinChip();
          if (joinChipArrivals.length > 0) armJoinChipTimer();

          if (capture) {
            client?.setSharing(true);
            if (!tiles.has(SELF_TILE)) renderSelfPreview(capture.stream);
          }

          setStatus(connectedRoomStatusText(code), "info");
          if (rejectedStoredHostToken) {
            showTransientRoomNotice("Joined as participant \u2014 another member is hosting this session.");
          }
          renderInviteMenu();
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
        unreadPeerIds.clear();
        recentDepartures.clear();
        clearJoinChip();
        selfId = null;

        for (const id of [...tiles.keys()]) {
          if (id !== SELF_TILE) removeTile(id);
        }
        if (tiles.has(SELF_TILE)) names.set(SELF_TILE, "You");
        isHost = room.host;
        roomLocked = room.locked;

        const wiredStreams = new WeakSet<MediaStream>();
        mesh = new Mesh(
          selfIdFromServer,
          {
            iceServers: ICE_SERVERS,
            preset: QUALITY_PRESETS[currentPreset()],
            codec: currentCodec(),
            degradation: currentDegradation(),
            jitterBufferTargetMs: 150,
          },
          (to, data) => client?.signal(to, data),
          {
            onRemoteStream: (peerId, stream) => {
              if (members.get(peerId)?.sharing !== true) return;
              const video = tileFor(peerId);
              if (video.srcObject !== stream) {
                video.srcObject = stream;
              }
              if (!wiredStreams.has(stream)) {
                wiredStreams.add(stream);
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
          if (p.id === selfIdFromServer) continue;
          names.set(p.id, p.name);
          members.set(p.id, { name: p.name, sharing: p.sharing, host: p.host === true });
          mesh.addMember(p.id, p.sharing);
        }
        setStatus(connectedRoomStatusText(code), "info");
        if (rejectedStoredHostToken) {
          showTransientRoomNotice("Joined as participant \u2014 another member is hosting this session.");
        }
        if (capture) {
          client?.setSharing(true);
          if (!tiles.has(SELF_TILE)) renderSelfPreview(capture.stream);
          void mesh.setCapture(capture);
        }
        renderInviteMenu();
        syncViewState();
        startHealthPolling();
        renderRoster();
        if (reopenRosterOnWelcome) {
          reopenRosterOnWelcome = false;
          applyPopoverState("roster");
        }
      },

      onPeerJoined: (peer: PeerInfo, replaces?: PeerId) => {
        if (activeGen !== joinGeneration) return;
        if (replaces && replaces !== peer.id) {
          teardownPeer(replaces);
          unreadPeerIds.delete(replaces);
        }
        if (peerLeftTimers.has(peer.id)) {
          clearTimeout(peerLeftTimers.get(peer.id));
          peerLeftTimers.delete(peer.id);
        }
        const isReconnect = replaces !== undefined || wasRecentDeparture(peer.id);
        names.set(peer.id, peer.name);
        members.set(peer.id, { name: peer.name, sharing: peer.sharing, host: peer.host === true });
        mesh?.addMember(peer.id, peer.sharing);
        if (!isReconnect && activePopover !== "roster") {
          unreadPeerIds.add(peer.id);
          joinChipArrivals.push({
            name: peer.name.trim() || "Anonymous",
            shortId: peer.id.slice(0, 4),
          });
          renderJoinChip();
          armJoinChipTimer();
        }
        setStatus(`${peer.name} joined room ${code}`, "info");
        renderRoster();
      },

      onPeerLeft: (id, kicked) => {
        if (activeGen !== joinGeneration) return;
        const pendingKick = pendingKicks.get(id);
        if (pendingKick) {
          clearTimeout(pendingKick.timer);
          pendingKicks.delete(id);
          if (kicked && isHost) {
            showTransientRoomNotice(
              `Removed ${pendingKick.name} \u2014 invite link rotated. Share the new link from Invite \u25BE.`,
            );
          }
        }
        if (!kicked) recordDeparture(id);
        unreadPeerIds.delete(id);
        if (kicked) {
          teardownPeer(id);
          return;
        }
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
        if (activeGen !== joinGeneration) return;
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

      onRoomState: (locked, password) => {
        if (activeGen !== joinGeneration) return;
        roomLocked = locked;
        if (locked) {
          setInviteRevealed(false);
          resetInviteCopyFeedback();
          if (!isHost) roomPassword = null;
        } else if (password) {
          roomPassword = password;
        }
        renderRoster();
        renderInviteMenu();
      },

      onRoomPassword: (password, rejoinToken) => {
        if (activeGen !== joinGeneration) return;
        const wasRotating = inviteRotatePending;
        inviteRotatePending = false;
        clearRotatePendingTimer();
        setInviteRevealed(false);
        resetInviteCopyFeedback();
        if (rejoinToken !== undefined) {
          saveRejoinToken(code, rejoinToken);
        }
        if (password !== undefined) {
          roomPassword = password;
        } else if (roomLocked && !isHost) {
          roomPassword = null;
        }
        if (wasRotating) {
          if (rotateFeedbackTimer !== null) clearTimeout(rotateFeedbackTimer);
          ui.inviteRotateBtn.textContent = "Rotated!";
          ui.inviteRotateBtn.classList.add("invite-feedback-ok");
          rotateFeedbackTimer = setTimeout(() => {
            rotateFeedbackTimer = null;
            ui.inviteRotateBtn.textContent = "Rotate";
            ui.inviteRotateBtn.classList.remove("invite-feedback-ok");
          }, 1600);
        }
        renderInviteMenu();
      },

      onPeerRenamed: (id, name) => {
        if (activeGen !== joinGeneration) return;
        names.set(id, name);
        const m = members.get(id);
        if (m) m.name = name;
        if (id === selfId) {
          ui.nameInput.value = name;
          ui.roomNameInput.value = name;
        }
        const existingVideo = tiles.get(id);
        if (existingVideo) {
          const label = existingVideo.closest(".tile")?.querySelector(".tile-label");
          if (label) label.textContent = formatTileLabel(id, name);
        }
        renderRoster();
      },

      onHostPromoted: (hostId, hostToken, password) => {
        if (activeGen !== joinGeneration) return;
        isHost = hostId === selfId;
        for (const [id, m] of members) {
          m.host = id === hostId;
        }
        if (isHost) {
          if (hostToken) saveSessionHostToken(code, hostToken);
          if (password) {
            roomPassword = password;
          }
        }
        renderRoster();
        renderInviteMenu();
      },

      onError: (codeErr, message) => {
        if (activeGen !== joinGeneration) return;
        const friendlyMessages: Record<string, string> = {
          kicked: "You were removed from this room by its host.",
          "room-locked": `Room ${codeToJoin} is locked. Ask its host to unlock it.`,
          "session-replaced": "Connected from another tab. This session was closed.",
          "bad-password": "Invalid or expired room invite.",
          "join-timeout": "Connection timed out while joining the room. Please try again.",
          "connection-failed": "Could not connect to that room. Check your connection and try again.",
          "bad-message": "Disconnected due to a protocol error. Please rejoin the room.",
        };
        const friendly = friendlyMessages[codeErr] ?? message;
        if (activeClient.isFatal) {
          void stopSharing();
          if (SESSION_WIPING_ERRORS.has(codeErr)) {
            clearRoomSession(codeToJoin);
          } else if (!hasWelcomed) {
            saveActiveRoom(undefined);
          }
          if (codeErr === "bad-password" || CREATOR_TOKEN_WIPING_ERRORS.has(codeErr)) {
            sessionHostTokens.delete(codeToJoin);
          }
          if (CREATOR_TOKEN_WIPING_ERRORS.has(codeErr)) {
            if (lastPresentedHostToken !== undefined) {
              forgetCreatorHostToken(codeToJoin, lastPresentedHostToken);
            } else {
              syncForgetHostUi();
            }
          }
          lastJoin = null;
          leaveRoom();
          setLobbyError(friendly);
          setStatus("", "info");
          return;
        }
        if (codeErr === "not-host") {
          clearPendingKicks();
          renderRoster();
          setStatus(friendly, "warn");
          return;
        }
        if (codeErr === "unknown-peer" || codeErr === "not-sharing") {
          if (codeErr === "unknown-peer") {
            clearPendingKicks();
            renderRoster();
          }
          return;
        }
        clearPendingKicks();
        renderRoster();
        setStatus(codeErr === "rate-limited" ? friendly : `${codeErr}: ${friendly}`, "error");
      },
    },
    () => {
      const hostToken = hostTokenFor(code);
      lastPresentedHostToken = hostToken;
      return {
        password: roomPassword ?? undefined,
        hostToken,
        rejoinToken: rejoinTokenFor(code),
      };
    },
  );

  client = activeClient;
  activeClient.connect();
  scrubRoomUrl();
}

function leaveRoom(): void {
  joinGeneration++;
  reopenRosterOnWelcome = false;
  inviteRotatePending = false;
  clearRotatePendingTimer();
  clearPendingKicks();
  clearTransientNoticeTimer();
  activeTransientNotice = null;
  if (inviteRevealTimer !== null) {
    clearTimeout(inviteRevealTimer);
    inviteRevealTimer = null;
  }
  inviteRevealed = false;
  resetInviteCopyFeedback();
  if (rotateFeedbackTimer !== null) {
    clearTimeout(rotateFeedbackTimer);
    rotateFeedbackTimer = null;
  }
  ui.inviteRotateBtn.textContent = "Rotate";
  ui.inviteRotateBtn.classList.remove("invite-feedback-ok");

  recentDepartures.clear();
  unreadPeerIds.clear();
  clearJoinChip();

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
  roomPassword = null;
  setFocusedTile(null);
  renderInviteMenu();
  renderRoster();
  syncViewState();
  syncForgetHostUi();
}

// ---- quality & audio controls --------------------------------------------

const CODEC_META: Record<CodecName, { title: string; hint: string }> = {
  h264: { title: "H.264", hint: "Hardware · Best for gaming" },
  av1: { title: "AV1", hint: "Best quality · Modern GPU" },
};

const DEGRADATION_META: Record<DegradationMode, { title: string; hint: string }> = {
  framerate: { title: "Focus Framerate", hint: "Smooth FPS" },
  clarity: { title: "Focus Clarity", hint: "Sharp Resolution" },
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
  ui.inviteMenu.hidden = !state.inviteOpen;
  ui.roster.hidden = !state.rosterOpen;
  ui.presetMenu.hidden = !state.presetOpen;
  ui.codecMenu.hidden = !state.codecOpen;
  ui.degradationMenu.hidden = !state.degradationOpen;
  ui.inviteBtn.setAttribute("aria-expanded", String(state.inviteOpen));
  ui.rosterBtn.setAttribute("aria-expanded", String(state.rosterOpen));
  ui.presetBtn.setAttribute("aria-expanded", String(state.presetOpen));
  ui.codecBtn.setAttribute("aria-expanded", String(state.codecOpen));
  ui.degradationBtn.setAttribute("aria-expanded", String(state.degradationOpen));

  if (state.inviteOpen) {
    renderInviteMenu();
  }
  if (previous === "invite" && state.active !== "invite") {
    setInviteRevealed(false);
  }
  if (state.rosterOpen) {
    clearJoinChip();
    renderRosterUnreadDot();
  }
  if (previous === "roster" && state.active !== "roster") {
    unreadPeerIds.clear();
    renderRosterUnreadDot();
    renderRoster();
  }

  if (previous !== null && previous !== state.active) {
    const menu =
      previous === "invite"
        ? ui.inviteMenu
        : previous === "roster"
          ? ui.roster
          : previous === "preset"
            ? ui.presetMenu
            : previous === "codec"
              ? ui.codecMenu
              : ui.degradationMenu;
    const trigger =
      previous === "invite"
        ? ui.inviteBtn
        : previous === "roster"
          ? ui.rosterBtn
          : previous === "preset"
            ? ui.presetBtn
            : previous === "codec"
              ? ui.codecBtn
              : ui.degradationBtn;
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

function syncDegradationMenuSelection(selected: DegradationMode): void {
  ui.degradationBtnLabel.textContent = DEGRADATION_META[selected].title;
  for (const btn of ui.degradationList.querySelectorAll<HTMLButtonElement>(".popover-item")) {
    const active = btn.dataset["degradation"] === selected;
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

  for (const [name, meta] of Object.entries(DEGRADATION_META)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "popover-item";
    btn.dataset["degradation"] = name;

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
      if (!isDegradationMode(name)) return;
      localStorage.setItem("stream-degradation", name);
      syncDegradationMenuSelection(name);
      closeAllPopovers();
      if (mesh) runBackground(mesh.setDegradation(name));
    });
    ui.degradationList.append(btn);
  }
  syncDegradationMenuSelection(currentDegradation());

  ui.presetBtn.addEventListener("click", () => {
    togglePopover("preset");
  });

  ui.codecBtn.addEventListener("click", () => {
    togglePopover("codec");
  });

  ui.degradationBtn.addEventListener("click", () => {
    togglePopover("degradation");
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

// ---- roster, invite & header controls ------------------------------------

async function copyInvite(mode: "link" | "code"): Promise<void> {
  const code = lastJoin?.code;
  if (!code || !roomPassword || roomLocked) return;
  const invite = formatInviteCode(code, roomPassword);
  const text = mode === "link" ? `${location.origin}/#${invite}` : invite;
  const copied = await copyTextToClipboard(text);
  if (!copied) {
    clearTransientNoticeTimer();
    activeTransientNotice = null;
    setStatus("Could not copy automatically. Use Show to view and copy manually.", "warn");
    return;
  }
  dismissTransientRoomNotice();
  if (mode === "link") {
    if (linkFeedbackTimer !== null) clearTimeout(linkFeedbackTimer);
    ui.inviteLinkFeedback.textContent = "Copied!";
    ui.inviteLinkFeedback.classList.add("invite-feedback-ok");
    ui.inviteCopyLinkBtn.classList.add("invite-feedback-ok");
    linkFeedbackTimer = setTimeout(() => {
      linkFeedbackTimer = null;
      ui.inviteLinkFeedback.textContent = "";
      ui.inviteLinkFeedback.classList.remove("invite-feedback-ok");
      ui.inviteCopyLinkBtn.classList.remove("invite-feedback-ok");
    }, 2000);
  } else {
    if (codeFeedbackTimer !== null) clearTimeout(codeFeedbackTimer);
    ui.inviteCopyCodeBtn.textContent = "Copied!";
    ui.inviteCopyCodeBtn.classList.add("invite-feedback-ok");
    codeFeedbackTimer = setTimeout(() => {
      codeFeedbackTimer = null;
      ui.inviteCopyCodeBtn.textContent = "Copy";
      ui.inviteCopyCodeBtn.classList.remove("invite-feedback-ok");
    }, 2000);
  }
}

ui.inviteBtn.addEventListener("click", () => {
  togglePopover("invite");
});

ui.inviteShowBtn.addEventListener("click", () => {
  if (roomLocked || !roomPassword) return;
  setInviteRevealed(!inviteRevealed);
});

ui.inviteCopyLinkBtn.addEventListener("click", () => {
  runBackground(copyInvite("link"));
});

ui.inviteCopyCodeBtn.addEventListener("click", () => {
  runBackground(copyInvite("code"));
});

ui.inviteForgetHostBtn.addEventListener("click", () => {
  const code = lastJoin?.code;
  if (!code) return;
  forgetCreatorHostToken(code);
  closeAllPopovers();
  showTransientRoomNotice("Removed saved host access for this room on this device.");
});

ui.lobbyForgetHostsBtn.addEventListener("click", () => {
  creatorHostTokens.clear();
  sessionHostTokens.clear();
  for (const key of [...memorySession.keys()]) {
    if (key.startsWith("host:")) memorySession.delete(key);
  }
  clearLegacySessionHostTokens(safeSessionStorage());
  syncForgetHostUi();
  runBackground(
    runWithHostRoomsLock(safeLocks(), () => {
      clearAllPersistedHostTokens(safeLocalStorage());
      syncForgetHostUi();
    }),
  );
});

ui.inviteRotateBtn.addEventListener("click", () => {
  if (!client || !isHost || !lastJoin?.code || inviteRotatePending) return;
  setInviteRevealed(false);
  if (!client.rotatePassword()) {
    renderInviteMenu();
    return;
  }
  inviteRotatePending = true;
  resetInviteCopyFeedback();
  if (rotateFeedbackTimer !== null) {
    clearTimeout(rotateFeedbackTimer);
    rotateFeedbackTimer = null;
  }
  ui.inviteRotateBtn.classList.remove("invite-feedback-ok");
  ui.inviteRotateBtn.textContent = "Rotating\u2026";
  renderInviteMenu();
  clearRotatePendingTimer();
  inviteRotateTimeout = setTimeout(() => {
    inviteRotateTimeout = null;
    if (!inviteRotatePending) return;
    inviteRotatePending = false;
    ui.inviteRotateBtn.textContent = "Rotate";
    renderInviteMenu();
  }, 10_000);
});

ui.rosterBtn.addEventListener("click", () => {
  togglePopover("roster");
});

window.addEventListener("blur", () => {
  pauseJoinChipTimer();
  if (inviteRevealed) setInviteRevealed(false);
});

window.addEventListener("focus", () => {
  armJoinChipTimer();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pauseJoinChipTimer();
    if (inviteRevealed) setInviteRevealed(false);
    return;
  }
  if (document.hasFocus()) armJoinChipTimer();
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
  clearRoomSession();
  lastJoin = null;
  leaveRoom();
  scrubRoomUrl();
  setLobbyError(null);
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
  if (client && selfId !== null) {
    client.rename(currentName());
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

async function enterInvite(code: string, password: string): Promise<void> {
  if (capture && lastJoin && lastJoin.code !== code) {
    const confirmed = window.confirm("Leave your current room and stop sharing your screen to join the new room?");
    if (!confirmed) return;
  }
  const previous = lastJoin?.code ?? activeRoomFor();
  if (previous && previous !== code) {
    clearRoomSession(previous);
  }
  saveActiveRoom(code);
  scrubRoomUrl();
  await joinRoom(code, password);
}

async function submitLobbyJoin(): Promise<void> {
  const parsed = parseInviteInput(ui.roomInput.value);
  if (!parsed.ok) {
    setLobbyError(describeInviteParseFailure(parsed.reason));
    ui.roomInput.focus();
    return;
  }
  setLobbyError(null);
  await enterInvite(parsed.code, parsed.password);
}

ui.roomInput.addEventListener("input", () => {
  setLobbyError(null);
});

ui.joinBtn.addEventListener("click", () => {
  runBackground(submitLobbyJoin());
});

ui.roomInput.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  runBackground(submitLobbyJoin());
});

ui.createBtn.addEventListener("click", () => {
  if (ui.createBtn.disabled) return;
  setLobbyError(null);
  ui.createBtn.disabled = true;
  const genBeforeFetch = joinGeneration;
  runBackground(
    (async () => {
      try {
        const res = await fetch("/api/room", { method: "POST" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseNewRoomResponse(await res.json());
        if (!parsed) throw new Error("server returned an invalid room response");
        if (genBeforeFetch !== joinGeneration) return;
        const { code, password, hostToken } = parsed;
        const previous = lastJoin?.code ?? activeRoomFor();
        if (previous && previous !== code) clearRoomSession(previous);
        saveActiveRoom(code);
        saveCreatorHostToken(code, hostToken);
        ui.roomInput.value = "";
        scrubRoomUrl();
        await joinRoom(code, password);
      } catch (err) {
        console.error("[main] could not create a room", err);
        setLobbyError("Could not create a room. Check your connection and try again.");
      } finally {
        ui.createBtn.disabled = false;
      }
    })(),
  );
});

ui.shareBtn.addEventListener("click", () => {
  runBackground(capture ? stopSharing() : startSharing());
});

window.addEventListener("beforeunload", () => leaveRoom());
window.addEventListener("pagehide", () => leaveRoom());

function joinFromBootOrHash(isHashChange: boolean): void {
  const rawHash = location.hash;
  if (rawHash.length > 0) {
    scrubRoomUrl();
    const parsed = parseInviteInput(rawHash);
    if (!parsed.ok) {
      const msg = describeInviteParseFailure(parsed.reason);
      if (client && selfId !== null) setStatus(msg, "warn");
      else setLobbyError(msg);
      return;
    }
    if (lastJoin?.code === parsed.code && selfId !== null && client !== null && !client.isFatal) {
      if (!client.isReady) {
        roomPassword = parsed.password;
        client.connect();
      }
      return;
    }
    setLobbyError(null);
    runBackground(enterInvite(parsed.code, parsed.password));
    return;
  }

  if (isHashChange) return;
  const savedRoom = activeRoomFor();
  if (savedRoom && isValidRoomCode(savedRoom) && Boolean(rejoinTokenFor(savedRoom) ?? hostTokenFor(savedRoom))) {
    runBackground(joinRoom(savedRoom));
  } else if (savedRoom) {
    clearRoomSession(savedRoom);
  }
}

window.addEventListener("storage", (ev) => {
  if (ev.key !== HOST_ROOMS_STORAGE_KEY && ev.key !== null) return;
  const storage = safeLocalStorage();
  for (const code of [...creatorHostTokens.keys()]) {
    const current = readPersistedHostToken(storage, code);
    if (current === undefined) {
      creatorHostTokens.delete(code);
    } else {
      creatorHostTokens.set(code, current);
    }
  }
  syncForgetHostUi();
});

syncForgetHostUi();
syncViewState();
joinFromBootOrHash(false);
window.addEventListener("hashchange", () => joinFromBootOrHash(true));
