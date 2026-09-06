import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRESET,
  QUALITY_PRESETS,
  captureScreen,
  onCaptureEnded,
  stopCapture,
  systemAudioSupport,
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

describe("captureScreen and track helpers", () => {
  function makeTrack(kind: "video" | "audio") {
    let endedHandler: (() => void) | null = null;
    let stopped = false;
    return {
      kind,
      contentHint: "",
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

    const result = await captureScreen(QUALITY_PRESETS["1080p60"], true);
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
  });

  it("supports capture without audio when requested", async () => {
    const vTrack = makeTrack("video");
    const stream = makeStream(vTrack, null);

    const getDisplayMediaMock = vi.fn().mockResolvedValue(stream);
    (navigator.mediaDevices as unknown as { getDisplayMedia: typeof getDisplayMediaMock }).getDisplayMedia =
      getDisplayMediaMock;

    const result = await captureScreen(QUALITY_PRESETS["720p30"], false);
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

    await expect(captureScreen(QUALITY_PRESETS["1080p60"], true)).rejects.toThrow(
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
});
