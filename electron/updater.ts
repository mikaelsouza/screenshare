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
 * Only installed packaged Windows builds check GitHub Releases for updates.
 */
export function shouldEnableAutoUpdate(env: AutoUpdateEnv): boolean {
  return (
    env.isPackaged &&
    env.platform === "win32" &&
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
  let timer: ReturnType<typeof setInterval> | null = null;
  const notifiedVersions = new Set<string>();

  async function checkOnce(client: UpdaterClient): Promise<void> {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const res = await client.checkForUpdates();
      if (res?.downloadPromise) {
        await res.downloadPromise;
      }
    } catch (err: unknown) {
      deps.onError(err);
    } finally {
      inFlight = false;
    }
  }

  return {
    start(): boolean {
      if (!shouldEnableAutoUpdate(env)) return false;
      if (started) return true;
      started = true;
      stopped = false;

      const client = deps.createUpdater();
      client.autoDownload = true;
      client.autoInstallOnAppQuit = true;
      client.disableWebInstaller = true;

      client.on("error", (err: Error) => {
        deps.onError(err);
      });
      client.on("update-downloaded", (info: { readonly version: string }) => {
        if (stopped || notifiedVersions.has(info.version)) return;
        notifiedVersions.add(info.version);
        deps.notifyDownloaded(info.version);
      });

      void checkOnce(client);
      const intervalMs = deps.checkIntervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS;
      timer = setInterval(() => {
        void checkOnce(client);
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
