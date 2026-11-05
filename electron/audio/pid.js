// @ts-check
/**
 * Turns an Electron desktopCapturer window source id ("window:<HWND>:0") into the
 * process id that owns that window.
 *
 * Pure parsing + an injected Win32 lookup so this file has no native dependency of
 * its own and is unit- and mutation-testable on any platform.
 */

const WINDOW_SOURCE_RE = /^window:([1-9]\d*):\d+$/;

/**
 * Extract the Win32 HWND from a desktopCapturer source id, or null if it is not a
 * window source (e.g. "screen:0:0").
 * @param {string} sourceId
 * @returns {number | null}
 */
export function parseWindowHandle(sourceId) {
  const match = WINDOW_SOURCE_RE.exec(sourceId.trim());
  if (!match) return null;
  return Number(match[1]);
}

/**
 * Build a sourceId → PID resolver from a low-level HWND → PID function.
 * @param {(hwnd: number) => number} lookupPid Returns 0 when the window no longer exists.
 * @returns {(sourceId: string) => number | null}
 */
export function createPidResolver(lookupPid) {
  return (sourceId) => {
    const hwnd = parseWindowHandle(sourceId);
    if (hwnd === null) return null;
    const pid = lookupPid(hwnd);
    return pid > 0 ? pid : null;
  };
}
