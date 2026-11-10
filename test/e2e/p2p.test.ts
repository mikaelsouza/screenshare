import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright-core";
import {
  baseUrl,
  INSTRUMENT,
  launchBrowser,
  startServer,
  stopServer,
  waitFor,
  type ServerHandle,
} from "./helpers.ts";

// Fresh per run: wrangler dev keeps Durable Object storage between runs, and a room
// claimed by an earlier run has a host this run cannot be.
const ROOM = Array.from(
  crypto.getRandomValues(new Uint8Array(8)),
  (byteVal) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[byteVal % 31] ?? "A",
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

interface RawStatRecord {
  id: string;
  type: string;
  kind?: string;
  selectedCandidatePairId?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
  framesDecoded?: number;
  framesEncoded?: number;
  bytesReceived?: number;
  codecId?: string;
  mimeType?: string;
}

/** Read link stats out of the page's recorded RTCPeerConnections. */
const readStats = async (): Promise<LinkStatEntry[]> => {
  const candidateType = (byId: Map<string, RawStatRecord>, id?: string): string | null =>
    byId.get(id ?? "")?.candidateType ?? null;

  const applyTransport = (entry: LinkStatEntry, rec: RawStatRecord, byId: Map<string, RawStatRecord>): void => {
    const pair = byId.get(rec.selectedCandidatePairId ?? "");
    if (!pair) return;
    entry.localType = candidateType(byId, pair.localCandidateId);
    entry.remoteType = candidateType(byId, pair.remoteCandidateId);
  };

  const applyRecord = (entry: LinkStatEntry, rec: RawStatRecord, byId: Map<string, RawStatRecord>): void => {
    if (rec.type === "transport") {
      applyTransport(entry, rec, byId);
    } else if (rec.type === "inbound-rtp" && rec.kind === "video") {
      entry.framesDecoded = rec.framesDecoded ?? 0;
      entry.bytesReceived = rec.bytesReceived ?? 0;
    } else if (rec.type === "outbound-rtp" && rec.kind === "video") {
      entry.framesEncoded = rec.framesEncoded ?? 0;
    }
  };

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
    const byId = new Map<string, RawStatRecord>();
    report.forEach((statItem: unknown, id: string) => byId.set(id, statItem as RawStatRecord));
    for (const statRecord of byId.values()) {
      applyRecord(entry, statRecord, byId);
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
    report.forEach((statEntry: unknown) => {
      const rec = statEntry as RawStatRecord;
      if (rec.type === "inbound-rtp" && rec.kind === "video") total += rec.framesDecoded ?? 0;
    });
  }
  return total;
};

/** Negotiated inbound video codec mimeType (lowercase) on the first active peer connection, if any. */
const inboundVideoCodec = async (): Promise<string | null> => {
  for (const pc of window.__pcs) {
    if (pc.connectionState === "closed") continue;
    const report = await pc.getStats();
    const codecs = new Map<string, string>();
    let codecId: string | null = null;
    report.forEach((statEntry: unknown, id: string) => {
      const rec = statEntry as RawStatRecord;
      if (rec.type === "codec" && typeof rec.mimeType === "string") {
        codecs.set(id, rec.mimeType.toLowerCase());
      } else if (rec.type === "inbound-rtp" && rec.kind === "video" && typeof rec.codecId === "string") {
        codecId = rec.codecId;
      }
    });
    if (codecId && codecs.has(codecId)) return codecs.get(codecId) ?? null;
  }
  return null;
};

await describe("peer-to-peer screen sharing", { concurrency: 1 }, async () => {
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
    const pages: Array<[string, Page]> = [
      ["sharer", sharer],
      ["viewer", viewer],
      ["viewer2", viewer2],
    ];
    for (const [name, peerPage] of pages) {
      peerPage.on("console", (msg) => {
        if (msg.type() === "error") console.error(`[${name}]`, msg.text());
      });
    }
  });

  after(async () => {
    await browser?.close();
    await stopServer(server);
  });

  await it("serves the app and mints a room code", async () => {
    const res = await fetch(`${BASE_URL}/api/room`);
    assert.equal(res.status, 200);
    const { code } = (await res.json()) as { code: string };
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });

  await it("routes /ws and /api past the static assets", async () => {
    // not_found_handling must not swallow these into index.html.
    const ws = await fetch(`${BASE_URL}/ws/${ROOM}`);
    assert.equal(ws.status, 426, "expected websocket-only endpoint to reject a plain GET");
    const bad = await fetch(`${BASE_URL}/ws/short`);
    assert.equal(bad.status, 400);
  });

  interface RectBox {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface ShareBox {
    top: number;
    right: number;
    bottom: number;
    height: number;
  }

  const emptyRect: RectBox = { x: 0, y: 0, width: 0, height: 0 };
  const emptyShare: ShareBox = { top: 0, right: 0, bottom: 0, height: 0 };

  let lobbyGeometry = {
    header: emptyRect,
    h1: emptyRect,
    lobbyHidden: false,
    roomBarHidden: false,
    stageHidden: false,
    controlsHidden: false,
  };
  let watchingGeometry = {
    header: emptyRect,
    h1: emptyRect,
    controls: emptyRect,
    share: emptyShare,
    lobbyHidden: false,
    roomBarHidden: false,
    stageHidden: false,
    controlsHidden: false,
    liveControlsHidden: false,
    statusHidden: false,
  };

  await it("joins straight from a room link, without pressing Join, with zero header layout shift", async () => {
    // One at a time, so the sharer is first in and becomes the room's host.
    const pages: Array<[string, Page]> = [
      ["sharer", sharer],
      ["viewer", viewer],
      ["viewer2", viewer2],
    ];
    for (const [name, page] of pages) {
      await page.goto(BASE_URL);
      if (name === "sharer") {
        lobbyGeometry = await page.evaluate(() => {
          const headerRect = document.querySelector("header.app-bar")?.getBoundingClientRect();
          const h1Rect = document.querySelector("header.app-bar h1")?.getBoundingClientRect();
          if (!headerRect || !h1Rect) throw new Error("Missing header elements");
          return {
            header: { x: headerRect.x, y: headerRect.y, width: headerRect.width, height: headerRect.height },
            h1: { x: h1Rect.x, y: h1Rect.y, width: h1Rect.width, height: h1Rect.height },
            lobbyHidden: Boolean(document.getElementById("lobby")?.hidden),
            roomBarHidden: Boolean(document.getElementById("room-bar")?.hidden),
            stageHidden: Boolean(document.getElementById("stage")?.hidden),
            controlsHidden: Boolean(document.getElementById("controls")?.hidden),
          };
        });
        assert.equal(lobbyGeometry.header.height, 52, "Lobby header must be 52px tall");
        assert.equal(lobbyGeometry.lobbyHidden, false);
        assert.equal(lobbyGeometry.roomBarHidden, true);
        assert.equal(lobbyGeometry.stageHidden, true);
        assert.equal(lobbyGeometry.controlsHidden, true);
      }
      await page.evaluate((peerName) => localStorage.setItem("name", peerName), name);
      // Navigate via about:blank so opening /#ROOM is a genuine document navigation
      // (a same-origin hash change in Chromium does not re-run the page's load init).
      await page.goto("about:blank");
      await page.goto(`${BASE_URL}/#${ROOM}`);
      await waitFor(page, () => Boolean(document.getElementById("status")?.textContent?.includes("In room")), {
        label: `${name} to join from the link`,
      });
      assert.equal(await page.inputValue("#room-code"), ROOM);
    }

    watchingGeometry = await sharer.evaluate(() => {
      const headerRect = document.querySelector("header.app-bar")?.getBoundingClientRect();
      const h1Rect = document.querySelector("header.app-bar h1")?.getBoundingClientRect();
      const controlsRect = document.getElementById("controls")?.getBoundingClientRect();
      const shareRect = document.getElementById("share")?.getBoundingClientRect();
      const rosterBtnRect = document.getElementById("roster-btn")?.getBoundingClientRect();
      const copyLinkRect = document.getElementById("copy-link")?.getBoundingClientRect();
      if (!headerRect || !h1Rect || !controlsRect || !shareRect || !rosterBtnRect || !copyLinkRect) {
        throw new Error("Missing room bar elements");
      }
      if (rosterBtnRect.right > copyLinkRect.left) {
        throw new Error("#roster-btn must be positioned to the left of #copy-link");
      }
      if (document.getElementById("leave") !== null) {
        throw new Error("#leave button must not exist");
      }
      return {
        header: { x: headerRect.x, y: headerRect.y, width: headerRect.width, height: headerRect.height },
        h1: { x: h1Rect.x, y: h1Rect.y, width: h1Rect.width, height: h1Rect.height },
        controls: { x: controlsRect.x, y: controlsRect.y, width: controlsRect.width, height: controlsRect.height },
        share: { top: shareRect.top, right: shareRect.right, bottom: shareRect.bottom, height: shareRect.height },
        lobbyHidden: Boolean(document.getElementById("lobby")?.hidden),
        roomBarHidden: Boolean(document.getElementById("room-bar")?.hidden),
        stageHidden: Boolean(document.getElementById("stage")?.hidden),
        controlsHidden: Boolean(document.getElementById("controls")?.hidden),
        liveControlsHidden: Boolean(document.getElementById("live-controls")?.hidden),
        statusHidden: Boolean(document.getElementById("status")?.hidden),
      };
    });
    assert.deepEqual(watchingGeometry.header, lobbyGeometry.header, "header must have 0px shift from Lobby to Watching");
    assert.deepEqual(watchingGeometry.h1, lobbyGeometry.h1, "brand title h1 must have 0px shift from Lobby to Watching");
    assert.equal(watchingGeometry.controls.height, 52, "Watching footer controls must be 52px tall");
    assert.equal(watchingGeometry.lobbyHidden, true);
    assert.equal(watchingGeometry.roomBarHidden, false);
    assert.equal(watchingGeometry.stageHidden, false);
    assert.equal(watchingGeometry.controlsHidden, false);
    assert.equal(watchingGeometry.liveControlsHidden, true, "#live-controls must be hidden when not streaming");
    assert.equal(watchingGeometry.statusHidden, true, "#status must be hidden during normal info state");
    assert.equal(
      await sharer.evaluate(() => Boolean(document.getElementById("stage-empty")?.hidden)),
      false,
      "#stage-empty must be visible when no stream is running",
    );
    assert.equal(
      await sharer.textContent("#stage-empty-title"),
      "No one is sharing right now",
    );

    // Viewers get no tile, so the participant list is the only place they show up.
    for (const page of [sharer, viewer, viewer2]) {
      await waitFor(page, () => document.querySelectorAll("#roster-list li").length === 3, {
        label: "all three in the participant list",
      });
    }
  });

  await it("does not connect anyone while nobody is sharing", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (const page of [sharer, viewer, viewer2]) {
      assert.equal(await page.evaluate(() => window.__pcs.length), 0, "a peer connection exists with nobody sharing");
    }
  });

  await it("delivers video from the sharer to the viewer with zero footer/header layout shift", async () => {
    await sharer.click("#share");

    const streamingGeometry = await sharer.evaluate(() => {
      const headerRect = document.querySelector("header.app-bar")?.getBoundingClientRect();
      const h1Rect = document.querySelector("header.app-bar h1")?.getBoundingClientRect();
      const controlsRect = document.getElementById("controls")?.getBoundingClientRect();
      const shareEl = document.getElementById("share");
      const shareRect = shareEl?.getBoundingClientRect();
      const muteEl = document.getElementById("mute-audio");
      const muteRect = muteEl?.getBoundingClientRect();
      const rosterBtnRect = document.getElementById("roster-btn")?.getBoundingClientRect();
      const presetBtnRect = document.getElementById("preset-btn")?.getBoundingClientRect();
      const codecBtnRect = document.getElementById("codec-btn")?.getBoundingClientRect();
      const degradationBtnRect = document.getElementById("degradation-btn")?.getBoundingClientRect();
      if (
        !headerRect ||
        !h1Rect ||
        !controlsRect ||
        !shareEl ||
        !shareRect ||
        !muteEl ||
        !muteRect ||
        !rosterBtnRect ||
        !presetBtnRect ||
        !codecBtnRect ||
        !degradationBtnRect
      ) {
        throw new Error("Missing streaming elements");
      }
      if (presetBtnRect.right > codecBtnRect.left || codecBtnRect.right > degradationBtnRect.left) {
        throw new Error("#preset-btn, #codec-btn, and #degradation-btn must be ordered left-to-right");
      }
      if (muteEl.hidden || muteRect.right > shareRect.left) {
        throw new Error("#mute-audio must be visible and positioned to the left of #share");
      }
      return {
        header: { x: headerRect.x, y: headerRect.y, width: headerRect.width, height: headerRect.height },
        h1: { x: h1Rect.x, y: h1Rect.y, width: h1Rect.width, height: h1Rect.height },
        controls: { x: controlsRect.x, y: controlsRect.y, width: controlsRect.width, height: controlsRect.height },
        share: { top: shareRect.top, right: shareRect.right, bottom: shareRect.bottom, height: shareRect.height },
        rosterBtnWidth: rosterBtnRect.width,
        liveControlsHidden: Boolean(document.getElementById("live-controls")?.hidden),
        shareText: shareEl.textContent,
        shareDanger: shareEl.classList.contains("danger"),
      };
    });
    assert.deepEqual(streamingGeometry.header, watchingGeometry.header, "header must have 0px shift from Watching to Streaming");
    assert.deepEqual(streamingGeometry.h1, watchingGeometry.h1, "brand title h1 must have 0px shift from Watching to Streaming");
    assert.deepEqual(streamingGeometry.controls, watchingGeometry.controls, "footer #controls must have 0px shift from Watching to Streaming");
    assert.deepEqual(streamingGeometry.share, watchingGeometry.share, "#share button must stay pinned at the exact same bottom-right position");
    assert.equal(streamingGeometry.liveControlsHidden, false, "#live-controls must be visible while streaming");
    assert.equal(streamingGeometry.shareText, "Stop sharing");
    assert.equal(streamingGeometry.shareDanger, true);
    assert.equal(
      await sharer.evaluate(() => Boolean(document.getElementById("stage-empty")?.hidden)),
      true,
      "#stage-empty must be hidden while streaming tile is visible",
    );

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

    // And the frames must actually decode — a track that never renders is not delivery.
    await waitFor(
      viewer,
      async () => {
        for (const pc of window.__pcs) {
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
      { label: "decoded video frames on the viewer", timeout: 45_000, interval: 1000 },
    );

    const decoding = (await viewer.evaluate(readStats)).filter((stat) => (stat.framesDecoded ?? 0) > 0);
    assert.ok(decoding.length > 0, "no decoded frames");
    assert.ok((decoding[0]?.bytesReceived ?? 0) > 0, "no bytes received");

    // The sharer must be encoding too, or we would be measuring a stalled stream.
    const encoding = (await sharer.evaluate(readStats)).filter((stat) => (stat.framesEncoded ?? 0) > 0);
    assert.ok(encoding.length > 0, "sharer encoded no frames");

    // Verify #roster-btn width stays static even after outbound telemetry updates:
    const rosterBtnWidthAfterStats = await sharer.evaluate(
      () => document.getElementById("roster-btn")?.getBoundingClientRect().width ?? 0,
    );
    assert.equal(
      rosterBtnWidthAfterStats,
      streamingGeometry.rosterBtnWidth,
      "#roster-btn width must not jitter when telemetry updates",
    );

    // Verify self-preview hide and Show preview restore:
    await sharer.hover('.tile[data-peer="__self"]');
    await sharer.click('.tile[data-peer="__self"] .tile-hide-self');
    assert.equal(
      await sharer.evaluate(() => Boolean(document.querySelector<HTMLElement>('.tile[data-peer="__self"]')?.hidden)),
      true,
    );
    assert.equal(await sharer.evaluate(() => Boolean(document.getElementById("toggle-preview")?.hidden)), false);
    assert.equal(await sharer.evaluate(() => Boolean(document.getElementById("stage-empty")?.hidden)), false);
    assert.equal(await sharer.textContent("#stage-empty-title"), "Your stream preview is hidden");
    await sharer.click("#toggle-preview");
    assert.equal(
      await sharer.evaluate(() => Boolean(document.querySelector<HTMLElement>('.tile[data-peer="__self"]')?.hidden)),
      false,
    );
    assert.equal(await sharer.evaluate(() => Boolean(document.getElementById("toggle-preview")?.hidden)), true);
    assert.equal(await sharer.evaluate(() => Boolean(document.getElementById("stage-empty")?.hidden)), true);

    // Verify outbound audio mute toggle (#mute-audio):
    assert.equal(await sharer.getAttribute("#mute-audio", "aria-pressed"), "false");
    assert.equal(await sharer.textContent("#mute-audio"), "Mute audio");
    await sharer.click("#mute-audio");
    assert.equal(await sharer.getAttribute("#mute-audio", "aria-pressed"), "true");
    assert.equal(await sharer.textContent("#mute-audio"), "Mute audio");
    assert.equal(
      await sharer.evaluate(() => document.getElementById("mute-audio")?.classList.contains("muted-active")),
      true,
    );
    assert.equal(
      await sharer.evaluate(() => window.__gdmStreams?.[0]?.getAudioTracks()[0]?.enabled),
      false,
      "clicking #mute-audio must disable the outbound audio track",
    );
    await sharer.click("#mute-audio");
    assert.equal(await sharer.getAttribute("#mute-audio", "aria-pressed"), "false");
    assert.equal(
      await sharer.evaluate(() => document.getElementById("mute-audio")?.classList.contains("muted-active")),
      false,
    );
    assert.equal(
      await sharer.evaluate(() => window.__gdmStreams?.[0]?.getAudioTracks()[0]?.enabled),
      true,
      "clicking #mute-audio again must re-enable the outbound audio track",
    );

    // Verify live Quality (#preset-btn), Codec (#codec-btn), and Stream Priority (#degradation-btn)
    // popover changes while streaming keep the stream alive and restore keyboard focus to the trigger button:
    assert.equal(await sharer.textContent("#degradation-btn-label"), "Focus Framerate");
    assert.equal(
      await sharer.evaluate(() => {
        const senders = window.__pcs
          .filter((pc) => pc.connectionState !== "closed")
          .flatMap((pc) => pc.getSenders())
          .filter((sender) => sender.track?.kind === "video");
        return (
          senders.length > 0 &&
          senders.every((sender) => sender.getParameters().degradationPreference === "maintain-framerate")
        );
      }),
      true,
      "sharer video senders must start with maintain-framerate",
    );
    await sharer.evaluate(() => {
      window.__setParamsCalls = [];
    });
    await sharer.click("#degradation-btn");
    await sharer.focus('#degradation-list button[data-degradation="clarity"]');
    await sharer.click('#degradation-list button[data-degradation="clarity"]');
    assert.equal(
      await sharer.evaluate(() => document.activeElement?.id),
      "degradation-btn",
      "selecting a degradation option must restore focus to #degradation-btn",
    );
    assert.equal(await sharer.textContent("#degradation-btn-label"), "Focus Clarity");
    assert.equal(
      await sharer.evaluate(() => localStorage.getItem("stream-degradation")),
      "clarity",
    );
    await waitFor(
      sharer,
      () => {
        const senders = window.__pcs
          .filter((pc) => pc.connectionState !== "closed")
          .flatMap((pc) => pc.getSenders())
          .filter((sender) => sender.track?.kind === "video");
        if (senders.length === 0) return false;
        const calls = window.__setParamsCalls ?? [];
        const clarityCalls = calls.filter(
          (call) => call.degradationPreference === "maintain-framerate-and-resolution",
        );
        if (clarityCalls.length < senders.length) return false;
        if (clarityCalls.every((call) => call.ok)) {
          return senders.every((sender) => {
            const pref: string | undefined = sender.getParameters().degradationPreference;
            return pref === "maintain-framerate-and-resolution";
          });
        }
        const fallbackCalls = calls.filter(
          (call) => call.degradationPreference === "maintain-framerate" && call.ok,
        );
        return (
          fallbackCalls.length >= senders.length &&
          senders.every((sender) => sender.getParameters().degradationPreference === "maintain-framerate")
        );
      },
      { label: "sharer video sender clarity degradationPreference update" },
    );

    await sharer.evaluate(() => {
      window.__setParamsCalls = [];
    });
    await sharer.click("#degradation-btn");
    await sharer.focus('#degradation-list button[data-degradation="framerate"]');
    await sharer.click('#degradation-list button[data-degradation="framerate"]');
    assert.equal(
      await sharer.evaluate(() => document.activeElement?.id),
      "degradation-btn",
      "selecting Focus Framerate must restore focus to #degradation-btn",
    );
    assert.equal(await sharer.textContent("#degradation-btn-label"), "Focus Framerate");
    assert.equal(
      await sharer.evaluate(() => localStorage.getItem("stream-degradation")),
      "framerate",
    );
    await waitFor(
      sharer,
      () => {
        const senders = window.__pcs
          .filter((pc) => pc.connectionState !== "closed")
          .flatMap((pc) => pc.getSenders())
          .filter((sender) => sender.track?.kind === "video");
        const framerateCalls = (window.__setParamsCalls ?? []).filter(
          (call) => call.degradationPreference === "maintain-framerate" && call.ok,
        );
        return (
          senders.length > 0 &&
          framerateCalls.length >= senders.length &&
          senders.every((sender) => sender.getParameters().degradationPreference === "maintain-framerate")
        );
      },
      { label: "sharer video sender framerate degradationPreference restore" },
    );

    await sharer.click("#preset-btn");
    await sharer.focus('#preset-list button[data-preset="720p30"]');
    await sharer.click('#preset-list button[data-preset="720p30"]');
    assert.equal(
      await sharer.evaluate(() => document.activeElement?.id),
      "preset-btn",
      "selecting a preset option must restore focus to #preset-btn",
    );
    const av1Supported =
      (await sharer.evaluate(() =>
        Boolean(RTCRtpSender.getCapabilities("video")?.codecs.some((c) => c.mimeType.toLowerCase() === "video/av1")),
      )) &&
      (await viewer.evaluate(() =>
        Boolean(RTCRtpReceiver.getCapabilities("video")?.codecs.some((c) => c.mimeType.toLowerCase() === "video/av1")),
      ));
    await sharer.click("#codec-btn");
    await sharer.focus('#codec-list button[data-codec="av1"]');
    await sharer.click('#codec-list button[data-codec="av1"]');
    assert.equal(
      await sharer.evaluate(() => document.activeElement?.id),
      "codec-btn",
      "selecting a codec option must restore focus to #codec-btn",
    );
    if (av1Supported) {
      const codecDeadline = Date.now() + 30_000;
      let negotiatedCodec = await viewer.evaluate(inboundVideoCodec);
      while (Date.now() < codecDeadline && negotiatedCodec !== "video/av1") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        negotiatedCodec = await viewer.evaluate(inboundVideoCodec);
      }
      assert.equal(negotiatedCodec, "video/av1", "expected viewer inbound video codec to switch to video/av1");
    } else {
      assert.equal(
        await sharer.evaluate(() => window.__pcs.every((pc) => pc.connectionState === "connected")),
        true,
        "peer connection must remain connected when AV1 is unsupported",
      );
      const fallbackDeadline = Date.now() + 30_000;
      let fallbackCodec = await viewer.evaluate(inboundVideoCodec);
      while (Date.now() < fallbackDeadline && fallbackCodec === null) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        fallbackCodec = await viewer.evaluate(inboundVideoCodec);
      }
      assert.ok(
        fallbackCodec !== null && fallbackCodec !== "video/av1",
        `expected non-AV1 fallback codec when AV1 is unsupported: ${String(fallbackCodec)}`,
      );
    }
    const beforeSwitch = await viewer.evaluate(decodedFrames);
    const switchDeadline = Date.now() + 30_000;
    let afterSwitch = beforeSwitch;
    while (Date.now() < switchDeadline && afterSwitch <= beforeSwitch + 5) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      afterSwitch = await viewer.evaluate(decodedFrames);
    }
    assert.ok(
      afterSwitch > beforeSwitch + 5,
      `frames did not continue after preset/codec switch: ${String(beforeSwitch)} -> ${String(afterSwitch)}`,
    );
  });

  // Regression: tiles relied on the `autoplay` attribute while unmuted, which Chrome
  // blocks without a user gesture — a shared deep link produced a permanently black
  // tile. This suite used to relax the autoplay policy, hiding exactly that.
  await it("actually plays the received video, not just receives it", async () => {
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

    // currentTime must advance — a non-paused element that never renders is still broken.
    const t0 = await viewer.evaluate(
      () => [...document.querySelectorAll<HTMLVideoElement>(".tile video")].find((videoEl) => videoEl.srcObject)?.currentTime ?? 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const t1 = await viewer.evaluate(
      () => [...document.querySelectorAll<HTMLVideoElement>(".tile video")].find((videoEl) => videoEl.srcObject)?.currentTime ?? 0,
    );
    assert.ok(t1 > t0, `playback did not advance: ${t0} -> ${t1}`);
  });

  await it("connects each viewer to the sharer only, never to each other", async () => {
    const live = (): number => window.__pcs.filter((pc) => pc.connectionState !== "closed").length;
    await waitFor(viewer2, () => window.__pcs.some((pc) => pc.connectionState === "connected"), {
      label: "second viewer connected to the sharer",
    });
    assert.equal(await sharer.evaluate(live), 2, "sharer should hold one link per viewer");
    assert.equal(await viewer.evaluate(live), 1, "viewer should hold only the link to the sharer");
    assert.equal(await viewer2.evaluate(live), 1, "second viewer should hold only the link to the sharer");
  });

  await it("connects directly rather than through a TURN relay", async () => {
    // The premise of the whole design: media must not pass through a server.
    // On loopback both ends are host candidates; the assertion that matters is
    // that neither side selected a relay.
    const pages: Array<[string, Page]> = [
      ["sharer", sharer],
      ["viewer", viewer],
    ];
    for (const [name, page] of pages) {
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

  await it("lets a viewer turn a stream down, and pause it so the sharer stops sending", async () => {
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
      if (!videoEl) throw new Error("Missing tile video");
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
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.deepEqual([...active].sort((first, second) => Number(first) - Number(second)), [false, true], "sharer should stop sending to the paused viewer only");

    const beforeCount = await viewer.evaluate(decodedFrames);
    await viewer.click(`${tile} .tile-paused`);
    const resumeDeadline = Date.now() + 15_000;
    while (Date.now() < resumeDeadline) {
      active = await sharer.evaluate(videoSendsActive);
      if (active.length === 2 && active.every(Boolean)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.deepEqual(active, [true, true], "sharer should resume sending after the viewer resumes");

    const framesDeadline = Date.now() + 30_000;
    let now = beforeCount;
    while (Date.now() < framesDeadline && now <= beforeCount + 10) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      now = await viewer.evaluate(decodedFrames);
    }
    assert.ok(now > beforeCount + 10, `frames did not flow again after resuming: ${beforeCount} -> ${now}`);

    const resumed = await viewer.evaluate(remote);
    assert.equal(resumed.paused, false);
    assert.equal(resumed.muted, false);
    assert.equal(resumed.volume, 0.4, "resuming should keep the chosen volume");

    // Volume boost past 100% up to 200%:
    await viewer.fill(`${tile} .tile-volume`, "150");
    const boosted = await viewer.evaluate(() => {
      const videoEl = document.querySelector<HTMLVideoElement>(".tile:has(.tile-controls) video");
      const input = document.querySelector<HTMLInputElement>(".tile:has(.tile-controls) .tile-volume");
      if (!videoEl || !input) throw new Error("Missing tile controls");
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
      if (!videoEl || !input) throw new Error("Missing tile controls");
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
      if (!tileEl || !videoEl) throw new Error("Missing tile or video");
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
      if (!tileEl || !videoEl) throw new Error("Missing tile or video");
      return {
        fitAttr: tileEl.dataset["fit"],
        objectFit: window.getComputedStyle(videoEl).objectFit,
      };
    });
    assert.equal(containState.fitAttr, "contain");
    assert.equal(containState.objectFit, "contain");
    assert.equal(await viewer.getAttribute(fitBtn, "aria-pressed"), "false");

    // Per-tile stats pill toggle (.tile-stats -> .tile-health):
    const statsBtn = `${tile} .tile-stats`;
    assert.equal(
      await viewer.evaluate(() => Boolean(document.querySelector<HTMLElement>(".tile:has(.tile-controls) .tile-health")?.hidden)),
      true,
    );
    await viewer.click(statsBtn);
    assert.equal(
      await viewer.evaluate(() => Boolean(document.querySelector<HTMLElement>(".tile:has(.tile-controls) .tile-health")?.hidden)),
      false,
    );
    await viewer.click(statsBtn);
    assert.equal(
      await viewer.evaluate(() => Boolean(document.querySelector<HTMLElement>(".tile:has(.tile-controls) .tile-health")?.hidden)),
      true,
    );
  });

  await it("removes the viewer's tile when the sharer stops", async () => {
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

  await it("lets only the room's creator remove people and lock the room", async () => {
    await sharer.click("#roster-btn");
    await viewer.click("#roster-btn");
    // The sharer joined first, so it created the room and is its host.
    const removeButtons = (page: Page): Promise<number> =>
      page.evaluate(() => document.querySelectorAll("#roster-list button").length);
    assert.equal(await removeButtons(sharer), 2, "host should see a Remove button per other person");
    assert.equal(await removeButtons(viewer), 0);
    assert.equal(await sharer.isVisible("#lock-btn"), true);
    assert.equal(await viewer.isVisible("#lock-btn"), false);

    // Inline display-name editing inside the roster popover:
    await viewer.fill("#room-name", "viewer-renamed");
    await viewer.dispatchEvent("#room-name", "change");
    await waitFor(
      sharer,
      () =>
        [...document.querySelectorAll("#roster-list li")].some((li) =>
          Boolean(li.textContent?.includes("viewer-renamed")),
        ),
      { label: "sharer to see viewer's renamed display name" },
    );

    await sharer.click("#roster-list li:has-text('viewer2') button");
    await waitFor(viewer2, () => Boolean(document.getElementById("status")?.textContent?.includes("removed")), {
      label: "viewer2 to be told it was removed",
    });
    for (const page of [sharer, viewer]) {
      await waitFor(page, () => document.querySelectorAll("#roster-list li").length === 2, {
        label: "viewer2 to leave the participant list",
      });
    }

    await sharer.click("#lock-btn");
    await waitFor(viewer, () => Boolean(document.getElementById("roster-title")?.textContent?.includes("locked")), {
      label: "viewer to see the room locked",
    });
    await waitFor(sharer, () => document.getElementById("lock-btn")?.textContent === "Unlock room", {
      label: "host's button to offer unlocking",
    });
  });
});
