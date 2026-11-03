// @ts-nocheck
// 
import { app, BrowserWindow, session, desktopCapturer, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalServer } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env.ELECTRON_DEV === '1' || process.env.NODE_ENV === 'development';
const isSmokeTest = process.argv.includes('--smoke-test') || process.env.SMOKE_TEST === '1';

// The app loads the hosted site so it shares rooms (signaling via the Cloudflare Worker /
// Durable Object) with browser users. The embedded server (server.js) keeps rooms in
// local memory only, so it's used just for dev (`electron:dev`) or when explicitly
// requested with SCREENSHARE_LOCAL=1 (offline/LAN testing, smoke test).
const REMOTE_APP_URL = process.env.SCREENSHARE_URL || 'https://screenshare.webmikas.com';
const useLocalServer = isDev || process.env.SCREENSHARE_LOCAL === '1';

let mainWindow = null;
let localServer = null;
// Origin of the page we load; capture permissions are only granted to it.
let trustedOrigin = null;

// Smoke tests use a throwaway profile so they neither collide with a running copy of the
// app (single-instance lock) nor touch its data.
if (isSmokeTest) {
  app.setPath('userData', path.join(app.getPath('temp'), `screenshare-smoke-${process.pid}`));
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another Screenshare/Electron instance (same userData dir) already holds the lock.
  // Without this message the app just exits silently, which looks like "it won't start".
  console.error(
    '[main] Another instance is already running (single-instance lock is held). ' +
      'Close it (check Task Manager for stray electron.exe processes) and try again.',
  );
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    setupMediaHandlers();
    await initApplication();
  });
}

function setupMediaHandlers() {
  // 1. Desktop capturer integration for navigator.mediaDevices.getDisplayMedia
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen', 'window'], fetchWindowIcons: true })
      .then((sources) => {
        if (!sources || sources.length === 0) {
          callback({});
          return;
        }

        // Prefer full screen display surface, fall back to first source
        const primaryScreen = sources.find((s) => s.id.startsWith('screen:'));
        const selectedSource = primaryScreen || sources[0];

        callback({
          video: selectedSource,
          audio: request.audioRequested ? 'loopback' : undefined,
        });
      })
      .catch((err) => {
        console.error('[main] setDisplayMediaRequestHandler error:', err);
        callback({});
      });
  });

  // 2. Permission request handler for display-capture & media (trusted origin only,
  //    since the app now loads remote content)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = permission === 'display-capture' || permission === 'media';
    callback(allowed && isTrustedUrl(details?.requestingUrl || webContents.getURL()));
  });

  // 3. Permission check handler
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const allowed = permission === 'display-capture' || permission === 'media';
    return allowed && isTrustedUrl(requestingOrigin || webContents?.getURL());
  });
}

function isTrustedUrl(url) {
  try {
    return Boolean(trustedOrigin) && new URL(url).origin === trustedOrigin;
  } catch {
    return false;
  }
}

async function resolveTargetUrl() {
  if (!useLocalServer) {
    return REMOTE_APP_URL;
  }
  // Start the embedded local HTTP + WS server.
  // In dev, the server must listen on the fixed port Vite proxies to (see vite.config.ts).
  if (!localServer) {
    const serverPort = isDev && process.env.ELECTRON_SERVER_PORT
      ? parseInt(process.env.ELECTRON_SERVER_PORT, 10)
      : undefined;
    localServer = await startLocalServer({ port: serverPort });
  }
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  return isDev && devServerUrl ? devServerUrl : localServer.url;
}

function offlinePage(url, description) {
  const html = `<!doctype html><meta charset="utf-8"><title>Screenshare</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#121214;color:#e6e6e6;font:15px system-ui,sans-serif">
<div style="text-align:center;max-width:460px">
<h2 style="font-weight:600">Can't reach Screenshare</h2>
<p>Couldn't load <b>${new URL(url).host}</b> (${description}).</p>
<p style="opacity:.7">Check your internet connection. Retrying automatically…</p>
</div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function initApplication() {
  const targetUrl = await resolveTargetUrl();
  trustedOrigin = new URL(targetUrl).origin;
  console.log(`[main] Loading ${targetUrl}`);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#121214',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!isSmokeTest) {
      mainWindow.show();
    }
  });

  // External links routing to default system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('mailto:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsedNav = new URL(url);
      const parsedTarget = new URL(targetUrl);
      if (parsedNav.origin !== parsedTarget.origin) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      // Invalid URL navigation attempt ignored
    }
  });

  // If the hosted site can't be reached (offline, DNS, TLS), show a message and retry
  // instead of leaving a blank window.
  let retryTimer = null;
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 = ERR_ABORTED (e.g. superseded navigation); not a real failure.
    if (!isMainFrame || errorCode === -3 || validatedURL.startsWith('data:')) return;
    console.error(`[main] Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
    mainWindow.loadURL(offlinePage(targetUrl, errorDescription)).catch(() => {});
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(targetUrl).catch(() => {});
      }
    }, 5000);
  });
  mainWindow.on('closed', () => {
    clearTimeout(retryTimer);
    mainWindow = null;
  });

  // Load failures are handled by 'did-fail-load' above.
  await mainWindow.loadURL(targetUrl).catch(() => {});
}

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await initApplication();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (localServer) {
    try {
      await localServer.close();
    } catch (err) {
      console.error('[main] Error closing local server:', err);
    }
    localServer = null;
  }
});
