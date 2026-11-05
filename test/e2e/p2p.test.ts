import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright-core";
import { baseUrl, INSTRUMENT, launchBrowser, startServer, stopServer, waitFor, type ServerHandle } from "./helpers.ts";

// Fresh per run: wrangler dev keeps Durable Object storage between runs, and a room
// claimed by an earlier run has a host this run cannot be.
const ROOM = Array.from(
  crypto.getRandomValues(new Uint8Array(8)),
  (byte) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[byte % 31] ?? "A",
).join("");
const PORT = 8890;
const BASE_URL = baseUrl(PORT);

let server: ServerHandle | undefined;
let browser: Browser | undefined;
let sharer: Page;
let viewer: Page;
/** A second viewer: viewers must never connect to each other, only to the sharer. */
let viewer2: Page;

interface LinkStatEntry {
  connectionState: RTCPeerConnectionState;
  localType: string | null;
  remoteType: string | null;
  framesDecoded: number | null;
  framesEncoded: number | null;
  bytesReceived: number | null;
}

interface RawRtcStat {
  // skipcq: JS-T1001
  type?: string | undefined;
  // skipcq: JS-T1001
  kind?: string | undefined;
  // skipcq: JS-T1001
  selectedCandidatePairId?: string | undefined;
  // skipcq: JS-T1001
  localCandidateId?: string | undefined;
  // skipcq: JS-T1001
  remoteCandidateId?: string | undefined;
  // skipcq: JS-T1001
  candidateType?: string | undefined;
  // skipcq: JS-T1001
  framesDecoded?: number | undefined;
  // skipcq: JS-T1001
  framesEncoded?: number | undefined;
  // skipcq: JS-T1001
  bytesReceived?: number | undefined;
}

/** Read link stats out of the page's recorded RTCPeerConnections. */
// skipcq: JS-R1005
const readStats = async (): Promise<LinkStatEntry[]> => {
  const out: LinkStatEntry[] = [];
  for (const pc of window.__pcs) {
    const report = await pc.getStats();
    const entry: LinkStatEntry = {
      connectionState: pc.connectionState,
      localType: null,
      remoteType: null,
      framesDecoded: null,
      framesEncoded: null,
      bytesReceived: null,
    };
    const byId = new Map<string, RawRtcStat>();
    report.forEach((stat: unknown, id: string) => byId.set(id, stat as RawRtcStat));
    for (const stat of byId.values()) {
      if (stat.type === "transport" && stat.selectedCandidatePairId) {
        const pair = byId.get(stat.selectedCandidatePairId);
        if (pair) {
          entry.localType = (pair.localCandidateId ? byId.get(pair.localCandidateId)?.candidateType : null) ?? null;
          entry.remoteType = (pair.remoteCandidateId ? byId.get(pair.remoteCandidateId)?.candidateType : null) ?? null;
        }
      }
      if (stat.type === "inbound-rtp" && stat.kind === "video") {
        entry.framesDecoded = stat.framesDecoded ?? 0;
        entry.bytesReceived = stat.bytesReceived ?? 0;
      }
      if (stat.type === "outbound-rtp" && stat.kind === "video") {
        entry.framesEncoded = stat.framesEncoded ?? 0;
      }
    }
    out.push(entry);
  }
  return out;
};

/** Frames decoded so far across every live inbound video stream on the page. */
const decodedFrames = async (): Promise<number> => {
  let total = 0;
  for (const pc of window.__pcs) {
    if (pc.connectionState === "closed") continue;
    const report = await pc.getStats();
    report.forEach((raw: unknown) => {
      const stat = raw as RawRtcStat;
      if (stat.type === "inbound-rtp" && stat.kind === "video") total += stat.framesDecoded ?? 0;
    });
  }
  return total;
};

// skipcq: JS-0098
void describe("peer-to-peer screen sharing", { concurrency: 1 }, () => {
  before(async () => {
    server = await startServer(PORT);
    browser = await launchBrowser();

    // Separate contexts so the two peers get separate localStorage identities.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    for (const ctx of [ctxA, ctxB, ctxC]) await ctx.addInitScript(INSTRUMENT);
    sharer = await ctxA.newPage();
    viewer = await ctxB.newPage();
    viewer2 = await ctxC.newPage();
    const namedPages: Array<[string, Page]> = [
      ["sharer", sharer],
      ["viewer", viewer],
      ["viewer2", viewer2],
    ];
    for (const [name, page] of namedPages) {
      page.on("console", (msg) => {
        if (msg.type() === "error") console.error(`[${name}]`, msg.text());
      });
    }
  });

  after(async () => {
    await browser?.close();
    await stopServer(server);
  });

  // skipcq: JS-0098
  void it("serves the app and mints a room code", async () => {
    const res = await fetch(`${BASE_URL}/api/room`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { code: string };
    assert.match(body.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });

  // skipcq: JS-0098
  void it("routes /ws and /api past the static assets", async () => {
    // not_found_handling must not swallow these into index.html.
    const ws = await fetch(`${BASE_URL}/ws/${ROOM}`);
    assert.equal(ws.status, 426, "expected websocket-only endpoint to reject a plain GET");
    const bad = await fetch(`${BASE_URL}/ws/short`);
    assert.equal(bad.status, 400);
  });

  // skipcq: JS-0098
  void it("joins straight from a room link, without pressing Join", async () => {
    // One at a time, so the sharer is first in and becomes the room's host.
    const namedPages: Array<[string, Page]> = [
      ["sharer", sharer],
      ["viewer", viewer],
      ["viewer2", viewer2],
    ];
    for (const [name, page] of namedPages) {
      await page.goto(BASE_URL);
      await page.evaluate((peerName) => localStorage.setItem("name", peerName), name);
      // A fresh load, not a same-document hash change: this is someone opening a link.
      await page.goto("about:blank");
      await page.goto(`${BASE_URL}/#${ROOM}`);
      await waitFor(page, () => document.getElementById("status")?.textContent?.includes("In room"), {
        label: `${name} to join from the link`,
      });
      assert.equal(await page.inputValue("#room-code"), ROOM);
    }
    // Viewers get no tile, so the participant list is the only place they show up.
    for (const page of [sharer, viewer, viewer2]) {
      await waitFor(page, () => document.querySelectorAll("#roster-list li").length === 3, {
        label: "all three in the participant list",
      });
    }
  });

  // skipcq: JS-0098
  void it("does not connect anyone while nobody is sharing", async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1500);
    });
    for (const page of [sharer, viewer, viewer2]) {
      assert.equal(await page.evaluate(() => window.__pcs.length), 0, "a peer connection exists with nobody sharing");
    }
  });

  // skipcq: JS-0098
  void it("delivers video from the sharer to the viewer", async () => {
    await sharer.click("#share");

    const check = (): boolean => window.__pcs.some((pc) => pc.connectionState === "connected");
    await waitFor(sharer, check, { label: "sharer peer connection" });
    await waitFor(viewer, check, { label: "viewer peer connection" });

    // A tile with a live remote stream is what a real viewer would see.
    await waitFor(
      viewer,
      () => {
        const vids = [...document.querySelectorAll<HTMLVideoElement>(".tile video")];
        return vids.some((videoEl) => videoEl.srcObject instanceof MediaStream && videoEl.srcObject.getVideoTracks().length > 0);
      },
      { label: "viewer to receive a remote video track", timeout: 45_000 },
    );

    // And the frames must actually decode â€” a track that never renders is not delivery.
    await waitFor(
      viewer,
      async () => {
        for (const pc of window.__pcs) {
          const report = await pc.getStats();
          let decoded = 0;
          report.forEach((raw: unknown) => {
            const stat = raw as RawRtcStat;
            if (stat.type === "inbound-rtp" && stat.kind === "video") decoded = Math.max(decoded, stat.framesDecoded ?? 0);
          });
          if (decoded > 0) return decoded;
        }
        return 0;
      },
      { label: "decoded video frames on the viewer", timeout: 45_000, interval: 1000 },
    );

    const decoding = (await viewer.evaluate(readStats)).filter((stat) => (stat.framesDecoded ?? 0) > 0);
    assert.ok(decoding.length > 0, "no decoded frames");
    const firstDecoding = decoding[0];
    assert.ok(firstDecoding && (firstDecoding.bytesReceived ?? 0) > 0, "no bytes received");

    // The sharer must be encoding too, or we would be measuring a stalled stream.
    const encoding = (await sharer.evaluate(readStats)).filter((stat) => (stat.framesEncoded ?? 0) > 0);
    assert.ok(encoding.length > 0, "sharer encoded no frames");
  });

  // Regression: tiles relied on the `autoplay` attribute while unmuted, which Chrome
  // blocks without a user gesture â€” a shared deep link produced a permanently black
  // tile. This suite used to relax the autoplay policy, hiding exactly that.
  // skipcq: JS-0098
  void it("actually plays the received video, not just receives it", async () => {
    const playing = await waitFor(
      viewer,
      () => {
        const videoEl = [...document.querySelectorAll<HTMLVideoElement>(".tile video")].find((el) => el.srcObject);
        if (!videoEl) return null;
        return { paused: videoEl.paused, readyState: videoEl.readyState, t: videoEl.currentTime };
      },
      { label: "a tile with a stream", timeout: 30_000 },
    );
    assert.equal(playing.paused, false, `video element is paused: ${JSON.stringify(playing)}`);

    // currentTime must advance â€” a non-paused element that never renders is still broken.
    const t0 = await viewer.evaluate(
      () => [...document.querySelectorAll<HTMLVideoElement>(".tile video")].find((videoEl) => videoEl.srcObject)?.currentTime ?? 0,
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1500);
    });
    const t1 = await viewer.evaluate(
      () => [...document.querySelectorAll<HTMLVideoElement>(".tile video")].find((videoEl) => videoEl.srcObject)?.currentTime ?? 0,
    );
    assert.ok(t1 > t0, `playback did not advance: ${String(t0)} -> ${String(t1)}`);
  });

  // skipcq: JS-0098
  void it("connects each viewer to the sharer only, never to each other", async () => {
    const live = (): number => window.__pcs.filter((pc) => pc.connectionState !== "closed").length;
    await waitFor(viewer2, () => window.__pcs.some((pc) => pc.connectionState === "connected"), {
      label: "second viewer connected to the sharer",
    });
    assert.equal(await sharer.evaluate(live), 2, "sharer should hold one link per viewer");
    assert.equal(await viewer.evaluate(live), 1, "viewer should hold only the link to the sharer");
    assert.equal(await viewer2.evaluate(live), 1, "second viewer should hold only the link to the sharer");
  });

  // skipcq: JS-0098
  void it("connects directly rather than through a TURN relay", async () => {
    // The premise of the whole design: media must not pass through a server.
    // On loopback both ends are host candidates; the assertion that matters is
    // that neither side selected a relay.
    const namedPages: Array<[string, Page]> = [
      ["sharer", sharer],
      ["viewer", viewer],
    ];
    for (const [name, page] of namedPages) {
      const stats = await page.evaluate(readStats);
      const connected = stats.filter((stat) => stat.connectionState === "connected");
      assert.ok(connected.length > 0, `${name} had no connected peer connection`);
      // Assert a positively direct candidate type rather than merely "not relay":
      // localType is null when no pair is selected, which would pass vacuously.
      const DIRECT = ["host", "srflx", "prflx"];
      const withPair = connected.filter((stat) => stat.localType !== null);
      assert.ok(withPair.length > 0, `${name} had no selected candidate pair to inspect`);
      for (const stat of withPair) {
        assert.ok(
          stat.localType !== null && DIRECT.includes(stat.localType),
          `${name} local candidate was ${String(stat.localType)}, expected a direct type`,
        );
        assert.ok(
          stat.remoteType !== null && DIRECT.includes(stat.remoteType),
          `${name} remote candidate was ${String(stat.remoteType)}, expected a direct type`,
        );
      }
    }
  });

  // skipcq: JS-0098, JS-R1005
  void it("lets a viewer turn a stream down, and pause it so the sharer stops sending", async () => {
    const tile = ".tile:has(.tile-controls)";
    // Whether each of the sharer's live video senders is encoding. Self-contained,
    // because page.evaluate ships the function's source to the browser.
    const videoSendsActive = (): boolean[] =>
      window.__pcs
        .filter((pc) => pc.connectionState !== "closed")
        .flatMap((pc) => pc.getSenders())
        .filter((sender) => sender.track?.kind === "video")
        .map((sender) => sender.getParameters().encodings[0]?.active !== false);
    const remote = (): { paused: boolean; muted: boolean; volume: number } => {
      const videoEl = document.querySelector<HTMLVideoElement>(".tile:has(.tile-controls) video");
      if (!videoEl) throw new Error("missing tile video");
      return { paused: videoEl.paused, muted: videoEl.muted, volume: videoEl.volume };
    };

    await viewer.hover(tile);
    await viewer.fill(`${tile} .tile-volume`, "40");
    assert.equal((await viewer.evaluate(remote)).volume, 0.4);

    await viewer.click(`${tile} .tile-pause`);
    const pausedState = await viewer.evaluate(remote);
    assert.equal(pausedState.paused, true, "the video should be paused");
    assert.equal(pausedState.muted, true, "a paused stream should be silent");
    // Pausing is not just local: the sharer stops encoding for this viewer, and only this one.
    const deadline = Date.now() + 15_000;
    let active: boolean[] = [];
    while (Date.now() < deadline) {
      active = await sharer.evaluate(videoSendsActive);
      if (active.length === 2 && active.filter((isActive) => !isActive).length === 1) break;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });
    }
    assert.deepEqual([...active].sort((left, right) => Number(left) - Number(right)), [false, true], "sharer should stop sending to the paused viewer only");

    const beforeFrames = await viewer.evaluate(decodedFrames);
    await viewer.click(`${tile} .tile-paused`);
    const resumeDeadline = Date.now() + 15_000;
    while (Date.now() < resumeDeadline) {
      active = await sharer.evaluate(videoSendsActive);
      if (active.length === 2 && active.every(Boolean)) break;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      });
    }
    assert.deepEqual(active, [true, true], "sharer should resume sending after the viewer resumes");

    const framesDeadline = Date.now() + 30_000;
    let now = beforeFrames;
    while (Date.now() < framesDeadline && now <= beforeFrames + 10) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1000);
      });
      now = await viewer.evaluate(decodedFrames);
    }
    assert.ok(now > beforeFrames + 10, `frames did not flow again after resuming: ${String(beforeFrames)} -> ${String(now)}`);

    const resumed = await viewer.evaluate(remote);
    assert.equal(resumed.paused, false);
    assert.equal(resumed.muted, false);
    assert.equal(resumed.volume, 0.4, "resuming should keep the chosen volume");

    // Volume boost past 100% up to 200%:
    await viewer.fill(`${tile} .tile-volume`, "150");
    const boosted = await viewer.evaluate(() => {
      const videoEl = document.querySelector<HTMLVideoElement>(".tile:has(.tile-controls) video");
      const input = document.querySelector<HTMLInputElement>(".tile:has(.tile-controls) .tile-volume");
      if (!videoEl || !input) throw new Error("missing tile controls");
      return {
        volume: videoEl.volume,
        inputValue: input.value,
        inputTitle: input.title,
        boostedAttr: input.dataset["boosted"],
      };
    });
    assert.equal(boosted.volume, 1.0, "HTMLMediaElement volume should be clamped to 1.0");
    assert.equal(boosted.inputValue, "150");
    assert.ok(boosted.inputTitle.includes("150% (boosted)"));
    assert.equal(boosted.boostedAttr, "true");

    // Dragging back to standard range resets boost styling:
    await viewer.fill(`${tile} .tile-volume`, "75");
    const restored = await viewer.evaluate(() => {
      const videoEl = document.querySelector<HTMLVideoElement>(".tile:has(.tile-controls) video");
      const input = document.querySelector<HTMLInputElement>(".tile:has(.tile-controls) .tile-volume");
      if (!videoEl || !input) throw new Error("missing tile controls");
      return {
        volume: videoEl.volume,
        inputValue: input.value,
        boostedAttr: input.dataset["boosted"],
      };
    });
    assert.equal(restored.volume, 0.75);
    assert.equal(restored.inputValue, "75");
    assert.equal(restored.boostedAttr, "false");

    // Fits within the browser window bounds without page scrolling:
    const windowFit = await viewer.evaluate(() => {
      return {
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
      };
    });
    assert.equal(windowFit.pageScrolls, false, "stream stage should not cause vertical page scroll");

    // Fit vs. Fill toggle (Approach A):
    const fitBtn = `${tile} .tile-fit`;
    assert.equal(await viewer.getAttribute(fitBtn, "aria-pressed"), "false");
    await viewer.click(fitBtn);
    const coverState = await viewer.evaluate(() => {
      const tileEl = document.querySelector<HTMLElement>(".tile:has(.tile-controls)");
      const videoEl = tileEl?.querySelector<HTMLVideoElement>("video");
      if (!tileEl || !videoEl) throw new Error("missing tile video");
      return {
        fitAttr: tileEl.dataset["fit"],
        objectFit: window.getComputedStyle(videoEl).objectFit,
      };
    });
    assert.equal(coverState.fitAttr, "cover");
    assert.equal(coverState.objectFit, "cover");
    assert.equal(await viewer.getAttribute(fitBtn, "aria-pressed"), "true");

    // Toggle back to contain (fit):
    await viewer.click(fitBtn);
    const containState = await viewer.evaluate(() => {
      const tileEl = document.querySelector<HTMLElement>(".tile:has(.tile-controls)");
      const videoEl = tileEl?.querySelector<HTMLVideoElement>("video");
      if (!tileEl || !videoEl) throw new Error("missing tile video");
      return {
        fitAttr: tileEl.dataset["fit"],
        objectFit: window.getComputedStyle(videoEl).objectFit,
      };
    });
    assert.equal(containState.fitAttr, "contain");
    assert.equal(containState.objectFit, "contain");
    assert.equal(await viewer.getAttribute(fitBtn, "aria-pressed"), "false");
  });

  // skipcq: JS-0098
  void it("removes the viewer's tile when the sharer stops", async () => {
    await sharer.click("#share");
    await waitFor(
      viewer,
      () =>
        [...document.querySelectorAll<HTMLVideoElement>(".tile video")].every(
          (videoEl) => !(videoEl.srcObject instanceof MediaStream) || videoEl.srcObject.getVideoTracks().length === 0,
        ),
      { label: "viewer tile to clear", timeout: 30_000 },
    );
    // With nobody sharing, the links have no reason to exist: they are torn down.
    await waitFor(
      sharer,
      () => window.__pcs.every((pc) => pc.connectionState === "closed"),
      { label: "sharer links to close after stopping", timeout: 10_000 },
    );
  });

  // skipcq: JS-0098
  void it("lets only the room's creator remove people and lock the room", async () => {
    // The sharer joined first, so it created the room and is its host.
    const removeButtons = (page: Page): Promise<number> =>
      page.evaluate(() => document.querySelectorAll("#roster-list button").length);
    assert.equal(await removeButtons(sharer), 2, "host should see a Remove button per other person");
    assert.equal(await removeButtons(viewer), 0);
    assert.equal(await viewer.isVisible("#lock-btn"), false);

    await sharer.click("#roster-list li:has-text('viewer2') button");
    await waitFor(viewer2, () => document.getElementById("status")?.textContent?.includes("removed"), {
      label: "viewer2 to be told it was removed",
    });
    for (const page of [sharer, viewer]) {
      await waitFor(page, () => document.querySelectorAll("#roster-list li").length === 2, {
        label: "viewer2 to leave the participant list",
      });
    }

    await sharer.click("#lock-btn");
    await waitFor(viewer, () => document.getElementById("roster-title")?.textContent?.includes("locked"), {
      label: "viewer to see the room locked",
    });
    await waitFor(sharer, () => document.getElementById("lock-btn")?.textContent === "Unlock room", {
      label: "host's button to offer unlocking",
    });
  });
});
