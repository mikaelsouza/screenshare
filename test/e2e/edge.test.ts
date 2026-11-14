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

const inRoom = (): boolean => Boolean(document.getElementById("status")?.textContent?.includes("In room"));

await describe("edge cases in a real browser", { concurrency: 1 }, async () => {
  let code = "";

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
        const roster = await peerPage.textContent("#roster").catch(() => "?");
        console.log(`# ${testCtx.name} :: ${peerName}: status=${JSON.stringify(st)} roster=${JSON.stringify(roster)}`);
      }
    }
  });

  after(async () => {
    await browser?.close();
    await stopServer(server);
  });

  await it("creates a room with Create and displays the merged copy-link button", async () => {
    await host.click("#create");
    await waitFor(host, inRoom, { label: "host in the new room" });
    code = await host.inputValue("#room-code");
    assert.match(code, /^[A-Z2-9]{8}$/);
    const copyText = await host.textContent("#copy-link");
    assert.equal(copyText, `${code} · Copy link`);
    await openRoster(host);
    assert.equal(await host.isVisible("#lock-btn"), true, "the creator should be host");
  });

  await it("turns away an invalid room code and lets a valid room code in", async () => {
    await joinWith(other, "BAD");
    await waitFor(
      other,
      () => {
        const el = document.getElementById("status");
        return Boolean(el && !el.hidden && /valid room code/i.test(el.textContent ?? ""));
      },
      { label: "invalid room code error to be shown" },
    );
    assert.equal(await other.evaluate(() => window.__pcs.length), 0);
    // Joining with the valid room code from the same page must succeed and hide #status again.
    await joinWith(other, code);
    await waitFor(other, inRoom, { label: "other in the room with the valid code" });
    assert.equal(await other.evaluate(() => Boolean(document.getElementById("status")?.hidden)), true);
  });

  await it("delivers video to someone who joins after sharing started", async () => {
    await host.click("#share");
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
    await joinWith(late, code);
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
    // A refresh lands on /#CODE and automatically rejoins with the stored hostToken.
    await waitFor(host, inRoom, { label: "host back in the room" });
    await openRoster(host);
    await waitFor(host, () => !document.getElementById("lock-btn")?.hidden, { label: "host controls after refresh" });
    // The others see exactly one host, not a ghost of the old socket.
    await waitFor(
      other,
      () =>
        [...document.querySelectorAll("#roster-list li")].filter((li) => (li.textContent ?? "").includes("(host)"))
          .length === 1,
      { label: "one host in the viewer's list" },
    );
  });

  await it("does not let a removed person back in, and a locked room refuses newcomers", async () => {
    // The refresh above ended the host's share; nobody is sharing now.
    assert.equal(await host.textContent("#share"), "Share screen");
    await openRoster(host);
    await waitFor(host, () => document.querySelectorAll("#roster-list button").length === 2, {
      label: "Remove buttons for both others",
    });
    await host.click("#roster-list li:has-text('late') button");
    await waitFor(late, () => (document.getElementById("status")?.textContent ?? "").includes("removed"), {
      label: "late to be told it was removed",
    });
    // Removal cuts the media, not just the list entry.
    await waitFor(late, () => window.__pcs.every((pc) => pc.connectionState === "closed"), {
      label: "the removed person's connections to close",
    });
    // Pressing Join again must not get back in.
    await joinWith(late, code);
    await waitFor(late, () => (document.getElementById("status")?.textContent ?? "").includes("removed"), {
      label: "rejoin to be refused",
    });
    assert.equal((await status(late)).includes("In room"), false);

    await host.click("#lock-btn");
    await waitFor(host, () => document.getElementById("lock-btn")?.textContent === "Unlock room", {
      label: "room locked",
    });
    // A newcomer from another browser profile. Every page here shares 127.0.0.1, so
    // the removal ban would also refuse it; the lock message is what must win,
    // or at least a refusal of some kind.
    const newcomer = await newPage("newcomer");
    await joinWith(newcomer, code);
    await waitFor(newcomer, () => /locked|removed/.test(document.getElementById("status")?.textContent ?? ""), {
      label: "newcomer to be refused",
    });
    assert.equal(await newcomer.evaluate(() => window.__pcs.length), 0);
    // People already inside are unaffected.
    assert.ok((await status(other)).length > 0);
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

  await it("stops sharing when the sharer is removed", async () => {
    await openRoster(host);
    await host.click("#lock-btn"); // unlock, so a fresh page can come in to be removed
    await waitFor(host, () => document.getElementById("lock-btn")?.textContent === "Lock room", { label: "unlocked" });
    // The removal ban is by address and every page here is 127.0.0.1, so the second
    // person to remove has to be someone already inside: the other member.
    await other.click("#share");
    await waitFor(host, () => document.querySelectorAll("#roster-list .badge").length === 1, {
      label: "host to see other sharing",
    });
    await host.click("#roster-list li:has-text('other') button");
    await waitFor(other, () => (document.getElementById("status")?.textContent ?? "").includes("removed"), {
      label: "other to be told it was removed",
    });
    // The screen capture itself is stopped, not left running for the next room.
    await waitFor(other, () => document.getElementById("share")?.textContent === "Share screen", {
      label: "the share button to reset",
    });
    await waitFor(
      other,
      () => (window.__gdmStreams ?? []).every((st) => st.getTracks().every((track) => track.readyState === "ended")),
      { label: "every captured track to be stopped" },
    );
  });

  await it("maintains 52px bars and zero horizontal overflow across viewport resizes", async () => {
    const viewports: Array<[number, number]> = [
      [1440, 900],
      [1024, 768],
      [800, 600],
    ];
    for (const [width, height] of viewports) {
      await host.setViewportSize({ width, height });
      const metrics = await host.evaluate(() => {
        const headerRect = document.querySelector("header.app-bar")?.getBoundingClientRect();
        const controlsRect = document.getElementById("controls")?.getBoundingClientRect();
        return {
          headerHeight: Math.round(headerRect?.height ?? 0),
          controlsHeight: Math.round(controlsRect?.height ?? 0),
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });
      assert.equal(metrics.headerHeight, 52, `header height at ${String(width)}x${String(height)}`);
      assert.equal(metrics.controlsHeight, 52, `controls height at ${String(width)}x${String(height)}`);
      assert.ok(
        metrics.scrollWidth <= metrics.innerWidth,
        `horizontal overflow at ${String(width)}x${String(height)}: ${String(metrics.scrollWidth)} > ${String(metrics.innerWidth)}`,
      );
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
