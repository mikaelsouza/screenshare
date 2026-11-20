import type { PeerId } from "@shared/protocol";
import {
  formatJoinChipText,
  nextPopoverState,
  type JoinChipArrival,
  type PopoverKind,
  type PopoverVisibility,
} from "../ui-model";

export const RECENT_DEPARTURE_MS: number = 8_000;
export const JOIN_CHIP_DURATION_MS: number = 2_800;

export interface PopoverTransition {
  previous: PopoverKind | null;
  visibility: PopoverVisibility;
  closedInvite: boolean;
  openedRoster: boolean;
  closedRoster: boolean;
}

export interface PopoverToastCallbacks {
  onJoinChipChange: () => void;
}

/**
 * Pure, DOM-free controller for exclusive header/footer popovers, unread arrival badges,
 * recent departure suppression, and focus-gated burst-coalesced join chips.
 */
export class PopoverToastController {
  private active: PopoverKind | null = null;
  private readonly unread = new Set<PeerId>();
  private readonly departures = new Map<PeerId, number>();
  private readonly arrivals: JoinChipArrival[] = [];
  private chipTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onJoinChipChange: () => void;

  constructor(callbacks: PopoverToastCallbacks) {
    this.onJoinChipChange = callbacks.onJoinChipChange;
  }

  get activePopover(): PopoverKind | null {
    return this.active;
  }

  get unreadPeerIds(): ReadonlySet<PeerId> {
    return this.unread;
  }

  get joinChipArrivals(): readonly JoinChipArrival[] {
    return this.arrivals;
  }

  hasUnreadDot(): boolean {
    return this.unread.size > 0 && this.active !== "roster";
  }

  applyPopover(target: PopoverKind | null, connected: boolean, sharing: boolean): PopoverTransition {
    const previous = this.active;
    const visibility = nextPopoverState(this.active, target, connected, sharing);
    this.active = visibility.active;

    const closedInvite = previous === "invite" && visibility.active !== "invite";
    const openedRoster = visibility.rosterOpen;
    const closedRoster = previous === "roster" && visibility.active !== "roster";

    if (openedRoster) {
      this.clearJoinChip();
    }
    if (closedRoster) {
      this.unread.clear();
    }

    return { previous, visibility, closedInvite, openedRoster, closedRoster };
  }

  pruneDepartures(now: number = Date.now()): void {
    for (const [id, ts] of this.departures) {
      if (now - ts >= RECENT_DEPARTURE_MS) {
        this.departures.delete(id);
      }
    }
  }

  recordDeparture(id: PeerId, now: number = Date.now()): void {
    this.pruneDepartures(now);
    this.departures.set(id, now);
  }

  wasRecentDeparture(id: PeerId, now: number = Date.now()): boolean {
    this.pruneDepartures(now);
    return this.departures.has(id);
  }

  recordArrival(
    peer: { id: PeerId; name: string },
    options: { replaces?: PeerId | undefined; now?: number | undefined; isFocusedAndVisible?: boolean | undefined },
  ): boolean {
    const now = options.now ?? Date.now();
    const isReconnect = options.replaces !== undefined || this.wasRecentDeparture(peer.id, now);
    if (isReconnect || this.active === "roster") {
      return false;
    }
    this.unread.add(peer.id);
    this.arrivals.push({
      name: peer.name.trim() || "Anonymous",
      shortId: peer.id.slice(0, 4),
    });
    this.onJoinChipChange();
    if (options.isFocusedAndVisible !== undefined) {
      this.armJoinChipTimer(options.isFocusedAndVisible);
    }
    return true;
  }

  enqueueArrivalUnchecked(peer: { id: PeerId; name: string }): void {
    if (this.active === "roster") return;
    this.unread.add(peer.id);
    this.arrivals.push({
      name: peer.name.trim() || "Anonymous",
      shortId: peer.id.slice(0, 4),
    });
  }

  removeUnread(id: PeerId): void {
    this.unread.delete(id);
  }

  getJoinChipText(connected: boolean): string {
    if (!connected) return "";
    return formatJoinChipText(this.arrivals);
  }

  pauseJoinChipTimer(): void {
    if (this.chipTimer !== null) {
      clearTimeout(this.chipTimer);
      this.chipTimer = null;
    }
  }

  clearJoinChip(): void {
    this.pauseJoinChipTimer();
    this.arrivals.length = 0;
    this.onJoinChipChange();
  }

  armJoinChipTimer(isFocusedAndVisible: boolean): void {
    this.pauseJoinChipTimer();
    if (this.arrivals.length === 0 || !isFocusedAndVisible) return;
    this.chipTimer = setTimeout(() => {
      this.chipTimer = null;
      this.arrivals.length = 0;
      this.onJoinChipChange();
    }, JOIN_CHIP_DURATION_MS);
  }

  resetRoom(): void {
    this.departures.clear();
    this.unread.clear();
    this.clearJoinChip();
  }
}
