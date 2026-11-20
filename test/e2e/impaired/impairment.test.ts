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
} from "../helpers.ts";

const PORT = 8892;
const BASE_URL = baseUrl(PORT);

let server: ServerHandle | undefined;
let browser: Browser | undefined;
let host: Page;
let viewer: Page;
const contexts: BrowserContext[] = [];

interface RawStatRecord {
  id: string;
  type: string;
  kind?: string;
  framesDecoded?: number;
  framesEncoded?: number;
  bytesReceived?: number;
}

const decodedFrames = async (): Promise<number> => {
  let total = 0;
  for (const pc of window.__pcs) {
    if (pc.connectionState === "closed") continue;
    const report = await pc.getStats();
    report.forEach((statEntry: unknown) => {
      const rec = statEntry as RawStatRecord;
      if (rec.type === "inbound-rtp" && rec.kind === "video") {
        total += rec.framesDecoded ?? 0;
      }
    });
  }
  return total;
};

const encodedFrames = async (): Promise<number> => {
  let total = 0;
  for (const pc of window.__pcs) {
    if (pc.connectionState === "closed") continue;
    const report = await pc.getStats();
    report.forEach((statEntry: unknown) => {
      const rec = statEntry as RawStatRecord;
      if (rec.type === "outbound-rtp" && rec.kind === "video") {
        total += rec.framesEncoded ?? 0;
      }
    });
  }
  return total;
};

async function attachImpairmentCdp(page: Page): Promise<void> {
  if (process.env["NETEM_ACTIVE"] === "1") {
    // Kernel tc netem already shapes loopback TCP/UDP; skip duplicate CDP latency.
    return;
  }
  const client = await page.context().newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 60,
    downloadThroughput: (5 * 1024 * 1024) / 8,
    uploadThroughput: (5 * 1024 * 1024) / 8,
  });
}

async function waitForDecodedAdvance(
  page: Page,
  minDelta: number,
  label: string,
): Promise<number> {
  const start = await page.evaluate(decodedFrames);
  const deadline = Date.now() + 45_000;
  let current = start;
  while (Date.now() < deadline) {
    current = await page.evaluate(decodedFrames);
    if (current >= start + minDelta) return current;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${label}: decoded frames stalled at ${String(current)} (start=${String(start)})`);
}

await describe("network-impaired WebRTC P2P E2E", { concurrency: 1 }, async () => {
  let invite = "";
  const pageErrors: string[] = [];

  before(async () => {
    server = await startServer(PORT);
    browser = await launchBrowser();

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    contexts.push(ctxA, ctxB);
    await ctxA.addInitScript(INSTRUMENT);
    await ctxB.addInitScript(INSTRUMENT);

    host = await ctxA.newPage();
    viewer = await ctxB.newPage();
    for (const [name, p] of [
      ["host", host],
      ["viewer", viewer],
    ] as const) {
      p.on("pageerror", (err) => {
        pageErrors.push(`${name}: ${err.message || String(err)}`);
      });
      p.on("console", (msg) => {
        if (msg.type() === "error") {
          console.error(`[impaired:${name}]`, msg.text());
        }
      });
    }

    await attachImpairmentCdp(host);
    await attachImpairmentCdp(viewer);
  });

  after(async () => {
    await Promise.allSettled(contexts.map((c) => c.close()));
    await browser?.close();
    await stopServer(server);
  });

  await it("converges ICE and delivers live video frames under packet loss, jitter, and 5 Mbps cap", async () => {
    await host.goto(BASE_URL);
    await host.fill("#display-name", "impaired-host");
    await host.click("#create");
    await waitFor(host, () => Boolean(document.getElementById("status")?.textContent?.includes("In room")), {
      label: "host joined under impairment",
      timeout: 30_000,
    });

    await host.click("#invite-btn");
    await host.click("#invite-show-btn");
    invite = ((await host.textContent("#invite-code-value")) ?? "").trim();
    assert.match(invite, /^[A-Z2-9]{8}-[A-Z2-9]{16}$/);
    await host.click("#invite-btn");

    await viewer.goto(BASE_URL);
    await viewer.fill("#display-name", "impaired-viewer");
    await viewer.fill("#room-code", invite);
    await viewer.click("#join");
    await waitFor(viewer, () => Boolean(document.getElementById("status")?.textContent?.includes("In room")), {
      label: "viewer joined under impairment",
      timeout: 30_000,
    });

    await host.click("#share");
    await waitFor(
      host,
      () => window.__pcs.some((pc) => pc.connectionState === "connected"),
      { label: "host ICE connected under impairment", timeout: 45_000 },
    );
    await waitFor(
      viewer,
      () => window.__pcs.some((pc) => pc.connectionState === "connected"),
      { label: "viewer ICE connected under impairment", timeout: 45_000 },
    );

    const decoded = await waitForDecodedAdvance(viewer, 5, "initial impaired stream");
    assert.ok(decoded >= 5);
    const encoded = await host.evaluate(encodedFrames);
    assert.ok(encoded >= 5, `expected host to encode frames under impairment, got ${String(encoded)}`);

    // Switch Focus Framerate -> Focus Clarity -> Focus Framerate under impairment
    await host.click("#degradation-btn");
    await host.click('#degradation-list button[data-degradation="clarity"]');
    assert.equal(await host.textContent("#degradation-btn-label"), "Focus Clarity");
    await waitForDecodedAdvance(viewer, 3, "impaired Focus Clarity delivery");

    await host.click("#degradation-btn");
    await host.click('#degradation-list button[data-degradation="framerate"]');
    assert.equal(await host.textContent("#degradation-btn-label"), "Focus Framerate");
    await waitForDecodedAdvance(viewer, 3, "impaired Focus Framerate restore");
  });

  await it("recovers share stop/restart and simultaneous mutual-share glare without m=-line bloat or page errors", async () => {
    // Stop host share -> all links close under impairment
    await host.click("#share");
    await waitFor(
      host,
      () => window.__pcs.every((pc) => pc.connectionState === "closed"),
      { label: "impaired links closed when sharing stops", timeout: 20_000 },
    );

    // Trigger simultaneous mutual share (glare) under impairment
    await Promise.all([host.click("#share"), viewer.click("#share")]);
    await waitFor(
      host,
      () =>
        window.__pcs.some((pc) => pc.connectionState === "connected") &&
        document.querySelector(".tile:has(.tile-pause) video") !== null,
      { label: "host mutual glare link connected", timeout: 45_000 },
    );
    await waitFor(
      viewer,
      () =>
        window.__pcs.some((pc) => pc.connectionState === "connected") &&
        document.querySelector(".tile:has(.tile-pause) video") !== null,
      { label: "viewer mutual glare link connected", timeout: 45_000 },
    );

    await waitForDecodedAdvance(viewer, 3, "mutual share viewer decode");
    await waitForDecodedAdvance(host, 3, "mutual share host decode");

    const cycle1 = await host.evaluate(() => {
      const live = window.__pcs.filter((pc) => pc.connectionState !== "closed");
      const [pc] = live;
      if (!pc) return null;
      return {
        mLines: (pc.localDescription?.sdp?.match(/^m=/gm) ?? []).length,
        transceivers: pc.getTransceivers().length,
      };
    });
    assert.ok(cycle1 !== null && cycle1.mLines <= 5 && cycle1.transceivers <= 4, `unexpected glare SDP metrics: ${JSON.stringify(cycle1)}`);

    // Stop and restart host share while viewer remains sharing (reusing persistent transceivers)
    await host.click("#share");
    await waitFor(
      viewer,
      () => document.querySelector(".tile:has(.tile-pause)") === null,
      { label: "viewer remote tile cleared after stop", timeout: 25_000 },
    );
    await host.click("#share");
    await waitForDecodedAdvance(viewer, 4, "viewer decode after restart under impairment");

    const cycle2 = await host.evaluate(() => {
      const live = window.__pcs.filter((pc) => pc.connectionState !== "closed");
      const [pc] = live;
      if (!pc) return null;
      return {
        mLines: (pc.localDescription?.sdp?.match(/^m=/gm) ?? []).length,
        transceivers: pc.getTransceivers().length,
      };
    });
    assert.deepEqual(cycle2, cycle1, `SDP m=-lines/transceivers changed after restart: ${JSON.stringify(cycle1)} -> ${JSON.stringify(cycle2)}`);

    // Stop both shares and verify clean teardown + zero CSP/page errors
    await Promise.all([host.click("#share"), viewer.click("#share")]);
    await waitFor(
      host,
      () => window.__pcs.every((pc) => pc.connectionState === "closed"),
      { label: "host links closed at end", timeout: 20_000 },
    );
    await waitFor(
      viewer,
      () => window.__pcs.every((pc) => pc.connectionState === "closed"),
      { label: "viewer links closed at end", timeout: 20_000 },
    );

    assert.deepEqual(await host.evaluate(() => window.__csp), [], "host hit CSP violation");
    assert.deepEqual(await viewer.evaluate(() => window.__csp), [], "viewer hit CSP violation");
    assert.deepEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join("; ")}`);
  });
});
