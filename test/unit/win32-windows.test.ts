import { describe, expect, it, vi } from "vitest";
import {
  classifyWin32Candidate,
  createWin32WindowApi,
  extractExeBaseName,
  mergePickerSources,
  resolveRestoredVideoSource,
  type KoffiModule,
  type RawWin32Window,
  type Win32WindowApi,
} from "@electron/win32-windows.js";

function makeRaw(overrides: Partial<RawWin32Window> = {}): RawWin32Window {
  return {
    hwnd: 1001,
    className: "Chrome_WidgetWin_1",
    title: "Sample App",
    exeName: "SampleApp",
    isVisible: true,
    isIconic: false,
    cloaked: 0,
    exStyle: 0x00000100,
    ownerHwnd: 0,
    width: 800,
    height: 600,
    ...overrides,
  };
}

function makeMockApi(overrides: Partial<Win32WindowApi> = {}): Win32WindowApi {
  return {
    available: true,
    lookupPid: () => 0,
    enumerateRawWindows: () => [],
    probeResponsiveness: () => ({ responsive: true, errorCode: 0 }),
    getExeNameForHwnd: () => null,
    isMinimized: () => false,
    restoreWindow: () => true,
    ...overrides,
  };
}

describe("extractExeBaseName", () => {
  it("extracts base executable names from Windows and POSIX paths", () => {
    expect(extractExeBaseName("C:\\Program Files\\App\\Game.exe")).toBe("Game");
    expect(extractExeBaseName("C:/Games/Client.EXE")).toBe("Client");
    expect(extractExeBaseName("notepad")).toBe("notepad");
    expect(extractExeBaseName("   ")).toBeNull();
    expect(extractExeBaseName("C:\\folder\\")).toBeNull();
    expect(extractExeBaseName(".exe")).toBeNull();
  });
});

describe("classifyWin32Candidate", () => {
  const responsive = () => ({ responsive: true, errorCode: 0 });

  it("classifies minimized, busy, owned, and untitled windows properly", () => {
    expect(classifyWin32Candidate(makeRaw({ hwnd: 42, isIconic: true, title: "League of Legends" }), responsive)).toEqual({
      id: "window:42:0",
      hwnd: 42,
      name: "League of Legends",
      state: "minimized",
    });

    expect(
      classifyWin32Candidate(makeRaw({ hwnd: 55, title: "Cyberpunk 2077" }), () => ({
        responsive: false,
        errorCode: 1460,
      })),
    ).toEqual({
      id: "window:55:0",
      hwnd: 55,
      name: "Cyberpunk 2077",
      state: "normal",
    });

    expect(
      classifyWin32Candidate(makeRaw({ hwnd: 77, ownerHwnd: 99, width: 320, height: 240, title: "Secondary" }), responsive),
    ).toEqual({
      id: "window:77:0",
      hwnd: 77,
      name: "Secondary",
      state: "normal",
    });

    expect(classifyWin32Candidate(makeRaw({ hwnd: 88, title: "   ", exeName: "Discord" }), responsive)).toEqual({
      id: "window:88:0",
      hwnd: 88,
      name: "Discord",
      state: "normal",
    });
  });

  it("marks ERROR_ACCESS_DENIED (5) windows as elevated", () => {
    expect(
      classifyWin32Candidate(makeRaw({ hwnd: 90, title: "Task Manager" }), () => ({
        responsive: false,
        errorCode: 5,
      })),
    ).toEqual({
      id: "window:90:0",
      hwnd: 90,
      name: "Task Manager",
      state: "elevated",
    });
  });

  it("handles UWP shell-cloaked windows vs other-desktop cloaked windows", () => {
    expect(
      classifyWin32Candidate(
        makeRaw({ hwnd: 101, className: "ApplicationFrameWindow", cloaked: 2, title: "Calculator" }),
        responsive,
      ),
    ).toEqual({
      id: "window:101:0",
      hwnd: 101,
      name: "Calculator",
      state: "minimized",
    });

    expect(classifyWin32Candidate(makeRaw({ cloaked: 2, title: "Other Desktop" }), responsive)).toBeNull();
    expect(classifyWin32Candidate(makeRaw({ className: "ApplicationFrameWindow", cloaked: 1 }), responsive)).toBeNull();
  });

  it("filters invisible, shell, tool, small owned, dialog, tiny, and nameless windows without probing", () => {
    const probe = vi.fn(responsive);
    expect(classifyWin32Candidate(makeRaw({ isVisible: false }), probe)).toBeNull();
    expect(classifyWin32Candidate(makeRaw({ hwnd: 0 }), probe)).toBeNull();
    expect(classifyWin32Candidate(makeRaw({ className: "Shell_TrayWnd" }), probe)).toBeNull();
    expect(classifyWin32Candidate(makeRaw({ exStyle: 0x80 }), probe)).toBeNull();
    expect(classifyWin32Candidate(makeRaw({ exStyle: 0x08000000 }), probe)).toBeNull();
    expect(classifyWin32Candidate(makeRaw({ ownerHwnd: 10, className: "#32770", width: 500, height: 400 }), probe)).toBeNull();
    expect(classifyWin32Candidate(makeRaw({ ownerHwnd: 10, width: 199, height: 150 }), probe)).toBeNull();
    expect(classifyWin32Candidate(makeRaw({ ownerHwnd: 10, width: 200, height: 149 }), probe)).toBeNull();
    expect(classifyWin32Candidate(makeRaw({ ownerHwnd: 10, isIconic: true, width: 500, height: 400 }), probe)).toBeNull();
    expect(classifyWin32Candidate(makeRaw({ width: 59, height: 40 }), probe)).toBeNull();
    expect(classifyWin32Candidate(makeRaw({ width: 60, height: 39 }), probe)).toBeNull();
    expect(classifyWin32Candidate(makeRaw({ title: "  ", exeName: null }), probe)).toBeNull();
    expect(classifyWin32Candidate(makeRaw({ title: "  ", exeName: "   " }), probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();

    // Exact boundary thresholds pass
    expect(classifyWin32Candidate(makeRaw({ hwnd: 103, ownerHwnd: 10, width: 200, height: 150 }), probe)?.state).toBe("normal");
    expect(classifyWin32Candidate(makeRaw({ hwnd: 104, width: 60, height: 40 }), probe)?.state).toBe("normal");
    // WS_EX_APPWINDOW overrides tool/noactivate/owned exclusions
    expect(classifyWin32Candidate(makeRaw({ hwnd: 102, ownerHwnd: 10, exStyle: 0x40080, width: 120, height: 80 }), probe)).toEqual({
      id: "window:102:0",
      hwnd: 102,
      name: "Sample App",
      state: "normal",
    });
    expect(probe).toHaveBeenCalledTimes(3);
  });
});

describe("mergePickerSources", () => {
  it("passes through unchanged when Win32 API is unavailable", () => {
    const dc = [{ id: "window:10:0", name: "App" }, { id: "screen:0:0", name: "Screen 1" }];
    expect(mergePickerSources(dc, makeMockApi({ available: false }), null)).toEqual(dc);
  });

  it("deduplicates by HWND, enriches blank desktopCapturer titles, and appends supplemental windows", () => {
    const probe = vi.fn(() => ({ responsive: true, errorCode: 0 }));
    const exeLookup = vi.fn((hwnd: number) => (hwnd === 20 || hwnd === 35 ? "FramelessApp" : null));
    const api = makeMockApi({
      getExeNameForHwnd: exeLookup,
      probeResponsiveness: probe,
      enumerateRawWindows: () => [
        makeRaw({ hwnd: 10, title: "Already In DC", exeName: null }),
        makeRaw({ hwnd: 30, title: "Minimized Game", isIconic: true }),
        makeRaw({ hwnd: 30, title: "Duplicate Raw" }),
        makeRaw({ hwnd: 35, title: "", exeName: null }),
        makeRaw({ hwnd: 40, className: "Progman", title: "", exeName: null }),
      ],
    });
    const dc = [
      { id: "window:10:1", name: "Already In DC" },
      { id: "window:20:0", name: "   " },
      { id: "window:99:0", name: "   " },
      { id: "screen:0:0", name: "Screen 1" },
    ];

    const merged = mergePickerSources(dc, api, 99);
    expect(merged).toEqual([
      { id: "window:10:1", name: "Already In DC" },
      { id: "window:20:0", name: "FramelessApp" },
      { id: "window:99:0", name: "   " },
      { id: "screen:0:0", name: "Screen 1" },
      { id: "window:30:0", hwnd: 30, name: "Minimized Game", state: "minimized" },
      { id: "window:35:0", hwnd: 35, name: "FramelessApp", state: "normal" },
    ]);
    // Probe is only called for eligible missing windows (30 and 35), not 10 or Progman 40
    expect(probe).toHaveBeenCalledTimes(2);
    expect(exeLookup).toHaveBeenCalledWith(20);
    expect(exeLookup).toHaveBeenCalledWith(35);
    expect(exeLookup).not.toHaveBeenCalledWith(40);
  });
});

describe("resolveRestoredVideoSource", () => {
  it("restores minimized window, polls until unminimized, and returns refreshed DesktopCapturerSource", async () => {
    let iconicChecks = 0;
    const api = {
      restoreWindow: vi.fn(() => true),
      isMinimized: vi.fn(() => {
        iconicChecks++;
        return iconicChecks < 2;
      }),
    };
    const sleep = vi.fn(async () => {});
    const liveSource = { id: "window:500:0", name: "League of Legends", extra: true };

    const result = await resolveRestoredVideoSource(
      { id: "window:500:0", name: "League of Legends" },
      api,
      async () => [liveSource],
      { maxWaitMs: 150, pollIntervalMs: 25, sleep },
    );

    expect(api.restoreWindow).toHaveBeenCalledWith(500);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result).toBe(liveSource);
  });

  it("retries queryWindows once after sleeping when UWP uncloaking lags behind IsIconic", async () => {
    const api = { restoreWindow: vi.fn(() => true), isMinimized: () => false };
    const sleep = vi.fn(async () => {});
    const uwpSource = { id: "window:600:0", name: "Calculator" };
    let queries = 0;
    const result = await resolveRestoredVideoSource(
      { id: "window:600:0", name: "Calculator" },
      api,
      async () => {
        queries++;
        return queries === 1 ? [] : [uwpSource];
      },
      { pollIntervalMs: 25, sleep },
    );
    expect(queries).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result).toBe(uwpSource);
  });

  it("falls back to { id, name } on invalid id, missing match, or query failure", async () => {
    const api = { restoreWindow: vi.fn(() => true), isMinimized: () => false };
    expect(await resolveRestoredVideoSource({ id: "screen:0:0", name: "Screen 1" }, api, async () => [])).toEqual({
      id: "screen:0:0",
      name: "Screen 1",
    });
    expect(api.restoreWindow).not.toHaveBeenCalled();

    expect(
      await resolveRestoredVideoSource({ id: "window:777:0", name: "Game" }, api, async () => {
        throw new Error("boom");
      }),
    ).toEqual({ id: "window:777:0", name: "Game" });
  });

  it("stops polling at maxWaitMs when window stays minimized and falls back cleanly", async () => {
    const api = { restoreWindow: vi.fn(() => true), isMinimized: () => true };
    const sleep = vi.fn(async () => {});
    const res = await resolveRestoredVideoSource(
      { id: "window:888:0", name: "Stubborn" },
      api,
      async () => [],
      { maxWaitMs: 50, pollIntervalMs: 25, sleep },
    );
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(25);
    expect(res).toEqual({ id: "window:888:0", name: "Stubborn" });
  });
});

describe("createWin32WindowApi", () => {
  it("returns no-op adapter on non-win32 platforms or when koffi.load fails", () => {
    const unusedKoffi = {} as KoffiModule;
    const linuxApi = createWin32WindowApi(unusedKoffi, "linux");
    expect(linuxApi.available).toBe(false);
    expect(linuxApi.lookupPid(100)).toBe(0);
    expect(linuxApi.enumerateRawWindows(null)).toEqual([]);
    expect(linuxApi.probeResponsiveness(100)).toEqual({ responsive: true, errorCode: 0 });
    expect(linuxApi.getExeNameForHwnd(100)).toBeNull();
    expect(linuxApi.isMinimized(100)).toBe(false);
    expect(linuxApi.restoreWindow(100)).toBe(false);

    const brokenKoffi = {
      load: () => {
        throw new Error("missing dll");
      },
    } as unknown as KoffiModule;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createWin32WindowApi(brokenKoffi, "win32").available).toBe(false);
    warnSpy.mockRestore();
  });

  it("binds Win32 functions via koffi and cleans up EnumWindows callbacks and process handles", () => {
    function writeUtf16(buf: Uint16Array, text: string): number {
      for (let i = 0; i < text.length; i++) buf[i] = text.charCodeAt(i);
      return text.length;
    }

    let registeredProc: ((hwnd: number, lParam: number) => boolean) | null = null;
    const unregister = vi.fn();
    const closeHandle = vi.fn(() => true);
    const showWindow = vi.fn(() => true);
    let lastError = 0;
    let sendMsgRet: number | bigint = 1;

    const fns: Record<string, unknown> = {
      EnumWindows: () => {
        registeredProc?.(10, 0); // excluded self
        registeredProc?.(20, 0); // invisible
        registeredProc?.(30, 0); // titled visible
        registeredProc?.(40, 0); // untitled visible -> queries exe
        return true;
      },
      IsWindowVisible: (hwnd: number) => hwnd !== 20,
      IsIconic: (hwnd: number) => hwnd === 40,
      GetWindowTextW: (hwnd: number, buf: Uint16Array) => (hwnd === 30 ? writeUtf16(buf, "Notepad") : 0),
      GetClassNameW: (_hwnd: number, buf: Uint16Array) => writeUtf16(buf, "NotepadClass"),
      GetWindowLongPtrW: () => 0x100n,
      GetWindow: () => 0,
      GetWindowRect: (_hwnd: number, rect: Int32Array) => {
        rect[0] = 10;
        rect[1] = 20;
        rect[2] = 810;
        rect[3] = 620;
        return true;
      },
      GetWindowThreadProcessId: (hwnd: number, outPid: [number]) => {
        outPid[0] = hwnd === 40 ? 4444 : 3333;
        return 1;
      },
      SendMessageTimeoutW: () => sendMsgRet,
      ShowWindow: showWindow,
      DwmGetWindowAttribute: (_hwnd: number, _attr: number, outVal: [number]) => {
        outVal[0] = 0;
        return 0;
      },
      OpenProcess: (_access: number, _inherit: boolean, pid: number) => (pid === 4444 ? 999 : 0),
      QueryFullProcessImageNameW: (_h: number, _flags: number, buf: Uint16Array, size: [number]) => {
        size[0] = writeUtf16(buf, "C:\\Apps\\CustomApp.exe");
        return true;
      },
      CloseHandle: closeHandle,
      GetLastError: () => lastError,
    };

    const mockKoffi: KoffiModule<{ name: string }> = {
      load: () => ({
        func: <T>(def: string): T => {
          const match = /\b([A-Za-z0-9_]+)\(/.exec(def);
          const name = match?.[1] ?? "";
          return fns[name] as T;
        },
      }),
      proto: () => ({ name: "anon_proto" }),
      pointer: (ref) => ref,
      register: (cb) => {
        registeredProc = cb;
        return 77n;
      },
      unregister,
    };

    const api = createWin32WindowApi(mockKoffi, "win32");
    expect(api.available).toBe(true);
    expect(api.lookupPid(40)).toBe(4444);
    expect(api.getExeNameForHwnd(40)).toBe("CustomApp");
    expect(api.getExeNameForHwnd(30)).toBeNull();
    expect(closeHandle).toHaveBeenCalledWith(999);

    expect(api.isMinimized(40)).toBe(true);
    expect(api.restoreWindow(40)).toBe(true);
    expect(showWindow).toHaveBeenCalledWith(40, 9);

    expect(api.probeResponsiveness(30)).toEqual({ responsive: true, errorCode: 0 });
    sendMsgRet = 0;
    lastError = 1460;
    expect(api.probeResponsiveness(30)).toEqual({ responsive: false, errorCode: 1460 });

    const rows = api.enumerateRawWindows(10);
    expect(unregister).toHaveBeenCalledWith(77n);
    expect(rows).toEqual([
      {
        hwnd: 30,
        className: "NotepadClass",
        title: "Notepad",
        exeName: null,
        isVisible: true,
        isIconic: false,
        cloaked: 0,
        exStyle: 0x100,
        ownerHwnd: 0,
        width: 800,
        height: 600,
      },
      {
        hwnd: 40,
        className: "NotepadClass",
        title: "",
        exeName: null,
        isVisible: true,
        isIconic: true,
        cloaked: 0,
        exStyle: 0x100,
        ownerHwnd: 0,
        width: 800,
        height: 600,
      },
    ]);
  });
});
