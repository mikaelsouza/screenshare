import { describe, expect, it, vi } from "vitest";
import { createAudioSessionController } from "@electron/audio/capture.js";
import { createPidResolver, parseWindowHandle } from "@electron/audio/pid.js";

describe("parseWindowHandle", () => {
  it("extracts the numeric HWND from a desktopCapturer window source id", () => {
    expect(parseWindowHandle("window:131072:0")).toBe(131072);
    expect(parseWindowHandle("  window:9:12  ")).toBe(9);
  });

  it("rejects screens, zero handles and malformed source ids", () => {
    expect(parseWindowHandle("screen:0:0")).toBeNull();
    expect(parseWindowHandle("window:0:0")).toBeNull();
    expect(parseWindowHandle("window:0123:0")).toBeNull();
    expect(parseWindowHandle("window:123")).toBeNull();
    expect(parseWindowHandle("window:123:0:extra")).toBeNull();
    expect(parseWindowHandle("prefix-window:123:0")).toBeNull();
    expect(parseWindowHandle("window:123:0-suffix")).toBeNull();
    expect(parseWindowHandle("window:abc:0")).toBeNull();
    expect(parseWindowHandle("")).toBeNull();
  });
});

describe("createPidResolver", () => {
  it("looks up the PID for a valid window source id", () => {
    const lookup = vi.fn((hwnd: number) => (hwnd === 42 ? 1234 : 0));
    const resolve = createPidResolver(lookup);
    expect(resolve("window:42:0")).toBe(1234);
    expect(lookup).toHaveBeenCalledWith(42);
  });

  it("returns null for non-window ids or when the OS lookup returns 0 or negative", () => {
    const lookup = vi.fn((hwnd: number) => (hwnd === 1 ? 0 : -5));
    const resolve = createPidResolver(lookup);
    expect(resolve("screen:0:0")).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    expect(resolve("window:1:0")).toBeNull();
    expect(resolve("window:2:0")).toBeNull();
  });
});

describe("createAudioSessionController", () => {
  function setup() {
    const devices: Array<{
      start: ReturnType<typeof vi.fn>;
      startSystemAudio: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }> = [];
    const createCapture = vi.fn(() => {
      const dev = {
        start: vi.fn(),
        startSystemAudio: vi.fn(),
        stop: vi.fn(),
      };
      devices.push(dev);
      return dev;
    });
    const pidMap: Record<string, number> = {
      "window:10:0": 1000,
      "window:20:0": 2000,
      "window:21:0": 2000, // second window in same process
    };
    const resolvePid = vi.fn((id: string) => pidMap[id] ?? null);
    const sendPcm = vi.fn();
    const session = createAudioSessionController({
      createCapture,
      resolvePid,
      selfPid: 9999,
      sendPcm,
    });
    return { session, devices, createCapture, resolvePid, sendPcm };
  }

  it("starts per-window audio capture for the window's PID", () => {
    const { session, devices, sendPcm } = setup();
    expect(session.currentMode()).toBe("off");
    expect(session.startForWindow("window:10:0")).toBe(true);
    expect(session.currentMode()).toBe("window");
    expect(devices).toHaveLength(1);
    expect(devices[0]!.start).toHaveBeenCalledWith(1000, sendPcm);
  });

  it("does not restart capture when asked for the same window PID twice", () => {
    const { session, devices } = setup();
    expect(session.startForWindow("window:20:0")).toBe(true);
    expect(session.startForWindow("window:21:0")).toBe(true);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.stop).not.toHaveBeenCalled();
  });

  it("returns false and stays off when the window has no PID", () => {
    const { session, devices } = setup();
    expect(session.startForWindow("screen:0:0")).toBe(false);
    expect(session.currentMode()).toBe("off");
    expect(devices).toHaveLength(0);
  });

  it("starts system audio excluding the app's own PID", () => {
    const { session, devices, sendPcm } = setup();
    expect(session.startForSystem()).toBe(true);
    expect(session.currentMode()).toBe("system");
    expect(devices).toHaveLength(1);
    expect(devices[0]!.startSystemAudio).toHaveBeenCalledWith(sendPcm, 9999);
    // Calling startForSystem again while already in system mode is a no-op.
    expect(session.startForSystem()).toBe(true);
    expect(devices).toHaveLength(1);
  });

  it("stops the previous device when switching between window and system audio", () => {
    const { session, devices } = setup();
    session.startForWindow("window:10:0");
    session.startForSystem();
    expect(devices[0]!.stop).toHaveBeenCalledTimes(1);
    expect(devices).toHaveLength(2);
    expect(session.currentMode()).toBe("system");

    // Switching back to the same window PID must start a new device because mode was "system".
    session.startForWindow("window:10:0");
    expect(devices[1]!.stop).toHaveBeenCalledTimes(1);
    expect(devices).toHaveLength(3);
    expect(session.currentMode()).toBe("window");
  });

  it("switches the captured PID when a followed game moves between lobby and match", () => {
    const { session, devices, sendPcm } = setup();
    session.startForWindow("window:10:0");
    expect(session.switchWindow("window:20:0")).toBe(true);
    expect(devices[0]!.stop).toHaveBeenCalledTimes(1);
    expect(devices[1]!.start).toHaveBeenCalledWith(2000, sendPcm);
    expect(session.currentMode()).toBe("window");
  });

  it("does not switch audio when not in per-window mode", () => {
    const { session, devices } = setup();
    expect(session.switchWindow("window:10:0")).toBe(false);
    session.startForSystem();
    expect(session.switchWindow("window:10:0")).toBe(false);
    expect(devices).toHaveLength(1);
    expect(session.currentMode()).toBe("system");
  });

  it("resets state and returns false if starting window or system capture throws", () => {
    const { session, createCapture, devices } = setup();
    session.startForWindow("window:10:0");
    createCapture.mockImplementationOnce(() => ({
      start: vi.fn(() => { throw new Error("WASAPI error"); }),
      startSystemAudio: vi.fn(),
      stop: vi.fn(),
    }));
    expect(session.startForWindow("window:20:0")).toBe(false);
    expect(devices[0]!.stop).toHaveBeenCalledTimes(1);
    expect(session.currentMode()).toBe("off");
    // Because activePid was cleared on failure, starting window:20:0 now tries again.
    expect(session.startForWindow("window:20:0")).toBe(true);

    createCapture.mockImplementationOnce(() => ({
      start: vi.fn(),
      startSystemAudio: vi.fn(() => { throw new Error("WASAPI system error"); }),
      stop: vi.fn(),
    }));
    expect(session.startForSystem()).toBe(false);
    expect(session.currentMode()).toBe("off");
  });

  it("stops cleanly and ignores errors from device.stop()", () => {
    const { session, devices } = setup();
    session.startForWindow("window:10:0");
    devices[0]!.stop.mockImplementationOnce(() => { throw new Error("already stopped"); });
    expect(() => session.stop()).not.toThrow();
    expect(devices[0]!.stop).toHaveBeenCalledTimes(1);
    expect(session.currentMode()).toBe("off");
    // Subsequent startForWindow with same PID must create a fresh device after stop().
    session.startForWindow("window:10:0");
    expect(devices).toHaveLength(2);
  });
});
