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

const PORT = 8893;
const BASE_URL = baseUrl(PORT);

let server: ServerHandle | undefined;
let browser: Browser | undefined;
let host: Page;
let guest: Page;
const contexts: BrowserContext[] = [];
const pageErrors: string[] = [];
const consoleErrors: string[] = [];

const inRoom = (): boolean => Boolean(document.getElementById("status")?.textContent?.includes("In room"));

interface RawStatRecord {
  type?: string;
  kind?: string;
  framesDecoded?: number;
}

interface ChatMessageSnapshot {
  isSelf: boolean;
  name: string;
  shortId: string;
  sep: string;
  time: string;
  text: string;
}

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

async function newPage(name: string): Promise<Page> {
  if (!browser) throw new Error("Browser not initialized");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(ctx);
  await ctx.addInitScript(INSTRUMENT);
  const page = await ctx.newPage();
  attachErrorListeners(name, page);
  await page.goto(BASE_URL);
  await page.fill("#display-name", name);
  return page;
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

async function readChatMessages(page: Page): Promise<ChatMessageSnapshot[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".chat-msg")].map((row) => ({
      isSelf: row.classList.contains("is-self"),
      name: row.querySelector(".chat-msg-name")?.textContent ?? "",
      shortId: row.querySelector(".chat-msg-id")?.textContent ?? "",
      sep: row.querySelector(".chat-msg-sep")?.textContent ?? "",
      time: row.querySelector(".chat-msg-time")?.textContent ?? "",
      text: row.querySelector(".chat-msg-text")?.textContent ?? "",
    })),
  );
}

await describe("room chat end-to-end", { concurrency: 1 }, async () => {
  let inviteCode = "";

  before(async () => {
    server = await startServer(PORT);
    browser = await launchBrowser();
    host = await newPage("host");
    guest = await newPage("guest");
  });

  after(async () => {
    await Promise.allSettled(contexts.map((ctx) => ctx.close()));
    try {
      await browser?.close();
    } finally {
      await stopServer(server);
    }
  });

  await it("lets 2 users chat bidirectionally with 0 sharers and 0 open RTCPeerConnections", async () => {
    await host.click("#create");
    await waitFor(host, inRoom, { label: "host in room" });
    inviteCode = await readHostInvite(host);
    assert.match(inviteCode, /^[A-Z2-9]{8}-[A-Z2-9]{16}$/);

    await guest.fill("#room-code", inviteCode);
    await guest.click("#join");
    await waitFor(guest, inRoom, { label: "guest in room" });

    for (const [label, page] of [
      ["host", host],
      ["guest", guest],
    ] as const) {
      await waitFor(page, () => document.querySelectorAll("#roster-list li").length === 2, {
        label: `${label} sees both participants`,
      });
      const initialState = await page.evaluate(() => ({
        totalPcs: window.__pcs.length,
        openPcs: window.__pcs.filter((pc) => pc.connectionState !== "closed").length,
        chatBtnHidden: document.getElementById("chat-btn")?.hidden ?? true,
        panelHidden: document.getElementById("chat-panel")?.hidden ?? false,
        emptyHidden: document.getElementById("chat-empty")?.hidden ?? true,
        messagesHidden: document.getElementById("chat-messages")?.hidden ?? false,
      }));
      assert.equal(initialState.totalPcs, 0, `${label} must have 0 peer connections before chat`);
      assert.equal(initialState.openPcs, 0, `${label} must have 0 open peer connections before chat`);
      assert.equal(initialState.chatBtnHidden, false, `${label} #chat-btn must be visible in room`);
      assert.equal(initialState.panelHidden, true, `${label} #chat-panel must start closed`);
      assert.equal(initialState.emptyHidden, false, `${label} #chat-empty must start visible`);
      assert.equal(initialState.messagesHidden, true, `${label} #chat-messages must start hidden`);
    }

    // Host opens chat and sends the first message via Enter
    await host.click("#chat-btn");
    const hostAfterOpen = await host.evaluate(() => ({
      panelHidden: document.getElementById("chat-panel")?.hidden ?? true,
      bodyChatOpen: document.body.classList.contains("chat-open"),
      ariaExpanded: document.getElementById("chat-btn")?.getAttribute("aria-expanded"),
      activeId: document.activeElement?.id ?? "",
    }));
    assert.equal(hostAfterOpen.panelHidden, false);
    assert.equal(hostAfterOpen.bodyChatOpen, true);
    assert.equal(hostAfterOpen.ariaExpanded, "true");
    assert.equal(hostAfterOpen.activeId, "chat-input");

    await host.fill("#chat-input", "Hello with zero sharers");
    await host.press("#chat-input", "Enter");

    await waitFor(host, () => document.querySelectorAll(".chat-msg").length === 1, {
      label: "host sees echoed self message",
    });
    const hostComposerAfterSend = await host.evaluate(() => ({
      inputVal: (document.getElementById("chat-input") as HTMLInputElement | null)?.value ?? "x",
      emptyHidden: document.getElementById("chat-empty")?.hidden ?? false,
      messagesHidden: document.getElementById("chat-messages")?.hidden ?? true,
    }));
    assert.equal(hostComposerAfterSend.inputVal, "");
    assert.equal(hostComposerAfterSend.emptyHidden, true);
    assert.equal(hostComposerAfterSend.messagesHidden, false);

    const hostMsgs1 = await readChatMessages(host);
    assert.equal(hostMsgs1.length, 1);
    const firstSelfMsg = hostMsgs1[0];
    assert.ok(firstSelfMsg);
    assert.equal(firstSelfMsg.isSelf, true);
    assert.equal(firstSelfMsg.name, "host");
    assert.match(firstSelfMsg.shortId, /^#[a-zA-Z0-9_-]{4}$/);
    assert.equal(firstSelfMsg.sep, "\u00b7");
    assert.match(firstSelfMsg.time, /^\d{2}:\d{2}$/);
    assert.equal(firstSelfMsg.text, "Hello with zero sharers");

    // Guest opens chat, verifies host's message metadata, and replies via #chat-send
    await guest.click("#chat-btn");
    await waitFor(guest, () => document.querySelectorAll(".chat-msg").length === 1, {
      label: "guest receives host message",
    });
    const guestMsgs1 = await readChatMessages(guest);
    assert.equal(guestMsgs1.length, 1);
    const receivedFromHost = guestMsgs1[0];
    assert.ok(receivedFromHost);
    assert.equal(receivedFromHost.isSelf, false);
    assert.equal(receivedFromHost.name, "host");
    assert.equal(receivedFromHost.shortId, firstSelfMsg.shortId);
    assert.equal(receivedFromHost.sep, "\u00b7");
    assert.match(receivedFromHost.time, /^\d{2}:\d{2}$/);
    assert.equal(receivedFromHost.text, "Hello with zero sharers");

    await guest.fill("#chat-input", "Reply with zero sharers");
    await guest.click("#chat-send");

    await waitFor(guest, () => document.querySelectorAll(".chat-msg").length === 2, {
      label: "guest sees own reply",
    });
    await waitFor(host, () => document.querySelectorAll(".chat-msg").length === 2, {
      label: "host receives guest reply",
    });

    const guestMsgs2 = await readChatMessages(guest);
    const guestSelfReply = guestMsgs2[1];
    assert.ok(guestSelfReply);
    assert.equal(guestSelfReply.isSelf, true);
    assert.equal(guestSelfReply.name, "guest");
    assert.match(guestSelfReply.shortId, /^#[a-zA-Z0-9_-]{4}$/);
    assert.equal(guestSelfReply.sep, "\u00b7");
    assert.match(guestSelfReply.time, /^\d{2}:\d{2}$/);
    assert.equal(guestSelfReply.text, "Reply with zero sharers");

    const hostMsgs2 = await readChatMessages(host);
    const hostReceivedReply = hostMsgs2[1];
    assert.ok(hostReceivedReply);
    assert.equal(hostReceivedReply.isSelf, false);
    assert.equal(hostReceivedReply.name, "guest");
    assert.equal(hostReceivedReply.shortId, guestSelfReply.shortId);
    assert.equal(hostReceivedReply.sep, "\u00b7");
    assert.match(hostReceivedReply.time, /^\d{2}:\d{2}$/);
    assert.equal(hostReceivedReply.text, "Reply with zero sharers");

    // Partial-mesh invariant: still 0 open RTCPeerConnections after bidirectional chat
    for (const [label, page] of [
      ["host", host],
      ["guest", guest],
    ] as const) {
      const pcs = await page.evaluate(() => ({
        total: window.__pcs.length,
        open: window.__pcs.filter((pc) => pc.connectionState !== "closed").length,
      }));
      assert.equal(pcs.total, 0, `${label} must still have 0 RTCPeerConnections with 0 sharers`);
      assert.equal(pcs.open, 0, `${label} must still have 0 open RTCPeerConnections with 0 sharers`);
    }
  });

  await it("shows unread badge while drawer is closed and clears it when opened", async () => {
    await guest.click("#chat-close");
    const closedState = await guest.evaluate(() => ({
      panelHidden: document.getElementById("chat-panel")?.hidden ?? false,
      bodyChatOpen: document.body.classList.contains("chat-open"),
      activeId: document.activeElement?.id ?? "",
      hasUnread: document.getElementById("chat-btn")?.classList.contains("has-unread") ?? true,
      badgeHidden: document.getElementById("chat-unread-badge")?.hidden ?? false,
      badgeText: document.getElementById("chat-unread-badge")?.textContent ?? "x",
      ariaLabel: document.getElementById("chat-btn")?.getAttribute("aria-label") ?? "",
    }));
    assert.equal(closedState.panelHidden, true);
    assert.equal(closedState.bodyChatOpen, false);
    assert.equal(closedState.activeId, "chat-btn");
    assert.equal(closedState.hasUnread, false);
    assert.equal(closedState.badgeHidden, true);
    assert.equal(closedState.badgeText, "");
    assert.equal(closedState.ariaLabel, "Room chat");

    await host.fill("#chat-input", "Unread message 1");
    await host.press("#chat-input", "Enter");
    await waitFor(
      guest,
      () => document.getElementById("chat-unread-badge")?.textContent === "1",
      { label: "guest unread badge increments to 1" },
    );
    const unread1 = await guest.evaluate(() => ({
      hasUnread: document.getElementById("chat-btn")?.classList.contains("has-unread") ?? false,
      badgeHidden: document.getElementById("chat-unread-badge")?.hidden ?? true,
      badgeText: document.getElementById("chat-unread-badge")?.textContent ?? "",
      ariaLabel: document.getElementById("chat-btn")?.getAttribute("aria-label") ?? "",
    }));
    assert.equal(unread1.hasUnread, true);
    assert.equal(unread1.badgeHidden, false);
    assert.equal(unread1.badgeText, "1");
    assert.equal(unread1.ariaLabel, "Room chat (1 unread)");

    await host.fill("#chat-input", "Unread message 2");
    await host.press("#chat-input", "Enter");
    await waitFor(
      guest,
      () => document.getElementById("chat-unread-badge")?.textContent === "2",
      { label: "guest unread badge increments to 2" },
    );
    assert.equal(await guest.getAttribute("#chat-btn", "aria-label"), "Room chat (2 unread)");

    // Opening drawer clears badge, class, and aria-label
    await guest.click("#chat-btn");
    const afterOpen = await guest.evaluate(() => ({
      panelHidden: document.getElementById("chat-panel")?.hidden ?? true,
      bodyChatOpen: document.body.classList.contains("chat-open"),
      hasUnread: document.getElementById("chat-btn")?.classList.contains("has-unread") ?? true,
      badgeHidden: document.getElementById("chat-unread-badge")?.hidden ?? false,
      badgeText: document.getElementById("chat-unread-badge")?.textContent ?? "x",
      ariaLabel: document.getElementById("chat-btn")?.getAttribute("aria-label") ?? "",
    }));
    assert.equal(afterOpen.panelHidden, false);
    assert.equal(afterOpen.bodyChatOpen, true);
    assert.equal(afterOpen.hasUnread, false);
    assert.equal(afterOpen.badgeHidden, true);
    assert.equal(afterOpen.badgeText, "");
    assert.equal(afterOpen.ariaLabel, "Room chat");

    const guestMsgs = await readChatMessages(guest);
    assert.equal(guestMsgs.length, 4);
    assert.equal(guestMsgs[3]?.text, "Unread message 2");
  });

  await it("uses 320px desktop push layout while sharing and shifts #join-chip left", async () => {
    await guest.setViewportSize({ width: 1280, height: 720 });
    await host.click("#share");

    await waitFor(guest, () => window.__pcs.some((pc) => pc.connectionState === "connected"), {
      label: "guest connected to sharer",
    });
    await waitFor(
      guest,
      () => {
        const videoEl = document.querySelector<HTMLVideoElement>(".tile:has(.tile-pause) video");
        return Boolean(
          videoEl && videoEl.srcObject instanceof MediaStream && videoEl.srcObject.getVideoTracks().length > 0,
        );
      },
      { label: "guest receives remote video tile", timeout: 45_000 },
    );
    await waitFor(
      guest,
      async () => {
        for (const pc of window.__pcs) {
          if (pc.connectionState === "closed") continue;
          const report = await pc.getStats();
          let decoded = 0;
          report.forEach((statEntry: unknown) => {
            const rec = statEntry as RawStatRecord;
            if (rec.type === "inbound-rtp" && rec.kind === "video") {
              decoded = Math.max(decoded, rec.framesDecoded ?? 0);
            }
          });
          if (decoded > 0) return decoded;
        }
        return 0;
      },
      { label: "guest decodes live video frames", timeout: 45_000, interval: 500 },
    );

    const desktopLayout = await guest.evaluate(() => {
      const panel = document.getElementById("chat-panel");
      const stage = document.getElementById("stage");
      const tile = document.querySelector<HTMLElement>(".tile:has(.tile-pause)");
      const joinChip = document.getElementById("join-chip");
      if (!panel || !stage || !tile || !joinChip) {
        throw new Error("Missing desktop layout elements");
      }
      const panelRect = panel.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const tileRect = tile.getBoundingClientRect();
      return {
        panelWidth: panelRect.width,
        panelLeft: panelRect.left,
        panelRight: panelRect.right,
        stageWidth: stageRect.width,
        stageLeft: stageRect.left,
        stageRight: stageRect.right,
        stageTop: stageRect.top,
        stageBottom: stageRect.bottom,
        tileWidth: tileRect.width,
        tileHeight: tileRect.height,
        tileLeft: tileRect.left,
        tileRight: tileRect.right,
        tileTop: tileRect.top,
        tileBottom: tileRect.bottom,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        joinChipComputedRight: getComputedStyle(joinChip).right,
      };
    });

    assert.equal(Math.round(desktopLayout.panelWidth), 320);
    assert.equal(Math.round(desktopLayout.panelLeft), 960);
    assert.equal(Math.round(desktopLayout.panelRight), 1280);
    assert.equal(Math.round(desktopLayout.stageWidth), 960);
    assert.ok(desktopLayout.stageRight <= desktopLayout.panelLeft + 0.5);
    assert.ok(desktopLayout.tileWidth > 0 && desktopLayout.tileHeight > 0);
    assert.ok(
      desktopLayout.tileLeft >= desktopLayout.stageLeft - 0.5 &&
        desktopLayout.tileRight <= desktopLayout.panelLeft + 0.5 &&
        desktopLayout.tileTop >= desktopLayout.stageTop - 0.5 &&
        desktopLayout.tileBottom <= desktopLayout.stageBottom + 0.5,
      "shared video tile must remain 100% uncovered beside #chat-panel",
    );
    assert.ok(desktopLayout.scrollWidth <= desktopLayout.innerWidth);
    assert.equal(desktopLayout.joinChipComputedRight, "336px");

    // Live 3rd-peer arrival with guest focused triggers #join-chip shifted left of the 320px drawer
    assert.equal(
      await guest.evaluate(() => document.getElementById("roster")?.hidden ?? true),
      true,
      "#roster must be closed so #join-chip renders on arrival",
    );
    await guest.bringToFront();

    if (!browser) throw new Error("Browser not initialized");
    const joinerCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    contexts.push(joinerCtx);
    try {
      await joinerCtx.addInitScript(INSTRUMENT);
      const joiner = await joinerCtx.newPage();
      attachErrorListeners("joiner", joiner);
      await joiner.goto(BASE_URL);
      await joiner.fill("#display-name", "joiner");
      await joiner.fill("#room-code", inviteCode);
      await joiner.click("#join");

      await waitFor(
        guest,
        () => {
          const chip = document.getElementById("join-chip");
          return Boolean(chip && !chip.hidden && chip.getBoundingClientRect().width > 0);
        },
        { label: "guest shows #join-chip on 3rd-peer arrival", timeout: 15_000, interval: 100 },
      );

      const liveChipMetrics = await guest.evaluate(() => {
        const chip = document.getElementById("join-chip");
        const panel = document.getElementById("chat-panel");
        if (!chip || !panel) throw new Error("Missing #join-chip or #chat-panel");
        const chipRect = chip.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        return {
          rightOffset: Math.round(window.innerWidth - chipRect.right),
          chipRight: chipRect.right,
          panelLeft: panelRect.left,
          computedRight: getComputedStyle(chip).right,
          text: chip.textContent ?? "",
        };
      });
      assert.equal(liveChipMetrics.computedRight, "336px");
      assert.equal(liveChipMetrics.rightOffset, 336);
      assert.ok(liveChipMetrics.chipRight <= liveChipMetrics.panelLeft + 0.5);
      assert.ok(liveChipMetrics.text.includes("joiner"));

      assert.deepEqual(await joiner.evaluate(() => window.__csp), [], "joiner hit a CSP violation");
    } finally {
      await joinerCtx.close();
    }

    await waitFor(guest, () => document.querySelectorAll("#roster-list li").length === 2, {
      label: "guest roster returns to 2 peers after joiner leaves",
    });
    await host.click("#share");
    for (const [label, page] of [
      ["host", host],
      ["guest", guest],
    ] as const) {
      await waitFor(page, () => window.__pcs.every((pc) => pc.connectionState === "closed"), {
        label: `${label} closes peer connections after stopping share`,
      });
    }
  });

  await it("renders mobile <= 680px full-width overlay, z-index stacking, and Escape precedence", async () => {
    try {
      await guest.setViewportSize({ width: 390, height: 844 });
      await waitFor(
        guest,
        () => {
          const panel = document.getElementById("chat-panel");
          return Boolean(panel && !panel.hidden && getComputedStyle(panel).position === "absolute");
        },
        { label: "mobile chat overlay styles apply" },
      );

      const mobileGeometry = await guest.evaluate(() => {
        const workspace = document.querySelector<HTMLElement>(".chat-workspace");
        const panel = document.getElementById("chat-panel");
        const header = document.querySelector<HTMLElement>("header.app-bar");
        const chatBtn = document.getElementById("chat-btn");
        if (!workspace || !panel || !header || !chatBtn) {
          throw new Error("Missing mobile chat elements");
        }
        const workspaceRect = workspace.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        const chatBtnRect = chatBtn.getBoundingClientRect();
        const panelStyle = getComputedStyle(panel);
        return {
          position: panelStyle.position,
          zIndex: panelStyle.zIndex,
          borderLeftWidth: panelStyle.borderLeftWidth,
          panelWidth: panelRect.width,
          panelLeft: panelRect.left,
          panelRight: panelRect.right,
          panelHeight: panelRect.height,
          workspaceHeight: workspaceRect.height,
          headerHeight: headerRect.height,
          chatBtnWidth: chatBtnRect.width,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });

      assert.equal(mobileGeometry.position, "absolute");
      assert.equal(mobileGeometry.zIndex, "28");
      assert.equal(mobileGeometry.borderLeftWidth, "0px");
      assert.equal(Math.round(mobileGeometry.panelWidth), 390);
      assert.equal(Math.round(mobileGeometry.panelLeft), 0);
      assert.equal(Math.round(mobileGeometry.panelRight), 390);
      assert.equal(Math.round(mobileGeometry.panelHeight), Math.round(mobileGeometry.workspaceHeight));
      assert.equal(Math.round(mobileGeometry.headerHeight), 52);
      assert.equal(Math.round(mobileGeometry.chatBtnWidth), 32);
      assert.ok(mobileGeometry.scrollWidth <= mobileGeometry.innerWidth);

      // #roster popover (z-index 30) sits above #chat-panel (z-index 28), #join-chip (z-index 25) below
      await guest.click("#roster-btn");
      await waitFor(guest, () => document.getElementById("roster")?.hidden === false, {
        label: "mobile roster popover opens",
      });
      const rosterStack = await guest.evaluate(() => {
        const roster = document.getElementById("roster");
        const panel = document.getElementById("chat-panel");
        const joinChip = document.getElementById("join-chip");
        if (!roster || !panel || !joinChip) throw new Error("Missing stacking elements");
        const rect = roster.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const topEl = document.elementFromPoint(cx, cy);
        return {
          rosterZ: getComputedStyle(roster).zIndex,
          panelZ: getComputedStyle(panel).zIndex,
          joinChipZ: getComputedStyle(joinChip).zIndex,
          rosterOnTop: Boolean(topEl && roster.contains(topEl)),
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });
      assert.equal(rosterStack.rosterZ, "30");
      assert.equal(rosterStack.panelZ, "28");
      assert.equal(rosterStack.joinChipZ, "25");
      assert.equal(rosterStack.rosterOnTop, true);
      assert.ok(rosterStack.scrollWidth <= rosterStack.innerWidth);

      // First Escape closes #roster without closing #chat-panel
      await guest.keyboard.press("Escape");
      const afterRosterEscape = await guest.evaluate(() => ({
        rosterHidden: document.getElementById("roster")?.hidden ?? false,
        panelHidden: document.getElementById("chat-panel")?.hidden ?? true,
        bodyChatOpen: document.body.classList.contains("chat-open"),
      }));
      assert.equal(afterRosterEscape.rosterHidden, true);
      assert.equal(afterRosterEscape.panelHidden, false);
      assert.equal(afterRosterEscape.bodyChatOpen, true);

      // #invite-menu popover (z-index 30) also sits above #chat-panel (z-index 28) and closes first on Escape
      await guest.click("#invite-btn");
      await waitFor(guest, () => document.getElementById("invite-menu")?.hidden === false, {
        label: "mobile invite popover opens",
      });
      const inviteStack = await guest.evaluate(() => {
        const inviteMenu = document.getElementById("invite-menu");
        if (!inviteMenu) throw new Error("Missing #invite-menu");
        const rect = inviteMenu.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const topEl = document.elementFromPoint(cx, cy);
        return {
          inviteZ: getComputedStyle(inviteMenu).zIndex,
          inviteOnTop: Boolean(topEl && inviteMenu.contains(topEl)),
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });
      assert.equal(inviteStack.inviteZ, "30");
      assert.equal(inviteStack.inviteOnTop, true);
      assert.ok(inviteStack.scrollWidth <= inviteStack.innerWidth);

      await guest.keyboard.press("Escape");
      const afterInviteEscape = await guest.evaluate(() => ({
        inviteHidden: document.getElementById("invite-menu")?.hidden ?? false,
        panelHidden: document.getElementById("chat-panel")?.hidden ?? true,
        bodyChatOpen: document.body.classList.contains("chat-open"),
      }));
      assert.equal(afterInviteEscape.inviteHidden, true);
      assert.equal(afterInviteEscape.panelHidden, false);
      assert.equal(afterInviteEscape.bodyChatOpen, true);

      // Second Escape closes #chat-panel and returns focus to #chat-btn
      await guest.keyboard.press("Escape");
      const afterSecondEscape = await guest.evaluate(() => ({
        panelHidden: document.getElementById("chat-panel")?.hidden ?? false,
        bodyChatOpen: document.body.classList.contains("chat-open"),
        activeId: document.activeElement?.id ?? "",
      }));
      assert.equal(afterSecondEscape.panelHidden, true);
      assert.equal(afterSecondEscape.bodyChatOpen, false);
      assert.equal(afterSecondEscape.activeId, "chat-btn");
    } finally {
      await guest.setViewportSize({ width: 1280, height: 720 });
    }
  });

  await it("raised zero CSP, Trusted Types, pageerror, or console errors", async () => {
    for (const [label, page] of [
      ["host", host],
      ["guest", guest],
    ] as const) {
      assert.deepEqual(await page.evaluate(() => window.__csp), [], `${label} hit a CSP violation`);
    }
    assert.deepEqual(pageErrors, [], `unexpected pageerror(s): ${pageErrors.join("; ")}`);
    assert.deepEqual(consoleErrors, [], `unexpected console.error(s): ${consoleErrors.join("; ")}`);
  });
});
