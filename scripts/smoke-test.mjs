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
// @ts-nocheck

import { _electron as electron } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Safety global timeout (45 seconds) to prevent hanging CI/local runs
const GLOBAL_TIMEOUT_MS = 45000;
const globalTimer = setTimeout(() => {
  console.error(`[smoke-test] FATAL: Global timeout of ${GLOBAL_TIMEOUT_MS}ms exceeded. Aborting.`);
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);
globalTimer.unref();

async function runSmokeTest() {
  console.log('[smoke-test] ========================================');
  console.log('[smoke-test] Starting Electron Automated Smoke Check');
  console.log('[smoke-test] ========================================');

  // Resolve Electron executable path
  let executablePath = process.env.ELECTRON_EXEC_PATH;
  if (!executablePath) {
    try {
      const electronModule = await import('electron');
      executablePath = electronModule.default || electronModule;
    } catch {
      // Allow playwright-core to resolve from node_modules if import fails
    }
  }

  console.log('[smoke-test] Launching Electron app with playwright-core...');
  const consoleErrors = [];
  const pageErrors = [];

  const launchOptions = {
    cwd: projectRoot,
    args: ['.'],
    ...(typeof executablePath === 'string' ? { executablePath } : {}),
    env: {
      ...process.env,
      ELECTRON_DEV: '0',
      NODE_ENV: 'test',
      SMOKE_TEST: '1',
    },
  };

  const app = await electron.launch(launchOptions);
  console.log('[smoke-test] Electron process launched successfully.');

  try {
    console.log('[smoke-test] Waiting for BrowserWindow to open...');
    const window = await app.firstWindow();
    console.log('[smoke-test] BrowserWindow acquired.');

    window.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error') {
        console.error(`[smoke-test:browser-console-error] ${text}`);
        consoleErrors.push(text);
      } else {
        console.log(`[smoke-test:browser-console-${type}] ${text}`);
      }
    });

    window.on('pageerror', (err) => {
      const message = err.message || String(err);
      console.error(`[smoke-test:browser-page-error] ${message}`);
      pageErrors.push(message);
    });

    await window.waitForLoadState('domcontentloaded');
    console.log('[smoke-test] DOMContentLoaded event received.');

    const windowTitle = await window.title();
    console.log(`[smoke-test] Window title: "${windowTitle}"`);
    if (!windowTitle.toLowerCase().includes('screenshare')) {
      throw new Error(`Expected title to contain "Screenshare", but got: "${windowTitle}"`);
    }

    const requiredElements = [
      { selector: '#display-name', name: 'Display Name Input' },
      { selector: '#room-code', name: 'Room Code Input' },
      { selector: '#share', name: 'Share Screen Button' },
      { selector: '#stage', name: 'Screen Share Stage' },
      { selector: '#controls', name: 'Control Bar Container' },
    ];

    console.log('[smoke-test] Verifying key DOM selectors...');
    for (const { selector, name } of requiredElements) {
      console.log(`[smoke-test] - Checking ${selector} (${name})...`);
      await window.waitForSelector(selector, { state: 'visible', timeout: 15000 });
      const isVisible = await window.isVisible(selector);
      if (!isVisible) {
        throw new Error(`Element ${selector} (${name}) is not visible.`);
      }
    }

    console.log('[smoke-test] Testing UI input interactions...');

    await window.fill('#room-code', 'SMOKETST');
    const enteredRoom = await window.inputValue('#room-code');
    if (enteredRoom !== 'SMOKETST') {
      throw new Error(`Expected #room-code to contain "SMOKETST", got "${enteredRoom}"`);
    }
    await window.fill('#room-code', '');

    await window.fill('#display-name', 'SmokeTester');
    const enteredName = await window.inputValue('#display-name');
    if (enteredName !== 'SmokeTester') {
      throw new Error(`Expected #display-name to contain "SmokeTester", got "${enteredName}"`);
    }

    await window.waitForSelector('#create', { state: 'visible', timeout: 5000 });
    const isCreateEnabled = await window.isEnabled('#create');
    if (!isCreateEnabled) {
      throw new Error('#create button is unexpectedly disabled.');
    }

    const isShareEnabled = await window.isEnabled('#share');
    if (!isShareEnabled) {
      throw new Error('#share button is unexpectedly disabled.');
    }

    const preloadInfo = await window.evaluate(() => {
      return {
        isElectron: Boolean(window.electronAPI?.isElectron),
        platform: window.electronAPI?.platform || null,
      };
    });
    console.log(`[smoke-test] Preload context check: isElectron=${preloadInfo.isElectron}, platform=${preloadInfo.platform}`);

    if (pageErrors.length > 0) {
      throw new Error(`Smoke test failed due to ${pageErrors.length} uncaught page error(s):\n${pageErrors.join('\n')}`);
    }

    // Filter out benign external warnings
    const fatalErrors = consoleErrors.filter((text) => {
      if (text.includes('favicon.ico')) return false;
      if (text.includes('stun:')) return false;
      if (text.includes('stun.cloudflare.com')) return false;
      if (text.includes('cloudflareinsights.com')) return false;
      if (text.startsWith('Refused to execute inline script')) return false;
      return true;
    });

    if (fatalErrors.length > 0) {
      throw new Error(`Smoke test failed due to ${fatalErrors.length} console error(s):\n${fatalErrors.join('\n')}`);
    }

    console.log('[smoke-test] ========================================');
    console.log('[smoke-test] ALL SMOKE CHECKS PASSED SUCCESSFULLY!');
    console.log('[smoke-test] ========================================');
  } finally {
    console.log('[smoke-test] Closing Electron application...');
    await app.close();
    console.log('[smoke-test] Electron application closed cleanly.');
  }
}

runSmokeTest()
  .then(() => {
    console.log('[smoke-test] Exiting with code 0.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[smoke-test] SMOKE CHECK FAILED:');
    console.error(err);
    process.exit(1);
  });
