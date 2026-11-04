// @ts-check
/**
 * Games whose lobby and match run in two different windows. When the user shares
 * one of these windows in the desktop app, the share follows them between the two
 * (see follower.js). Every other window is shared exactly as on the web.
 *
 * Matching is on exact window titles: desktopCapturer exposes no process names, and
 * exact titles keep a browser tab like "League of Legends - YouTube" from matching.
 * To support another game, add an entry here.
 */

/**
 * @typedef {object} FollowProfile
 * @property {string} id
 * @property {string} label Shown in the UI, e.g. "League of Legends".
 * @property {readonly string[]} lobbyTitles Window titles of the lobby/launcher client.
 * @property {readonly string[]} gameTitles Window titles of the in-game client.
 * @property {number} graceMs How long to wait with neither window open before the share stops.
 */

/** @typedef {"lobby" | "game"} WindowRole */

/** @type {readonly FollowProfile[]} */
export const FOLLOW_PROFILES = [
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
 * @param {FollowProfile} profile
 * @param {string} title
 * @returns {WindowRole | null}
 */
export function roleIn(profile, title) {
  const t = title.trim();
  if (profile.gameTitles.includes(t)) return "game";
  if (profile.lobbyTitles.includes(t)) return "lobby";
  return null;
}

/**
 * The profile a picked window belongs to, if any.
 * @param {string} title
 * @param {readonly FollowProfile[]} [profiles]
 * @returns {{ profile: FollowProfile, role: WindowRole } | null}
 */
export function matchProfile(title, profiles = FOLLOW_PROFILES) {
  for (const profile of profiles) {
    const role = roleIn(profile, title);
    if (role) return { profile, role };
  }
  return null;
}
