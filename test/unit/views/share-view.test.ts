import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteController } from "@src/controllers/invite-controller";
import { SessionController } from "@src/controllers/session-controller";
import { TileController } from "@src/controllers/tile-controller";
import type { CaptureResult } from "@src/capture";
import type { Mesh } from "@src/mesh";
import type { CaptureController } from "@src/platform/types";
import type { SignalingClient } from "@src/signaling";
import type { UiElements } from "@src/views/dom";
import type { HealthPoller } from "@src/views/health-view";
import { ShareLifecycle, type ShareLifecycleContext } from "@src/views/share-view";
import type { TileView } from "@src/views/tile-view";

function makeFakeSvgNode() {
  return {
    setAttribute: vi.fn(),
    append: vi.fn(),
  };
}

function makeFakeCaptureResult(): CaptureResult {
  const video = { addEventListener: vi.fn(), readyState: "live" } as unknown as MediaStreamTrack;
  return {
    stream: {} as MediaStream,
    video,
    audio: null,
  };
}

function makeFakeShareSetup() {
  const stopCaptureController = vi.fn();
  const startCapture = vi.fn(async () => makeFakeCaptureResult());
  const captureController: CaptureController = {
    kind: "web",
    start: startCapture,
    setPreset: vi.fn(),
    stop: stopCaptureController,
  };

  const setCapture = vi.fn(async (): Promise<void> => {});
  const mesh = { setCapture } as unknown as Mesh;
  const setSharing = vi.fn();
  const client = { setSharing } as unknown as SignalingClient;

  const session = new SessionController({
    getLocalStorage: () => null,
    getSessionStorage: () => null,
    getLocks: () => null,
    runBackground: vi.fn(),
    onForgetHostUiChange: vi.fn(),
  });
  session.lastJoinCode = "ABCD1234";

  const muteBtn = {
    hidden: false,
    disabled: false,
    textContent: "",
    title: "",
    setAttribute: vi.fn(),
    replaceChildren: vi.fn(),
    classList: { toggle: vi.fn() },
  };
  const ui = {
    muteAudioBtn: muteBtn,
    presetSelect: { value: "1080p60" },
    status: { textContent: "" },
  } as unknown as UiElements;

  const clearOutbound = vi.fn();
  const renderSelfPreview = vi.fn();
  const syncViewState = vi.fn();
  const renderRoster = vi.fn();

  const ctx: ShareLifecycleContext = {
    ui,
    session,
    invite: new InviteController({ onChange: vi.fn() }),
    tileCtrl: new TileController(),
    tileView: { renderSelfPreview } as unknown as TileView,
    health: { clearOutbound } as unknown as HealthPoller,
    captureController,
    getClient: () => client,
    getMesh: () => mesh,
    closeAllPopovers: vi.fn(),
    setStatus: vi.fn(),
    syncViewState,
    renderRoster,
    runBackground: vi.fn(),
  };

  const share = new ShareLifecycle(ctx);
  return {
    share,
    session,
    startCapture,
    stopCaptureController,
    setCapture,
    setSharing,
    clearOutbound,
    renderSelfPreview,
    syncViewState,
    renderRoster,
  };
}

describe("ShareLifecycle.forceStop", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia: vi.fn() },
      userAgent: "Chrome",
      platform: "Win32",
    });
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("document", {
      createElementNS: () => makeFakeSvgNode(),
      createTextNode: (text: string) => ({ textContent: text }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a no-op when neither active nor pending", () => {
    const setup = makeFakeShareSetup();
    setup.share.forceStop();
    expect(setup.stopCaptureController).not.toHaveBeenCalled();
  });

  it("stops an active capture synchronously and clears state", async () => {
    const setup = makeFakeShareSetup();
    await setup.share.start();

    expect(setup.share.capture).not.toBeNull();
    setup.share.forceStop();
    expect(setup.stopCaptureController).toHaveBeenCalledTimes(1);
    expect(setup.share.capture).toBeNull();
  });

  it("stops a pending capture synchronously", async () => {
    const setup = makeFakeShareSetup();
    let rejectStart!: (err: unknown) => void;
    setup.startCapture.mockImplementationOnce(
      () =>
        new Promise<CaptureResult>((_resolve, reject) => {
          rejectStart = reject;
        }),
    );

    const startPromise = setup.share.start();
    expect(setup.share.isPending).toBe(true);

    setup.session.joinGeneration++;
    setup.share.forceStop();
    expect(setup.stopCaptureController).toHaveBeenCalledTimes(1);
    expect(setup.share.capture).toBeNull();

    rejectStart(new Error("aborted"));
    await startPromise;
  });

  it("avoids double-stopping or clobbering UI when forceStop preempts in-flight stop()", async () => {
    const setup = makeFakeShareSetup();
    await setup.share.start();

    setup.clearOutbound.mockClear();
    setup.renderSelfPreview.mockClear();
    setup.syncViewState.mockClear();
    setup.renderRoster.mockClear();
    setup.setSharing.mockClear();

    let resolveStopMesh!: () => void;
    setup.setCapture.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStopMesh = resolve;
        }),
    );

    const stopPromise = setup.share.stop();
    setup.share.forceStop();
    expect(setup.stopCaptureController).toHaveBeenCalledTimes(1);
    expect(setup.share.capture).toBeNull();

    resolveStopMesh();
    await stopPromise;

    expect(setup.stopCaptureController).toHaveBeenCalledTimes(1);
    expect(setup.clearOutbound).not.toHaveBeenCalled();
    expect(setup.renderSelfPreview).not.toHaveBeenCalled();
    expect(setup.syncViewState).not.toHaveBeenCalled();
    expect(setup.renderRoster).not.toHaveBeenCalled();
    expect(setup.setSharing).not.toHaveBeenCalled();
  });

  it("allows stopping a re-started capture while an older preempted stop() is still in flight", async () => {
    const setup = makeFakeShareSetup();
    await setup.share.start();

    let resolveFirstStop!: () => void;
    setup.setCapture.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirstStop = resolve;
        }),
    );

    const stop1 = setup.share.stop();
    setup.share.forceStop();

    await setup.share.start();
    expect(setup.share.capture).not.toBeNull();

    const stop2 = setup.share.stop();
    resolveFirstStop();
    await Promise.all([stop1, stop2]);

    expect(setup.share.capture).toBeNull();
    expect(setup.stopCaptureController).toHaveBeenCalledTimes(2);
  });

  it("aborts in-flight start() standalone when forceStop() runs without incrementing session.joinGeneration", async () => {
    const setup = makeFakeShareSetup();
    let resolveAcquire!: (res: CaptureResult) => void;
    setup.startCapture.mockImplementationOnce(
      () =>
        new Promise<CaptureResult>((resolve) => {
          resolveAcquire = resolve;
        }),
    );

    const startPromise = setup.share.start();
    setup.share.forceStop();
    resolveAcquire(makeFakeCaptureResult());
    await startPromise;

    expect(setup.share.capture).toBeNull();
    expect(setup.setCapture).not.toHaveBeenCalled();
    expect(setup.stopCaptureController).toHaveBeenCalledTimes(2);
  });

  it("cleans up mesh and UI when forceStop() runs while attachCapture awaits mesh.setCapture", async () => {
    const setup = makeFakeShareSetup();
    let resolveAttach!: () => void;
    setup.setCapture.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAttach = resolve;
        }),
    );

    const startPromise = setup.share.start();
    await vi.waitFor(() => {
      expect(setup.setCapture).toHaveBeenCalledTimes(1);
    });
    setup.share.forceStop();
    resolveAttach();
    await startPromise;

    expect(setup.share.capture).toBeNull();
    expect(setup.setCapture).toHaveBeenLastCalledWith(null);
    expect(setup.setSharing).toHaveBeenLastCalledWith(false);
  });
});
