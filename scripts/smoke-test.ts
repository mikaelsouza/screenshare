/**
 * Automated Launch & Smoke Check Script for Screenshare Electron App
 *
 * Uses playwright-core to:
 * 1. Launch the Electron application.
 * 2. Wait for BrowserWindow load.
 * 3. Verify key DOM selectors (#display-name, #room-code, #share, #stage, #controls).
 * 4. Verify user interaction (input fields, action button states).
 * 5. Trap uncaught console and page runtime errors.
 * 6. Gracefully close the application with exit code 0.
 */

import { _electron as electron } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {} from "../src/platform/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Safety global timeout (45 seconds) to prevent hanging CI/local runs
const GLOBAL_TIMEOUT_MS = 45000;
const globalTimer = setTimeout(() => {
  console.error(`[smoke-test] FATAL: Global timeout of ${String(GLOBAL_TIMEOUT_MS)}ms exceeded. Aborting.`);
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);
globalTimer.unref();

async function runSmokeTest(): Promise<void> {
  console.log("[smoke-test] ========================================");
  console.log("[smoke-test] Starting Electron Automated Smoke Check");
  console.log("[smoke-test] ========================================");

  // Resolve Electron executable path
  let executablePath: string | undefined = process.env["ELECTRON_EXEC_PATH"];
  if (!executablePath) {
    try {
      const electronModule = (await import("electron")) as unknown as { default?: unknown };
      const resolved = electronModule.default ?? electronModule;
      if (typeof resolved === "string") {
        executablePath = resolved;
      }
    } catch {
      // Allow playwright-core to resolve from node_modules if import fails
    }
  }

  console.log("[smoke-test] Launching Electron app with playwright-core...");
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const envVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      envVars[key] = value;
    }
  }
  envVars["ELECTRON_DEV"] = "0";
  envVars["NODE_ENV"] = "test";
  envVars["SMOKE_TEST"] = "1";

  const launchOptions = {
    cwd: projectRoot,
    args: ["."],
    ...(typeof executablePath === "string" ? { executablePath } : {}),
    env: envVars,
  };

  const app = await electron.launch(launchOptions);
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

    const requiredElements = [
      { selector: "#display-name", name: "Display Name Input" },
      { selector: "#room-code", name: "Room Code Input" },
      { selector: "#share", name: "Share Screen Button" },
      { selector: "#stage", name: "Screen Share Stage" },
      { selector: "#controls", name: "Control Bar Container" },
    ];

    console.log("[smoke-test] Verifying key DOM selectors...");
    for (const { selector, name } of requiredElements) {
      console.log(`[smoke-test] - Checking ${selector} (${name})...`);
      await page.waitForSelector(selector, { state: "visible", timeout: 15000 });
      const isVisible = await page.isVisible(selector);
      if (!isVisible) {
        throw new Error(`Element ${selector} (${name}) is not visible.`);
      }
    }

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
    const isCreateEnabled = await page.isEnabled("#create");
    if (!isCreateEnabled) {
      throw new Error("#create button is unexpectedly disabled.");
    }

    const isShareEnabled = await page.isEnabled("#share");
    if (!isShareEnabled) {
      throw new Error("#share button is unexpectedly disabled.");
    }

    const preloadInfo = await page.evaluate(() => {
      return {
        isElectron: Boolean(window.electronAPI?.isElectron),
        platform: window.electronAPI?.platform || null,
      };
    });
    console.log(
      `[smoke-test] Preload context check: isElectron=${String(preloadInfo.isElectron)}, platform=${String(preloadInfo.platform)}`,
    );

    if (pageErrors.length > 0) {
      throw new Error(
        `Smoke test failed due to ${String(pageErrors.length)} uncaught page error(s):\n${pageErrors.join("\n")}`,
      );
    }

    // Filter out benign external warnings
    const fatalErrors = consoleErrors.filter((text) => {
      if (text.includes("favicon.ico")) return false;
      if (text.includes("stun:")) return false;
      if (text.includes("stun.cloudflare.com")) return false;
      if (text.includes("cloudflareinsights.com")) return false;
      if (text.startsWith("Refused to execute inline script")) return false;
      return true;
    });

    if (fatalErrors.length > 0) {
      throw new Error(
        `Smoke test failed due to ${String(fatalErrors.length)} console error(s):\n${fatalErrors.join("\n")}`,
      );
    }

    console.log("[smoke-test] ========================================");
    console.log("[smoke-test] ALL SMOKE CHECKS PASSED SUCCESSFULLY!");
    console.log("[smoke-test] ========================================");
  } finally {
    console.log("[smoke-test] Closing Electron application...");
    await app.close();
    console.log("[smoke-test] Electron application closed cleanly.");
  }
}

runSmokeTest()
  .then(() => {
    console.log("[smoke-test] Exiting with code 0.");
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("[smoke-test] SMOKE CHECK FAILED:");
    console.error(err);
    process.exit(1);
  });
