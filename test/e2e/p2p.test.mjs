import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { baseUrl, INSTRUMENT, launchBrowser, startServer, stopServer, waitFor } from "./helpers.mjs";

const ROOM = "ABCDEFGH";
const PORT = 8890;
const BASE_URL = baseUrl(PORT);

let server;
let browser;
let sharer;
let viewer;

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

describe("peer-to-peer screen sharing", { concurrency: 1 }, () => {
  before(async () => {
    server = await startServer(PORT);
    browser = await launchBrowser();

    // Separate contexts so the two peers get separate localStorage identities.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.addInitScript(INSTRUMENT);
    await ctxB.addInitScript(INSTRUMENT);
    sharer = await ctxA.newPage();
    viewer = await ctxB.newPage();
    for (const p of [sharer, viewer]) {
      p.on("console", (m) => { if (m.type() === "error") console.error(`[${p === sharer ? "sharer" : "viewer"}]`, m.text()); });
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

  it("loads the app for both peers and joins them to one room", async () => {
    await sharer.goto(`${BASE_URL}/#${ROOM}`);
    await viewer.goto(`${BASE_URL}/#${ROOM}`);

    for (const [name, page] of [["sharer", sharer], ["viewer", viewer]]) {
      await waitFor(page, () => document.getElementById("status")?.textContent?.includes("In room"), {
        label: `${name} to join the room`,
      });
    }
  });

  it("establishes a peer connection between the two browsers", async () => {
    const check = () => window.__pcs.length > 0 && window.__pcs.some((pc) => pc.connectionState === "connected");
    await waitFor(sharer, check, { label: "sharer peer connection" });
    await waitFor(viewer, check, { label: "viewer peer connection" });
  });

  it("delivers video from the sharer to the viewer", async () => {
    await sharer.click("#share");

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

  it("removes the viewer's tile when the sharer stops", async () => {
    await sharer.click("#share");
    await waitFor(
      viewer,
      () => [...document.querySelectorAll(".tile video")].every((v) => !v.srcObject || v.srcObject.getVideoTracks().length === 0),
      { label: "viewer tile to clear", timeout: 30_000 },
    );
  });
});
