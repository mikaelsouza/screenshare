/**
 * Win32 window enumeration supplement for Electron's desktopCapturer.
 *
 * Chromium/WebRTC's GetWindowListHandler omits minimized windows (IsIconic),
 * momentarily busy/loading windows (>50ms SendMessageTimeout), large owned
 * secondary windows without WS_EX_APPWINDOW, untitled frameless windows, and
 * elevated (UIPI) windows. This module recovers or labels them via koffi.
 */

import { parseWindowHandle } from "./audio/pid.js";
import type { PickerSource, PickerWindowState } from "./picker.js";

const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_APPWINDOW = 0x40000;
const WS_EX_NOACTIVATE = 0x08000000;
const GWL_EXSTYLE = -20;
const GW_OWNER = 4;
const DWMWA_CLOAKED = 14;
const DWM_CLOAKED_SHELL = 2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SMTO_ABORTIFHUNG = 0x0002;
const WM_NULL = 0x0000;
const SW_RESTORE = 9;
const PROBE_TIMEOUT_MS = 25;
const ERROR_ACCESS_DENIED = 5;

const MIN_UNOWNED_WIDTH = 60;
const MIN_UNOWNED_HEIGHT = 40;
const MIN_OWNED_WIDTH = 200;
const MIN_OWNED_HEIGHT = 150;
const DIALOG_CLASS = "#32770";
const UWP_FRAME_CLASS = "ApplicationFrameWindow";

const IGNORED_CLASSES: ReadonlySet<string> = new Set([
  "Progman",
  "WorkerW",
  "Shell_TrayWnd",
  "Shell_SecondaryTrayWnd",
  "Windows.UI.Core.CoreWindow",
  "Button",
]);

export interface RawWin32Window {
  readonly hwnd: number;
  readonly className: string;
  readonly title: string;
  readonly exeName: string | null;
  readonly isVisible: boolean;
  readonly isIconic: boolean;
  readonly cloaked: number;
  readonly exStyle: number;
  readonly ownerHwnd: number;
  readonly width: number;
  readonly height: number;
}

export interface ResponsivenessProbe {
  readonly responsive: boolean;
  readonly errorCode: number;
}

export interface SupplementalWindow extends PickerSource {
  readonly id: string;
  readonly hwnd: number;
  readonly name: string;
  readonly state: PickerWindowState;
  readonly fromExeFallback?: boolean;
}

export type MergedPickerSource<S extends PickerSource = PickerSource> =
  | (S & { readonly fromExeFallback?: boolean })
  | SupplementalWindow;

export interface Win32WindowApi {
  readonly available: boolean;
  readonly lookupPid: (hwnd: number) => number;
  readonly enumerateRawWindows: (excludeHwnd: number | null) => RawWin32Window[];
  readonly probeResponsiveness: (hwnd: number) => ResponsivenessProbe;
  readonly getExeNameForHwnd: (hwnd: number) => string | null;
  readonly isMinimized: (hwnd: number) => boolean;
  readonly restoreWindow: (hwnd: number) => boolean;
}

export interface KoffiModule<TType extends { name: string } = { name: string }> {
  load: (path: string) => { func: <T>(definition: string) => T };
  proto: (convention: string, result: string, args: string[]) => TType;
  pointer: (ref: TType) => TType;
  register: (callback: (hwnd: number, lParam: number) => boolean, type: TType) => bigint;
  unregister: (token: bigint) => void;
}

/** Extract a displayable executable base name (without `.exe`) from a full path. */
export function extractExeBaseName(fullPath: string): string | null {
  const trimmed = fullPath.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]/);
  const last = parts[parts.length - 1]?.trim() ?? "";
  if (!last) return null;
  const base = last.replace(/\.exe$/i, "").trim();
  return base.length > 0 ? base : null;
}

function isUwpShellCloaked(win: RawWin32Window): boolean {
  return win.cloaked === DWM_CLOAKED_SHELL && win.className === UWP_FRAME_CLASS;
}

function isEligibleStyleAndCloak(win: RawWin32Window): boolean {
  if (!win.isVisible || win.hwnd <= 0 || IGNORED_CLASSES.has(win.className)) {
    return false;
  }
  const hasAppWindow = (win.exStyle & WS_EX_APPWINDOW) !== 0;
  const hasToolOrNoActivate = (win.exStyle & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) !== 0;
  if (hasToolOrNoActivate && !hasAppWindow) {
    return false;
  }
  if (win.cloaked !== 0 && !isUwpShellCloaked(win)) {
    return false;
  }
  return true;
}

function isEligibleGeometry(win: RawWin32Window): boolean {
  const hasAppWindow = (win.exStyle & WS_EX_APPWINDOW) !== 0;
  if (win.ownerHwnd !== 0 && !hasAppWindow) {
    if (win.className === DIALOG_CLASS || win.isIconic) return false;
    return win.width >= MIN_OWNED_WIDTH && win.height >= MIN_OWNED_HEIGHT;
  }
  if (win.isIconic || isUwpShellCloaked(win)) {
    return true;
  }
  return win.width >= MIN_UNOWNED_WIDTH && win.height >= MIN_UNOWNED_HEIGHT;
}

/**
 * Filter and classify a Win32 top-level window missing from desktopCapturer.
 * Runs cheap visibility/style/geometry checks before probing responsiveness.
 */
export function classifyWin32Candidate(
  win: RawWin32Window,
  probe: (hwnd: number) => ResponsivenessProbe,
  resolveExeName?: (hwnd: number) => string | null,
): SupplementalWindow | null {
  if (!isEligibleStyleAndCloak(win) || !isEligibleGeometry(win)) {
    return null;
  }
  const trimmedTitle = win.title.trim();
  const resolvedExe =
    trimmedTitle || win.exeName !== null ? win.exeName : (resolveExeName?.(win.hwnd) ?? null);
  const name = trimmedTitle || (resolvedExe ? resolvedExe.trim() : "");
  if (!name) return null;

  const probed = probe(win.hwnd);
  let state: PickerWindowState = "normal";
  if (!probed.responsive && probed.errorCode === ERROR_ACCESS_DENIED) {
    state = "elevated";
  } else if (win.isIconic || isUwpShellCloaked(win)) {
    state = "minimized";
  }

  return {
    id: `window:${String(win.hwnd)}:0`,
    hwnd: win.hwnd,
    name,
    state,
    ...(trimmedTitle ? {} : { fromExeFallback: true }),
  };
}

/**
 * Merge desktopCapturer sources with supplemental Win32 windows, deduplicating
 * by HWND and enriching blank-titled desktopCapturer entries with exe names.
 */
export function mergePickerSources<S extends PickerSource>(
  sources: readonly S[],
  api: Win32WindowApi,
  excludeHwnd: number | null,
): MergedPickerSource<S>[] {
  if (!api.available) {
    return [...sources];
  }

  const seenHwnds = new Set<number>();
  const merged: MergedPickerSource<S>[] = [];

  for (const source of sources) {
    const hwnd = source.id.startsWith("window:") ? parseWindowHandle(source.id) : null;
    if (hwnd !== null) {
      seenHwnds.add(hwnd);
      if (source.name.trim() === "" && hwnd !== excludeHwnd) {
        const fallback = api.getExeNameForHwnd(hwnd);
        if (fallback) {
          merged.push({ ...source, name: fallback, fromExeFallback: true });
          continue;
        }
      }
    }
    merged.push(source);
  }

  for (const raw of api.enumerateRawWindows(excludeHwnd)) {
    if (seenHwnds.has(raw.hwnd)) continue;
    const candidate = classifyWin32Candidate(raw, api.probeResponsiveness, api.getExeNameForHwnd);
    if (!candidate) continue;
    seenHwnds.add(raw.hwnd);
    merged.push(candidate);
  }

  return merged;
}

export interface RestoreSourceDeps {
  readonly maxWaitMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Restore a minimized window via ShowWindowAsync(SW_RESTORE), wait briefly for DWM
 * to unminimize it, and re-query desktopCapturer for the live source object.
 * Returns null if the window remained minimized and was omitted from both refreshes.
 */
export async function resolveRestoredVideoSource<T extends { id: string; name: string }>(
  source: { id: string; name: string },
  api: Pick<Win32WindowApi, "restoreWindow" | "isMinimized">,
  queryWindows: () => Promise<readonly T[]>,
  deps: RestoreSourceDeps = {},
): Promise<T | { id: string; name: string } | null> {
  const hwnd = parseWindowHandle(source.id);
  if (hwnd === null) {
    return { id: source.id, name: source.name };
  }

  const maxWaitMs = deps.maxWaitMs ?? 150;
  const pollIntervalMs = deps.pollIntervalMs ?? 25;
  const sleep = deps.sleep ?? defaultSleep;

  api.restoreWindow(hwnd);
  let elapsed = 0;
  while (api.isMinimized(hwnd) && elapsed < maxWaitMs) {
    await sleep(pollIntervalMs);
    elapsed += pollIntervalMs;
  }

  try {
    const prefix = `window:${String(hwnd)}:`;
    const refreshed = await queryWindows();
    const match = refreshed.find((entry) => entry.id.startsWith(prefix));
    if (match) return match;
    // Shell-cloaked UWP windows may already report !IsIconic before DWM finishes uncloaking.
    await sleep(pollIntervalMs);
    const retried = await queryWindows();
    const retryMatch = retried.find((entry) => entry.id.startsWith(prefix));
    if (retryMatch) return retryMatch;
  } catch {
    // Fall through to minimized check below.
  }
  if (api.isMinimized(hwnd)) {
    return null;
  }
  return { id: source.id, name: source.name };
}

const NOOP_API: Win32WindowApi = {
  available: false,
  lookupPid: () => 0,
  enumerateRawWindows: () => [],
  probeResponsiveness: () => ({ responsive: true, errorCode: 0 }),
  getExeNameForHwnd: () => null,
  isMinimized: () => false,
  restoreWindow: () => false,
};

type EnumWindowsProcFn = (hwnd: number, lParam: number) => boolean;
type EnumWindowsFn = (cb: bigint, lParam: number) => boolean;
type BoolHwndFn = (hwnd: number) => boolean;
type GetWindowTextWFn = (hwnd: number, buf: Uint16Array, maxCount: number) => number;
type GetWindowLongPtrWFn = (hwnd: number, index: number) => number | bigint;
type GetWindowFn = (hwnd: number, cmd: number) => number | bigint;
type GetWindowRectFn = (hwnd: number, rect: Int32Array) => boolean;
type GetWindowThreadProcessIdFn = (hwnd: number, outPid: [number]) => number;
type SendMessageTimeoutWFn = (
  hwnd: number,
  msg: number,
  wParam: number,
  lParam: number,
  flags: number,
  timeout: number,
  outResult: [number],
) => number | bigint;
type ShowWindowFn = (hwnd: number, cmdShow: number) => boolean;
type DwmGetWindowAttributeFn = (
  hwnd: number,
  attr: number,
  outVal: [number],
  cbAttr: number,
) => number;
type OpenProcessFn = (access: number, inherit: boolean, pid: number) => number | bigint;
type QueryFullProcessImageNameWFn = (
  handle: number | bigint,
  flags: number,
  buf: Uint16Array,
  size: [number],
) => boolean;
type CloseHandleFn = (handle: number | bigint) => boolean;
type GetLastErrorFn = () => number;
type SetLastErrorFn = (code: number) => void;

function decodeUtf16(buf: Uint16Array, length: number): string {
  if (length <= 0) return "";
  const clamped = Math.min(length, buf.length);
  return Buffer.from(buf.buffer, buf.byteOffset, clamped * 2).toString("utf16le");
}

/**
 * Create the Win32 window enumeration/restore API backed by `koffi`.
 * Returns a no-op adapter on non-Windows platforms or if DLL loading fails.
 */
export function createWin32WindowApi<TType extends { name: string }>(
  koffiMod: KoffiModule<TType>,
  platform: NodeJS.Platform = process.platform,
): Win32WindowApi {
  if (platform !== "win32") return NOOP_API;

  let lookupPid: (hwnd: number) => number = NOOP_API.lookupPid;
  let user32: { func: <T>(definition: string) => T };
  try {
    user32 = koffiMod.load("user32.dll");
    const GetWindowThreadProcessId = user32.func<GetWindowThreadProcessIdFn>(
      "uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *lpdwProcessId)",
    );
    lookupPid = (hwnd: number): number => {
      const out: [number] = [0];
      GetWindowThreadProcessId(hwnd, out);
      return out[0];
    };
  } catch (err) {
    console.warn("[win32-windows] failed to bind user32 PID lookup via koffi:", err);
    return NOOP_API;
  }

  try {
    const dwmapi = koffiMod.load("dwmapi.dll");
    const kernel32 = koffiMod.load("kernel32.dll");

    const enumProto = koffiMod.proto("__stdcall", "bool", ["uintptr_t", "intptr_t"]);
    const enumProtoPtr = koffiMod.pointer(enumProto);

    const EnumWindows = user32.func<EnumWindowsFn>("bool __stdcall EnumWindows(void *lpEnumFunc, intptr_t lParam)");
    const IsWindowVisible = user32.func<BoolHwndFn>("bool __stdcall IsWindowVisible(uintptr_t hWnd)");
    const IsIconic = user32.func<BoolHwndFn>("bool __stdcall IsIconic(uintptr_t hWnd)");
    const GetWindowTextW = user32.func<GetWindowTextWFn>(
      "int __stdcall GetWindowTextW(uintptr_t hWnd, _Out_ uint16 *lpString, int nMaxCount)",
    );
    const GetClassNameW = user32.func<GetWindowTextWFn>(
      "int __stdcall GetClassNameW(uintptr_t hWnd, _Out_ uint16 *lpClassName, int nMaxCount)",
    );
    const GetWindowLongPtrW = user32.func<GetWindowLongPtrWFn>(
      "intptr_t __stdcall GetWindowLongPtrW(uintptr_t hWnd, int nIndex)",
    );
    const GetWindow = user32.func<GetWindowFn>("uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 uCmd)");
    const GetWindowRect = user32.func<GetWindowRectFn>(
      "bool __stdcall GetWindowRect(uintptr_t hWnd, _Out_ int32 *lpRect)",
    );
    const SendMessageTimeoutW = user32.func<SendMessageTimeoutWFn>(
      "uintptr_t __stdcall SendMessageTimeoutW(uintptr_t hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam, uint32 fuFlags, uint32 uTimeout, _Out_ uintptr_t *lpdwResult)",
    );
    const ShowWindowAsync = user32.func<ShowWindowFn>("bool __stdcall ShowWindowAsync(uintptr_t hWnd, int nCmdShow)");
    const DwmGetWindowAttribute = dwmapi.func<DwmGetWindowAttributeFn>(
      "int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 dwAttribute, _Out_ uint32 *pvAttribute, uint32 cbAttribute)",
    );
    const OpenProcess = kernel32.func<OpenProcessFn>(
      "uintptr_t __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)",
    );
    const QueryFullProcessImageNameW = kernel32.func<QueryFullProcessImageNameWFn>(
      "bool __stdcall QueryFullProcessImageNameW(uintptr_t hProcess, uint32 dwFlags, _Out_ uint16 *lpExeName, _Inout_ uint32 *lpdwSize)",
    );
    const CloseHandle = kernel32.func<CloseHandleFn>("bool __stdcall CloseHandle(uintptr_t hObject)");
    const GetLastError = kernel32.func<GetLastErrorFn>("uint32 __stdcall GetLastError()");
    const SetLastError = kernel32.func<SetLastErrorFn>("void __stdcall SetLastError(uint32 dwErrCode)");

    const getExeNameForPid = (pid: number): string | null => {
      if (pid <= 0) return null;
      const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!handle || handle === 0n) return null;
      try {
        const buf = new Uint16Array(512);
        const size: [number] = [512];
        if (!QueryFullProcessImageNameW(handle, 0, buf, size)) return null;
        return extractExeBaseName(decodeUtf16(buf, size[0]));
      } finally {
        CloseHandle(handle);
      }
    };

    const getExeNameForHwnd = (hwnd: number): string | null => getExeNameForPid(lookupPid(hwnd));

    const probeResponsiveness = (hwnd: number): ResponsivenessProbe => {
      const out: [number] = [0];
      SetLastError(0);
      const ok = SendMessageTimeoutW(hwnd, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, PROBE_TIMEOUT_MS, out);
      if (ok !== 0 && ok !== 0n) {
        return { responsive: true, errorCode: 0 };
      }
      return { responsive: false, errorCode: GetLastError() };
    };

    const readRawWindow = (hwnd: number): RawWin32Window => {
      const titleBuf = new Uint16Array(256);
      const classBuf = new Uint16Array(128);
      const title = decodeUtf16(titleBuf, GetWindowTextW(hwnd, titleBuf, 256));
      const className = decodeUtf16(classBuf, GetClassNameW(hwnd, classBuf, 128));
      const cloakedOut: [number] = [0];
      DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloakedOut, 4);
      const rect = new Int32Array(4);
      GetWindowRect(hwnd, rect);
      return {
        hwnd,
        className,
        title,
        exeName: null,
        isVisible: true,
        isIconic: IsIconic(hwnd),
        cloaked: cloakedOut[0],
        exStyle: Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) >>> 0,
        ownerHwnd: Number(GetWindow(hwnd, GW_OWNER)),
        width: (rect[2] ?? 0) - (rect[0] ?? 0),
        height: (rect[3] ?? 0) - (rect[1] ?? 0),
      };
    };

    const enumerateRawWindows = (excludeHwnd: number | null): RawWin32Window[] => {
      const windows: RawWin32Window[] = [];
      const proc: EnumWindowsProcFn = (hwnd: number): boolean => {
        const numericHwnd = Number(hwnd);
        if (excludeHwnd !== null && numericHwnd === excludeHwnd) return true;
        if (!IsWindowVisible(numericHwnd)) return true;
        windows.push(readRawWindow(numericHwnd));
        return true;
      };
      const token = koffiMod.register(proc, enumProtoPtr);
      try {
        EnumWindows(token, 0);
      } finally {
        koffiMod.unregister(token);
      }
      return windows;
    };

    return {
      available: true,
      lookupPid,
      enumerateRawWindows,
      probeResponsiveness,
      getExeNameForHwnd,
      isMinimized: (hwnd: number): boolean => IsIconic(hwnd),
      restoreWindow: (hwnd: number): boolean => ShowWindowAsync(hwnd, SW_RESTORE),
    };
  } catch (err) {
    console.warn("[win32-windows] failed to initialize Win32 picker supplement via koffi:", err);
    return { ...NOOP_API, lookupPid };
  }
}
