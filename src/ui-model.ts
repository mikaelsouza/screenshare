import type { PeerId } from "@shared/protocol";

export interface ViewState {
  lobbyHidden: boolean;
  roomBarHidden: boolean;
  controlsHidden: boolean;
  liveControlsHidden: boolean;
  togglePreviewHidden: boolean;
  stageEmptyHidden: boolean;
  stageEmptyTitle: string;
  stageEmptySubtitle: string;
  shareButtonText: "Share screen" | "Stop sharing";
  shareButtonVariant: "primary" | "danger";
  showFocusButtons: boolean;
}

const DEFAULT_EMPTY_TITLE = "No one is sharing right now";
const DEFAULT_EMPTY_SUBTITLE = 'Click "Share screen" below to start, or wait for someone to share.';
const HIDDEN_PREVIEW_TITLE = "Your stream preview is hidden";
const HIDDEN_PREVIEW_SUBTITLE = 'Click "Show preview" below to bring it back on stage.';

/**
 * Pure derivation of top-level UI visibility and button states across
 * Lobby (!connected), Watching (connected && !sharing), and Streaming (connected && sharing).
 */
export function deriveViewState(
  connected: boolean,
  sharing: boolean,
  selfPreviewHidden: boolean,
  visibleTileCount: number,
): ViewState {
  if (!connected) {
    return {
      lobbyHidden: false,
      roomBarHidden: true,
      controlsHidden: true,
      liveControlsHidden: true,
      togglePreviewHidden: true,
      stageEmptyHidden: true,
      stageEmptyTitle: DEFAULT_EMPTY_TITLE,
      stageEmptySubtitle: DEFAULT_EMPTY_SUBTITLE,
      shareButtonText: "Share screen",
      shareButtonVariant: "primary",
      showFocusButtons: false,
    };
  }
  const hiddenPreview = sharing && selfPreviewHidden;
  return {
    lobbyHidden: true,
    roomBarHidden: false,
    controlsHidden: false,
    liveControlsHidden: !sharing,
    togglePreviewHidden: !hiddenPreview,
    stageEmptyHidden: visibleTileCount > 0,
    stageEmptyTitle: hiddenPreview ? HIDDEN_PREVIEW_TITLE : DEFAULT_EMPTY_TITLE,
    stageEmptySubtitle: hiddenPreview ? HIDDEN_PREVIEW_SUBTITLE : DEFAULT_EMPTY_SUBTITLE,
    shareButtonText: sharing ? "Stop sharing" : "Share screen",
    shareButtonVariant: sharing ? "danger" : "primary",
    showFocusButtons: visibleTileCount >= 2,
  };
}

/**
 * Pure decision for whether a viewer wants video frames from a remote sharer.
 * Returns null if the tile's IntersectionObserver has not yet reported visibility
 * and the tile is neither in PiP nor manually paused.
 */
export function shouldRequestRemoteVideo(
  onScreen: boolean | undefined,
  isPip: boolean,
  isPaused: boolean,
): boolean | null {
  if (isPaused) return false;
  if (isPip) return true;
  if (onScreen === undefined) return null;
  return onScreen;
}

export interface VolumeState {
  volume: number;
  muted: boolean;
  boosted: boolean;
  label: string;
}

/**
 * Pure mapping from slider value (0..200) or mute toggle to normalized volume (0..2).
 */
export function computeVolumeState(sliderValue: number, fallbackVolume = 1): VolumeState {
  const clamped = Number.isFinite(sliderValue)
    ? Math.max(0, Math.min(200, Math.round(sliderValue)))
    : Math.max(0, Math.min(200, Math.round(fallbackVolume * 100)));
  const volume = clamped / 100;
  return {
    volume,
    muted: clamped === 0,
    boosted: clamped > 100,
    label: `Volume: ${clamped}%`,
  };
}

export interface RosterEntry {
  id: PeerId;
  name: string;
  shortId: string;
  sharing: boolean;
  host: boolean;
  self: boolean;
  canKick: boolean;
}

export interface RosterSummary {
  totalCount: number;
  sharingCount: number;
  buttonLabel: string;
  entries: RosterEntry[];
}

/**
 * Pure roster sorting and top-bar button summary formatting.
 * Self is always first; remaining members are sorted by display name then PeerId.
 */
export function sortAndFormatRoster(
  selfId: PeerId,
  selfName: string,
  selfSharing: boolean,
  isHost: boolean,
  roomLocked: boolean,
  members: ReadonlyMap<PeerId, { name: string; sharing: boolean; host: boolean }>,
): RosterSummary {
  const entries: RosterEntry[] = [
    {
      id: selfId,
      name: selfName.trim() || "Anonymous",
      shortId: `#${selfId.slice(0, 4)}`,
      sharing: selfSharing,
      host: isHost,
      self: true,
      canKick: false,
    },
  ];

  const others = [...members.entries()]
    .filter(([id]) => id !== selfId)
    .sort((a, b) => a[1].name.localeCompare(b[1].name) || a[0].localeCompare(b[0]));

  for (const [id, m] of others) {
    entries.push({
      id,
      name: m.name.trim() || "Anonymous",
      shortId: `#${id.slice(0, 4)}`,
      sharing: m.sharing,
      host: m.host,
      self: false,
      canKick: isHost,
    });
  }

  const totalCount = entries.length;
  const sharingCount = entries.filter((e) => e.sharing).length;
  const lockPart = roomLocked ? " · Locked" : "";
  const buttonLabel = `${totalCount} in room · ${sharingCount} sharing${lockPart} \u25BE`;

  return {
    totalCount,
    sharingCount,
    buttonLabel,
    entries,
  };
}
