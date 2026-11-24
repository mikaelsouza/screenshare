import { ROOM_PASSWORD_LENGTH, type InviteParseFailureReason, type PeerId } from "@shared/protocol";

/** Truncate trimmed `value` to at most `maxUnits` UTF-16 code units without splitting a surrogate pair. */
export function trimCodeUnits(value: string, maxUnits: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxUnits) return trimmed;
  let end = maxUnits;
  const unit = trimmed.charCodeAt(end - 1);
  if (unit >= 0xd800 && unit <= 0xdbff) end -= 1;
  return trimmed.slice(0, end).trimEnd();
}

export interface ViewState {
  lobbyHidden: boolean;
  roomBarHidden: boolean;
  controlsHidden: boolean;
  liveControlsHidden: boolean;
  muteAudioHidden: boolean;
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
      muteAudioHidden: true,
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
    muteAudioHidden: !sharing,
    togglePreviewHidden: !hiddenPreview,
    stageEmptyHidden: visibleTileCount > 0,
    stageEmptyTitle: hiddenPreview ? HIDDEN_PREVIEW_TITLE : DEFAULT_EMPTY_TITLE,
    stageEmptySubtitle: hiddenPreview ? HIDDEN_PREVIEW_SUBTITLE : DEFAULT_EMPTY_SUBTITLE,
    shareButtonText: sharing ? "Stop sharing" : "Share screen",
    shareButtonVariant: sharing ? "danger" : "primary",
    showFocusButtons: visibleTileCount >= 2,
  };
}

export interface OutboundAudioState {
  disabled: boolean;
  muted: boolean;
  ariaPressed: "true" | "false";
  icon: "volumeOn" | "volumeOff";
  text: "Mute audio" | "No audio";
  title: string;
}

/**
 * Pure derivation of the outbound audio mute button (`#mute-audio`) state.
 */
export function deriveOutboundAudioState(
  sharing: boolean,
  hasAudioTrack: boolean,
  trackEnabled: boolean,
): OutboundAudioState {
  if (!sharing) {
    return {
      disabled: false,
      muted: false,
      ariaPressed: "false",
      icon: "volumeOn",
      text: "Mute audio",
      title: "Mute or unmute your shared audio",
    };
  }
  if (!hasAudioTrack) {
    return {
      disabled: true,
      muted: false,
      ariaPressed: "false",
      icon: "volumeOff",
      text: "No audio",
      title: "No audio source was shared",
    };
  }
  const muted = !trackEnabled;
  return {
    disabled: false,
    muted,
    ariaPressed: muted ? "true" : "false",
    icon: muted ? "volumeOff" : "volumeOn",
    text: "Mute audio",
    title: muted ? "Unmute your shared audio" : "Mute your shared audio",
  };
}

export type PopoverKind = "invite" | "roster" | "preset" | "codec" | "degradation";

export interface PopoverVisibility {
  active: PopoverKind | null;
  inviteOpen: boolean;
  rosterOpen: boolean;
  presetOpen: boolean;
  codecOpen: boolean;
  degradationOpen: boolean;
}

/**
 * Pure state-machine transition for header & footer popovers (`invite`, `roster`, `preset`, `codec`, `degradation`).
 * Guarantees at most one popover is open at any time and only when its parent bar is visible.
 */
export function nextPopoverState(
  current: PopoverKind | null,
  target: PopoverKind | null,
  connected: boolean,
  sharing: boolean,
): PopoverVisibility {
  const requested = current !== target ? target : null;
  const inviteOpen = connected && requested === "invite";
  const rosterOpen = connected && requested === "roster";
  const presetOpen = connected && sharing && requested === "preset";
  const codecOpen = connected && sharing && requested === "codec";
  const degradationOpen = connected && sharing && requested === "degradation";
  const active: PopoverKind | null = inviteOpen
    ? "invite"
    : rosterOpen
      ? "roster"
      : presetOpen
        ? "preset"
        : codecOpen
          ? "codec"
          : degradationOpen
            ? "degradation"
            : null;
  return { active, inviteOpen, rosterOpen, presetOpen, codecOpen, degradationOpen };
}

export interface InviteMenuState {
  canCopy: boolean;
  canShow: boolean;
  canRotate: boolean;
  showLockedBanner: boolean;
  displayCode: string;
}

/** Mask the secret portion of a room invite code with bullets while preserving the 8-char code prefix. */
export function maskInviteSecret(code: string): string {
  return `${code}-${"\u2022".repeat(ROOM_PASSWORD_LENGTH)}`;
}

export interface InviteMenuParams {
  roomCode: string | null;
  roomPassword: string | null;
  roomLocked: boolean;
  isHost: boolean;
  revealed: boolean;
  signalingReady?: boolean;
  rotating?: boolean;
}

function formatInviteDisplayCode(
  roomCode: string | null,
  roomPassword: string | null,
  canShow: boolean,
  revealed: boolean,
): string {
  if (!roomCode) return "";
  if (canShow && revealed && roomPassword !== null) {
    return `${roomCode}-${roomPassword}`;
  }
  return maskInviteSecret(roomCode);
}

/**
 * Pure derivation of the invite menu's enabled actions, locked state, and displayed code string.
 */
export function deriveInviteMenuState(params: InviteMenuParams): InviteMenuState {
  const { roomCode, roomPassword, roomLocked, isHost, revealed } = params;
  const signalingReady = params.signalingReady ?? true;
  const rotating = params.rotating ?? false;
  const hasCode = Boolean(roomCode);
  const hasSecret = Boolean(roomPassword);
  const canRotate = isHost && hasCode && signalingReady && !rotating;
  const canCopy = !roomLocked && !rotating && hasCode && hasSecret;
  const canShow = canCopy;
  return {
    canCopy,
    canShow,
    canRotate,
    showLockedBanner: roomLocked,
    displayCode: formatInviteDisplayCode(roomCode, roomPassword, canShow, revealed),
  };
}

/**
 * Map a parseInviteInput failure reason to concise inline Lobby error copy.
 */
export function describeInviteParseFailure(reason: InviteParseFailureReason): string {
  switch (reason) {
    case "empty":
      return "Paste an invite link or code to join.";
    case "url-missing-invite":
      return "That link is missing its #CODE-SECRET invite part. Ask someone in the room to click Copy invite link.";
    case "missing-secret":
      return "Room codes now include a secret (CODE-SECRET). Paste the full invite link or code.";
    case "invalid":
      return "Invalid invite code or link. Check for typos or ask for a fresh invite.";
  }
}

export interface JoinChipArrival {
  name: string;
  shortId: string;
}

/**
 * Format coalesced arrival notifications for the bottom-right join chip.
 */
export function formatJoinChipText(arrivals: ReadonlyArray<JoinChipArrival>): string {
  const fmt = (a: JoinChipArrival): string => `${a.name} #${a.shortId.replace(/^#/, "")}`;
  const first = arrivals[0];
  if (!first) return "";
  if (arrivals.length === 1) return `${fmt(first)} joined`;
  const second = arrivals[1];
  if (arrivals.length === 2 && second) return `${fmt(first)} & ${fmt(second)} joined`;
  return `${fmt(first)} + ${arrivals.length - 1} others joined`;
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
  isNew: boolean;
  duplicateName: boolean;
}

export interface RosterSummary {
  totalCount: number;
  sharingCount: number;
  buttonLabel: string;
  entries: RosterEntry[];
}

export interface RosterOptions {
  newPeerIds?: ReadonlySet<PeerId>;
  extraPeerIds?: Iterable<PeerId>;
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
  options?: RosterOptions,
): RosterSummary {
  const combined = new Map<PeerId, { name: string; sharing: boolean; host: boolean }>(members);
  if (options?.extraPeerIds) {
    for (const id of options.extraPeerIds) {
      if (id !== selfId && !combined.has(id)) {
        combined.set(id, { name: "Peer", sharing: false, host: false });
      }
    }
  }

  const baseEntries: Array<{
    id: PeerId;
    name: string;
    shortId: string;
    sharing: boolean;
    host: boolean;
    self: boolean;
    canKick: boolean;
  }> = [
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

  const others = [...combined.entries()]
    .filter(([id]) => id !== selfId)
    .sort((a, b) => a[1].name.localeCompare(b[1].name) || a[0].localeCompare(b[0]));

  for (const [id, m] of others) {
    baseEntries.push({
      id,
      name: m.name.trim() || "Anonymous",
      shortId: `#${id.slice(0, 4)}`,
      sharing: m.sharing,
      host: m.host,
      self: false,
      canKick: isHost,
    });
  }

  const nameCounts = new Map<string, number>();
  for (const entry of baseEntries) {
    const key = entry.name.trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  const entries: RosterEntry[] = baseEntries.map((entry) => ({
    ...entry,
    isNew: !entry.self && (options?.newPeerIds?.has(entry.id) ?? false),
    duplicateName: (nameCounts.get(entry.name.trim().toLowerCase()) ?? 0) > 1,
  }));

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
