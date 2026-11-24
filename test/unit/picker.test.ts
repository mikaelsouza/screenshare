import { describe, expect, it, vi } from "vitest";
import { buildPickerTemplate, formatWindowLabel, menuLabel, type PickerSource } from "@electron/picker.js";

function icon(empty = false) {
  return { isEmpty: () => empty, resize: vi.fn(() => "resized-icon") };
}

describe("menuLabel", () => {
  it("doubles ampersands so Windows shows them instead of an access key", () => {
    expect(menuLabel("Tom & Jerry")).toBe("Tom && Jerry");
  });

  it("trims and cuts long titles", () => {
    expect(menuLabel("  short  ")).toBe("short");
    const long = "x".repeat(80);
    const label = menuLabel(long);
    expect(label).toHaveLength(60);
    expect(label.endsWith("…")).toBe(true);
    expect(menuLabel("y".repeat(60))).toBe("y".repeat(60));
  });
});

describe("buildPickerTemplate", () => {
  const lol = { id: "window:1:0", name: "League of Legends", appIcon: icon() };
  const self = { id: "window:2:0", name: "Screenshare" };
  const untitled = { id: "window:3:0", name: "   " };
  const screen1 = { id: "screen:0:0", name: "Entire screen" };
  const screen2 = { id: "screen:1:0", name: "" };

  it("lists windows then screens, like Chrome's picker", () => {
    const items = buildPickerTemplate([screen1, lol, self, untitled, screen2], () => {}, { excludeId: self.id });
    expect(items.map((i) => i.type ?? i.label)).toEqual([
      "Windows",
      "League of Legends",
      "separator",
      "Screens",
      "Entire screen",
      "Screen 2",
    ]);
    expect(items[0]).toEqual({ label: "Windows", enabled: false });
    expect(items[3]).toEqual({ label: "Screens", enabled: false });
  });

  it("calls back with the clicked source", () => {
    const onPick = vi.fn();
    const items = buildPickerTemplate([lol, screen1], onPick);
    items.find((i) => i.label === "League of Legends")!.click!();
    expect(onPick).toHaveBeenLastCalledWith(lol);
    items.find((i) => i.label === "Entire screen")!.click!();
    expect(onPick).toHaveBeenLastCalledWith(screen1);
  });

  it("shows window icons when there are any", () => {
    const items = buildPickerTemplate([lol, { id: "window:5:0", name: "No icon", appIcon: icon(true) }], () => {});
    expect(items[1]!.icon).toBe("resized-icon");
    expect(lol.appIcon.resize).toHaveBeenCalledWith({ width: 16, height: 16 });
    expect(items[2]).not.toHaveProperty("icon");
  });

  it("has no separator or empty sections", () => {
    expect(buildPickerTemplate([screen1], () => {}).map((i) => i.label)).toEqual(["Screens", "Entire screen"]);
    expect(buildPickerTemplate([lol], () => {}).map((i) => i.label)).toEqual(["Windows", "League of Legends"]);
    expect(buildPickerTemplate([], () => {})).toEqual([]);
  });

  it("orders active, minimized, and disabled elevated windows before screens", () => {
    const elevated: PickerSource = { id: "window:10:0", name: "Task Manager", state: "elevated" };
    const minimized: PickerSource = { id: "window:11:0", name: "League of Legends", state: "minimized", appIcon: icon() };
    const active: PickerSource = { id: "window:12:0", name: "Discord", state: "normal" };
    const onPick = vi.fn();

    const items = buildPickerTemplate([elevated, screen1, minimized, active], onPick);
    expect(items.map((i) => i.type ?? i.label)).toEqual([
      "Windows",
      "Discord",
      "League of Legends (minimized)",
      "Task Manager (Run as Admin to share)",
      "separator",
      "Screens",
      "Entire screen",
    ]);

    const minItem = items.find((i) => i.label === "League of Legends (minimized)")!;
    minItem.click!();
    expect(onPick).toHaveBeenCalledWith(minimized);

    const elevItem = items.find((i) => i.label === "Task Manager (Run as Admin to share)")!;
    expect(elevItem.enabled).toBe(false);
    expect(elevItem.click).toBeUndefined();
    expect(elevItem.icon).toBeUndefined();
  });

  it("truncates long titles before appending suffixes and escapes ampersands", () => {
    const label = formatWindowLabel("A & B " + "x".repeat(80), " (minimized)");
    expect(label.endsWith(" (minimized)")).toBe(true);
    expect(label.startsWith("A && B ")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(61);
  });
});
