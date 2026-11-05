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
 */
export function parseWindowHandle(sourceId: string): number | null {
  const match = WINDOW_SOURCE_RE.exec(sourceId.trim());
  if (!match) return null;
  return Number(match[1]);
}

/**
 * Build a sourceId → PID resolver from a low-level HWND → PID function.
 * `lookupPid` returns 0 when the window no longer exists.
 */
export function createPidResolver(lookupPid: (hwnd: number) => number): (sourceId: string) => number | null {
  return (sourceId: string): number | null => {
    const hwnd = parseWindowHandle(sourceId);
    if (hwnd === null) return null;
    const pid = lookupPid(hwnd);
    return pid > 0 ? pid : null;
  };
}
