/** Picks the capture implementation for where the page is running. */

import { createElectronCaptureController } from "./electron";
import type { CaptureCallbacks, CaptureController } from "./types";
import { createWebCaptureController } from "./web";

export function createCaptureController(
  cb: CaptureCallbacks,
  api = typeof window === "undefined" ? undefined : window.electronAPI,
): CaptureController {
  // Feature-detect rather than trust isElectron: an older desktop app has the flag
  // but not the follow bridge, and must keep today's behaviour.
  const onFollowUpdate = api?.onFollowUpdate;
  const stopFollow = api?.stopFollow;
  if (api?.isElectron && onFollowUpdate && stopFollow) {
    return createElectronCaptureController(
      {
        onFollowUpdate,
        stopFollow,
        startWindowAudio: api.startWindowAudio,
        pickWindowAudio: api.pickWindowAudio,
        startSystemAudio: api.startSystemAudio,
        stopAudio: api.stopAudio,
        onAudioPcm: api.onAudioPcm,
      },
      cb,
    );
  }
  return createWebCaptureController(cb);
}
