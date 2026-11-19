import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JOIN_CHIP_DURATION_MS,
  PopoverToastController,
  RECENT_DEPARTURE_MS,
} from "@src/controllers/popover-toast-controller";

describe("PopoverToastController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces exclusive popover transitions and clears unread/join-chip on roster open/close", () => {
    const onJoinChipChange = vi.fn();
    const ctrl = new PopoverToastController({ onJoinChipChange });

    ctrl.recordArrival({ id: "peer1", name: "Alice" }, { isFocusedAndVisible: true });
    expect(ctrl.hasUnreadDot()).toBe(true);
    expect(ctrl.getJoinChipText(true)).toBe("Alice #peer joined");
    expect(ctrl.getJoinChipText(false)).toBe("");

    const openInvite = ctrl.applyPopover("invite", true, false);
    expect(openInvite.visibility.inviteOpen).toBe(true);
    expect(openInvite.closedInvite).toBe(false);
    expect(ctrl.activePopover).toBe("invite");

    const openRoster = ctrl.applyPopover("roster", true, false);
    expect(openRoster.closedInvite).toBe(true);
    expect(openRoster.openedRoster).toBe(true);
    expect(ctrl.hasUnreadDot()).toBe(false);
    expect(ctrl.joinChipArrivals).toHaveLength(0);
    expect(ctrl.unreadPeerIds.has("peer1")).toBe(true);

    const closeRoster = ctrl.applyPopover("roster", true, false);
    expect(closeRoster.closedRoster).toBe(true);
    expect(ctrl.unreadPeerIds.size).toBe(0);
    expect(ctrl.activePopover).toBeNull();
  });

  it("suppresses arrivals for replaces reconnects, recent departures, and while roster is open", () => {
    const onJoinChipChange = vi.fn();
    const ctrl = new PopoverToastController({ onJoinChipChange });

    // Reconnect via replaces
    expect(ctrl.recordArrival({ id: "p2", name: "Bob" }, { replaces: "p1", now: 1000 })).toBe(false);
    expect(ctrl.unreadPeerIds.size).toBe(0);

    // Recent departure within RECENT_DEPARTURE_MS
    ctrl.recordDeparture("p3", 10_000);
    expect(ctrl.wasRecentDeparture("p3", 10_000 + RECENT_DEPARTURE_MS - 1)).toBe(true);
    expect(ctrl.recordArrival({ id: "p3", name: "Cara" }, { now: 10_000 + RECENT_DEPARTURE_MS - 1 })).toBe(false);

    // Expired departure allows arrival again
    expect(ctrl.wasRecentDeparture("p3", 10_000 + RECENT_DEPARTURE_MS)).toBe(false);
    expect(ctrl.recordArrival({ id: "p3", name: "Cara" }, { now: 10_000 + RECENT_DEPARTURE_MS })).toBe(true);
    expect(ctrl.unreadPeerIds.has("p3")).toBe(true);

    // Roster open suppresses both recordArrival and enqueueArrivalUnchecked
    ctrl.applyPopover("roster", true, false);
    expect(ctrl.recordArrival({ id: "p4", name: "Dan" }, { now: 20_000 })).toBe(false);
    ctrl.enqueueArrivalUnchecked({ id: "p5", name: "Eve" });
    expect(ctrl.unreadPeerIds.has("p4")).toBe(false);
    expect(ctrl.unreadPeerIds.has("p5")).toBe(false);
  });

  it("coalesces burst arrivals, pauses timer when unfocused, and dismisses after duration when focused", () => {
    const onJoinChipChange = vi.fn();
    const ctrl = new PopoverToastController({ onJoinChipChange });

    ctrl.recordArrival({ id: "aaaa1", name: "  " }, { isFocusedAndVisible: false });
    ctrl.enqueueArrivalUnchecked({ id: "bbbb2", name: "Bob" });
    expect(ctrl.getJoinChipText(true)).toBe("Anonymous #aaaa & Bob #bbbb joined");

    // Unfocused: timer must NOT dismiss chip
    vi.advanceTimersByTime(JOIN_CHIP_DURATION_MS * 3);
    expect(ctrl.joinChipArrivals).toHaveLength(2);

    // Focusing arms timer
    ctrl.armJoinChipTimer(true);
    vi.advanceTimersByTime(JOIN_CHIP_DURATION_MS - 1);
    expect(ctrl.joinChipArrivals).toHaveLength(2);

    // Pausing prevents dismissal
    ctrl.pauseJoinChipTimer();
    vi.advanceTimersByTime(JOIN_CHIP_DURATION_MS * 2);
    expect(ctrl.joinChipArrivals).toHaveLength(2);

    // Re-arming dismisses cleanly
    ctrl.armJoinChipTimer(true);
    vi.advanceTimersByTime(JOIN_CHIP_DURATION_MS);
    expect(ctrl.joinChipArrivals).toHaveLength(0);
    expect(ctrl.getJoinChipText(true)).toBe("");
  });

  it("removes individual unread peers and resets all room arrival state", () => {
    const ctrl = new PopoverToastController({ onJoinChipChange: vi.fn() });
    ctrl.recordArrival({ id: "p1", name: "A" }, {});
    ctrl.recordDeparture("p2", 1000);
    ctrl.removeUnread("p1");
    expect(ctrl.unreadPeerIds.has("p1")).toBe(false);

    ctrl.resetRoom();
    expect(ctrl.unreadPeerIds.size).toBe(0);
    expect(ctrl.joinChipArrivals).toHaveLength(0);
    expect(ctrl.wasRecentDeparture("p2", 1001)).toBe(false);
  });

  it("coalesces burst arrivals while ignoring interleaved replaces reconnects and resets dismissal window", () => {
    const onJoinChipChange = vi.fn();
    const ctrl = new PopoverToastController({ onJoinChipChange });

    expect(ctrl.recordArrival({ id: "aaaa1", name: "Alice" }, { now: 1000, isFocusedAndVisible: true })).toBe(true);
    vi.advanceTimersByTime(JOIN_CHIP_DURATION_MS - 500);

    // Interleaved reconnect via replaces must NOT add to chip, unread, or reset the timer
    expect(ctrl.recordArrival({ id: "rrrr1", name: "Reconnector" }, { replaces: "old1", now: 1500, isFocusedAndVisible: true })).toBe(false);
    expect(ctrl.joinChipArrivals).toHaveLength(1);
    expect(ctrl.unreadPeerIds.has("rrrr1")).toBe(false);

    // Second genuine arrival coalesces and extends the full JOIN_CHIP_DURATION_MS timer
    expect(ctrl.recordArrival({ id: "bbbb2", name: "Bob" }, { now: 2000, isFocusedAndVisible: true })).toBe(true);
    expect(ctrl.getJoinChipText(true)).toBe("Alice #aaaa & Bob #bbbb joined");

    vi.advanceTimersByTime(600);
    expect(ctrl.joinChipArrivals).toHaveLength(2);

    // Third arrival switches to N-others format
    expect(ctrl.recordArrival({ id: "cccc3", name: "Cara" }, { now: 2600, isFocusedAndVisible: true })).toBe(true);
    expect(ctrl.getJoinChipText(true)).toBe("Alice #aaaa + 2 others joined");

    vi.advanceTimersByTime(JOIN_CHIP_DURATION_MS);
    expect(ctrl.joinChipArrivals).toHaveLength(0);
    expect(ctrl.getJoinChipText(true)).toBe("");
    // Unread peers remain tracked until roster is opened and closed
    expect(ctrl.unreadPeerIds.size).toBe(3);
    expect(ctrl.hasUnreadDot()).toBe(true);
  });

  it("refreshes departure grace window on repeated leave and prunes expired entries", () => {
    const ctrl = new PopoverToastController({ onJoinChipChange: vi.fn() });
    ctrl.recordDeparture("p1", 10_000);
    ctrl.recordDeparture("p2", 12_000);

    // At 17_999ms, p1 is still within RECENT_DEPARTURE_MS (8_000)
    expect(ctrl.recordArrival({ id: "p1", name: "A" }, { now: 10_000 + RECENT_DEPARTURE_MS - 1 })).toBe(false);

    // Repeated departure refreshes p1's grace window
    ctrl.recordDeparture("p1", 17_000);
    expect(ctrl.wasRecentDeparture("p1", 10_000 + RECENT_DEPARTURE_MS + 1)).toBe(true);

    // At 20_000ms, p2 (departed at 12_000) is pruned while p1 (departed at 17_000) remains suppressed
    expect(ctrl.wasRecentDeparture("p2", 12_000 + RECENT_DEPARTURE_MS)).toBe(false);
    expect(ctrl.wasRecentDeparture("p1", 12_000 + RECENT_DEPARTURE_MS)).toBe(true);
    expect(ctrl.recordArrival({ id: "p2", name: "B" }, { now: 12_000 + RECENT_DEPARTURE_MS })).toBe(true);
  });

  it("handles unread dot clearing on roster-to-invite switch, disconnect, and blank-name enqueue", () => {
    const onJoinChipChange = vi.fn();
    const ctrl = new PopoverToastController({ onJoinChipChange });

    ctrl.enqueueArrivalUnchecked({ id: "zzzz1", name: "   " });
    expect(ctrl.getJoinChipText(true)).toBe("Anonymous #zzzz joined");
    expect(ctrl.hasUnreadDot()).toBe(true);

    // Opening invite keeps unread dot visible
    ctrl.applyPopover("invite", true, false);
    expect(ctrl.hasUnreadDot()).toBe(true);

    // Switching to roster hides dot and clears chip, retaining unreadPeerIds for 'new' badges
    const toRoster = ctrl.applyPopover("roster", true, false);
    expect(toRoster.closedInvite).toBe(true);
    expect(toRoster.openedRoster).toBe(true);
    expect(ctrl.hasUnreadDot()).toBe(false);
    expect(ctrl.unreadPeerIds.has("zzzz1")).toBe(true);

    // Switching directly from roster to invite counts as closedRoster and clears unreadPeerIds
    const toInvite = ctrl.applyPopover("invite", true, false);
    expect(toInvite.closedRoster).toBe(true);
    expect(ctrl.unreadPeerIds.size).toBe(0);

    // Disconnecting while roster is open also closes roster and clears unreadPeerIds
    ctrl.recordArrival({ id: "yyyy2", name: "Yara" }, {});
    ctrl.applyPopover("roster", true, false);
    expect(ctrl.unreadPeerIds.has("yyyy2")).toBe(true);
    const onDisconnect = ctrl.applyPopover("roster", false, false);
    expect(onDisconnect.closedRoster).toBe(true);
    expect(ctrl.activePopover).toBeNull();
    expect(ctrl.unreadPeerIds.size).toBe(0);

    // armJoinChipTimer(true) when no arrivals exist is a safe no-op
    onJoinChipChange.mockClear();
    ctrl.armJoinChipTimer(true);
    vi.advanceTimersByTime(JOIN_CHIP_DURATION_MS * 2);
    expect(onJoinChipChange).not.toHaveBeenCalled();
  });
});
