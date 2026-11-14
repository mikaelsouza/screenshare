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
  it("returns true only for installed packaged Windows non-dev non-smoke builds", () => {
    expect(shouldEnableAutoUpdate(BASE_ENV)).toBe(true);
  });

  it("returns false when unpackaged, non-Windows, dev, or smoke test", () => {
    expect(shouldEnableAutoUpdate({ ...BASE_ENV, isPackaged: false })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...BASE_ENV, platform: "linux" })).toBe(false);
    expect(shouldEnableAutoUpdate({ ...BASE_ENV, platform: "darwin" })).toBe(false);
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

  it("does not create an updater or schedule checks when disabled by environment", async () => {
    const { deps, mock } = makeDeps();
    const controller = createAutoUpdateController({ ...BASE_ENV, isSmokeTest: true }, deps);
    expect(controller.start()).toBe(false);
    expect(deps.createUpdater).not.toHaveBeenCalled();
    expect(mock.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEFAULT_UPDATE_CHECK_INTERVAL_MS);
    expect(mock.checkForUpdates).not.toHaveBeenCalled();
    expect(() => controller.stop()).not.toThrow();
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

  it("can be restarted cleanly after stop()", async () => {
    const { deps, mock } = makeDeps({ checkIntervalMs: 1_000 });
    const controller = createAutoUpdateController(BASE_ENV, deps);
    expect(controller.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(1);

    controller.stop();
    expect(controller.start()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.createUpdater).toHaveBeenCalledTimes(2);
    expect(mock.checkForUpdates).toHaveBeenCalledTimes(2);
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

  it("awaits downloadPromise and forwards both checkForUpdates, downloadPromise, and event errors to onError", async () => {
    const { deps, mock, onError } = makeDeps({ checkIntervalMs: 1_000 });
    const checkErr = new Error("network down");
    const downloadErr = new Error("sha512 mismatch");

    mock.checkForUpdates
      .mockRejectedValueOnce(checkErr)
      .mockImplementationOnce(async () => ({
        downloadPromise: Promise.resolve().then(() => {
          throw downloadErr;
        }),
      }))
      .mockImplementationOnce(async () => ({ downloadPromise: Promise.resolve(["installer.exe"]) }));

    const controller = createAutoUpdateController(BASE_ENV, deps);
    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenNthCalledWith(1, checkErr);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenNthCalledWith(2, downloadErr);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledTimes(2);

    const emittedErr = new Error("github 502");
    mock.emitError(emittedErr);
    expect(onError).toHaveBeenNthCalledWith(3, emittedErr);

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
