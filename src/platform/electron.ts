/**
 * Desktop capture. The picker lives in the Electron main process (electron/main.js),
 * and getDisplayMedia goes through it, so starting a share works as on the web.
 *
 * Audio rules in the desktop app (when the WASAPI audio bridge is present):
 *  - Sharing a window captures only that window's process tree, and follows the
 *    window automatically when a game moves between its lobby and match windows.
 *  - Sharing a whole screen captures system audio excluding this app's own
 *    process tree.
 */

import {
  captureScreen,
  stopCapture,
  type CaptureResult,
  type QualityPreset,
} from "../capture";
import { createPcmAudioTrack, type PcmAudioBridge } from "./pcm-audio";
import type {
  AudioSourceProvider,
  CaptureCallbacks,
  CaptureController,
  CaptureFailureReason,
  ElectronAPI,
  FollowUpdate,
} from "./types";

/** The parts of window.electronAPI this controller uses. */
export type FollowAPI = Required<Pick<ElectronAPI, "onFollowUpdate" | "stopFollow">> &
  Pick<
    ElectronAPI,
    "startWindowAudio" | "startSystemAudio" | "stopAudio" | "onAudioPcm" | "onCaptureError"
  >;

export interface ElectronCaptureDeps {
  captureScreen: (preset: QualityPreset) => Promise<CaptureResult>;
  /** Captures one desktop source by id, with no picker and no user gesture. */
  captureSource: (sourceId: string, preset: QualityPreset) => Promise<MediaStreamTrack>;
  makeStream: (tracks: MediaStreamTrack[]) => MediaStream;
  createPcmTrack: (bridge: PcmAudioBridge) => Promise<MediaStreamTrack> | MediaStreamTrack;
  audioSource?: AudioSourceProvider;
}

/** Electron's (Chromium's) desktop-source constraints. Not in TypeScript's DOM lib. */
async function captureDesktopSource(sourceId: string, preset: QualityPreset): Promise<MediaStreamTrack> {
  const constraints: MediaStreamConstraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        maxWidth: preset.width,
        maxHeight: preset.height,
        maxFrameRate: preset.frameRate,
      },
    },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(`no video track for source ${sourceId}`);
  }
  // Hint "motion" to match captureScreen() so followed windows also use
  // realtime video encoding and maintain-framerate policy.
  track.contentHint = "motion";
  return track;
}

const defaultDeps: ElectronCaptureDeps = {
  captureScreen,
  captureSource: captureDesktopSource,
  makeStream: (tracks) => new MediaStream(tracks),
  createPcmTrack: createPcmAudioTrack,
};

/** Check whether the preload bridge exposes all required WASAPI audio IPC methods. */
function hasAudioBridge(
  api: FollowAPI,
): api is FollowAPI &
  { startWindowAudio: NonNullable<ElectronAPI["startWindowAudio"]>; startSystemAudio: NonNullable<ElectronAPI["startSystemAudio"]>; stopAudio: NonNullable<ElectronAPI["stopAudio"]>; onAudioPcm: NonNullable<ElectronAPI["onAudioPcm"]> } {
  return Boolean(api.startWindowAudio && api.startSystemAudio && api.stopAudio && api.onAudioPcm);
}

interface AudioProviderHooks {
  isCanceled: () => boolean;
  onNativeAudioStarted: () => void;
}

/**
 * Default Electron audio provider: uses per-window WASAPI capture when a window was
 * picked, and system audio (excluding our own app) when a screen was picked. Falls
 * back to whatever came with getDisplayMedia if the main process doesn't have the
 * WASAPI bridge.
 */
function buildDefaultAudioProvider(
  api: FollowAPI,
  deps: ElectronCaptureDeps,
  hooks: AudioProviderHooks,
): AudioSourceProvider {
  return async (capture) => {
    if (!hasAudioBridge(api)) return capture.audio;
    const useWindow = capture.surface === "window";
    const ok = useWindow ? await api.startWindowAudio() : await api.startSystemAudio();
    if (!ok) return capture.audio;
    hooks.onNativeAudioStarted();
    if (hooks.isCanceled()) return null;
    capture.audio?.stop();
    return await deps.createPcmTrack({ onAudioPcm: api.onAudioPcm, stopAudio: api.stopAudio });
  };
}

interface PendingStart {
  readonly gen: number;
  canceled: boolean;
  captureErrorReason: CaptureFailureReason | null;
  result: CaptureResult | null;
  cancel: () => void;
  unsub: () => void;
}

/** Create the Electron desktop capture controller with game-client following and WASAPI audio. */
export function createElectronCaptureController(
  api: FollowAPI,
  cb: CaptureCallbacks,
  deps: ElectronCaptureDeps = defaultDeps,
): CaptureController {
  let capture: CaptureResult | null = null;
  let preset: QualityPreset | null = null;
  /** An update that arrived while the picker result was still on its way. */
  let pending: FollowUpdate | null = null;
  let following = false;
  /** The desktop source the current video comes from, once a follow has named it. */
  let sourceId: string | null = null;
  /** Bumped on stop and on every swap, so a slow capture that lost the race is dropped. */
  let generation = 0;
  let unsubscribe: (() => void) | null = null;
  let pendingStart: PendingStart | null = null;
  /** Generation that currently owns the main-process native WASAPI audio session. */
  let activeNativeAudioGen: number | null = null;

  function stopOwnedNativeAudio(gen: number): void {
    if (activeNativeAudioGen !== gen) return;
    activeNativeAudioGen = null;
    api.stopAudio?.();
  }

  function watchEnded(track: MediaStreamTrack): void {
    track.addEventListener("ended", () => {
      // A track ending after the share stopped means nothing, and while following,
      // the window closing is the game moving on; the follow decides when it is over.
      if (capture?.video !== track || following) return;
      cb.onEnded("source-closed");
    });
  }

  function handle(update: FollowUpdate): void {
    if (!capture) {
      // Only reachable while start() waits for the picker: stop() unsubscribes.
      pending = update;
      return;
    }
    if (update.role === "ended") {
      following = false;
      cb.onFollowState(null);
      cb.onEnded("follow-ended");
      return;
    }
    following = true;
    cb.onFollowState({ role: update.role, profile: update.profile, title: update.title });
    // "waiting" carries no window.
    if (update.sourceId === null) return;
    // The first update names the window the user just picked, which is already
    // being captured, unless it closed in the meantime.
    if (sourceId === null) sourceId = update.sourceId;
    if (update.sourceId === sourceId && capture.video.readyState !== "ended") return;
    void swapTo(update.sourceId);
  }

  async function swapTo(id: string): Promise<void> {
    const gen = ++generation;
    let track: MediaStreamTrack;
    try {
      track = await deps.captureSource(id, preset!);
    } catch (err) {
      console.warn(`[capture] could not capture window ${id}`, err);
      return;
    }
    if (gen !== generation || !capture) {
      track.stop();
      return;
    }
    const old = capture.video;
    // A fresh stream rather than mutating the old one: <video> elements and the far
    // end both handle a new stream reliably, and the audio carries over untouched.
    capture.stream = deps.makeStream(capture.audio ? [track, capture.audio] : [track]);
    capture.video = track;
    sourceId = id;
    old.stop();
    // No ended watcher on the new track: swaps only happen while following, and
    // from then on the follow alone decides when the share is over.
    await cb.onVideoTrackSwapped(track, capture.stream);
  }

  function release(): void {
    unsubscribe?.();
    unsubscribe = null;
    pending = null;
  }

  function beginPendingStart(gen: number): PendingStart {
    pendingStart?.cancel();
    release();
    // Subscribe first: the main process starts following as soon as the window is
    // picked, which can be before getDisplayMedia resolves here.
    const rawUnsub = api.onFollowUpdate(handle);
    let unsubscribed = false;
    let captureErrorUnsub: (() => void) | null = null;
    const unsub = (): void => {
      if (unsubscribed) return;
      unsubscribed = true;
      rawUnsub();
      captureErrorUnsub?.();
      captureErrorUnsub = null;
      if (unsubscribe === unsub) unsubscribe = null;
    };
    unsubscribe = unsub;

    const state: PendingStart = {
      gen,
      canceled: false,
      captureErrorReason: null,
      result: null,
      unsub,
      cancel() {
        if (state.canceled) return;
        state.canceled = true;
        unsub();
        if (state.result) {
          stopCapture(state.result);
          state.result = null;
        }
        stopOwnedNativeAudio(gen);
        if (pendingStart === state) {
          pendingStart = null;
          pending = null;
        }
      },
    };
    captureErrorUnsub = api.onCaptureError?.((reason) => {
      if (!state.canceled && state.gen === generation) {
        state.captureErrorReason = reason;
      }
    }) ?? null;
    pendingStart = state;
    return state;
  }

  function provideAudioForStart(state: PendingStart, result: CaptureResult): Promise<MediaStreamTrack | null> {
    if (deps.audioSource) return deps.audioSource(result);
    const provider = buildDefaultAudioProvider(api, deps, {
      isCanceled: () => state.canceled || state.gen !== generation,
      onNativeAudioStarted: () => {
        if (state.canceled || state.gen !== generation) {
          if (activeNativeAudioGen === null) api.stopAudio?.();
          return;
        }
        activeNativeAudioGen = state.gen;
      },
    });
    return provider(result);
  }

  function assertStartActive(state: PendingStart): void {
    if (state.canceled || state.gen !== generation) {
      throw new Error("Capture stopped before starting");
    }
  }

  function isPendingEnded(): boolean {
    return pending?.role === "ended";
  }

  async function ensureLiveStartupVideo(
    state: PendingStart,
    result: CaptureResult,
    p: QualityPreset,
  ): Promise<boolean> {
    if (isPendingEnded()) {
      throw new Error("Capture ended before starting");
    }
    if (result.video.readyState !== "ended") return false;
    const replacementId = pending?.sourceId ?? null;
    if (replacementId === null) {
      throw new Error("Capture ended before starting");
    }
    const replacement = await deps.captureSource(replacementId, p);
    if (state.canceled || state.gen !== generation) {
      replacement.stop();
      throw new Error("Capture stopped before starting");
    }
    if (isPendingEnded()) {
      replacement.stop();
      throw new Error("Capture ended before starting");
    }
    const oldVideo = result.video;
    result.video = replacement;
    sourceId = replacementId;
    oldVideo.stop();
    return true;
  }

  return {
    kind: "electron",
    async start(p) {
      // following, sourceId and pending are already clear: they start that way and
      // stop() (or a failed start) clears them again.
      const gen = ++generation;
      preset = p;
      const state = beginPendingStart(gen);
      let result: CaptureResult | null = null;
      let chosenAudio: MediaStreamTrack | null = null;
      try {
        try {
          result = await deps.captureScreen(p);
        } catch (captureErr) {
          if (state.captureErrorReason === "restore-failed") {
            throw new DOMException("Could not restore minimized window", "NotReadableError");
          }
          if (state.captureErrorReason === "sources-failed") {
            throw new Error("Could not list windows or screens to share.");
          }
          throw captureErr;
        }
        state.result = result;
        assertStartActive(state);
        chosenAudio = await provideAudioForStart(state, result);
        assertStartActive(state);
        const videoReplaced = await ensureLiveStartupVideo(state, result, p);
        if (videoReplaced || chosenAudio !== result.audio) {
          const nextStream = deps.makeStream(chosenAudio ? [result.video, chosenAudio] : [result.video]);
          result.audio = chosenAudio;
          result.stream = nextStream;
        }
      } catch (err) {
        if (chosenAudio && chosenAudio !== result?.audio) chosenAudio.stop();
        if (result) stopCapture(result);
        state.result = null;
        stopOwnedNativeAudio(gen);
        state.unsub();
        if (state.gen === generation) api.stopFollow();
        if (pendingStart === state) {
          pendingStart = null;
          pending = null;
        }
        throw err;
      }
      pendingStart = null;
      capture = result;
      watchEnded(result.video);
      const early = pending;
      pending = null;
      if (early) handle(early);
      return result;
    },
    setPreset(p) {
      preset = p;
    },
    stop() {
      generation++;
      pendingStart?.cancel();
      release();
      api.stopFollow();
      if (following) cb.onFollowState(null);
      following = false;
      sourceId = null;
      activeNativeAudioGen = null;
      if (capture) stopCapture(capture);
      capture = null;
    },
  };
}
