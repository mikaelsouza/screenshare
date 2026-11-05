/**
 * Automated Launch & Smoke Check Script for Screenshare Electron App
 *
 * Uses playwright-core to:
 * 1. Launch the Electron application.
 * 2. Wait for BrowserWindow load.
 * 3. Verify key DOM selectors (#display-name, #room-code, #share, #stage, #controls).
 * 4. Verify user interaction (input fields, action button states).
 * 5. Trap uncaught console and page runtime errors.
 * 6. Gracefully close the application.
 */

import { _electron as electron, type Page } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const GLOBAL_TIMEOUT_MS = 45000;

const REQUIRED_ELEMENTS = [
  { selector: "#display-name", name: "Display Name Input" },
  { selector: "#room-code", name: "Room Code Input" },
  { selector: "#share", name: "Share Screen Button" },
  { selector: "#stage", name: "Screen Share Stage" },
  { selector: "#controls", name: "Control Bar Container" },
] as const;

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

function buildSmokeEnv(): Record<string, string> {
  const envVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) envVars[key] = value;
  }
  envVars["ELECTRON_DEV"] = "0";
  envVars["NODE_ENV"] = "test";
  envVars["SMOKE_TEST"] = "1";
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
  console.log("[smoke-test] Verifying key DOM selectors...");
  for (const { selector, name } of REQUIRED_ELEMENTS) {
    console.log(`[smoke-test] - Checking ${selector} (${name})...`);
    await page.waitForSelector(selector, { state: "visible", timeout: 15000 });
    const isVisible = await page.isVisible(selector);
    if (!isVisible) {
      throw new Error(`Element ${selector} (${name}) is not visible.`);
    }
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

  await page.waitForSelector("#create", { state: "visible", timeout: 5000 });
  if (!(await page.isEnabled("#create"))) {
    throw new Error("#create button is unexpectedly disabled.");
  }
  if (!(await page.isEnabled("#share"))) {
    throw new Error("#share button is unexpectedly disabled.");
  }
}

function verifyNoFatalErrors(pageErrors: readonly string[], consoleErrors: readonly string[]): void {
  if (pageErrors.length > 0) {
    throw new Error(
      `Smoke test failed due to ${pageErrors.length} uncaught page error(s):\n${pageErrors.join("\n")}`,
    );
  }
  const fatalErrors = consoleErrors.filter((text) => !isBenignConsoleError(text));
  if (fatalErrors.length > 0) {
    throw new Error(
      `Smoke test failed due to ${fatalErrors.length} console error(s):\n${fatalErrors.join("\n")}`,
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

  const app = await electron.launch({
    cwd: projectRoot,
    args: ["."],
    ...(executablePath !== undefined ? { executablePath } : {}),
    env: buildSmokeEnv(),
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
    console.log("[smoke-test] Electron application closed cleanly.");
  }
}

async function runSmokeTest(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[smoke-test] FATAL: Global timeout of ${GLOBAL_TIMEOUT_MS}ms exceeded.`));
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
