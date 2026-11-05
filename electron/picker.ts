/**
 * The desktop app's source picker: a native menu listing windows and screens, the
 * same choices Chrome's picker offers on the web. Builds the menu template only, so
 * it can be tested without Electron; main.ts turns it into a Menu.
 */

interface PickerIcon<Icon = unknown> {
  isEmpty(): boolean;
  resize(options: { width: number; height: number }): Icon;
}

export interface PickerSource<Icon = unknown> {
  /** "window:…" or "screen:…", as desktopCapturer reports. */
  id: string;
  name: string;
  appIcon?: PickerIcon<Icon> | null | undefined;
}

export interface PickerItem<Icon = unknown> {
  label?: string | undefined;
  type?: "separator" | undefined;
  enabled?: boolean | undefined;
  icon?: Icon | undefined;
  click?: (() => void) | undefined;
}

export interface PickerOptions {
  /** Our own window id to exclude from the picker. */
  excludeId?: string | null | undefined;
  windowsOnly?: boolean | undefined;
}

const MAX_LABEL = 60;

/**
 * Menu labels treat "&" as an access-key marker on Windows; double it to show it.
 * Long titles are cut so the menu stays a sensible width.
 */
export function menuLabel(name: string): string {
  const t = name.trim();
  const short = t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1)}…` : t;
  return short.replace(/&/g, "&&");
}

export function buildPickerTemplate<Icon = unknown, S extends PickerSource<Icon> = PickerSource<Icon>>(
  sources: readonly S[],
  onPick: (source: S) => void,
  { excludeId = null, windowsOnly = false }: PickerOptions = {},
): PickerItem<Icon>[] {
  const windows = sources.filter(
    (s) => s.id.startsWith("window:") && s.id !== excludeId && s.name.trim() !== "",
  );
  const screens = windowsOnly ? [] : sources.filter((s) => s.id.startsWith("screen:"));

  const items: PickerItem<Icon>[] = [];
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
      items.push({ label: menuLabel(s.name || `Screen ${String(i + 1)}`), click: () => onPick(s) });
    });
  }
  return items;
}
