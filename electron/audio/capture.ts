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

interface LoopbackDevice {
  start: (pid: number, onData: (chunk: Uint8Array) => void) => void;
  startSystemAudio: (onData: (chunk: Uint8Array) => void, excludePid?: number) => void;
  stop: () => void;
}

interface AudioSessionDeps {
  createCapture: () => LoopbackDevice;
  resolvePid: (sourceId: string) => number | null;
  selfPid: number;
  sendPcm: (chunk: Uint8Array) => void;
}

type AudioSessionMode = "off" | "window" | "system";

interface AudioSessionController {
  startForWindow: (sourceId: string, options?: { follow?: boolean }) => boolean;
  startForSystem: () => boolean;
  switchWindow: (sourceId: string) => boolean;
  stop: () => void;
  currentMode: () => AudioSessionMode;
}

/**
 * Create a controller for WASAPI / PipeWire per-window and system audio loopback.
 */
export function createAudioSessionController(deps: AudioSessionDeps): AudioSessionController {
  let device: LoopbackDevice | null = null;
  let mode: AudioSessionMode = "off";
  let activePid: number | null = null;
  let followWindowAudio = false;

  /** Stop the currently active WASAPI loopback device, if any. */
  function stopDevice(): void {
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
   */
  function startForWindow(sourceId: string, { follow = true }: { follow?: boolean } = {}): boolean {
    const pid = deps.resolvePid(sourceId);
    if (pid === null) return false;
    followWindowAudio = follow;
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
   */
  function startForSystem(): boolean {
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
     */
    switchWindow(sourceId: string): boolean {
      if (!followWindowAudio) return false;
      return startForWindow(sourceId);
    },

    /** Stop any active audio capture session and reset to "off". */
    stop(): void {
      stopDevice();
      followWindowAudio = false;
      mode = "off";
      activePid = null;
    },

    currentMode(): AudioSessionMode {
      return mode;
    },
  };
}
