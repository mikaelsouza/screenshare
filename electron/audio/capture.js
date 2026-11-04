// @ts-check
/**
 * Manages the desktop app's WASAPI / PipeWire audio capture session.
 *
 * Three rules:
 *  1. Sharing a window captures only that window's process tree.
 *  2. Sharing a followed game switches the captured process automatically whenever
 *     the followed window switches between lobby and match.
 *  3. Sharing a whole screen (or choosing "All system audio") captures system audio
 *     excluding this app's own process tree, so viewers never hear themselves echo.
 */

/**
 * @typedef {object} LoopbackDevice
 * @property {(pid: number, onData: (chunk: Uint8Array) => void) => void} start
 * @property {(onData: (chunk: Uint8Array) => void, excludePid?: number) => void} startSystemAudio
 * @property {() => void} stop
 */

/**
 * @typedef {object} AudioSessionDeps
 * @property {() => LoopbackDevice} createCapture
 * @property {(sourceId: string) => number | null} resolvePid
 * @property {number} selfPid
 * @property {(chunk: Uint8Array) => void} sendPcm
 */

/**
 * @param {AudioSessionDeps} deps
 */
export function createAudioSessionController(deps) {
  /** @type {LoopbackDevice | null} */
  let device = null;
  /** @type {"off" | "window" | "system"} */
  let mode = "off";
  /** @type {number | null} */
  let activePid = null;
  let followWindowAudio = false;

  /** Stop the currently active WASAPI loopback device, if any. */
  function stopDevice() {
    try {
      // Stryker disable next-line OptionalChaining: catch block swallows null TypeError when device is null
      device?.stop();
    } catch {
      // Ignore teardown errors if the process already exited.
    }
    device = null;
  }

  /**
   * Capture only the process tree that owns `sourceId`.
   * @param {string} sourceId
   * @returns {boolean}
   */
  function startForWindow(sourceId) {
    const pid = deps.resolvePid(sourceId);
    if (pid === null) return false;
    followWindowAudio = true;
    if (activePid === pid) return true;
    stopDevice();
    try {
      const next = deps.createCapture();
      next.start(pid, deps.sendPcm);
      device = next;
      mode = "window";
      activePid = pid;
      return true;
    } catch {
      mode = "off";
      activePid = null;
      return false;
    }
  }

  /**
   * Capture all system audio except our own process tree.
   * @returns {boolean}
   */
  function startForSystem() {
    if (mode === "system") return true;
    followWindowAudio = false;
    stopDevice();
    try {
      const next = deps.createCapture();
      next.startSystemAudio(deps.sendPcm, deps.selfPid);
      device = next;
      mode = "system";
      activePid = null;
      return true;
    } catch {
      mode = "off";
      activePid = null;
      return false;
    }
  }

  return {
    startForWindow,
    startForSystem,

    /**
     * Follow a game's audio when its window changes (lobby ↔ match). No-op when not
     * in per-window audio mode.
     * @param {string} sourceId
     * @returns {boolean}
     */
    switchWindow(sourceId) {
      if (!followWindowAudio) return false;
      return startForWindow(sourceId);
    },

    /** Stop any active audio capture session and reset to "off". */
    stop() {
      stopDevice();
      followWindowAudio = false;
      mode = "off";
      activePid = null;
    },

    /** @returns {"off" | "window" | "system"} */
    currentMode() {
      return mode;
    },
  };
}
