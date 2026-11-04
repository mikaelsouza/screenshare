import { describe, expect, it } from "vitest";
import { FOLLOW_PROFILES, matchProfile, roleIn, type FollowProfile } from "@electron/follow/profiles.js";
import { createFollower, pickSource } from "@electron/follow/follower.js";

const LEAGUE = FOLLOW_PROFILES.find((p) => p.id === "league-of-legends")!;

/** A made-up second game, so nothing here quietly depends on League. */
const OTHER: FollowProfile = {
  id: "other",
  label: "Other Game",
  lobbyTitles: ["Other Launcher", "Other Launcher (Beta)"],
  gameTitles: ["Other Game"],
  graceMs: 3_000,
};

const lobby = { id: "window:1:0", name: "League of Legends" };
const game = { id: "window:2:0", name: "League of Legends (TM) Client" };
const discord = { id: "window:3:0", name: "Discord" };

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("profiles", () => {
  it("ships League with its lobby and game window titles", () => {
    expect(LEAGUE).toMatchObject({
      label: "League of Legends",
      lobbyTitles: ["League of Legends"],
      gameTitles: ["League of Legends (TM) Client"],
      graceMs: 10_000,
    });
  });

  it("tells the lobby window from the game window", () => {
    expect(roleIn(LEAGUE, "League of Legends")).toBe("lobby");
    expect(roleIn(LEAGUE, "League of Legends (TM) Client")).toBe("game");
    expect(roleIn(LEAGUE, "  League of Legends (TM) Client  ")).toBe("game");
  });

  it.each([
    "League of Legends - YouTube",
    "league of legends",
    "League of Legends (TM) Client - Notepad",
    "Discord",
    "",
  ])("does not match a lookalike title: %j", (title) => {
    expect(roleIn(LEAGUE, title)).toBeNull();
    expect(matchProfile(title)).toBeNull();
  });

  it("finds the profile a picked window belongs to", () => {
    expect(matchProfile("League of Legends")).toEqual({ profile: LEAGUE, role: "lobby" });
    expect(matchProfile("Other Launcher (Beta)", [LEAGUE, OTHER])).toEqual({ profile: OTHER, role: "lobby" });
    expect(matchProfile("Other Game", [LEAGUE, OTHER])).toEqual({ profile: OTHER, role: "game" });
    expect(matchProfile("Other Game")).toBeNull();
  });
});

describe("pickSource", () => {
  it("prefers the game window whenever it is open", () => {
    expect(pickSource(LEAGUE, [lobby, discord, game])).toEqual({ source: game, role: "game" });
    expect(pickSource(LEAGUE, [game, lobby])).toEqual({ source: game, role: "game" });
  });

  it("falls back to the first lobby window", () => {
    const second = { id: "window:9:0", name: "League of Legends" };
    expect(pickSource(LEAGUE, [discord, lobby, second])).toEqual({ source: lobby, role: "lobby" });
  });

  it("returns null with neither window open", () => {
    expect(pickSource(LEAGUE, [discord])).toBeNull();
    expect(pickSource(LEAGUE, [])).toBeNull();
  });
});

describe.each([
  ["League", LEAGUE, lobby, game],
  ["a second profile", OTHER, { id: "window:7:0", name: "Other Launcher" }, { id: "window:8:0", name: "Other Game" }],
] as const)("createFollower with %s", (_name, profile, lobbyWin, gameWin) => {
  it("starts on the picked window", () => {
    const f = createFollower(profile, { initial: lobbyWin, now: clock().now });
    expect(f.current()).toEqual({ role: "lobby", sourceId: lobbyWin.id, title: lobbyWin.name });
    expect(f.evaluate([lobbyWin, discord])).toBeNull();
  });

  it("follows lobby → game → waiting → lobby", () => {
    const c = clock();
    const f = createFollower(profile, { initial: lobbyWin, now: c.now });

    expect(f.evaluate([lobbyWin, gameWin])).toEqual({ role: "game", sourceId: gameWin.id, title: gameWin.name });
    expect(f.evaluate([gameWin])).toBeNull();

    c.advance(1);
    expect(f.evaluate([discord])).toEqual({ role: "waiting", sourceId: null, title: null });
    c.advance(profile.graceMs - 2);
    expect(f.evaluate([])).toBeNull();

    expect(f.evaluate([lobbyWin])).toEqual({ role: "lobby", sourceId: lobbyWin.id, title: lobbyWin.name });
  });

  it("ends exactly when the grace period runs out", () => {
    const c = clock();
    const f = createFollower(profile, { initial: gameWin, now: c.now });
    expect(f.evaluate([])?.role).toBe("waiting");
    c.advance(profile.graceMs - 1);
    expect(f.evaluate([])).toBeNull();
    c.advance(1);
    expect(f.evaluate([])).toEqual({ role: "ended", sourceId: null, title: null });
    // Over for good: a window coming back later does not restart it.
    expect(f.evaluate([lobbyWin])).toBeNull();
    expect(f.current().role).toBe("ended");
  });

  it("restarts the grace period on every new wait", () => {
    const c = clock();
    const f = createFollower(profile, { initial: lobbyWin, now: c.now });
    f.evaluate([]);
    c.advance(profile.graceMs - 1);
    f.evaluate([gameWin]);
    c.advance(10);
    expect(f.evaluate([])?.role).toBe("waiting");
    c.advance(profile.graceMs - 1);
    expect(f.evaluate([])).toBeNull();
    c.advance(1);
    expect(f.evaluate([])?.role).toBe("ended");
  });

  it("reports a new window of the same role", () => {
    const f = createFollower(profile, { initial: lobbyWin, now: clock().now });
    const reopened = { id: "window:99:0", name: lobbyWin.name };
    expect(f.evaluate([reopened])).toEqual({ role: "lobby", sourceId: reopened.id, title: reopened.name });
  });

  it("waits from the start if the picked window is not one of the profile's", () => {
    const c = clock();
    const f = createFollower(profile, { initial: discord, now: c.now });
    expect(f.current()).toEqual({ role: "waiting", sourceId: null, title: null });
    c.advance(profile.graceMs);
    expect(f.evaluate([])?.role).toBe("ended");
  });

  it("hands out copies, not its own state", () => {
    const f = createFollower(profile, { initial: lobbyWin, now: clock().now });
    const s = f.current();
    s.role = "ended";
    expect(f.current().role).toBe("lobby");
  });
});
