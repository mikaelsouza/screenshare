/**
 * AudioWorklet processor and fixed-capacity stereo ring buffer for native WASAPI
 * PCM audio capture. Compiled by Vite (`?worker&url`) into a same-origin JS asset
 * under strict CSP (`script-src 'self'`, `trusted-types 'none'`).
 */

export const PCM_WORKLET_PROCESSOR_NAME: string = "pcm-ring-processor";

/** 400 ms of 48 kHz stereo audio headroom (48,000 * 0.4). */
export const PCM_RING_CAPACITY_FRAMES: number = 19_200;

export type PcmWorkletMessage =
  | { readonly type: "pcm"; readonly left: Float32Array; readonly right: Float32Array }
  | { readonly type: "dispose" };

/**
 * Fixed-capacity stereo ring buffer. On overflow, the oldest samples are dropped so
 * latency never builds up; on underrun, remaining output samples are filled with 0.
 */
export class StereoRingBuffer {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private readPos = 0;
  private writePos = 0;
  private available = 0;

  readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`StereoRingBuffer capacity must be a positive integer, got ${String(capacity)}`);
    }
    this.capacity = capacity;
    this.left = new Float32Array(capacity);
    this.right = new Float32Array(capacity);
  }

  /** Number of stereo frames currently queued in the ring buffer. */
  get length(): number {
    return this.available;
  }

  /** Write planar left and right channel samples into the ring buffer. */
  write(leftIn: Float32Array, rightIn: Float32Array): void {
    const n = Math.min(leftIn.length, rightIn.length);
    for (let i = 0; i < n; i++) {
      this.left[this.writePos] = leftIn[i] ?? 0;
      this.right[this.writePos] = rightIn[i] ?? 0;
      this.writePos = (this.writePos + 1) % this.capacity;
      if (this.available < this.capacity) {
        this.available++;
      } else {
        this.readPos = (this.readPos + 1) % this.capacity;
      }
    }
  }

  /** Read up to `outLeft.length` stereo frames from the ring buffer, zero-filling on underrun. */
  read(outLeft: Float32Array, outRight: Float32Array): void {
    const len = Math.min(outLeft.length, outRight.length);
    for (let i = 0; i < len; i++) {
      if (this.available > 0) {
        outLeft[i] = this.left[this.readPos] ?? 0;
        outRight[i] = this.right[this.readPos] ?? 0;
        this.readPos = (this.readPos + 1) % this.capacity;
        this.available--;
      } else {
        outLeft[i] = 0;
        outRight[i] = 0;
      }
    }
    if (outLeft.length > len) outLeft.fill(0, len);
    if (outRight.length > len) outRight.fill(0, len);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Pure DSP processor core shared between the browser `AudioWorkletProcessor`
 * registration and Node unit tests.
 */
export class PcmRingProcessor {
  private readonly ring: StereoRingBuffer;
  private disposed = false;

  constructor(capacityFrames: number = PCM_RING_CAPACITY_FRAMES) {
    this.ring = new StereoRingBuffer(capacityFrames);
  }

  /** Number of stereo frames currently buffered in the worklet ring. */
  get bufferedFrames(): number {
    return this.ring.length;
  }

  /** Handle messages posted over `AudioWorkletNode.port`. */
  handleMessage(msg: unknown): void {
    if (!isRecord(msg) || typeof msg["type"] !== "string") return;
    if (msg["type"] === "dispose") {
      this.disposed = true;
      return;
    }
    if (this.disposed || msg["type"] !== "pcm") return;
    const left = msg["left"];
    const right = msg["right"];
    if (left instanceof Float32Array && right instanceof Float32Array) {
      this.ring.write(left, right);
    }
  }

  /** Pull one render quantum (128 frames in Web Audio) into the first stereo output. */
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (this.disposed) {
      if (output) {
        for (const channel of output) channel.fill(0);
      }
      return false;
    }
    if (!output || output.length === 0) return true;
    const outL = output[0];
    if (!outL) return true;
    const outR = output[1];
    if (outR) {
      this.ring.read(outL, outR);
    } else {
      const scratch = new Float32Array(outL.length);
      this.ring.read(outL, scratch);
    }
    return true;
  }
}

interface WorkletProcessorBase {
  readonly port: { onmessage: ((ev: { readonly data: unknown }) => void) | null };
}

declare global {
  var AudioWorkletProcessor: (new () => WorkletProcessorBase) | undefined;
  var registerProcessor: ((name: string, ctor: new () => WorkletProcessorBase) => void) | undefined;
}

// Stryker disable all: browser AudioWorkletGlobalScope registration
/* v8 ignore start */
if (
  typeof globalThis.AudioWorkletProcessor === "function" &&
  typeof globalThis.registerProcessor === "function"
) {
  const BaseProcessor = globalThis.AudioWorkletProcessor;
  class RegisteredPcmRingProcessor extends BaseProcessor {
    private readonly core = new PcmRingProcessor(PCM_RING_CAPACITY_FRAMES);

    constructor() {
      super();
      this.port.onmessage = (ev) => this.core.handleMessage(ev.data);
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      return this.core.process(inputs, outputs);
    }
  }
  globalThis.registerProcessor(PCM_WORKLET_PROCESSOR_NAME, RegisteredPcmRingProcessor);
}
/* v8 ignore stop */
// Stryker restore all
