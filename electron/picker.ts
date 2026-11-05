/**
 * The desktop app's source picker: a native menu listing windows and screens, the
 * same choices Chrome's picker offers on the web. Builds the menu template only, so
 * it can be tested without Electron; main.ts turns it into a Menu.
 */

export interface PickerSource {
  /** "window:…" or "screen:…", as desktopCapturer reports. */
  id: string;
  name: string;
  appIcon?: { isEmpty(): boolean; resize(options: { width: number; height: number }): unknown } | null;
}

export interface PickerItem {
  label?: string;
  type?: "separator";
  enabled?: boolean;
  icon?: unknown;
  click?: () => void;
}

const MAX_LABEL = 60;

/**
 * Menu labels treat "&" as an access-key marker on Windows; double it to show it.
 * Long titles are cut so the menu stays a sensible width.
 */
export function menuLabel(name: string): string {
  const trimmedName = name.trim();
  const short = trimmedName.length > MAX_LABEL ? `${trimmedName.slice(0, MAX_LABEL - 1)}…` : trimmedName;
  return short.replace(/&/g, "&&");
}

/**
 * Build the native context-menu template for picking a window or screen.
 * `excludeId` omits our own window from the list.
 */
export function buildPickerTemplate<S extends PickerSource>(
  sources: readonly S[],
  onPick: (source: S) => void,
  { excludeId = null, windowsOnly = false }: { excludeId?: string | null; windowsOnly?: boolean } = {},
): PickerItem[] {
  const windows = sources.filter(
    (s) => s.id.startsWith("window:") && s.id !== excludeId && s.name.trim() !== "",
  );
  const screens = windowsOnly ? [] : sources.filter((s) => s.id.startsWith("screen:"));

  const items: PickerItem[] = [];
  if (windows.length > 0) {
    items.push({ label: "Windows", enabled: false });
    for (const s of windows) {
      const icon =
        s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.resize({ width: 16, height: 16 }) : undefined;
      items.push({ label: menuLabel(s.name), ...(icon !== undefined ? { icon } : {}), click: () => onPick(s) });
    }
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
