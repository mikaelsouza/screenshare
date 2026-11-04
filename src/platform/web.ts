/** Browser capture: the browser's own picker, and the share ends with its source. */

import { captureScreen, onCaptureEnded, stopCapture, type CaptureResult } from "../capture";
import type { CaptureCallbacks, CaptureController } from "./types";

export function createWebCaptureController(cb: CaptureCallbacks): CaptureController {
  let capture: CaptureResult | null = null;
  let unlisten: (() => void) | null = null;

  return {
    kind: "web",
    async start(preset, mode) {
      const result = await captureScreen(preset, mode);
      capture = result;
      unlisten = onCaptureEnded(result, () => cb.onEnded("source-closed"));
      return result;
    },
    setPreset() {
      // Nothing to do: the browser never re-captures mid-share.
    },
    stop() {
      unlisten?.();
      unlisten = null;
      if (capture) stopCapture(capture);
      capture = null;
    },
  };
}
