/**
 * Manual verification harness library. Manual-only: never imported by product code or
 * CI, never re-exports the e2e helpers, and no Chrome is touched until launchBrowser().
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SELECTORS = Object.freeze({
  name: "#display-name", room: "#room-code", create: "#create", join: "#join",
  relayOnly: "#relay-only", preset: "#preset", codec: "#codec", status: "#status",
  roster: "#roster", rosterList: "#roster-list", share: "#share", audioMode: "#audio-mode",
  audioChipText: "#audio-chip-text", audioPickApp: "#audio-pick-app", tileHealth: ".tile-health",
});
export const DIRECT_TYPES = Object.freeze(["host", "srflx", "prflx"]);
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, SKIP: 2, SETUP: 3, WARN: 4 });
export const latencyPageUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "latency.html")).href;
export class UsageError extends Error {}
export class SetupError extends Error {}
export class UserCancelError extends Error {}
export class TimeoutError extends Error {}
export const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)));

/** Chrome first, then Chromium package names, then Edge. */
export function findChrome() {
  const e = process.env;
  const candidates = [
    e.CHROMIUM_BIN, e.CHROME_PATH,
    process.platform === "win32" ? join(e.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe") : null,
    process.platform === "win32" ? join(e["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe") : null,
    process.platform === "win32" ? join(e.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe") : null,
    process.platform === "win32" ? join(e.PROGRAMFILES ?? "", "Microsoft/Edge/Application/msedge.exe") : null,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : null,
    process.platform === "darwin" ? "/Applications/Chromium.app/Contents/MacOS/Chromium" : null,
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
    "/usr/bin/chromium-browser", "/snap/bin/chromium",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new SetupError("Chrome not found. Set CHROMIUM_BIN to a Chrome/Chromium executable.");
  return found;
}

/** Runs before app scripts. Self-contained: Playwright ships this function's source. */
export function instrumentation(config) {
  window.__pcs = []; window.__csp = []; window.__gdmOpts = []; window.__gdmReturns = [];
  window.__gdmStreams = []; window.__gdmTimers = []; window.__gdmAudio = [];
  try {
    if (config.name) localStorage.setItem("name", config.name);
    if (config.preset) localStorage.setItem("preset", config.preset);
    if (config.codec) localStorage.setItem("codec", config.codec);
    if (config.audioMode) localStorage.setItem("audio_mode", config.audioMode);
    localStorage.setItem("relay_only", config.relayOnly ? "true" : "false");
  } catch {}
  document.addEventListener("securitypolicyviolation", (event) =>
    window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));

  const NativePc = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new NativePc(...args);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = NativePc.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, NativePc);

  const remember = (options) => {
    const index = window.__gdmOpts.length;
    try { window.__gdmOpts.push(JSON.parse(JSON.stringify(options ?? {}))); }
    catch { window.__gdmOpts.push({}); }
    return index;
  };
  const record = (index, stream) => {
    const video = stream.getVideoTracks()[0];
    window.__gdmStreams.push(stream);
    window.__gdmReturns.push({
      index, hasAudio: stream.getAudioTracks().length > 0,
      videoLabel: video?.label ?? null, videoSettings: video?.getSettings?.() ?? null,
    });
  };
  const native = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices);
  if (config.media !== "fake") {
    // Real mode leaves the picker to the operator; wrapping the native call only records
    // what was requested and returned, so the audio evidence checks still work.
    if (native) navigator.mediaDevices.getDisplayMedia = async (options) => {
      const index = remember(options);
      const stream = await native(options);
      record(index, stream);
      return stream;
    };
    return;
  }

  const makeVideo = (width, height, fps, label, displaySurface) => {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    let frame = 0;
    window.__gdmTimers.push(setInterval(() => {
      frame += 1;
      if (!ctx) return;
      ctx.fillStyle = `hsl(${(frame * 7) % 360}, 90%, 45%)`;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#fff"; ctx.font = "64px monospace";
      ctx.fillText(String(frame), 40, height / 2);
    }, 1000 / Math.max(1, Math.min(fps, 30))));
    const stream = canvas.captureStream(fps);
    const track = stream.getVideoTracks()[0];
    if (track) {
      try { Object.defineProperty(track, "label", { configurable: true, get: () => label }); } catch {}
      const nativeSettings = track.getSettings.bind(track);
      try {
        Object.defineProperty(track, "getSettings", {
          configurable: true,
          value: () => ({ ...nativeSettings(), displaySurface, width, height, frameRate: fps }),
        });
      } catch {}
    }
    return { stream, track };
  };
  const makeAudio = () => {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const destination = ctx.createMediaStreamDestination();
    const oscillator = ctx.createOscillator();
    oscillator.type = "sawtooth"; oscillator.frequency.value = 220;
    oscillator.connect(destination); oscillator.start();
    window.__gdmAudio.push({ ctx, oscillator });
    const track = destination.stream.getAudioTracks()[0];
    if (track) { try { Object.defineProperty(track, "label", { value: "Fake game audio" }); } catch {} }
    return { stream: destination.stream, track };
  };
  const capture = (options, index) => {
    const wantsAudio = options?.audio !== false;
    const audioOnlyPick = config.captureMode === "second-pick" && index > 0;
    const wholeScreenFirst = config.captureMode === "second-pick" && index === 0;
    const video = audioOnlyPick
      ? makeVideo(320, 180, 1, "Fake Game Window", "window")
      : wholeScreenFirst
        ? makeVideo(1280, 720, 30, "Fake Whole Screen", "monitor")
        : makeVideo(1280, 720, 30, "Fake Game Window", "window");
    const stream = video.stream;
    if (wantsAudio && !wholeScreenFirst) {
      const audio = makeAudio();
      if (audio.track) stream.addTrack(audio.track);
    }
    record(index, stream);
    return stream;
  };
  navigator.mediaDevices.getDisplayMedia = async (options) => capture(options, remember(options));
}

export function watchPage(page, label = "peer") {
  const logs = [], errors = [];
  page.on("console", (message) => logs.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => errors.push(String(error)));
  return { label, logs, errors };
}

export async function launchBrowser({ media = "real", headed = false } = {}) {
  const executablePath = findChrome();
  const { chromium } = await import("playwright-core");
  const args = [
    "--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
  if (media === "fake") args.push("--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream");
  try { return await chromium.launch({ executablePath, headless: !headed, args }); }
  catch (error) { throw new SetupError(`could not launch Chrome (${executablePath}): ${error.message}`); }
}

export async function newPeer(browser, config = {}) {
  const context = await browser.newContext({ viewport: config.viewport ?? { width: 1280, height: 720 } });
  await context.addInitScript(instrumentation, { ...config });
  const page = await context.newPage();
  return { context, page, watched: watchPage(page, config.label ?? "peer") };
}

/** A selector rename must fail here, loudly, rather than making a check pass vacuously. */
export async function assertSelectors(page, keys) {
  const wanted = keys ?? Object.keys(SELECTORS).filter((key) => key !== "tileHealth");
  const missing = await page.evaluate((entries) =>
    entries.filter(([, selector]) => !document.querySelector(selector)).map(([key]) => key),
    wanted.map((key) => [key, SELECTORS[key]]));
  if (missing.length) throw new SetupError(
    `selector map drift: ${missing.map((key) => `${key} (${SELECTORS[key]})`).join(", ")} not found`);
}

export async function waitFor(page, predicate, { timeout = 30_000, interval = 250, label = "condition", arg } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await page.evaluate(predicate, arg); }
    catch (error) { last = `evaluate failed: ${error.message}`; }
    if (last) return last;
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
  throw new TimeoutError(`timed out after ${timeout}ms waiting for ${label}; last value: ${JSON.stringify(last)}`);
}

export const stripSlash = (url) => String(url).replace(/\/+$/, "");

export async function openBase(page, url) {
  try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
  catch (error) { throw new SetupError(`could not open ${url}: ${error.message}`); }
  await assertSelectors(page);
  await waitFor(page, () => document.querySelectorAll("#preset option").length > 0, { label: "quality controls to initialise" });
}

export async function applySetup(page, config) {
  if (config.name) await page.fill(SELECTORS.name, config.name);
  if (config.preset) await page.selectOption(SELECTORS.preset, config.preset);
  if (config.codec) await page.selectOption(SELECTORS.codec, config.codec);
  if (config.audioMode) await page.selectOption(SELECTORS.audioMode, config.audioMode);
  const relay = await page.isChecked(SELECTORS.relayOnly);
  if (config.relayOnly && !relay) await page.check(SELECTORS.relayOnly);
  if (!config.relayOnly && relay) await page.uncheck(SELECTORS.relayOnly);
}

export async function createRoom(page, timeout = 30_000) {
  try {
    await page.click(SELECTORS.create);
    return await waitFor(page, () => {
      const code = document.querySelector("#room-code")?.value ?? "";
      const status = document.querySelector("#status")?.textContent ?? "";
      const valid = /^[A-Z2-9]{8}$/.test(code);
      if (valid && /In room/.test(status)) return { code, relayUnavailable: false };
      if (/no TURN relay/.test(status)) return { code: valid ? code : null, relayUnavailable: true };
      return null;
    }, { timeout, label: "room creation and join" });
  } catch (error) { throw new SetupError(`could not create a room: ${error.message}`); }
}

export async function joinRoom(page, { url, code, timeout = 30_000 }) {
  const target = `${stripSlash(url)}/#${String(code).toUpperCase()}`;
  try { await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
  catch (error) { throw new SetupError(`could not open ${target}: ${error.message}`); }
  await assertSelectors(page);
  let outcome;
  try {
    outcome = await waitFor(page, () => {
      const status = document.querySelector("#status")?.textContent ?? "";
      if (/In room/.test(status)) return { ok: true, relayUnavailable: false };
      if (/no TURN relay/.test(status)) return { ok: false, relayUnavailable: true };
      if (/locked|password|removed|room is full|kicked/i.test(status)) return { ok: false, status };
      return null;
    }, { timeout, label: `join room ${code}` });
  } catch (error) { throw new SetupError(error.message); }
  if (!outcome.ok && !outcome.relayUnavailable) throw new SetupError(`could not join room ${code}: ${outcome.status}`);
  return outcome;
}

export async function waitForShareStarted(page, { timeout = 180_000, media = "real", watched } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (/Stop sharing/.test(await page.textContent(SELECTORS.share).catch(() => "") ?? "")) return;
    const status = await page.textContent(SELECTORS.status).catch(() => "");
    if (/Screen sharing is blocked|getDisplayMedia/.test(status ?? "")) throw new SetupError(`sharing blocked: ${status}`);
    if (watched?.logs.some((entry) => /capture cancelled or failed/.test(entry.text))) throw new UserCancelError("screen picker was cancelled");
    await sleep(250);
  }
  if (media === "real") throw new UserCancelError("screen picker did not complete");
  throw new TimeoutError(`sharing did not start within ${timeout}ms`);
}

export async function clickShare(page, options) {
  await page.click(SELECTORS.share);
  await waitForShareStarted(page, options);
}

/** The second-pick prompt appears only after a whole-screen pick with no audio. */
export async function clickAudioPickApp(page, timeout = 15_000) {
  if (!(await page.isVisible(SELECTORS.audioPickApp).catch(() => false))) {
    try { await page.waitForSelector(SELECTORS.audioPickApp, { state: "visible", timeout }); }
    catch { return false; }
  }
  await page.click(SELECTORS.audioPickApp);
  return true;
}

/** Raw getStats() extraction. Deliberately omits ICE addresses so output is safe to paste. */
export async function readStats(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs ?? []) {
      if (pc.connectionState === "closed") continue;
      let report;
      try { report = await pc.getStats(); } catch { continue; }
      const byId = new Map();
      report.forEach((entry, id) => byId.set(id, entry));
      let pair = null;
      for (const entry of byId.values()) {
        if (entry.type === "transport" && entry.selectedCandidatePairId) {
          pair = byId.get(entry.selectedCandidatePairId) ?? null;
          if (pair) break;
        }
      }
      if (!pair) for (const entry of byId.values()) {
        if (entry.type === "candidate-pair" && entry.state === "succeeded" && entry.nominated === true) { pair = entry; break; }
      }
      const local = pair?.localCandidateId ? byId.get(pair.localCandidateId) : null;
      const remote = pair?.remoteCandidateId ? byId.get(pair.remoteCandidateId) : null;
      const peer = {
        pcIndex: out.length, connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState,
        localCandidateType: local?.candidateType ?? null, remoteCandidateType: remote?.candidateType ?? null,
        rttMs: typeof pair?.currentRoundTripTime === "number" ? pair.currentRoundTripTime * 1000 : null,
        availableOutgoingBitrate: pair?.availableOutgoingBitrate ?? null,
        videoOut: null, videoIn: null, audioOut: null, audioIn: null, remoteInbound: null,
      };
      for (const entry of byId.values()) {
        if (entry.type === "outbound-rtp" && entry.kind === "video") peer.videoOut = {
          framesEncoded: entry.framesEncoded ?? 0, framesPerSecond: entry.framesPerSecond ?? null,
          bytesSent: entry.bytesSent ?? 0, packetsSent: entry.packetsSent ?? 0,
          encoderImplementation: entry.encoderImplementation ?? null,
          qualityLimitationReason: entry.qualityLimitationReason ?? null,
          codecMimeType: entry.codecId ? byId.get(entry.codecId)?.mimeType ?? null : null,
        };
        else if (entry.type === "inbound-rtp" && entry.kind === "video") peer.videoIn = {
          framesDecoded: entry.framesDecoded ?? 0, framesPerSecond: entry.framesPerSecond ?? null,
          bytesReceived: entry.bytesReceived ?? 0, packetsReceived: entry.packetsReceived ?? 0,
          freezeCount: entry.freezeCount ?? null,
          codecMimeType: entry.codecId ? byId.get(entry.codecId)?.mimeType ?? null : null,
          jitterBufferDelayMs: typeof entry.jitterBufferDelay === "number" && entry.jitterBufferEmittedCount > 0
            ? (entry.jitterBufferDelay / entry.jitterBufferEmittedCount) * 1000 : null,
        };
        else if (entry.type === "outbound-rtp" && entry.kind === "audio") peer.audioOut = {
          bytesSent: entry.bytesSent ?? 0, packetsSent: entry.packetsSent ?? 0,
        };
        else if (entry.type === "inbound-rtp" && entry.kind === "audio") peer.audioIn = {
          bytesReceived: entry.bytesReceived ?? 0, packetsReceived: entry.packetsReceived ?? 0,
        };
        else if (entry.type === "remote-inbound-rtp") peer.remoteInbound = {
          kind: entry.kind ?? null, packetsLost: entry.packetsLost ?? null,
          fractionLost: entry.fractionLost ?? null,
          roundTripTimeMs: typeof entry.roundTripTime === "number" ? entry.roundTripTime * 1000 : null,
          jitter: entry.jitter ?? null,
        };
      }
      out.push(peer);
    }
    return out;
  });
}

export function totals(stats) {
  return stats.reduce((sum, peer) => ({
    livePcs: sum.livePcs + 1,
    connectedPcs: sum.connectedPcs + (peer.connectionState === "connected" ? 1 : 0),
    framesEncoded: sum.framesEncoded + (peer.videoOut?.framesEncoded ?? 0),
    framesDecoded: sum.framesDecoded + (peer.videoIn?.framesDecoded ?? 0),
    bytesSent: sum.bytesSent + (peer.videoOut?.bytesSent ?? 0),
    bytesReceived: sum.bytesReceived + (peer.videoIn?.bytesReceived ?? 0),
    audioBytesSent: sum.audioBytesSent + (peer.audioOut?.bytesSent ?? 0),
    audioBytesReceived: sum.audioBytesReceived + (peer.audioIn?.bytesReceived ?? 0),
  }), { livePcs: 0, connectedPcs: 0, framesEncoded: 0, framesDecoded: 0, bytesSent: 0,
    bytesReceived: 0, audioBytesSent: 0, audioBytesReceived: 0 });
}

/** Rates from two snapshots of the same page. */
export function pageDelta(before, after, seconds) {
  const previous = new Map(before.map((peer) => [peer.pcIndex, peer]));
  const d = { framesEncoded: 0, framesDecoded: 0, bytesSent: 0, bytesReceived: 0, audioBytesSent: 0, audioBytesReceived: 0 };
  for (const peer of after) {
    const older = previous.get(peer.pcIndex);
    if (!older) continue;
    d.framesEncoded += Math.max(0, (peer.videoOut?.framesEncoded ?? 0) - (older.videoOut?.framesEncoded ?? 0));
    d.framesDecoded += Math.max(0, (peer.videoIn?.framesDecoded ?? 0) - (older.videoIn?.framesDecoded ?? 0));
    d.bytesSent += Math.max(0, (peer.videoOut?.bytesSent ?? 0) - (older.videoOut?.bytesSent ?? 0));
    d.bytesReceived += Math.max(0, (peer.videoIn?.bytesReceived ?? 0) - (older.videoIn?.bytesReceived ?? 0));
    d.audioBytesSent += Math.max(0, (peer.audioOut?.bytesSent ?? 0) - (older.audioOut?.bytesSent ?? 0));
    d.audioBytesReceived += Math.max(0, (peer.audioIn?.bytesReceived ?? 0) - (older.audioIn?.bytesReceived ?? 0));
  }
  const safe = Math.max(0.001, seconds);
  return {
    seconds: safe, ...d, fpsEncoded: d.framesEncoded / safe, fpsDecoded: d.framesDecoded / safe,
    videoBitrateSent: (d.bytesSent * 8) / safe, videoBitrateReceived: (d.bytesReceived * 8) / safe,
    audioBitrateSent: (d.audioBytesSent * 8) / safe, audioBitrateReceived: (d.audioBytesReceived * 8) / safe,
  };
}

export function percentile(values, fraction) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = (clean.length - 1) * fraction, lower = Math.floor(index), upper = Math.ceil(index);
  return clean[lower] + (clean[upper] - clean[lower]) * (index - lower);
}

export async function readDiagnostics(context, baseUrl) {
  const page = await context.newPage();
  watchPage(page, "diagnostics");
  try {
    await page.goto(new URL("diagnostics", `${stripSlash(baseUrl)}/`).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!(await page.isVisible("#run-btn").catch(() => false))) throw new SetupError("diagnostics page has no #run-btn");
    await page.click("#run-btn");
    await waitFor(page, () => {
      const button = document.querySelector("#run-btn");
      return button && !button.disabled && document.querySelectorAll("#results tr").length > 0 ? true : null;
    }, { timeout: 120_000, interval: 500, label: "diagnostics run" });
    return await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#results tr")].map((row) => {
      const [name, status, details] = [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim());
      return [name, { status, details }];
    })));
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError(`could not run diagnostics: ${error.message}`);
  } finally { await page.close().catch(() => {}); }
}

export async function readAudioEvidence(page) {
  return page.evaluate(() => {
    const streams = window.__gdmStreams ?? [];
    const audioTracks = streams.flatMap((stream) => stream.getAudioTracks().map((track) => ({
      label: track.label, enabled: track.enabled, readyState: track.readyState,
      settings: track.getSettings?.() ?? {},
    })));
    return {
      gdmOpts: window.__gdmOpts ?? [], gdmReturns: window.__gdmReturns ?? [], audioTracks,
      chip: document.querySelector("#audio-chip-text")?.textContent ?? null,
      chipKind: document.querySelector("#audio-chip")?.dataset?.kind ?? null,
      promptHidden: document.querySelector("#audio-prompt")?.hidden ?? null,
      selectedMode: document.querySelector("#audio-mode")?.value ?? null, streamCount: streams.length,
    };
  });
}

/** Only called for FAIL/SETUP, before withBrowser() closes the pages. */
export async function collectFailure(pages, { room, names = [] } = {}) {
  const errors = { console: [], pageErrors: [], csp: [], pages: [] };
  for (const entry of pages) {
    const dump = await entry.page.evaluate(() => ({
      status: document.querySelector("#status")?.textContent ?? null,
      roster: [...document.querySelectorAll("#roster-list li")].map((item) => item.textContent ?? ""),
      csp: window.__csp ?? [], gdmOpts: window.__gdmOpts ?? [],
    })).catch(() => ({ status: null, roster: [], csp: [], gdmOpts: [] }));
    errors.pages.push({ label: entry.label, status: dump.status, roster: dump.roster, gdmOpts: dump.gdmOpts });
    errors.csp.push(...dump.csp);
    errors.console.push(...(entry.watched?.logs ?? []).filter((log) => log.type === "error" || log.type === "warning"));
    errors.pageErrors.push(...(entry.watched?.errors ?? []));
  }
  return redactDeep(errors, { room, names });
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const IPV6_FULL = /(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/gi;
const IPV6_COMPRESSED = /(?<![\w:])(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![\w:])/gi;
const IPV6_LOOPBACK = /(?<![\w:])::(?:1|ffff(?::[0-9a-f.:]+)?)(?![\w:])/gi;
const ROOM_RE = /\b(?=[A-Z2-9]*[A-Z])(?=[A-Z2-9]*[2-9])[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}\b/g;

export function redact(text, { room, names = [] } = {}) {
  let out = String(text);
  const versions = [];
  // Chrome/<version> must survive: it is required evidence, not an IPv4 address.
  out = out.replace(/\b(?:HeadlessChrome|Chrome|Chromium|Edg|Version)\/\d+(?:\.\d+)+/g, (match) => {
    versions.push(match);
    return `\u0000V${versions.length - 1}\u0000`;
  });
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (room) out = out.replace(new RegExp(escape(room), "gi"), "<room>");
  for (const name of [...names].filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (name.length >= 2) out = out.replace(new RegExp(escape(name), "gi"), "<name>");
  }
  out = out
    .replace(UUID_RE, "<peer>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (match) =>
      match.split(".").every((part) => Number(part) <= 255) ? "<ipv4>" : match)
    .replace(IPV6_FULL, "<ipv6>").replace(IPV6_COMPRESSED, "<ipv6>").replace(IPV6_LOOPBACK, "<ipv6>")
    .replace(ROOM_RE, "<room>")
    // Case-sensitive key form: uppercase status text such as "PASS:" is not a token.
    .replace(/(["']?)\b(hostToken|rejoinToken|roomToken|token|password|pass)\b\1\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{6,}["']?/g,
      (match, quote, key) => `${quote}${key}${quote}${match.includes(":") ? ":" : "="}<redacted>`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <redacted>")
    .replace(/("?(?:address|localAddress|remoteAddress|raddr|ip)"?\s*[:=]\s*")([^"]+)(")/gi, "$1<redacted>$3");
  return out.replace(/\u0000V(\d+)\u0000/g, (_, index) => versions[Number(index)]);
}

export function redactDeep(value, options = {}) {
  if (typeof value === "string") return redact(value, options);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, options));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/^(password|hostToken|rejoinToken|token)$/i.test(key) || /^(address|ip|raddr|localAddress|remoteAddress)$/i.test(key)) {
        out[key] = "<redacted>";
      } else if (key === "room" && entry) out[key] = "<room>";
      else out[key] = redactDeep(entry, options);
    }
    return out;
  }
  return value;
}

export function isDirectTypes(local, remote) {
  return DIRECT_TYPES.includes(local) && DIRECT_TYPES.includes(remote);
}
export function chromeMajor(version) {
  const major = Number(String(version ?? "").split(".")[0]);
  return Number.isFinite(major) ? major : null;
}
export function classifyEncoder(value) {
  if (!value) return "missing";
  if (/(nvenc|videotoolbox|video toolbox|media ?foundation|vaapi|quick ?sync|intel|amd|amf|hardware)/i.test(value)) return "hardware";
  if (/(libvpx|openh264|open264|software|ffmpeg|vp8|vp9|av1)/i.test(value)) return "software";
  return "unknown";
}

export function formatMarkdown(result) {
  const lines = [
    `# Screenshare manual harness — ${result.command}`, "",
    `- Verdict: **${result.verdict}** (exit ${result.exitCode})`, `- URL: ${result.url}`,
    `- Started: ${result.startedAt}`,
  ];
  if (result.reason) lines.push(`- Reason: ${result.reason}`);
  if (result.environment?.chrome) lines.push(`- Chrome: ${result.environment.chrome} (${result.environment.platform})`);
  lines.push("", "## Checks");
  lines.push(...(result.checks.length ? result.checks.map((check) => `- **${check.verdict}** ${check.name}: ${check.detail}`) : ["- (none recorded)"]));
  if (result.manual?.length) lines.push("", "## Manual follow-up", ...result.manual.map((item) => `- ${item}`));
  if (result.errors) lines.push("", "## Failure dump", "```json", JSON.stringify(result.errors, null, 2), "```");
  return lines.join("\n");
}

/** Open the file URL in its own context. The timer is never a production route. */
export async function openTimer(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const watched = watchPage(page, "timer");
  await page.goto(latencyPageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitFor(page, () => {
    const clock = document.querySelector("#clock")?.textContent ?? "";
    const frames = Number(document.querySelector("#frames")?.textContent ?? "0");
    return /\d{2}:\d{2}:\d{2}\.\d{3}/.test(clock) && frames > 0 ? { clock, frames } : null;
  }, { label: "latency clock", timeout: 10_000 });
  return { context, page, watched };
}
