/** Browser capture: the browser's own picker, and the share ends with its source. */

import { captureAudioOnly, captureScreen, onCaptureEnded, stopCapture, type CaptureResult } from "../capture";
import type { CaptureCallbacks, CaptureController } from "./types";

const pendingTasks = new Set<Promise<unknown>>();

function runBackground(task: Promise<unknown>): void {
  const tracked = task
    .catch(() => {
      /* ignore unsupported constraint errors */
    })
    .finally(() => {
      pendingTasks.delete(tracked);
    });
  pendingTasks.add(tracked);
}

export function createWebCaptureController(cb: CaptureCallbacks): CaptureController {
  let capture: CaptureResult | null = null;
  let unlisten: (() => void) | null = null;

  return {
    kind: "web",
    hasPerAppAudio: true,
    async start(preset, mode) {
      const result = await captureScreen(preset, mode);
      capture = result;
      unlisten = onCaptureEnded(result, () => cb.onEnded("source-closed"));
      return result;
    },
    captureAudioOnly(kind) {
      return captureAudioOnly(kind);
    },
    setPreset(preset) {
      if (!capture) return;
      runBackground(
        capture.video.applyConstraints({
          width: { ideal: preset.width },
          height: { ideal: preset.height },
          frameRate: { ideal: preset.frameRate, max: preset.frameRate },
        }),
      );
    },
    stop() {
      unlisten?.();
      unlisten = null;
      if (capture) stopCapture(capture);
      capture = null;
    },
  };
}
