import type { PeerId } from "@shared/protocol";
import { SELF_TILE, type TileController } from "../controllers/tile-controller";
import { computeVolumeState } from "../ui-model";
import type { UiElements } from "./dom";
import { createIcon, setButtonIcon } from "./icons";

interface BoostAudioPipe {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  compressor?: DynamicsCompressorNode;
}

interface TileControlElements {
  wrap: HTMLElement;
  pauseBtn: HTMLButtonElement;
  muteBtn: HTMLButtonElement;
  volume: HTMLInputElement;
  fitBtn: HTMLButtonElement;
  focusBtn: HTMLButtonElement;
  statsBtn: HTMLButtonElement;
  fullscreenBtn: HTMLButtonElement;
  pipBtn?: HTMLButtonElement | undefined;
}

export interface TileViewCallbacks {
  onViewingChange: (peerId: PeerId, want: boolean) => void;
  onSyncViewState: () => void;
  runBackground: (task: Promise<unknown>) => void;
}

export class TileView {
  private readonly ui: UiElements;
  private readonly ctrl: TileController;
  private readonly cb: TileViewCallbacks;
  private readonly videos = new Map<PeerId, HTMLVideoElement>();
  private readonly healthEls = new Map<PeerId, HTMLElement>();
  private readonly observers = new Map<PeerId, IntersectionObserver>();
  private readonly unmutePrompts = new Map<PeerId, HTMLElement>();
  private readonly controls = new Map<PeerId, TileControlElements>();
  private readonly boostPipes = new Map<PeerId, BoostAudioPipe>();
  private sharedAudioCtx: AudioContext | null = null;

  constructor(ui: UiElements, ctrl: TileController, cb: TileViewCallbacks) {
    this.ui = ui;
    this.ctrl = ctrl;
    this.cb = cb;
  }

  getVideo(peerId: PeerId): HTMLVideoElement | undefined {
    return this.videos.get(peerId);
  }

  getHealthEl(peerId: PeerId): HTMLElement | undefined {
    return this.healthEls.get(peerId);
  }

  videoPeerIds(): PeerId[] {
    return [...this.videos.keys()];
  }

  setFocusButtonsVisible(visible: boolean): void {
    for (const c of this.controls.values()) {
      c.focusBtn.hidden = !visible;
    }
  }

  updateTileLabel(peerId: PeerId, name: string): void {
    const video = this.videos.get(peerId);
    const label = video?.closest(".tile")?.querySelector(".tile-label");
    if (label) label.textContent = this.ctrl.formatTileLabel(peerId, name);
  }

  setFocusedTile(peerId: PeerId | null): void {
    const focused = this.ctrl.toggleFocus(peerId);
    for (const [id, tileVideo] of this.videos.entries()) {
      const wrap = tileVideo.closest(".tile");
      if (!wrap) continue;
      wrap.classList.toggle("tile-focused", focused === id);
      this.renderTileControls(id);
    }
    this.ui.stage.classList.toggle("has-focused", focused !== null);
  }

  tileFor(peerId: PeerId): HTMLVideoElement {
    const existing = this.videos.get(peerId);
    if (existing) return existing;

    const wrap = document.createElement("div");
    wrap.className = "tile";
    wrap.dataset["peer"] = peerId;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = peerId === SELF_TILE;

    const label = document.createElement("span");
    label.className = "tile-label";
    label.textContent = this.ctrl.formatTileLabel(peerId);

    const health = document.createElement("span");
    health.className = "tile-health";
    health.hidden = !this.ctrl.isStatsOpen(peerId);
    this.healthEls.set(peerId, health);

    wrap.append(video, label, health);
    this.wireTileInteractions(peerId, wrap, video);

    this.videos.set(peerId, video);
    const hidden = peerId === SELF_TILE && this.ctrl.selfPreviewHidden;
    this.ctrl.registerTile(peerId, hidden);
    if (peerId === SELF_TILE) {
      this.buildSelfTileControls(wrap);
      wrap.hidden = hidden;
    } else {
      this.buildTileControls(peerId, wrap);
    }

    this.ui.stage.append(wrap);
    this.applyAudio(peerId);
    this.cb.onSyncViewState();
    if (peerId !== SELF_TILE) this.observeTileVisibility(peerId, wrap);
    return video;
  }

  private wireTileInteractions(peerId: PeerId, wrap: HTMLElement, video: HTMLVideoElement): void {
    const updateAspect = (): void => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        wrap.style.setProperty("--tile-aspect", `${video.videoWidth} / ${video.videoHeight}`);
      }
    };
    video.addEventListener("loadedmetadata", updateAspect);
    video.addEventListener("resize", updateAspect);
    wrap.addEventListener("dblclick", (ev) => {
      if (ev.target instanceof Element && ev.target.closest("button, input")) return;
      if (this.ctrl.visibleTileCount() >= 2) this.setFocusedTile(peerId);
    });
    wrap.addEventListener("click", (ev) => {
      if (this.ctrl.focusedPeerId !== null && this.ctrl.focusedPeerId !== peerId) {
        if (ev.target instanceof Element && ev.target.closest("button, input")) return;
        this.setFocusedTile(peerId);
      }
    });
  }

  private observeTileVisibility(peerId: PeerId, wrap: HTMLElement): void {
    const io = new IntersectionObserver(
      (entries) => {
        if (this.observers.get(peerId) !== io) return;
        for (const e of entries) this.ctrl.setOnScreen(peerId, e.isIntersecting);
        this.applyViewing(peerId);
      },
      { threshold: 0.1 },
    );
    io.observe(wrap);
    this.observers.set(peerId, io);
  }

  private buildSelfTileControls(wrap: HTMLElement): void {
    const bar = document.createElement("div");
    bar.className = "tile-controls";
    const hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.className = "tile-hide-self";
    hideBtn.textContent = "Hide preview";
    hideBtn.title = "Hide your local preview tile";
    hideBtn.addEventListener("click", () => {
      const { clearedFocus } = this.ctrl.setSelfPreviewHidden(true);
      wrap.hidden = true;
      if (clearedFocus) this.setFocusedTile(null);
      this.cb.onSyncViewState();
    });
    bar.append(hideBtn);
    wrap.append(bar);
  }

  applyViewing(peerId: PeerId): void {
    const isPip = document.pictureInPictureElement === this.videos.get(peerId);
    const want = this.ctrl.shouldRequestVideo(peerId, isPip);
    if (want !== null) this.cb.onViewingChange(peerId, want);
  }

  private getSharedAudioContext(): AudioContext | null {
    const AudioContextClass = window.AudioContext;
    if (!AudioContextClass) return null;
    if (!this.sharedAudioCtx || this.sharedAudioCtx.state === "closed") {
      try {
        this.sharedAudioCtx = new AudioContextClass({ latencyHint: "interactive" });
      } catch {
        this.sharedAudioCtx = new AudioContextClass();
      }
    }
    if (this.sharedAudioCtx.state === "suspended") {
      void this.sharedAudioCtx.resume().catch(() => {});
    }
    return this.sharedAudioCtx;
  }

  private setupBoostPipe(peerId: PeerId, stream: MediaStream): BoostAudioPipe | null {
    const existing = this.boostPipes.get(peerId);
    if (existing) {
      if (existing.stream === stream) return existing;
      this.teardownBoostPipe(peerId);
    }
    if (stream.getAudioTracks().length === 0) return null;
    try {
      const ctx = this.getSharedAudioContext();
      if (!ctx) return null;
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -6;
      compressor.knee.value = 6;
      compressor.ratio.value = 12;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.1;
      source.connect(gain);
      gain.connect(compressor);
      compressor.connect(ctx.destination);
      const pipe: BoostAudioPipe = { stream, source, gain, compressor };
      this.boostPipes.set(peerId, pipe);
      return pipe;
    } catch (err) {
      console.warn(`[main] Web Audio boost setup failed for ${peerId}`, err);
      return null;
    }
  }

  teardownBoostPipe(peerId: PeerId): void {
    const pipe = this.boostPipes.get(peerId);
    if (!pipe) return;
    try {
      pipe.gain.disconnect();
      pipe.source.disconnect();
      pipe.compressor?.disconnect();
    } catch {}
    this.boostPipes.delete(peerId);
  }

  applyAudio(peerId: PeerId): void {
    if (peerId === SELF_TILE) return;
    const video = this.videos.get(peerId);
    if (!video) return;
    const s = this.ctrl.listeningFor(peerId);
    const isSilent = s.muted || this.ctrl.isPaused(peerId) || this.unmutePrompts.has(peerId);
    const stream = video.srcObject instanceof MediaStream ? video.srcObject : null;
    video.volume = Math.max(0, Math.min(1, s.volume));

    if (s.volume > 1 && !isSilent && stream && stream.getAudioTracks().length > 0) {
      const pipe = this.setupBoostPipe(peerId, stream);
      if (pipe) {
        video.muted = true;
        pipe.gain.gain.value = s.volume;
        const ctx = this.getSharedAudioContext();
        if (ctx?.state === "suspended") void ctx.resume().catch(() => {});
        return;
      }
    }
    video.muted = isSilent;
    const pipe = this.boostPipes.get(peerId);
    if (pipe) pipe.gain.gain.value = 0;
  }

  private buildPipButton(peerId: PeerId): HTMLButtonElement | undefined {
    if (!("pictureInPictureEnabled" in document) || !document.pictureInPictureEnabled) {
      return undefined;
    }
    const pipBtn = document.createElement("button");
    pipBtn.type = "button";
    pipBtn.className = "tile-pip";
    pipBtn.addEventListener("click", () => {
      const v = this.videos.get(peerId);
      if (!v) return;
      if (document.pictureInPictureElement === v) {
        void document.exitPictureInPicture().catch(() => {});
      } else if (typeof v.requestPictureInPicture === "function") {
        void v.requestPictureInPicture().catch((err: unknown) => {
          console.warn(`[main] PiP request failed for ${peerId}`, err);
        });
      }
    });
    const video = this.videos.get(peerId);
    if (video) {
      const sync = (): void => {
        this.applyViewing(peerId);
        this.renderTileControls(peerId);
      };
      video.addEventListener("enterpictureinpicture", sync);
      video.addEventListener("leavepictureinpicture", sync);
    }
    return pipBtn;
  }

  private buildTileControls(peerId: PeerId, wrap: HTMLElement): void {
    const bar = document.createElement("div");
    bar.className = "tile-controls";

    const pauseBtn = this.makeBtn("tile-pause", () => this.setPaused(peerId, !this.ctrl.isPaused(peerId)));
    const muteBtn = this.makeBtn("tile-mute", () => {
      this.ctrl.toggleMute(peerId);
      this.dismissUnmutePrompt(peerId, false);
      this.applyAudio(peerId);
      this.renderTileControls(peerId);
    });

    const volume = document.createElement("input");
    volume.type = "range";
    volume.className = "tile-volume";
    volume.min = "0";
    volume.max = "200";
    volume.step = "1";
    volume.addEventListener("input", () => {
      this.ctrl.setVolumeFromSlider(peerId, Number(volume.value));
      this.dismissUnmutePrompt(peerId, false);
      this.applyAudio(peerId);
      this.renderTileControls(peerId);
    });

    const fitBtn = this.makeBtn("tile-fit", () => {
      wrap.dataset["fit"] = wrap.dataset["fit"] === "cover" ? "contain" : "cover";
      this.renderTileControls(peerId);
    });
    const focusBtn = this.makeBtn("tile-focus", () => this.setFocusedTile(peerId));
    const statsBtn = this.makeBtn("tile-stats", () => {
      const open = this.ctrl.toggleStats(peerId);
      const hEl = this.healthEls.get(peerId);
      if (hEl) hEl.hidden = !open;
      this.renderTileControls(peerId);
    });
    const fullscreenBtn = this.makeBtn("tile-fullscreen", () => {
      if (document.fullscreenElement === wrap) void document.exitFullscreen().catch(() => {});
      else if (typeof wrap.requestFullscreen === "function") void wrap.requestFullscreen().catch(() => {});
    });
    const pipBtn = this.buildPipButton(peerId);

    bar.append(pauseBtn, muteBtn, volume, fitBtn, focusBtn, ...(pipBtn ? [pipBtn] : []), statsBtn, fullscreenBtn);
    const resume = this.makeBtn("tile-paused", () => this.setPaused(peerId, false));
    resume.textContent = "Paused · Click to resume";
    wrap.append(resume, bar);

    this.controls.set(peerId, { wrap, pauseBtn, muteBtn, volume, fitBtn, focusBtn, statsBtn, fullscreenBtn, pipBtn });
    this.renderTileControls(peerId);
  }

  private makeBtn(className: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.addEventListener("click", onClick);
    return btn;
  }

  renderAllControls(): void {
    for (const id of this.controls.keys()) this.renderTileControls(id);
  }

  renderTileControls(peerId: PeerId): void {
    const c = this.controls.get(peerId);
    if (!c) return;
    const audioState = this.ctrl.listeningFor(peerId);
    const isPaused = this.ctrl.isPaused(peerId);
    const name = this.ctrl.getName(peerId, "this stream");
    c.wrap.dataset["paused"] = String(isPaused);
    this.renderAudioControls(c, audioState, isPaused, name);
    this.renderViewControls(c, peerId, name);
  }

  private renderAudioControls(
    c: TileControlElements,
    audioState: { volume: number; muted: boolean },
    isPaused: boolean,
    name: string,
  ): void {
    setButtonIcon(c.pauseBtn, isPaused ? "play" : "pause");
    c.pauseBtn.title = isPaused ? `Resume ${name}` : `Pause ${name}. Stops their video being sent to you.`;
    c.pauseBtn.setAttribute("aria-label", isPaused ? `Resume ${name}` : `Pause ${name}`);

    const silent = audioState.muted || isPaused;
    setButtonIcon(c.muteBtn, silent ? "volumeOff" : "volumeOn");
    c.muteBtn.title = isPaused ? `${name} is paused` : audioState.muted ? `Unmute ${name}` : `Mute ${name}`;
    c.muteBtn.setAttribute("aria-label", c.muteBtn.title);
    c.muteBtn.disabled = isPaused;

    const sliderVal = audioState.muted ? 0 : Math.round(audioState.volume * 100);
    const volState = computeVolumeState(sliderVal, audioState.volume);
    c.volume.value = String(sliderVal);
    const isBoosted = !isPaused && volState.boosted;
    c.volume.dataset["boosted"] = String(isBoosted);
    c.volume.title = `${name} ${volState.label.toLowerCase()}${isBoosted ? " (boosted)" : ""}`;
    c.volume.setAttribute("aria-label", `${name} volume`);
    c.volume.disabled = isPaused;
  }

  private renderViewControls(c: TileControlElements, peerId: PeerId, name: string): void {
    const isCover = c.wrap.dataset["fit"] === "cover";
    setButtonIcon(c.fitBtn, isCover ? "fitContain" : "fitCover");
    c.fitBtn.title = isCover ? `Fit ${name} to window (show whole screen)` : `Fill window with ${name} (crop black bars)`;
    c.fitBtn.setAttribute("aria-label", c.fitBtn.title);
    c.fitBtn.setAttribute("aria-pressed", String(isCover));

    const isFocused = this.ctrl.focusedPeerId === peerId;
    setButtonIcon(c.focusBtn, isFocused ? "unfocus" : "focus");
    c.focusBtn.title = isFocused ? `Unfocus ${name}` : `Focus ${name} (double-click also focuses)`;
    c.focusBtn.setAttribute("aria-label", c.focusBtn.title);
    c.focusBtn.setAttribute("aria-pressed", String(isFocused));
    c.focusBtn.hidden = this.ctrl.visibleTileCount() < 2;

    if (c.pipBtn) {
      const isPip = document.pictureInPictureElement === this.videos.get(peerId);
      setButtonIcon(c.pipBtn, "pip");
      c.pipBtn.title = isPip ? `Exit Picture-in-Picture for ${name}` : `Picture-in-Picture for ${name}`;
      c.pipBtn.setAttribute("aria-label", c.pipBtn.title);
      c.pipBtn.setAttribute("aria-pressed", String(isPip));
    }

    const isStats = this.ctrl.isStatsOpen(peerId);
    setButtonIcon(c.statsBtn, "stats");
    c.statsBtn.title = isStats ? `Hide stream stats for ${name}` : `Show stream stats for ${name}`;
    c.statsBtn.setAttribute("aria-label", c.statsBtn.title);
    c.statsBtn.setAttribute("aria-pressed", String(isStats));

    const isFs = document.fullscreenElement === c.wrap;
    setButtonIcon(c.fullscreenBtn, isFs ? "exitFullscreen" : "fullscreen");
    c.fullscreenBtn.title = isFs ? `Exit full screen for ${name}` : `Full screen ${name}`;
    c.fullscreenBtn.setAttribute("aria-label", c.fullscreenBtn.title);
    c.fullscreenBtn.setAttribute("aria-pressed", String(isFs));
  }

  setPaused(peerId: PeerId, value: boolean): void {
    this.ctrl.setPaused(peerId, value);
    const video = this.videos.get(peerId);
    const target = this.healthEls.get(peerId);
    if (value && target) target.textContent = "paused";
    this.dismissUnmutePrompt(peerId);
    this.applyAudio(peerId);
    if (video) {
      if (value) video.pause();
      else this.startPlayback(video, peerId);
    }
    this.applyViewing(peerId);
    this.renderTileControls(peerId);
  }

  startPlayback(video: HTMLVideoElement, peerId: PeerId): void {
    if (this.ctrl.isPaused(peerId)) {
      video.pause();
      return;
    }
    this.cb.runBackground(
      video.play().catch(() => {
        if (this.videos.get(peerId) !== video || this.ctrl.isPaused(peerId)) return;
        video.muted = true;
        return video.play().then(
          () => {
            if (this.videos.get(peerId) === video && !this.ctrl.isPaused(peerId)) {
              this.showUnmutePrompt(video, peerId, false);
            }
          },
          () => {
            if (this.videos.get(peerId) === video && !this.ctrl.isPaused(peerId)) {
              this.showUnmutePrompt(video, peerId, true);
            }
          },
        );
      }),
    );
  }

  private showUnmutePrompt(video: HTMLVideoElement, peerId: PeerId, playbackBlocked: boolean): void {
    const wrap = video.closest(".tile");
    if (!wrap || wrap.querySelector(".tile-unmute")) return;
    if (!playbackBlocked && this.ctrl.listeningFor(peerId).muted) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tile-unmute";
    btn.dataset["blocked"] = String(playbackBlocked);
    const pill = document.createElement("span");
    pill.className = "tile-unmute-pill";
    pill.append(createIcon(playbackBlocked ? "play" : "volumeOff"));
    const txt = document.createElement("span");
    txt.textContent = playbackBlocked ? "Click to play" : "Click to unmute";
    pill.append(txt);
    btn.append(pill);
    btn.addEventListener("click", () => {
      this.dismissUnmutePrompt(peerId);
      if (!playbackBlocked) this.ctrl.setMuted(peerId, false);
      this.applyAudio(peerId);
      this.renderTileControls(peerId);
      this.startPlayback(video, peerId);
    });
    wrap.append(btn);
    this.unmutePrompts.set(peerId, btn);
  }

  dismissUnmutePrompt(peerId: PeerId, includeBlocked = true): void {
    const btn = this.unmutePrompts.get(peerId);
    if (!btn) return;
    if (!includeBlocked && btn.dataset["blocked"] === "true") return;
    btn.remove();
    this.unmutePrompts.delete(peerId);
  }

  removeTile(peerId: PeerId): void {
    const video = this.videos.get(peerId);
    if (!video) return;
    this.observers.get(peerId)?.disconnect();
    this.observers.delete(peerId);
    this.dismissUnmutePrompt(peerId);
    if (document.pictureInPictureElement === video) {
      this.cb.runBackground(document.exitPictureInPicture());
    }
    this.teardownBoostPipe(peerId);
    video.srcObject = null;
    video.closest(".tile")?.remove();
    this.videos.delete(peerId);
    this.healthEls.delete(peerId);
    this.controls.delete(peerId);
    const { clearedFocus } = this.ctrl.unregisterTile(peerId);
    if (clearedFocus) this.setFocusedTile(null);
    this.cb.onSyncViewState();
  }

  renderSelfPreview(stream: MediaStream | null): void {
    if (!stream) {
      this.ctrl.setSelfPreviewHidden(false);
      this.removeTile(SELF_TILE);
      return;
    }
    this.ctrl.setName(SELF_TILE, "You");
    const videoEl = this.tileFor(SELF_TILE);
    videoEl.muted = true;
    videoEl.srcObject = stream;
    const wrap = videoEl.closest<HTMLElement>(".tile");
    if (wrap) wrap.hidden = this.ctrl.selfPreviewHidden;
    this.cb.runBackground(videoEl.play());
    this.cb.onSyncViewState();
  }

  showSelfPreview(): void {
    this.ctrl.setSelfPreviewHidden(false);
    const wrap = this.videos.get(SELF_TILE)?.closest<HTMLElement>(".tile");
    if (wrap) wrap.hidden = false;
    this.cb.onSyncViewState();
  }

  clearAll(): void {
    for (const id of [...this.videos.keys()]) this.removeTile(id);
    for (const id of [...this.boostPipes.keys()]) this.teardownBoostPipe(id);
  }
}
