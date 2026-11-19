import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REMOTE_APP_URL,
  resolveElectronConfig,
  resolveProcessElectronConfig,
} from "@electron/config";

describe("electron/config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ignores every environment and CLI override when app is packaged", () => {
    const cfg = resolveElectronConfig({
      isPackaged: true,
      env: {
        SCREENSHARE_URL: "https://evil.example/app",
        SMOKE_TEST: "1",
        SMOKE_USER_DATA_DIR: "/tmp/attacker-profile",
        ELECTRON_DEV: "1",
        NODE_ENV: "development",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      argv: ["Screenshare.exe", "--smoke-test"],
    });

    expect(cfg).toEqual({
      isDev: false,
      isSmokeTest: false,
      remoteAppUrl: DEFAULT_REMOTE_APP_URL,
      targetUrl: DEFAULT_REMOTE_APP_URL,
      allowedAppOrigin: "https://screenshare.webmikas.com",
      devServerUrl: undefined,
      smokeUserDataDir: undefined,
    });
  });

  it("returns production defaults when unpackaged with empty env and argv", () => {
    const cfg = resolveElectronConfig({
      isPackaged: false,
      env: {},
      argv: ["electron", "."],
    });

    expect(cfg).toEqual({
      isDev: false,
      isSmokeTest: false,
      remoteAppUrl: DEFAULT_REMOTE_APP_URL,
      targetUrl: DEFAULT_REMOTE_APP_URL,
      allowedAppOrigin: "https://screenshare.webmikas.com",
      devServerUrl: undefined,
      smokeUserDataDir: undefined,
    });
  });

  it("honors http/https SCREENSHARE_URL and SMOKE_USER_DATA_DIR when unpackaged in smoke mode", () => {
    const cfg = resolveElectronConfig({
      isPackaged: false,
      env: {
        SCREENSHARE_URL: "http://127.0.0.1:41234",
        SMOKE_TEST: "1",
        SMOKE_USER_DATA_DIR: "/tmp/screenshare-smoke-123",
      },
      argv: ["electron", "."],
    });

    expect(cfg.isDev).toBe(false);
    expect(cfg.isSmokeTest).toBe(true);
    expect(cfg.remoteAppUrl).toBe("http://127.0.0.1:41234/");
    expect(cfg.targetUrl).toBe("http://127.0.0.1:41234/");
    expect(cfg.allowedAppOrigin).toBe("http://127.0.0.1:41234");
    expect(cfg.devServerUrl).toBeUndefined();
    expect(cfg.smokeUserDataDir).toBe("/tmp/screenshare-smoke-123");
  });

  it("honors VITE_DEV_SERVER_URL only when dev mode is active", () => {
    const devCfg = resolveElectronConfig({
      isPackaged: false,
      env: {
        ELECTRON_DEV: "1",
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        SCREENSHARE_URL: "https://staging.example",
      },
      argv: [],
    });
    expect(devCfg.isDev).toBe(true);
    expect(devCfg.devServerUrl).toBe("http://localhost:5173/");
    expect(devCfg.targetUrl).toBe("http://localhost:5173/");
    expect(devCfg.allowedAppOrigin).toBe("http://localhost:5173");

    const nonDevCfg = resolveElectronConfig({
      isPackaged: false,
      env: {
        VITE_DEV_SERVER_URL: "http://localhost:5173",
      },
      argv: [],
    });
    expect(nonDevCfg.isDev).toBe(false);
    expect(nonDevCfg.devServerUrl).toBeUndefined();
    expect(nonDevCfg.targetUrl).toBe(DEFAULT_REMOTE_APP_URL);
  });

  it("rejects non-HTTP schemes, credentialed URLs, and malformed URLs cleanly", () => {
    const badUrls = [
      "",
      "   ",
      "not a url",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<h1>hi</h1>",
      "https://user:pass@screenshare.webmikas.com",
      "https://user@screenshare.webmikas.com",
      "http://:secret@127.0.0.1:5173",
    ];
    for (const bad of badUrls) {
      const cfg = resolveElectronConfig({
        isPackaged: false,
        env: {
          NODE_ENV: "development",
          SCREENSHARE_URL: bad,
          VITE_DEV_SERVER_URL: bad,
        },
        argv: [],
      });
      expect(cfg.remoteAppUrl).toBe(DEFAULT_REMOTE_APP_URL);
      expect(cfg.devServerUrl).toBeUndefined();
      expect(cfg.targetUrl).toBe(DEFAULT_REMOTE_APP_URL);
      expect(cfg.allowedAppOrigin).toBe("https://screenshare.webmikas.com");
    }
  });

  it("ignores SMOKE_USER_DATA_DIR unless smoke mode is active, and rejects blank or NUL paths", () => {
    const notSmoke = resolveElectronConfig({
      isPackaged: false,
      env: { SMOKE_USER_DATA_DIR: "/tmp/should-ignore" },
      argv: [],
    });
    expect(notSmoke.isSmokeTest).toBe(false);
    expect(notSmoke.smokeUserDataDir).toBeUndefined();

    const blankDir = resolveElectronConfig({
      isPackaged: false,
      env: { SMOKE_USER_DATA_DIR: "   " },
      argv: ["--smoke-test"],
    });
    expect(blankDir.isSmokeTest).toBe(true);
    expect(blankDir.smokeUserDataDir).toBeUndefined();

    const nulDir = resolveElectronConfig({
      isPackaged: false,
      env: { SMOKE_USER_DATA_DIR: "/tmp/bad\0dir" },
      argv: ["--smoke-test"],
    });
    expect(nulDir.smokeUserDataDir).toBeUndefined();
  });

  it("reads process.env through resolveProcessElectronConfig while still locking packaged builds", () => {
    vi.stubEnv("SCREENSHARE_URL", "http://127.0.0.1:8787");
    vi.stubEnv("SMOKE_TEST", "1");

    const unpackaged = resolveProcessElectronConfig(false);
    expect(unpackaged.isSmokeTest).toBe(true);
    expect(unpackaged.targetUrl).toBe("http://127.0.0.1:8787/");

    const packaged = resolveProcessElectronConfig(true);
    expect(packaged.isSmokeTest).toBe(false);
    expect(packaged.targetUrl).toBe(DEFAULT_REMOTE_APP_URL);
  });

  describe("adversarial trust-boundary probes", () => {
    it("rejects non-HTTP schemes and mixed-case non-HTTP schemes across both URL env vars", () => {
      const forbiddenSchemes = [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "file:///etc/passwd",
        "FILE:///C:/Windows/win.ini",
        "data:text/html,<script>alert(1)</script>",
        "Data:text/html,hi",
        "ws://127.0.0.1:8787",
        "WS://127.0.0.1:8787",
        "wss://screenshare.webmikas.com",
        "Wss://screenshare.webmikas.com",
        "ftp://evil.example/app",
        "FTP://evil.example/app",
        "about:blank",
        "About:srcdoc",
        "blob:https://screenshare.webmikas.com/550e8400-e29b-41d4-a716-446655440000",
        "BLOB:https://screenshare.webmikas.com/550e8400-e29b-41d4-a716-446655440000",
        "chrome://settings",
        "devtools://devtools/bundled/inspector.html",
      ];

      for (const candidate of forbiddenSchemes) {
        const cfg = resolveElectronConfig({
          isPackaged: false,
          env: {
            ELECTRON_DEV: "1",
            SCREENSHARE_URL: candidate,
            VITE_DEV_SERVER_URL: candidate,
          },
          argv: [],
        });
        expect({
          candidate,
          remoteAppUrl: cfg.remoteAppUrl,
          devServerUrl: cfg.devServerUrl,
          targetUrl: cfg.targetUrl,
          allowedAppOrigin: cfg.allowedAppOrigin,
        }).toEqual({
          candidate,
          remoteAppUrl: DEFAULT_REMOTE_APP_URL,
          devServerUrl: undefined,
          targetUrl: DEFAULT_REMOTE_APP_URL,
          allowedAppOrigin: "https://screenshare.webmikas.com",
        });
      }
    });

    it("normalizes mixed-case HTTP/HTTPS schemes to lowercase canonical origins", () => {
      const cfg = resolveElectronConfig({
        isPackaged: false,
        env: {
          ELECTRON_DEV: "1",
          SCREENSHARE_URL: "HtTpS://STAGING.EXAMPLE/app",
          VITE_DEV_SERVER_URL: "HTTP://127.0.0.1:5173/dev",
        },
        argv: [],
      });

      expect(cfg.remoteAppUrl).toBe("https://staging.example/app");
      expect(cfg.devServerUrl).toBe("http://127.0.0.1:5173/dev");
      expect(cfg.targetUrl).toBe("http://127.0.0.1:5173/dev");
      expect(cfg.allowedAppOrigin).toBe("http://127.0.0.1:5173");
    });

    it("rejects URLs with embedded credentials in any form", () => {
      const credentialedUrls = [
        "https://user:pass@screenshare.webmikas.com",
        "https://user@screenshare.webmikas.com",
        "http://:pass@127.0.0.1:5173",
        "https://user:@screenshare.webmikas.com",
        "https://%75ser:%70ass@screenshare.webmikas.com",
      ];

      for (const candidate of credentialedUrls) {
        const cfg = resolveElectronConfig({
          isPackaged: false,
          env: {
            ELECTRON_DEV: "1",
            SCREENSHARE_URL: candidate,
            VITE_DEV_SERVER_URL: candidate,
          },
          argv: [],
        });
        expect({
          candidate,
          remoteAppUrl: cfg.remoteAppUrl,
          devServerUrl: cfg.devServerUrl,
          targetUrl: cfg.targetUrl,
          allowedAppOrigin: cfg.allowedAppOrigin,
        }).toEqual({
          candidate,
          remoteAppUrl: DEFAULT_REMOTE_APP_URL,
          devServerUrl: undefined,
          targetUrl: DEFAULT_REMOTE_APP_URL,
          allowedAppOrigin: "https://screenshare.webmikas.com",
        });
      }
    });

    it("rejects URLs smuggling ASCII control characters or newlines instead of letting WHATWG URL strip/encode them", () => {
      const controlSmuggledUrls = [
        "ht\ttps://evil.example",
        "ht\ntps://evil.example",
        "ht\rtps://evil.example",
        "https://evil.example/\r\nX-Injected: 1",
        "https://evil.example/\npath",
        "https://evil.example\r\n",
        "\nhttp://127.0.0.1:5173",
        "\u0000https://evil.example",
        "https://evil.example/\u0000foo",
        "https://evil.example/\u001ffoo",
        "https://evil.example/\u007ffoo",
      ];

      for (const candidate of controlSmuggledUrls) {
        const cfg = resolveElectronConfig({
          isPackaged: false,
          env: {
            ELECTRON_DEV: "1",
            SCREENSHARE_URL: candidate,
            VITE_DEV_SERVER_URL: candidate,
          },
          argv: [],
        });
        expect({
          candidate,
          remoteAppUrl: cfg.remoteAppUrl,
          devServerUrl: cfg.devServerUrl,
          targetUrl: cfg.targetUrl,
          allowedAppOrigin: cfg.allowedAppOrigin,
        }).toEqual({
          candidate,
          remoteAppUrl: DEFAULT_REMOTE_APP_URL,
          devServerUrl: undefined,
          targetUrl: DEFAULT_REMOTE_APP_URL,
          allowedAppOrigin: "https://screenshare.webmikas.com",
        });
      }
    });

    it("rejects URLs containing backslashes that trigger WHATWG slash normalization or authority confusion", () => {
      const backslashUrls = [
        "https:\\\\evil.example\\app",
        "https://evil.example\\@screenshare.webmikas.com",
        "http://127.0.0.1:5173\\path",
        "https:/\\evil.example",
      ];

      for (const candidate of backslashUrls) {
        const cfg = resolveElectronConfig({
          isPackaged: false,
          env: {
            ELECTRON_DEV: "1",
            SCREENSHARE_URL: candidate,
            VITE_DEV_SERVER_URL: candidate,
          },
          argv: [],
        });
        expect({
          candidate,
          remoteAppUrl: cfg.remoteAppUrl,
          devServerUrl: cfg.devServerUrl,
          targetUrl: cfg.targetUrl,
          allowedAppOrigin: cfg.allowedAppOrigin,
        }).toEqual({
          candidate,
          remoteAppUrl: DEFAULT_REMOTE_APP_URL,
          devServerUrl: undefined,
          targetUrl: DEFAULT_REMOTE_APP_URL,
          allowedAppOrigin: "https://screenshare.webmikas.com",
        });
      }
    });

    it("blocks every individual override vector when isPackaged is true", () => {
      const vectors: Array<{
        name: string;
        env: Record<string, string | undefined>;
        argv: string[];
      }> = [
        { name: "SCREENSHARE_URL", env: { SCREENSHARE_URL: "http://127.0.0.1:9999" }, argv: [] },
        {
          name: "VITE_DEV_SERVER_URL + ELECTRON_DEV",
          env: { ELECTRON_DEV: "1", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" },
          argv: [],
        },
        {
          name: "VITE_DEV_SERVER_URL + NODE_ENV",
          env: { NODE_ENV: "development", VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" },
          argv: [],
        },
        {
          name: "SMOKE_TEST + SMOKE_USER_DATA_DIR",
          env: { SMOKE_TEST: "1", SMOKE_USER_DATA_DIR: "/tmp/pwn-profile" },
          argv: [],
        },
        {
          name: "--smoke-test argv + SMOKE_USER_DATA_DIR",
          env: { SMOKE_USER_DATA_DIR: "/tmp/pwn-profile" },
          argv: ["Screenshare.exe", "--smoke-test"],
        },
      ];

      for (const vector of vectors) {
        const cfg = resolveElectronConfig({
          isPackaged: true,
          env: vector.env,
          argv: vector.argv,
        });
        expect({ name: vector.name, cfg }).toEqual({
          name: vector.name,
          cfg: {
            isDev: false,
            isSmokeTest: false,
            remoteAppUrl: DEFAULT_REMOTE_APP_URL,
            targetUrl: DEFAULT_REMOTE_APP_URL,
            allowedAppOrigin: "https://screenshare.webmikas.com",
            devServerUrl: undefined,
            smokeUserDataDir: undefined,
          },
        });
      }
    });

    it("blocks process.argv --smoke-test and all env vars through resolveProcessElectronConfig(true)", () => {
      const originalArgv = process.argv;
      vi.stubEnv("SCREENSHARE_URL", "https://evil.example");
      vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5173");
      vi.stubEnv("ELECTRON_DEV", "1");
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("SMOKE_TEST", "1");
      vi.stubEnv("SMOKE_USER_DATA_DIR", "/tmp/attacker-dir");
      process.argv = [...originalArgv, "--smoke-test"];
      try {
        const packaged = resolveProcessElectronConfig(true);
        expect(packaged).toEqual({
          isDev: false,
          isSmokeTest: false,
          remoteAppUrl: DEFAULT_REMOTE_APP_URL,
          targetUrl: DEFAULT_REMOTE_APP_URL,
          allowedAppOrigin: "https://screenshare.webmikas.com",
          devServerUrl: undefined,
          smokeUserDataDir: undefined,
        });
      } finally {
        process.argv = originalArgv;
      }
    });

    it("cannot smuggle SMOKE_USER_DATA_DIR when isSmokeTest is false or VITE_DEV_SERVER_URL when isDev is false", () => {
      const devOnly = resolveElectronConfig({
        isPackaged: false,
        env: {
          ELECTRON_DEV: "1",
          NODE_ENV: "development",
          SMOKE_USER_DATA_DIR: "/tmp/should-not-apply-in-dev",
        },
        argv: ["electron", "."],
      });
      expect(devOnly.isDev).toBe(true);
      expect(devOnly.isSmokeTest).toBe(false);
      expect(devOnly.smokeUserDataDir).toBeUndefined();

      const smokeOnly = resolveElectronConfig({
        isPackaged: false,
        env: {
          SMOKE_TEST: "1",
          VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
        },
        argv: ["electron", ".", "--smoke-test"],
      });
      expect(smokeOnly.isSmokeTest).toBe(true);
      expect(smokeOnly.isDev).toBe(false);
      expect(smokeOnly.devServerUrl).toBeUndefined();
      expect(smokeOnly.targetUrl).toBe(DEFAULT_REMOTE_APP_URL);
      expect(smokeOnly.allowedAppOrigin).toBe("https://screenshare.webmikas.com");
    });

    it("enforces strict flag and env matching for argv --smoke-test, SMOKE_TEST, NODE_ENV, and ELECTRON_DEV", () => {
      const nonMatchingSmokeArgvs: string[][] = [
        ["electron", ".", "--smoke-test=1"],
        ["electron", ".", "--smoke-test=true"],
        ["electron", ".", "--SMOKE-TEST"],
        ["electron", ".", "-smoke-test"],
        ["electron", ".", "--smoke-test "],
      ];
      for (const argv of nonMatchingSmokeArgvs) {
        const cfg = resolveElectronConfig({
          isPackaged: false,
          env: { SMOKE_USER_DATA_DIR: "/tmp/ignored" },
          argv,
        });
        expect({
          argv,
          isSmokeTest: cfg.isSmokeTest,
          smokeUserDataDir: cfg.smokeUserDataDir,
        }).toEqual({
          argv,
          isSmokeTest: false,
          smokeUserDataDir: undefined,
        });
      }

      const matchingSmokeArgvs: string[][] = [
        ["--smoke-test"],
        ["electron", "--smoke-test", "."],
        ["electron", ".", "--inspect=0", "--smoke-test"],
      ];
      for (const argv of matchingSmokeArgvs) {
        const cfg = resolveElectronConfig({
          isPackaged: false,
          env: { SMOKE_USER_DATA_DIR: "/tmp/smoke-ok" },
          argv,
        });
        expect({
          argv,
          isSmokeTest: cfg.isSmokeTest,
          smokeUserDataDir: cfg.smokeUserDataDir,
        }).toEqual({
          argv,
          isSmokeTest: true,
          smokeUserDataDir: "/tmp/smoke-ok",
        });
      }

      for (const smokeVal of ["0", "2", "true", "TRUE", "yes", " 1", "1 "]) {
        const cfg = resolveElectronConfig({
          isPackaged: false,
          env: { SMOKE_TEST: smokeVal, SMOKE_USER_DATA_DIR: "/tmp/ignored" },
          argv: [],
        });
        expect({
          smokeVal,
          isSmokeTest: cfg.isSmokeTest,
          smokeUserDataDir: cfg.smokeUserDataDir,
        }).toEqual({
          smokeVal,
          isSmokeTest: false,
          smokeUserDataDir: undefined,
        });
      }

      for (const nodeEnv of ["DEVELOPMENT", "Development", "dev", "development ", " development"]) {
        const cfg = resolveElectronConfig({
          isPackaged: false,
          env: { NODE_ENV: nodeEnv, VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" },
          argv: [],
        });
        expect({
          nodeEnv,
          isDev: cfg.isDev,
          devServerUrl: cfg.devServerUrl,
          targetUrl: cfg.targetUrl,
        }).toEqual({
          nodeEnv,
          isDev: false,
          devServerUrl: undefined,
          targetUrl: DEFAULT_REMOTE_APP_URL,
        });
      }

      for (const devVal of ["0", "2", "true", "TRUE", "yes", " 1", "1 "]) {
        const cfg = resolveElectronConfig({
          isPackaged: false,
          env: { ELECTRON_DEV: devVal, VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" },
          argv: [],
        });
        expect({
          devVal,
          isDev: cfg.isDev,
          devServerUrl: cfg.devServerUrl,
          targetUrl: cfg.targetUrl,
        }).toEqual({
          devVal,
          isDev: false,
          devServerUrl: undefined,
          targetUrl: DEFAULT_REMOTE_APP_URL,
        });
      }
    });

    it("falls back from malformed VITE_DEV_SERVER_URL to valid SCREENSHARE_URL, or to default if both are invalid", () => {
      const fallbackToScreenshare = resolveElectronConfig({
        isPackaged: false,
        env: {
          ELECTRON_DEV: "1",
          VITE_DEV_SERVER_URL: "javascript:alert(1)",
          SCREENSHARE_URL: "http://127.0.0.1:8787/room",
        },
        argv: [],
      });
      expect(fallbackToScreenshare.isDev).toBe(true);
      expect(fallbackToScreenshare.devServerUrl).toBeUndefined();
      expect(fallbackToScreenshare.remoteAppUrl).toBe("http://127.0.0.1:8787/room");
      expect(fallbackToScreenshare.targetUrl).toBe("http://127.0.0.1:8787/room");
      expect(fallbackToScreenshare.allowedAppOrigin).toBe("http://127.0.0.1:8787");

      const fallbackToDefault = resolveElectronConfig({
        isPackaged: false,
        env: {
          NODE_ENV: "development",
          VITE_DEV_SERVER_URL: "not a url",
          SCREENSHARE_URL: "file:///etc/passwd",
        },
        argv: [],
      });
      expect(fallbackToDefault.isDev).toBe(true);
      expect(fallbackToDefault.devServerUrl).toBeUndefined();
      expect(fallbackToDefault.remoteAppUrl).toBe(DEFAULT_REMOTE_APP_URL);
      expect(fallbackToDefault.targetUrl).toBe(DEFAULT_REMOTE_APP_URL);
      expect(fallbackToDefault.allowedAppOrigin).toBe("https://screenshare.webmikas.com");
    });
  });
});

