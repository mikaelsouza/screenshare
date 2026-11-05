/**
 * Games whose lobby and match run in two different windows. When the user shares
 * one of these windows in the desktop app, the share follows them between the two
 * (see follower.ts). Every other window is shared exactly as on the web.
 *
 * Matching is on exact window titles: desktopCapturer exposes no process names, and
 * exact titles keep a browser tab like "League of Legends - YouTube" from matching.
 * To support another game, add an entry here.
 */

export interface FollowProfile {
  id: string;
  /** Shown in the UI, e.g. "League of Legends". */
  label: string;
  /** Window titles of the lobby/launcher client. */
  lobbyTitles: readonly string[];
  /** Window titles of the in-game client. */
  gameTitles: readonly string[];
  /** How long to wait with neither window open before the share stops. */
  graceMs: number;
}

export type WindowRole = "lobby" | "game";

export const FOLLOW_PROFILES: readonly FollowProfile[] = [
  {
    id: "league-of-legends",
    label: "League of Legends",
    lobbyTitles: ["League of Legends"],
    gameTitles: ["League of Legends (TM) Client"],
    graceMs: 10_000,
  },
];

/**
 * The role a window plays in one profile, or null if it is not one of its windows.
 */
// skipcq: JS-0067
export function roleIn(profile: FollowProfile, title: string): WindowRole | null {
  const trimmed = title.trim();
  if (profile.gameTitles.includes(trimmed)) return "game";
  if (profile.lobbyTitles.includes(trimmed)) return "lobby";
  return null;
}

/**
 * The profile a picked window belongs to, if any.
 */
// skipcq: JS-0067
export function matchProfile(
  title: string,
  profiles: readonly FollowProfile[] = FOLLOW_PROFILES,
): { profile: FollowProfile; role: WindowRole } | null {
  for (const profile of profiles) {
    const role = roleIn(profile, title);
    if (role) return { profile, role };
  }
  return null;
}
