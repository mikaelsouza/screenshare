import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { baseUrl, INSTRUMENT, launchBrowser, startServer, stopServer, waitFor } from "./helpers.mjs";

// Fresh per run: wrangler dev keeps Durable Object storage between runs, and a room
// claimed by an earlier run has a host this run cannot be.
const ROOM = Array.from(
  crypto.getRandomValues(new Uint8Array(8)),
  (b) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 31],
).join("");
const PORT = 8890;
const BASE_URL = baseUrl(PORT);

let server;
let browser;
let sharer;
let viewer;
/** A second viewer: viewers must never connect to each other, only to the sharer. */
let viewer2;

/** Read link stats out of the page's recorded RTCPeerConnections. */
const readStats = async () => {
  const out = [];
  for (const pc of window.__pcs) {
    const report = await pc.getStats();
    const entry = { connectionState: pc.connectionState, localType: null, remoteType: null, framesDecoded: null, framesEncoded: null, bytesReceived: null };
    const byId = new Map();
    report.forEach((s, id) => byId.set(id, s));
    for (const s of byId.values()) {
      if (s.type === "transport" && s.selectedCandidatePairId) {
        const pair = byId.get(s.selectedCandidatePairId);
        if (pair) {
          entry.localType = byId.get(pair.localCandidateId)?.candidateType ?? null;
          entry.remoteType = byId.get(pair.remoteCandidateId)?.candidateType ?? null;
        }
      }
      if (s.type === "inbound-rtp" && s.kind === "video") {
        entry.framesDecoded = s.framesDecoded ?? 0;
        entry.bytesReceived = s.bytesReceived ?? 0;
      }
      if (s.type === "outbound-rtp" && s.kind === "video") {
        entry.framesEncoded = s.framesEncoded ?? 0;
      }
    }
    out.push(entry);
  }
  return out;
};

/** Frames decoded so far across every live inbound video stream on the page. */
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

describe("peer-to-peer screen sharing", { concurrency: 1 }, () => {
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
    for (const [name, p] of [["sharer", sharer], ["viewer", viewer], ["viewer2", viewer2]]) {
      p.on("console", (m) => { if (m.type() === "error") console.error(`[${name}]`, m.text()); });
    }
  });

  after(async () => {
    await browser?.close();
    await stopServer(server);
  });

  it("serves the app and mints a room code", async () => {
    const res = await fetch(`${BASE_URL}/api/room`);
    assert.equal(res.status, 200);
    const { code } = await res.json();
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });

  it("routes /ws and /api past the static assets", async () => {
    // not_found_handling must not swallow these into index.html.
    const ws = await fetch(`${BASE_URL}/ws/${ROOM}`);
    assert.equal(ws.status, 426, "expected websocket-only endpoint to reject a plain GET");
    const bad = await fetch(`${BASE_URL}/ws/short`);
    assert.equal(bad.status, 400);
  });

  it("joins straight from a room link, without pressing Join", async () => {
    // One at a time, so the sharer is first in and becomes the room's host.
    for (const [name, page] of [["sharer", sharer], ["viewer", viewer], ["viewer2", viewer2]]) {
      await page.goto(BASE_URL);
      await page.evaluate((n) => localStorage.setItem("name", n), name);
      // A fresh load, not a same-document hash change: this is someone opening a link.
      await page.goto(`${BASE_URL}/#${ROOM}`);
      await page.reload();
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

  it("does not connect anyone while nobody is sharing", async () => {
    await new Promise((r) => setTimeout(r, 1500));
    for (const page of [sharer, viewer, viewer2]) {
      assert.equal(await page.evaluate(() => window.__pcs.length), 0, "a peer connection exists with nobody sharing");
    }
  });

  it("delivers video from the sharer to the viewer", async () => {
    await sharer.click("#share");

    const check = () => window.__pcs.some((pc) => pc.connectionState === "connected");
    await waitFor(sharer, check, { label: "sharer peer connection" });
    await waitFor(viewer, check, { label: "viewer peer connection" });

    // A tile with a live remote stream is what a real viewer would see.
    await waitFor(
      viewer,
      () => {
        const vids = [...document.querySelectorAll(".tile video")];
        return vids.some((v) => v.srcObject && v.srcObject.getVideoTracks().length > 0);
      },
      { label: "viewer to receive a remote video track", timeout: 45_000 },
    );

    // And the frames must actually decode — a track that never renders is not delivery.
    await waitFor(
      viewer,
      async () => {
        for (const pc of window.__pcs) {
          const report = await pc.getStats();
          let decoded = 0;
          report.forEach((s) => {
            if (s.type === "inbound-rtp" && s.kind === "video") decoded = Math.max(decoded, s.framesDecoded ?? 0);
          });
          if (decoded > 0) return decoded;
        }
        return 0;
      },
      { label: "decoded video frames on the viewer", timeout: 45_000, interval: 1000 },
    );

    const decoding = (await viewer.evaluate(readStats)).filter((s) => (s.framesDecoded ?? 0) > 0);
    assert.ok(decoding.length > 0, "no decoded frames");
    assert.ok(decoding[0].bytesReceived > 0, "no bytes received");

    // The sharer must be encoding too, or we would be measuring a stalled stream.
    const encoding = (await sharer.evaluate(readStats)).filter((s) => (s.framesEncoded ?? 0) > 0);
    assert.ok(encoding.length > 0, "sharer encoded no frames");
  });

  // Regression: tiles relied on the `autoplay` attribute while unmuted, which Chrome
  // blocks without a user gesture — a shared deep link produced a permanently black
  // tile. This suite used to relax the autoplay policy, hiding exactly that.
  it("actually plays the received video, not just receives it", async () => {
    const playing = await waitFor(
      viewer,
      () => {
        const v = [...document.querySelectorAll(".tile video")].find((el) => el.srcObject);
        if (!v) return null;
        return { paused: v.paused, readyState: v.readyState, t: v.currentTime };
      },
      { label: "a tile with a stream", timeout: 30_000 },
    );
    assert.equal(playing.paused, false, `video element is paused: ${JSON.stringify(playing)}`);

    // currentTime must advance — a non-paused element that never renders is still broken.
    const t0 = await viewer.evaluate(() =>
      [...document.querySelectorAll(".tile video")].find((v) => v.srcObject)?.currentTime ?? 0);
    await new Promise((r) => setTimeout(r, 1500));
    const t1 = await viewer.evaluate(() =>
      [...document.querySelectorAll(".tile video")].find((v) => v.srcObject)?.currentTime ?? 0);
    assert.ok(t1 > t0, `playback did not advance: ${t0} -> ${t1}`);
  });

  it("connects each viewer to the sharer only, never to each other", async () => {
    const live = () => window.__pcs.filter((pc) => pc.connectionState !== "closed").length;
    await waitFor(viewer2, () => window.__pcs.some((pc) => pc.connectionState === "connected"), {
      label: "second viewer connected to the sharer",
    });
    assert.equal(await sharer.evaluate(live), 2, "sharer should hold one link per viewer");
    assert.equal(await viewer.evaluate(live), 1, "viewer should hold only the link to the sharer");
    assert.equal(await viewer2.evaluate(live), 1, "second viewer should hold only the link to the sharer");
  });

  it("connects directly rather than through a TURN relay", async () => {
    // The premise of the whole design: media must not pass through a server.
    // On loopback both ends are host candidates; the assertion that matters is
    // that neither side selected a relay.
    for (const [name, page] of [["sharer", sharer], ["viewer", viewer]]) {
      const stats = await page.evaluate(readStats);
      const connected = stats.filter((s) => s.connectionState === "connected");
      assert.ok(connected.length > 0, `${name} had no connected peer connection`);
      // Assert a positively direct candidate type rather than merely "not relay":
      // localType is null when no pair is selected, which would pass vacuously.
      const DIRECT = ["host", "srflx", "prflx"];
      const withPair = connected.filter((s) => s.localType !== null);
      assert.ok(withPair.length > 0, `${name} had no selected candidate pair to inspect`);
      for (const s of withPair) {
        assert.ok(DIRECT.includes(s.localType), `${name} local candidate was ${s.localType}, expected a direct type`);
        assert.ok(DIRECT.includes(s.remoteType), `${name} remote candidate was ${s.remoteType}, expected a direct type`);
      }
    }
  });

  it("lets a viewer turn a stream down, and pause it so the sharer stops sending", async () => {
    const tile = ".tile:has(.tile-controls)";
    // Whether each of the sharer's live video senders is encoding. Self-contained,
    // because page.evaluate ships the function's source to the browser.
    const videoSendsActive = () =>
      window.__pcs
        .filter((pc) => pc.connectionState !== "closed")
        .flatMap((pc) => pc.getSenders())
        .filter((s) => s.track?.kind === "video")
        .map((s) => s.getParameters().encodings?.[0]?.active !== false);
    const remote = () => {
      const v = document.querySelector(".tile:has(.tile-controls) video");
      return { paused: v.paused, muted: v.muted, volume: v.volume };
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
    let active = [];
    while (Date.now() < deadline) {
      active = await sharer.evaluate(videoSendsActive);
      if (active.length === 2 && active.filter((a) => !a).length === 1) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.deepEqual([...active].sort(), [false, true], "sharer should stop sending to the paused viewer only");

    const before = await viewer.evaluate(decodedFrames);
    await viewer.click(`${tile} .tile-paused`);
    const resumeDeadline = Date.now() + 15_000;
    while (Date.now() < resumeDeadline) {
      active = await sharer.evaluate(videoSendsActive);
      if (active.length === 2 && active.every(Boolean)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.deepEqual(active, [true, true], "sharer should resume sending after the viewer resumes");

    const framesDeadline = Date.now() + 30_000;
    let now = before;
    while (Date.now() < framesDeadline && now <= before + 10) {
      await new Promise((r) => setTimeout(r, 1000));
      now = await viewer.evaluate(decodedFrames);
    }
    assert.ok(now > before + 10, `frames did not flow again after resuming: ${before} -> ${now}`);

    const resumed = await viewer.evaluate(remote);
    assert.equal(resumed.paused, false);
    assert.equal(resumed.muted, false);
    assert.equal(resumed.volume, 0.4, "resuming should keep the chosen volume");

    // Volume boost past 100% up to 200%:
    await viewer.fill(`${tile} .tile-volume`, "150");
    const boosted = await viewer.evaluate(() => {
      const v = document.querySelector(".tile:has(.tile-controls) video");
      const input = document.querySelector(".tile:has(.tile-controls) .tile-volume");
      const pipes = window.__boostPipes;
      const gainVal = pipes && pipes.size > 0 ? [...pipes.values()][0].gain.gain.value : null;
      return {
        volume: v.volume,
        inputValue: input.value,
        inputTitle: input.title,
        boostedAttr: input.dataset.boosted,
        gainVal,
      };
    });
    assert.equal(boosted.volume, 1.0, "HTMLMediaElement volume should be clamped to 1.0");
    assert.equal(boosted.inputValue, "150");
    assert.ok(boosted.inputTitle.includes("150% (boosted)"));
    assert.equal(boosted.boostedAttr, "true");
    if (boosted.gainVal !== null) {
      assert.equal(boosted.gainVal, 1.5, "Web Audio gain should be 1.5 for 150% boost");
    }

    // Dragging back to standard range resets boost styling:
    await viewer.fill(`${tile} .tile-volume`, "75");
    const restored = await viewer.evaluate(() => {
      const v = document.querySelector(".tile:has(.tile-controls) video");
      const input = document.querySelector(".tile:has(.tile-controls) .tile-volume");
      return {
        volume: v.volume,
        inputValue: input.value,
        boostedAttr: input.dataset.boosted,
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
      const t = document.querySelector(".tile:has(.tile-controls)");
      const v = t.querySelector("video");
      return {
        fitAttr: t.dataset.fit,
        objectFit: window.getComputedStyle(v).objectFit,
      };
    });
    assert.equal(coverState.fitAttr, "cover");
    assert.equal(coverState.objectFit, "cover");
    assert.equal(await viewer.getAttribute(fitBtn, "aria-pressed"), "true");

    // Toggle back to contain (fit):
    await viewer.click(fitBtn);
    const containState = await viewer.evaluate(() => {
      const t = document.querySelector(".tile:has(.tile-controls)");
      const v = t.querySelector("video");
      return {
        fitAttr: t.dataset.fit,
        objectFit: window.getComputedStyle(v).objectFit,
      };
    });
    assert.equal(containState.fitAttr, "contain");
    assert.equal(containState.objectFit, "contain");
    assert.equal(await viewer.getAttribute(fitBtn, "aria-pressed"), "false");
  });

  it("removes the viewer's tile when the sharer stops", async () => {
    await sharer.click("#share");
    await waitFor(
      viewer,
      () => [...document.querySelectorAll(".tile video")].every((v) => !v.srcObject || v.srcObject.getVideoTracks().length === 0),
      { label: "viewer tile to clear", timeout: 30_000 },
    );
    // With nobody sharing, the links have no reason to exist: they are torn down.
    await waitFor(
      sharer,
      () => window.__pcs.every((pc) => pc.connectionState === "closed"),
      { label: "sharer links to close after stopping", timeout: 10_000 },
    );
  });

  it("lets only the room's creator remove people and lock the room", async () => {
    // The sharer joined first, so it created the room and is its host.
    const removeButtons = (page) => page.evaluate(() => document.querySelectorAll("#roster-list button").length);
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
