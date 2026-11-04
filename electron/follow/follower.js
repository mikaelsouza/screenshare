// @ts-check
/**
 * Follows one game between its lobby window and its game window.
 *
 * Pure logic: the caller polls the open windows and passes them in, and time comes
 * from an injected clock, so this has no Electron dependency and is unit-testable.
 *
 * Rules, applied on every evaluate():
 *  - The game window wins whenever it is open (a match in progress).
 *  - Otherwise the lobby window is followed.
 *  - With neither open, the follow is "waiting" (the gap while one closes and the
 *    other opens) until profile.graceMs has passed, and then "ended".
 */

import { roleIn } from "./profiles.js";

/** @typedef {import("./profiles.js").FollowProfile} FollowProfile */
/** @typedef {import("./profiles.js").WindowRole} WindowRole */
/** @typedef {{ id: string, name: string }} WindowSource */
/**
 * @typedef {object} FollowStatus
 * @property {WindowRole | "waiting" | "ended"} role
 * @property {string | null} sourceId
 * @property {string | null} title
 */

/**
 * The window to follow right now: the game window if open, else the lobby window.
 * @param {FollowProfile} profile
 * @param {readonly WindowSource[]} sources
 * @returns {{ source: WindowSource, role: WindowRole } | null}
 */
export function pickSource(profile, sources) {
  /** @type {WindowSource | undefined} */
  let lobby;
  for (const source of sources) {
    const role = roleIn(profile, source.name);
    if (role === "game") return { source, role };
    if (role === "lobby" && !lobby) lobby = source;
  }
  return lobby ? { source: lobby, role: "lobby" } : null;
}

/**
 * @param {FollowProfile} profile
 * @param {{ initial: WindowSource, now?: () => number }} options
 *   `initial` is the window the user picked, which is already being captured.
 */
export function createFollower(profile, { initial, now = Date.now }) {
  const initialRole = roleIn(profile, initial.name);
  /** @type {FollowStatus} */
  let status = initialRole
    ? { role: initialRole, sourceId: initial.id, title: initial.name }
    : { role: "waiting", sourceId: null, title: null };
  /** When the current wait started; null while a window is open. */
  let waitingSince = initialRole ? null : now();

  return {
    /** @returns {FollowStatus} */
    current() {
      return { ...status };
    },

    /**
     * Reconcile with the windows open now.
     * @param {readonly WindowSource[]} sources
     * @returns {FollowStatus | null} The new status, or null when nothing changed.
     */
    evaluate(sources) {
      if (status.role === "ended") return null;
      /** @type {FollowStatus} */
      let next;
      const pick = pickSource(profile, sources);
      if (pick) {
        waitingSince = null;
        next = { role: pick.role, sourceId: pick.source.id, title: pick.source.name };
      } else {
        if (waitingSince === null) waitingSince = now();
        const expired = now() - waitingSince >= profile.graceMs;
        next = { role: expired ? "ended" : "waiting", sourceId: null, title: null };
      }
      if (next.role === status.role && next.sourceId === status.sourceId) return null;
      status = next;
      return { ...next };
    },
  };
}
