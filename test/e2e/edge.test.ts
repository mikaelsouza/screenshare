import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  baseUrl,
  INSTRUMENT,
  launchBrowser,
  startServer,
  stopServer,
  waitFor,
  type ServerHandle,
} from "./helpers.ts";

/**
 * The paths p2p.test.ts does not walk: a password-protected room made with Create,
 * joining after sharing has started, stopping and sharing again, two people sharing
 * at once, the host refreshing, and removal and locking.
 */
const PORT = 8891;
const BASE_URL = baseUrl(PORT);

let server: ServerHandle | undefined;
let browser: Browser | undefined;
let host: Page;
let late: Page;
let other: Page;
const contexts: BrowserContext[] = [];

const status = async (page: Page): Promise<string> => (await page.textContent("#status")) ?? "";

/** Frames decoded so far across every inbound video stream on the page. */
const decodedFrames = async (): Promise<number> => {
  let total = 0;
  for (const pc of window.__pcs) {
    if (pc.connectionState === "closed") continue;
    const report = await pc.getStats();
    report.forEach((statEntry: unknown) => {
      const rec = statEntry as { type?: string; kind?: string; framesDecoded?: number };
      if (rec.type === "inbound-rtp" && rec.kind === "video") total += rec.framesDecoded ?? 0;
    });
  }
  return total;
};

/** Wait until the page's decoded frame count grows past `from`: video is flowing now. */
async function framesGrow(page: Page, label: string, from: number | null = null): Promise<number> {
  const start = from ?? (await page.evaluate(decodedFrames));
  await waitFor(page, decodedFrames, { label: `${label}: any decoded frames`, timeout: 45_000, interval: 1000 });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const now = await page.evaluate(decodedFrames);
    if (now > start + 10) return now;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label}: decoded frames stuck at ${start}`);
}

async function newPage(name: string): Promise<Page> {
  if (!browser) throw new Error("Browser not initialized");
  const ctx = await browser.newContext();
  await ctx.addInitScript(INSTRUMENT);
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error(`[${name}]`, msg.text());
  });
  await page.goto(BASE_URL);
  await page.fill("#display-name", name);
  return page;
}

async function joinWith(page: Page, code: string): Promise<void> {
  await page.fill("#room-code", code);
  await page.click("#join");
}

async function openRoster(page: Page): Promise<void> {
  const hidden = await page.evaluate(() => document.getElementById("roster")?.hidden ?? true);
  if (hidden) await page.click("#roster-btn");
}

async function openInvite(page: Page): Promise<void> {
  const hidden = await page.evaluate(() => document.getElementById("invite-menu")?.hidden ?? true);
  if (hidden) await page.click("#invite-btn");
}

async function readHostInvite(page: Page): Promise<string> {
  await openInvite(page);
  if ((await page.textContent("#invite-show-btn")) === "Show") {
    await page.click("#invite-show-btn");
  }
  const value = ((await page.textContent("#invite-code-value")) ?? "").trim();
  await page.click("#invite-btn");
  return value;
}

const inRoom = (): boolean => Boolean(document.getElementById("status")?.textContent?.includes("In room"));

await describe("edge cases in a real browser", { concurrency: 1 }, async () => {
  let code = "";
  let inviteCode = "";

  before(async () => {
    server = await startServer(PORT);
    browser = await launchBrowser();
    host = await newPage("host");
    late = await newPage("late");
    other = await newPage("other");
  });

  afterEach(async (testCtx) => {
    // On failure, show what each page was saying: the status line is the app's own account.
    if (process.env["E2E_DEBUG"]) {
      const pages: Array<[string, Page]> = [
        ["host", host],
        ["late", late],
        ["other", other],
      ];
      for (const [peerName, peerPage] of pages) {
        const st = await peerPage.textContent("#status").catch(() => "?");
        const err = await peerPage.textContent("#lobby-error").catch(() => "?");
        const roster = await peerPage.textContent("#roster").catch(() => "?");
        console.log(
          `# ${testCtx.name} :: ${peerName}: status=${JSON.stringify(st)} err=${JSON.stringify(err)} roster=${JSON.stringify(roster)}`,
        );
      }
    }
  });

  after(async () => {
    await browser?.close();
    await stopServer(server);
  });

  await it("creates a room with Create and displays the 1C-2 invite menu", async () => {
    await host.click("#create");
    await waitFor(host, inRoom, { label: "host in the new room" });
    assert.equal(await host.evaluate(() => window.location.hash), "", "URL hash must stay empty after Create");
    assert.equal(await host.inputValue("#room-code"), "", "#room-code input should clear on join");

    // 1-click Copy invite link in the split button: menu stays closed, 0px horizontal shift.
    await host.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
    const beforeCopyWidth = await host.evaluate(
      () => document.getElementById("invite-copy-link")?.getBoundingClientRect().width ?? 0,
    );
    assert.ok(beforeCopyWidth > 0, "#invite-copy-link should have non-zero width");
    assert.equal(
      await host.evaluate(() => document.getElementById("invite-menu")?.hidden),
      true,
      "#invite-menu should start hidden",
    );
    await host.click("#invite-copy-link");
    await waitFor(
      host,
      () =>
        document.getElementById("invite-link-feedback")?.textContent === "Copied!" &&
        Boolean(document.getElementById("invite-copy-link")?.classList.contains("invite-feedback-ok")),
      { label: "#invite-copy-link shows Copied! feedback" },
    );
    const afterCopy = await host.evaluate(() => ({
      menuHidden: document.getElementById("invite-menu")?.hidden ?? false,
      afterWidth: document.getElementById("invite-copy-link")?.getBoundingClientRect().width ?? 0,
    }));
    assert.equal(afterCopy.menuHidden, true, "#invite-menu must remain hidden after 1-click copy");
    assert.ok(
      Math.abs(afterCopy.afterWidth - beforeCopyWidth) < 0.5,
      `#invite-copy-link width shifted during Copied! flash: ${String(beforeCopyWidth)} -> ${String(afterCopy.afterWidth)}`,
    );

    // Clipboard failure on #invite-copy-link must auto-open #invite-menu so Show is immediately visible.
    try {
      await host.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => Promise.reject(new Error("clipboard denied")) },
        });
        Object.defineProperty(document, "execCommand", {
          configurable: true,
          value: () => false,
        });
      });
      await host.click("#invite-copy-link");
      await waitFor(host, () => document.getElementById("invite-menu")?.hidden === false, {
        label: "#invite-menu auto-opens on clipboard failure",
      });
      assert.equal(await host.isVisible("#invite-show-btn"), true, "#invite-show-btn must be visible on copy failure");
      await host.click("#invite-btn"); // close popover before continuing
    } finally {
      await host.evaluate(() => {
        Reflect.deleteProperty(navigator, "clipboard");
        Reflect.deleteProperty(document, "execCommand");
      });
    }

    await openInvite(host);
    const masked = ((await host.textContent("#invite-code-value")) ?? "").trim();
    assert.match(masked, /^[A-Z2-9]{8}-\u2022{16}$/, "invite code must be masked by default");
    assert.equal(await host.isVisible("#invite-rotate-btn"), true, "host should see Rotate button");
    await host.click("#invite-show-btn");
    inviteCode = ((await host.textContent("#invite-code-value")) ?? "").trim();
    assert.match(inviteCode, /^[A-Z2-9]{8}-[A-Z2-9]{16}$/);
    code = inviteCode.slice(0, 8);
    await host.click("#invite-btn"); // close popover

    await openRoster(host);
    assert.equal(await host.isVisible("#lock-btn"), true, "the creator should be host");
    await host.click("#roster-btn"); // close so incoming join lights unread dot
  });

  await it("shows inline lobby errors for invalid/wrong invites, lets valid invite in, and lights 2AB-2 join awareness", async () => {
    await joinWith(other, "BAD");
    await waitFor(
      other,
      () => {
        const el = document.getElementById("lobby-error");
        return Boolean(el && !el.hidden && /invalid/i.test(el.textContent ?? ""));
      },
      { label: "invalid invite error in #lobby-error" },
    );
    await joinWith(other, code);
    await waitFor(
      other,
      () => {
        const el = document.getElementById("lobby-error");
        return Boolean(el && !el.hidden && /CODE-SECRET/i.test(el.textContent ?? ""));
      },
      { label: "missing secret error in #lobby-error" },
    );
    await joinWith(other, `${code}-23456789ABCDEFGH`);
    await waitFor(
      other,
      () => {
        const el = document.getElementById("lobby-error");
        return Boolean(el && !el.hidden && /Invalid or expired room invite/i.test(el.textContent ?? ""));
      },
      { label: "wrong secret error in #lobby-error" },
    );
    assert.equal(await other.evaluate(() => window.__pcs.length), 0);

    // Joining with the full CODE-SECRET invite succeeds and clears both #lobby-error and #status.
    await host.bringToFront();
    await joinWith(other, inviteCode);
    await waitFor(other, inRoom, { label: "other in the room with the valid invite" });
    assert.equal(await other.evaluate(() => Boolean(document.getElementById("status")?.hidden)), true);
    assert.equal(await other.evaluate(() => Boolean(document.getElementById("lobby-error")?.hidden)), true);

    await waitFor(
      host,
      () => !document.getElementById("roster-unread-dot")?.hidden && !document.getElementById("join-chip")?.hidden,
      { label: "host to see 2AB-2 unread dot and join chip" },
    );
    await openRoster(host);
    assert.equal(
      await host.evaluate(() => Boolean(document.getElementById("roster-unread-dot")?.hidden)),
      true,
      "opening roster clears unread dot",
    );
    await host.click("#roster-btn");
  });

  await it("delivers video to someone who joins after sharing started and auto-remasks invite secret on share", async () => {
    await openInvite(host);
    await host.click("#invite-show-btn");
    assert.equal(await host.textContent("#invite-show-btn"), "Hide");
    await host.click("#share");
    await waitFor(
      host,
      () => (document.getElementById("invite-code-value")?.textContent ?? "").includes("\u2022"),
      { label: "starting share auto-remasks revealed secret" },
    );
    // The picker is asked for a window and never this tab, so a share does not
    // default to the whole screen or show the app to itself.
    const [opts] = await host.evaluate(() => window.__gdmOpts);
    const optsRecord = opts as Record<string, unknown> | undefined;
    assert.equal(optsRecord?.["selfBrowserSurface"], "exclude");
    assert.equal(optsRecord?.["windowAudio"], "window");
    assert.equal(optsRecord?.["systemAudio"], "include");
    const videoOpts = opts?.video as MediaTrackConstraints | undefined;
    assert.equal(videoOpts?.displaySurface, "window");
    await framesGrow(other, "other viewer");
    await joinWith(late, inviteCode);
    await waitFor(late, inRoom, { label: "late joiner in the room" });
    await framesGrow(late, "late joiner");
  });

  await it("delivers video again after the sharer stops and shares again", async () => {
    await host.click("#share"); // stop
    await waitFor(host, () => window.__pcs.every((pc) => pc.connectionState === "closed"), {
      label: "links to close after stopping",
    });
    await host.click("#share"); // share again
    await framesGrow(late, "late joiner after re-share", 0);
    await framesGrow(other, "other viewer after re-share", 0);
  });

  await it("carries video both ways when two people share at once, and pauses when scrolled out of stage", async () => {
    await late.click("#share");
    // The host now receives from late while still sending to everyone.
    await framesGrow(host, "host receiving from the second sharer");
    await framesGrow(late, "second sharer still receiving the host");
    // The viewer who does not share gets both.
    await waitFor(
      other,
      () =>
        [...document.querySelectorAll<HTMLVideoElement>(".tile video")].filter(
          (videoEl) => videoEl.srcObject instanceof MediaStream && videoEl.srcObject.getVideoTracks().length > 0,
        ).length >= 2,
      { label: "viewer to show two shared screens", timeout: 45_000 },
    );

    // Push the first remote tile on `other` outside `#stage`'s viewport so IntersectionObserver
    // marks it non-intersecting and pauses the sharer's outbound encoding for `other`:
    await other.evaluate(() => {
      const tile = document.querySelector<HTMLElement>(".tile:has(.tile-controls)");
      if (tile) tile.style.transform = "translateY(3000px)";
    });
    await waitFor(
      host,
      () =>
        window.__pcs
          .filter((pc) => pc.connectionState !== "closed")
          .flatMap((pc) => pc.getSenders())
          .filter((sender) => sender.track?.kind === "video")
          .some((sender) => sender.getParameters().encodings[0]?.active === false),
      { label: "sharer to pause outbound encoding when viewer tile is outside stage viewport", timeout: 15_000 },
    );
    // Restore the tile into `#stage` viewport and verify outbound encoding resumes:
    await other.evaluate(() => {
      const tile = document.querySelector<HTMLElement>(".tile:has(.tile-controls)");
      if (tile) tile.style.transform = "";
    });
    await waitFor(
      host,
      () =>
        window.__pcs
          .filter((pc) => pc.connectionState !== "closed")
          .flatMap((pc) => pc.getSenders())
          .filter((sender) => sender.track?.kind === "video")
          .every((sender) => sender.getParameters().encodings[0]?.active !== false),
      { label: "sharer to resume outbound encoding when viewer tile re-enters stage viewport", timeout: 15_000 },
    );

    await late.click("#share"); // stop again for the rest of the suite
  });

  await it("keeps the host a host across a page refresh", async () => {
    await host.reload();
    // A refresh auto-rejoins via sessionStorage.activeRoom and stored hostToken without URL hash.
    await waitFor(host, inRoom, { label: "host back in the room" });
    await openRoster(host);
    await waitFor(host, () => !document.getElementById("lock-btn")?.hidden, { label: "host controls after refresh" });
    // The others see exactly one host role-badge, not a ghost of the old socket.
    await waitFor(
      other,
      () =>
        [...document.querySelectorAll("#roster-list .role-badge")].filter((el) => el.textContent === "host")
          .length === 1,
      { label: "one host in the viewer's list" },
    );
  });

  await it("auto-rotates invite on removal, blocks removed member's old & new invite, and locks newcomers out", async () => {
    // The refresh above ended the host's share; nobody is sharing now.
    assert.equal(await host.textContent("#share"), "Share screen");
    await openRoster(host);
    await waitFor(host, () => document.querySelectorAll("#roster-list button").length === 2, {
      label: "Remove buttons for both others",
    });
    const kickTitle = await host.getAttribute("#roster-list li:has-text('late') button.kick-btn", "title");
    assert.ok(
      kickTitle && /rotate the invite link/i.test(kickTitle),
      `expected Remove tooltip to explain invite rotation, got ${JSON.stringify(kickTitle)}`,
    );
    const oldInvite = inviteCode;
    await host.click("#roster-list li:has-text('late') button");
    await waitFor(
      host,
      () => {
        const st = document.getElementById("status");
        return Boolean(
          st &&
            !st.hidden &&
            st.dataset["kind"] === "warn" &&
            (st.textContent ?? "").includes("invite link rotated"),
        );
      },
      { label: "host sees warning notice that invite link rotated after removal" },
    );
    await waitFor(
      late,
      () => {
        const err = document.getElementById("lobby-error");
        return Boolean(err && !err.hidden && (err.textContent ?? "").includes("removed"));
      },
      { label: "late to be told in #lobby-error it was removed" },
    );
    // Removal cuts the media, not just the list entry.
    await waitFor(late, () => window.__pcs.every((pc) => pc.connectionState === "closed"), {
      label: "the removed person's connections to close",
    });
    // Old invite link fails immediately due to auto-rotation on kick.
    await joinWith(late, oldInvite);
    await waitFor(
      late,
      () => {
        const err = document.getElementById("lobby-error");
        return Boolean(err && !err.hidden && /Invalid or expired room invite/i.test(err.textContent ?? ""));
      },
      { label: "kicked member using old link sees invalid invite" },
    );

    inviteCode = await readHostInvite(host);
    assert.notEqual(inviteCode, oldInvite, "removing a peer must rotate the room secret");
    // Even with the newly rotated invite, the removed IP is refused.
    await joinWith(late, inviteCode);
    await waitFor(
      late,
      () => {
        const err = document.getElementById("lobby-error");
        return Boolean(err && !err.hidden && (err.textContent ?? "").includes("removed"));
      },
      { label: "rejoin with new invite to be refused as removed" },
    );
    assert.equal((await status(late)).includes("In room"), false);

    await openRoster(host);
    await host.click("#lock-btn");
    await waitFor(host, () => document.getElementById("lock-btn")?.textContent === "Unlock room", {
      label: "room locked",
    });
    // Locked non-host member cannot view or copy the invite secret while locked.
    await openInvite(other);
    await waitFor(
      other,
      () =>
        !document.getElementById("invite-locked-note")?.hidden &&
        (document.getElementById("invite-copy-link") as HTMLButtonElement | null)?.disabled === true &&
        (document.getElementById("invite-copy-link") as HTMLButtonElement | null)?.title ===
          "Room is locked \u2014 unlock to invite" &&
        (document.getElementById("invite-show-btn") as HTMLButtonElement | null)?.disabled === true,
      { label: "other sees invite disabled while room locked" },
    );
    await other.click("#invite-btn");

    // A newcomer with the rotated invite must still be refused while locked (or IP-banned).
    const newcomer = await newPage("newcomer");
    await joinWith(newcomer, inviteCode);
    await waitFor(
      newcomer,
      () => {
        const err = document.getElementById("lobby-error");
        return Boolean(err && !err.hidden && /locked|removed/.test(err.textContent ?? ""));
      },
      { label: "newcomer to be refused" },
    );
    assert.equal(await newcomer.evaluate(() => window.__pcs.length), 0);
    await waitFor(other, () => document.querySelectorAll("#roster-list li").length === 2, {
      label: "other still in the room with the host",
    });
  });

  await it("lets a member back into the locked room after a refresh", async () => {
    // A refresh is a reconnect. The locked room must recognise a member who was
    // already in via its rejoinToken, even though every page here shares the removed person's address.
    await other.reload();
    await waitFor(other, inRoom, { label: "member back in the locked room" });
    await waitFor(other, () => (document.getElementById("roster-title")?.textContent ?? "").includes("locked"), {
      label: "member to see the room is locked",
    });
    await waitFor(other, () => (document.getElementById("roster-btn")?.textContent ?? "").includes("Locked"), {
      label: "member top-bar button to show Locked indicator",
    });
  });

  await it("unlocks, rotates invites on demand, and stops sharing when the sharer is removed", async () => {
    await openRoster(host);
    await host.click("#lock-btn"); // unlock
    await waitFor(host, () => document.getElementById("lock-btn")?.textContent === "Lock room", { label: "unlocked" });

    // Other member regains copyable invite secret once unlocked, and host can rotate on demand.
    await openInvite(other);
    await waitFor(
      other,
      () =>
        Boolean(document.getElementById("invite-locked-note")?.hidden) &&
        (document.getElementById("invite-copy-link") as HTMLButtonElement | null)?.disabled === false &&
        (document.getElementById("invite-copy-link") as HTMLButtonElement | null)?.title === "Copy invite link",
      { label: "other regains invite controls after unlock" },
    );
    await other.click("#invite-btn");

    const beforeRotate = inviteCode;
    await openInvite(host);
    await host.click("#invite-rotate-btn");
    await waitFor(host, () => document.getElementById("invite-rotate-btn")?.textContent === "Rotated!", {
      label: "host sees Rotated! feedback",
    });
    await host.click("#invite-show-btn");
    await waitFor(
      host,
      () => /^[A-Z2-9]{8}-[A-Z2-9]{16}$/.test(document.getElementById("invite-code-value")?.textContent?.trim() ?? ""),
      { label: "rotated invite code is revealed" },
    );
    inviteCode = ((await host.textContent("#invite-code-value")) ?? "").trim();
    assert.notEqual(inviteCode, beforeRotate, "Rotate must mint a new invite secret");
    await host.click("#invite-btn");

    // The removal ban is by address and every page here is 127.0.0.1, so the second
    // person to remove has to be someone already inside: the other member.
    await other.click("#share");
    await waitFor(host, () => document.querySelectorAll("#roster-list .badge").length === 1, {
      label: "host to see other sharing",
    });
    await openRoster(host);
    await host.click("#roster-list li:has-text('other') button");
    await waitFor(
      other,
      () => {
        const err = document.getElementById("lobby-error");
        return Boolean(err && !err.hidden && (err.textContent ?? "").includes("removed"));
      },
      { label: "other to be told in #lobby-error it was removed" },
    );
    // The screen capture itself is stopped, not left running for the next room.
    await waitFor(other, () => document.getElementById("share")?.textContent === "Share screen", {
      label: "the share button to reset",
    });
    await waitFor(
      other,
      () => (window.__gdmStreams ?? []).every((st) => st.getTracks().every((track) => track.readyState === "ended")),
      { label: "every captured track to be stopped" },
    );
    // Removing `other` also auto-rotated the room secret; read the latest invite before leaving.
    inviteCode = await readHostInvite(host);
  });

  await it("maintains 52px bars, header button order, and zero horizontal overflow across viewport resizes", async () => {
    const viewports: Array<[number, number]> = [
      [1440, 900],
      [1024, 768],
      [800, 600],
      [390, 844],
    ];
    try {
      for (const [width, height] of viewports) {
        await host.setViewportSize({ width, height });
        const metrics = await host.evaluate(() => {
          const headerRect = document.querySelector("header.app-bar")?.getBoundingClientRect();
          const controlsRect = document.getElementById("controls")?.getBoundingClientRect();
          const inviteCopyEl = document.getElementById("invite-copy-link");
          const inviteCopyRect = inviteCopyEl?.getBoundingClientRect();
          const inviteCopyLabel = inviteCopyEl?.querySelector<HTMLElement>(".invite-copy-label");
          const inviteCopyLabelRect = inviteCopyLabel?.getBoundingClientRect();
          const inviteBtnRect = document.getElementById("invite-btn")?.getBoundingClientRect();
          const rosterBtnRect = document.getElementById("roster-btn")?.getBoundingClientRect();
          return {
            headerHeight: Math.round(headerRect?.height ?? 0),
            controlsHeight: Math.round(controlsRect?.height ?? 0),
            inviteLeftOfRoster: Boolean(inviteBtnRect && rosterBtnRect && inviteBtnRect.right <= rosterBtnRect.left),
            inviteCopyWidth: Math.round(inviteCopyRect?.width ?? 0),
            inviteCopyHeight: Math.round(inviteCopyRect?.height ?? 0),
            inviteCopyLabelDisplay: inviteCopyLabel ? getComputedStyle(inviteCopyLabel).display : "",
            inviteCopyLabelWidth: Math.round(inviteCopyLabelRect?.width ?? 0),
            inviteCopyLabelHeight: Math.round(inviteCopyLabelRect?.height ?? 0),
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
          };
        });
        assert.equal(metrics.headerHeight, 52, `header height at ${String(width)}x${String(height)}`);
        assert.equal(metrics.controlsHeight, 52, `controls height at ${String(width)}x${String(height)}`);
        assert.equal(metrics.inviteLeftOfRoster, true, `header button order at ${String(width)}x${String(height)}`);
        assert.ok(
          metrics.scrollWidth <= metrics.innerWidth,
          `horizontal overflow at ${String(width)}x${String(height)}: ${String(metrics.scrollWidth)} > ${String(metrics.innerWidth)}`,
        );
        if (width <= 680) {
          assert.equal(
            metrics.inviteCopyWidth,
            32,
            `#invite-copy-link width at ${String(width)}x${String(height)} should collapse to 32px`,
          );
          assert.equal(
            metrics.inviteCopyHeight,
            32,
            `#invite-copy-link height at ${String(width)}x${String(height)} should be 32px`,
          );
          assert.notEqual(
            metrics.inviteCopyLabelDisplay,
            "none",
            `.invite-copy-label must remain in the accessibility tree at ${String(width)}x${String(height)}`,
          );
          assert.ok(
            metrics.inviteCopyLabelWidth <= 1 && metrics.inviteCopyLabelHeight <= 1,
            `.invite-copy-label must be visually hidden at ${String(width)}x${String(height)}, got ${String(metrics.inviteCopyLabelWidth)}x${String(metrics.inviteCopyLabelHeight)}`,
          );
        }
      }
    } finally {
      await host.setViewportSize({ width: 1280, height: 720 });
    }
  });

  await it("returns to the lobby when clicking the top-left Screenshare brand title", async () => {
    assert.equal(
      await host.evaluate(() => (document.getElementById("brand-home") as HTMLButtonElement | null)?.disabled),
      false,
      "#brand-home must be enabled while in a room",
    );
    await host.click("#brand-home");
    await waitFor(
      host,
      () =>
        document.getElementById("lobby")?.hidden === false &&
        document.getElementById("room-bar")?.hidden === true &&
        (document.getElementById("brand-home") as HTMLButtonElement | null)?.disabled === true &&
        window.location.hash === "",
      { label: "host to return to the lobby when clicking #brand-home" },
    );
  });

  await it("preserves host controls across Return to lobby and sessionStorage reset when revisiting the invite link", async () => {
    // Rejoin first, then explicitly click Return to lobby (#brand-home) inside this test so clearRoomSession() is exercised directly.
    await joinWith(host, inviteCode);
    await waitFor(host, inRoom, { label: "host enters room before clicking Return to lobby" });
    await host.click("#brand-home");
    await waitFor(
      host,
      () => document.getElementById("lobby")?.hidden === false && document.getElementById("room-bar")?.hidden === true,
      { label: "host returns to lobby via #brand-home" },
    );

    // clearRoomSession() must not wipe localStorage host-rooms, and sessionStorage should never retain a redundant host: copy.
    const afterLobby = await host.evaluate((roomCode) => ({
      legacyHostSession: sessionStorage.getItem(`host:${roomCode}`),
      persistedHosts: localStorage.getItem("host-rooms") ?? "",
      forgetLobbyHidden: document.getElementById("lobby-forget-hosts")?.hidden ?? true,
    }), code);
    assert.equal(afterLobby.legacyHostSession, null, "sessionStorage must not keep a redundant host: copy");
    assert.ok(afterLobby.persistedHosts.includes(code), "Return to lobby must keep host-rooms entry in localStorage");
    assert.equal(afterLobby.forgetLobbyHidden, false, "#lobby-forget-hosts should be visible while saved host rooms exist");

    await joinWith(host, inviteCode);
    await waitFor(host, inRoom, { label: "host re-enters room via invite after Return to lobby" });
    await openRoster(host);
    await waitFor(host, () => !document.getElementById("lock-btn")?.hidden, {
      label: "host retains #lock-btn after Return to lobby",
    });

    // Simulate closing the browser/desktop app (clearing tab-scoped sessionStorage while preserving localStorage).
    await host.evaluate(() => {
      sessionStorage.clear();
    });
    await host.goto("about:blank");
    await host.goto(`${BASE_URL}/#${inviteCode}`);
    await waitFor(host, inRoom, { label: "host re-enters room via invite link after sessionStorage reset" });
    assert.equal(await host.evaluate(() => window.location.hash), "", "URL hash must be scrubbed on revisit");
    await openRoster(host);
    await waitFor(host, () => !document.getElementById("lock-btn")?.hidden, {
      label: "host retains #lock-btn via persisted localStorage hostToken",
    });

    // Verify localStorage stores only hostToken metadata and never the invite secret or sessionStorage host: copy.
    const [, secretPart = ""] = inviteCode.split("-");
    assert.ok(secretPart.length > 0);
    const storageSnapshot = await host.evaluate((roomCode) => ({
      storedRaw: localStorage.getItem("host-rooms") ?? "",
      legacyHostSession: sessionStorage.getItem(`host:${roomCode}`),
    }), code);
    assert.ok(storageSnapshot.storedRaw.includes(code), "localStorage host-rooms should track the hosted room code");
    assert.equal(storageSnapshot.storedRaw.includes(secretPart), false, "localStorage must never store the invite secret");
    assert.equal(storageSnapshot.legacyHostSession, null, "sessionStorage must not retain host: key");

    // Verify the explicit Forget host button inside Invite ▾ removes persisted host access on this device.
    await openInvite(host);
    await waitFor(host, () => document.getElementById("invite-forget-host")?.hidden === false, {
      label: "#invite-forget-host button is visible for saved creator room",
    });
    await host.click("#invite-forget-host");
    await waitFor(
      host,
      () => localStorage.getItem("host-rooms") === null,
      { label: "localStorage host-rooms cleared after clicking Forget host on this device" },
    );
    await waitFor(
      host,
      () => (document.getElementById("status")?.textContent ?? "").includes("Removed saved host access"),
      { label: "status confirms host access removed on this device" },
    );
    await host.click("#brand-home");
    await waitFor(
      host,
      () =>
        document.getElementById("lobby")?.hidden === false &&
        document.getElementById("lobby-forget-hosts")?.hidden === true,
      { label: "#lobby-forget-hosts hides once all saved host rooms are forgotten" },
    );

    // Create another room to test #lobby-forget-hosts, including purging legacy host: entries from sessionStorage.
    await host.click("#create");
    await waitFor(host, inRoom, { label: "host creates second room" });
    await host.click("#brand-home");
    await waitFor(
      host,
      () =>
        document.getElementById("lobby")?.hidden === false &&
        document.getElementById("lobby-forget-hosts")?.hidden === false,
      { label: "#lobby-forget-hosts is visible for newly created room" },
    );
    await host.evaluate(() => {
      sessionStorage.setItem("host:MNPQRSTU", "legacy-token");
      sessionStorage.setItem("unrelatedKey", "keep");
    });
    await host.click("#lobby-forget-hosts");
    await waitFor(
      host,
      () =>
        localStorage.getItem("host-rooms") === null &&
        sessionStorage.getItem("host:MNPQRSTU") === null &&
        sessionStorage.getItem("unrelatedKey") === "keep" &&
        document.getElementById("lobby-forget-hosts")?.hidden === true,
      { label: "#lobby-forget-hosts clears host-rooms and legacy host: entries while keeping unrelated sessionStorage keys" },
    );
  });

  await it("serves /privacy.html with strict CSP headers and zero CSP violations", async () => {
    const manualRes = await fetch(`${BASE_URL}/privacy.html`, { redirect: "manual" });
    assert.equal(manualRes.status, 307);
    assert.equal(manualRes.headers.get("location"), "/privacy");
    const res = await fetch(`${BASE_URL}/privacy.html`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.ok(csp.includes("require-trusted-types-for 'script'"), `expected strict CSP header, got ${JSON.stringify(csp)}`);
    const html = await res.text();
    assert.ok(html.includes("Privacy Policy"));
    assert.ok(html.includes("Webmikas"));

    if (!browser) throw new Error("Browser not initialized");
    const ctx = await browser.newContext();
    try {
      await ctx.addInitScript(INSTRUMENT);
      const page = await ctx.newPage();
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      await page.goto(`${BASE_URL}/privacy.html`);
      const heading = await page.textContent("h1");
      assert.ok(heading?.includes("Privacy Policy"), `expected Privacy Policy heading, got ${JSON.stringify(heading)}`);
      assert.deepEqual(await page.evaluate(() => window.__csp), [], "privacy page hit a CSP violation");
      assert.deepEqual(consoleErrors, [], `privacy page logged console errors: ${consoleErrors.join("; ")}`);
    } finally {
      await ctx.close();
    }
  });

  await it("raised no CSP or Trusted Types violation on any page", async () => {
    const pages: Array<[string, Page]> = [
      ["host", host],
      ["late", late],
      ["other", other],
    ];
    for (const [name, page] of pages) {
      assert.deepEqual(await page.evaluate(() => window.__csp), [], `${name} hit a CSP violation`);
    }
  });
});
