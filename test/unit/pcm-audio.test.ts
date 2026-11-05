import { describe, expect, it, vi } from "vitest";
import {
  createPcmAudioTrack,
  deinterleavePcm16Stereo,
  StereoRingBuffer,
} from "@src/platform/pcm-audio";

function pcmBytesFromInt16(samples: number[]): Uint8Array {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return new Uint8Array(buf);
}

describe("deinterleavePcm16Stereo", () => {
  it("converts interleaved signed 16-bit LE stereo into planar Float32 channels", () => {
    const bytes = pcmBytesFromInt16([0, 16384, -32768, -16384]);
    const { left, right } = deinterleavePcm16Stereo(bytes);
    expect(Array.from(left)).toEqual([0, -1]);
    expect(Array.from(right)).toEqual([0.5, -0.5]);
  });

  it("honours a Uint8Array view with a non-zero byteOffset and ignores trailing odd bytes", () => {
    const raw = new Uint8Array(12);
    const sub = pcmBytesFromInt16([16384, -16384]);
    raw.set(sub, 2);
    // Slice of length 7 (1 full 4-byte stereo frame + 3 trailing bytes) starting at offset 2
    const sliced = new Uint8Array(raw.buffer, 2, 7);
    const { left, right } = deinterleavePcm16Stereo(sliced);
    expect(Array.from(left)).toEqual([0.5]);
    expect(Array.from(right)).toEqual([-0.5]);
  });
});

describe("StereoRingBuffer", () => {
  it("writes and reads stereo frames in FIFO order and zero-fills on underrun", () => {
    const ring = new StereoRingBuffer(4);
    ring.write(new Float32Array([0.1, 0.2]), new Float32Array([-0.1, -0.2]));

    const outL = [9, 9, 9] as unknown as Float32Array;
    const outR = [9, 9, 9] as unknown as Float32Array;
    ring.read(outL, outR);

    expect(outL).toHaveLength(3);
    expect(outR).toHaveLength(3);
    expect(outL[0]).toBeCloseTo(0.1);
    expect(outL[1]).toBeCloseTo(0.2);
    expect(outL[2]).toBe(0);
    expect(outR[0]).toBeCloseTo(-0.1);
    expect(outR[1]).toBeCloseTo(-0.2);
    expect(outR[2]).toBe(0);
  });

  it("wraps around capacity and drops the oldest frames on overflow", () => {
    const ring = new StereoRingBuffer(3);
    ring.write(new Float32Array([1, 2, 3]), new Float32Array([10, 20, 30]));
    // Writing 2 more frames into a capacity-3 buffer drops [1, 2] and keeps [3, 4, 5].
    ring.write(new Float32Array([4, 5]), new Float32Array([40, 50]));

    const outL = new Float32Array(3);
    const outR = new Float32Array(3);
    ring.read(outL, outR);
    expect(Array.from(outL)).toEqual([3, 4, 5]);
    expect(Array.from(outR)).toEqual([30, 40, 50]);

    // Buffer is now empty again; reading fills with 0.
    ring.read(outL, outR);
    expect(Array.from(outL)).toEqual([0, 0, 0]);
    expect(Array.from(outR)).toEqual([0, 0, 0]);
  });
});

describe("createPcmAudioTrack", () => {
  it("feeds incoming PCM packets into the ring buffer and tears down once", () => {
    let pcmListener: ((pcm: Uint8Array) => void) | null = null;
    const unsubscribe = vi.fn();
    const stopAudio = vi.fn();
    let capturedRing: StereoRingBuffer | null = null;
    let capturedTeardown: (() => void) | null = null;
    const fakeTrack = { kind: "audio" } as unknown as MediaStreamTrack;

    const track = createPcmAudioTrack(
      {
        onAudioPcm: (cb) => {
          pcmListener = cb;
          return unsubscribe;
        },
        stopAudio,
      },
      {
        createTrack: (ring, onTeardown) => {
          capturedRing = ring;
          capturedTeardown = onTeardown;
          return fakeTrack;
        },
      },
    );

    expect(track).toBe(fakeTrack);
    expect(capturedRing!.capacity).toBe(7200);

    pcmListener!(pcmBytesFromInt16([16384, -16384]));
    const outL = new Float32Array(1);
    const outR = new Float32Array(1);
    capturedRing!.read(outL, outR);
    expect(outL[0]).toBeCloseTo(0.5);
    expect(outR[0]).toBeCloseTo(-0.5);

    capturedTeardown!();
    capturedTeardown!();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(stopAudio).toHaveBeenCalledTimes(1);
  });

  it("does not call stopAudio when an older replaced PCM track is stopped after a newer one is created", () => {
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();
    const stopAudio = vi.fn();
    const teardowns: Array<() => void> = [];
    const bridge = {
      onAudioPcm: vi.fn().mockReturnValueOnce(unsub1).mockReturnValueOnce(unsub2),
      stopAudio,
    };
    const deps = {
      createTrack: (_ring: StereoRingBuffer, onTeardown: () => void) => {
        teardowns.push(onTeardown);
        return { kind: "audio" } as unknown as MediaStreamTrack;
      },
    };

    createPcmAudioTrack(bridge, deps);
    createPcmAudioTrack(bridge, deps);

    // Stopping the older track unsubscribes its listener but leaves main-process capture running.
    teardowns[0]!();
    expect(unsub1).toHaveBeenCalledTimes(1);
    expect(stopAudio).not.toHaveBeenCalled();

    // Stopping the newest track stops main-process capture.
    teardowns[1]!();
    expect(unsub2).toHaveBeenCalledTimes(1);
    expect(stopAudio).toHaveBeenCalledTimes(1);
  });
});
