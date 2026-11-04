// @ts-check
/**
 * The desktop app's source picker: a native menu listing windows and screens, the
 * same choices Chrome's picker offers on the web. Builds the menu template only, so
 * it can be tested without Electron; main.js turns it into a Menu.
 */

/**
 * @typedef {object} PickerSource
 * @property {string} id "window:…" or "screen:…", as desktopCapturer reports.
 * @property {string} name
 * @property {{ isEmpty(): boolean, resize(o: { width: number, height: number }): unknown } | null} [appIcon]
 */

/**
 * @typedef {object} PickerItem
 * @property {string} [label]
 * @property {"separator"} [type]
 * @property {boolean} [enabled]
 * @property {unknown} [icon]
 * @property {() => void} [click]
 */

const MAX_LABEL = 60;

/**
 * Menu labels treat "&" as an access-key marker on Windows; double it to show it.
 * Long titles are cut so the menu stays a sensible width.
 * @param {string} name
 */
export function menuLabel(name) {
  const t = name.trim();
  const short = t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1)}…` : t;
  return short.replace(/&/g, "&&");
}

/**
 * @template {PickerSource} S
 * @param {readonly S[]} sources
 * @param {(source: S) => void} onPick
 * @param {{ excludeId?: string | null }} [options] `excludeId`: our own window.
 * @returns {PickerItem[]}
 */
export function buildPickerTemplate(sources, onPick, { excludeId = null } = {}) {
  const windows = sources.filter((s) => s.id.startsWith("window:") && s.id !== excludeId && s.name.trim() !== "");
  const screens = sources.filter((s) => s.id.startsWith("screen:"));

  /** @type {PickerItem[]} */
  const items = [];
  if (windows.length > 0) {
    items.push({ label: "Windows", enabled: false });
    for (const s of windows) {
      const icon = s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.resize({ width: 16, height: 16 }) : undefined;
      items.push({ label: menuLabel(s.name), ...(icon ? { icon } : {}), click: () => onPick(s) });
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
