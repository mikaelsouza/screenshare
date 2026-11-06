import { describe, expect, it } from "vitest";
import {
  deriveViewState,
  shouldRequestRemoteVideo,
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

            // Invariant 2: Live stream controls are visible iff connected AND sharing.
            expect(state.liveControlsHidden).toBe(!(connected && sharing));

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
