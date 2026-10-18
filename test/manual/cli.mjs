#!/usr/bin/env node
/**
 * Manual verification harness CLI (issue #15).
 *   node test/manual/cli.mjs pair   --create --role sharer --diagnostics
 *   node test/manual/cli.mjs pair   --room CODE --role viewer
 *   node test/manual/cli.mjs pair   --both --media fake --seconds 10
 *   node test/manual/cli.mjs audio  --mode window --both
 *   node test/manual/cli.mjs load   --url http://127.0.0.1:8787 --expect-peers 20 --media fake
 *   node test/manual/cli.mjs timer
 *
 * stdout stays machine-usable: --create prints exactly `ROOM=<code>` and, with
 * --json, the final one-line JSON. Progress and the default summary go to stderr.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT, SELECTORS, SetupError, TimeoutError, UsageError, UserCancelError,
  applySetup, chromeMajor, classifyEncoder, clickAudioPickApp, clickShare, collectFailure,
  createRoom, formatMarkdown, isDirectTypes, joinRoom, latencyPageUrl, launchBrowser, newPeer,
  openBase, openTimer, pageDelta, percentile, readAudioEvidence, readDiagnostics, readStats,
  redactDeep, sleep, totals, waitFor, waitForShareStarted,
} from "./lib.mjs";

export const DEFAULT_PEERS = 20;
const PRESETS = ["1080p60", "1080p30", "720p60", "720p30"];
const CODECS = ["h264", "vp9", "av1", "vp8"];
const MEDIA = ["fake", "real"];
const ROLES = ["sharer", "viewer", "both"];
const MODES = ["window", "second-pick"];
const ROOM_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const CODEC_MIME = { h264: "video/H264", vp9: "video/VP9", av1: "video/AV1", vp8: "video/VP8" };
const URLS = { pair: "https://screenshare.webmikas.com", load: "http://127.0.0.1:8787" };
const HELP = `Screenshare manual verification harness (issue #15)

Usage:
  node test/manual/cli.mjs pair  (--create | --room CODE | --both) [options]
  node test/manual/cli.mjs audio [--mode window|second-pick] [--both | --role ROLE] [options]
  node test/manual/cli.mjs load  [--expect-peers N] [options]
  node test/manual/cli.mjs timer [--seconds N]

Roles: --role sharer|viewer|both; --both is a shortcut for --role both.
Rooms: --create prints ROOM=<code> on stdout; --room CODE opens url/#CODE.
Pair:  --relay-only forces TURN (SKIP without it); --diagnostics requires STUN.
Audio: --mode window (one game-window pick) or second-pick (screen, then audio-only).
Common: --url URL, --seconds N, --preset ${PRESETS.join("|")}, --codec ${CODECS.join("|")},
        --media fake|real, --expect-peers N, --join-timeout D, --share-timeout D,
        --connect-timeout D, --json, --help. Durations: 30, 30s, 500ms, 2m.
Defaults: pair/audio 60s real media; load 30s fake-friendly local URL; timer runs until Ctrl+C.
Exit codes: 0 PASS, 1 FAIL, 2 SKIP/USER_CANCEL, 3 SETUP ERROR, 4 WARN.`;

const VALUE_FLAGS = {
  "--url": "url", "--room": "room", "--role": "role", "--mode": "mode", "--seconds": "seconds",
  "--preset": "preset", "--codec": "codec", "--media": "media", "--expect-peers": "expectPeers",
  "--join-timeout": "joinTimeout", "--share-timeout": "shareTimeout", "--connect-timeout": "connectTimeout",
};
const BOOLEAN_FLAGS = {
  "--create": "create", "--relay-only": "relayOnly", "--diagnostics": "diagnostics",
  "--both": "both", "--json": "json", "--help": "help",
};

function parseDuration(value, name) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(String(value).trim());
  if (!match) throw new UsageError(`${name} needs a duration like 30, 30s, 500ms, or 2m`);
  const amount = Number(match[1]), unit = (match[2] ?? "s").toLowerCase();
  const ms = unit === "ms" ? amount : unit === "m" ? amount * 60_000 : amount * 1_000;
  if (!(ms > 0)) throw new UsageError(`${name} must be positive`);
  return Math.round(ms);
}
function parseInteger(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new UsageError(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}
function common(o, url, seconds, peers) {
  o.url ??= url;
  o.seconds = parseInteger(o.seconds ?? seconds, "--seconds", 1, 86_400);
  o.expectPeers = parseInteger(o.expectPeers ?? peers, "--expect-peers", 2, DEFAULT_PEERS);
  o.joinTimeout = parseDuration(o.joinTimeout ?? "30s", "--join-timeout");
  o.shareTimeout = parseDuration(o.shareTimeout ?? "180s", "--share-timeout");
  o.connectTimeout = parseDuration(o.connectTimeout ?? "45s", "--connect-timeout");
}

export function parseArgs(argv) {
  const o = {
    command: null, help: false, json: false, create: false, room: null, role: null, both: false,
    relayOnly: false, diagnostics: false, mode: null, url: null, seconds: null, preset: null,
    codec: null, media: null, expectPeers: null, joinTimeout: null, shareTimeout: null,
    connectTimeout: null, provided: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (!argument.startsWith("-")) {
      if (o.command) throw new UsageError(`unexpected argument: ${argument}`);
      o.command = argument;
      continue;
    }
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    const inline = equals < 0 ? undefined : argument.slice(equals + 1);
    if (flag === "-h") { o.help = true; continue; }
    if (BOOLEAN_FLAGS[flag]) {
      o[BOOLEAN_FLAGS[flag]] = inline === undefined ? true : inline !== "false";
      o.provided.push(flag);
      continue;
    }
    const property = VALUE_FLAGS[flag];
    if (!property) throw new UsageError(`unknown option: ${flag}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    o[property] = value;
    o.provided.push(flag);
  }
  if (o.help) return { ...o, help: true };
  if (!["pair", "load", "audio", "timer"].includes(o.command)) {
    throw new UsageError(o.command ? `unknown command: ${o.command}` : "choose a command: pair, load, audio, or timer");
  }
  if (o.preset !== null && !PRESETS.includes(o.preset)) throw new UsageError(`--preset must be one of ${PRESETS.join(", ")}`);
  if (o.codec !== null && !CODECS.includes(o.codec)) throw new UsageError(`--codec must be one of ${CODECS.join(", ")}`);
  if (o.media !== null && !MEDIA.includes(o.media)) throw new UsageError(`--media must be one of ${MEDIA.join(", ")}`);
  if (o.role !== null && !ROLES.includes(o.role)) throw new UsageError(`--role must be one of ${ROLES.join(", ")}`);
  if (o.mode !== null && !MODES.includes(o.mode)) throw new UsageError(`--mode must be one of ${MODES.join(", ")}`);
  if (o.room !== null) {
    o.room = o.room.toUpperCase();
    if (!ROOM_CODE.test(o.room)) throw new UsageError("--room must be an 8-character room code");
  }
  o.preset ??= "1080p60";
  o.codec ??= "h264";
  o.media ??= "real";

  if (o.command === "pair") {
    if (o.mode !== null) throw new UsageError("--mode is only valid for audio");
    common(o, URLS.pair, 60, 2);
    o.both ||= o.role === "both";
    if (o.both && o.role && o.role !== "both") throw new UsageError(`--both conflicts with --role ${o.role}`);
    if (o.both) {
      o.role = "both";
      if (o.create && o.room) throw new UsageError("--create and --room are mutually exclusive");
      if (!o.room) o.create = true;
    } else {
      o.role ??= o.create ? "sharer" : o.room ? "viewer" : null;
      if (!o.role) throw new UsageError("pair needs --create, --room CODE, or --both");
      if (o.create && o.room) throw new UsageError("--create and --room are mutually exclusive");
      if (!o.create && !o.room) throw new UsageError("pair needs --create or --room CODE");
    }
  } else if (o.command === "audio") {
    if (o.diagnostics) throw new UsageError("--diagnostics is only valid for pair");
    common(o, URLS.pair, 60, 2);
    o.mode ??= "window";
    o.both ||= o.role === "both" || (!o.role && !o.room);
    if (o.both && o.role && o.role !== "both") throw new UsageError(`--both conflicts with --role ${o.role}`);
    if (o.both) {
      o.role = "both";
      if (!o.room) o.create = true;
    } else {
      if (o.role === "viewer" && !o.room) throw new UsageError("audio --role viewer needs --room CODE");
      if (o.role === "sharer" && !o.room) o.create = true;
      if (o.create && o.room) throw new UsageError("--create and --room are mutually exclusive");
    }
  } else if (o.command === "load") {
    if (o.room || o.role || o.both || o.diagnostics || o.mode !== null || o.relayOnly) {
      throw new UsageError("load runs one sharer and many viewers; only common load options are valid");
    }
    common(o, URLS.load, 30, DEFAULT_PEERS);
    o.create = true;
    o.role = "sharer";
  } else {
    if (o.create || o.room || o.role || o.both || o.diagnostics || o.mode !== null || o.expectPeers !== null) {
      throw new UsageError("timer only accepts --seconds and --json");
    }
    o.url = latencyPageUrl;
    o.seconds = parseInteger(o.seconds ?? 0, "--seconds", 0, 86_400);
    o.expectPeers = 0;
    o.joinTimeout = 30_000; o.shareTimeout = 180_000; o.connectTimeout = 45_000;
  }
  if (o.command !== "timer" && !/^https?:\/\//i.test(o.url)) throw new UsageError("--url must be an http(s) URL");
  o.names = o.command === "load"
    ? ["manual-sharer", ...Array.from({ length: Math.max(0, o.expectPeers - 1) }, (_, i) => `manual-viewer-${i + 1}`)]
    : ["manual-sharer", "manual-viewer"];
  return o;
}

const progress = (o, message) => process.stderr.write(`[${o.command}] ${message}\n`);
const writeRoom = (code) => process.stdout.write(`ROOM=${code}\n`);
const check = (r, name, verdict, detail) => r.checks.push({ name, verdict, detail });

function newResult(o) {
  return {
    tool: "screenshare-manual-harness", issue: 15, command: o.command, verdict: "PASS",
    exitCode: 0, startedAt: new Date().toISOString(), url: o.url, room: null,
    options: {
      role: o.role, mode: o.mode, media: o.media, preset: o.preset, codec: o.codec,
      seconds: o.seconds, expectPeers: o.expectPeers, relayOnly: o.relayOnly,
      diagnostics: o.diagnostics, joinTimeoutMs: o.joinTimeout, shareTimeoutMs: o.shareTimeout,
      connectTimeoutMs: o.connectTimeout,
    },
    environment: {}, checks: [], peers: [], manual: [], errors: null,
  };
}
function stamp(r) {
  r.finishedAt = new Date().toISOString();
  r.durationMs = Date.now() - new Date(r.startedAt).getTime();
  return r;
}
function finish(r) {
  const verdicts = r.checks.map((entry) => entry.verdict);
  r.verdict = verdicts.includes("FAIL") ? "FAIL" : verdicts.includes("WARN") ? "WARN" : verdicts.includes("SKIP") ? "SKIP" : "PASS";
  r.exitCode = EXIT[r.verdict];
  return stamp(r);
}
function fail(r, error) {
  r.reason = error.message;
  if (error instanceof SetupError) {
    r.verdict = "SETUP"; r.exitCode = EXIT.SETUP;
    check(r, "setup", "SETUP", error.message);
    return stamp(r);
  }
  check(r, error instanceof UserCancelError ? "user cancel" : "harness", error instanceof UserCancelError ? "SKIP" : "FAIL", error.message);
  return finish(r);
}
function emit(r, o) {
  const safe = redactDeep(r, { room: o.room, names: o.names });
  if (o.json) process.stdout.write(`${JSON.stringify(safe)}\n`);
  else process.stderr.write(`${formatMarkdown(safe)}\n${JSON.stringify(safe)}\n`);
}

async function withBrowser(o, fn, onFailure) {
  const media = o.command === "timer" ? "none" : o.media;
  const browser = await launchBrowser({ media, headed: o.command === "timer" || media === "real" });
  const contexts = [];
  const track = (context) => { contexts.push(context); return context; };
  try { return await fn({ browser, track }); }
  catch (error) {
    if (onFailure) await onFailure(error).catch(() => {});
    throw error;
  } finally {
    for (const context of contexts.reverse()) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
function setEnv(r, browser, userAgent) {
  r.environment = { platform: process.platform, arch: process.arch, node: process.version, chrome: browser.version(), ...(userAgent ? { userAgent } : {}) };
}
async function run(o, work) {
  const r = newResult(o), pages = [];
  const failure = async (error) => {
    if (!(error instanceof UserCancelError)) r.errors = await collectFailure(pages, { room: o.room, names: o.names });
  };
  try {
    return await withBrowser(o, async (context) => {
      setEnv(r, context.browser);
      return await work(context, r, pages);
    }, failure);
  } catch (error) {
    if (!r.errors && !(error instanceof UserCancelError)) r.errors = await collectFailure(pages, { room: o.room, names: o.names });
    return fail(r, error);
  }
}

async function openPeer(context, config, pages) {
  const peer = await newPeer(context.browser, config);
  context.track(peer.context);
  const entry = { ...peer, label: config.label };
  pages.push(entry);
  return entry;
}
async function setupCreated(peer, o, r, config) {
  await openBase(peer.page, o.url);
  await applySetup(peer.page, config);
  const created = await createRoom(peer.page, o.joinTimeout);
  r.room = "<room>";
  if (created.code) { o.room = created.code; writeRoom(created.code); }
  if (created.relayUnavailable) check(r, "relay-only", "SKIP", "no TURN relay configured; not connecting");
  return created;
}
async function setupJoined(peer, o, r) {
  const joined = await joinRoom(peer.page, { url: o.url, code: o.room, timeout: o.joinTimeout });
  if (joined.relayUnavailable) check(r, "relay-only", "SKIP", "no TURN relay configured; not connecting");
  else r.room = "<room>";
  return joined;
}
/** One sharer and/or viewer: creators click Create, joiners open url/#CODE. */
async function openDuo(context, o, r, pages, extra = {}) {
  const roles = o.role === "both" ? ["sharer", "viewer"] : [o.role];
  const peers = {};
  for (const role of roles) {
    const config = {
      label: role, name: `manual-${role}`, preset: o.preset, codec: o.codec, relayOnly: o.relayOnly,
      audioMode: extra.audioMode ?? "app", media: o.media, captureMode: extra.captureMode,
      viewport: extra.viewport ?? { width: 1280, height: 720 },
    };
    const peer = await openPeer(context, config, pages);
    peers[role] = peer;
    const creates = o.create && (o.role !== "both" || role === "sharer");
    const outcome = creates ? await setupCreated(peer, o, r, config) : await setupJoined(peer, o, r);
    if (!r.environment.userAgent) r.environment.userAgent = await peer.page.evaluate(() => navigator.userAgent).catch(() => null);
    if (outcome.relayUnavailable) return { peers, relayUnavailable: true };
  }
  return { peers };
}

async function startSharing(peer, o, { secondPick = false } = {}) {
  if (o.media === "fake") {
    progress(o, `${peer.label}: clicking Share`);
    await clickShare(peer.page, { timeout: o.shareTimeout, media: o.media, watched: peer.watched });
  } else {
    progress(o, `${peer.label}: click Share in the Chrome window and pick the window (waiting ${Math.round(o.shareTimeout / 1000)}s)`);
    await waitForShareStarted(peer.page, { timeout: o.shareTimeout, media: o.media, watched: peer.watched });
  }
  if (secondPick) {
    progress(o, `${peer.label}: complete the audio picker (second pick)`);
    if (!(await clickAudioPickApp(peer.page, Math.min(o.shareTimeout, 30_000)))) progress(o, `${peer.label}: audio prompt did not appear`);
  }
}
async function waitForRoster(peer, expected, timeout) {
  await waitFor(peer.page, (count) => document.querySelectorAll("#roster-list li").length >= count,
    { arg: expected, timeout, label: `${peer.label} roster to show ${expected} peers` });
}
async function waitForLive(peer, expected, timeout) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = totals(await readStats(peer.page));
    if (last.connectedPcs >= expected) return last;
    await sleep(500);
  }
  throw new TimeoutError(`${peer.label} only had ${last?.connectedPcs ?? 0}/${expected} live peer connections after ${timeout}ms`);
}
async function waitForMedia(peer, role, timeout) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = totals(await readStats(peer.page));
    if (role === "sharer" ? last.framesEncoded > 0 : last.framesDecoded > 0 && last.bytesReceived > 0) return last;
    await sleep(500);
  }
  throw new TimeoutError(`${peer.label} saw no ${role === "sharer" ? "encoded" : "decoded"} frames within ${timeout}ms; last: ${JSON.stringify(last)}`);
}
async function waitForTileHealth(peer, timeout) {
  try { await peer.page.waitForSelector(SELECTORS.tileHealth, { state: "attached", timeout }); }
  catch { throw new SetupError(`selector map drift: ${SELECTORS.tileHealth} not found`); }
}
async function collectCsp(pages) {
  const violations = [];
  for (const entry of pages) {
    const csp = await entry.page.evaluate(() => window.__csp ?? []).catch(() => []);
    for (const violation of csp) violations.push(`${entry.label}: ${violation}`);
  }
  return violations;
}
async function checkConsoleAndCsp(r, pages) {
  const problems = [
    ...pages.flatMap((entry) => (entry.watched?.errors ?? []).map((error) => `${entry.label}: ${error}`)),
    ...(await collectCsp(pages)),
  ];
  check(r, "uncaught errors / CSP", problems.length ? "FAIL" : "PASS", problems.length ? problems.join(" | ") : "none");
}
const compactStats = (stats) => stats.map((peer) => ({
  pcIndex: peer.pcIndex, connectionState: peer.connectionState,
  localCandidateType: peer.localCandidateType, remoteCandidateType: peer.remoteCandidateType,
  rttMs: peer.rttMs, availableOutgoingBitrate: peer.availableOutgoingBitrate,
  videoOut: peer.videoOut, videoIn: peer.videoIn, audioOut: peer.audioOut,
  audioIn: peer.audioIn, remoteInbound: peer.remoteInbound,
}));
const peerSummary = (role, stats) => ({ role, totals: totals(stats), peers: compactStats(stats) });

function pairCandidateVerdict(r, statsByPage, relayOnly) {
  const pairs = [];
  for (const { role, stats } of statsByPage) for (const peer of stats) {
    if (peer.connectionState !== "connected") continue;
    pairs.push({
      role, local: peer.localCandidateType, remote: peer.remoteCandidateType,
      direct: isDirectTypes(peer.localCandidateType, peer.remoteCandidateType),
    });
  }
  const direct = pairs.filter((pair) => pair.direct);
  const relayed = pairs.filter((pair) => pair.local === "relay" || pair.remote === "relay");
  if (relayOnly) {
    check(r, "candidate pair", relayed.length ? "PASS" : "FAIL", relayed.length
      ? `relay path confirmed (${relayed.length} pair${relayed.length === 1 ? "" : "s"}); this proves the TURN fallback, not the direct premise`
      : "no relay candidate pair was selected");
    return;
  }
  if (direct.length && !relayed.length) {
    check(r, "candidate pair", "PASS", `direct (${[...new Set(direct.map((pair) => pair.local))].join(", ")})`);
  } else if (relayed.length) {
    check(r, "candidate pair", "WARN", `media works but at least one selected pair is relayed (TURN): ${JSON.stringify(relayed)}`);
  } else {
    check(r, "candidate pair", "FAIL", `no positively direct pair was selected: ${JSON.stringify(pairs)}`);
  }
  check(r, "handshake evidence", pairs.length ? "PASS" : "FAIL", pairs.length
    ? "candidate types are receive-side values from each page; combine both peers' JSON for two-machine runs"
    : "no connected candidate pair was visible");
}
function checkCodec(r, o, before, after) {
  if (!o.provided.includes("--codec")) return;
  const sent = after.flatMap((peer) => (peer.videoOut ? [peer.videoOut] : []));
  const mime = sent.find((video) => video.codecMimeType)?.codecMimeType ?? null;
  const expected = CODEC_MIME[o.codec];
  if (!mime) check(r, "negotiated codec", "FAIL", "could not resolve outbound-rtp codecId to a codec entry");
  else if (mime.toLowerCase() !== expected.toLowerCase()) check(r, "negotiated codec", "FAIL", `negotiated ${mime}, expected ${expected}`);
  else check(r, "negotiated codec", "PASS", `${mime} from the sharer's outbound-rtp codecId`);
  const beforeFrames = totals(before).framesEncoded, afterFrames = totals(after).framesEncoded;
  check(r, "frames encoded rising", afterFrames > beforeFrames ? "PASS" : "FAIL", `${beforeFrames} -> ${afterFrames}`);
  const implementation = sent.map((video) => video.encoderImplementation).find(Boolean) ?? null;
  r.encoderImplementation = implementation;
  const kind = classifyEncoder(implementation);
  check(r, "encoder implementation", kind === "hardware" ? "PASS" : "WARN", implementation
    ? `${implementation} (${kind})` : "encoderImplementation is empty; headless or fake media often falls back to software");
}
async function addDiagnostics(r, context, o) {
  const rows = await readDiagnostics(context, o.url);
  r.diagnostics = rows;
  const stun = rows["STUN / public address"], turnCredentials = rows["TURN credentials"], turnRelay = rows["TURN relay"];
  check(r, "STUN reachable", stun?.status === "PASS" ? "PASS" : "FAIL", stun ? `${stun.status}: ${stun.details}` : "diagnostics did not report a STUN row");
  if (o.relayOnly) {
    const available = turnCredentials?.status === "PASS" && turnRelay?.status === "PASS";
    check(r, "TURN relay", available ? "PASS" : "SKIP", available
      ? "TURN credentials and relay allocation both passed"
      : "relay-only was requested but TURN is not configured/reachable");
  } else {
    check(r, "TURN relay", "PASS", turnCredentials?.status === "PASS"
      ? "TURN configured; a relay is available if direct ICE fails"
      : "STUN only; acceptable for the direct premise, but symmetric NAT will need TURN");
  }
  check(r, "NAT mapping", "PASS", rows["NAT mapping"]
    ? `${rows["NAT mapping"].status}: ${rows["NAT mapping"].details} (informational; may be inconclusive)` : "not reported");
}

async function runPair(o) {
  return run(o, async (context, r, pages) => {
    const { peers, relayUnavailable } = await openDuo(context, o, r, pages);
    if (relayUnavailable) return finish(r);
    const { sharer, viewer } = peers;
    if (sharer) { await startSharing(sharer, o); await waitForMedia(sharer, "sharer", o.connectTimeout); }
    if (viewer) { await waitForMedia(viewer, "viewer", o.connectTimeout); await waitForTileHealth(viewer, o.connectTimeout); }
    if (sharer) await waitForRoster(sharer, o.expectPeers, o.connectTimeout);
    if (viewer) await waitForRoster(viewer, o.expectPeers, o.connectTimeout);
    if (sharer) await waitForLive(sharer, o.expectPeers - 1, o.connectTimeout);
    if (viewer && o.expectPeers > 1) await waitForLive(viewer, 1, o.connectTimeout);

    progress(o, `measuring for ${o.seconds}s`);
    const beforeS = sharer ? await readStats(sharer.page) : [], beforeV = viewer ? await readStats(viewer.page) : [];
    await sleep(o.seconds * 1000);
    const afterS = sharer ? await readStats(sharer.page) : [], afterV = viewer ? await readStats(viewer.page) : [];
    const dS = sharer ? pageDelta(beforeS, afterS, o.seconds) : null;
    const dV = viewer ? pageDelta(beforeV, afterV, o.seconds) : null;
    if (sharer) {
      check(r, "sharer encoded frames", dS.framesEncoded > 0 ? "PASS" : "FAIL",
        `${dS.framesEncoded} frames, ${(dS.videoBitrateSent / 1e6).toFixed(2)} Mbps over ${o.seconds}s`);
      r.peers.push(peerSummary("sharer", afterS));
    }
    if (viewer) {
      check(r, "viewer decoded frames", dV.framesDecoded > 0 ? "PASS" : "FAIL",
        `${dV.framesDecoded} frames, ${(dV.videoBitrateReceived / 1e6).toFixed(2)} Mbps over ${o.seconds}s`);
      r.peers.push(peerSummary("viewer", afterV));
    }
    pairCandidateVerdict(r, [
      ...(sharer ? [{ role: "sharer", stats: afterS }] : []),
      ...(viewer ? [{ role: "viewer", stats: afterV }] : []),
    ], o.relayOnly);
    if (sharer && o.provided.includes("--codec")) checkCodec(r, o, beforeS, afterS);
    else if (o.provided.includes("--codec")) check(r, "negotiated codec", "SKIP", "requires --role sharer or --both");
    if (o.diagnostics) {
      const diagnosticsContext = (sharer ?? viewer)?.context;
      if (diagnosticsContext) await addDiagnostics(r, diagnosticsContext, o);
    }
    await checkConsoleAndCsp(r, pages);
    r.manual.push(
      "Two-machine run: start the other side with --room CODE and the opposite --role, then paste both JSON lines into the issue comment.",
      "PASS locally/loopback if both ends report direct (host|srflx|prflx). On two distinct networks require direct (srflx|prflx) on both ends.",
      "Do not rely on the sharer's data-direct badge: it is only set for received tiles.",
    );
    return finish(r);
  });
}

async function runLoad(o) {
  return run(o, async (context, r, pages) => {
    const shared = { preset: o.preset, codec: o.codec, relayOnly: false, audioMode: "none", media: o.media, viewport: { width: 960, height: 540 } };
    const sharer = await openPeer(context, { ...shared, label: "sharer", name: "manual-sharer" }, pages);
    await openBase(sharer.page, o.url);
    r.environment.userAgent = await sharer.page.evaluate(() => navigator.userAgent).catch(() => null);
    await applySetup(sharer.page, { ...shared, name: "manual-sharer" });
    const created = await createRoom(sharer.page, o.joinTimeout);
    if (!created.code) throw new SetupError("load could not create a room");
    o.room = created.code; r.room = "<room>";
    writeRoom(created.code);
    const viewers = [];
    for (let i = 0; i < o.expectPeers - 1; i++) {
      const viewer = await openPeer(context, { ...shared, label: `viewer-${i + 1}`, name: `manual-viewer-${i + 1}` }, pages);
      await setupJoined(viewer, o, r);
      viewers.push(viewer);
      progress(o, `viewer ${i + 1}/${o.expectPeers - 1} joined`);
    }
    await waitForRoster(sharer, o.expectPeers, o.connectTimeout);
    for (const viewer of viewers) await waitForRoster(viewer, o.expectPeers, o.connectTimeout);
    await sharer.page.selectOption(SELECTORS.audioMode, "none");
    check(r, "audio mode", "PASS", "sharer set to none; this is not an audio or bandwidth test");
    await startSharing(sharer, o);
    await waitForLive(sharer, o.expectPeers - 1, o.connectTimeout);
    for (const viewer of viewers) { await waitForMedia(viewer, "viewer", o.connectTimeout); await waitForTileHealth(viewer, o.connectTimeout); }

    progress(o, "discarding a 5s warm-up");
    await sleep(5_000);
    const samples = viewers.map(() => []);
    const before = await readStats(sharer.page);
    const previous = await Promise.all(viewers.map((viewer) => readStats(viewer.page)));
    const started = Date.now();
    while (Date.now() - started < o.seconds * 1000) {
      const tick = Date.now();
      await sleep(Math.min(2_000, Math.max(0, o.seconds * 1000 - (Date.now() - started))));
      const elapsed = (Date.now() - tick) / 1000;
      const next = await Promise.all(viewers.map((viewer) => readStats(viewer.page)));
      for (let i = 0; i < viewers.length; i++) { samples[i].push(pageDelta(previous[i], next[i], elapsed)); previous[i] = next[i]; }
    }
    const after = await readStats(sharer.page);
    const sharp = totals(before), end = totals(after), sharerDelta = pageDelta(before, after, o.seconds);
    check(r, "sharer load", end.connectedPcs >= o.expectPeers - 1 ? "PASS" : "FAIL",
      `${end.connectedPcs}/${o.expectPeers - 1} live viewer links; ${sharerDelta.framesEncoded} frames encoded (${(sharerDelta.videoBitrateSent / 1e6).toFixed(2)} Mbps)`);
    check(r, "sharer frames", end.framesEncoded > sharp.framesEncoded ? "PASS" : "FAIL", `${sharp.framesEncoded} -> ${end.framesEncoded}`);

    let degraded = false;
    const reports = [];
    for (let i = 0; i < viewers.length; i++) {
      const values = samples[i];
      const p50Fps = percentile(values.map((entry) => entry.fpsDecoded), 0.5);
      const p95Fps = percentile(values.map((entry) => entry.fpsDecoded), 0.95);
      const p50Bitrate = percentile(values.map((entry) => entry.videoBitrateReceived), 0.5);
      const p95Bitrate = percentile(values.map((entry) => entry.videoBitrateReceived), 0.95);
      const decoded = values.reduce((sum, entry) => sum + entry.framesDecoded, 0);
      if ((p50Fps ?? 0) < 20 || (p50Bitrate ?? 0) < 250_000) degraded = true;
      if (decoded <= 0) check(r, `viewer ${i + 1} decode`, "FAIL", "no decoded frames during the measurement window");
      reports.push({ viewer: i + 1, samples: values.length, decodedFrames: decoded, p50Fps, p95Fps, p50Bitrate, p95Bitrate, pageErrors: viewers[i].watched.errors.length });
    }
    r.metrics = {
      viewers: reports,
      sharer: { framesEncoded: sharerDelta.framesEncoded, bitrate: sharerDelta.videoBitrateSent },
      cpuTelemetry: await sharer.page.evaluate(() => ({ hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null })).catch(() => null),
      note: "CPU is telemetry only; loopback is not a bandwidth test and CPU is not a capacity claim.",
    };
    check(r, "all viewers decoding", reports.every((report) => report.decodedFrames > 0) ? "PASS" : "FAIL",
      reports.map((report) => `v${report.viewer}: ${report.decodedFrames} frames`).join(", "));
    check(r, "viewer p50 fps / bitrate", degraded ? "WARN" : "PASS", reports.map((report) =>
      `v${report.viewer}: p50 ${Math.round(report.p50Fps ?? 0)} fps / ${((report.p50Bitrate ?? 0) / 1e6).toFixed(2)} Mbps, p95 ${Math.round(report.p95Fps ?? 0)} fps / ${((report.p95Bitrate ?? 0) / 1e6).toFixed(2)} Mbps`).join(" | "));
    check(r, "expected room size", reports.length === o.expectPeers - 1 ? "PASS" : "FAIL", `${reports.length + 1}/${o.expectPeers} peers`);
    await checkConsoleAndCsp(r, pages);
    r.manual.push(
      "This is a fan-out/decode check on one host, not a bandwidth or capacity guarantee.",
      "Report p50/p95 fps and bitrate as WARN telemetry; never gate on 19 x maxBitrate or uplink.",
    );
    return finish(r);
  });
}

/** All three DSP constraints must be present and false for a PASS; undefined is WARN. */
export function audioDsp(constraints) {
  if (!constraints || typeof constraints !== "object") return null;
  const flags = [constraints.echoCancellation, constraints.noiseSuppression, constraints.autoGainControl];
  if (flags.some((flag) => flag === undefined)) return null;
  return flags.some((flag) => flag === true);
}
function audioOptionChecks(r, evidence, o) {
  const [first, second] = evidence.gdmOpts;
  if (!first) { check(r, "capture options", "FAIL", "getDisplayMedia was never called"); return; }
  check(r, "windowAudio", first.windowAudio === "window" ? "PASS" : "FAIL", `first pick recorded windowAudio=${JSON.stringify(first.windowAudio)}`);
  check(r, "system audio excluded", first.systemAudio === "exclude" ? "PASS" : "FAIL", `first pick recorded systemAudio=${JSON.stringify(first.systemAudio)}`);
  const constraints = first.audio && typeof first.audio === "object" ? first.audio : null;
  const dsp = audioDsp(constraints);
  check(r, "DSP disabled", dsp === false ? "PASS" : dsp === true ? "FAIL" : "WARN", dsp === true
    ? "echoCancellation/noiseSuppression/autoGainControl was requested on"
    : dsp === false ? "echoCancellation, noiseSuppression and autoGainControl were all requested off"
      : "one or more DSP constraints were not exposed; treated as missing evidence");
  check(r, "stereo / 48 kHz", constraints?.channelCount === 2 && constraints?.sampleRate === 48_000 ? "PASS" : "WARN",
    `requested channelCount=${constraints?.channelCount}, sampleRate=${constraints?.sampleRate}`);
  const firstReturn = evidence.gdmReturns[0];
  if (o.mode === "second-pick") {
    check(r, "whole-screen first pick",
      firstReturn && firstReturn.hasAudio === false && firstReturn.videoSettings?.displaySurface === "monitor" ? "PASS" : "FAIL",
      `first pick returned audio=${firstReturn?.hasAudio}, displaySurface=${firstReturn?.videoSettings?.displaySurface}`);
    check(r, "audio-only second pick", second ? "PASS" : "FAIL", second
      ? `second pick video.displaySurface=${second.video?.displaySurface}, monitorTypeSurfaces=${second.monitorTypeSurfaces}`
      : "the app never opened the audio-only picker");
    if (second) check(r, "second pick window constraints",
      second.video?.displaySurface === "window" && second.monitorTypeSurfaces === "exclude" && second.windowAudio === "window" && second.systemAudio === "exclude" ? "PASS" : "FAIL",
      JSON.stringify({ displaySurface: second.video?.displaySurface, monitorTypeSurfaces: second.monitorTypeSurfaces, windowAudio: second.windowAudio, systemAudio: second.systemAudio }));
  } else {
    check(r, "window pick returned audio",
      firstReturn?.hasAudio === true && firstReturn?.videoSettings?.displaySurface === "window" ? "PASS" : "FAIL",
      `first pick returned audio=${firstReturn?.hasAudio}, displaySurface=${firstReturn?.videoSettings?.displaySurface}`);
  }
  const chip = evidence.chip ?? "";
  if (/^All system audio/i.test(chip)) check(r, "audio chip", "FAIL", `system mix would leak: ${chip}`);
  else if (/^Game audio:\s*(?:window|screen|web-contents-media-stream):/i.test(chip)) check(r, "audio chip", "WARN", `opaque picker label: ${chip}`);
  else if (/^Game audio:\s*\S/i.test(chip)) check(r, "audio chip", "PASS", chip);
  else if (/^Tab audio/i.test(chip)) check(r, "audio chip", "PASS", chip);
  else if (chip === "No audio") check(r, "audio chip", "FAIL", "the app reports no audio source");
  else check(r, "audio chip", "WARN", `unrecognised chip: ${JSON.stringify(chip)}`);
  const track = evidence.audioTracks[0];
  check(r, "audio track", track ? "PASS" : "FAIL", track
    ? `label=${JSON.stringify(track.label)}, enabled=${track.enabled}, settings=${JSON.stringify(track.settings)} (observed evidence, not proof)`
    : "no audio track was captured");
}

async function runAudio(o) {
  return run(o, async (context, r, pages) => {
    if (process.platform !== "win32") {
      r.environment.userAgent = await probeUserAgent(context.browser);
      check(r, "platform", "SKIP", "game-only window audio is unsupported on macOS/Linux; skip this item instead of reporting FAIL");
      return finish(r);
    }
    const major = chromeMajor(context.browser.version());
    if (major !== null && major < 141) {
      r.environment.userAgent = await probeUserAgent(context.browser);
      check(r, "Chrome windowAudio", "SKIP", `windowAudio needs Chrome 141+; found ${context.browser.version()}`);
      return finish(r);
    }
    const { peers, relayUnavailable } = await openDuo(context, o, r, pages, { audioMode: "app", captureMode: o.mode });
    if (relayUnavailable) return finish(r);
    const { sharer, viewer } = peers;
    if (sharer) {
      await startSharing(sharer, o, { secondPick: o.mode === "second-pick" });
      const deadline = Date.now() + o.shareTimeout;
      let evidence = null;
      while (Date.now() < deadline) {
        evidence = await readAudioEvidence(sharer.page);
        if (evidence.audioTracks.length > 0) break;
        if (sharer.watched.logs.some((log) => /audio pick cancelled or failed/.test(log.text))) throw new UserCancelError("audio picker was cancelled");
        await sleep(500);
      }
      if (!evidence || evidence.audioTracks.length === 0) throw new TimeoutError("no audio track was captured");
      r.audio = { evidence, requested: evidence.gdmOpts[0]?.audio ?? null, observedSettings: evidence.audioTracks.map((track) => track.settings) };
      audioOptionChecks(r, evidence, o);
    }
    if (viewer) { await waitForMedia(viewer, "viewer", o.connectTimeout); await waitForTileHealth(viewer, o.connectTimeout); }

    progress(o, `measuring audio RTP for ${o.seconds}s`);
    const beforeS = sharer ? totals(await readStats(sharer.page)) : null, beforeV = viewer ? totals(await readStats(viewer.page)) : null;
    await sleep(o.seconds * 1000);
    const afterS = sharer ? totals(await readStats(sharer.page)) : null, afterV = viewer ? totals(await readStats(viewer.page)) : null;
    if (sharer) {
      const delta = (afterS?.audioBytesSent ?? 0) - (beforeS?.audioBytesSent ?? 0);
      check(r, "audio RTP sent", delta > 0 ? "PASS" : "FAIL", `${delta} bytes rose on the sharer over ${o.seconds}s`);
    }
    if (viewer) {
      const delta = (afterV?.audioBytesReceived ?? 0) - (beforeV?.audioBytesReceived ?? 0);
      check(r, "audio RTP received", delta > 0 ? "PASS" : "FAIL", `${delta} bytes rose on the viewer over ${o.seconds}s`);
    }
    if (sharer) r.peers.push(peerSummary("sharer", await readStats(sharer.page)));
    if (viewer) r.peers.push(peerSummary("viewer", await readStats(viewer.page)));
    await checkConsoleAndCsp(r, pages);
    r.manual.push(
      "Human-only: only the game is audible (no Discord or music), it does not sound underwater, lip sync is within roughly 100 ms, and a live source swap keeps sync.",
      "getSettings() is observed evidence, not proof that Chrome honoured the request.",
      "macOS/Linux game-only audio is unsupported; SKIP with the windowAudioSupport reason.",
    );
    return finish(r);
  });
}
async function probeUserAgent(browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    return await page.evaluate(() => navigator.userAgent).catch(() => null);
  } finally { await context.close().catch(() => {}); }
}

async function runTimer(o) {
  return run(o, async (context, r, pages) => {
    const timer = await openTimer(context.browser);
    context.track(timer.context);
    pages.push({ ...timer, label: "timer" });
    r.environment.userAgent = await timer.page.evaluate(() => navigator.userAgent).catch(() => null);
    check(r, "latency page", "PASS", `${latencyPageUrl} opened in its own context (file URL, no production route)`);
    const read = () => timer.page.evaluate(() => ({
      clock: document.querySelector("#clock")?.textContent ?? "",
      frames: Number(document.querySelector("#frames")?.textContent ?? "0"),
    }));
    const first = await read();
    await sleep(1_000);
    const second = await read();
    check(r, "millisecond clock", /\d{2}:\d{2}:\d{2}\.\d{3}/.test(second.clock) ? "PASS" : "FAIL", second.clock);
    check(r, "frame counter", second.frames > first.frames ? "PASS" : "FAIL", `${first.frames} -> ${second.frames}`);
    progress(o, "Share this timer window from peer A; on peer B take five phone photos of both clocks. delta = A - B.");
    if (o.seconds > 0) await sleep(o.seconds * 1000);
    else {
      progress(o, "Timer stays open until you close the window or press Ctrl+C.");
      await new Promise((resolveWait) => {
        const done = () => { process.removeListener("SIGINT", done); timer.page.removeListener("close", done); resolveWait(); };
        process.once("SIGINT", done);
        timer.page.once("close", done);
      });
    }
    r.manual.push(
      "Attach five phone photos showing both clocks to the #15 comment.",
      "PASS: median delta <=100 ms. WARN: 100-200 ms. FAIL: >200 ms or no photo.",
      "Record RTT and jitterBufferDelayMs from both peers as corroboration.",
    );
    await checkConsoleAndCsp(r, pages);
    return finish(r);
  });
}

export async function main(argv = process.argv.slice(2)) {
  let o;
  try { o = parseArgs(argv); }
  catch (error) { process.stderr.write(`error: ${error.message}\n\n${HELP}\n`); return EXIT.SETUP; }
  if (o.help) { process.stdout.write(`${HELP}\n`); return EXIT.PASS; }
  let result;
  try {
    result = o.command === "pair" ? await runPair(o)
      : o.command === "load" ? await runLoad(o)
        : o.command === "audio" ? await runAudio(o) : await runTimer(o);
  } catch (error) {
    const unexpected = newResult(o);
    unexpected.errors = { console: [], pageErrors: [String(error)], csp: [], pages: [] };
    result = fail(unexpected, error instanceof SetupError ? error : new SetupError(String(error)));
  }
  emit(result, o);
  return result.exitCode;
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`fatal: ${error.stack ?? error}\n`);
    process.exitCode = EXIT.SETUP;
  });
}
