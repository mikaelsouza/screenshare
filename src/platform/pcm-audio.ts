/**
 * Turns raw 48 kHz 16-bit signed little-endian stereo PCM from the Electron main
 * process (loopback-capture) into a live MediaStreamTrack for WebRTC.
 *
 * When a followed game swaps from its lobby window to its match window, the main
 * process switches the PID feeding this stream while the MediaStreamTrack here stays
 * the same object — so peers keep hearing uninterrupted audio with no renegotiation.
 */

const SAMPLE_RATE = 48_000;
const PCM16_SCALE = 1 / 32768;

/**
 * Convert interleaved signed 16-bit little-endian stereo PCM into planar Float32
 * left and right channel arrays in [-1, 1].
 */
export function deinterleavePcm16Stereo(bytes: Uint8Array): { left: Float32Array; right: Float32Array } {
  const frames = Math.floor(bytes.byteLength / 4);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const view = new DataView(bytes.buffer, bytes.byteOffset, frames * 4);
  for (let i = 0; i < frames; i++) {
    const offset = i * 4;
    left[i] = view.getInt16(offset, true) * PCM16_SCALE;
    right[i] = view.getInt16(offset + 2, true) * PCM16_SCALE;
  }
  return { left, right };
}

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
    this.capacity = capacity;
    this.left = new Float32Array(capacity);
    this.right = new Float32Array(capacity);
  }

  /** Write interleaved planar left and right channel samples into the ring buffer. */
  write(leftIn: Float32Array, rightIn: Float32Array): void {
    const n = leftIn.length;
    for (let i = 0; i < n; i++) {
      this.left[this.writePos] = leftIn[i]!;
      this.right[this.writePos] = rightIn[i]!;
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
    const len = outLeft.length;
    for (let i = 0; i < len; i++) {
      if (this.available > 0) {
        outLeft[i] = this.left[this.readPos]!;
        outRight[i] = this.right[this.readPos]!;
        this.readPos = (this.readPos + 1) % this.capacity;
        this.available--;
      } else {
        outLeft[i] = 0;
        outRight[i] = 0;
      }
    }
  }
}

export interface PcmAudioBridge {
  onAudioPcm: (cb: (pcm: Uint8Array) => void) => () => void;
  stopAudio: () => void;
}

export interface PcmTrackDeps {
  createTrack: (ring: StereoRingBuffer, onTeardown: () => void) => MediaStreamTrack;
}

/**
 * Default Web Audio pipeline: pulls from the StereoRingBuffer into a
 * MediaStreamAudioDestinationNode and returns its audio MediaStreamTrack.
 */
// Stryker disable all: Web Audio API DOM plumbing requires a real browser AudioContext
/* v8 ignore start */
function createWebAudioTrack(ring: StereoRingBuffer, onTeardown: () => void): MediaStreamTrack {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
  const processor = ctx.createScriptProcessor(512, 0, 2);
  const destination = ctx.createMediaStreamDestination();
  processor.onaudioprocess = (ev) => {
    const outL = ev.outputBuffer.getChannelData(0);
    const outR = ev.outputBuffer.getChannelData(1);
    ring.read(outL, outR);
  };
  processor.connect(destination);
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});

  const track = destination.stream.getAudioTracks()[0]!;
  track.contentHint = "music";
  const origStop = track.stop.bind(track);
  track.stop = () => {
    onTeardown();
    try {
      processor.disconnect();
      void ctx.close().catch(() => {});
    } catch {}
    origStop();
  };
  return track;
}

const defaultPcmDeps: PcmTrackDeps = {
  createTrack: createWebAudioTrack,
};
/* v8 ignore stop */
// Stryker restore all

/** ~150 ms of 48 kHz stereo buffer. */
const RING_CAPACITY_FRAMES = 7_200;

let latestPcmTrackToken: symbol | null = null;

/**
 * Create a live MediaStreamTrack fed by `bridge.onAudioPcm`. Calling `track.stop()`
 * unsubscribes from PCM updates and tells the main process to stop capturing audio
 * if no newer PCM track has replaced this one.
 */
export function createPcmAudioTrack(
  bridge: PcmAudioBridge,
  deps: PcmTrackDeps = defaultPcmDeps,
): MediaStreamTrack {
  const ring = new StereoRingBuffer(RING_CAPACITY_FRAMES);
  let stopped = false;
  const token = Symbol();
  latestPcmTrackToken = token;
  const unsubscribe = bridge.onAudioPcm((bytes) => {
    const { left, right } = deinterleavePcm16Stereo(bytes);
    ring.write(left, right);
  });

  const teardown = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    if (latestPcmTrackToken === token) bridge.stopAudio();
  };

  return deps.createTrack(ring, teardown);
}
