import type { PeerId } from "@shared/protocol";
import {
  computeVolumeState,
  deriveViewState,
  shouldRequestRemoteVideo,
  type ViewState,
  type VolumeState,
} from "../ui-model";

export const SELF_TILE = "__self";

export interface ListeningState {
  volume: number;
  muted: boolean;
}

/**
 * Pure, DOM-free controller for stage tile registry, WeakSet stream listener
 * deduplication, focus/pin resolution, per-peer audio/pause/visibility state,
 * and outbound roster stats snapshots.
 */
export class TileController {
  private readonly registeredTiles = new Map<PeerId, { hidden: boolean }>();
  private wiredStreams = new WeakSet<object>();
  private readonly peerNames = new Map<PeerId, string>();
  private readonly listeningMap = new Map<PeerId, ListeningState>();
  private readonly pausedPeers = new Set<PeerId>();
  private readonly onScreenPeers = new Map<PeerId, boolean>();
  private readonly statsOpenPeers = new Set<PeerId>();
  private readonly outboundStats = new Map<PeerId, string>();
  private focused: PeerId | null = null;
  private previewHidden = false;
  private outboundMbps = 0;
  private viewers = 0;

  get focusedPeerId(): PeerId | null {
    return this.focused;
  }

  get selfPreviewHidden(): boolean {
    return this.previewHidden;
  }

  get totalOutboundMbps(): number {
    return this.outboundMbps;
  }

  get activeViewerCount(): number {
    return this.viewers;
  }

  hasTile(peerId: PeerId): boolean {
    return this.registeredTiles.has(peerId);
  }

  tileIds(): PeerId[] {
    return [...this.registeredTiles.keys()];
  }

  registerTile(peerId: PeerId, hidden = false): void {
    this.registeredTiles.set(peerId, { hidden });
  }

  setTileHidden(peerId: PeerId, hidden: boolean): void {
    const entry = this.registeredTiles.get(peerId);
    if (entry) entry.hidden = hidden;
  }

  unregisterTile(peerId: PeerId): { clearedFocus: boolean } {
    this.registeredTiles.delete(peerId);
    this.statsOpenPeers.delete(peerId);
    this.onScreenPeers.delete(peerId);
    this.pausedPeers.delete(peerId);
    if (this.focused === peerId) {
      this.focused = null;
      return { clearedFocus: true };
    }
    return { clearedFocus: false };
  }

  /** Returns true the first time a MediaStream instance is seen, false on duplicate calls. */
  markStreamWired(stream: object): boolean {
    if (this.wiredStreams.has(stream)) return false;
    this.wiredStreams.add(stream);
    return true;
  }

  resetWiredStreams(): void {
    this.wiredStreams = new WeakSet<object>();
  }

  setName(peerId: PeerId, name: string): void {
    this.peerNames.set(peerId, name);
  }

  getName(peerId: PeerId, fallback = "Peer"): string {
    return this.peerNames.get(peerId) ?? fallback;
  }

  deleteName(peerId: PeerId): void {
    this.peerNames.delete(peerId);
  }

  formatTileLabel(peerId: PeerId, name?: string): string {
    if (peerId === SELF_TILE) return "You";
    const resolved = name ?? this.peerNames.get(peerId) ?? "Peer";
    return `${resolved} #${peerId.slice(0, 4)}`;
  }

  visibleTileCount(): number {
    let count = 0;
    for (const [id, meta] of this.registeredTiles.entries()) {
      if (!meta.hidden && !(id === SELF_TILE && this.previewHidden)) {
        count++;
      }
    }
    return count;
  }

  deriveView(connected: boolean, sharing: boolean): ViewState {
    return deriveViewState(connected, sharing, this.previewHidden, this.visibleTileCount());
  }

  toggleFocus(peerId: PeerId | null): PeerId | null {
    if (this.focused === peerId) {
      this.focused = null;
    } else {
      this.focused = peerId;
    }
    return this.focused;
  }

  setSelfPreviewHidden(hidden: boolean): { clearedFocus: boolean } {
    this.previewHidden = hidden;
    this.setTileHidden(SELF_TILE, hidden);
    if (hidden && this.focused === SELF_TILE) {
      this.focused = null;
      return { clearedFocus: true };
    }
    return { clearedFocus: false };
  }

  listeningFor(peerId: PeerId): ListeningState {
    let state = this.listeningMap.get(peerId);
    if (!state) {
      state = { volume: 1, muted: false };
      this.listeningMap.set(peerId, state);
    }
    return state;
  }

  toggleMute(peerId: PeerId): ListeningState {
    const state = this.listeningFor(peerId);
    state.muted = !state.muted;
    return state;
  }

  setMuted(peerId: PeerId, muted: boolean): ListeningState {
    const state = this.listeningFor(peerId);
    state.muted = muted;
    return state;
  }

  setVolumeFromSlider(peerId: PeerId, sliderValue: number): VolumeState {
    const state = this.listeningFor(peerId);
    const volState = computeVolumeState(sliderValue, state.volume);
    if (volState.muted) {
      state.muted = true;
    } else {
      state.volume = volState.volume;
      state.muted = false;
    }
    return volState;
  }

  isPaused(peerId: PeerId): boolean {
    return this.pausedPeers.has(peerId);
  }

  setPaused(peerId: PeerId, value: boolean): void {
    if (value) this.pausedPeers.add(peerId);
    else this.pausedPeers.delete(peerId);
  }

  setOnScreen(peerId: PeerId, intersecting: boolean): void {
    this.onScreenPeers.set(peerId, intersecting);
  }

  shouldRequestVideo(peerId: PeerId, isPip: boolean): boolean | null {
    return shouldRequestRemoteVideo(this.onScreenPeers.get(peerId), isPip, this.pausedPeers.has(peerId));
  }

  isStatsOpen(peerId: PeerId): boolean {
    return this.statsOpenPeers.has(peerId);
  }

  toggleStats(peerId: PeerId): boolean {
    if (this.statsOpenPeers.has(peerId)) {
      this.statsOpenPeers.delete(peerId);
      return false;
    }
    this.statsOpenPeers.add(peerId);
    return true;
  }

  setPeerOutboundText(peerId: PeerId, text: string | null): void {
    if (text === null) this.outboundStats.delete(peerId);
    else this.outboundStats.set(peerId, text);
  }

  getPeerOutboundText(peerId: PeerId): string {
    return this.outboundStats.get(peerId) ?? "";
  }

  setOutboundSummary(activeViewerCount: number, totalOutboundMbps: number): void {
    this.viewers = activeViewerCount;
    this.outboundMbps = totalOutboundMbps;
  }

  clearOutboundStats(): void {
    this.outboundStats.clear();
    this.outboundMbps = 0;
    this.viewers = 0;
  }

  formatRosterHeaderTitle(totalCount: number, roomLocked: boolean, isSharing: boolean): string {
    const lockSuffix = roomLocked ? ", locked" : "";
    if (isSharing) {
      const othersCount = Math.max(0, totalCount - 1);
      const mbpsPart = this.outboundMbps > 0 ? ` · ↑ ${this.outboundMbps.toFixed(1)} Mbps` : "";
      return `In this room (${totalCount}${lockSuffix})${mbpsPart} (${this.viewers}/${othersCount} watching)`;
    }
    return `In this room (${totalCount}${lockSuffix})`;
  }

  teardownPeer(peerId: PeerId): { clearedFocus: boolean } {
    this.peerNames.delete(peerId);
    this.listeningMap.delete(peerId);
    this.outboundStats.delete(peerId);
    return this.unregisterTile(peerId);
  }

  clearListening(): void {
    this.listeningMap.clear();
  }

  resetAll(): void {
    this.registeredTiles.clear();
    this.resetWiredStreams();
    this.peerNames.clear();
    this.listeningMap.clear();
    this.pausedPeers.clear();
    this.onScreenPeers.clear();
    this.statsOpenPeers.clear();
    this.clearOutboundStats();
    this.focused = null;
    this.previewHidden = false;
  }
}
