import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  session,
  desktopCapturer,
  ipcMain,
  shell,
  type DesktopCapturerSource,
} from "electron";
import { NsisUpdater } from "electron-updater";
import { matchProfile, type FollowProfile } from "./follow/profiles.js";
import { createFollower, type Follower, type FollowStatus, type WindowSource } from "./follow/follower.js";
import { buildPickerTemplate } from "./picker.js";
import { createPidResolver } from "./audio/pid.js";
import { createAudioSessionController } from "./audio/capture.js";
import { createAutoUpdateController } from "./updater.js";
import koffi from "koffi";
import loopback from "loopback-capture";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env["ELECTRON_DEV"] === "1" || process.env["NODE_ENV"] === "development";
const isSmokeTest = process.argv.includes("--smoke-test") || process.env["SMOKE_TEST"] === "1";

// The app loads the hosted site so it shares rooms (signaling via the Cloudflare Worker /
// Durable Object) with browser users.
const REMOTE_APP_URL = process.env["SCREENSHARE_URL"] || "https://screenshare.webmikas.com";

let mainWindow: BrowserWindow | null = null;
// Origin of the page we load; capture permissions are only granted to it.
let trustedOrigin: string | null = null;

const pendingTasks = new Set<Promise<unknown>>();

function runBackground(task: Promise<unknown>, context: string): void {
  const tracked = task
    .catch((err: unknown) => {
      console.warn(`[main] ${context}:`, err);
    })
    .finally(() => {
      pendingTasks.delete(tracked);
    });
  pendingTasks.add(tracked);
}

function isTrustedUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return Boolean(trustedOrigin) && new URL(url).origin === trustedOrigin;
  } catch {
    return false;
  }
}

function resolveTargetUrl(): string {
  const devServerUrl = process.env["VITE_DEV_SERVER_URL"];
  return isDev && devServerUrl ? devServerUrl : REMOTE_APP_URL;
}

function offlinePage(url: string, description: string): string {
  const html = `<!doctype html><meta charset="utf-8"><title>Screenshare</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#121214;color:#e6e6e6;font:15px system-ui,sans-serif">
<div style="text-align:center;max-width:460px">
<h2 style="font-weight:600">Can't reach Screenshare</h2>
<p>Couldn't load <b>${new URL(url).host}</b> (${description}).</p>
<p style="opacity:.7">Check your internet connection. Retrying automatically…</p>
</div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// ---- audio capture ---------------------------------------------------------

let lastPickedSource: DesktopCapturerSource | null = null;

type GetWindowThreadProcessIdFn = (hwnd: number, outPid: [number]) => unknown;

let lookupWin32Pid: (hwnd: number) => number = () => 0;
if (process.platform === "win32") {
  try {
    const user32 = koffi.load("user32.dll");
    const GetWindowThreadProcessId: GetWindowThreadProcessIdFn = user32.func(
      "uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *lpdwProcessId)",
    );
    lookupWin32Pid = (hwnd: number): number => {
      const out: [number] = [0];
      GetWindowThreadProcessId(hwnd, out);
      return out[0];
    };
  } catch (err) {
    console.warn("[main] could not load user32.dll via koffi:", err);
  }
}

const audioSession = createAudioSessionController({
  createCapture: () => new loopback.LoopbackCapture(),
  resolvePid: createPidResolver(lookupWin32Pid),
  selfPid: process.pid,
  sendPcm: (chunk: Uint8Array) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("audio:pcm", chunk);
    }
  },
});

// ---- game follow -----------------------------------------------------------

/** How often the open windows are checked while following a game. */
const FOLLOW_POLL_MS = 1000;

interface FollowSessionState {
  follower: Follower;
  timer: ReturnType<typeof setInterval> | null;
  busy: boolean;
}

/** The active follow, if any: { follower, timer, busy }. */
let follow: FollowSessionState | null = null;

function sendFollowUpdate(profile: FollowProfile, status: FollowStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("follow:update", { ...status, profile: profile.label });
}

function stopFollow(): void {
  if (follow?.timer) clearInterval(follow.timer);
  follow = null;
}

async function pollFollowState(profile: FollowProfile, state: FollowSessionState): Promise<void> {
  try {
    const windows = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 0, height: 0 },
    });
    if (follow !== state) return;
    const status = state.follower.evaluate(windows);
    if (!status) return;
    if (status.sourceId) audioSession.switchWindow(status.sourceId);
    sendFollowUpdate(profile, status);
    if (status.role === "ended") stopFollow();
  } catch (err) {
    console.error("[main] follow poll failed:", err);
  } finally {
    state.busy = false;
  }
}

function startFollow(profile: FollowProfile, source: WindowSource): void {
  stopFollow();
  const follower = createFollower(profile, { initial: source });
  const state: FollowSessionState = { follower, timer: null, busy: false };
  follow = state;
  sendFollowUpdate(profile, follower.current());

  // Polled here rather than in the page: the page's timers are throttled while the
  // game covers its window, which is exactly when this has to keep running.
  state.timer = setInterval(() => {
    if (state.busy) return;
    state.busy = true;
    runBackground(pollFollowState(profile, state), "follow poll");
  }, FOLLOW_POLL_MS);
}

// ---- media & IPC handlers --------------------------------------------------

async function handleDisplayMediaRequest(
  callback: (streams: { video?: DesktopCapturerSource }) => void,
): Promise<void> {
  let sources: DesktopCapturerSource[];
  try {
    sources = await desktopCapturer.getSources({
      types: ["window", "screen"],
      fetchWindowIcons: true,
      thumbnailSize: { width: 0, height: 0 },
    });
  } catch (err) {
    console.error("[main] desktopCapturer.getSources failed:", err);
    // Electron's callback({}) rejects getDisplayMedia in the page, and also
    // throws synchronously on the main-process stack.
    try {
      callback({});
    } catch {
      // Ignore synchronous rejection error from Electron
    }
    return;
  }

  let settled = false;
  const finish = (source: DesktopCapturerSource | null): void => {
    if (settled) return;
    settled = true;
    if (!source) {
      // Rejects getDisplayMedia, which the page treats as a cancelled pick.
      // Electron also throws "Video was requested, but no video stream was
      // provided" synchronously here; inside setTimeout that would be uncaught.
      try {
        callback({});
      } catch {
        // Ignore synchronous rejection error from Electron
      }
      return;
    }
    stopFollow();
    audioSession.stop();
    lastPickedSource = source;
    try {
      callback({ video: source });
    } catch (err) {
      console.error("[main] setDisplayMediaRequestHandler callback failed:", err);
      return;
    }
    // The exception to "share what was picked": a game's lobby or game window is
    // followed between the two. See electron/follow.
    const match = matchProfile(source.name);
    if (match) startFollow(match.profile, source);
  };

  const template = buildPickerTemplate(sources, finish, {
    excludeId: mainWindow && !mainWindow.isDestroyed() ? mainWindow.getMediaSourceId() : null,
  });
  if (template.length === 0 || !mainWindow || mainWindow.isDestroyed()) {
    finish(null);
    return;
  }
  Menu.buildFromTemplate(template).popup({
    window: mainWindow,
    // Runs when the menu closes, which on Windows can be before the clicked
    // item's handler. Wait a moment so a real pick always wins over "cancelled".
    callback: () => {
      setTimeout(() => finish(null), 100);
    },
  });
}

function setupMediaHandlers(): void {
  // 1. getDisplayMedia: let the user pick a window or screen from a native menu,
  //    as Chrome's own picker does on the web. Audio is Electron's loopback, i.e.
  //    everything the PC plays: Electron cannot capture a single window's audio.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    runBackground(handleDisplayMediaRequest(callback), "display media request");
  });

  ipcMain.on("follow:stop", (event) => {
    if (isTrustedUrl(event.senderFrame?.url || event.sender.getURL())) stopFollow();
  });

  ipcMain.handle("audio:start-window", (event, sourceId: unknown) => {
    if (!isTrustedUrl(event.senderFrame?.url || event.sender.getURL())) return false;
    const targetId = lastPickedSource?.id;
    if (typeof sourceId === "string" && sourceId && sourceId !== targetId) return false;
    return Boolean(targetId && audioSession.startForWindow(targetId));
  });

  ipcMain.handle("audio:start-system", (event) => {
    if (!isTrustedUrl(event.senderFrame?.url || event.sender.getURL())) return false;
    return audioSession.startForSystem();
  });

  ipcMain.on("audio:stop", (event) => {
    if (isTrustedUrl(event.senderFrame?.url || event.sender.getURL())) audioSession.stop();
  });

  // 2. Permission request handler for display-capture & media (trusted origin only,
  //    since the app now loads remote content)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = (permission as string) === "display-capture" || permission === "media";
    callback(allowed && isTrustedUrl(details.requestingUrl || webContents.getURL()));
  });

  // 3. Permission check handler
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const allowed = (permission as string) === "display-capture" || permission === "media";
    return allowed && isTrustedUrl(requestingOrigin || webContents?.getURL());
  });
}

// ---- application lifecycle -------------------------------------------------

async function initApplication(): Promise<void> {
  const targetUrl = resolveTargetUrl();
  trustedOrigin = new URL(targetUrl).origin;
  console.log(`[main] Loading ${targetUrl}`);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#121214",
    show: false,
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, "../assets/icon.ico") }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = win;

  win.once("ready-to-show", () => {
    if (!isSmokeTest) {
      win.show();
    }
  });

  // External links routing to default system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http:") || url.startsWith("https:") || url.startsWith("mailto:")) {
      runBackground(shell.openExternal(url), "openExternal");
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    try {
      const parsedNav = new URL(url);
      const parsedTarget = new URL(targetUrl);
      if (parsedNav.origin !== parsedTarget.origin) {
        event.preventDefault();
        runBackground(shell.openExternal(url), "will-navigate openExternal");
      }
    } catch {
      // Invalid URL navigation attempt ignored
    }
  });

  // If the hosted site can't be reached (offline, DNS, TLS), show a message and retry
  // instead of leaving a blank window.
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED (e.g. superseded navigation); not a real failure.
    if (!isMainFrame || errorCode === -3 || validatedURL.startsWith("data:")) return;
    console.error(`[main] Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
    runBackground(win.loadURL(offlinePage(targetUrl, errorDescription)), "load offline page");
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        runBackground(mainWindow.loadURL(targetUrl), "retry loadURL");
      }
    }, 5000);
  });
  win.on("closed", () => {
    if (retryTimer) clearTimeout(retryTimer);
    stopFollow();
    audioSession.stop();
    mainWindow = null;
  });

  // Load failures are handled by 'did-fail-load' above.
  try {
    await win.loadURL(targetUrl);
  } catch {
    // Handled via did-fail-load listener above
  }
}

if (process.platform === "win32") {
  app.setAppUserModelId("com.screenshare.app");
}

const autoUpdate = createAutoUpdateController(
  {
    isPackaged: app.isPackaged,
    platform: process.platform,
    isDev,
    isSmokeTest,
  },
  {
    createUpdater: () => new NsisUpdater(),
    notifyDownloaded: (version: string) => {
      if (Notification.isSupported()) {
        new Notification({
          title: "Screenshare update ready",
          body: `Version ${version} has been downloaded and will install when you close Screenshare.`,
        }).show();
      }
    },
    onError: (err: unknown) => {
      console.warn("[updater] auto-update check failed:", err);
    },
  },
);

// Smoke tests use a throwaway profile so they neither collide with a running copy of the
// app (single-instance lock) nor touch its data.
if (isSmokeTest) {
  app.setPath("userData", path.join(app.getPath("temp"), `screenshare-smoke-${process.pid}`));
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another Screenshare/Electron instance (same userData dir) already holds the lock.
  // Without this message the app just exits silently, which looks like "it won't start".
  console.error(
    "[main] Another instance is already running (single-instance lock is held). " +
      "Close it (check Task Manager for stray electron.exe processes) and try again.",
  );
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  runBackground(
    app.whenReady().then(async () => {
      setupMediaHandlers();
      await initApplication();
      autoUpdate.start();
    }),
    "app startup",
  );
}

app.on("will-quit", () => {
  autoUpdate.stop();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    runBackground(initApplication(), "app activate");
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
