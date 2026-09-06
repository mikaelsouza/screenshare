/**
 * Screen capture. The defaults here are deliberately NOT the browser defaults:
 * getDisplayMedia is tuned for slide-sharing, and every audio constraint below is
 * turned *off* because they are voice-call processing that destroys game audio.
 */

export type QualityPresetName = "1080p60" | "1080p30" | "720p60" | "720p30";

export interface QualityPreset {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  /** Encoder ceiling in bits/sec. Applied in quality.ts, not here. */
  readonly maxBitrate: number;
}

export const QUALITY_PRESETS: Record<QualityPresetName, QualityPreset> = {
  "1080p60": { label: "1080p 60fps", width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000 },
  "1080p30": { label: "1080p 30fps", width: 1920, height: 1080, frameRate: 30, maxBitrate: 6_000_000 },
  // The floor the project promises: 720p @ 6 Mbps.
  "720p60": { label: "720p 60fps", width: 1280, height: 720, frameRate: 60, maxBitrate: 6_000_000 },
  "720p30": { label: "720p 30fps", width: 1280, height: 720, frameRate: 30, maxBitrate: 4_000_000 },
};

export const DEFAULT_PRESET: QualityPresetName = "1080p60";

/**
 * Chrome-only getDisplayMedia options that TypeScript's DOM lib doesn't model yet.
 * Unknown members are ignored by browsers, so passing them is safe.
 */
interface ChromeDisplayMediaOptions extends DisplayMediaStreamOptions {
  systemAudio?: "include" | "exclude";
  selfBrowserSurface?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
}

export interface CaptureResult {
  stream: MediaStream;
  video: MediaStreamTrack;
  /** Null when the user unticked "share audio", or on a platform that can't. */
  audio: MediaStreamTrack | null;
}

/**
 * macOS Chrome cannot capture system audio — only tab audio. There is no workaround.
 * Detect it so the UI can say so instead of looking broken.
 */
export function systemAudioSupport(): { supported: boolean; reason?: string } {
  const ua = navigator.userAgent;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";

  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
    return {
      supported: false,
      reason:
        "On macOS, Chrome can only capture audio from a browser tab, not from a game or the system. " +
        "Your screen will share fine, but without game audio.",
    };
  }
  if (/Linux/i.test(platform) && !/Android/i.test(ua)) {
    return {
      supported: false,
      reason:
        "On Linux, screen capture goes through PipeWire and system audio is usually unavailable. " +
        "Video will work; audio probably won't.",
    };
  }
  if (!/Chrome|Chromium|Edg/i.test(ua)) {
    return {
      supported: false,
      reason: "System audio capture requires Chrome or Edge on Windows.",
    };
  }
  return { supported: true };
}

export async function captureScreen(
  preset: QualityPreset,
  wantAudio: boolean,
): Promise<CaptureResult> {
  const options: ChromeDisplayMediaOptions = {
    video: {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.frameRate, max: preset.frameRate },
    },
    audio: wantAudio
      ? {
          channelCount: 2,
          sampleRate: 48000,
          // All three OFF. These are voice-call DSP: echo cancellation eats game
          // audio as "echo", noise suppression strips ambience, and AGC pumps the
          // volume on every explosion. They are the usual cause of "the audio
          // sounds underwater".
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      : false,
    systemAudio: "include",
    selfBrowserSurface: "exclude",
    monitorTypeSurfaces: "include",
    surfaceSwitching: "include",
  };

  const stream = await navigator.mediaDevices.getDisplayMedia(options);

  const video = stream.getVideoTracks()[0];
  if (!video) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("getDisplayMedia returned no video track");
  }
  const audio = stream.getAudioTracks()[0] ?? null;

  // Content hints materially change encoder behaviour.
  //  - "motion": trade per-frame sharpness for framerate. Correct for games.
  //    ("detail" is for text/slides and makes game footage stutter.)
  //  - "music": stop Opus applying speech-optimised coding to game audio.
  video.contentHint = "motion";
  if (audio) audio.contentHint = "music";

  return { stream, video, audio };
}

/** Fires when the user clicks the browser's own "Stop sharing" bar. */
export function onCaptureEnded(result: CaptureResult, cb: () => void): () => void {
  const handler = () => cb();
  result.video.addEventListener("ended", handler);
  return () => result.video.removeEventListener("ended", handler);
}

export function stopCapture(result: CaptureResult): void {
  result.stream.getTracks().forEach((t) => t.stop());
}
