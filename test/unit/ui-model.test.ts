import { describe, expect, it } from "vitest";
import {
  computeVolumeState,
  deriveOutboundAudioState,
  deriveViewState,
  nextPopoverState,
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
      muteAudioHidden: true,
      stageEmptyHidden: true,
      stageEmptyTitle: "No one is sharing right now",
      stageEmptySubtitle: 'Click "Share screen" below to start, or wait for someone to share.',
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
    expect(state.muteAudioHidden).toBe(true);
    expect(state.stageEmptyHidden).toBe(true);
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
      muteAudioHidden: true,
      stageEmptyHidden: true,
      stageEmptyTitle: "No one is sharing right now",
      stageEmptySubtitle: 'Click "Share screen" below to start, or wait for someone to share.',
      shareButtonText: "Share screen",
      shareButtonVariant: "primary",
      showFocusButtons: false,
    });
  });

  it("shows stageEmpty message when connected with 0 visible tiles", () => {
    const idleState = deriveViewState(true, false, false, 0);
    expect(idleState.stageEmptyHidden).toBe(false);
    expect(idleState.stageEmptyTitle).toBe("No one is sharing right now");
    expect(idleState.stageEmptySubtitle).toBe(
      'Click "Share screen" below to start, or wait for someone to share.',
    );

    const hiddenPreviewState = deriveViewState(true, true, true, 0);
    expect(hiddenPreviewState.stageEmptyHidden).toBe(false);
    expect(hiddenPreviewState.stageEmptyTitle).toBe("Your stream preview is hidden");
    expect(hiddenPreviewState.stageEmptySubtitle).toBe(
      'Click "Show preview" below to bring it back on stage.',
    );
  });

  it("shows liveControls and Stop sharing when connected and sharing", () => {
    const state = deriveViewState(true, true, false, 2);
    expect(state).toEqual({
      lobbyHidden: true,
      roomBarHidden: false,
      controlsHidden: false,
      liveControlsHidden: false,
      togglePreviewHidden: true,
      muteAudioHidden: false,
      stageEmptyHidden: true,
      stageEmptyTitle: "No one is sharing right now",
      stageEmptySubtitle: 'Click "Share screen" below to start, or wait for someone to share.',
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

describe("deriveOutboundAudioState", () => {
  it("returns default ready state when not sharing", () => {
    expect(deriveOutboundAudioState(false, false, false)).toEqual({
      disabled: false,
      muted: false,
      ariaPressed: "false",
      icon: "volumeOn",
      text: "Mute audio",
      title: "Mute or unmute your shared audio",
    });
    expect(deriveOutboundAudioState(false, true, true).disabled).toBe(false);
  });

  it("returns disabled No audio state when sharing without an audio track", () => {
    expect(deriveOutboundAudioState(true, false, false)).toEqual({
      disabled: true,
      muted: false,
      ariaPressed: "false",
      icon: "volumeOff",
      text: "No audio",
      title: "No audio source was shared",
    });
  });

  it("returns unmuted Mute audio state when sharing with an enabled audio track", () => {
    expect(deriveOutboundAudioState(true, true, true)).toEqual({
      disabled: false,
      muted: false,
      ariaPressed: "false",
      icon: "volumeOn",
      text: "Mute audio",
      title: "Mute your shared audio",
    });
  });

  it("returns active muted state with constant Mute audio label when sharing with a disabled (muted) audio track", () => {
    expect(deriveOutboundAudioState(true, true, false)).toEqual({
      disabled: false,
      muted: true,
      ariaPressed: "true",
      icon: "volumeOff",
      text: "Mute audio",
      title: "Unmute your shared audio",
    });
  });
});

describe("nextPopoverState", () => {
  it("opens a popover when closed and closes it when toggled again", () => {
    const opened = nextPopoverState(null, "roster", true, false);
    expect(opened).toEqual({
      active: "roster",
      rosterOpen: true,
      presetOpen: false,
      codecOpen: false,
    });
    const closed = nextPopoverState("roster", "roster", true, false);
    expect(closed).toEqual({
      active: null,
      rosterOpen: false,
      presetOpen: false,
      codecOpen: false,
    });
  });

  it("switches directly between popovers while closing the previous one", () => {
    const preset = nextPopoverState("roster", "preset", true, true);
    expect(preset).toEqual({
      active: "preset",
      rosterOpen: false,
      presetOpen: true,
      codecOpen: false,
    });
    const codec = nextPopoverState("preset", "codec", true, true);
    expect(codec).toEqual({
      active: "codec",
      rosterOpen: false,
      presetOpen: false,
      codecOpen: true,
    });
    const closedAll = nextPopoverState("codec", null, true, true);
    expect(closedAll).toEqual({
      active: null,
      rosterOpen: false,
      presetOpen: false,
      codecOpen: false,
    });
  });

  it("refuses to open roster when disconnected or preset/codec when not sharing", () => {
    expect(nextPopoverState(null, "roster", false, true).active).toBeNull();
    expect(nextPopoverState(null, "preset", true, false).active).toBeNull();
    expect(nextPopoverState(null, "codec", true, false).active).toBeNull();
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
