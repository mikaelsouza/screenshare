import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutoUpdateController,
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
  shouldEnableAutoUpdate,
  type AutoUpdateDeps,
  type AutoUpdateEnv,
  type UpdaterClient,
} from "@electron/updater.js";

const BASE_ENV: AutoUpdateEnv = {
  isPackaged: true,
  platform: "win32",
  isWindowsStore: false,
  isDev: false,
  isSmokeTest: false,
};

interface MockUpdater {
  client: UpdaterClient;
  emitError: (err: Error) => void;
  emitDownloaded: (version: string) => void;
  checkForUpdates: ReturnType<
    typeof vi.fn<() => Promise<{ readonly downloadPromise?: Promise<unknown> | null | undefined } | null>>
  >;
}

function makeMockUpdater(): MockUpdater {
  const errorListeners: Array<(err: Error) => void> = [];
  const downloadedListeners: Array<(info: { readonly version: string }) => void> = [];
  const checkForUpdates = vi.fn<
    () => Promise<{ readonly downloadPromise?: Promise<unknown> | null | undefined } | null>
  >(async () => null);

  const client: UpdaterClient = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    disableWebInstaller: false,
    on(event: "error" | "update-downloaded", listener: ((err: Error) => void) | ((info: { readonly version: string }) => void)) {
      if (event === "error") {
        errorListeners.push(listener as (err: Error) => void);
      } else if (event === "update-downloaded") {
        downloadedListeners.push(listener as (info: { readonly version: string }) => void);
      }
      return client;
    },
    checkForUpdates,
  };

  return {
    client,
    checkForUpdates,
    emitError: (err: Error) => {
      for (const fn of errorListeners) fn(err);
    },
    emitDownloaded: (version: string) => {
      for (const fn of downloadedListeners) fn({ version });
    },
  };
}

function makeDeps(overrides: Partial<AutoUpdateDeps> = {}): {
  deps: AutoUpdateDeps;
  mock: MockUpdater;
  notifyDownloaded: ReturnType<typeof vi.fn<(version: string) => void>>;
  onError: ReturnType<typeof vi.fn<(err: unknown) => void>>;
} {
  const mock = makeMockUpdater();
  const notifyDownloaded = vi.fn<(version: string) => void>();
  const onError = vi.fn<(err: unknown) => void>();
  const deps: AutoUpdateDeps = {
    createUpdater: vi.fn(() => mock.client),
    notifyDownloaded,
    onError,
    ...overrides,
  };
  return { deps, mock, notifyDownloaded, onError };
}

describe("DEFAULT_UPDATE_CHECK_INTERVAL_MS", () => {
  it("defaults to four hours in milliseconds", () => {
    expect(DEFAULT_UPDATE_CHECK_INTERVAL_MS).toBe(4 * 60 * 60 * 1000);
  });
});

describe("shouldEnableAutoUpdate", () => {
  it("returns true only for non-Store installed packaged Windows non-dev non-smoke builds", () => {
    expect(shouldEnableAutoUpdate(BASE_ENV)).toBe(true);
  });

  it("returns false when unpackaged, non-Windows, Windows Store, dev, or smoke test", () => {
    expect(shouldEnableAutoUpdate({ ...BASE_ENV, isPackaged: false })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...BASE_ENV, platform: "linux" })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...BASE_ENV, platform: "darwin" })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...BASE_ENV, isWindowsStore: true })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...BASE_ENV, isDev: true })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...BASE_ENV, isSmokeTest: true })).toBe(false);
  });
});

describe("createAutoUpdateController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not create an updater or schedule checks when disabled by environment or Windows Store", async () => {
    for (const env of [
      { ...BASE_ENV, isSmokeTest: true },
      { ...BASE_ENV, isWindowsStore: true },
    ]) {
      const { deps, mock } = makeDeps();
      const controller = createAutoUpdateController(env, deps);
      expect(controller.start()).toBe(false);
      expect(deps.createUpdater).not.toHaveBeenCalled();
      expect(mock.checkForUpdates).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(DEFAULT_UPDATE_CHECK_INTERVAL_MS);
      expect(mock.checkForUpdates).not.toHaveBeenCalled();
      expect(() => controller.stop()).not.toThrow();
    }
  });

  it("configures NsisUpdater flags, unrefs interval timer, and checks immediately + periodically", async () => {
    const { deps, mock } = makeDeps();
    const realSetInterval = globalThis.setInterval;
    const unrefSpies: Array<ReturnType<typeof vi.fn>> = [];
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((
      fn: () => void,
      ms?: number,
    ) => {
      const handle = realSetInterval(fn, ms);
      const unrefSpy = vi.fn(() => handle);
      handle.unref = unrefSpy;
      unrefSpies.push(unrefSpy);
      return handle;
    });

    const controller = createAutoUpdateController(BASE_ENV, deps);
    expect(controller.start()).toBe(true);
    // Starting twice while active is idempotent and does not recreate the updater.
    expect(controller.start()).toBe(true);

    expect(deps.createUpdater).toHaveBeenCalledTimes(1);
    expect(mock.client.autoDownload).toBe(true);
    expect(mock.client.autoInstallOnAppQuit).toBe(true);
    expect(mock.client.disableWebInstaller).toBe(true);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), DEFAULT_UPDATE_CHECK_INTERVAL_MS);
    expect(unrefSpies[0]).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(deps.onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_UPDATE_CHECK_INTERVAL_MS);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(deps.onError).not.toHaveBeenCalled();

    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    controller.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    controller.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses a single UpdaterClient instance when restarted after stop()", async () => {
    const { deps, mock, notifyDownloaded } = makeDeps({ checkIntervalMs: 1_000 });
    const controller = createAutoUpdateController(BASE_ENV, deps);
    expect(controller.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(1);

    controller.stop();
    expect(controller.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.createUpdater).toHaveBeenCalledTimes(1);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(2);

    mock.emitDownloaded("1.0.5");
    expect(notifyDownloaded).toHaveBeenCalledTimes(1);
    expect(notifyDownloaded).toHaveBeenCalledWith("1.0.5");
    controller.stop();
  });

  it("reports createUpdater errors without crashing and can recover on a later start()", async () => {
    const initErr = new Error("bad semver");
    const mock = makeMockUpdater();
    const notifyDownloaded = vi.fn<(version: string) => void>();
    const onError = vi.fn<(err: unknown) => void>();
    const createUpdater = vi
      .fn<() => UpdaterClient>()
      .mockImplementationOnce(() => {
        throw initErr;
      })
      .mockImplementationOnce(() => mock.client);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const controller = createAutoUpdateController(BASE_ENV, {
      createUpdater,
      notifyDownloaded,
      onError,
      checkIntervalMs: 1_000,
    });

    expect(controller.start()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(initErr);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    expect(controller.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(createUpdater).toHaveBeenCalledTimes(2);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it("respects custom checkIntervalMs and prevents overlapping checks while one is in flight", async () => {
    const { deps, mock } = makeDeps({ checkIntervalMs: 1_000 });
    let resolveCheck!: (val: { downloadPromise?: Promise<unknown> | null } | null) => void;
    mock.checkForUpdates.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );

    const controller = createAutoUpdateController(BASE_ENV, deps);
    expect(controller.start()).toBe(true);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(1);

    // Interval fires while initial check is still pending -> skipped by inFlight guard.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(1);

    resolveCheck(null);
    await vi.advanceTimersByTimeAsync(0);

    // Next interval fires after previous check completed -> runs again.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(2);
    resolveCheck(null);
    await vi.advanceTimersByTimeAsync(0);

    controller.stop();
  });

  it("deduplicates errors emitted and rethrown by AppUpdater while still forwarding primitives and event-only errors", async () => {
    const { deps, mock, onError } = makeDeps({ checkIntervalMs: 1_000 });
    const checkErr = new Error("network down");
    const downloadErr = new Error("sha512 mismatch");

    mock.checkForUpdates
      // Real AppUpdater.checkForUpdates emits 'error' AND rejects with the same Error object.
      .mockImplementationOnce(async () => {
        mock.emitError(checkErr);
        throw checkErr;
      })
      // Real AppUpdater.downloadUpdate emits 'error' AND rejects downloadPromise with the same Error.
      .mockImplementationOnce(async () => ({
        downloadPromise: Promise.resolve().then(() => {
          mock.emitError(downloadErr);
          throw downloadErr;
        }),
      }))
      // Non-object rejections must bypass WeakSet tracking cleanly without throwing.
      .mockRejectedValueOnce("primitive failure")
      .mockRejectedValueOnce(null)
      .mockImplementationOnce(async () => ({ downloadPromise: Promise.resolve(["installer.exe"]) }));

    const controller = createAutoUpdateController(BASE_ENV, deps);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenNthCalledWith(1, checkErr);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenNthCalledWith(2, downloadErr);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenNthCalledWith(3, "primitive failure");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenNthCalledWith(4, null);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledTimes(4);

    // Quit-time / event-only errors (no active checkForUpdates promise) still report once.
    const quitErr = new Error("github 502");
    mock.emitError(quitErr);
    mock.emitError(quitErr);
    expect(onError).toHaveBeenCalledTimes(5);
    expect(onError).toHaveBeenNthCalledWith(5, quitErr);

    controller.stop();
  });

  it("notifies once per downloaded version and suppresses notifications and checks after stop()", async () => {
    const { deps, mock, notifyDownloaded } = makeDeps({ checkIntervalMs: 1_000 });
    const controller = createAutoUpdateController(BASE_ENV, deps);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(1);

    mock.emitDownloaded("1.0.1");
    mock.emitDownloaded("1.0.1");
    expect(notifyDownloaded).toHaveBeenCalledTimes(1);
    expect(notifyDownloaded).toHaveBeenCalledWith("1.0.1");

    mock.emitDownloaded("1.0.2");
    expect(notifyDownloaded).toHaveBeenCalledTimes(2);
    expect(notifyDownloaded).toHaveBeenLastCalledWith("1.0.2");

    controller.stop();

    // Events and timer ticks after stop() do not notify or trigger checkForUpdates.
    mock.emitDownloaded("1.0.3");
    expect(notifyDownloaded).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("ignores scheduled callbacks if stop() is called while an interval callback is triggered", async () => {
    const { deps, mock } = makeDeps({ checkIntervalMs: 1_000 });
    let capturedCb: (() => void) | null = null;
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation((fn: () => void, ms?: number) => {
      capturedCb = fn;
      return realSetInterval(fn, ms);
    });

    const controller = createAutoUpdateController(BASE_ENV, deps);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(1);

    controller.stop();
    capturedCb!();
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});
