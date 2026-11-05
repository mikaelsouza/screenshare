/** Picks the capture implementation for where the page is running. */

import { createElectronCaptureController, type FollowAPI } from "./electron";
import type { CaptureCallbacks, CaptureController, ElectronAPI } from "./types";
import { createWebCaptureController } from "./web";

function hasFollowBridge(api: ElectronAPI | undefined): api is ElectronAPI & FollowAPI {
  return Boolean(api?.isElectron && api.onFollowUpdate && api.stopFollow);
}

export function createCaptureController(
  cb: CaptureCallbacks,
  api: ElectronAPI | undefined = typeof window === "undefined" ? undefined : window.electronAPI,
): CaptureController {
  // Feature-detect rather than trust isElectron: an older desktop app has the flag
  // but not the follow bridge, and must keep today's behaviour.
  if (hasFollowBridge(api)) {
    return createElectronCaptureController(api, cb);
  }
  return createWebCaptureController(cb);
}
