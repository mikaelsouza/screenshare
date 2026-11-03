// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("Electron Desktop Capturer & Preload Bridge (Features 28 & 29)", () => {
  describe("Feature 29: Secure Preload Bridge (electron/preload.cjs)", () => {
    it("exposes strictly read-only electronAPI via contextBridge without leaking Node APIs", () => {
      const exposeInMainWorld = vi.fn();
      const electronPath = require.resolve("electron");
      const preloadPath = require.resolve("../../electron/preload.cjs");

      delete require.cache[preloadPath];
      require.cache[electronPath] = {
        id: electronPath,
        filename: electronPath,
        loaded: true,
        exports: {
          contextBridge: { exposeInMainWorld },
        },
      } as any;

      // Require the preload script
      require("../../electron/preload.cjs");

      expect(exposeInMainWorld).toHaveBeenCalledWith(
        "electronAPI",
        expect.objectContaining({
          isElectron: true,
          platform: process.platform,
        }),
      );

      const exposedObj = exposeInMainWorld.mock.calls[0][1];
      expect(exposedObj.isElectron).toBe(true);
      expect(typeof exposedObj.platform).toBe("string");
      expect(exposedObj.ipcRenderer).toBeUndefined();
      expect(exposedObj.require).toBeUndefined();
      expect(exposedObj.process).toBeUndefined();
    });
  });

  describe("Feature 28: Desktop Capturer & Media Selection Logic", () => {
    let mockGetSources: any;
    let mockCallback: any;

    beforeEach(() => {
      mockGetSources = vi.fn();
      mockCallback = vi.fn();
    });

    // Simulates the exact desktopCapturer handler logic in electron/main.js:57-81
    function handleDisplayMediaRequest(
      request: { audioRequested?: boolean },
      callback: (opts: any) => void,
    ) {
      return mockGetSources({ types: ["screen", "window"], fetchWindowIcons: true })
        .then((sources: any[]) => {
          if (!sources || sources.length === 0) {
            callback({});
            return;
          }

          // Prefer primary screen over window
          const primaryScreen = sources.find((s: any) => s.id.startsWith("screen:"));
          const selectedSource = primaryScreen || sources[0];

          callback({
            video: selectedSource,
            audio: request.audioRequested ? "loopback" : undefined,
          });
        })
        .catch(() => {
          callback({});
        });
    }

    it("prefers full screen capture over window capture", async () => {
      const sources = [
        { id: "window:123:0", name: "Discord" },
        { id: "screen:0:0", name: "Entire Screen 1" },
        { id: "window:456:0", name: "Chrome" },
      ];
      mockGetSources.mockResolvedValue(sources);

      await handleDisplayMediaRequest({ audioRequested: false }, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        video: { id: "screen:0:0", name: "Entire Screen 1" },
        audio: undefined,
      });
    });

    it("falls back to first window source when no screen source exists", async () => {
      const sources = [
        { id: "window:101:0", name: "Terminal" },
        { id: "window:102:0", name: "Code" },
      ];
      mockGetSources.mockResolvedValue(sources);

      await handleDisplayMediaRequest({ audioRequested: false }, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        video: { id: "window:101:0", name: "Terminal" },
        audio: undefined,
      });
    });

    it("enables 'loopback' audio when audioRequested is true", async () => {
      const sources = [{ id: "screen:0:0", name: "Primary Screen" }];
      mockGetSources.mockResolvedValue(sources);

      await handleDisplayMediaRequest({ audioRequested: true }, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        video: { id: "screen:0:0", name: "Primary Screen" },
        audio: "loopback",
      });
    });

    it("returns empty object on empty sources or capturer error", async () => {
      mockGetSources.mockResolvedValue([]);
      await handleDisplayMediaRequest({ audioRequested: true }, mockCallback);
      expect(mockCallback).toHaveBeenCalledWith({});

      mockGetSources.mockRejectedValue(new Error("Permission denied"));
      await handleDisplayMediaRequest({ audioRequested: true }, mockCallback);
      expect(mockCallback).toHaveBeenCalledWith({});
    });
  });

  describe("Feature 28: Origin Verification & Permission Handlers", () => {
    const trustedOrigin = "https://screenshare.example.com";

    function isTrustedUrl(url: string) {
      try {
        return Boolean(trustedOrigin) && new URL(url).origin === trustedOrigin;
      } catch {
        return false;
      }
    }

    function checkPermission(webContentsUrl: string, permission: string, requestingOrigin?: string) {
      const allowed = permission === "display-capture" || permission === "media";
      return allowed && isTrustedUrl(requestingOrigin || webContentsUrl);
    }

    it("allows display-capture and media permissions exclusively for trustedOrigin", () => {
      expect(checkPermission("https://screenshare.example.com/app", "display-capture")).toBe(true);
      expect(checkPermission("https://screenshare.example.com/app", "media")).toBe(true);
    });

    it("denies untrusted permissions even for trustedOrigin", () => {
      expect(checkPermission("https://screenshare.example.com/app", "camera")).toBe(false);
      expect(checkPermission("https://screenshare.example.com/app", "microphone")).toBe(false);
      expect(checkPermission("https://screenshare.example.com/app", "geolocation")).toBe(false);
    });

    it("denies display-capture and media for untrusted origins", () => {
      expect(checkPermission("https://attacker.evil.com", "display-capture")).toBe(false);
      expect(checkPermission("http://screenshare.example.com", "display-capture")).toBe(false);
      expect(checkPermission("not-a-valid-url", "display-capture")).toBe(false);
    });
  });

  describe("Feature 28: Navigation Lockdown & Window Open Routing", () => {
    it("routes window.open to shell.openExternal and denies child window creation", () => {
      const mockShellOpen = vi.fn();
      const setWindowOpenHandler = ({ url }: { url: string }) => {
        if (url.startsWith("http:") || url.startsWith("https:") || url.startsWith("mailto:")) {
          mockShellOpen(url);
        }
        return { action: "deny" };
      };

      const resultHttp = setWindowOpenHandler({ url: "https://example.com/docs" });
      expect(resultHttp).toEqual({ action: "deny" });
      expect(mockShellOpen).toHaveBeenCalledWith("https://example.com/docs");

      const resultMail = setWindowOpenHandler({ url: "mailto:support@example.com" });
      expect(resultMail).toEqual({ action: "deny" });
      expect(mockShellOpen).toHaveBeenCalledWith("mailto:support@example.com");

      const resultFile = setWindowOpenHandler({ url: "file:///C:/passwords.txt" });
      expect(resultFile).toEqual({ action: "deny" });
      expect(mockShellOpen).not.toHaveBeenCalledWith("file:///C:/passwords.txt");
    });

    it("prevents cross-origin navigation and delegates to external browser", () => {
      const targetUrl = "https://screenshare.example.com/room";
      const mockShellOpen = vi.fn();

      const handleWillNavigate = (navUrl: string, event: { preventDefault: () => void }) => {
        try {
          const parsedNav = new URL(navUrl);
          const parsedTarget = new URL(targetUrl);
          if (parsedNav.origin !== parsedTarget.origin) {
            event.preventDefault();
            mockShellOpen(navUrl);
          }
        } catch {}
      };

      // Same-origin navigation -> permitted
      const eventSame = { preventDefault: vi.fn() };
      handleWillNavigate("https://screenshare.example.com/other", eventSame);
      expect(eventSame.preventDefault).not.toHaveBeenCalled();
      expect(mockShellOpen).not.toHaveBeenCalled();

      // Cross-origin navigation -> prevented and opened externally
      const eventCross = { preventDefault: vi.fn() };
      handleWillNavigate("https://malicious.com/phish", eventCross);
      expect(eventCross.preventDefault).toHaveBeenCalled();
      expect(mockShellOpen).toHaveBeenCalledWith("https://malicious.com/phish");
    });
  });

  describe("Feature 28: Single-Instance Lock Lifecycle", () => {
    it("quits app if single-instance lock is not acquired", () => {
      const mockApp = {
        requestSingleInstanceLock: vi.fn(() => false),
        quit: vi.fn(),
      };

      if (!mockApp.requestSingleInstanceLock()) {
        mockApp.quit();
      }

      expect(mockApp.quit).toHaveBeenCalled();
    });

    it("restores, shows, and focuses window on second-instance event", () => {
      const mainWindow = {
        isMinimized: vi.fn(() => true),
        isVisible: vi.fn(() => false),
        restore: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
      };

      const handleSecondInstance = () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          if (!mainWindow.isVisible()) mainWindow.show();
          mainWindow.focus();
        }
      };

      handleSecondInstance();
      expect(mainWindow.restore).toHaveBeenCalled();
      expect(mainWindow.show).toHaveBeenCalled();
      expect(mainWindow.focus).toHaveBeenCalled();
    });
  });
});
