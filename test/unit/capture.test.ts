import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRESET,
  QUALITY_PRESETS,
  captureScreen,
  onCaptureEnded,
  stopCapture,
  systemAudioSupport,
  windowAudioSupport,
} from "@src/capture";

describe("QUALITY_PRESETS", () => {
  it("defines standard resolution and framerate presets", () => {
    expect(DEFAULT_PRESET).toBe("1080p60");
    expect(QUALITY_PRESETS["1080p60"]).toEqual({
      label: "1080p 60fps",
      width: 1920,
      height: 1080,
      frameRate: 60,
      maxBitrate: 12_000_000,
    });
    expect(QUALITY_PRESETS["1080p30"]).toEqual({
      label: "1080p 30fps",
      width: 1920,
      height: 1080,
      frameRate: 30,
      maxBitrate: 8_000_000,
    });
    expect(QUALITY_PRESETS["720p60"]).toEqual({
      label: "720p 60fps",
      width: 1280,
      height: 720,
      frameRate: 60,
      maxBitrate: 8_000_000,
    });
    expect(QUALITY_PRESETS["720p30"]).toEqual({
      label: "720p 30fps",
      width: 1280,
      height: 720,
      frameRate: 30,
      maxBitrate: 6_000_000,
    });
  });
});

describe("systemAudioSupport", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  });

  it("detects macOS platform via userAgentData even without Macintosh in userAgent", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 Chrome/150.0.0.0",
        userAgentData: { platform: "macOS" },
        platform: "Win32",
      },
      configurable: true,
      writable: true,
    });

    const res = systemAudioSupport();
    expect(res.supported).toBe(false);
    expect(res.reason).toBe(
      "On macOS, Chrome can only capture audio from a browser tab, not from a game or the system. " +
        "Your screen will share fine, but without game audio.",
    );
  });

  it("detects macOS platform via userAgent even when platform is not Mac", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      },
      configurable: true,
      writable: true,
    });

    const res = systemAudioSupport();
    expect(res.supported).toBe(false);
    expect(res.reason).toContain("without game audio.");
  });

  it("detects macOS platform via navigator.platform fallback when userAgentData.platform is undefined", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 Chrome/150.0.0.0",
        userAgentData: {},
        platform: "MacIntel",
      },
      configurable: true,
      writable: true,
    });

    const res = systemAudioSupport();
    expect(res.supported).toBe(false);
    expect(res.reason).toContain("macOS");
  });

  it("detects Linux platform", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0",
        userAgentData: { platform: "Linux" },
        platform: "Linux x86_64",
      },
      configurable: true,
      writable: true,
    });

    const res = systemAudioSupport();
    expect(res.supported).toBe(false);
    expect(res.reason).toBe(
      "On Linux, screen capture goes through PipeWire and system audio is usually unavailable. " +
        "Video will work; audio probably won't.",
    );
  });

  it("detects non-Chromium browsers", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
        userAgentData: { platform: "Windows" },
        platform: "Win32",
      },
      configurable: true,
      writable: true,
    });

    const res = systemAudioSupport();
    expect(res.supported).toBe(false);
    expect(res.reason).toBe("System audio capture requires Chrome or Edge on Windows.");
  });

  it("reports supported for Windows Chrome", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        userAgentData: { platform: "Windows" },
        platform: "Win32",
      },
      configurable: true,
      writable: true,
    });

    const res = systemAudioSupport();
    expect(res.supported).toBe(true);
    expect(res.reason).toBeUndefined();
  });
});

describe("windowAudioSupport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubUa(userAgent: string, platform = "Windows") {
    vi.stubGlobal("navigator", { userAgent, userAgentData: { platform }, platform: "Win32" });
  }

  it("supports Chrome 141 and newer on Windows", () => {
    stubUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36");
    expect(windowAudioSupport()).toEqual({ supported: true });
  });

  it("supports Edge, which carries Chromium's version, and rejects Edg without Chrome token", () => {
    stubUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0");
    expect(windowAudioSupport().supported).toBe(true);

    stubUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/150.0.0.0");
    expect(windowAudioSupport().supported).toBe(false);
  });

  it("asks older Chrome to update", () => {
    stubUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36");
    const res = windowAudioSupport();
    expect(res.supported).toBe(false);
    expect(res.reason).toBe(
      "Sharing only a game's audio needs Chrome or Edge 141 or newer. " +
        "Update your browser, or share your screen with system audio.",
    );
  });

  it("passes on the system-audio reason where there is no audio at all", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/150.0.0.0",
      userAgentData: { platform: "macOS" },
      platform: "MacIntel",
    });
    const res = windowAudioSupport();
    expect(res.supported).toBe(false);
    expect(res.reason).toContain("macOS");
  });
});

describe("captureScreen and track helpers", () => {
  function makeTrack(kind: "video" | "audio", settings: Record<string, unknown> | undefined = {}, label = "") {
    let endedHandler: (() => void) | null = null;
    let stopped = false;
    return {
      kind,
      label,
      enabled: true,
      contentHint: "",
      getSettings: () => settings,
      get stopped() { return stopped; },
      stop: () => { stopped = true; },
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "ended") endedHandler = handler;
      }),
      removeEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "ended" && endedHandler === handler) endedHandler = null;
      }),
      triggerEnded: () => { endedHandler?.(); },
    } as unknown as MediaStreamTrack & { stopped: boolean; triggerEnded: () => void; removeEventListener: ReturnType<typeof vi.fn> };
  }

  function makeStream(videoTrack: MediaStreamTrack | null, audioTrack: MediaStreamTrack | null) {
    const tracks: MediaStreamTrack[] = [];
    if (videoTrack) tracks.push(videoTrack);
    if (audioTrack) tracks.push(audioTrack);

    return {
      getVideoTracks: () => (videoTrack ? [videoTrack] : []),
      getAudioTracks: () => (audioTrack ? [audioTrack] : []),
      getTracks: () => tracks,
    } as unknown as MediaStream;
  }

  beforeEach(() => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getDisplayMedia: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("captures video and audio with appropriate content hints and gaming audio constraints", async () => {
    const vTrack = makeTrack("video");
    const aTrack = makeTrack("audio");
    const stream = makeStream(vTrack, aTrack);

    const getDisplayMediaMock = vi.fn().mockResolvedValue(stream);
    (navigator.mediaDevices as unknown as { getDisplayMedia: typeof getDisplayMediaMock }).getDisplayMedia =
      getDisplayMediaMock;

    const result = await captureScreen(QUALITY_PRESETS["1080p60"]);
    expect(result.stream).toBe(stream);
    expect(result.video).toBe(vTrack);
    expect(result.audio).toBe(aTrack);
    expect(vTrack.contentHint).toBe("motion");
    expect(aTrack.contentHint).toBe("music");

    const callArgs = getDisplayMediaMock.mock.calls[0]?.[0] as DisplayMediaStreamOptions;
    expect(callArgs.audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      restrictOwnAudio: true,
    });
    expect(callArgs.video).toMatchObject({ displaySurface: "window" });
    expect(callArgs).toMatchObject({
      windowAudio: "window",
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      monitorTypeSurfaces: "include",
      surfaceSwitching: "include",
    });
  });

  it("returns null audio when the user did not share audio in the picker", async () => {
    const vTrack = makeTrack("video");
    const stream = makeStream(vTrack, null);

    const getDisplayMediaMock = vi.fn().mockResolvedValue(stream);
    (navigator.mediaDevices as unknown as { getDisplayMedia: typeof getDisplayMediaMock }).getDisplayMedia =
      getDisplayMediaMock;

    const result = await captureScreen(QUALITY_PRESETS["720p30"]);
    expect(result.audio).toBeNull();
  });

  it("throws and stops tracks if getDisplayMedia returned no video track", async () => {
    const aTrack = makeTrack("audio");
    const stream = makeStream(null, aTrack);

    const getDisplayMediaMock = vi.fn().mockResolvedValue(stream);
    (navigator.mediaDevices as unknown as { getDisplayMedia: typeof getDisplayMediaMock }).getDisplayMedia =
      getDisplayMediaMock;

    await expect(captureScreen(QUALITY_PRESETS["1080p60"])).rejects.toThrow(
      "getDisplayMedia returned no video track",
    );
    expect((aTrack as unknown as { stopped: boolean }).stopped).toBe(true);
  });

  it("notifies when capture ended and allows unregistering", () => {
    const vTrack = makeTrack("video");
    const stream = makeStream(vTrack, null);
    const cb = vi.fn();

    const cleanup = onCaptureEnded({ stream, video: vTrack, audio: null }, cb);
    vTrack.triggerEnded();
    expect(cb).toHaveBeenCalledTimes(1);

    cleanup();
    expect(vTrack.removeEventListener).toHaveBeenCalled();
  });

  it("stops all tracks when stopCapture is called", () => {
    const vTrack = makeTrack("video") as unknown as MediaStreamTrack & { stopped: boolean };
    const aTrack = makeTrack("audio") as unknown as MediaStreamTrack & { stopped: boolean };
    const stream = makeStream(vTrack, aTrack);

    stopCapture({ stream, video: vTrack, audio: aTrack });
    expect(vTrack.stopped).toBe(true);
    expect(aTrack.stopped).toBe(true);
  });

  function stubGetDisplayMedia(stream: MediaStream) {
    const mock = vi.fn().mockResolvedValue(stream);
    (navigator.mediaDevices as unknown as { getDisplayMedia: typeof mock }).getDisplayMedia = mock;
    return mock;
  }

  it("reports which surface was picked across monitor, window, browser, and unknown", async () => {
    stubGetDisplayMedia(makeStream(makeTrack("video", { displaySurface: "monitor" }), null));
    expect((await captureScreen(QUALITY_PRESETS["1080p60"])).surface).toBe("monitor");

    stubGetDisplayMedia(makeStream(makeTrack("video", { displaySurface: "window" }), null));
    expect((await captureScreen(QUALITY_PRESETS["1080p60"])).surface).toBe("window");

    stubGetDisplayMedia(makeStream(makeTrack("video", { displaySurface: "browser" }), null));
    expect((await captureScreen(QUALITY_PRESETS["1080p60"])).surface).toBe("browser");

    stubGetDisplayMedia(makeStream(makeTrack("video", { displaySurface: "other" }), null));
    expect((await captureScreen(QUALITY_PRESETS["1080p60"])).surface).toBe("unknown");

    stubGetDisplayMedia(makeStream(makeTrack("video", {}), null));
    expect((await captureScreen(QUALITY_PRESETS["1080p60"])).surface).toBe("unknown");
  });
});
