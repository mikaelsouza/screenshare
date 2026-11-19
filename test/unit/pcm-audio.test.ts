import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createPcmAudioTrack,
  deinterleavePcm16Stereo,
  type PcmTrackDeps,
  type PcmWorkletTrackHandle,
} from "@src/platform/pcm-audio";
import {
  PCM_RING_CAPACITY_FRAMES,
  PCM_WORKLET_PROCESSOR_NAME,
  PcmRingProcessor,
  StereoRingBuffer,
} from "@src/platform/pcm-ring-worklet";

function pcmBytesFromInt16(samples: number[]): Uint8Array {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return new Uint8Array(buf);
}

describe("deinterleavePcm16Stereo", () => {
  it("converts interleaved signed 16-bit LE stereo into planar Float32 channels including Int16 extremes", () => {
    const bytes = pcmBytesFromInt16([0, 16384, -32768, 32767]);
    const { left, right } = deinterleavePcm16Stereo(bytes);
    expect(Array.from(left)).toEqual([0, -1]);
    expect(right[0]).toBeCloseTo(0.5);
    expect(right[1]).toBeCloseTo(32767 / 32768);
  });

  it("honours a Uint8Array view with a non-zero byteOffset and ignores trailing odd bytes", () => {
    const raw = new Uint8Array(13);
    const sub = pcmBytesFromInt16([16384, -16384]);
    raw.set(sub, 3);
    // Odd byteOffset (3) and length 7 (1 full 4-byte stereo frame + 3 trailing bytes)
    const sliced = new Uint8Array(raw.buffer, 3, 7);
    const { left, right } = deinterleavePcm16Stereo(sliced);
    expect(Array.from(left)).toEqual([0.5]);
    expect(Array.from(right)).toEqual([-0.5]);
  });

  it("returns empty arrays for sub-frame inputs (< 4 bytes)", () => {
    for (const len of [0, 1, 2, 3]) {
      const { left, right } = deinterleavePcm16Stereo(new Uint8Array(len));
      expect(left).toHaveLength(0);
      expect(right).toHaveLength(0);
    }
  });
});

describe("StereoRingBuffer", () => {
  it("rejects non-positive or non-integer capacities", () => {
    expect(() => new StereoRingBuffer(0)).toThrow(RangeError);
    expect(() => new StereoRingBuffer(-4)).toThrow(RangeError);
    expect(() => new StereoRingBuffer(1.5)).toThrow(RangeError);
  });

  it("writes and reads stereo frames in FIFO order and zero-fills on underrun", () => {
    const ring = new StereoRingBuffer(4);
    ring.write(new Float32Array([0.1, 0.2]), new Float32Array([-0.1, -0.2]));
    expect(ring.length).toBe(2);

    const outL = new Float32Array([9, 9, 9]);
    const outR = new Float32Array([9, 9, 9]);
    ring.read(outL, outR);

    expect(ring.length).toBe(0);
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
    expect(ring.length).toBe(3);

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

  it("clamps mismatched left/right channel lengths safely", () => {
    const ring = new StereoRingBuffer(4);
    ring.write(new Float32Array([1, 2, 3]), new Float32Array([10]));
    expect(ring.length).toBe(1);

    const outL = new Float32Array(2);
    const outR = new Float32Array(1);
    ring.read(outL, outR);
    expect(outL[0]).toBe(1);
    expect(outR[0]).toBe(10);
  });
});

describe("PcmRingProcessor", () => {
  it("uses a 400 ms (19,200-frame) stereo ring buffer capacity by default", () => {
    expect(PCM_WORKLET_PROCESSOR_NAME).toBe("pcm-ring-processor");
    expect(PCM_RING_CAPACITY_FRAMES).toBe(19_200);

    const processor = new PcmRingProcessor();
    const chunk = new Float32Array(20_000).fill(0.25);
    processor.handleMessage({ type: "pcm", left: chunk, right: chunk });
    expect(processor.bufferedFrames).toBe(19_200);
  });

  it("renders multi-quantum 128-frame stereo audio across ring wraparound and zero-fills underruns", () => {
    const processor = new PcmRingProcessor(200);
    const firstL = Float32Array.from({ length: 160 }, (_, i) => i + 1);
    const firstR = Float32Array.from({ length: 160 }, (_, i) => -(i + 1));
    processor.handleMessage({ type: "pcm", left: firstL, right: firstR });

    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    expect(processor.process([], [[outL, outR]])).toBe(true);
    expect(outL[0]).toBe(1);
    expect(outL[127]).toBe(128);
    expect(outR[0]).toBe(-1);
    expect(outR[127]).toBe(-128);
    expect(processor.bufferedFrames).toBe(32);

    // Push another 120 frames (wraps past 200 without overflowing since 32 + 120 = 152 <= 200)
    const secondL = Float32Array.from({ length: 120 }, (_, i) => 1000 + i);
    const secondR = Float32Array.from({ length: 120 }, (_, i) => -(1000 + i));
    processor.handleMessage({ type: "pcm", left: secondL, right: secondR });

    expect(processor.process([], [[outL, outR]])).toBe(true);
    expect(outL[0]).toBe(129);
    expect(outL[31]).toBe(160);
    expect(outL[32]).toBe(1000);
    expect(outL[127]).toBe(1095);
    expect(processor.bufferedFrames).toBe(24);

    // Third quantum drains remaining 24 frames and zero-fills the remaining 104 frames
    expect(processor.process([], [[outL, outR]])).toBe(true);
    expect(outL[0]).toBe(1096);
    expect(outL[23]).toBe(1119);
    expect(outL[24]).toBe(0);
    expect(outR[127]).toBe(0);
  });

  it("ignores malformed messages and handles empty or mono outputs safely", () => {
    const processor = new PcmRingProcessor(16);
    processor.handleMessage(null);
    processor.handleMessage("bad");
    processor.handleMessage({ type: 123 });
    processor.handleMessage({ type: "unknown" });
    processor.handleMessage({ type: "pcm", left: [1, 2], right: [3, 4] });
    expect(processor.bufferedFrames).toBe(0);

    // Empty outputs array or empty channel list keeps processor alive
    expect(processor.process([], [])).toBe(true);
    expect(processor.process([], [[]])).toBe(true);

    // Mono output channel advances ring safely
    processor.handleMessage({ type: "pcm", left: new Float32Array([0.5, 0.25]), right: new Float32Array([-0.5, -0.25]) });
    const mono = new Float32Array(2);
    expect(processor.process([], [[mono]])).toBe(true);
    expect(Array.from(mono)).toEqual([0.5, 0.25]);
    expect(processor.bufferedFrames).toBe(0);
  });

  it("zero-fills output, returns false, and ignores further PCM after dispose", () => {
    const processor = new PcmRingProcessor(16);
    processor.handleMessage({ type: "pcm", left: new Float32Array([1, 1]), right: new Float32Array([1, 1]) });
    processor.handleMessage({ type: "dispose" });
    const framesAfterDispose = processor.bufferedFrames;
    processor.handleMessage({ type: "pcm", left: new Float32Array([2, 2]), right: new Float32Array([2, 2]) });
    expect(processor.bufferedFrames).toBe(framesAfterDispose);

    const outL = new Float32Array([9, 9]);
    const outR = new Float32Array([9, 9]);
    expect(processor.process([], [[outL, outR]])).toBe(false);
    expect(Array.from(outL)).toEqual([0, 0]);
    expect(Array.from(outR)).toEqual([0, 0]);
    expect(processor.process([], [])).toBe(false);
  });
});

describe("createPcmAudioTrack", () => {
  it("loads a same-origin worklet URL, forwards deinterleaved PCM to the worklet sink, and tears down once", async () => {
    let pcmListener: ((pcm: Uint8Array) => void) | null = null;
    const unsubscribe = vi.fn();
    const stopAudio = vi.fn();
    const dispose = vi.fn();
    const processor = new PcmRingProcessor(64);
    let capturedUrl = "";
    let capturedTeardown: (() => void) | null = null;
    const fakeTrack = { kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack;

    const track = await createPcmAudioTrack(
      {
        onAudioPcm: (cb) => {
          pcmListener = cb;
          return unsubscribe;
        },
        stopAudio,
      },
      {
        createTrack: async (workletUrl, onTeardown) => {
          capturedUrl = workletUrl;
          capturedTeardown = onTeardown;
          return {
            track: fakeTrack,
            sink: {
              postPcm: (left, right) => processor.handleMessage({ type: "pcm", left, right }),
              dispose: () => {
                dispose();
                processor.handleMessage({ type: "dispose" });
              },
            },
          };
        },
      },
    );

    expect(track).toBe(fakeTrack);
    expect(capturedUrl.length).toBeGreaterThan(0);
    expect(capturedUrl.startsWith("blob:")).toBe(false);
    expect(capturedUrl.startsWith("data:")).toBe(false);
    const appOrigin = "https://screenshare.example";
    expect(new URL(capturedUrl, `${appOrigin}/`).origin).toBe(appOrigin);

    // Sub-frame (< 4 bytes) packet is skipped
    pcmListener!(new Uint8Array([1, 2, 3]));
    expect(processor.bufferedFrames).toBe(0);

    pcmListener!(pcmBytesFromInt16([16384, -16384]));
    const outL = new Float32Array(1);
    const outR = new Float32Array(1);
    expect(processor.process([], [[outL, outR]])).toBe(true);
    expect(outL[0]).toBeCloseTo(0.5);
    expect(outR[0]).toBeCloseTo(-0.5);

    capturedTeardown!();
    capturedTeardown!();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stopAudio).toHaveBeenCalledTimes(1);

    // Post-teardown PCM packets are ignored
    pcmListener!(pcmBytesFromInt16([16384, -16384]));
    expect(processor.process([], [[outL, outR]])).toBe(false);
  });

  it("rolls back worklet sink and track when bridge.onAudioPcm throws synchronously", async () => {
    const stopAudio = vi.fn();
    const dispose = vi.fn();
    const stopTrack = vi.fn();
    const fakeTrack = { kind: "audio", stop: stopTrack } as unknown as MediaStreamTrack;

    await expect(
      createPcmAudioTrack(
        {
          onAudioPcm: () => {
            throw new Error("IPC registration failed");
          },
          stopAudio,
        },
        {
          createTrack: async () => ({
            track: fakeTrack,
            sink: { postPcm: vi.fn(), dispose },
          }),
        },
      ),
    ).rejects.toThrow("IPC registration failed");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(stopAudio).toHaveBeenCalledTimes(1);
  });

  it("does not call stopAudio when an older replaced PCM track is stopped after a newer one is created", async () => {
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();
    const stopAudio = vi.fn();
    const teardowns: Array<() => void> = [];
    const disposes = [vi.fn(), vi.fn()];
    const bridge = {
      onAudioPcm: vi.fn().mockReturnValueOnce(unsub1).mockReturnValueOnce(unsub2),
      stopAudio,
    };
    let idx = 0;
    const deps: PcmTrackDeps = {
      createTrack: async (_url, onTeardown) => {
        const myIdx = idx++;
        teardowns.push(onTeardown);
        return {
          track: { kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack,
          sink: { postPcm: vi.fn(), dispose: disposes[myIdx]! },
        };
      },
    };

    await createPcmAudioTrack(bridge, deps);
    await createPcmAudioTrack(bridge, deps);

    // Stopping the older track unsubscribes and disposes its worklet but leaves main-process capture running.
    teardowns[0]!();
    expect(unsub1).toHaveBeenCalledTimes(1);
    expect(disposes[0]).toHaveBeenCalledTimes(1);
    expect(stopAudio).not.toHaveBeenCalled();

    // Stopping the newest track stops main-process capture.
    teardowns[1]!();
    expect(unsub2).toHaveBeenCalledTimes(1);
    expect(disposes[1]).toHaveBeenCalledTimes(1);
    expect(stopAudio).toHaveBeenCalledTimes(1);
  });

  it("cleans up when createTrack rejects and when teardown runs mid-addModule", async () => {
    const stopAudio = vi.fn();
    const onAudioPcm = vi.fn(() => vi.fn());

    // Case 1: createTrack rejects -> calls stopAudio and propagates error
    await expect(
      createPcmAudioTrack(
        { onAudioPcm, stopAudio },
        { createTrack: async () => { throw new Error("addModule failed"); } },
      ),
    ).rejects.toThrow("addModule failed");
    expect(stopAudio).toHaveBeenCalledTimes(1);
    expect(onAudioPcm).not.toHaveBeenCalled();

    // Case 2: teardown triggered while createTrack is still pending -> disposes handle immediately on resolve
    stopAudio.mockClear();
    let resolveTrack!: (handle: PcmWorkletTrackHandle) => void;
    let pendingTeardown!: () => void;
    const pendingPromise = createPcmAudioTrack(
      { onAudioPcm, stopAudio },
      {
        createTrack: (_url, onTeardown) => {
          pendingTeardown = onTeardown;
          return new Promise<PcmWorkletTrackHandle>((resolve) => {
            resolveTrack = resolve;
          });
        },
      },
    );

    pendingTeardown();
    const lateStop = vi.fn();
    const lateDispose = vi.fn();
    resolveTrack({
      track: { kind: "audio", stop: lateStop } as unknown as MediaStreamTrack,
      sink: { postPcm: vi.fn(), dispose: lateDispose },
    });

    await pendingPromise;
    expect(stopAudio).toHaveBeenCalledTimes(1);
    expect(lateDispose).toHaveBeenCalledTimes(1);
    expect(lateStop).toHaveBeenCalledTimes(1);
    expect(onAudioPcm).not.toHaveBeenCalled();
  });

  it("swallows synchronous postPcm and dispose errors without crashing the IPC listener", async () => {
    let pcmListener: ((pcm: Uint8Array) => void) | null = null;
    let teardown!: () => void;
    await createPcmAudioTrack(
      {
        onAudioPcm: (cb) => {
          pcmListener = cb;
          return () => {};
        },
        stopAudio: vi.fn(),
      },
      {
        createTrack: async (_url, onTeardown) => {
          teardown = onTeardown;
          return {
            track: { kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack,
            sink: {
              postPcm: () => { throw new Error("port closed"); },
              dispose: () => { throw new Error("already closed"); },
            },
          };
        },
      },
    );

    expect(() => pcmListener!(pcmBytesFromInt16([1000, -1000]))).not.toThrow();
    expect(() => teardown()).not.toThrow();
  });
});

describe("adversarial PCM audio edge cases & invariants", () => {
  it("handles misaligned byteOffsets (1, 2, 3, 5) and byteLengths (0..7) on a shared oversized ArrayBuffer", () => {
    const backing = new Uint8Array(64).fill(0x7f);
    // Single stereo frame: L = +16384 (0x00, 0x40), R = -16384 (0x00, 0xc0)
    const frameBytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xaa, 0xbb, 0xcc]);

    for (const byteOffset of [1, 2, 3, 5]) {
      backing.fill(0x7f);
      backing.set(frameBytes, byteOffset);

      for (const byteLength of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const view = new Uint8Array(backing.buffer, byteOffset, byteLength);
        const { left, right } = deinterleavePcm16Stereo(view);
        const expectedFrames = Math.floor(byteLength / 4);

        expect(left).toHaveLength(expectedFrames);
        expect(right).toHaveLength(expectedFrames);
        expect(left.byteOffset).toBe(0);
        expect(right.byteOffset).toBe(0);
        expect(left.buffer.byteLength).toBe(expectedFrames * 4);
        expect(right.buffer.byteLength).toBe(expectedFrames * 4);
        expect(left.buffer).not.toBe(right.buffer);
        expect(left.buffer).not.toBe(backing.buffer);
        expect(right.buffer).not.toBe(backing.buffer);

        if (expectedFrames === 1) {
          expect(left[0]).toBe(0.5);
          expect(right[0]).toBe(-0.5);
        }
      }
    }
  });

  it("decodes exact little-endian signed Int16 extremes and never reuses transferable buffers", () => {
    // Raw LE bytes:
    // Frame 0: L = -32768 (0x00, 0x80), R = 32767 (0xff, 0x7f)
    // Frame 1: L = -1 (0xff, 0xff),     R = 0 (0x00, 0x00)
    // Frame 2: L = 1 (0x01, 0x00),      R = -16384 (0x00, 0xc0)
    const raw = new Uint8Array([
      0x00, 0x80, 0xff, 0x7f,
      0xff, 0xff, 0x00, 0x00,
      0x01, 0x00, 0x00, 0xc0,
    ]);

    const first = deinterleavePcm16Stereo(raw);
    const second = deinterleavePcm16Stereo(raw);

    expect(Array.from(first.left)).toEqual([-1, Math.fround(-1 / 32768), Math.fround(1 / 32768)]);
    expect(Array.from(first.right)).toEqual([Math.fround(32767 / 32768), 0, -0.5]);

    expect(first.left.buffer.byteLength).toBe(12);
    expect(first.right.buffer.byteLength).toBe(12);
    expect(first.left.buffer).not.toBe(first.right.buffer);
    expect(first.left.buffer).not.toBe(second.left.buffer);
    expect(first.right.buffer).not.toBe(second.right.buffer);
  });

  it("handles exact 19,200-frame capacity, single writes > 19,200 frames, and repeated partial wraparounds", () => {
    expect(() => new StereoRingBuffer(Number.NaN)).toThrow(RangeError);
    expect(() => new StereoRingBuffer(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => new StereoRingBuffer(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
    expect(() => new StereoRingBuffer(-0)).toThrow(RangeError);

    // Exact 19,200-frame capacity (150 x 128-frame Web Audio quanta)
    const exactRing = new StereoRingBuffer(PCM_RING_CAPACITY_FRAMES);
    const exactL = Float32Array.from({ length: PCM_RING_CAPACITY_FRAMES }, (_, i) => i);
    const exactR = Float32Array.from({ length: PCM_RING_CAPACITY_FRAMES }, (_, i) => -i);
    exactRing.write(exactL, exactR);
    expect(exactRing.length).toBe(PCM_RING_CAPACITY_FRAMES);

    const qL = new Float32Array(128);
    const qR = new Float32Array(128);
    for (let q = 0; q < 150; q++) {
      exactRing.read(qL, qR);
      expect(qL[0]).toBe(q * 128);
      expect(qL[127]).toBe(q * 128 + 127);
      expect(qR[0]).toBe(-(q * 128));
      expect(qR[127]).toBe(-(q * 128 + 127));
    }
    expect(exactRing.length).toBe(0);

    // Single write larger than capacity keeps newest 19,200 frames in exact order
    const total = 25_000;
    const bigL = Float32Array.from({ length: total }, (_, i) => i + 1);
    const bigR = Float32Array.from({ length: total }, (_, i) => -(i + 1));
    exactRing.write(bigL, bigR);
    expect(exactRing.length).toBe(PCM_RING_CAPACITY_FRAMES);

    const outL = new Float32Array(PCM_RING_CAPACITY_FRAMES);
    const outR = new Float32Array(PCM_RING_CAPACITY_FRAMES);
    exactRing.read(outL, outR);
    const expectedStart = total - PCM_RING_CAPACITY_FRAMES + 1; // 5801
    expect(outL[0]).toBe(expectedStart);
    expect(outL[PCM_RING_CAPACITY_FRAMES - 1]).toBe(total);
    expect(outR[0]).toBe(-expectedStart);
    expect(outR[PCM_RING_CAPACITY_FRAMES - 1]).toBe(-total);
    for (let i = 0; i < PCM_RING_CAPACITY_FRAMES; i += 257) {
      expect(outL[i]).toBe(expectedStart + i);
      expect(outR[i]).toBe(-(expectedStart + i));
    }

    // Repeated partial fills and drains across wraparound & overflow compared to an oracle queue
    const cap = 500;
    const ring = new StereoRingBuffer(cap);
    const oracleL: number[] = [];
    const oracleR: number[] = [];
    let seq = 1;
    for (let cycle = 0; cycle < 20; cycle++) {
      const writeCount = 193;
      const inL = new Float32Array(writeCount);
      const inR = new Float32Array(writeCount);
      for (let i = 0; i < writeCount; i++) {
        inL[i] = seq;
        inR[i] = -seq;
        oracleL.push(seq);
        oracleR.push(-seq);
        if (oracleL.length > cap) {
          oracleL.shift();
          oracleR.shift();
        }
        seq++;
      }
      ring.write(inL, inR);
      expect(ring.length).toBe(oracleL.length);

      const readL = new Float32Array(128).fill(999);
      const readR = new Float32Array(128).fill(999);
      ring.read(readL, readR);
      for (let i = 0; i < 128; i++) {
        expect(readL[i]).toBe(oracleL.shift() ?? 0);
        expect(readR[i]).toBe(oracleR.shift() ?? 0);
      }
      expect(ring.length).toBe(oracleL.length);
    }
  });

  it("zero-fills trailing samples on mismatched output channel lengths in StereoRingBuffer and PcmRingProcessor", () => {
    const ring = new StereoRingBuffer(8);
    ring.write(new Float32Array([0.25]), new Float32Array([-0.25]));

    // outL longer than outR with dirty pre-existing samples
    const outL1 = new Float32Array([9, 9, 9, 9]);
    const outR1 = new Float32Array([8, 8]);
    ring.read(outL1, outR1);
    expect(Array.from(outL1)).toEqual([0.25, 0, 0, 0]);
    expect(Array.from(outR1)).toEqual([-0.25, 0]);

    // outR longer than outL with dirty pre-existing samples
    ring.write(new Float32Array([0.5]), new Float32Array([-0.5]));
    const outL2 = new Float32Array([7, 7]);
    const outR2 = new Float32Array([6, 6, 6, 6]);
    ring.read(outL2, outR2);
    expect(Array.from(outL2)).toEqual([0.5, 0]);
    expect(Array.from(outR2)).toEqual([-0.5, 0, 0, 0]);

    // Same invariant through PcmRingProcessor.process
    const processor = new PcmRingProcessor(8);
    processor.handleMessage({ type: "pcm", left: new Float32Array([0.75]), right: new Float32Array([-0.75]) });
    const procL = new Float32Array([5, 5, 5]);
    const procR = new Float32Array([4]);
    expect(processor.process([], [[procL, procR]])).toBe(true);
    expect(Array.from(procL)).toEqual([0.75, 0, 0]);
    expect(Array.from(procR)).toEqual([-0.75]);
  });

  it("handles PcmRingProcessor null-prototype messages, prototype-pollution keys, empty/non-finite payloads, multi-output, and zero-length channels", () => {
    const processor = new PcmRingProcessor(16);

    // Null-prototype empty object is ignored safely
    const emptyNullProto: Record<string, unknown> = {};
    Object.setPrototypeOf(emptyNullProto, null);
    processor.handleMessage(emptyNullProto);
    expect(processor.bufferedFrames).toBe(0);

    // Null-prototype valid PCM message is accepted
    const validNullProto: Record<string, unknown> = {
      type: "pcm",
      left: new Float32Array([0.25]),
      right: new Float32Array([-0.25]),
    };
    Object.setPrototypeOf(validNullProto, null);
    processor.handleMessage(validNullProto);
    expect(processor.bufferedFrames).toBe(1);

    // Prototype pollution payload does not pollute Object.prototype or corrupt state
    const protoPayload: unknown = JSON.parse('{"__proto__":{"polluted":true},"type":"pcm"}');
    processor.handleMessage(protoPayload);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    expect(processor.bufferedFrames).toBe(1);

    // Empty Float32Array and mismatched TypedArray types are harmless
    processor.handleMessage({ type: "pcm", left: new Float32Array(0), right: new Float32Array(0) });
    processor.handleMessage({ type: "pcm", left: new Float32Array([1]), right: new Int16Array([1]) });
    processor.handleMessage(undefined);
    expect(processor.bufferedFrames).toBe(1);

    // Zero-length output channels do not consume buffered frames
    expect(processor.process([], [[new Float32Array(0), new Float32Array(0)]])).toBe(true);
    expect(processor.process([], [[new Float32Array(0)]])).toBe(true);
    expect(processor.bufferedFrames).toBe(1);

    // Multiple outputs: renders into outputs[0] without throwing
    const out0L = new Float32Array(2);
    const out0R = new Float32Array(2);
    const out1L = new Float32Array([3, 3]);
    const out1R = new Float32Array([4, 4]);
    expect(processor.process([], [[out0L, out0R], [out1L, out1R]])).toBe(true);
    expect(Array.from(out0L)).toEqual([0.25, 0]);
    expect(Array.from(out0R)).toEqual([-0.25, 0]);
    expect(processor.bufferedFrames).toBe(0);

    // Non-finite samples do not corrupt ring indices or prevent subsequent finite frames
    processor.handleMessage({
      type: "pcm",
      left: new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, 0.5]),
      right: new Float32Array([Number.NEGATIVE_INFINITY, Number.NaN, -0.5]),
    });
    expect(processor.bufferedFrames).toBe(3);
    const nfL = new Float32Array(3);
    const nfR = new Float32Array(3);
    expect(processor.process([], [[nfL, nfR]])).toBe(true);
    expect(nfL[2]).toBe(0.5);
    expect(nfR[2]).toBe(-0.5);

    // Repeated dispose calls are idempotent
    processor.handleMessage({ type: "dispose" });
    processor.handleMessage({ type: "dispose" });
    out0L.fill(7);
    out0R.fill(7);
    expect(processor.process([], [[out0L, out0R], [out1L, out1R]])).toBe(false);
    expect(Array.from(out0L)).toEqual([0, 0]);
    expect(Array.from(out0R)).toEqual([0, 0]);
  });

  it("does not leak worklet/listener when an older createPcmAudioTrack resolves AFTER a newer one supersedes it", async () => {
    const unsub1 = vi.fn();
    const unsub2 = vi.fn();
    const stopAudio = vi.fn();
    const listeners: Array<(pcm: Uint8Array) => void> = [];
    const bridge = {
      onAudioPcm: vi.fn((cb: (pcm: Uint8Array) => void) => {
        listeners.push(cb);
        return listeners.length === 1 ? unsub2 : unsub1;
      }),
      stopAudio,
    };

    let resolve1!: (handle: PcmWorkletTrackHandle) => void;
    let teardown1!: () => void;
    let teardown2!: () => void;

    const p1 = createPcmAudioTrack(bridge, {
      createTrack: (_url, onTeardown) => {
        teardown1 = onTeardown;
        return new Promise<PcmWorkletTrackHandle>((resolve) => {
          resolve1 = resolve;
        });
      },
    });

    const stop2 = vi.fn();
    const dispose2 = vi.fn();
    const postPcm2 = vi.fn();
    const p2 = createPcmAudioTrack(bridge, {
      createTrack: async (_url, onTeardown) => {
        teardown2 = onTeardown;
        return {
          track: { kind: "audio", stop: stop2 } as unknown as MediaStreamTrack,
          sink: { postPcm: postPcm2, dispose: dispose2 },
        };
      },
    });

    // Call #2 finishes first and becomes the active PCM track
    await p2;
    expect(bridge.onAudioPcm).toHaveBeenCalledTimes(1);

    // Call #1 resolves AFTER #2 already superseded it
    const stop1 = vi.fn();
    const dispose1 = vi.fn();
    const postPcm1 = vi.fn();
    resolve1({
      track: { kind: "audio", stop: stop1 } as unknown as MediaStreamTrack,
      sink: { postPcm: postPcm1, dispose: dispose1 },
    });
    await p1;

    // Superseded #1 MUST NOT subscribe to onAudioPcm, MUST dispose/stop its own handle, and MUST NOT stopAudio
    expect(bridge.onAudioPcm).toHaveBeenCalledTimes(1);
    expect(dispose1).toHaveBeenCalledTimes(1);
    expect(stop1).toHaveBeenCalledTimes(1);
    expect(stopAudio).not.toHaveBeenCalled();

    // Subsequent teardown of #1 is a no-op; teardown of #2 stops main-process audio once
    teardown1();
    expect(stopAudio).not.toHaveBeenCalled();
    teardown2();
    expect(dispose2).toHaveBeenCalledTimes(1);
    expect(unsub2).toHaveBeenCalledTimes(1);
    expect(stopAudio).toHaveBeenCalledTimes(1);
  });

  it("does not call stopAudio when a superseded createPcmAudioTrack rejects after a newer one starts", async () => {
    const stopAudio = vi.fn();
    const onAudioPcm = vi.fn(() => vi.fn());
    let reject1!: (err: Error) => void;

    const p1 = createPcmAudioTrack(
      { onAudioPcm, stopAudio },
      {
        createTrack: () =>
          new Promise<PcmWorkletTrackHandle>((_resolve, reject) => {
            reject1 = reject;
          }),
      },
    );

    const p2 = createPcmAudioTrack(
      { onAudioPcm, stopAudio },
      {
        createTrack: async () => ({
          track: { kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack,
          sink: { postPcm: vi.fn(), dispose: vi.fn() },
        }),
      },
    );

    await p2;
    reject1(new Error("stale addModule failure"));
    await expect(p1).rejects.toThrow("stale addModule failure");
    expect(stopAudio).not.toHaveBeenCalled();
    expect(onAudioPcm).toHaveBeenCalledTimes(1);
  });

  it("keeps teardown idempotent when called both mid-addModule and again after resolve or reject", async () => {
    const stopAudio = vi.fn();
    const onAudioPcm = vi.fn(() => vi.fn());
    let resolveTrack!: (handle: PcmWorkletTrackHandle) => void;
    let teardown!: () => void;

    const p = createPcmAudioTrack(
      { onAudioPcm, stopAudio },
      {
        createTrack: (_url, onTeardown) => {
          teardown = onTeardown;
          return new Promise<PcmWorkletTrackHandle>((resolve) => {
            resolveTrack = resolve;
          });
        },
      },
    );

    teardown();
    const dispose = vi.fn();
    const trackStop = vi.fn();
    resolveTrack({
      track: { kind: "audio", stop: trackStop } as unknown as MediaStreamTrack,
      sink: { postPcm: vi.fn(), dispose },
    });
    await p;
    teardown();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(stopAudio).toHaveBeenCalledTimes(1);
    expect(onAudioPcm).not.toHaveBeenCalled();

    // Teardown mid-addModule followed by rejection still calls stopAudio only once
    stopAudio.mockClear();
    let rejectTrack!: (err: Error) => void;
    let teardownReject!: () => void;
    const pReject = createPcmAudioTrack(
      { onAudioPcm, stopAudio },
      {
        createTrack: (_url, onTeardown) => {
          teardownReject = onTeardown;
          return new Promise<PcmWorkletTrackHandle>((_resolve, reject) => {
            rejectTrack = reject;
          });
        },
      },
    );
    teardownReject();
    rejectTrack(new Error("aborted"));
    await expect(pReject).rejects.toThrow("aborted");
    expect(stopAudio).toHaveBeenCalledTimes(1);
  });

  it("transfers exact-sized distinct Float32Array buffers through sink.postPcm from offset IPC chunks", async () => {
    let pcmListener: ((pcm: Uint8Array) => void) | null = null;
    const received: Array<{ left: Float32Array; right: Float32Array }> = [];
    let teardown!: () => void;

    await createPcmAudioTrack(
      {
        onAudioPcm: (cb) => {
          pcmListener = cb;
          return () => {};
        },
        stopAudio: vi.fn(),
      },
      {
        createTrack: async (_url, onTeardown) => {
          teardown = onTeardown;
          return {
            track: { kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack,
            sink: {
              postPcm: (left, right) => {
                received.push({ left, right });
              },
              dispose: vi.fn(),
            },
          };
        },
      },
    );

    const backing = new Uint8Array(128).fill(0x55);
    const payload = pcmBytesFromInt16([-32768, 32767, 16384, -16384]);
    backing.set(payload, 5);
    // 2 frames + 3 trailing odd bytes from offset 5 inside 128-byte buffer
    pcmListener!(new Uint8Array(backing.buffer, 5, 11));

    expect(received).toHaveLength(1);
    const packet = received[0]!;
    expect(packet.left.buffer.byteLength).toBe(8);
    expect(packet.right.buffer.byteLength).toBe(8);
    expect(packet.left.buffer).not.toBe(packet.right.buffer);
    expect(packet.left.buffer).not.toBe(backing.buffer);
    expect(packet.right.buffer).not.toBe(backing.buffer);
    expect(Array.from(packet.left)).toEqual([-1, 0.5]);
    expect(Array.from(packet.right)).toEqual([Math.fround(32767 / 32768), -0.5]);
    teardown();
  });

  it("enforces CSP and Trusted Types boundaries across PCM audio sources (no ScriptProcessorNode, blob:/data:, eval, or unsafe casts)", () => {
    const files = [
      new URL("../../src/platform/pcm-audio.ts", import.meta.url),
      new URL("../../src/platform/pcm-ring-worklet.ts", import.meta.url),
      new URL("../../src/platform/electron.ts", import.meta.url),
    ];
    const forbidden = [
      /\bScriptProcessorNode\b/,
      /\bcreateScriptProcessor\b/,
      /\bcreateObjectURL\b/,
      /["'`]blob:/i,
      /["'`]data:/i,
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
      /\binnerHTML\b/,
      /\bouterHTML\b/,
      /\binsertAdjacentHTML\b/,
      /\bdocument\.write\b/,
      /\bas\s+unknown\s+as\b/,
    ];
    for (const fileUrl of files) {
      // Stryker's mutant sandbox prepends its own `new Function("return this")()` harness to source files.
      if (fileUrl.pathname.includes(".stryker-tmp")) continue;
      const source = readFileSync(fileUrl, "utf8");
      for (const pattern of forbidden) {
        expect(source, `${fileUrl.pathname} must not match ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });
});

