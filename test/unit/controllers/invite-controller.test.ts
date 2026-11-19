import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INVITE_COPY_FEEDBACK_MS,
  INVITE_REVEAL_MS,
  INVITE_ROTATE_FEEDBACK_MS,
  INVITE_ROTATE_TIMEOUT_MS,
  InviteController,
} from "@src/controllers/invite-controller";

describe("InviteController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reveals secret and auto-hides after 10 seconds", () => {
    const onChange = vi.fn();
    const ctrl = new InviteController({ onChange });
    expect(ctrl.isRevealed).toBe(false);

    ctrl.setRevealed(true);
    expect(ctrl.isRevealed).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);

    const menu = ctrl.deriveMenu({
      roomCode: "ABCD1234",
      roomPassword: "SECRET1234567890",
      roomLocked: false,
      isHost: true,
      signalingReady: true,
    });
    expect(menu.displayCode).toBe("ABCD1234-SECRET1234567890");

    vi.advanceTimersByTime(INVITE_REVEAL_MS - 1);
    expect(ctrl.isRevealed).toBe(true);

    vi.advanceTimersByTime(1);
    expect(ctrl.isRevealed).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("hideIfRevealed masks only when currently revealed", () => {
    const onChange = vi.fn();
    const ctrl = new InviteController({ onChange });

    ctrl.hideIfRevealed();
    expect(onChange).not.toHaveBeenCalled();

    ctrl.setRevealed(true);
    ctrl.hideIfRevealed();
    expect(ctrl.isRevealed).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("shows and auto-clears link and code copy feedback timers", () => {
    const onChange = vi.fn();
    const ctrl = new InviteController({ onChange });

    ctrl.showCopyFeedback("link");
    expect(ctrl.getFeedback()).toMatchObject({ linkText: "Copied!", linkOk: true, codeText: "Copy", codeOk: false });

    ctrl.showCopyFeedback("code");
    expect(ctrl.getFeedback()).toMatchObject({ linkText: "Copied!", linkOk: true, codeText: "Copied!", codeOk: true });

    // Re-triggering resets the timer cleanly
    vi.advanceTimersByTime(INVITE_COPY_FEEDBACK_MS / 2);
    ctrl.showCopyFeedback("link");
    vi.advanceTimersByTime(INVITE_COPY_FEEDBACK_MS / 2);
    expect(ctrl.getFeedback().codeText).toBe("Copy");
    expect(ctrl.getFeedback().codeOk).toBe(false);
    expect(ctrl.getFeedback().linkText).toBe("Copied!");
    expect(ctrl.getFeedback().linkOk).toBe(true);

    vi.advanceTimersByTime(INVITE_COPY_FEEDBACK_MS / 2);
    expect(ctrl.getFeedback()).toMatchObject({ linkText: "", linkOk: false, codeText: "Copy", codeOk: false });
  });

  it("resetCopyFeedback clears active link and code feedback immediately", () => {
    const ctrl = new InviteController({ onChange: vi.fn() });
    ctrl.showCopyFeedback("link");
    ctrl.showCopyFeedback("code");
    ctrl.resetCopyFeedback();
    expect(ctrl.getFeedback()).toMatchObject({ linkText: "", linkOk: false, codeText: "Copy", codeOk: false });
  });

  it("handles beginRotate, completeRotate with Rotated! feedback, and timeout fallback", () => {
    const ctrl = new InviteController({ onChange: vi.fn() });
    ctrl.setRevealed(true);
    ctrl.showCopyFeedback("link");

    expect(ctrl.beginRotate()).toBe(true);
    expect(ctrl.beginRotate()).toBe(false);
    expect(ctrl.isRevealed).toBe(false);
    expect(ctrl.isRotatePending).toBe(true);
    expect(ctrl.getFeedback()).toMatchObject({
      linkText: "",
      linkOk: false,
      rotateText: "Rotating\u2026",
      rotateOk: false,
    });

    ctrl.completeRotate();
    expect(ctrl.isRotatePending).toBe(false);
    expect(ctrl.getFeedback()).toMatchObject({ rotateText: "Rotated!", rotateOk: true });

    vi.advanceTimersByTime(INVITE_ROTATE_FEEDBACK_MS);
    expect(ctrl.getFeedback()).toMatchObject({ rotateText: "Rotate", rotateOk: false });

    // Timeout fallback if server never responds
    expect(ctrl.beginRotate()).toBe(true);
    vi.advanceTimersByTime(INVITE_ROTATE_TIMEOUT_MS);
    expect(ctrl.isRotatePending).toBe(false);
    expect(ctrl.getFeedback().rotateText).toBe("Rotate");
  });

  it("handles cancelRotate, completeRotate without pending, onRoomLocked, and reset", () => {
    const ctrl = new InviteController({ onChange: vi.fn() });
    ctrl.beginRotate();
    ctrl.cancelRotate();
    expect(ctrl.isRotatePending).toBe(false);
    expect(ctrl.getFeedback().rotateText).toBe("Rotate");

    // Non-host receives room-password without having initiated rotate
    ctrl.setRevealed(true);
    ctrl.showCopyFeedback("code");
    ctrl.completeRotate();
    expect(ctrl.isRevealed).toBe(false);
    expect(ctrl.getFeedback()).toMatchObject({ codeText: "Copy", rotateText: "Rotate", rotateOk: false });

    // Room locked masks reveal and clears copy feedback
    ctrl.setRevealed(true);
    ctrl.showCopyFeedback("link");
    ctrl.onRoomLocked();
    expect(ctrl.isRevealed).toBe(false);
    expect(ctrl.getFeedback().linkText).toBe("");

    // Full reset clears everything including active Rotated! timer
    ctrl.beginRotate();
    ctrl.completeRotate();
    ctrl.setRevealed(true);
    ctrl.showCopyFeedback("code");
    ctrl.reset();
    expect(ctrl.isRevealed).toBe(false);
    expect(ctrl.isRotatePending).toBe(false);
    expect(ctrl.getFeedback()).toEqual({
      linkText: "",
      linkOk: false,
      codeText: "Copy",
      codeOk: false,
      rotateText: "Rotate",
      rotateOk: false,
    });
  });

  it("masks secret in deriveMenu when locked, missing password, or rotating even if revealed is true", () => {
    const ctrl = new InviteController({ onChange: vi.fn() });
    ctrl.setRevealed(true);

    // Locked room must never expose raw password
    const lockedMenu = ctrl.deriveMenu({
      roomCode: "ABCD2345",
      roomPassword: "SECRET1234567890",
      roomLocked: true,
      isHost: true,
      signalingReady: true,
    });
    expect(lockedMenu.canShow).toBe(false);
    expect(lockedMenu.canCopy).toBe(false);
    expect(lockedMenu.showLockedBanner).toBe(true);
    expect(lockedMenu.displayCode).not.toContain("SECRET1234567890");

    // Missing or empty password must never expose unmasked code
    const nullPassMenu = ctrl.deriveMenu({
      roomCode: "ABCD2345",
      roomPassword: null,
      roomLocked: false,
      isHost: false,
      signalingReady: true,
    });
    expect(nullPassMenu.canShow).toBe(false);
    expect(nullPassMenu.canCopy).toBe(false);
    expect(nullPassMenu.displayCode).toContain("ABCD2345");

    const emptyPassMenu = ctrl.deriveMenu({
      roomCode: "ABCD2345",
      roomPassword: "",
      roomLocked: false,
      isHost: true,
      signalingReady: true,
    });
    expect(emptyPassMenu.canShow).toBe(false);
    expect(emptyPassMenu.canCopy).toBe(false);

    // Rotating disables copy/show/rotate and masks secret
    ctrl.beginRotate();
    const rotatingMenu = ctrl.deriveMenu({
      roomCode: "ABCD2345",
      roomPassword: "SECRET1234567890",
      roomLocked: false,
      isHost: true,
      signalingReady: true,
    });
    expect(rotatingMenu.canShow).toBe(false);
    expect(rotatingMenu.canCopy).toBe(false);
    expect(rotatingMenu.canRotate).toBe(false);
    expect(rotatingMenu.displayCode).not.toContain("SECRET1234567890");
  });

  it("resets auto-remask timer on repeated reveal and cancels stale timers on blur/visibility/lock/reset", () => {
    const onChange = vi.fn();
    const ctrl = new InviteController({ onChange });

    // Repeated setRevealed(true) extends the 10s window instead of firing on the first timer
    ctrl.setRevealed(true);
    vi.advanceTimersByTime(INVITE_REVEAL_MS - 1_000);
    ctrl.setRevealed(true);
    vi.advanceTimersByTime(2_000);
    expect(ctrl.isRevealed).toBe(true);

    // Simulated blur / visibilitychange hidden via hideIfRevealed cancels pending timer cleanly
    onChange.mockClear();
    ctrl.hideIfRevealed();
    expect(ctrl.isRevealed).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INVITE_REVEAL_MS * 2);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Simulated startShare / popover close via setRevealed(false) cancels pending timer
    ctrl.setRevealed(true);
    onChange.mockClear();
    ctrl.setRevealed(false);
    expect(ctrl.isRevealed).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INVITE_REVEAL_MS * 2);
    expect(onChange).toHaveBeenCalledTimes(1);

    // onRoomLocked cancels reveal + both copy feedback timers with no stale callbacks later
    ctrl.setRevealed(true);
    ctrl.showCopyFeedback("link");
    ctrl.showCopyFeedback("code");
    onChange.mockClear();
    ctrl.onRoomLocked();
    expect(ctrl.isRevealed).toBe(false);
    expect(ctrl.getFeedback()).toMatchObject({ linkText: "", linkOk: false, codeText: "Copy", codeOk: false });
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INVITE_REVEAL_MS * 2);
    expect(onChange).toHaveBeenCalledTimes(1);

    // reset() cancels all active timers (reveal, copy link/code, rotate pending, rotate feedback)
    ctrl.beginRotate();
    ctrl.completeRotate();
    ctrl.setRevealed(true);
    ctrl.showCopyFeedback("link");
    ctrl.showCopyFeedback("code");
    onChange.mockClear();
    ctrl.reset();
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INVITE_ROTATE_TIMEOUT_MS * 2);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("handles copy feedback races against resetCopyFeedback, beginRotate, and late completeRotate after timeout", () => {
    const onChange = vi.fn();
    const ctrl = new InviteController({ onChange });

    // resetCopyFeedback cancels active timers so they never fire later
    ctrl.showCopyFeedback("link");
    ctrl.showCopyFeedback("code");
    onChange.mockClear();
    ctrl.resetCopyFeedback();
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INVITE_COPY_FEEDBACK_MS * 2);
    expect(onChange).toHaveBeenCalledTimes(1);

    // beginRotate while Rotated! feedback is active clears the prior feedback timer
    ctrl.beginRotate();
    ctrl.completeRotate();
    expect(ctrl.getFeedback()).toMatchObject({ rotateText: "Rotated!", rotateOk: true });
    vi.advanceTimersByTime(INVITE_ROTATE_FEEDBACK_MS / 2);
    expect(ctrl.beginRotate()).toBe(true);
    expect(ctrl.getFeedback()).toMatchObject({ rotateText: "Rotating\u2026", rotateOk: false });
    vi.advanceTimersByTime(INVITE_ROTATE_FEEDBACK_MS);
    // Prior Rotated! timer must NOT have clobbered Rotating…
    expect(ctrl.isRotatePending).toBe(true);
    expect(ctrl.getFeedback().rotateText).toBe("Rotating\u2026");

    // Timeout expires, then a late completeRotate arrives: must NOT flash "Rotated!", must still mask
    vi.advanceTimersByTime(INVITE_ROTATE_TIMEOUT_MS);
    expect(ctrl.isRotatePending).toBe(false);
    expect(ctrl.getFeedback().rotateText).toBe("Rotate");
    ctrl.setRevealed(true);
    ctrl.completeRotate();
    expect(ctrl.isRevealed).toBe(false);
    expect(ctrl.getFeedback()).toMatchObject({ rotateText: "Rotate", rotateOk: false });

    // cancelRotate when not rotating does not overwrite active Rotated! text
    ctrl.beginRotate();
    ctrl.completeRotate();
    expect(ctrl.getFeedback().rotateText).toBe("Rotated!");
    ctrl.cancelRotate();
    expect(ctrl.getFeedback().rotateText).toBe("Rotated!");
  });
});
