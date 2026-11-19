/**
 * Turns raw 48 kHz 16-bit signed little-endian stereo PCM from the Electron main
 * process (loopback-capture) into a live MediaStreamTrack for WebRTC.
 *
 * Audio buffering and playback run off the renderer main thread inside a same-origin
 * AudioWorkletNode (`pcm-ring-worklet.ts?worker&url`) so UI jank never starves audio
 * output and strict CSP (`script-src 'self'`, `trusted-types 'none'`) stays intact.
 *
 * When a followed game swaps from its lobby window to its match window, the main
 * process switches the PID feeding this stream while the MediaStreamTrack here stays
 * the same object — so peers keep hearing uninterrupted audio with no renegotiation.
 */

import { PCM_WORKLET_PROCESSOR_NAME, type PcmWorkletMessage } from "./pcm-ring-worklet";
// oxlint-disable-next-line import/default -- Vite ?worker&url virtual module default-exports the compiled asset URL
import pcmRingWorkletUrl from "./pcm-ring-worklet.ts?worker&url";

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

export interface PcmAudioBridge {
  onAudioPcm: (cb: (pcm: Uint8Array) => void) => () => void;
  stopAudio: () => void;
}

interface PcmWorkletSink {
  postPcm: (left: Float32Array, right: Float32Array) => void;
  dispose: () => void;
}

export interface PcmWorkletTrackHandle {
  track: MediaStreamTrack;
  sink: PcmWorkletSink;
}

export interface PcmTrackDeps {
  createTrack: (workletUrl: string, onTeardown: () => void) => Promise<PcmWorkletTrackHandle>;
}

/**
 * Default Web Audio pipeline: loads the same-origin AudioWorklet module, feeds
 * stereo PCM frames via transferable MessagePort buffers into an AudioWorkletNode
 * connected to a MediaStreamAudioDestinationNode, and returns its MediaStreamTrack.
 */
// Stryker disable all: Web Audio API DOM plumbing requires a real browser AudioContext
/* v8 ignore start */
async function createWebAudioTrack(
  workletUrl: string,
  onTeardown: () => void,
): Promise<PcmWorkletTrackHandle> {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    const worklet = new AudioWorkletNode(ctx, PCM_WORKLET_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const destination = ctx.createMediaStreamDestination();
    worklet.connect(destination);
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});

    const track = destination.stream.getAudioTracks()[0];
    if (!track) {
      worklet.disconnect();
      throw new Error("MediaStreamAudioDestinationNode returned no audio track");
    }
    track.contentHint = "music";

    let disposed = false;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      try {
        const msg: PcmWorkletMessage = { type: "dispose" };
        worklet.port.postMessage(msg);
      } catch {
        /* port may already be closed */
      }
      try {
        worklet.disconnect();
      } catch {
        /* node may already be disconnected */
      }
      void ctx.close().catch(() => {});
    };

    const origStop = track.stop.bind(track);
    track.stop = () => {
      onTeardown();
      dispose();
      origStop();
    };

    return {
      track,
      sink: {
        postPcm: (left, right) => {
          const msg: PcmWorkletMessage = { type: "pcm", left, right };
          worklet.port.postMessage(msg, [left.buffer, right.buffer]);
        },
        dispose,
      },
    };
  } catch (err) {
    void ctx.close().catch(() => {});
    throw err;
  }
}

const defaultPcmDeps: PcmTrackDeps = {
  createTrack: createWebAudioTrack,
};
/* v8 ignore stop */
// Stryker restore all

let latestPcmTrackToken: symbol | null = null;

/**
 * Create a live MediaStreamTrack fed by `bridge.onAudioPcm` through an off-main-thread
 * AudioWorkletNode. Calling `track.stop()` unsubscribes from PCM updates, disposes the
 * worklet, and tells the main process to stop capturing audio if no newer PCM track has
 * replaced this one.
 */
export async function createPcmAudioTrack(
  bridge: PcmAudioBridge,
  deps: PcmTrackDeps = defaultPcmDeps,
): Promise<MediaStreamTrack> {
  let stopped = false;
  let sink: PcmWorkletSink | null = null;
  let unsubscribe: (() => void) | null = null;
  const token = Symbol();
  latestPcmTrackToken = token;

  const teardown = (): void => {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
    unsubscribe = null;
    try {
      sink?.dispose();
    } catch {
      /* worklet port may already be closed */
    }
    if (latestPcmTrackToken === token) bridge.stopAudio();
  };

  let handle: PcmWorkletTrackHandle;
  try {
    handle = await deps.createTrack(pcmRingWorkletUrl, teardown);
  } catch (err) {
    teardown();
    throw err;
  }

  sink = handle.sink;

  // If teardown ran or a newer track superseded this one while awaiting addModule, dispose immediately.
  if (stopped || latestPcmTrackToken !== token) {
    stopped = true;
    try {
      sink.dispose();
    } catch {
      /* worklet port may already be closed */
    }
    handle.track.stop();
    return handle.track;
  }

  try {
    unsubscribe = bridge.onAudioPcm((bytes) => {
      if (stopped) return;
      const { left, right } = deinterleavePcm16Stereo(bytes);
      if (left.length === 0) return;
      try {
        sink.postPcm(left, right);
      } catch {
        /* worklet port may already be closed */
      }
    });
  } catch (err) {
    teardown();
    handle.track.stop();
    throw err;
  }

  return handle.track;
}
