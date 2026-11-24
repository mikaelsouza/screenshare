/**
 * The desktop app's source picker: a native menu listing windows and screens, the
 * same choices Chrome's picker offers on the web. Builds the menu template only, so
 * it can be tested without Electron; main.ts turns it into a Menu.
 */

import type { NativeImage } from "electron";

export type PickerWindowState = "normal" | "minimized" | "elevated";

export interface PickerSource {
  /** "window:…" or "screen:…", as desktopCapturer reports. */
  id: string;
  name: string;
  state?: PickerWindowState;
  appIcon?: { isEmpty(): boolean; resize(options: { width: number; height: number }): NativeImage | string } | null;
}

export interface PickerItem {
  label?: string;
  type?: "separator";
  enabled?: boolean;
  icon?: NativeImage | string;
  click?: () => void;
}

const MAX_LABEL = 60;

/**
 * Format a window or screen title with an optional status suffix, truncating the
 * base title first so the suffix stays intact, and doubling "&" for Windows menus.
 */
export function formatWindowLabel(name: string, suffix = ""): string {
  const trimmedName = name.trim();
  const maxBase = Math.max(1, MAX_LABEL - suffix.length);
  const base =
    trimmedName.length > maxBase ? `${trimmedName.slice(0, maxBase - 1)}…` : trimmedName;
  return `${base}${suffix}`.replace(/&/g, "&&");
}

/**
 * Menu labels treat "&" as an access-key marker on Windows; double it to show it.
 * Long titles are cut so the menu stays a sensible width.
 */
export function menuLabel(name: string): string {
  return formatWindowLabel(name, "");
}

function buildWindowItem<S extends PickerSource>(
  source: S,
  suffix: string,
  onPick?: (source: S) => void,
  enabled = true,
): PickerItem {
  const icon =
    enabled && source.appIcon && !source.appIcon.isEmpty()
      ? source.appIcon.resize({ width: 16, height: 16 })
      : undefined;
  return {
    label: formatWindowLabel(source.name, suffix),
    ...(enabled ? {} : { enabled: false }),
    ...(icon !== undefined ? { icon } : {}),
    ...(enabled && onPick ? { click: () => onPick(source) } : {}),
  };
}

/**
 * Build the native context-menu template for picking a window or screen.
 * `excludeId` omits our own window from the list.
 */
export function buildPickerTemplate<S extends PickerSource>(
  sources: readonly S[],
  onPick: (source: S) => void,
  { excludeId = null }: { excludeId?: string | null } = {},
): PickerItem[] {
  const windows = sources.filter(
    (s) => s.id.startsWith("window:") && s.id !== excludeId && s.name.trim() !== "",
  );
  const active = windows.filter((s) => s.state === undefined || s.state === "normal");
  const minimized = windows.filter((s) => s.state === "minimized");
  const elevated = windows.filter((s) => s.state === "elevated");
  const screens = sources.filter((s) => s.id.startsWith("screen:"));

  const items: PickerItem[] = [];
  if (windows.length > 0) {
    items.push({ label: "Windows", enabled: false });
    for (const s of active) items.push(buildWindowItem(s, "", onPick, true));
    for (const s of minimized) items.push(buildWindowItem(s, " (minimized)", onPick, true));
    for (const s of elevated) items.push(buildWindowItem(s, " (Run as Admin to share)", undefined, false));
  }
  if (screens.length > 0) {
    if (items.length > 0) items.push({ type: "separator" });
    items.push({ label: "Screens", enabled: false });
    screens.forEach((s, i) => {
      items.push({ label: menuLabel(s.name || `Screen ${i + 1}`), click: () => onPick(s) });
    });
  }
  return items;
}
