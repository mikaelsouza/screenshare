/** Browser capture: the browser's own picker, and the share ends with its source. */

import { captureAudioOnly, captureScreen, onCaptureEnded, stopCapture, type CaptureResult } from "../capture";
import type { CaptureCallbacks, CaptureController } from "./types";

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
      void capture.video
        .applyConstraints({
          width: { ideal: preset.width },
          height: { ideal: preset.height },
          frameRate: { ideal: preset.frameRate, max: preset.frameRate },
        })
        .catch(() => {});
    },
    stop() {
      unlisten?.();
      unlisten = null;
      if (capture) stopCapture(capture);
      capture = null;
    },
  };
}
