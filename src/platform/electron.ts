/**
 * Desktop capture. The picker lives in the Electron main process (electron/main.js),
 * and getDisplayMedia goes through it, so starting a share works exactly as on the
 * web.
 *
 * The one difference: when the picked window belongs to a game profile, the main
 * process follows the game from its lobby window to its game window and back, and
 * sends updates here. While a follow is active, the captured window closing is a
 * normal step, not the end of the share; the share ends when the main process says
 * the game is gone.
 */

import { captureScreen, stopCapture, type AudioMode, type CaptureResult, type QualityPreset } from "../capture";
import type {
  AudioSourceProvider,
  CaptureCallbacks,
  CaptureController,
  ElectronAPI,
  FollowUpdate,
} from "./types";

/** The parts of window.electronAPI this controller needs. */
export type FollowAPI = Required<Pick<ElectronAPI, "onFollowUpdate" | "stopFollow">>;

export interface ElectronCaptureDeps {
  captureScreen: (preset: QualityPreset, mode: AudioMode) => Promise<CaptureResult>;
  /** Captures one desktop source by id, with no picker and no user gesture. */
  captureSource: (sourceId: string, preset: QualityPreset) => Promise<MediaStreamTrack>;
  makeStream: (tracks: MediaStreamTrack[]) => MediaStream;
  audioSource: AudioSourceProvider;
}

/** Electron's (Chromium's) desktop-source constraints. Not in TypeScript's DOM lib. */
async function captureDesktopSource(sourceId: string, preset: QualityPreset): Promise<MediaStreamTrack> {
  const constraints = {
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
  } as unknown as MediaStreamConstraints;
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(`no video track for source ${sourceId}`);
  }
  // Same reason as captureScreen: games want framerate over per-frame sharpness.
  track.contentHint = "motion";
  return track;
}

const defaultDeps: ElectronCaptureDeps = {
  captureScreen,
  captureSource: captureDesktopSource,
  makeStream: (tracks) => new MediaStream(tracks),
  audioSource: async (capture) => capture.audio,
};

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

  return {
    kind: "electron",
    async start(p, mode) {
      // following, sourceId and pending are already clear: they start that way and
      // stop() (or a failed start) clears them again.
      preset = p;
      // Subscribe first: the main process starts following as soon as the window is
      // picked, which can be before getDisplayMedia resolves here.
      unsubscribe = api.onFollowUpdate(handle);
      let result: CaptureResult;
      try {
        result = await deps.captureScreen(p, mode);
        result.audio = await deps.audioSource(result, mode);
      } catch (err) {
        release();
        throw err;
      }
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
      release();
      api.stopFollow();
      if (following) cb.onFollowState(null);
      following = false;
      sourceId = null;
      if (capture) stopCapture(capture);
      capture = null;
    },
  };
}
