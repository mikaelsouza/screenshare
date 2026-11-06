/** Browser capture: the browser's own picker, and the share ends with its source. */

import { captureScreen, onCaptureEnded, stopCapture, type CaptureResult } from "../capture";
import type { CaptureCallbacks, CaptureController } from "./types";

export function createWebCaptureController(cb: CaptureCallbacks): CaptureController {
  let capture: CaptureResult | null = null;
  let unlisten: (() => void) | null = null;

  return {
    kind: "web",
    async start(preset) {
      const result = await captureScreen(preset);
      capture = result;
      unlisten = onCaptureEnded(result, () => cb.onEnded("source-closed"));
      return result;
    },
    setPreset(preset) {
      if (!capture) return;
      capture.video
        .applyConstraints({
          width: { ideal: preset.width },
          height: { ideal: preset.height },
          frameRate: { ideal: preset.frameRate, max: preset.frameRate },
        })
        .catch((err: unknown) => {
          console.warn("[web] applyConstraints failed", err);
        });
    },
    stop() {
      unlisten?.();
      unlisten = null;
      if (capture) stopCapture(capture);
      capture = null;
    },
  };
}
