const SVG_NS = "http://www.w3.org/2000/svg";

export type IconName =
  | "play"
  | "pause"
  | "volumeOn"
  | "volumeOff"
  | "fitContain"
  | "fitCover"
  | "focus"
  | "unfocus"
  | "pip"
  | "stats"
  | "fullscreen"
  | "exitFullscreen";

const ICON_PATHS: Record<IconName, readonly string[]> = {
  play: ["M6 4l14 8-14 8V4z"],
  pause: ["M6 4h4v16H6zM14 4h4v16h-4z"],
  volumeOn: [
    "M11 5L6 9H2v6h4l5 4V5z",
    "M15.54 8.46a5 5 0 0 1 0 7.07",
    "M19.07 4.93a10 10 0 0 1 0 14.14",
  ],
  volumeOff: ["M11 5L6 9H2v6h4l5 4V5z", "M22 9l-6 6", "M16 9l6 6"],
  fitContain: ["M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"],
  fitCover: ["M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4"],
  focus: ["M12 2v8M8 6h8M6 14h12l-2 6H8l-2-6z"],
  unfocus: ["M4 12h16"],
  pip: ["M3 5h18v14H3z", "M12 11h7v6h-7z"],
  stats: ["M18 20V10M12 20V4M6 20v-6"],
  fullscreen: [
    "M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3",
  ],
  exitFullscreen: [
    "M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3",
  ],
};

/**
 * Trusted-Types-safe SVG icon factory using createElementNS (never innerHTML).
 */
export function createIcon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");

  for (const pathData of ICON_PATHS[name]) {
    const pathEl = document.createElementNS(SVG_NS, "path");
    pathEl.setAttribute("d", pathData);
    svg.append(pathEl);
  }
  return svg;
}

export function setButtonIcon(btn: HTMLButtonElement, icon: IconName): void {
  btn.replaceChildren(createIcon(icon));
}
