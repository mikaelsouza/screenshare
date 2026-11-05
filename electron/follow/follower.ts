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

import { roleIn, type FollowProfile, type WindowRole } from "./profiles.js";

export interface WindowSource {
  id: string;
  name: string;
}

export interface FollowStatus {
  role: WindowRole | "waiting" | "ended";
  sourceId: string | null;
  title: string | null;
}

export interface Follower {
  current: () => FollowStatus;
  evaluate: (sources: readonly WindowSource[]) => FollowStatus | null;
}

/**
 * The window to follow right now: the game window if open, else the lobby window.
 */
// skipcq: JS-0067, JS-R1005
export function pickSource(
  profile: FollowProfile,
  sources: readonly WindowSource[],
): { source: WindowSource; role: WindowRole } | null {
  let lobby: WindowSource | undefined;
  for (const source of sources) {
    const role = roleIn(profile, source.name);
    if (role === "game") return { source, role };
    if (role === "lobby" && !lobby) lobby = source;
  }
  return lobby ? { source: lobby, role: "lobby" } : null;
}

/**
 * `initial` is the window the user picked, which is already being captured.
 */
// skipcq: JS-0067
export function createFollower(
  profile: FollowProfile,
  // skipcq: JS-T1001
  { initial, now = Date.now }: { initial: WindowSource; now?: (() => number) | undefined },
): Follower {
  const initialRole = roleIn(profile, initial.name);
  let status: FollowStatus = initialRole
    ? { role: initialRole, sourceId: initial.id, title: initial.name }
    : { role: "waiting", sourceId: null, title: null };
  /** When the current wait started; null while a window is open. */
  let waitingSince: number | null = initialRole ? null : now();

  return {
    current(): FollowStatus {
      return { ...status };
    },

    /**
     * Reconcile with the windows open now.
     * @returns The new status, or null when nothing changed.
     */
    // skipcq: JS-R1005
    evaluate(sources: readonly WindowSource[]): FollowStatus | null {
      if (status.role === "ended") return null;
      let next: FollowStatus;
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
