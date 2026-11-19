import { describe, expect, it } from "vitest";
import { SELF_TILE, TileController } from "@src/controllers/tile-controller";

describe("TileController", () => {
  it("tracks tile registration, visibility count, focus toggling, and self preview hiding", () => {
    const ctrl = new TileController();
    ctrl.registerTile("p1");
    ctrl.registerTile("p2");
    ctrl.registerTile(SELF_TILE, false);

    expect(ctrl.hasTile("p1")).toBe(true);
    expect(ctrl.tileIds()).toEqual(["p1", "p2", SELF_TILE]);
    expect(ctrl.visibleTileCount()).toBe(3);

    expect(ctrl.toggleFocus("p1")).toBe("p1");
    expect(ctrl.focusedPeerId).toBe("p1");
    expect(ctrl.toggleFocus("p1")).toBeNull();

    // Hiding self preview clears focus if self tile was focused
    ctrl.toggleFocus(SELF_TILE);
    expect(ctrl.setSelfPreviewHidden(true)).toEqual({ clearedFocus: true });
    expect(ctrl.selfPreviewHidden).toBe(true);
    expect(ctrl.focusedPeerId).toBeNull();
    expect(ctrl.visibleTileCount()).toBe(2);

    // Setting hidden on unregistered tile is a safe no-op
    ctrl.setTileHidden("missing", true);
    expect(ctrl.setSelfPreviewHidden(false)).toEqual({ clearedFocus: false });
    expect(ctrl.visibleTileCount()).toBe(3);

    // Unregistering focused tile reports clearedFocus: true
    ctrl.toggleFocus("p2");
    expect(ctrl.unregisterTile("p2")).toEqual({ clearedFocus: true });
    expect(ctrl.unregisterTile("p1")).toEqual({ clearedFocus: false });
  });

  it("deduplicates MediaStream listener wiring with WeakSet and supports reset", () => {
    const ctrl = new TileController();
    const streamA = { id: "stream-a" };
    const streamB = { id: "stream-b" };

    expect(ctrl.markStreamWired(streamA)).toBe(true);
    expect(ctrl.markStreamWired(streamA)).toBe(false);
    expect(ctrl.markStreamWired(streamB)).toBe(true);

    ctrl.resetWiredStreams();
    expect(ctrl.markStreamWired(streamA)).toBe(true);
  });

  it("manages names, tile labels, audio volume/mute, pause, visibility, and stats HUD", () => {
    const ctrl = new TileController();
    ctrl.setName("abcd1234", "Alice");
    expect(ctrl.getName("abcd1234")).toBe("Alice");
    expect(ctrl.formatTileLabel("abcd1234")).toBe("Alice #abcd");
    expect(ctrl.formatTileLabel(SELF_TILE)).toBe("You");
    expect(ctrl.formatTileLabel("zzzz9999")).toBe("Peer #zzzz");
    ctrl.deleteName("abcd1234");
    expect(ctrl.getName("abcd1234", "fallback")).toBe("fallback");

    expect(ctrl.listeningFor("p1")).toEqual({ volume: 1, muted: false });
    expect(ctrl.toggleMute("p1")).toEqual({ volume: 1, muted: true });
    expect(ctrl.setMuted("p1", false)).toEqual({ volume: 1, muted: false });

    const boosted = ctrl.setVolumeFromSlider("p1", 150);
    expect(boosted.boosted).toBe(true);
    expect(ctrl.listeningFor("p1")).toEqual({ volume: 1.5, muted: false });

    const silenced = ctrl.setVolumeFromSlider("p1", 0);
    expect(silenced.muted).toBe(true);
    expect(ctrl.listeningFor("p1")).toEqual({ volume: 1.5, muted: true });

    expect(ctrl.shouldRequestVideo("p1", false)).toBeNull();
    ctrl.setOnScreen("p1", true);
    expect(ctrl.shouldRequestVideo("p1", false)).toBe(true);
    ctrl.setPaused("p1", true);
    expect(ctrl.isPaused("p1")).toBe(true);
    expect(ctrl.shouldRequestVideo("p1", true)).toBe(false);
    ctrl.setPaused("p1", false);
    expect(ctrl.shouldRequestVideo("p1", true)).toBe(true);

    expect(ctrl.isStatsOpen("p1")).toBe(false);
    expect(ctrl.toggleStats("p1")).toBe(true);
    expect(ctrl.isStatsOpen("p1")).toBe(true);
    expect(ctrl.toggleStats("p1")).toBe(false);
  });

  it("formats outbound stats, derives view state, and tears down peer/room state", () => {
    const ctrl = new TileController();
    ctrl.registerTile("p1");
    ctrl.setPeerOutboundText("p1", "↑ 4.2 Mbps");
    expect(ctrl.getPeerOutboundText("p1")).toBe("↑ 4.2 Mbps");
    ctrl.setPeerOutboundText("p1", null);
    expect(ctrl.getPeerOutboundText("p1")).toBe("");

    ctrl.setOutboundSummary(2, 6.45);
    expect(ctrl.activeViewerCount).toBe(2);
    expect(ctrl.totalOutboundMbps).toBe(6.45);
    expect(ctrl.formatRosterHeaderTitle(3, true, true)).toBe("In this room (3, locked) · ↑ 6.5 Mbps (2/2 watching)");
    expect(ctrl.formatRosterHeaderTitle(3, false, false)).toBe("In this room (3)");

    ctrl.clearOutboundStats();
    expect(ctrl.formatRosterHeaderTitle(2, false, true)).toBe("In this room (2) (0/1 watching)");

    const view = ctrl.deriveView(true, false);
    expect(view.lobbyHidden).toBe(true);
    expect(view.stageEmptyHidden).toBe(true);

    ctrl.setName("p1", "Alice");
    ctrl.listeningFor("p1");
    ctrl.toggleFocus("p1");
    expect(ctrl.teardownPeer("p1")).toEqual({ clearedFocus: true });
    expect(ctrl.hasTile("p1")).toBe(false);

    ctrl.listeningFor("p2");
    ctrl.clearListening();
    expect(ctrl.listeningFor("p2")).toEqual({ volume: 1, muted: false });

    ctrl.registerTile("p3");
    ctrl.resetAll();
    expect(ctrl.tileIds()).toEqual([]);
    expect(ctrl.focusedPeerId).toBeNull();
  });

  it("handles SELF_TILE hide/show without disturbing another focused peer and respects pre-hidden state", () => {
    const ctrl = new TileController();
    ctrl.registerTile("p1");
    ctrl.registerTile("p2");
    ctrl.registerTile(SELF_TILE, false);

    // Focus p1, then hide SELF_TILE: must NOT clear p1's focus
    ctrl.toggleFocus("p1");
    expect(ctrl.setSelfPreviewHidden(true)).toEqual({ clearedFocus: false });
    expect(ctrl.focusedPeerId).toBe("p1");
    expect(ctrl.visibleTileCount()).toBe(2);

    // Re-registering SELF_TILE while selfPreviewHidden is true keeps it excluded from visibleTileCount
    ctrl.unregisterTile(SELF_TILE);
    ctrl.registerTile(SELF_TILE, false);
    expect(ctrl.visibleTileCount()).toBe(2);

    // Showing self preview again restores visibility
    expect(ctrl.setSelfPreviewHidden(false)).toEqual({ clearedFocus: false });
    expect(ctrl.visibleTileCount()).toBe(3);

    // Focusing SELF_TILE and hiding clears focus cleanly
    ctrl.toggleFocus(SELF_TILE);
    expect(ctrl.focusedPeerId).toBe(SELF_TILE);
    expect(ctrl.setSelfPreviewHidden(true)).toEqual({ clearedFocus: true });
    expect(ctrl.focusedPeerId).toBeNull();
  });

  it("evaluates shouldRequestVideo across unknown/offscreen/on-screen, PiP, and paused states", () => {
    const ctrl = new TileController();

    // Unknown visibility
    expect(ctrl.shouldRequestVideo("p1", false)).toBeNull();
    expect(ctrl.shouldRequestVideo("p1", true)).toBe(true);

    // Offscreen without PiP -> false; with PiP -> true
    ctrl.setOnScreen("p1", false);
    expect(ctrl.shouldRequestVideo("p1", false)).toBe(false);
    expect(ctrl.shouldRequestVideo("p1", true)).toBe(true);

    // Paused overrides both on-screen and PiP
    ctrl.setPaused("p1", true);
    expect(ctrl.shouldRequestVideo("p1", true)).toBe(false);
    ctrl.setOnScreen("p1", true);
    expect(ctrl.shouldRequestVideo("p1", false)).toBe(false);
    expect(ctrl.shouldRequestVideo("p1", true)).toBe(false);

    // Unpausing restores on-screen request
    ctrl.setPaused("p1", false);
    expect(ctrl.shouldRequestVideo("p1", false)).toBe(true);
  });

  it("cleans up all peer state on teardownPeer and resets WeakSet stream deduplication on resetAll", () => {
    const ctrl = new TileController();
    const stream = { id: "s1" };
    expect(ctrl.markStreamWired(stream)).toBe(true);
    expect(ctrl.markStreamWired(stream)).toBe(false);

    ctrl.registerTile("p1");
    ctrl.setName("p1", "Alice");
    ctrl.setVolumeFromSlider("p1", 150);
    ctrl.setPaused("p1", true);
    ctrl.setOnScreen("p1", true);
    ctrl.toggleStats("p1");
    ctrl.setPeerOutboundText("p1", "↑ 3.0 Mbps");
    ctrl.toggleFocus("p1");

    // First teardownPeer clears focus and all per-peer maps
    expect(ctrl.teardownPeer("p1")).toEqual({ clearedFocus: true });
    expect(ctrl.focusedPeerId).toBeNull();
    expect(ctrl.hasTile("p1")).toBe(false);
    expect(ctrl.getName("p1", "fallback")).toBe("fallback");
    expect(ctrl.listeningFor("p1")).toEqual({ volume: 1, muted: false });
    expect(ctrl.isPaused("p1")).toBe(false);
    expect(ctrl.isStatsOpen("p1")).toBe(false);
    expect(ctrl.shouldRequestVideo("p1", false)).toBeNull();
    expect(ctrl.getPeerOutboundText("p1")).toBe("");

    // Subsequent unregisterTile after teardownPeer reports clearedFocus: false
    expect(ctrl.unregisterTile("p1")).toEqual({ clearedFocus: false });

    // formatRosterHeaderTitle clamps othersCount >= 0 when totalCount <= 1
    expect(ctrl.formatRosterHeaderTitle(1, false, true)).toBe("In this room (1) (0/0 watching)");
    expect(ctrl.formatRosterHeaderTitle(0, true, true)).toBe("In this room (0, locked) (0/0 watching)");

    // resetAll clears WeakSet so the same stream instance can be wired again
    ctrl.resetAll();
    expect(ctrl.markStreamWired(stream)).toBe(true);
  });
});
