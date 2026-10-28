import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { baseUrl, INSTRUMENT, launchBrowser, startServer, stopServer, waitFor } from "./helpers.mjs";

/**
 * The paths p2p.test.mjs does not walk: a password-protected room made with Create,
 * joining after sharing has started, stopping and sharing again, two people sharing
 * at once, the host refreshing, and removal and locking.
 */
const PORT = 8891;
const BASE_URL = baseUrl(PORT);

let server;
let browser;
let host;
let late;
let other;
let contexts = [];

const status = (page) => page.textContent("#status");

/** Frames decoded so far across every inbound video stream on the page. */
const decodedFrames = async () => {
  let total = 0;
  for (const pc of window.__pcs) {
    if (pc.connectionState === "closed") continue;
    const report = await pc.getStats();
    report.forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "video") total += s.framesDecoded ?? 0;
    });
  }
  return total;
};

/** Wait until the page's decoded frame count grows past `from`: video is flowing now. */
async function framesGrow(page, label, from = null) {
  const start = from ?? (await page.evaluate(decodedFrames));
  await waitFor(page, decodedFrames, { label: `${label}: any decoded frames`, timeout: 45_000, interval: 1000 });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const now = await page.evaluate(decodedFrames);
    if (now > start + 10) return now;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label}: decoded frames stuck at ${start}`);
}

async function newPage(name) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(INSTRUMENT);
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.error(`[${name}]`, m.text()); });
  await page.goto(BASE_URL);
  await page.fill("#display-name", name);
  return page;
}

async function joinWith(page, code, password) {
  await page.fill("#room-code", code);
  await page.fill("#room-pass", password ?? "");
  await page.click("#join");
}

const inRoom = () => document.getElementById("status")?.textContent?.includes("In room");

describe("edge cases in a real browser", { concurrency: 1 }, () => {
  let code;
  let password;

  before(async () => {
    server = await startServer(PORT);
    browser = await launchBrowser();
    host = await newPage("host");
    late = await newPage("late");
    other = await newPage("other");
  });

  afterEach(async (t) => {
    // On failure, show what each page was saying: the status line is the app's own account.
    if (process.env.E2E_DEBUG) {
      for (const [n, p] of [["host", host], ["late", late], ["other", other]]) {
        const st = await p.textContent("#status").catch(() => "?");
        const roster = await p.textContent("#roster").catch(() => "?");
        console.log(`# ${t.name} :: ${n}: status=${JSON.stringify(st)} roster=${JSON.stringify(roster)}`);
      }
    }
  });

  after(async () => {
    await browser?.close();
    await stopServer(server);
  });

  it("creates a password-protected room with Generate and Create", async () => {
    await host.click("#gen-pass");
    password = await host.inputValue("#room-pass");
    assert.ok(password.length >= 8, `generated password too short: ${password}`);
    await host.click("#create");
    await waitFor(host, inRoom, { label: "host in the new room" });
    code = await host.inputValue("#room-code");
    assert.match(code, /^[A-Z2-9]{8}$/);
    assert.equal(await host.isVisible("#lock-btn"), true, "the creator should be host");
  });

  it("turns away a wrong password and lets the right one in", async () => {
    await joinWith(other, code, "wrong-password");
    await waitFor(other, () => /password/i.test(document.getElementById("status")?.textContent ?? ""), {
      label: "wrong password to be reported",
    });
    assert.equal(await other.evaluate(() => window.__pcs.length), 0);
    // A retry with the right one, from the same page, must work.
    await joinWith(other, code, password);
    await waitFor(other, inRoom, { label: "other in the room with the right password" });
  });

  it("delivers video to someone who joins after sharing started", async () => {
    await host.click("#share");
    // The picker is asked for a window and never this tab, so a share does not
    // default to the whole screen or show the app to itself.
    const [opts] = await host.evaluate(() => window.__gdmOpts);
    assert.equal(opts.selfBrowserSurface, "exclude");
    assert.equal(opts.video?.displaySurface, "window");
    await framesGrow(other, "other viewer");
    await joinWith(late, code, password);
    await waitFor(late, inRoom, { label: "late joiner in the room" });
    await framesGrow(late, "late joiner");
  });

  it("delivers video again after the sharer stops and shares again", async () => {
    await host.click("#share"); // stop
    await waitFor(host, () => window.__pcs.every((pc) => pc.connectionState === "closed"), {
      label: "links to close after stopping",
    });
    await host.click("#share"); // share again
    await framesGrow(late, "late joiner after re-share", 0);
    await framesGrow(other, "other viewer after re-share", 0);
  });

  it("carries video both ways when two people share at once", async () => {
    await late.click("#share");
    // The host now receives from late while still sending to everyone.
    await framesGrow(host, "host receiving from the second sharer");
    await framesGrow(late, "second sharer still receiving the host");
    // The viewer who does not share gets both.
    await waitFor(
      other,
      () => [...document.querySelectorAll(".tile video")].filter((v) => v.srcObject?.getVideoTracks().length).length >= 2,
      { label: "viewer to show two shared screens", timeout: 45_000 },
    );
    await late.click("#share"); // stop again for the rest of the suite
  });

  it("keeps the host a host across a page refresh", async () => {
    await host.reload();
    // A refresh lands on /#CODE and joins at once, but without the password, so it is
    // asked for; entering it and pressing Join gets back in.
    await waitFor(host, () => /password/i.test(document.getElementById("status")?.textContent ?? ""), {
      label: "refresh to ask for the password",
    });
    await host.fill("#room-pass", password);
    await host.click("#join");
    await waitFor(host, inRoom, { label: "host back in the room" });
    await waitFor(host, () => !document.getElementById("lock-btn")?.hidden, { label: "host controls after refresh" });
    // The others see exactly one host, not a ghost of the old socket.
    await waitFor(
      other,
      () => [...document.querySelectorAll("#roster-list li")].filter((li) => li.textContent.includes("(host)")).length === 1,
      { label: "one host in the viewer's list" },
    );
  });

  it("does not let a removed person back in, and a locked room refuses newcomers", async () => {
    // The refresh above ended the host's share; nobody is sharing now.
    assert.equal(await host.textContent("#share"), "Share screen");
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
    await joinWith(late, code, password);
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
    await joinWith(newcomer, code, password);
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

  it("lets a member back into the locked room after a refresh", async () => {
    // A refresh is a reconnect. The locked room must recognise a member who was
    // already in, even though every page here shares the removed person's address.
    await other.reload();
    await waitFor(other, () => /password/i.test(document.getElementById("status")?.textContent ?? ""), {
      label: "refresh to ask for the password",
    });
    await other.fill("#room-pass", password);
    await other.click("#join");
    await waitFor(other, inRoom, { label: "member back in the locked room" });
    await waitFor(other, () => (document.getElementById("roster-title")?.textContent ?? "").includes("locked"), {
      label: "member to see the room is locked",
    });
  });

  it("stops sharing when the sharer is removed", async () => {
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
      () => window.__gdmStreams.every((st) => st.getTracks().every((t) => t.readyState === "ended")),
      { label: "every captured track to be stopped" },
    );
  });

  it("raised no CSP or Trusted Types violation on any page", async () => {
    for (const [name, page] of [["host", host], ["late", late], ["other", other]]) {
      assert.deepEqual(await page.evaluate(() => window.__csp), [], `${name} hit a CSP violation`);
    }
  });
});
