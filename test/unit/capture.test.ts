import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRESET,
  QUALITY_PRESETS,
  captureAudioOnly,
  captureScreen,
  onCaptureEnded,
  stopAudioSource,
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
      maxBitrate: 8_000_000,
    });
    expect(QUALITY_PRESETS["720p60"]).toEqual({
      label: "720p 60fps",
      width: 1280,
      height: 720,
      frameRate: 60,
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

  it("detects macOS platform via userAgentData", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0",
        userAgentData: { platform: "macOS" },
        platform: "MacIntel",
      },
      configurable: true,
      writable: true,
    });

    const res = systemAudioSupport();
    expect(res.supported).toBe(false);
    expect(res.reason).toContain("macOS");
  });

  it("detects macOS platform via navigator.platform fallback", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
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
    expect(res.reason).toContain("Linux");
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
    expect(res.reason).toContain("requires Chrome or Edge");
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

  it("supports Edge, which carries Chromium's version", () => {
    stubUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0");
    expect(windowAudioSupport().supported).toBe(true);
  });

  it("asks older Chrome to update", () => {
    stubUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36");
    const res = windowAudioSupport();
    expect(res.supported).toBe(false);
    expect(res.reason).toContain("141");
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
  function makeTrack(kind: "video" | "audio", settings: Record<string, unknown> = {}, label = "") {
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
    } as unknown as MediaStreamTrack & { stopped: boolean; triggerEnded: () => void };
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

    const result = await captureScreen(QUALITY_PRESETS["1080p60"], "app");
    expect(result.stream).toBe(stream);
    expect(result.video).toBe(vTrack);
    expect(result.audio).toBe(aTrack);
    expect(vTrack.contentHint).toBe("motion");
    expect(aTrack.contentHint).toBe("music");

    const callArgs = getDisplayMediaMock.mock.calls[0]?.[0];
    expect(callArgs.audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    // The picker opens on windows, not the whole screen.
    expect(callArgs.video).toMatchObject({ displaySurface: "window" });
  });

  it("supports capture without audio when requested", async () => {
    const vTrack = makeTrack("video");
    const stream = makeStream(vTrack, null);

    const getDisplayMediaMock = vi.fn().mockResolvedValue(stream);
    (navigator.mediaDevices as unknown as { getDisplayMedia: typeof getDisplayMediaMock }).getDisplayMedia =
      getDisplayMediaMock;

    const result = await captureScreen(QUALITY_PRESETS["720p30"], "none");
    expect(result.audio).toBeNull();
    const callArgs = getDisplayMediaMock.mock.calls[0]?.[0];
    expect(callArgs.audio).toBe(false);
  });

  it("throws and stops tracks if getDisplayMedia returned no video track", async () => {
    const aTrack = makeTrack("audio");
    const stream = makeStream(null, aTrack);

    const getDisplayMediaMock = vi.fn().mockResolvedValue(stream);
    (navigator.mediaDevices as unknown as { getDisplayMedia: typeof getDisplayMediaMock }).getDisplayMedia =
      getDisplayMediaMock;

    await expect(captureScreen(QUALITY_PRESETS["1080p60"], "app")).rejects.toThrow(
      "getDisplayMedia returned no video track",
    );
    expect((aTrack as unknown as { stopped: boolean }).stopped).toBe(true);
  });

  it("notifies when capture ended and allows unregistering", () => {
    const vTrack = makeTrack("video") as unknown as MediaStreamTrack & { triggerEnded: () => void };
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

  it("asks for only the window's audio in app mode, and no system audio for screens", async () => {
    const mock = stubGetDisplayMedia(makeStream(makeTrack("video"), null));
    await captureScreen(QUALITY_PRESETS["1080p60"], "app");
    expect(mock.mock.calls[0]?.[0]).toMatchObject({ windowAudio: "window", systemAudio: "exclude" });
  });

  it("offers system audio for screens and windows in system mode", async () => {
    const mock = stubGetDisplayMedia(makeStream(makeTrack("video"), null));
    await captureScreen(QUALITY_PRESETS["1080p60"], "system");
    expect(mock.mock.calls[0]?.[0]).toMatchObject({ windowAudio: "system", systemAudio: "include" });
  });

  it("reports which surface was picked", async () => {
    stubGetDisplayMedia(makeStream(makeTrack("video", { displaySurface: "monitor" }), null));
    const result = await captureScreen(QUALITY_PRESETS["1080p60"], "app");
    expect(result.surface).toBe("monitor");
  });

  it("captures a window's audio alone and keeps its thumbnail running but disabled", async () => {
    const video = makeTrack("video", {}, "League of Legends (TM) Client");
    const audio = makeTrack("audio");
    const mock = stubGetDisplayMedia(makeStream(video, audio));

    const source = await captureAudioOnly("window");
    expect(mock.mock.calls[0]?.[0]).toMatchObject({
      video: { displaySurface: "window" },
      monitorTypeSurfaces: "exclude",
      windowAudio: "window",
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    expect(source?.track).toBe(audio);
    expect(source?.kind).toBe("window");
    expect(source?.label).toBe("League of Legends (TM) Client");
    expect(audio.contentHint).toBe("music");
    expect(video.enabled).toBe(false);
    expect((video as unknown as { stopped: boolean }).stopped).toBe(false);

    stopAudioSource(source!);
    expect((video as unknown as { stopped: boolean }).stopped).toBe(true);
    expect((audio as unknown as { stopped: boolean }).stopped).toBe(true);
  });

  it("hides Chrome's opaque window ids instead of showing them as a name", async () => {
    stubGetDisplayMedia(makeStream(makeTrack("video", {}, "window:1234:0"), makeTrack("audio")));
    const source = await captureAudioOnly("window");
    expect(source?.label).toBeNull();
  });

  it("asks for a screen with system audio for the system fallback", async () => {
    const mock = stubGetDisplayMedia(makeStream(makeTrack("video"), makeTrack("audio")));
    const source = await captureAudioOnly("system");
    expect(mock.mock.calls[0]?.[0]).toMatchObject({ video: { displaySurface: "monitor" }, systemAudio: "include" });
    expect(source?.kind).toBe("system");
  });

  it("returns null and releases the capture when the pick had no audio", async () => {
    const video = makeTrack("video");
    stubGetDisplayMedia(makeStream(video, null));
    expect(await captureAudioOnly("window")).toBeNull();
    expect((video as unknown as { stopped: boolean }).stopped).toBe(true);
  });
});
