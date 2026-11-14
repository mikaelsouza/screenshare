/**
 * Manages background auto-updates for the packaged Windows desktop app via
 * electron-updater (GitHub Releases).
 *
 * Pure state machine with injected dependencies so it can be unit- and
 * mutation-tested without Electron or network access.
 */

export const DEFAULT_UPDATE_CHECK_INTERVAL_MS: number = 4 * 60 * 60 * 1000;

export interface UpdaterClient {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  disableWebInstaller: boolean;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "update-downloaded", listener: (info: { readonly version: string }) => void): unknown;
  checkForUpdates(): Promise<{ readonly downloadPromise?: Promise<unknown> | null | undefined } | null>;
}

export interface AutoUpdateEnv {
  readonly isPackaged: boolean;
  readonly platform: string;
  readonly isWindowsStore: boolean;
  readonly isDev: boolean;
  readonly isSmokeTest: boolean;
}

export interface AutoUpdateDeps {
  readonly createUpdater: () => UpdaterClient;
  readonly notifyDownloaded: (version: string) => void;
  readonly onError: (err: unknown) => void;
  readonly checkIntervalMs?: number | undefined;
}

export interface AutoUpdateController {
  start(): boolean;
  stop(): void;
}

/**
 * Only non-Store packaged Windows builds check GitHub Releases for updates;
 * Microsoft Store packages are updated automatically by the Store.
 */
export function shouldEnableAutoUpdate(env: AutoUpdateEnv): boolean {
  return (
    env.isPackaged &&
    env.platform === "win32" &&
    !env.isWindowsStore &&
    !env.isDev &&
    !env.isSmokeTest
  );
}

/**
 * Create a controller that checks for updates on startup and periodically thereafter,
 * downloading silently and notifying once per downloaded version so the update installs
 * automatically when the user quits.
 */
export function createAutoUpdateController(
  env: AutoUpdateEnv,
  deps: AutoUpdateDeps,
): AutoUpdateController {
  let started = false;
  let stopped = false;
  let inFlight = false;
  let client: UpdaterClient | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const notifiedVersions = new Set<string>();
  const reportedErrors = new WeakSet<object>();

  function reportError(err: unknown): void {
    if (typeof err === "object" && err !== null) {
      if (reportedErrors.has(err)) return;
      reportedErrors.add(err);
    }
    deps.onError(err);
  }

  function ensureClient(): UpdaterClient | null {
    if (client !== null) return client;
    let created: UpdaterClient;
    try {
      created = deps.createUpdater();
    } catch (err: unknown) {
      reportError(err);
      return null;
    }

    created.autoDownload = true;
    created.autoInstallOnAppQuit = true;
    created.disableWebInstaller = true;

    created.on("error", (err: Error) => {
      reportError(err);
    });
    created.on("update-downloaded", (info: { readonly version: string }) => {
      if (stopped || notifiedVersions.has(info.version)) return;
      notifiedVersions.add(info.version);
      deps.notifyDownloaded(info.version);
    });

    client = created;
    return client;
  }

  async function checkOnce(activeClient: UpdaterClient): Promise<void> {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const res = await activeClient.checkForUpdates();
      if (res?.downloadPromise) {
        await res.downloadPromise;
      }
    } catch (err: unknown) {
      reportError(err);
    } finally {
      inFlight = false;
    }
  }

  return {
    start(): boolean {
      if (!shouldEnableAutoUpdate(env)) return false;
      if (started) return true;
      const activeClient = ensureClient();
      if (activeClient === null) return false;

      started = true;
      stopped = false;

      void checkOnce(activeClient);
      const intervalMs = deps.checkIntervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS;
      timer = setInterval(() => {
        void checkOnce(activeClient);
      }, intervalMs);
      timer.unref();
      return true;
    },

    stop(): void {
      stopped = true;
      started = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
