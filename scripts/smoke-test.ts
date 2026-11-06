/**
 * Automated Launch & Smoke Check Script for Screenshare Electron App
 *
 * Uses playwright-core to:
 * 1. Launch the Electron application against a local static server serving dist/.
 * 2. Wait for BrowserWindow load.
 * 3. Verify key DOM selectors in Lobby state (#lobby, #display-name, #room-code, #create, #join) and 52px header.
 * 4. Verify user interaction (input fields, action button states).
 * 5. Trap uncaught console and page runtime errors.
 * 6. Gracefully close the application.
 */

import { _electron as electron, type Page } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");

const GLOBAL_TIMEOUT_MS = 45000;

const REQUIRED_ELEMENTS = [
  { selector: "#lobby", name: "Lobby Card" },
  { selector: "#display-name", name: "Display Name Input" },
  { selector: "#room-code", name: "Room Code Input" },
  { selector: "#create", name: "Create Room Button" },
  { selector: "#join", name: "Join Room Button" },
] as const;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

interface StaticServer {
  server: http.Server;
  url: string;
}

function startStaticDistServer(): Promise<StaticServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
      const relPath = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const filePath = path.join(distDir, relPath);
      if (!filePath.startsWith(distDir + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address format"));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${String(addr.port)}` });
    });
  });
}

async function resolveElectronPath(): Promise<string | undefined> {
  const fromEnv = process.env["ELECTRON_EXEC_PATH"];
  if (fromEnv) return fromEnv;
  try {
    const electronModule = (await import("electron")) as { default?: unknown };
    const candidate = electronModule.default ?? electronModule;
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function buildSmokeEnv(targetUrl: string): Record<string, string> {
  const envVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) envVars[key] = value;
  }
  envVars["ELECTRON_DEV"] = "0";
  envVars["NODE_ENV"] = "test";
  envVars["SMOKE_TEST"] = "1";
  envVars["SCREENSHARE_URL"] = targetUrl;
  return envVars;
}

function isBenignConsoleError(text: string): boolean {
  return (
    text.includes("favicon.ico") ||
    text.includes("stun:") ||
    text.startsWith("Refused to load the script") ||
    text.startsWith("Refused to execute inline script")
  );
}

async function verifyRequiredSelectors(page: Page): Promise<void> {
  console.log("[smoke-test] Verifying key DOM selectors in Lobby state...");
  for (const { selector, name } of REQUIRED_ELEMENTS) {
    console.log(`[smoke-test] - Checking ${selector} (${name})...`);
    await page.waitForSelector(selector, { state: "visible", timeout: 15000 });
    const isVisible = await page.isVisible(selector);
    if (!isVisible) {
      throw new Error(`Element ${selector} (${name}) is not visible.`);
    }
  }

  const layoutCheck = await page.evaluate(() => {
    const header = document.querySelector("header.app-bar");
    const roomBar = document.getElementById("room-bar");
    const stage = document.getElementById("stage");
    const controls = document.getElementById("controls");
    return {
      headerHeight: header ? Math.round(header.getBoundingClientRect().height) : 0,
      roomBarHidden: Boolean(roomBar?.hidden),
      stageHidden: Boolean(stage?.hidden),
      controlsHidden: Boolean(controls?.hidden),
    };
  });
  if (layoutCheck.headerHeight !== 52) {
    throw new Error(`Expected header.app-bar height to be 52px, got ${String(layoutCheck.headerHeight)}px`);
  }
  if (!layoutCheck.roomBarHidden || !layoutCheck.stageHidden || !layoutCheck.controlsHidden) {
    throw new Error(`Expected room elements to be hidden in Lobby state: ${JSON.stringify(layoutCheck)}`);
  }
}

async function verifyInputInteractions(page: Page): Promise<void> {
  console.log("[smoke-test] Testing UI input interactions...");

  await page.fill("#room-code", "SMOKETST");
  const enteredRoom = await page.inputValue("#room-code");
  if (enteredRoom !== "SMOKETST") {
    throw new Error(`Expected #room-code to contain "SMOKETST", got "${enteredRoom}"`);
  }
  await page.fill("#room-code", "");

  await page.fill("#display-name", "SmokeTester");
  const enteredName = await page.inputValue("#display-name");
  if (enteredName !== "SmokeTester") {
    throw new Error(`Expected #display-name to contain "SmokeTester", got "${enteredName}"`);
  }

  if (!(await page.isEnabled("#create"))) {
    throw new Error("#create button is unexpectedly disabled.");
  }
  if (!(await page.isEnabled("#join"))) {
    throw new Error("#join button is unexpectedly disabled.");
  }
}

function verifyNoFatalErrors(pageErrors: readonly string[], consoleErrors: readonly string[]): void {
  if (pageErrors.length > 0) {
    throw new Error(
      `Smoke test failed due to ${String(pageErrors.length)} uncaught page error(s):\n${pageErrors.join("\n")}`,
    );
  }
  const fatalErrors = consoleErrors.filter((text) => !isBenignConsoleError(text));
  if (fatalErrors.length > 0) {
    throw new Error(
      `Smoke test failed due to ${String(fatalErrors.length)} console error(s):\n${fatalErrors.join("\n")}`,
    );
  }
}

async function executeSmokeChecks(): Promise<void> {
  console.log("[smoke-test] ========================================");
  console.log("[smoke-test] Starting Electron Automated Smoke Check");
  console.log("[smoke-test] ========================================");

  const executablePath = await resolveElectronPath();
  console.log("[smoke-test] Launching Electron app with playwright-core...");
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const envUrl = process.env["SCREENSHARE_URL"];
  const localServer = envUrl ? null : await startStaticDistServer();
  const targetUrl = envUrl ?? localServer?.url ?? "http://127.0.0.1:8080";

  const app = await electron.launch({
    cwd: projectRoot,
    args: ["."],
    ...(executablePath !== undefined ? { executablePath } : {}),
    env: buildSmokeEnv(targetUrl),
  });
  console.log("[smoke-test] Electron process launched successfully.");

  try {
    console.log("[smoke-test] Waiting for BrowserWindow to open...");
    const page = await app.firstWindow();
    console.log("[smoke-test] BrowserWindow acquired.");

    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error") {
        console.error(`[smoke-test:browser-console-error] ${text}`);
        consoleErrors.push(text);
      } else {
        console.log(`[smoke-test:browser-console-${type}] ${text}`);
      }
    });

    page.on("pageerror", (err) => {
      const message = err.message || String(err);
      console.error(`[smoke-test:browser-page-error] ${message}`);
      pageErrors.push(message);
    });

    await page.waitForLoadState("domcontentloaded");
    console.log("[smoke-test] DOMContentLoaded event received.");

    const windowTitle = await page.title();
    console.log(`[smoke-test] Window title: "${windowTitle}"`);
    if (!windowTitle.toLowerCase().includes("screenshare")) {
      throw new Error(`Expected title to contain "Screenshare", but got: "${windowTitle}"`);
    }

    await verifyRequiredSelectors(page);
    await verifyInputInteractions(page);

    const preloadInfo = await page.evaluate(() => ({
      isElectron: Boolean(window.electronAPI?.isElectron),
      platform: window.electronAPI?.platform ?? null,
    }));
    console.log(
      `[smoke-test] Preload context check: isElectron=${String(preloadInfo.isElectron)}, platform=${String(preloadInfo.platform)}`,
    );

    verifyNoFatalErrors(pageErrors, consoleErrors);

    console.log("[smoke-test] ========================================");
    console.log("[smoke-test] ALL SMOKE CHECKS PASSED SUCCESSFULLY!");
    console.log("[smoke-test] ========================================");
  } finally {
    console.log("[smoke-test] Closing Electron application...");
    await app.close();
    if (localServer) {
      await new Promise<void>((r) => localServer.server.close(() => r()));
    }
    console.log("[smoke-test] Electron application closed cleanly.");
  }
}

async function runSmokeTest(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[smoke-test] FATAL: Global timeout of ${String(GLOBAL_TIMEOUT_MS)}ms exceeded.`));
    }, GLOBAL_TIMEOUT_MS);
    timer.unref();
  });

  try {
    await Promise.race([executeSmokeChecks(), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

await runSmokeTest();
