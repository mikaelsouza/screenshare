import { describe, expect, it } from "vitest";
import {
  computeVolumeState,
  deriveViewState,
  shouldRequestRemoteVideo,
  sortAndFormatRoster,
} from "@src/ui-model";

describe("deriveViewState", () => {
  it("shows only the lobby when disconnected", () => {
    const state = deriveViewState(false, false, false, 0);
    expect(state).toEqual({
      lobbyHidden: false,
      roomBarHidden: true,
      controlsHidden: true,
      liveControlsHidden: true,
      togglePreviewHidden: true,
      shareButtonText: "Share screen",
      shareButtonVariant: "primary",
      showFocusButtons: false,
    });
  });

  it("ignores sharing or preview flags when disconnected", () => {
    const state = deriveViewState(false, true, true, 5);
    expect(state.lobbyHidden).toBe(false);
    expect(state.roomBarHidden).toBe(true);
    expect(state.controlsHidden).toBe(true);
    expect(state.liveControlsHidden).toBe(true);
    expect(state.togglePreviewHidden).toBe(true);
    expect(state.showFocusButtons).toBe(false);
  });

  it("shows roomBar and controls but hides liveControls when connected and watching", () => {
    const state = deriveViewState(true, false, false, 1);
    expect(state).toEqual({
      lobbyHidden: true,
      roomBarHidden: false,
      controlsHidden: false,
      liveControlsHidden: true,
      togglePreviewHidden: true,
      shareButtonText: "Share screen",
      shareButtonVariant: "primary",
      showFocusButtons: false,
    });
  });

  it("shows liveControls and Stop sharing when connected and sharing", () => {
    const state = deriveViewState(true, true, false, 2);
    expect(state).toEqual({
      lobbyHidden: true,
      roomBarHidden: false,
      controlsHidden: false,
      liveControlsHidden: false,
      togglePreviewHidden: true,
      shareButtonText: "Stop sharing",
      shareButtonVariant: "danger",
      showFocusButtons: true,
    });
  });

  it("shows togglePreview only when connected, sharing, and selfPreviewHidden is true", () => {
    expect(deriveViewState(true, true, true, 1).togglePreviewHidden).toBe(false);
    expect(deriveViewState(true, true, false, 1).togglePreviewHidden).toBe(true);
    expect(deriveViewState(true, false, true, 1).togglePreviewHidden).toBe(true);
  });
});

describe("shouldRequestRemoteVideo", () => {
  it("always returns false when paused, even if onScreen or PiP is true", () => {
    expect(shouldRequestRemoteVideo(true, true, true)).toBe(false);
    expect(shouldRequestRemoteVideo(true, false, true)).toBe(false);
    expect(shouldRequestRemoteVideo(false, true, true)).toBe(false);
    expect(shouldRequestRemoteVideo(undefined, false, true)).toBe(false);
  });

  it("returns true when in Picture-in-Picture and not paused, even if scrolled off screen", () => {
    expect(shouldRequestRemoteVideo(false, true, false)).toBe(true);
    expect(shouldRequestRemoteVideo(undefined, true, false)).toBe(true);
  });

  it("returns null before IntersectionObserver reports when neither paused nor PiP", () => {
    expect(shouldRequestRemoteVideo(undefined, false, false)).toBeNull();
  });

  it("returns onScreen boolean when not paused and not PiP", () => {
    expect(shouldRequestRemoteVideo(true, false, false)).toBe(true);
    expect(shouldRequestRemoteVideo(false, false, false)).toBe(false);
  });
});

describe("computeVolumeState", () => {
  it("maps 0 to muted", () => {
    expect(computeVolumeState(0)).toEqual({
      volume: 0,
      muted: true,
      boosted: false,
      label: "Volume: 0%",
    });
  });

  it("maps 1..100 to standard unboosted volume", () => {
    expect(computeVolumeState(100)).toEqual({
      volume: 1,
      muted: false,
      boosted: false,
      label: "Volume: 100%",
    });
    expect(computeVolumeState(40)).toEqual({
      volume: 0.4,
      muted: false,
      boosted: false,
      label: "Volume: 40%",
    });
  });

  it("maps 101..200 to boosted volume", () => {
    expect(computeVolumeState(150)).toEqual({
      volume: 1.5,
      muted: false,
      boosted: true,
      label: "Volume: 150%",
    });
    expect(computeVolumeState(101).boosted).toBe(true);
  });

  it("clamps out-of-range and non-finite inputs safely", () => {
    expect(computeVolumeState(-50).volume).toBe(0);
    expect(computeVolumeState(-50).muted).toBe(true);
    expect(computeVolumeState(500).volume).toBe(2);
    expect(computeVolumeState(500).boosted).toBe(true);
    expect(computeVolumeState(Number.NaN, 0.75)).toEqual({
      volume: 0.75,
      muted: false,
      boosted: false,
      label: "Volume: 75%",
    });
  });
});

describe("sortAndFormatRoster", () => {
  it("places self first, sorts remaining members by name then id, and formats the button label", () => {
    const members = new Map([
      ["bbbb1111-0000-4000-8000-000000000000", { name: "charlie", sharing: false, host: false }],
      ["cccc2222-0000-4000-8000-000000000000", { name: "bob", sharing: true, host: false }],
      ["aaaa3333-0000-4000-8000-000000000000", { name: "bob", sharing: false, host: false }],
    ]);

    const res = sortAndFormatRoster(
      "self0000-0000-4000-8000-000000000000",
      "alice",
      true,
      true,
      false,
      members,
    );

    expect(res.totalCount).toBe(4);
    expect(res.sharingCount).toBe(2);
    expect(res.buttonLabel).toBe("4 in room · 2 sharing \u25BE");
    expect(res.entries.map((entry) => entry.id)).toEqual([
      "self0000-0000-4000-8000-000000000000",
      "aaaa3333-0000-4000-8000-000000000000",
      "cccc2222-0000-4000-8000-000000000000",
      "bbbb1111-0000-4000-8000-000000000000",
    ]);
    expect(res.entries[0]?.canKick).toBe(false);
    expect(res.entries[1]?.canKick).toBe(true);
    expect(res.entries[0]?.shortId).toBe("#self");
  });

  it("includes Locked in buttonLabel when roomLocked is true and falls back to Anonymous for blank names", () => {
    const members = new Map([
      ["self0000-0000-4000-8000-000000000000", { name: "ignored-duplicate-self", sharing: true, host: false }],
      ["peer1111-0000-4000-8000-000000000000", { name: "   ", sharing: false, host: true }],
    ]);
    const res = sortAndFormatRoster(
      "self0000-0000-4000-8000-000000000000",
      "   ",
      false,
      false,
      true,
      members,
    );
    expect(res.buttonLabel).toBe("2 in room · 0 sharing · Locked \u25BE");
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]?.name).toBe("Anonymous");
    expect(res.entries[0]?.shortId).toBe("#self");
    expect(res.entries[1]?.name).toBe("Anonymous");
    expect(res.entries[1]?.shortId).toBe("#peer");
    expect(res.entries[1]?.canKick).toBe(false);
  });
});
