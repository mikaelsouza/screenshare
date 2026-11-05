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
  // skipcq: JS-T1001
  appIcon?: PickerIcon<Icon> | null | undefined;
}

export interface PickerItem<Icon = unknown> {
  // skipcq: JS-T1001
  label?: string | undefined;
  // skipcq: JS-T1001
  type?: "separator" | undefined;
  // skipcq: JS-T1001
  enabled?: boolean | undefined;
  // skipcq: JS-T1001
  icon?: Icon | undefined;
  // skipcq: JS-T1001
  click?: (() => void) | undefined;
}

export interface PickerOptions {
  /** Our own window id to exclude from the picker. */
  // skipcq: JS-T1001
  excludeId?: string | null | undefined;
  // skipcq: JS-T1001
  windowsOnly?: boolean | undefined;
}

const MAX_LABEL = 60;

/**
 * Menu labels treat "&" as an access-key marker on Windows; double it to show it.
 * Long titles are cut so the menu stays a sensible width.
 */
// skipcq: JS-0067
export function menuLabel(name: string): string {
  const trimmed = name.trim();
  const short = trimmed.length > MAX_LABEL ? `${trimmed.slice(0, MAX_LABEL - 1)}…` : trimmed;
  return short.replace(/&/g, "&&");
}

// skipcq: JS-0067, JS-R1005
export function buildPickerTemplate<Icon = unknown, S extends PickerSource<Icon> = PickerSource<Icon>>(
  sources: readonly S[],
  onPick: (source: S) => void,
  { excludeId = null, windowsOnly = false }: PickerOptions = {},
): PickerItem<Icon>[] {
  const windows = sources.filter(
    (source) => source.id.startsWith("window:") && source.id !== excludeId && source.name.trim() !== "",
  );
  const screens = windowsOnly ? [] : sources.filter((source) => source.id.startsWith("screen:"));

  const items: PickerItem<Icon>[] = [];
  if (windows.length > 0) {
    items.push({ label: "Windows", enabled: false });
    for (const source of windows) {
      const icon =
        source.appIcon && !source.appIcon.isEmpty()
          ? source.appIcon.resize({ width: 16, height: 16 })
          : undefined;
      items.push({
        label: menuLabel(source.name),
        ...(icon !== undefined ? { icon } : {}),
        click: () => onPick(source),
      });
    }
  }
  if (screens.length > 0) {
    if (items.length > 0) items.push({ type: "separator" });
    items.push({ label: "Screens", enabled: false });
    screens.forEach((source, index) => {
      items.push({
        label: menuLabel(source.name || `Screen ${String(index + 1)}`),
        click: () => onPick(source),
      });
    });
  }
  return items;
}
