import { QUALITY_PRESETS, describeCaptureError, windowAudioSupport, type CaptureResult } from "../capture";
import type { InviteController } from "../controllers/invite-controller";
import type { SessionController } from "../controllers/session-controller";
import type { TileController } from "../controllers/tile-controller";
import type { Mesh } from "../mesh";
import type { CaptureController } from "../platform/types";
import type { SignalingClient } from "../signaling";
import type { UiElements } from "./dom";
import type { HealthPoller } from "./health-view";
import { captureBlockedReason, currentPreset, syncMuteAudioButton } from "./quality-view";
import type { TileView } from "./tile-view";

export interface ShareLifecycleContext {
  ui: UiElements;
  session: SessionController;
  invite: InviteController;
  tileCtrl: TileController;
  tileView: TileView;
  health: HealthPoller;
  captureController: CaptureController;
  getClient: () => SignalingClient | null;
  getMesh: () => Mesh | null;
  closeAllPopovers: () => void;
  setStatus: (text: string, kind?: "info" | "warn" | "error") => void;
  syncViewState: () => void;
  renderRoster: () => void;
  runBackground: (task: Promise<unknown>) => void;
}

export class ShareLifecycle {
  private readonly ctx: ShareLifecycleContext;
  private activeCapture: CaptureResult | null = null;
  private pending = false;
  private stopPromise: Promise<void> | null = null;
  private forceStopGen = 0;
  private activeCaptureWarning: string | null = null;

  constructor(ctx: ShareLifecycleContext) {
    this.ctx = ctx;
  }

  get capture(): CaptureResult | null {
    return this.activeCapture;
  }

  get isPending(): boolean {
    return this.pending;
  }

  toggleMuteAudio(): void {
    if (!this.activeCapture?.audio) return;
    this.activeCapture.audio.enabled = !this.activeCapture.audio.enabled;
    syncMuteAudioButton(this.ctx.ui, this.activeCapture);
  }

  async start(): Promise<void> {
    if (!this.ctx.getMesh() || this.activeCapture || this.pending) return;
    this.pending = true;
    try {
      await this.startInner();
    } finally {
      this.pending = false;
    }
  }

  private isStaleShare(shareGen: number, forceGen: number): boolean {
    return shareGen !== this.ctx.session.joinGeneration || forceGen !== this.forceStopGen || !this.ctx.getMesh();
  }

  private async startInner(): Promise<void> {
    const mesh = this.ctx.getMesh();
    if (!mesh) return;
    const shareGen = this.ctx.session.joinGeneration;
    const forceGen = this.forceStopGen;
    this.ctx.closeAllPopovers();
    this.ctx.invite.setRevealed(false);

    const blocked = captureBlockedReason();
    if (blocked) {
      this.ctx.setStatus(blocked, "error");
      return;
    }
    if (this.ctx.captureController.kind === "web") {
      const audio = windowAudioSupport();
      if (!audio.supported && audio.reason) this.ctx.setStatus(audio.reason, "warn");
    }

    const acquired = await this.acquireCapture(shareGen, forceGen);
    if (!acquired) return;
    await this.attachCapture(acquired, shareGen, forceGen);
  }

  private async acquireCapture(shareGen: number, forceGen: number): Promise<CaptureResult | null> {
    try {
      const result = await this.ctx.captureController.start(QUALITY_PRESETS[currentPreset()]);
      if (this.isStaleShare(shareGen, forceGen)) {
        this.ctx.captureController.stop();
        return null;
      }
      this.activeCapture = result;
      return result;
    } catch (err) {
      console.warn("[main] capture cancelled or failed", err);
      if (this.isStaleShare(shareGen, forceGen)) {
        return null;
      }
      const message = describeCaptureError(err, this.ctx.captureController.kind);
      if (message !== null) {
        this.activeCaptureWarning = message;
        this.ctx.setStatus(message, "warn");
      }
      return null;
    }
  }

  private async attachCapture(cap: CaptureResult, shareGen: number, forceGen: number): Promise<void> {
    const mesh = this.ctx.getMesh();
    if (!mesh || this.isStaleShare(shareGen, forceGen) || this.activeCapture !== cap) {
      await this.stop();
      return;
    }
    this.ctx.tileCtrl.setSelfPreviewHidden(false);
    if (cap.audio) this.watchAudioEnded(cap.audio);
    this.ctx.tileView.renderSelfPreview(cap.stream);
    this.ctx.getClient()?.setSharing(true);

    try {
      await mesh.setCapture(cap);
    } catch (err) {
      console.error("[main] failed to attach capture to peers", err);
      this.ctx.setStatus("Could not start sharing to peers. Screen capture stopped.", "error");
      await this.stop();
      return;
    }
    if (this.isStaleShare(shareGen, forceGen) || this.activeCapture !== cap) {
      if (this.activeCapture === cap) {
        await this.stop();
      } else {
        await this.ctx.getMesh()?.setCapture(null);
        this.clearStoppedUi();
      }
      return;
    }
    if (this.activeCaptureWarning !== null) {
      if (this.ctx.ui.status.textContent === this.activeCaptureWarning) {
        const code = this.ctx.session.lastJoinCode;
        this.ctx.setStatus(code !== null ? this.ctx.session.connectedRoomStatusText(code) : "", "info");
      }
      this.activeCaptureWarning = null;
    }
    syncMuteAudioButton(this.ctx.ui, this.activeCapture);
    this.ctx.syncViewState();
    this.ctx.renderRoster();
  }

  private clearStoppedUi(): void {
    this.ctx.health.clearOutbound();
    this.ctx.tileCtrl.clearOutboundStats();
    this.ctx.tileView.renderSelfPreview(null);
    this.ctx.getClient()?.setSharing(false);
    syncMuteAudioButton(this.ctx.ui, this.activeCapture);
    this.ctx.syncViewState();
    this.ctx.renderRoster();
  }

  private watchAudioEnded(track: MediaStreamTrack): void {
    track.addEventListener("ended", () => {
      if (this.activeCapture?.audio !== track) return;
      this.activeCapture.audio = null;
      const mesh = this.ctx.getMesh();
      if (mesh) this.ctx.runBackground(mesh.setAudioTrack(null));
      syncMuteAudioButton(this.ctx.ui, this.activeCapture);
    });
  }

  forceStop(): void {
    if (!this.activeCapture && !this.pending) return;
    this.forceStopGen++;
    this.stopPromise = null;
    this.ctx.captureController.stop();
    this.activeCapture = null;
    this.activeCaptureWarning = null;
    syncMuteAudioButton(this.ctx.ui, null);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.activeCapture) return Promise.resolve();
    const cap = this.activeCapture;
    const run = (async () => {
      let owned = false;
      try {
        await this.ctx.getMesh()?.setCapture(null);
      } finally {
        if (this.activeCapture === cap) {
          owned = true;
          this.ctx.captureController.stop();
          this.activeCapture = null;
          this.activeCaptureWarning = null;
        }
      }
      if (!owned) return;
      this.clearStoppedUi();
    })().finally(() => {
      if (this.stopPromise === run) this.stopPromise = null;
    });
    this.stopPromise = run;
    return run;
  }
}
