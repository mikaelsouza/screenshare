import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUALITY_PRESETS, type CaptureResult } from "@src/capture";
import { createCaptureController } from "@src/platform";
import { createElectronCaptureController, type ElectronCaptureDeps } from "@src/platform/electron";
import type { CaptureCallbacks, FollowUpdate } from "@src/platform/types";
import { createWebCaptureController } from "@src/platform/web";

type FakeTrack = MediaStreamTrack & { end(): void; stopped: boolean };

function track(kind: "video" | "audio", label: string = kind): FakeTrack {
  const listeners: Array<() => void> = [];
  const t = {
    kind,
    label,
    readyState: "live" as MediaStreamTrackState,
    stopped: false,
    contentHint: "",
    getSettings: () => ({}),
    addEventListener: (ev: string, fn: () => void) => { if (ev === "ended") listeners.push(fn); },
    removeEventListener: (ev: string, fn: () => void) => {
      const i = listeners.indexOf(fn);
      if (ev === "ended" && i !== -1) listeners.splice(i, 1);
    },
    stop() { t.stopped = true; t.readyState = "ended"; },
    end() { t.readyState = "ended"; for (const fn of [...listeners]) fn(); },
  };
  return t as unknown as FakeTrack;
}

function stream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    tracks,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  } as unknown as MediaStream;
}

function callbacks() {
  return {
    onEnded: vi.fn(),
    onVideoTrackSwapped: vi.fn(),
    onFollowState: vi.fn(),
  } satisfies CaptureCallbacks;
}

const preset = QUALITY_PRESETS["1080p60"];
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createCaptureController", () => {
  const cb = callbacks();

  it("uses web capture in a browser", () => {
    expect(createCaptureController(cb, undefined).kind).toBe("web");
  });

  it("uses web capture in an older desktop app without the follow bridge", () => {
    expect(createCaptureController(cb, { isElectron: true, platform: "win32", version: "35" }).kind).toBe("web");
    expect(
      createCaptureController(cb, { isElectron: true, platform: "win32", version: "35", onFollowUpdate: () => () => {} }).kind,
    ).toBe("web");
  });

  it("uses desktop capture when the bridge is there", () => {
    const api = { isElectron: true, platform: "win32", version: "35", onFollowUpdate: () => () => {}, stopFollow: () => {} };
    expect(createCaptureController(cb, api).kind).toBe("electron");
    expect(createCaptureController(cb, { ...api, isElectron: false }).kind).toBe("web");
  });

  it("hands the follow bridge to the desktop controller", async () => {
    const video = track("video");
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(stream([video])) } });
    const api = { isElectron: true, platform: "win32", version: "35", onFollowUpdate: vi.fn(() => () => {}), stopFollow: vi.fn() };
    const c = createCaptureController(callbacks(), api);
    await c.start(preset, "none");
    c.stop();
    expect(api.onFollowUpdate).toHaveBeenCalledTimes(1);
    expect(api.stopFollow).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("reads window.electronAPI by default", () => {
    vi.stubGlobal("window", { electronAPI: { isElectron: true, platform: "win32", version: "35", onFollowUpdate: () => () => {}, stopFollow: () => {} } });
    expect(createCaptureController(cb).kind).toBe("electron");
    vi.unstubAllGlobals();
  });
});

describe("web capture", () => {
  let video: FakeTrack;
  let audio: FakeTrack;

  beforeEach(() => {
    video = track("video");
    audio = track("audio");
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(stream([video, audio])) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("captures with the browser picker and ends with the source", async () => {
    const cb = callbacks();
    const c = createWebCaptureController(cb);
    const result = await c.start(preset, "app");
    expect(result.video).toBe(video);
    expect(result.audio).toBe(audio);
    video.end();
    expect(cb.onEnded).toHaveBeenCalledWith("source-closed");
  });

  it("stops every track and stops listening on stop", async () => {
    const cb = callbacks();
    const c = createWebCaptureController(cb);
    await c.start(preset, "app");
    c.setPreset(QUALITY_PRESETS["720p30"]);
    c.stop();
    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(true);
    video.end();
    expect(cb.onEnded).not.toHaveBeenCalled();
    c.stop(); // twice is harmless
  });

  it("passes on a cancelled picker", async () => {
    (navigator.mediaDevices.getDisplayMedia as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("NotAllowedError"));
    await expect(createWebCaptureController(callbacks()).start(preset, "app")).rejects.toThrow("NotAllowedError");
  });
});

describe("desktop capture", () => {
  let listener: ((u: FollowUpdate) => void) | null;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let api: {
    onFollowUpdate: ReturnType<typeof vi.fn<(cb: (u: FollowUpdate) => void) => () => void>>;
    stopFollow: ReturnType<typeof vi.fn<() => void>>;
  };
  let video: FakeTrack;
  let audio: FakeTrack;
  let deps: ElectronCaptureDeps & { captureSource: ReturnType<typeof vi.fn>; captureScreen: ReturnType<typeof vi.fn> };

  const update = (u: Partial<FollowUpdate>): FollowUpdate => ({
    role: "lobby",
    sourceId: "window:1:0",
    title: "League of Legends",
    profile: "League of Legends",
    ...u,
  });

  beforeEach(() => {
    listener = null;
    unsubscribe = vi.fn();
    api = {
      onFollowUpdate: vi.fn((cb: (u: FollowUpdate) => void) => { listener = cb; return unsubscribe as () => void; }),
      stopFollow: vi.fn<() => void>(),
    };
    video = track("video");
    audio = track("audio");
    deps = {
      captureScreen: vi.fn(async (): Promise<CaptureResult> => ({ stream: stream([video, audio]), video, audio, surface: "window" })),
      captureSource: vi.fn(async () => track("video", "swapped")),
      makeStream: (tracks) => stream(tracks),
      audioSource: async (capture) => capture.audio,
    };
  });

  function make(cb = callbacks()) {
    return { cb, c: createElectronCaptureController(api, cb, deps) };
  }

  it("works like the web when the picked window is not a game", async () => {
    const { cb, c } = make();
    const result = await c.start(preset, "system");
    expect(c.kind).toBe("electron");
    expect(deps.captureScreen).toHaveBeenCalledWith(preset, "system");
    expect(result.audio).toBe(audio);
    video.end();
    expect(cb.onEnded).toHaveBeenCalledWith("source-closed");
    expect(cb.onFollowState).not.toHaveBeenCalled();
  });

  it("adopts the picked window on the first update without re-capturing it", async () => {
    const { cb, c } = make();
    await c.start(preset, "app");
    listener!(update({}));
    expect(cb.onFollowState).toHaveBeenCalledWith({ role: "lobby", profile: "League of Legends", title: "League of Legends" });
    expect(deps.captureSource).not.toHaveBeenCalled();
    listener!(update({}));
    expect(deps.captureSource).not.toHaveBeenCalled();
  });

  it("keeps an update that arrives before the picker resolves", async () => {
    let resolve!: (r: CaptureResult) => void;
    deps.captureScreen.mockImplementation(() => new Promise<CaptureResult>((r) => { resolve = r; }));
    const { cb, c } = make();
    const started = c.start(preset, "app");
    listener!(update({}));
    expect(cb.onFollowState).not.toHaveBeenCalled();
    resolve({ stream: stream([video, audio]), video, audio });
    await started;
    expect(cb.onFollowState).toHaveBeenCalledWith(expect.objectContaining({ role: "lobby" }));
  });

  it("swaps to the game window, keeping the audio and the share", async () => {
    const { cb, c } = make();
    const result = await c.start(preset, "app");
    listener!(update({}));
    listener!(update({ role: "game", sourceId: "window:2:0", title: "League of Legends (TM) Client" }));
    await flush();

    expect(deps.captureSource).toHaveBeenCalledWith("window:2:0", preset);
    const swapped = deps.captureSource.mock.results[0]!.value as Promise<FakeTrack>;
    const newVideo = await swapped;
    expect(cb.onVideoTrackSwapped).toHaveBeenCalledWith(newVideo, result.stream);
    expect(result.video).toBe(newVideo);
    expect(result.audio).toBe(audio);
    expect(result.stream.getTracks()).toEqual([newVideo, audio]);
    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(false);
    expect(cb.onEnded).not.toHaveBeenCalled();
  });

  it("does not end the share when the followed window closes", async () => {
    const { cb, c } = make();
    await c.start(preset, "app");
    listener!(update({}));
    video.end();
    listener!(update({ role: "waiting", sourceId: null, title: null }));
    await flush();
    expect(cb.onEnded).not.toHaveBeenCalled();
    expect(deps.captureSource).not.toHaveBeenCalled();
    expect(cb.onFollowState).toHaveBeenLastCalledWith({ role: "waiting", profile: "League of Legends", title: null });
  });

  it("re-captures a window whose track ended, even with the same id", async () => {
    const { c } = make();
    await c.start(preset, "app");
    listener!(update({}));
    video.end();
    listener!(update({}));
    await flush();
    expect(deps.captureSource).toHaveBeenCalledWith("window:1:0", preset);
  });

  it("re-captures when the very first update finds the picked window already gone", async () => {
    const { c } = make();
    await c.start(preset, "app");
    (video as { readyState: MediaStreamTrackState }).readyState = "ended";
    listener!(update({}));
    await flush();
    expect(deps.captureSource).toHaveBeenCalledTimes(1);
  });

  it("uses the latest preset for windows captured later", async () => {
    const { c } = make();
    await c.start(preset, "app");
    c.setPreset(QUALITY_PRESETS["720p30"]);
    listener!(update({}));
    listener!(update({ role: "game", sourceId: "window:2:0" }));
    await flush();
    expect(deps.captureSource).toHaveBeenCalledWith("window:2:0", QUALITY_PRESETS["720p30"]);
  });

  it("ends the share when the follow ends", async () => {
    const { cb, c } = make();
    await c.start(preset, "app");
    listener!(update({}));
    listener!(update({ role: "ended", sourceId: null, title: null }));
    expect(cb.onFollowState).toHaveBeenLastCalledWith(null);
    expect(cb.onEnded).toHaveBeenCalledWith("follow-ended");
    // The page then stops the share; the follow state is not cleared twice.
    c.stop();
    expect(cb.onFollowState.mock.calls.filter(([s]) => s === null)).toHaveLength(1);
  });

  it("ignores the source ending once the share has stopped", async () => {
    const { cb, c } = make();
    await c.start(preset, "app");
    c.stop();
    video.end();
    expect(cb.onEnded).not.toHaveBeenCalled();
  });

  it("tolerates stop before start and stop twice", async () => {
    const { c } = make();
    expect(() => c.stop()).not.toThrow();
    await c.start(preset, "app");
    c.stop();
    expect(() => c.stop()).not.toThrow();
  });

  it("starts a second share fresh after a followed one", async () => {
    const { cb, c } = make();
    await c.start(preset, "app");
    listener!(update({}));
    c.stop();

    const video2 = track("video");
    deps.captureScreen.mockResolvedValue({ stream: stream([video2]), video: video2, audio: null });
    await c.start(preset, "app");
    // Not following any more: the window closing ends this share as on the web.
    video2.end();
    expect(cb.onEnded).toHaveBeenCalledWith("source-closed");
  });

  it("never lets a capture from a stopped share land in the next one", async () => {
    const resolvers: Array<(t: MediaStreamTrack) => void> = [];
    deps.captureSource.mockImplementation(() => new Promise<MediaStreamTrack>((r) => resolvers.push(r)));
    const { cb, c } = make();
    await c.start(preset, "app");
    listener!(update({}));
    listener!(update({ role: "game", sourceId: "window:2:0" }));
    c.stop();

    const video2 = track("video");
    deps.captureScreen.mockResolvedValue({ stream: stream([video2]), video: video2, audio: null });
    const second = await c.start(preset, "app");
    listener!(update({ sourceId: "window:5:0" }));
    listener!(update({ role: "game", sourceId: "window:6:0" }));

    const stale = track("video");
    resolvers[0]!(stale);
    await flush();
    expect(stale.stopped).toBe(true);
    expect(second.video).toBe(video2);

    const fresh = track("video");
    resolvers[1]!(fresh);
    await flush();
    expect(second.video).toBe(fresh);
    expect(cb.onVideoTrackSwapped).toHaveBeenCalledTimes(1);
  });

  it("keeps the current window if capturing the next one fails", async () => {
    deps.captureSource.mockRejectedValue(new Error("gone"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { cb, c } = make();
    const result = await c.start(preset, "app");
    listener!(update({}));
    listener!(update({ role: "game", sourceId: "window:2:0" }));
    await flush();
    expect(result.video).toBe(video);
    expect(cb.onVideoTrackSwapped).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("drops a capture that finishes after the share stopped", async () => {
    let resolve!: (t: MediaStreamTrack) => void;
    deps.captureSource.mockImplementation(() => new Promise<MediaStreamTrack>((r) => { resolve = r; }));
    const { cb, c } = make();
    await c.start(preset, "app");
    listener!(update({}));
    listener!(update({ role: "game", sourceId: "window:2:0" }));
    c.stop();
    const late = track("video");
    resolve(late);
    await flush();
    expect(late.stopped).toBe(true);
    expect(cb.onVideoTrackSwapped).not.toHaveBeenCalled();
  });

  it("only acts on the newest of two overlapping swaps", async () => {
    const resolvers: Array<(t: MediaStreamTrack) => void> = [];
    deps.captureSource.mockImplementation(() => new Promise<MediaStreamTrack>((r) => resolvers.push(r)));
    const { cb, c } = make();
    const result = await c.start(preset, "app");
    listener!(update({}));
    listener!(update({ role: "game", sourceId: "window:2:0" }));
    listener!(update({ role: "lobby", sourceId: "window:3:0" }));
    const first = track("video");
    const second = track("video");
    resolvers[1]!(second);
    resolvers[0]!(first);
    await flush();
    expect(first.stopped).toBe(true);
    expect(result.video).toBe(second);
    expect(cb.onVideoTrackSwapped).toHaveBeenCalledTimes(1);
  });

  it("ignores the old track ending after a swap", async () => {
    const { cb, c } = make();
    await c.start(preset, "app");
    listener!(update({}));
    listener!(update({ role: "game", sourceId: "window:2:0" }));
    await flush();
    video.end();
    expect(cb.onEnded).not.toHaveBeenCalled();
  });

  it("stops the follow, the tracks and the subscription on stop", async () => {
    const { cb, c } = make();
    await c.start(preset, "app");
    listener!(update({}));
    c.stop();
    expect(api.stopFollow).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(true);
    expect(cb.onFollowState).toHaveBeenLastCalledWith(null);
  });

  it("does not report a follow state on stop when none was active", async () => {
    const { cb, c } = make();
    await c.start(preset, "app");
    c.stop();
    expect(cb.onFollowState).not.toHaveBeenCalled();
  });

  it("ignores updates after stop", async () => {
    const { cb, c } = make();
    await c.start(preset, "app");
    c.stop();
    listener!(update({}));
    expect(cb.onFollowState).not.toHaveBeenCalled();
  });

  it("unsubscribes and rethrows when the picker is cancelled", async () => {
    deps.captureScreen.mockRejectedValue(new Error("cancelled"));
    const { cb, c } = make();
    await expect(c.start(preset, "app")).rejects.toThrow("cancelled");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    listener!(update({}));
    expect(cb.onFollowState).not.toHaveBeenCalled();
  });

  it("lets an audio provider choose the audio track", async () => {
    const other = track("audio", "per-app");
    deps.audioSource = vi.fn(async () => other);
    const { c } = make();
    const result = await c.start(preset, "app");
    expect(deps.audioSource).toHaveBeenCalledWith(expect.objectContaining({ video }), "app");
    expect(result.audio).toBe(other);
  });

  it("keeps a share with no audio silent across a swap", async () => {
    deps.captureScreen.mockResolvedValue({ stream: stream([video]), video, audio: null });
    const { c } = make();
    const result = await c.start(preset, "none");
    listener!(update({}));
    listener!(update({ role: "game", sourceId: "window:2:0" }));
    await flush();
    expect(result.stream.getTracks()).toHaveLength(1);
    expect(result.stream.getAudioTracks()).toEqual([]);
  });
});

describe("desktop capture defaults", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("captures a desktop source by id with Electron's constraints", async () => {
    const swapped = track("video");
    const getUserMedia = vi.fn().mockResolvedValue(stream([swapped]));
    const video = track("video");
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia: vi.fn().mockResolvedValue(stream([video])), getUserMedia },
    });
    vi.stubGlobal("MediaStream", class { constructor(readonly t: MediaStreamTrack[]) {} getTracks() { return this.t; } });
    const audio = track("audio");
    (navigator.mediaDevices.getDisplayMedia as ReturnType<typeof vi.fn>).mockResolvedValue(stream([video, audio]));
    let listener: ((u: FollowUpdate) => void) | null = null;
    const cb = callbacks();
    const c = createElectronCaptureController(
      { onFollowUpdate: (fn) => { listener = fn; return () => {}; }, stopFollow: () => {} },
      cb,
    );
    const result = await c.start(preset, "system");
    // By default the audio is whatever came with the capture.
    expect(result.audio).toBe(audio);
    const send = listener as unknown as (u: FollowUpdate) => void;
    send({ role: "lobby", sourceId: "window:1:0", title: "a", profile: "P" });
    send({ role: "game", sourceId: "window:2:0", title: "b", profile: "P" });
    await flush();

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: "window:2:0",
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 60,
        },
      },
    });
    expect(swapped.contentHint).toBe("motion");
    expect(cb.onVideoTrackSwapped).toHaveBeenCalledWith(swapped, expect.anything());
  });

  it("releases a desktop capture that came back without video", async () => {
    const stray = track("audio");
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getDisplayMedia: vi.fn().mockResolvedValue(stream([track("video")])),
        getUserMedia: vi.fn().mockResolvedValue(stream([stray])),
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let listener: ((u: FollowUpdate) => void) | null = null;
    const c = createElectronCaptureController(
      { onFollowUpdate: (fn) => { listener = fn; return () => {}; }, stopFollow: () => {} },
      callbacks(),
    );
    await c.start(preset, "none");
    const send = listener as unknown as (u: FollowUpdate) => void;
    send({ role: "lobby", sourceId: "window:1:0", title: "a", profile: "P" });
    send({ role: "game", sourceId: "window:2:0", title: "b", profile: "P" });
    await flush();
    expect(stray.stopped).toBe(true);
    expect(warn.mock.calls[0]?.[0]).toContain("window:2:0");
    expect(String(warn.mock.calls[0]?.[1])).toContain("no video track for source window:2:0");
    warn.mockRestore();
  });
});
