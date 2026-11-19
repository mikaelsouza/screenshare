import {
  DEFAULT_PRESET,
  QUALITY_PRESETS,
  type CaptureResult,
  type QualityPresetName,
} from "../capture";
import type { FollowState } from "../platform/types";
import {
  DEFAULT_CODEC,
  DEFAULT_DEGRADATION_MODE,
  type CodecName,
  type DegradationMode,
} from "../quality";
import { deriveOutboundAudioState, type PopoverKind } from "../ui-model";
import type { UiElements } from "./dom";
import { createIcon } from "./icons";

const CODEC_NAMES = ["h264", "av1"] as const;
const DEGRADATION_MODES = ["framerate", "clarity"] as const;

const CODEC_META: Record<CodecName, { title: string; hint: string }> = {
  h264: { title: "H.264", hint: "Hardware · Best for gaming" },
  av1: { title: "AV1", hint: "Best quality · Modern GPU" },
};

const DEGRADATION_META: Record<DegradationMode, { title: string; hint: string }> = {
  framerate: { title: "Focus Framerate", hint: "Smooth FPS" },
  clarity: { title: "Focus Clarity", hint: "Sharp Resolution" },
};

function isQualityPresetName(val: string | null): val is QualityPresetName {
  return val !== null && Object.hasOwn(QUALITY_PRESETS, val);
}

export function currentPreset(): QualityPresetName {
  const stored = localStorage.getItem("preset");
  return isQualityPresetName(stored) ? stored : DEFAULT_PRESET;
}

function isCodecName(val: string | null): val is CodecName {
  return val !== null && (CODEC_NAMES as readonly string[]).includes(val);
}

export function currentCodec(): CodecName {
  const stored = localStorage.getItem("codec");
  return isCodecName(stored) ? stored : DEFAULT_CODEC;
}

function isDegradationMode(val: string | null): val is DegradationMode {
  return val !== null && (DEGRADATION_MODES as readonly string[]).includes(val);
}

export function currentDegradation(): DegradationMode {
  const stored = localStorage.getItem("stream-degradation");
  return isDegradationMode(stored) ? stored : DEFAULT_DEGRADATION_MODE;
}

export function captureBlockedReason(): string | null {
  if (typeof navigator.mediaDevices?.getDisplayMedia === "function") return null;
  if (!window.isSecureContext) {
    return (
      `Screen sharing is blocked because ${location.origin} is not a secure context. ` +
      "Open chrome://flags/#unsafely-treat-insecure-origin-as-secure, add this exact " +
      "address, set it to Enabled, and restart Chrome. (Or reach this page over HTTPS.)"
    );
  }
  return "This browser does not support getDisplayMedia. Chrome or Edge on desktop is required.";
}

export function syncMuteAudioButton(ui: UiElements, capture: CaptureResult | null): void {
  const audioState = deriveOutboundAudioState(
    capture !== null,
    Boolean(capture?.audio),
    Boolean(capture?.audio?.enabled),
  );
  ui.muteAudioBtn.disabled = audioState.disabled;
  ui.muteAudioBtn.classList.toggle("muted-active", audioState.muted);
  ui.muteAudioBtn.setAttribute("aria-pressed", audioState.ariaPressed);
  ui.muteAudioBtn.title = audioState.title;
  ui.muteAudioBtn.replaceChildren(
    createIcon(audioState.icon),
    document.createTextNode(audioState.text),
  );
}

export function renderFollowChip(ui: UiElements, state: FollowState | null): void {
  if (!state) {
    ui.followChip.hidden = true;
    return;
  }
  ui.followChip.hidden = false;
  ui.followDot.dataset["state"] = state.role === "waiting" ? "warn" : "live";
  ui.followChipText.textContent =
    state.role === "waiting"
      ? `Following ${state.profile}: waiting…`
      : `Following ${state.profile}: ${state.role === "game" ? "in game" : "lobby"}`;
  ui.followChip.title = state.title ?? "";
}

function syncMenuListSelection(list: HTMLElement, attr: string, selected: string): void {
  for (const btn of list.querySelectorAll<HTMLButtonElement>(".popover-item")) {
    const active = btn.dataset[attr] === selected;
    btn.setAttribute("aria-pressed", String(active));
    const dot = btn.querySelector<HTMLElement>(".ui-dot");
    if (dot) {
      if (active) dot.dataset["state"] = "active";
      else delete dot.dataset["state"];
    }
  }
}

function buildMenuOption(
  attr: string,
  value: string,
  leftText: string,
  rightText: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "popover-item";
  btn.dataset[attr] = value;

  const left = document.createElement("span");
  left.className = "popover-item-left";
  const dot = document.createElement("span");
  dot.className = "ui-dot";
  left.append(dot, document.createTextNode(leftText));

  const right = document.createElement("span");
  right.className = "popover-item-right";
  right.textContent = rightText;

  btn.append(left, right);
  btn.addEventListener("click", onClick);
  return btn;
}

export interface QualityControlCallbacks {
  onTogglePopover: (kind: PopoverKind) => void;
  onClosePopovers: () => void;
  onPresetChange: (preset: QualityPresetName) => void;
  onCodecChange: (codec: CodecName) => void;
  onDegradationChange: (mode: DegradationMode) => void;
  onToggleMuteAudio: () => void;
  onShowPreview: () => void;
}

export function initQualityControls(ui: UiElements, cb: QualityControlCallbacks): void {
  localStorage.removeItem("audio_mode");

  const syncPreset = (selected: QualityPresetName): void => {
    ui.presetBtnLabel.textContent = QUALITY_PRESETS[selected].label;
    syncMenuListSelection(ui.presetList, "preset", selected);
  };
  for (const [name, preset] of Object.entries(QUALITY_PRESETS)) {
    ui.presetList.append(
      buildMenuOption("preset", name, preset.label, `${(preset.maxBitrate / 1e6).toFixed(0)} Mbps`, () => {
        if (!isQualityPresetName(name)) return;
        localStorage.setItem("preset", name);
        syncPreset(name);
        cb.onClosePopovers();
        cb.onPresetChange(name);
      }),
    );
  }
  syncPreset(currentPreset());

  const syncCodec = (selected: CodecName): void => {
    ui.codecBtnLabel.textContent = CODEC_META[selected].title;
    syncMenuListSelection(ui.codecList, "codec", selected);
  };
  for (const [name, meta] of Object.entries(CODEC_META)) {
    ui.codecList.append(
      buildMenuOption("codec", name, meta.title, meta.hint, () => {
        if (!isCodecName(name)) return;
        localStorage.setItem("codec", name);
        syncCodec(name);
        cb.onClosePopovers();
        cb.onCodecChange(name);
      }),
    );
  }
  syncCodec(currentCodec());

  const syncDeg = (selected: DegradationMode): void => {
    ui.degradationBtnLabel.textContent = DEGRADATION_META[selected].title;
    syncMenuListSelection(ui.degradationList, "degradation", selected);
  };
  for (const [name, meta] of Object.entries(DEGRADATION_META)) {
    ui.degradationList.append(
      buildMenuOption("degradation", name, meta.title, meta.hint, () => {
        if (!isDegradationMode(name)) return;
        localStorage.setItem("stream-degradation", name);
        syncDeg(name);
        cb.onClosePopovers();
        cb.onDegradationChange(name);
      }),
    );
  }
  syncDeg(currentDegradation());

  ui.presetBtn.addEventListener("click", () => cb.onTogglePopover("preset"));
  ui.codecBtn.addEventListener("click", () => cb.onTogglePopover("codec"));
  ui.degradationBtn.addEventListener("click", () => cb.onTogglePopover("degradation"));
  ui.muteAudioBtn.addEventListener("click", () => cb.onToggleMuteAudio());
  ui.togglePreviewBtn.addEventListener("click", () => cb.onShowPreview());
}
