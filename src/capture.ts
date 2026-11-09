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
  /** Chrome/Edge 141+. What audio to offer when a window is picked. A hint only. */
  windowAudio?: "window" | "system" | "exclude";
  selfBrowserSurface?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
}

/** What the picker returned. Chrome reports it on the video track's settings. */
type Surface = "monitor" | "window" | "browser" | "unknown";

export interface CaptureResult {
  stream: MediaStream;
  video: MediaStreamTrack;
  /**
   * The audio track currently being sent. Null when the user unticked "share audio"
   * or on a platform that cannot capture audio.
   */
  audio: MediaStreamTrack | null;
  surface?: Surface;
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
    // Stryker disable next-line StringLiteral: defensive fallback when navigator.platform is absent
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

/** First Chromium version with the `windowAudio` option. */
const WINDOW_AUDIO_MIN_CHROME = 141;

/**
 * Whether the browser understands `windowAudio` for per-application audio capture.
 * Older versions silently ignore the option and fall back to offering system audio.
 * Edge shares Chromium's version numbers, so the Chrome/NN token covers both.
 */
export function windowAudioSupport(): { supported: boolean; reason?: string } {
  const base = systemAudioSupport();
  if (!base.supported) return base;
  const major = Number(/Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent)?.[1] ?? NaN);
  if (!Number.isFinite(major) || major < WINDOW_AUDIO_MIN_CHROME) {
    return {
      supported: false,
      reason:
        `Sharing only a game's audio needs Chrome or Edge ${WINDOW_AUDIO_MIN_CHROME} or newer. ` +
        "Update your browser, or share your screen with system audio.",
    };
  }
  return { supported: true };
}

interface ChromeAudioTrackConstraints extends MediaTrackConstraints {
  /** Chromium screen-capture constraint excluding this browser's own audio playback. */
  restrictOwnAudio?: boolean;
}

/**
 * All three voice-call DSP flags OFF: echo cancellation eats game audio as
 * "echo", noise suppression strips ambience, and AGC pumps the volume on every
 * explosion. `restrictOwnAudio: true` excludes this browser's own playback so
 * whole-screen shares never loop remote peers' audio back to them.
 */
const GAME_AUDIO: ChromeAudioTrackConstraints = {
  channelCount: 2,
  sampleRate: 48000,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  restrictOwnAudio: true,
};

function surfaceOf(track: MediaStreamTrack): Surface {
  // Stryker disable next-line OptionalChaining: defensive guard for partial/fake MediaStreamTrack objects
  const s = (track.getSettings?.() as MediaTrackSettings & { displaySurface?: string } | undefined)
    ?.displaySurface;
  return s === "monitor" || s === "window" || s === "browser" ? s : "unknown";
}

export async function captureScreen(preset: QualityPreset): Promise<CaptureResult> {
  const options: ChromeDisplayMediaOptions = {
    video: {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.frameRate, max: preset.frameRate },
      // Open the picker on the Window tab. The goal is sharing one game window, and a
      // whole-screen share also shows notifications, chat pop-ups and every other
      // app. Only a starting point: the other tabs stay one click away.
      displaySurface: "window",
    },
    // Always offer audio in the native picker: per-application audio on the Window tab
    // (`windowAudio: "window"`) and full system audio on the Entire Screen tab
    // (`systemAudio: "include"`).
    audio: GAME_AUDIO,
    systemAudio: "include",
    windowAudio: "window",
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

  // Leave video.contentHint unset ("") so Chromium/Electron treats the track as
  // screen capture (using its default maintain-resolution policy to keep the
  // preset resolution locked instead of downscaling mid-stream). Stop Opus
  // applying speech-optimised coding to game audio.
  if (audio) audio.contentHint = "music";

  return { stream, video, audio, surface: surfaceOf(video) };
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
