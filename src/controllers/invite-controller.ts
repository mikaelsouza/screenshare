import { deriveInviteMenuState, type InviteMenuParams, type InviteMenuState } from "../ui-model";

export interface InviteFeedbackState {
  linkText: string;
  linkOk: boolean;
  codeText: string;
  codeOk: boolean;
  rotateText: string;
  rotateOk: boolean;
}

export interface InviteControllerCallbacks {
  onChange: () => void;
}

export const INVITE_REVEAL_MS = 10_000;
export const INVITE_COPY_FEEDBACK_MS = 2_000;
export const INVITE_ROTATE_FEEDBACK_MS = 1_600;
export const INVITE_ROTATE_TIMEOUT_MS = 10_000;

/**
 * Pure, DOM-free controller for the room invite menu: secret reveal/mask,
 * 10s auto-hide timer, copy/rotate feedback timers, and rotate-in-flight state.
 */
export class InviteController {
  private revealed = false;
  private rotatePending = false;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  private linkFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private codeFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private rotateFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private rotatePendingTimer: ReturnType<typeof setTimeout> | null = null;
  private linkText = "";
  private linkOk = false;
  private codeText = "Copy";
  private codeOk = false;
  private rotateText = "Rotate";
  private rotateOk = false;
  private readonly onChange: () => void;

  constructor(callbacks: InviteControllerCallbacks) {
    this.onChange = callbacks.onChange;
  }

  get isRevealed(): boolean {
    return this.revealed;
  }

  get isRotatePending(): boolean {
    return this.rotatePending;
  }

  getFeedback(): InviteFeedbackState {
    return {
      linkText: this.linkText,
      linkOk: this.linkOk,
      codeText: this.codeText,
      codeOk: this.codeOk,
      rotateText: this.rotateText,
      rotateOk: this.rotateOk,
    };
  }

  deriveMenu(params: Omit<InviteMenuParams, "revealed" | "rotating">): InviteMenuState {
    return deriveInviteMenuState({
      ...params,
      revealed: this.revealed,
      rotating: this.rotatePending,
    });
  }

  setRevealed(revealed: boolean): void {
    this.clearRevealTimer();
    this.revealed = revealed;
    if (revealed) {
      this.revealTimer = setTimeout(() => {
        this.revealTimer = null;
        this.revealed = false;
        this.onChange();
      }, INVITE_REVEAL_MS);
    }
    this.onChange();
  }

  hideIfRevealed(): void {
    if (this.revealed) {
      this.setRevealed(false);
    }
  }

  resetCopyFeedback(): void {
    if (this.linkFeedbackTimer !== null) {
      clearTimeout(this.linkFeedbackTimer);
      this.linkFeedbackTimer = null;
    }
    if (this.codeFeedbackTimer !== null) {
      clearTimeout(this.codeFeedbackTimer);
      this.codeFeedbackTimer = null;
    }
    this.linkText = "";
    this.linkOk = false;
    this.codeText = "Copy";
    this.codeOk = false;
    this.onChange();
  }

  showCopyFeedback(mode: "link" | "code"): void {
    if (mode === "link") {
      if (this.linkFeedbackTimer !== null) clearTimeout(this.linkFeedbackTimer);
      this.linkText = "Copied!";
      this.linkOk = true;
      this.linkFeedbackTimer = setTimeout(() => {
        this.linkFeedbackTimer = null;
        this.linkText = "";
        this.linkOk = false;
        this.onChange();
      }, INVITE_COPY_FEEDBACK_MS);
    } else {
      if (this.codeFeedbackTimer !== null) clearTimeout(this.codeFeedbackTimer);
      this.codeText = "Copied!";
      this.codeOk = true;
      this.codeFeedbackTimer = setTimeout(() => {
        this.codeFeedbackTimer = null;
        this.codeText = "Copy";
        this.codeOk = false;
        this.onChange();
      }, INVITE_COPY_FEEDBACK_MS);
    }
    this.onChange();
  }

  beginRotate(): boolean {
    if (this.rotatePending) return false;
    this.clearRevealTimer();
    this.revealed = false;
    this.rotatePending = true;
    this.clearCopyTimersOnly();
    this.linkText = "";
    this.linkOk = false;
    this.codeText = "Copy";
    this.codeOk = false;
    this.clearRotateFeedbackTimer();
    this.rotateOk = false;
    this.rotateText = "Rotating\u2026";
    this.clearRotatePendingTimer();
    this.rotatePendingTimer = setTimeout(() => {
      this.rotatePendingTimer = null;
      if (!this.rotatePending) return;
      this.rotatePending = false;
      this.rotateText = "Rotate";
      this.onChange();
    }, INVITE_ROTATE_TIMEOUT_MS);
    this.onChange();
    return true;
  }

  completeRotate(): void {
    const wasRotating = this.rotatePending;
    this.rotatePending = false;
    this.clearRotatePendingTimer();
    this.clearRevealTimer();
    this.revealed = false;
    this.clearCopyTimersOnly();
    this.linkText = "";
    this.linkOk = false;
    this.codeText = "Copy";
    this.codeOk = false;
    if (wasRotating) {
      this.clearRotateFeedbackTimer();
      this.rotateText = "Rotated!";
      this.rotateOk = true;
      this.rotateFeedbackTimer = setTimeout(() => {
        this.rotateFeedbackTimer = null;
        this.rotateText = "Rotate";
        this.rotateOk = false;
        this.onChange();
      }, INVITE_ROTATE_FEEDBACK_MS);
    } else if (this.rotateText === "Rotating\u2026") {
      this.rotateText = "Rotate";
    }
    this.onChange();
  }

  cancelRotate(): void {
    this.rotatePending = false;
    this.clearRotatePendingTimer();
    if (this.rotateText === "Rotating\u2026") {
      this.rotateText = "Rotate";
    }
    this.onChange();
  }

  onRoomLocked(): void {
    this.clearRevealTimer();
    this.revealed = false;
    this.clearCopyTimersOnly();
    this.linkText = "";
    this.linkOk = false;
    this.codeText = "Copy";
    this.codeOk = false;
    this.onChange();
  }

  reset(): void {
    this.rotatePending = false;
    this.clearRotatePendingTimer();
    this.clearRevealTimer();
    this.revealed = false;
    this.clearCopyTimersOnly();
    this.linkText = "";
    this.linkOk = false;
    this.codeText = "Copy";
    this.codeOk = false;
    this.clearRotateFeedbackTimer();
    this.rotateText = "Rotate";
    this.rotateOk = false;
    this.onChange();
  }

  private clearRevealTimer(): void {
    if (this.revealTimer !== null) {
      clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
  }

  private clearCopyTimersOnly(): void {
    if (this.linkFeedbackTimer !== null) {
      clearTimeout(this.linkFeedbackTimer);
      this.linkFeedbackTimer = null;
    }
    if (this.codeFeedbackTimer !== null) {
      clearTimeout(this.codeFeedbackTimer);
      this.codeFeedbackTimer = null;
    }
  }

  private clearRotatePendingTimer(): void {
    if (this.rotatePendingTimer !== null) {
      clearTimeout(this.rotatePendingTimer);
      this.rotatePendingTimer = null;
    }
  }

  private clearRotateFeedbackTimer(): void {
    if (this.rotateFeedbackTimer !== null) {
      clearTimeout(this.rotateFeedbackTimer);
      this.rotateFeedbackTimer = null;
    }
  }
}
