import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
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

const PORT = 8894;
const BASE_URL = baseUrl(PORT);

let server: ServerHandle | undefined;
let browser: Browser | undefined;
let host: Page;
let guest: Page;
let guestCtx: BrowserContext;
const contexts: BrowserContext[] = [];
const pageErrors: string[] = [];
const consoleErrors: string[] = [];

const inRoom = (): boolean => Boolean(document.getElementById("status")?.textContent?.includes("In room"));
const inLobby = (): boolean =>
  document.getElementById("lobby")?.hidden === false && document.getElementById("room-bar")?.hidden === true;

function attachErrorListeners(name: string, page: Page): void {
  page.on("pageerror", (err) => {
    pageErrors.push(`${name}: ${err.message || String(err)}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(`${name}: ${msg.text()}`);
    }
  });
}

async function assertNoCspViolations(name: string, page: Page): Promise<void> {
  assert.deepEqual(await page.evaluate(() => window.__csp), [], `${name} hit a CSP violation`);
}

async function createPageWithContext(name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  if (!browser) throw new Error("Browser not initialized");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(ctx);
  await ctx.addInitScript(INSTRUMENT);
  const page = await ctx.newPage();
  attachErrorListeners(name, page);
  await page.goto(BASE_URL);
  await page.fill("#display-name", name);
  return { ctx, page };
}

async function readHostInvite(page: Page): Promise<string> {
  const hidden = await page.evaluate(() => document.getElementById("invite-menu")?.hidden ?? true);
  if (hidden) await page.click("#invite-btn");
  if ((await page.textContent("#invite-show-btn")) === "Show") {
    await page.click("#invite-show-btn");
  }
  const value = ((await page.textContent("#invite-code-value")) ?? "").trim();
  await page.click("#invite-btn");
  return value;
}

await describe("recent rooms & passwordless rejoin (Mock #12) end-to-end", { concurrency: 1 }, async () => {
  before(async () => {
    server = await startServer(PORT);
    browser = await launchBrowser();
    ({ page: host } = await createPageWithContext("host"));
    ({ ctx: guestCtx, page: guest } = await createPageWithContext("guest"));
  });

  after(async () => {
    await Promise.allSettled(contexts.map((ctx) => ctx.close()));
    try {
      await browser?.close();
    } finally {
      await stopServer(server);
    }
  });

  await it("shows clean 0-room lobby with subtle opt-out toggle and no recents list or debug strip", async () => {
    const state = await host.evaluate(() => ({
      rootHidden: document.getElementById("recent-rooms-root")?.hidden ?? true,
      hasExpandedClass: document.getElementById("lobby-card")?.classList.contains("has-recent-rooms") ?? true,
      hasOptOut: document.getElementById("recent-rooms-optout") !== null,
      optOutChecked: (document.getElementById("recent-rooms-optout") as HTMLInputElement | null)?.checked ?? true,
      hasClear: document.getElementById("recent-rooms-clear") !== null,
      hasDivider: document.querySelector("#recent-rooms-root .lobby-divider") !== null,
      hasSearch: document.getElementById("recent-rooms-search") !== null,
      rowCount: document.querySelectorAll(".recent-room-row").length,
      hasOldForgetBtn: document.getElementById("lobby-forget-hosts") !== null,
      bodyText: document.body.textContent ?? "",
    }));
    assert.equal(state.rootHidden, false);
    assert.equal(state.hasExpandedClass, false);
    assert.equal(state.hasOptOut, true);
    assert.equal(state.optOutChecked, false);
    assert.equal(state.hasClear, false);
    assert.equal(state.hasDivider, false);
    assert.equal(state.hasSearch, false);
    assert.equal(state.rowCount, 0);
    assert.equal(state.hasOldForgetBtn, false);
    assert.equal(state.bodyText.includes("Simulate count"), false);

    // User can opt out before ever saving a first room, and re-enable cleanly
    await host.click("#recent-rooms-optout");
    await waitFor(
      host,
      () =>
        localStorage.getItem("recent-rooms-disabled") === "1" &&
        document.getElementById("recent-rooms-enable") !== null,
      { label: "0-room opt-out toggles shared-device mode on" },
    );
    await host.click("#recent-rooms-enable");
    await waitFor(
      host,
      () =>
        localStorage.getItem("recent-rooms-disabled") === null &&
        document.getElementById("recent-rooms-optout") !== null &&
        document.getElementById("recent-rooms-clear") === null,
      { label: "Enable restores clean 0-room lobby with opt-out toggle" },
    );
  });

  await it("saves rooms on join, shows quick rejoin, and supports passwordless rejoin for guest and host", async () => {
    await host.click("#create");
    await waitFor(host, inRoom, { label: "host creates first room" });
    const invite1 = await readHostInvite(host);
    const [code1 = ""] = invite1.split("-");
    assert.match(code1, /^[A-Z2-9]{8}$/);

    await guest.fill("#room-code", invite1);
    await guest.click("#join");
    await waitFor(guest, inRoom, { label: "guest joins first room" });
    await waitFor(guest, () => document.querySelectorAll("#roster-list li").length === 2, {
      label: "guest sees host in roster",
    });

    // Both return to lobby; each sees "quick rejoin" with appropriate Host/Guest badge
    await host.click("#brand-home");
    await waitFor(host, inLobby, { label: "host returns to lobby" });
    await guest.click("#brand-home");
    await waitFor(guest, inLobby, { label: "guest returns to lobby" });

    const hostSnap = await host.evaluate((c) => ({
      expanded: document.getElementById("lobby-card")?.classList.contains("has-recent-rooms") ?? false,
      divider: document.querySelector("#recent-rooms-root .lobby-divider")?.textContent ?? "",
      badge: document.querySelector(`[data-room-code="${c}"] .recent-room-badge`)?.textContent ?? "",
      sub: document.querySelector(`[data-room-code="${c}"] .recent-room-sub`)?.textContent ?? "",
    }), code1);
    assert.equal(hostSnap.expanded, true);
    assert.equal(hostSnap.divider, "quick rejoin");
    assert.equal(hostSnap.badge, "Host");
    assert.ok(hostSnap.sub.includes("with guest"), `expected guest peer name in subtitle: ${hostSnap.sub}`);

    const guestSnap = await guest.evaluate((c) => ({
      divider: document.querySelector("#recent-rooms-root .lobby-divider")?.textContent ?? "",
      badge: document.querySelector(`[data-room-code="${c}"] .recent-room-badge`)?.textContent ?? "",
      sub: document.querySelector(`[data-room-code="${c}"] .recent-room-sub`)?.textContent ?? "",
    }), code1);
    assert.equal(guestSnap.divider, "quick rejoin");
    assert.equal(guestSnap.badge, "Guest");
    assert.ok(guestSnap.sub.includes("with host"), `expected host peer name in subtitle: ${guestSnap.sub}`);

    // Clear sessionStorage, reload both pages for a cold boot from localStorage, and rejoin via click without password
    await guest.evaluate(() => sessionStorage.clear());
    await host.evaluate(() => sessionStorage.clear());
    await assertNoCspViolations("host", host);
    await assertNoCspViolations("guest", guest);
    await Promise.all([host.reload(), guest.reload()]);
    await host.waitForSelector(`[data-room-code="${code1}"] .recent-room-rejoin`);
    await guest.waitForSelector(`[data-room-code="${code1}"] .recent-room-rejoin`);
    await host.click(`[data-room-code="${code1}"] .recent-room-rejoin`);
    await waitFor(host, inRoom, { label: "host rejoins room via recent row" });
    await host.click("#roster-btn");
    await waitFor(host, () => !document.getElementById("lock-btn")?.hidden, {
      label: "host retains host controls after passwordless rejoin",
    });
    await host.click("#roster-btn");

    await guest.click(`[data-room-code="${code1}"] .recent-room-rejoin`);
    await waitFor(guest, inRoom, { label: "guest rejoins room via recent row without password" });

    // Return both to lobby
    await host.click("#brand-home");
    await waitFor(host, inLobby, { label: "host back in lobby" });
    await guest.click("#brand-home");
    await waitFor(guest, inLobby, { label: "guest back in lobby" });
  });

  await it("supports inline rename (Enter saves, Escape cancels) and 3+ room live search/filter + per-room delete", async () => {
    const firstCode = await host.evaluate(
      () => document.querySelector<HTMLElement>("[data-room-code]")?.dataset["roomCode"] ?? "",
    );
    assert.ok(firstCode.length === 8);

    // Inline rename: Escape cancels, Enter commits, and focus returns to .recent-room-edit-btn
    await host.click(`[data-room-code="${firstCode}"] .recent-room-edit-btn`);
    await host.fill(".recent-room-rename-input", "Should Not Save");
    await host.press(".recent-room-rename-input", "Escape");
    await waitFor(
      host,
      () => document.querySelector(".recent-room-rename-input") === null,
      { label: "Escape closes rename input" },
    );
    const focusAfterEsc = await host.evaluate(
      (c) => document.activeElement === document.querySelector(`[data-room-code="${c}"] .recent-room-edit-btn`),
      firstCode,
    );
    assert.equal(focusAfterEsc, true);
    const titleAfterEsc = await host.textContent(`[data-room-code="${firstCode}"] .recent-room-title`);
    assert.equal(titleAfterEsc, firstCode);

    await host.click(`[data-room-code="${firstCode}"] .recent-room-edit-btn`);
    await host.fill(".recent-room-rename-input", "  Weekly Design Sync  ");
    await host.press(".recent-room-rename-input", "Enter");
    await host.waitForFunction(
      (c) => document.querySelector(`[data-room-code="${c}"] .recent-room-title`)?.textContent === "Weekly Design Sync",
      firstCode,
    );
    const focusAfterEnter = await host.evaluate(
      (c) => document.activeElement === document.querySelector(`[data-room-code="${c}"] .recent-room-edit-btn`),
      firstCode,
    );
    assert.equal(focusAfterEnter, true);

    // Create 2 more rooms so host has 3 rooms -> triggers "recent rooms (3)" + live search
    await host.click("#create");
    await waitFor(host, inRoom, { label: "host creates room 2" });
    await host.click("#brand-home");
    await waitFor(host, inLobby, { label: "host returns after room 2" });

    await host.click("#create");
    await waitFor(host, inRoom, { label: "host creates room 3" });
    await host.click("#brand-home");
    await waitFor(host, inLobby, { label: "host returns after room 3" });

    const manyState = await host.evaluate(() => ({
      divider: document.querySelector("#recent-rooms-root .lobby-divider")?.textContent ?? "",
      hasSearch: document.getElementById("recent-rooms-search") !== null,
      rowCount: document.querySelectorAll(".recent-room-row").length,
    }));
    assert.equal(manyState.divider, "recent rooms (3)");
    assert.equal(manyState.hasSearch, true);
    assert.equal(manyState.rowCount, 3);

    // Filter by nickname, peer name, code, and unmatched query
    await host.fill("#recent-rooms-search", "weekly");
    assert.equal(await host.locator(".recent-room-row").count(), 1);

    await host.fill("#recent-rooms-search", "guest");
    assert.equal(await host.locator(".recent-room-row").count(), 1);

    await host.fill("#recent-rooms-search", firstCode.toLowerCase());
    assert.equal(await host.locator(".recent-room-row").count(), 1);

    await host.fill("#recent-rooms-search", "zzzz-no-match");
    assert.equal(await host.locator(".recent-room-row").count(), 0);
    assert.equal(await host.textContent(".recent-rooms-empty-filter"), "No matching rooms.");

    await host.fill("#recent-rooms-search", "");
    assert.equal(await host.locator(".recent-room-row").count(), 3);

    // Delete 1 room -> drops to 2 rooms -> switches back to "quick rejoin" and hides search
    const lastRowCode = await host.evaluate(
      () => [...document.querySelectorAll<HTMLElement>("[data-room-code]")].pop()?.dataset["roomCode"] ?? "",
    );
    await host.click(`[data-room-code="${lastRowCode}"] .recent-room-delete-btn`);
    await waitFor(
      host,
      () =>
        document.querySelectorAll(".recent-room-row").length === 2 &&
        document.querySelector("#recent-rooms-root .lobby-divider")?.textContent === "quick rejoin" &&
        document.getElementById("recent-rooms-search") === null,
      { label: "deleting 3rd room reverts to quick rejoin with 2 rooms" },
    );
  });

  await it("handles locked room retention, kick removal, bad-password removal, and cross-tab sync", async () => {
    // Host creates a fresh room, guest joins while unlocked
    await host.click("#create");
    await waitFor(host, inRoom, { label: "host creates room for lock/kick test" });
    const invite = await readHostInvite(host);
    const [roomCode = ""] = invite.split("-");

    await guest.fill("#room-code", invite);
    await guest.click("#join");
    await waitFor(guest, inRoom, { label: "guest joins unlocked room" });

    // Host locks room -> guest retains last known password in recent-rooms
    await host.click("#roster-btn");
    await host.click("#lock-btn");
    await waitFor(host, () => document.getElementById("lock-btn")?.textContent === "Unlock room", {
      label: "host locks room",
    });

    const guestStoredAfterLock = await guest.evaluate((c) => {
      const raw = localStorage.getItem("recent-rooms") ?? "[]";
      const list = JSON.parse(raw) as Array<{ code: string; password?: string }>;
      return list.find((r) => r.code === c)?.password ?? null;
    }, roomCode);
    assert.ok(guestStoredAfterLock !== null && guestStoredAfterLock.length === 16);

    // Guest returns to lobby and tries to rejoin while locked -> kept intact with error in #lobby-error
    await guest.click("#brand-home");
    await waitFor(guest, inLobby, { label: "guest returns to lobby" });
    await guest.click(`[data-room-code="${roomCode}"] .recent-room-rejoin`);
    await waitFor(
      guest,
      () => (document.getElementById("lobby-error")?.textContent ?? "").includes("locked"),
      { label: "guest sees room-locked error" },
    );
    assert.equal(await guest.locator(`[data-room-code="${roomCode}"]`).count(), 1);

    // Host unlocks room -> guest rejoins immediately using retained password
    await host.click("#lock-btn");
    await waitFor(host, () => document.getElementById("lock-btn")?.textContent === "Lock room", {
      label: "host unlocks room",
    });
    await host.click("#roster-btn");
    await guest.click(`[data-room-code="${roomCode}"] .recent-room-rejoin`);
    await waitFor(guest, inRoom, { label: "guest rejoins after unlock using retained password" });

    // Cross-tab storage sync: open second tab in guestCtx and verify it receives recent rooms
    const tab2 = await guestCtx.newPage();
    attachErrorListeners("guest-tab2", tab2);
    await tab2.goto(BASE_URL);
    await waitFor(
      tab2,
      () => document.querySelectorAll(".recent-room-row").length >= 1,
      { label: "second tab loads saved rooms" },
    );

    // Host kicks guest -> guest is removed from recent-rooms and tab2 syncs via storage event
    await host.click("#roster-btn");
    await host.click("#roster-list li:has-text('guest') button");
    await guest.waitForFunction(
      (c) =>
        document.getElementById("lobby")?.hidden === false &&
        (document.getElementById("lobby-error")?.textContent ?? "").includes("removed") &&
        document.querySelector(`[data-room-code="${c}"]`) === null,
      roomCode,
    );
    assert.equal(await guest.locator(`[data-room-code="${roomCode}"]`).count(), 0);
    await tab2.waitForFunction(
      (c) => document.querySelector(`[data-room-code="${c}"]`) === null,
      roomCode,
    );
    assert.deepEqual(await tab2.evaluate(() => window.__csp), [], "tab2 hit a CSP violation");
    await tab2.close();

    // Seed a bad-password entry in guest's recent-rooms -> click -> immediately removed + #lobby-error
    const badCode = "MNPQ2345";
    await guest.evaluate((c) => {
      localStorage.setItem(
        "recent-rooms",
        JSON.stringify([
          {
            code: c,
            role: "guest",
            password: "WRONGPASS1234567",
            lastJoinedAt: Date.now(),
            peerNames: ["Someone"],
          },
        ]),
      );
    }, badCode);
    await assertNoCspViolations("guest", guest);
    await guest.reload();
    await guest.waitForFunction((c) => document.querySelector(`[data-room-code="${c}"]`) !== null, badCode);
    await guest.click(`[data-room-code="${badCode}"] .recent-room-rejoin`);
    await waitFor(
      guest,
      () => /Invalid or expired room invite/i.test(document.getElementById("lobby-error")?.textContent ?? ""),
      { label: "bad-password shows invalid invite error in #lobby-error" },
    );
    assert.equal(await guest.locator(`[data-room-code="${badCode}"]`).count(), 0);
  });

  await it("supports shared-device opt-out toggle and discloses controls in privacy.html", async () => {
    await host.click("#brand-home");
    await waitFor(host, inLobby, { label: "host returns to lobby for opt-out test" });

    await host.click("#recent-rooms-optout");
    await waitFor(
      host,
      () =>
        (document.getElementById("recent-rooms-root")?.textContent ?? "").includes(
          "Room saving is off for this shared device.",
        ) &&
        document.getElementById("recent-rooms-enable") !== null &&
        localStorage.getItem("recent-rooms") === null &&
        localStorage.getItem("host-rooms") === null,
      { label: "shared-device mode shows banner and wipes saved rooms" },
    );

    // Creating a room while disabled must not persist host-rooms or recent-rooms
    await host.click("#create");
    await waitFor(host, inRoom, { label: "host creates room while saving is disabled" });
    await host.click("#brand-home");
    await waitFor(host, inLobby, { label: "host returns to lobby while disabled" });
    const storedWhileDisabled = await host.evaluate(() => ({
      recent: localStorage.getItem("recent-rooms"),
      hosts: localStorage.getItem("host-rooms"),
    }));
    assert.equal(storedWhileDisabled.recent, null);
    assert.equal(storedWhileDisabled.hosts, null);

    await host.click("#recent-rooms-enable");
    await waitFor(
      host,
      () =>
        document.getElementById("recent-rooms-root")?.hidden === false &&
        document.getElementById("recent-rooms-optout") !== null &&
        document.getElementById("recent-rooms-clear") === null &&
        document.querySelectorAll(".recent-room-row").length === 0 &&
        localStorage.getItem("recent-rooms-disabled") === null,
      { label: "Enable restores clean 0-room lobby" },
    );

    // Verify privacy.html §3 & §4 disclosures and zero CSP violations
    await assertNoCspViolations("host", host);
    await host.goto(`${BASE_URL}/privacy.html`);
    const privacyText = await host.evaluate(() => document.body.textContent ?? "");
    assert.ok(privacyText.includes("recent-rooms"));
    assert.ok(privacyText.includes("recent-rooms-disabled"));
    assert.ok(privacyText.includes("Don't save rooms on this device"));
    assert.ok(privacyText.includes("Clear saved rooms"));
    assert.ok(privacyText.includes("Forget host on this device"));

    for (const [name, p] of [
      ["host", host],
      ["guest", guest],
    ] as const) {
      await assertNoCspViolations(name, p);
    }
    assert.deepEqual(pageErrors, [], `unexpected page errors: ${pageErrors.join("; ")}`);
    assert.deepEqual(consoleErrors, [], `unexpected console errors: ${consoleErrors.join("; ")}`);
  });
});
