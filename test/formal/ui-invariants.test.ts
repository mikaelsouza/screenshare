import { describe, expect, it } from "vitest";
import {
  deriveOutboundAudioState,
  deriveViewState,
  nextPopoverState,
  shouldRequestRemoteVideo,
  type PopoverKind,
} from "@src/ui-model";

describe("Formal State-Machine Proofs: UI View & Bandwidth Invariants", () => {
  it("exhaustively verifies view-state mutual exclusion and button invariants across all boolean & tile-count states", () => {
    const bools = [false, true];
    const tileCounts = [0, 1, 2, 3, 8, 20];

    for (const connected of bools) {
      for (const sharing of bools) {
        for (const selfPreviewHidden of bools) {
          for (const visibleTileCount of tileCounts) {
            const state = deriveViewState(connected, sharing, selfPreviewHidden, visibleTileCount);

            // Invariant 1: Lobby and Room controls are strictly mutually exclusive.
            expect(state.lobbyHidden).toBe(!state.roomBarHidden);
            expect(state.lobbyHidden).toBe(!state.controlsHidden);

            // Invariant 2: Live stream controls and outbound Mute button are visible iff connected AND sharing.
            expect(state.liveControlsHidden).toBe(!(connected && sharing));
            expect(state.muteAudioHidden).toBe(!(connected && sharing));

            // Invariant 3: Show preview button is visible iff connected AND sharing AND selfPreviewHidden.
            expect(state.togglePreviewHidden).toBe(!(connected && sharing && selfPreviewHidden));

            // Invariant 4: Share button text & variant match active sharing state in a room.
            if (connected && sharing) {
              expect(state.shareButtonText).toBe("Stop sharing");
              expect(state.shareButtonVariant).toBe("danger");
            } else {
              expect(state.shareButtonText).toBe("Share screen");
              expect(state.shareButtonVariant).toBe("primary");
            }

            // Invariant 5: Focus buttons are shown iff connected and at least 2 tiles are visible.
            expect(state.showFocusButtons).toBe(connected && visibleTileCount >= 2);

            // Invariant 6: Empty-stage placeholder is shown iff connected and 0 tiles are visible.
            expect(state.stageEmptyHidden).toBe(!(connected && visibleTileCount === 0));
          }
        }
      }
    }
  });

  it("exhaustively verifies outbound audio mute button state across all 8 boolean combinations", () => {
    const bools = [false, true];
    for (const sharing of bools) {
      for (const hasAudioTrack of bools) {
        for (const trackEnabled of bools) {
          const st = deriveOutboundAudioState(sharing, hasAudioTrack, trackEnabled);

          // Invariant 1: ariaPressed always equals String(st.muted).
          expect(st.ariaPressed).toBe(st.muted ? "true" : "false");

          // Invariant 2: Disabled iff sharing without an audio track.
          expect(st.disabled).toBe(sharing && !hasAudioTrack);

          // Invariant 3: Muted iff actively sharing an audio track that is disabled.
          expect(st.muted).toBe(sharing && hasAudioTrack && !trackEnabled);

          // Invariant 4: Icon and text are strictly determined by disabled and muted flags.
          if (st.disabled) {
            expect(st.icon).toBe("volumeOff");
            expect(st.text).toBe("No audio");
          } else if (st.muted) {
            expect(st.icon).toBe("volumeOff");
            expect(st.text).toBe("Mute audio");
          } else {
            expect(st.icon).toBe("volumeOn");
            expect(st.text).toBe("Mute audio");
          }
        }
      }
    }
  });

  it("exhaustively verifies popover mutual exclusion across all 64 state transitions", () => {
    const popovers: Array<PopoverKind | null> = [null, "roster", "preset", "codec"];
    const bools = [false, true];

    for (const current of popovers) {
      for (const target of popovers) {
        for (const connected of bools) {
          for (const sharing of bools) {
            const next = nextPopoverState(current, target, connected, sharing);

            // Invariant 1: At most one popover is open at any time.
            const openCount = Number(next.rosterOpen) + Number(next.presetOpen) + Number(next.codecOpen);
            expect(openCount).toBeLessThanOrEqual(1);

            // Invariant 2: `active` matches the unique open popover, or null if none.
            if (next.rosterOpen) expect(next.active).toBe("roster");
            else if (next.presetOpen) expect(next.active).toBe("preset");
            else if (next.codecOpen) expect(next.active).toBe("codec");
            else expect(next.active).toBeNull();

            // Invariant 3: Toggling the already-open popover or passing null always closes all popovers.
            if (target === null || target === current) {
              expect(next.active).toBeNull();
              expect(openCount).toBe(0);
            }

            // Invariant 4: No popover can open when disconnected; preset/codec cannot open when not sharing.
            if (!connected) {
              expect(next.active).toBeNull();
            }
            if (!sharing) {
              expect(next.presetOpen).toBe(false);
              expect(next.codecOpen).toBe(false);
            }
          }
        }
      }
    }
  });

  it("exhaustively verifies remote video request decision table across all 12 state combinations", () => {
    const onScreenStates: Array<boolean | undefined> = [undefined, false, true];
    const bools = [false, true];

    for (const onScreen of onScreenStates) {
      for (const isPip of bools) {
        for (const isPaused of bools) {
          const decision = shouldRequestRemoteVideo(onScreen, isPip, isPaused);

          // Invariant A: Manual pause unconditionally halts video delivery.
          if (isPaused) {
            expect(decision).toBe(false);
            continue;
          }

          // Invariant B: Active Picture-in-Picture while unpaused unconditionally requests video.
          if (isPip) {
            expect(decision).toBe(true);
            continue;
          }

          // Invariant C: Before IntersectionObserver fires, no premature message is sent.
          if (onScreen === undefined) {
            expect(decision).toBeNull();
            continue;
          }

          // Invariant D: Otherwise matches viewport intersection state.
          expect(decision).toBe(onScreen);
        }
      }
    }
  });
});
