import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { baseUrl, INSTRUMENT, launchBrowser, startServer, stopServer, waitFor } from "./helpers.mjs";

/**
 * Regression for the transceiver leak: every stop/start on a link that survives
 * the stop used to add one video + one audio sendonly transceiver (and two m-lines)
 * on both ends. Here the host keeps sharing, so host<->late never closes; only
 * late<->viewer does, once per cycle.
 *
 * A fresh room avoids inheriting links from the other suites.
 */
const ROOM = Array.from(
  crypto.getRandomValues(new Uint8Array(8)),
  (b) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 31],
).join("");
const PORT = 8892;
const BASE_URL = baseUrl(PORT);

let server;
let browser;
let host;
let viewer;
let late;
const contexts = [];
let lateShortId;

const inRoom = () => document.getElementById("status")?.textContent?.includes("In room");

async function newPage(name) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(INSTRUMENT);
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.error(`[${name}]`, m.text()); });
  await page.goto(BASE_URL);
  await page.evaluate((n) => localStorage.setItem("name", n), name);
  await page.goto(`${BASE_URL}/#${ROOM}`);
  await page.reload();
  await waitFor(page, inRoom, { label: `${name} in the room` });
  return page;
}

/**
 * Every live PC as { transceivers, mlines, media, app }, read from its own SDP, or
 * null while any is mid-negotiation. localDescription still holds the previous
 * description until setLocalDescription lands, so reading it during
 * have-remote-offer can race the updated (answer) m-line count.
 */
const liveShapes = () => {
  const live = window.__pcs.filter((pc) => pc.connectionState !== "closed");
  if (live.some((pc) => pc.signalingState !== "stable")) return null;
  return live.map((pc) => {
    const sdp = pc.localDescription?.sdp ?? "";
    const mlines = (sdp.match(/^m=/gm) ?? []).length;
    const app = (sdp.match(/^m=application/gm) ?? []).length;
    return { transceivers: pc.getTransceivers().length, mlines, media: mlines - app, app };
  });
};

/** Stable host shapes, only once the retained 4-transceiver link is present. */
const hostRetainedShapes = () => {
  const live = window.__pcs.filter((pc) => pc.connectionState !== "closed");
  if (live.some((pc) => pc.signalingState !== "stable")) return null;
  const shapes = live.map((pc) => {
    const sdp = pc.localDescription?.sdp ?? "";
    const mlines = (sdp.match(/^m=/gm) ?? []).length;
    const app = (sdp.match(/^m=application/gm) ?? []).length;
    return { transceivers: pc.getTransceivers().length, mlines, media: mlines - app, app };
  });
  return shapes.filter((s) => s.transceivers === 4).length === 1 ? shapes : null;
};

/** Decoded video frames inbound on the retained host<->late link. */
const retainedFrames = async () => {
  for (const pc of window.__pcs) {
    if (pc.connectionState === "closed") continue;
    if (pc.getTransceivers().length !== 4) continue;
    const report = await pc.getStats();
    let frames = 0;
    report.forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "video") frames += s.framesDecoded ?? 0;
    });
    return frames;
  }
  return null;
};

async function waitFramesGrow(page, label) {
  const start = await page.evaluate(retainedFrames);
  assert.notEqual(start, null, `${label}: no retained 4-transceiver link`);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await page.evaluate(retainedFrames);
    if (now !== null && now > start + 10) return now;
  }
  throw new Error(`${label}: decoded frames stuck at ${start}`);
}

/**
 * The host's tile for late: full peer id in data-peer, roster shows only 4 chars.
 * Returns only once the tile is actually rendering, so waiting on it covers the
 * whole "tile exists and decodes" condition rather than just tile creation.
 */
const lateTile = () => {
  const el = document.querySelector(`[data-peer^="${window.__lateShort}"] video`);
  if (!el || !el.srcObject) return null;
  const live = el.srcObject.getVideoTracks().some((t) => t.readyState === "live");
  if (!live || el.videoWidth === 0 || el.readyState < 2) return null;
  return { live, videoWidth: el.videoWidth, readyState: el.readyState };
};

describe("persistent sendonly transceivers", { concurrency: 1 }, () => {
  before(async () => {
    server = await startServer(PORT);
    browser = await launchBrowser();
    host = await newPage("host");
    viewer = await newPage("viewer");
    late = await newPage("late");
    for (const page of [host, viewer, late]) {
      await waitFor(page, () => document.querySelectorAll("#roster-list li").length === 3, {
        label: "all three in the participant list",
      });
    }

    // The roster's own entry shows the same 4-character prefix the tile's data-peer
    // starts with; the full id is never rendered.
    lateShortId = await late.evaluate(
      () => document.querySelector("#roster-list li .peer-id")?.textContent ?? "",
    );
    assert.match(lateShortId, /^[0-9a-f]{4}$/);
    await host.evaluate((id) => { window.__lateShort = id; }, lateShortId);

    // The host shares first and keeps sharing for the whole suite.
    await host.click("#share");
    for (const [name, page] of [["host", host], ["viewer", viewer], ["late", late]]) {
      await waitFor(page, () => window.__pcs.some((pc) => pc.connectionState === "connected"), {
        label: `${name} connected to the host`,
      });
    }
  });

  after(async () => {
    for (const ctx of contexts) await ctx.close().catch(() => {});
    await browser?.close();
    await stopServer(server);
  });

  it("keeps one video/audio pair on the retained link across five share cycles", async () => {
    for (let cycle = 1; cycle <= 5; cycle++) {
      // Mark the viewer's PC list so the link late creates for this cycle is identifiable.
      await viewer.evaluate(() => { window.__cycleMark = window.__pcs.length; });
      await late.click("#share");
      await waitFor(late, () => document.getElementById("share")?.textContent === "Stop sharing", {
        label: `cycle ${cycle}: late starts sharing`,
      });

      // Re-emitted tile: live video, actually decoded (width/readyState come from frames).
      const tile = await waitFor(host, lateTile, {
        label: `cycle ${cycle}: late tile live`,
        timeout: 45_000,
        interval: 250,
      });
      assert.equal(tile.live, true);
      assert.ok(tile.videoWidth > 0, `cycle ${cycle}: tile has no decoded width`);
      assert.ok(tile.readyState >= 2, `cycle ${cycle}: tile readyState ${tile.readyState}`);

      // The retained host<->late link is one pair each way: 4 transceivers, 5 m-lines.
      // Aggregate host links: host<->viewer (2 media) + host<->late (4 media).
      const shapes = await waitFor(host, hostRetainedShapes, {
        label: `cycle ${cycle}: retained host link stable`,
      });
      const retained = shapes.find((s) => s.transceivers === 4);
      assert.deepEqual(retained, { transceivers: 4, mlines: 5, media: 4, app: 1 });
      assert.equal(shapes.reduce((n, s) => n + s.media, 0), 6, `cycle ${cycle}: host media m-lines grew`);
      assert.equal(shapes.reduce((n, s) => n + s.app, 0), 2, `cycle ${cycle}: host app m-lines grew`);

      // late<->viewer is a fresh PC each restart, back to one pair and no growth.
      const fresh = await waitFor(
        viewer,
        () => {
          const added = window.__pcs
            .slice(window.__cycleMark)
            .filter((pc) => pc.connectionState !== "closed");
          if (added.length !== 1) return null;
          const pc = added[0];
          if (pc.signalingState !== "stable") return null;
          const sdp = pc.localDescription?.sdp ?? "";
          const mlines = (sdp.match(/^m=/gm) ?? []).length;
          const app = (sdp.match(/^m=application/gm) ?? []).length;
          if (mlines === 0) return null;
          return { transceivers: pc.getTransceivers().length, mlines, media: mlines - app, app };
        },
        { label: `cycle ${cycle}: fresh late<->viewer link` },
      );
      assert.deepEqual(fresh, { transceivers: 2, mlines: 3, media: 2, app: 1 });

      // Video must actually flow from late on the retained link, not just be present.
      await waitFramesGrow(host, `cycle ${cycle}: late frames`);

      await late.click("#share");
      await waitFor(late, () => document.getElementById("share")?.textContent === "Share screen", {
        label: `cycle ${cycle}: late stops sharing`,
      });
      // late closes its link to the viewer locally; its link to the host stays. The
      // viewer's stale PC is not inspected: a remote close can sit at "failed".
      await waitFor(late, () => window.__pcs.filter((pc) => pc.connectionState !== "closed").length === 1, {
        label: `cycle ${cycle}: late<->viewer link closed`,
      });
      await waitFor(host, () => !document.querySelector(`[data-peer^="${window.__lateShort}"]`), {
        label: `cycle ${cycle}: late tile removed`,
      });

      // Stopping does not drop the retained link or grow it: still 4 transceivers.
      const stopped = await waitFor(host, liveShapes, {
        label: `cycle ${cycle}: host links stable after stop`,
      });
      assert.deepEqual(stopped.find((s) => s.transceivers === 4), {
        transceivers: 4,
        mlines: 5,
        media: 4,
        app: 1,
      });
      assert.equal(stopped.reduce((n, s) => n + s.media, 0), 6, `cycle ${cycle}: host media m-lines grew after stop`);
      assert.equal(stopped.reduce((n, s) => n + s.app, 0), 2, `cycle ${cycle}: host app m-lines grew after stop`);
    }
  });

  it("re-emits the late tile with live video after a restart", async () => {
    // The previous test normally ends stopped. If it aborted mid-cycle, stop late
    // here so this test still exercises re-emit instead of timing out on setup.
    if ((await late.textContent("#share")) === "Stop sharing") {
      await late.click("#share");
      await waitFor(late, () => document.getElementById("share")?.textContent === "Share screen", {
        label: "late stopped before restart test",
      });
    }
    // The tile is the observable signal that stopping reached the host on a link
    // that is still alive, so it must disappear before a restart can re-emit it.
    await waitFor(host, () => !document.querySelector(`[data-peer^="${window.__lateShort}"]`), {
      label: "late tile gone before restart",
    });
    await late.click("#share");

    const tile = await waitFor(host, lateTile, {
      label: "late tile re-emitted",
      timeout: 45_000,
      interval: 250,
    });
    assert.equal(tile.live, true, "re-emitted tile has no live video track");
    assert.ok(tile.videoWidth > 0, "re-emitted tile never decoded a frame");
    assert.ok(tile.readyState >= 2, `re-emitted tile readyState ${tile.readyState}`);

    // Same retained link, still one pair, and frames keep arriving.
    const shapes = await waitFor(host, hostRetainedShapes, {
      label: "retained host link stable after restart",
    });
    assert.deepEqual(shapes.find((s) => s.transceivers === 4), {
      transceivers: 4,
      mlines: 5,
      media: 4,
      app: 1,
    });
    await waitFramesGrow(host, "late frames after restart");

    await late.click("#share");
  });
});
