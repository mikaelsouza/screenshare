#!/usr/bin/env node
/**
 * Manual verification harness CLI (issue #15).
 *
 *   node test/manual/cli.mjs pair   --create --role sharer --diagnostics
 *   node test/manual/cli.mjs pair   --room CODE --role viewer
 *   node test/manual/cli.mjs pair   --both --media fake --seconds 10
 *   node test/manual/cli.mjs audio  --mode window --both
 *   node test/manual/cli.mjs load   --url http://127.0.0.1:8787 --expect-peers 20 --media fake
 *   node test/manual/cli.mjs timer
 *
 * stdout is kept machine-usable: --create prints exactly `ROOM=<code>` and, with
 * --json, the final one-line JSON. Progress and the default human summary go to stderr.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT,
  SELECTORS,
  SetupError,
  TimeoutError,
  UsageError,
  UserCancelError,
  applySetup,
  chromeMajor,
  classifyEncoder,
  clickAudioPickApp,
  clickShare,
  collectFailure,
  createRoom,
  formatMarkdown,
  isDirectTypes,
  joinRoom,
  latencyPageUrl,
  launchBrowser,
  newPeer,
  openBase,
  openTimer,
  pageDelta,
  percentile,
  readAudioEvidence,
  readDiagnostics,
  readStats,
  redactDeep,
  sleep,
  totals,
  waitFor,
  waitForShareStarted,
} from "./lib.mjs";

export const DEFAULT_PEERS = 20;

const PRESETS = ["1080p60", "1080p30", "720p60", "720p30"];
const CODECS = ["h264", "vp9", "av1", "vp8"];
const MEDIA = ["fake", "real"];
const ROLES = ["sharer", "viewer", "both"];
const MODES = ["window", "second-pick"];
const ROOM_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const CODEC_MIME = { h264: "video/H264", vp9: "video/VP9", av1: "video/AV1", vp8: "video/VP8" };
const PAIR_DEFAULT_URL = "https://screenshare.webmikas.com";
const LOAD_DEFAULT_URL = "http://127.0.0.1:8787";

const HELP = `Screenshare manual verification harness (issue #15)

Usage:
  node test/manual/cli.mjs pair  (--create | --room CODE | --both) [options]
  node test/manual/cli.mjs audio [--mode window|second-pick] [--both | --role ROLE] [options]
  node test/manual/cli.mjs load  [--expect-peers N] [options]
  node test/manual/cli.mjs timer [--seconds N]

Roles:
  --role sharer|viewer|both     Default: pair follows --create/--room; audio defaults to both.
  --both                        Run both roles locally (shortcut for --role both).
  --create                      Create a room and print ROOM=<code> on stdout.
  --room CODE                   Join an existing room via url/#CODE.

Pair options:
  --relay-only                  Force TURN; SKIP when no TURN credentials are available.
  --diagnostics                 Run /diagnostics and require STUN (and TURN with --relay-only).

Audio options:
  --mode window                 One pick: the game window's audio.
  --mode second-pick            Whole-screen pick, then the app's audio-only window pick.

Common options:
  --url URL                     App URL. Default pair/audio: ${PAIR_DEFAULT_URL}
  --seconds N                   Observation window after media starts. Default: pair/audio 60, load 30, timer 0 (until Ctrl+C)
  --preset NAME                 ${PRESETS.join(" | ")} (default 1080p60)
  --codec NAME                  ${CODECS.join(" | ")} (default h264)
  --media fake|real             Default real. fake installs canvas/oscillator capture; real opens the picker.
  --expect-peers N              Total peers. Default: load 20, pair/audio 2.
  --join-timeout D              Own join timeout. Default 30s.
  --share-timeout D             Time allowed to complete the picker. Default 180s.
  --connect-timeout D           Time allowed for peer connections/media. Default 45s.
  --json                        Print the final JSON on stdout after ROOM; otherwise JSON goes to stderr.
  --help, -h                    This text.

Durations accept 30, 30s, 500ms, 2m.
Exit codes: 0 PASS, 1 FAIL, 2 SKIP/USER_CANCEL, 3 SETUP ERROR, 4 WARN.`;

const VALUE_FLAGS = {
  "--url": "url",
  "--room": "room",
  "--role": "role",
  "--mode": "mode",
  "--seconds": "seconds",
  "--preset": "preset",
  "--codec": "codec",
  "--media": "media",
  "--expect-peers": "expectPeers",
  "--join-timeout": "joinTimeout",
  "--share-timeout": "shareTimeout",
  "--connect-timeout": "connectTimeout",
};

const BOOLEAN_FLAGS = {
  "--create": "create",
  "--relay-only": "relayOnly",
  "--diagnostics": "diagnostics",
  "--both": "both",
  "--json": "json",
  "--help": "help",
};

function parseDuration(value, name) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(String(value).trim());
  if (!match) throw new UsageError(`${name} needs a duration like 30, 30s, 500ms, or 2m`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const ms = unit === "ms" ? amount : unit === "m" ? amount * 60_000 : amount * 1000;
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

export function parseArgs(argv) {
  const out = {
    command: null,
    help: false,
    json: false,
    create: false,
    room: null,
    role: null,
    both: false,
    relayOnly: false,
    diagnostics: false,
    mode: null,
    url: null,
    seconds: null,
    preset: null,
    codec: null,
    media: null,
    expectPeers: null,
    joinTimeout: null,
    shareTimeout: null,
    connectTimeout: null,
    provided: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (!argument.startsWith("-")) {
      if (out.command) throw new UsageError(`unexpected argument: ${argument}`);
      out.command = argument;
      continue;
    }

    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);

    if (flag === "-h") {
      out.help = true;
      continue;
    }
    if (BOOLEAN_FLAGS[flag]) {
      out[BOOLEAN_FLAGS[flag]] = inline === undefined ? true : inline !== "false";
      out.provided.push(flag);
      continue;
    }
    const property = VALUE_FLAGS[flag];
    if (!property) throw new UsageError(`unknown option: ${flag}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    out[property] = value;
    out.provided.push(flag);
  }

  if (out.help) return { ...out, help: true };
  if (!out.command) throw new UsageError("choose a command: pair, load, audio, or timer");
  if (!["pair", "load", "audio", "timer"].includes(out.command)) {
    throw new UsageError(`unknown command: ${out.command}`);
  }

  if (out.preset !== null && !PRESETS.includes(out.preset)) {
    throw new UsageError(`--preset must be one of ${PRESETS.join(", ")}`);
  }
  if (out.codec !== null && !CODECS.includes(out.codec)) {
    throw new UsageError(`--codec must be one of ${CODECS.join(", ")}`);
  }
  if (out.media !== null && !MEDIA.includes(out.media)) {
    throw new UsageError(`--media must be one of ${MEDIA.join(", ")}`);
  }
  if (out.role !== null && !ROLES.includes(out.role)) {
    throw new UsageError(`--role must be one of ${ROLES.join(", ")}`);
  }
  if (out.mode !== null && !MODES.includes(out.mode)) {
    throw new UsageError(`--mode must be one of ${MODES.join(", ")}`);
  }
  if (out.room !== null) {
    out.room = out.room.toUpperCase();
    if (!ROOM_CODE.test(out.room)) throw new UsageError("--room must be an 8-character room code");
  }

  out.preset ??= "1080p60";
  out.codec ??= "h264";
  out.media ??= "real";

  if (out.command === "pair") {
    if (out.mode !== null) throw new UsageError("--mode is only valid for audio");
    out.url ??= PAIR_DEFAULT_URL;
    out.seconds = parseInteger(out.seconds ?? 60, "--seconds", 1, 86_400);
    out.expectPeers = parseInteger(out.expectPeers ?? 2, "--expect-peers", 2, DEFAULT_PEERS);
    out.joinTimeout = parseDuration(out.joinTimeout ?? "30s", "--join-timeout");
    out.shareTimeout = parseDuration(out.shareTimeout ?? "180s", "--share-timeout");
    out.connectTimeout = parseDuration(out.connectTimeout ?? "45s", "--connect-timeout");
    out.both = out.both || out.role === "both";
    if (out.both && out.role && out.role !== "both") {
      throw new UsageError("--both conflicts with --role " + out.role);
    }
    if (out.both) {
      out.role = "both";
      if (out.create && out.room) throw new UsageError("--create and --room are mutually exclusive");
      if (!out.room) out.create = true;
    } else {
      out.role ??= out.create ? "sharer" : out.room ? "viewer" : null;
      if (!out.role) throw new UsageError("pair needs --create, --room CODE, or --both");
      if (out.create && out.room) throw new UsageError("--create and --room are mutually exclusive");
      if (!out.create && !out.room) throw new UsageError("pair needs --create or --room CODE");
    }
  } else if (out.command === "audio") {
    if (out.diagnostics) throw new UsageError("--diagnostics is only valid for pair");
    out.url ??= PAIR_DEFAULT_URL;
    out.mode ??= "window";
    out.seconds = parseInteger(out.seconds ?? 60, "--seconds", 1, 86_400);
    out.expectPeers = parseInteger(out.expectPeers ?? 2, "--expect-peers", 2, DEFAULT_PEERS);
    out.joinTimeout = parseDuration(out.joinTimeout ?? "30s", "--join-timeout");
    out.shareTimeout = parseDuration(out.shareTimeout ?? "180s", "--share-timeout");
    out.connectTimeout = parseDuration(out.connectTimeout ?? "45s", "--connect-timeout");
    out.both = out.both || out.role === "both" || (!out.role && !out.room);
    if (out.both && out.role && out.role !== "both") {
      throw new UsageError("--both conflicts with --role " + out.role);
    }
    if (out.both) {
      out.role = "both";
      if (!out.room) out.create = true;
    } else {
      if (out.role === "viewer" && !out.room) {
        throw new UsageError("audio --role viewer needs --room CODE");
      }
      if (out.role === "sharer" && !out.room) out.create = true;
      if (out.create && out.room) throw new UsageError("--create and --room are mutually exclusive");
    }
  } else if (out.command === "load") {
    if (out.room) throw new UsageError("load creates its own room; do not pass --room");
    if (out.role || out.both) throw new UsageError("load runs one sharer and many viewers; do not pass --role/--both");
    if (out.diagnostics) throw new UsageError("--diagnostics is only valid for pair");
    if (out.mode !== null) throw new UsageError("--mode is only valid for audio");
    if (out.relayOnly) throw new UsageError("--relay-only is not valid for load");
    out.url ??= LOAD_DEFAULT_URL;
    out.seconds = parseInteger(out.seconds ?? 30, "--seconds", 1, 86_400);
    out.expectPeers = parseInteger(out.expectPeers ?? DEFAULT_PEERS, "--expect-peers", 2, DEFAULT_PEERS);
    out.joinTimeout = parseDuration(out.joinTimeout ?? "30s", "--join-timeout");
    out.shareTimeout = parseDuration(out.shareTimeout ?? "180s", "--share-timeout");
    out.connectTimeout = parseDuration(out.connectTimeout ?? "45s", "--connect-timeout");
    out.create = true;
    out.role = "sharer";
  } else {
    if (out.create || out.room || out.role || out.both) {
      throw new UsageError("timer does not use rooms or roles");
    }
    if (out.diagnostics || out.expectPeers !== null || out.mode !== null) {
      throw new UsageError("timer only accepts --seconds and --json");
    }
    out.url = latencyPageUrl;
    out.seconds = parseInteger(out.seconds ?? 0, "--seconds", 0, 86_400);
    out.expectPeers = 0;
    out.joinTimeout = 30_000;
    out.shareTimeout = 180_000;
    out.connectTimeout = 45_000;
  }

  if (!/^https?:\/\//i.test(out.url) && out.command !== "timer") {
    throw new UsageError("--url must be an http(s) URL");
  }

  out.names = out.command === "load"
    ? ["manual-sharer", ...[...Array(Math.max(0, out.expectPeers - 1))].map((_, i) => `manual-viewer-${i + 1}`)]
    : ["manual-sharer", "manual-viewer"];
  return out;
}

function progress(opts, message) {
  process.stderr.write(`[${opts.command}] ${message}\n`);
}

function writeRoom(code) {
  process.stdout.write(`ROOM=${code}\n`);
}

function newResult(opts) {
  return {
    tool: "screenshare-manual-harness",
    issue: 15,
    command: opts.command,
    verdict: "PASS",
    exitCode: 0,
    startedAt: new Date().toISOString(),
    url: opts.url,
    room: null,
    options: {
      role: opts.role,
      mode: opts.mode,
      media: opts.media,
      preset: opts.preset,
      codec: opts.codec,
      seconds: opts.seconds,
      expectPeers: opts.expectPeers,
      relayOnly: opts.relayOnly,
      diagnostics: opts.diagnostics,
      joinTimeoutMs: opts.joinTimeout,
      shareTimeoutMs: opts.shareTimeout,
      connectTimeoutMs: opts.connectTimeout,
    },
    environment: {},
    checks: [],
    peers: [],
    manual: [],
    errors: null,
  };
}

function stamp(result) {
  result.finishedAt = new Date().toISOString();
  result.durationMs = Date.now() - new Date(result.startedAt).getTime();
  return result;
}

function finish(result) {
  const verdicts = result.checks.map((check) => check.verdict);
  result.verdict = verdicts.includes("FAIL")
    ? "FAIL"
    : verdicts.includes("WARN")
      ? "WARN"
      : verdicts.includes("SKIP")
        ? "SKIP"
        : "PASS";
  result.exitCode = EXIT[result.verdict];
  return stamp(result);
}

function fail(result, error) {
  result.reason = error.message;
  if (error instanceof SetupError) {
    result.verdict = "SETUP";
    result.exitCode = EXIT.SETUP;
    result.checks.push({ name: "setup", verdict: "SETUP", detail: error.message });
    return stamp(result);
  }
  result.checks.push({
    name: error instanceof UserCancelError ? "user cancel" : "harness",
    verdict: error instanceof UserCancelError ? "SKIP" : "FAIL",
    detail: error.message,
  });
  return finish(result);
}

function addCheck(result, name, verdict, detail) {
  result.checks.push({ name, verdict, detail });
}

function emit(result, opts) {
  const safe = redactDeep(result, { room: opts.room, names: opts.names });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(safe)}\n`);
  } else {
    process.stderr.write(`${formatMarkdown(safe)}\n`);
    process.stderr.write(`${JSON.stringify(safe)}\n`);
  }
}

async function withBrowser(opts, fn, onFailure) {
  const media = opts.command === "timer" ? "none" : opts.media;
  const headed = opts.command === "timer" || media === "real";
  const browser = await launchBrowser({ media, headed });
  const contexts = [];
  const track = (context) => {
    contexts.push(context);
    return context;
  };
  try {
    return await fn({ browser, track });
  } catch (error) {
    // Dump status/roster/CSP before the finally block closes the pages.
    if (onFailure) await onFailure(error).catch(() => {});
    throw error;
  } finally {
    for (const context of contexts.reverse()) {
      await context.close().catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}

function failureHook(result, pages, opts) {
  return async (error) => {
    if (!(error instanceof UserCancelError)) {
      result.errors = await collectFailure(pages, { room: opts.room, names: opts.names });
    }
  };
}

async function probeUserAgent(browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    return await page.evaluate(() => navigator.userAgent).catch(() => null);
  } finally {
    await context.close().catch(() => {});
  }
}

async function recordEnvironment(result, browser, page) {
  result.environment = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    chrome: browser.version(),
  };
  if (page) {
    result.environment.userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);
  }
}

function compactStats(stats) {
  return stats.map((peer) => ({
    pcIndex: peer.pcIndex,
    connectionState: peer.connectionState,
    localCandidateType: peer.localCandidateType,
    remoteCandidateType: peer.remoteCandidateType,
    rttMs: peer.rttMs,
    availableOutgoingBitrate: peer.availableOutgoingBitrate,
    videoOut: peer.videoOut,
    videoIn: peer.videoIn,
    audioOut: peer.audioOut,
    audioIn: peer.audioIn,
    remoteInbound: peer.remoteInbound,
  }));
}

function peerSummary(role, stats) {
  return { role, totals: totals(stats), peers: compactStats(stats) };
}

async function collectCsp(pages) {
  const violations = [];
  for (const entry of pages) {
    const csp = await entry.page.evaluate(() => window.__csp ?? []).catch(() => []);
    for (const violation of csp) violations.push(`${entry.label}: ${violation}`);
  }
  return violations;
}

async function checkConsoleAndCsp(result, pages) {
  const pageErrors = pages.flatMap((entry) =>
    (entry.watched?.errors ?? []).map((error) => `${entry.label}: ${error}`),
  );
  const csp = await collectCsp(pages);
  const problems = [...pageErrors, ...csp];
  addCheck(
    result,
    "uncaught errors / CSP",
    problems.length === 0 ? "PASS" : "FAIL",
    problems.length === 0 ? "none" : problems.join(" | "),
  );
}

async function waitForRoster(entry, expected, timeout) {
  await waitFor(
    entry.page,
    (count) => document.querySelectorAll("#roster-list li").length >= count,
    { arg: expected, timeout, label: `${entry.label} roster to show ${expected} peers` },
  );
}

async function waitForLive(entry, expected, timeout) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const stats = await readStats(entry.page);
    last = totals(stats);
    if (last.connectedPcs >= expected) return stats;
    await sleep(500);
  }
  throw new TimeoutError(
    `${entry.label} only had ${last?.connectedPcs ?? 0}/${expected} live peer connections after ${timeout}ms`,
  );
}

async function waitForMedia(entry, role, timeout) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const stats = await readStats(entry.page);
    last = totals(stats);
    const flowing = role === "sharer" ? last.framesEncoded > 0 : last.framesDecoded > 0 && last.bytesReceived > 0;
    if (flowing) return stats;
    await sleep(500);
  }
  throw new TimeoutError(
    `${entry.label} saw no ${role === "sharer" ? "encoded" : "decoded"} frames within ${timeout}ms; last: ${JSON.stringify(last)}`,
  );
}

async function waitForTileHealth(entry, timeout) {
  try {
    await entry.page.waitForSelector(SELECTORS.tileHealth, { state: "attached", timeout });
  } catch {
    throw new SetupError(`selector map drift: ${SELECTORS.tileHealth} not found`);
  }
}

async function openPeer(browser, track, config, pages) {
  const peer = await newPeer(browser, config);
  track(peer.context);
  const entry = { ...peer, label: config.label ?? config.role };
  pages.push(entry);
  return entry;
}

async function setupCreatedRoom(entry, opts, result, config) {
  await openBase(entry.page, opts.url);
  await applySetup(entry.page, config);
  const created = await createRoom(entry.page, opts.joinTimeout);
  result.room = "<room>";
  if (created.code) {
    opts.room = created.code;
    writeRoom(created.code);
  }
  if (created.relayUnavailable) {
    addCheck(result, "relay-only", "SKIP", "no TURN relay configured; not connecting");
    return { relayUnavailable: true };
  }
  return created;
}

async function setupJoinedRoom(entry, opts) {
  const joined = await joinRoom(entry.page, {
    url: opts.url,
    code: opts.room,
    timeout: opts.joinTimeout,
  });
  return joined;
}

async function startSharing(entry, opts, { secondPick = false } = {}) {
  if (opts.media === "fake") {
    progress(opts, `${entry.label}: clicking Share`);
    await clickShare(entry.page, {
      timeout: opts.shareTimeout,
      media: opts.media,
      watched: entry.watched,
    });
  } else {
    progress(
      opts,
      `${entry.label}: click Share in the Chrome window and pick the window (waiting ${Math.round(opts.shareTimeout / 1000)}s)`,
    );
    await waitForShareStarted(entry.page, {
      timeout: opts.shareTimeout,
      media: opts.media,
      watched: entry.watched,
    });
  }

  if (secondPick) {
    progress(opts, `${entry.label}: complete the audio picker (second pick)`);
    const clicked = await clickAudioPickApp(entry.page, Math.min(opts.shareTimeout, 30_000));
    if (!clicked) progress(opts, `${entry.label}: audio prompt did not appear`);
  }
}

function pairCandidateVerdict(result, statsByPage, relayOnly) {
  const pairTypes = [];
  for (const { role, stats } of statsByPage) {
    for (const peer of stats) {
      if (peer.connectionState !== "connected") continue;
      pairTypes.push({
        role,
        local: peer.localCandidateType,
        remote: peer.remoteCandidateType,
        direct: isDirectTypes(peer.localCandidateType, peer.remoteCandidateType),
      });
    }
  }

  const direct = pairTypes.filter((pair) => pair.direct);
  const relayed = pairTypes.filter((pair) => pair.local === "relay" || pair.remote === "relay");
  const unknown = pairTypes.filter((pair) => pair.local === null || pair.remote === null);

  if (relayOnly) {
    addCheck(
      result,
      "candidate pair",
      relayed.length > 0 ? "PASS" : "FAIL",
      relayed.length > 0
        ? `relay path confirmed (${relayed.length} pair${relayed.length === 1 ? "" : "s"}); this proves the TURN fallback, not the direct premise`
        : "no relay candidate pair was selected",
    );
    return;
  }

  if (direct.length > 0 && relayed.length === 0) {
    const types = [...new Set(direct.map((pair) => pair.local))].join(", ");
    addCheck(result, "candidate pair", "PASS", `direct (${types})`);
  } else if (relayed.length > 0) {
    addCheck(
      result,
      "candidate pair",
      "WARN",
      `media works but at least one selected pair is relayed (TURN): ${JSON.stringify(relayed)}`,
    );
  } else {
    addCheck(
      result,
      "candidate pair",
      "FAIL",
      `no positively direct pair was selected: ${JSON.stringify(unknown)}`,
    );
  }

  addCheck(
    result,
    "handshake evidence",
    pairTypes.length > 0 ? "PASS" : "FAIL",
    pairTypes.length > 0
      ? "candidate types are receive-side values from each page; combine both peers' JSON for two-machine runs"
      : "no connected candidate pair was visible",
  );
}

function checkCodec(result, opts, before, after) {
  if (!opts.provided.includes("--codec")) return;
  const sent = after.flatMap((peer) => (peer.videoOut ? [peer.videoOut] : []));
  const mime = sent.find((video) => video.codecMimeType)?.codecMimeType ?? null;
  const expected = CODEC_MIME[opts.codec];
  if (!mime) {
    addCheck(result, "negotiated codec", "FAIL", "could not resolve outbound-rtp codecId to a codec entry");
  } else if (mime.toLowerCase() !== expected.toLowerCase()) {
    addCheck(result, "negotiated codec", "FAIL", `negotiated ${mime}, expected ${expected}`);
  } else {
    addCheck(result, "negotiated codec", "PASS", `${mime} from the sharer's outbound-rtp codecId`);
  }

  const beforeFrames = totals(before).framesEncoded;
  const afterFrames = totals(after).framesEncoded;
  addCheck(
    result,
    "frames encoded rising",
    afterFrames > beforeFrames ? "PASS" : "FAIL",
    `${beforeFrames} -> ${afterFrames}`,
  );

  const implementation = sent.map((video) => video.encoderImplementation).find(Boolean) ?? null;
  result.encoderImplementation = implementation;
  const kind = classifyEncoder(implementation);
  addCheck(
    result,
    "encoder implementation",
    kind === "hardware" ? "PASS" : "WARN",
    implementation
      ? `${implementation} (${kind})`
      : "encoderImplementation is empty; headless or fake media often falls back to software",
  );
}

async function addDiagnostics(result, context, opts) {
  const rows = await readDiagnostics(context, opts.url);
  result.diagnostics = rows;
  const stun = rows["STUN / public address"];
  addCheck(
    result,
    "STUN reachable",
    stun?.status === "PASS" ? "PASS" : "FAIL",
    stun ? `${stun.status}: ${stun.details}` : "diagnostics did not report a STUN row",
  );
  const turnCredentials = rows["TURN credentials"];
  const turnRelay = rows["TURN relay"];
  if (opts.relayOnly) {
    const available = turnCredentials?.status === "PASS" && turnRelay?.status === "PASS";
    addCheck(
      result,
      "TURN relay",
      available ? "PASS" : "SKIP",
      available
        ? "TURN credentials and relay allocation both passed"
        : "relay-only was requested but TURN is not configured/reachable",
    );
  } else {
    addCheck(
      result,
      "TURN relay",
      "PASS",
      turnCredentials?.status === "PASS"
        ? "TURN configured; a relay is available if direct ICE fails"
        : "STUN only; acceptable for the direct premise, but symmetric NAT will need TURN",
    );
  }
  const nat = rows["NAT mapping"];
  addCheck(
    result,
    "NAT mapping",
    "PASS",
    nat ? `${nat.status}: ${nat.details} (informational; may be inconclusive)` : "not reported",
  );
}

function addPairManual(result) {
  result.manual.push(
    "Two-machine run: start the other side with --room CODE and the opposite --role, then paste both JSON lines into the issue comment.",
    "PASS locally/loopback if both ends report direct (host|srflx|prflx). On two distinct networks require direct (srflx|prflx) on both ends.",
    "Do not rely on the sharer's data-direct badge: it is only set for received tiles.",
  );
}

async function runPair(opts) {
  const result = newResult(opts);
  const pages = [];
  try {
    return await withBrowser(opts, async ({ browser, track }) => {
      const localBoth = opts.role === "both";
      const baseConfig = {
        preset: opts.preset,
        codec: opts.codec,
        relayOnly: opts.relayOnly,
        audioMode: "app",
        media: opts.media,
        viewport: { width: 1280, height: 720 },
      };
      let sharer = null;
      let viewer = null;

      if (localBoth || opts.role === "sharer") {
        sharer = await openPeer(
          browser,
          track,
          { ...baseConfig, label: "sharer", name: "manual-sharer" },
          pages,
        );
        if (opts.create) {
          const created = await setupCreatedRoom(sharer, opts, result, {
            ...baseConfig,
            name: "manual-sharer",
          });
          if (created.relayUnavailable) return finish(result);
          await recordEnvironment(result, browser, sharer.page);
        } else {
          await openBase(sharer.page, opts.url);
          await applySetup(sharer.page, { ...baseConfig, name: "manual-sharer" });
          const joined = await setupJoinedRoom(sharer, opts);
          if (joined.relayUnavailable) {
            addCheck(result, "relay-only", "SKIP", "no TURN relay configured; not connecting");
            return finish(result);
          }
          result.room = "<room>";
          await recordEnvironment(result, browser, sharer.page);
        }
      }

      if (localBoth || opts.role === "viewer") {
        if (localBoth && !opts.room) {
          throw new SetupError("local --both needs a created room before the viewer can join");
        }
        viewer = await openPeer(
          browser,
          track,
          { ...baseConfig, label: "viewer", name: "manual-viewer" },
          pages,
        );
        if (localBoth) {
          await openBase(viewer.page, opts.url);
          await applySetup(viewer.page, { ...baseConfig, name: "manual-viewer" });
          const joined = await setupJoinedRoom(viewer, opts);
          if (joined.relayUnavailable) {
            addCheck(result, "relay-only", "SKIP", "no TURN relay configured; not connecting");
            return finish(result);
          }
        } else if (opts.create) {
          const created = await setupCreatedRoom(viewer, opts, result, {
            ...baseConfig,
            name: "manual-viewer",
          });
          if (created.relayUnavailable) return finish(result);
        } else {
          const joined = await setupJoinedRoom(viewer, opts);
          if (joined.relayUnavailable) {
            addCheck(result, "relay-only", "SKIP", "no TURN relay configured; not connecting");
            return finish(result);
          }
        }
        result.room = "<room>";
        if (!result.environment.chrome) await recordEnvironment(result, browser, viewer.page);
      }

      if (sharer) {
        await startSharing(sharer, opts);
        await waitForMedia(sharer, "sharer", opts.connectTimeout);
      }
      if (viewer) {
        await waitForMedia(viewer, "viewer", opts.connectTimeout);
        await waitForTileHealth(viewer, opts.connectTimeout);
      }

      if (sharer) await waitForRoster(sharer, opts.expectPeers, opts.connectTimeout);
      if (viewer) await waitForRoster(viewer, opts.expectPeers, opts.connectTimeout);

      const expectedLinks = opts.expectPeers - 1;
      if (sharer) await waitForLive(sharer, expectedLinks, opts.connectTimeout);
      if (viewer && expectedLinks > 0) await waitForLive(viewer, 1, opts.connectTimeout);

      progress(opts, `measuring for ${opts.seconds}s`);
      const beforeSharer = sharer ? await readStats(sharer.page) : [];
      const beforeViewer = viewer ? await readStats(viewer.page) : [];
      await sleep(opts.seconds * 1000);
      const afterSharer = sharer ? await readStats(sharer.page) : [];
      const afterViewer = viewer ? await readStats(viewer.page) : [];

      const sharerDelta = sharer ? pageDelta(beforeSharer, afterSharer, opts.seconds) : null;
      const viewerDelta = viewer ? pageDelta(beforeViewer, afterViewer, opts.seconds) : null;

      if (sharer) {
        addCheck(
          result,
          "sharer encoded frames",
          sharerDelta.framesEncoded > 0 ? "PASS" : "FAIL",
          `${sharerDelta.framesEncoded} frames, ${(sharerDelta.videoBitrateSent / 1e6).toFixed(2)} Mbps over ${opts.seconds}s`,
        );
        result.peers.push(peerSummary("sharer", afterSharer));
      }
      if (viewer) {
        addCheck(
          result,
          "viewer decoded frames",
          viewerDelta.framesDecoded > 0 ? "PASS" : "FAIL",
          `${viewerDelta.framesDecoded} frames, ${(viewerDelta.videoBitrateReceived / 1e6).toFixed(2)} Mbps over ${opts.seconds}s`,
        );
        result.peers.push(peerSummary("viewer", afterViewer));
      }

      const statsByPage = [];
      if (sharer) statsByPage.push({ role: "sharer", stats: afterSharer });
      if (viewer) statsByPage.push({ role: "viewer", stats: afterViewer });
      pairCandidateVerdict(result, statsByPage, opts.relayOnly);

      if (sharer && opts.provided.includes("--codec")) {
        checkCodec(result, opts, beforeSharer, afterSharer);
      } else if (opts.provided.includes("--codec")) {
        addCheck(result, "negotiated codec", "SKIP", "requires --role sharer or --both");
      }

      if (opts.diagnostics) {
        const context = sharer?.context ?? viewer?.context;
        if (context) await addDiagnostics(result, context, opts);
      }

      await checkConsoleAndCsp(result, pages);
      addPairManual(result);
      return finish(result);
    }, failureHook(result, pages, opts));
  } catch (error) {
    if (!result.errors && !(error instanceof UserCancelError)) {
      result.errors = await collectFailure(pages, { room: opts.room, names: opts.names });
    }
    return fail(result, error);
  }
}

async function runLoad(opts) {
  const result = newResult(opts);
  const pages = [];
  try {
    return await withBrowser(opts, async ({ browser, track }) => {
      const shared = {
        preset: opts.preset,
        codec: opts.codec,
        relayOnly: false,
        audioMode: "none",
        media: opts.media,
        viewport: { width: 960, height: 540 },
      };
      const sharer = await openPeer(
        browser,
        track,
        { ...shared, label: "sharer", name: "manual-sharer" },
        pages,
      );
      await openBase(sharer.page, opts.url);
      await applySetup(sharer.page, { ...shared, name: "manual-sharer" });
      const created = await createRoom(sharer.page, opts.joinTimeout);
      result.room = "<room>";
      if (!created.code) throw new SetupError("load could not create a room");
      opts.room = created.code;
      writeRoom(created.code);
      await recordEnvironment(result, browser, sharer.page);

      const viewers = [];
      for (let i = 0; i < opts.expectPeers - 1; i++) {
        const viewer = await openPeer(
          browser,
          track,
          { ...shared, label: `viewer-${i + 1}`, name: `manual-viewer-${i + 1}` },
          pages,
        );
        await setupJoinedRoom(viewer, opts);
        viewers.push(viewer);
        progress(opts, `viewer ${i + 1}/${opts.expectPeers - 1} joined`);
      }

      await waitForRoster(sharer, opts.expectPeers, opts.connectTimeout);
      for (const viewer of viewers) await waitForRoster(viewer, opts.expectPeers, opts.connectTimeout);

      await sharer.page.selectOption(SELECTORS.audioMode, "none");
      addCheck(result, "audio mode", "PASS", "sharer set to none; this is not an audio or bandwidth test");

      await startSharing(sharer, opts);
      await waitForLive(sharer, opts.expectPeers - 1, opts.connectTimeout);
      for (const viewer of viewers) {
        await waitForMedia(viewer, "viewer", opts.connectTimeout);
        await waitForTileHealth(viewer, opts.connectTimeout);
      }

      progress(opts, "discarding a 5s warm-up");
      await sleep(5_000);

      const samples = viewers.map(() => []);
      const beforeSharer = await readStats(sharer.page);
      const previous = await Promise.all(viewers.map((viewer) => readStats(viewer.page)));
      const started = Date.now();
      while (Date.now() - started < opts.seconds * 1000) {
        const tick = Date.now();
        await sleep(Math.min(2_000, Math.max(0, opts.seconds * 1000 - (Date.now() - started))));
        const elapsed = (Date.now() - tick) / 1000;
        const next = await Promise.all(viewers.map((viewer) => readStats(viewer.page)));
        for (let i = 0; i < viewers.length; i++) {
          samples[i].push(pageDelta(previous[i], next[i], elapsed));
          previous[i] = next[i];
        }
      }
      const afterSharer = await readStats(sharer.page);

      const sharp = totals(beforeSharer);
      const end = totals(afterSharer);
      const sharerDelta = pageDelta(beforeSharer, afterSharer, opts.seconds);
      addCheck(
        result,
        "sharer load",
        end.connectedPcs >= opts.expectPeers - 1 ? "PASS" : "FAIL",
        `${end.connectedPcs}/${opts.expectPeers - 1} live viewer links; ${sharerDelta.framesEncoded} frames encoded (${(sharerDelta.videoBitrateSent / 1e6).toFixed(2)} Mbps)`,
      );
      addCheck(
        result,
        "sharer frames",
        end.framesEncoded > sharp.framesEncoded ? "PASS" : "FAIL",
        `${sharp.framesEncoded} -> ${end.framesEncoded}`,
      );

      let degraded = false;
      const viewerReports = [];
      for (let i = 0; i < viewers.length; i++) {
        const values = samples[i];
        const fps = values.map((entry) => entry.fpsDecoded);
        const bitrates = values.map((entry) => entry.videoBitrateReceived);
        const p50Fps = percentile(fps, 0.5);
        const p95Fps = percentile(fps, 0.95);
        const p50Bitrate = percentile(bitrates, 0.5);
        const p95Bitrate = percentile(bitrates, 0.95);
        const decoded = values.reduce((sum, entry) => sum + entry.framesDecoded, 0);
        if ((p50Fps ?? 0) < 20 || (p50Bitrate ?? 0) < 250_000) degraded = true;
        if (decoded <= 0) {
          addCheck(result, `viewer ${i + 1} decode`, "FAIL", "no decoded frames during the measurement window");
        }
        viewerReports.push({
          viewer: i + 1,
          samples: values.length,
          decodedFrames: decoded,
          p50Fps,
          p95Fps,
          p50Bitrate,
          p95Bitrate,
          pageErrors: viewers[i].watched.errors.length,
        });
      }
      result.metrics = {
        viewers: viewerReports,
        sharer: { framesEncoded: sharerDelta.framesEncoded, bitrate: sharerDelta.videoBitrateSent },
        cpuTelemetry: await sharer.page
          .evaluate(() => ({ hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null }))
          .catch(() => null),
        note: "CPU is telemetry only; loopback is not a bandwidth test and CPU is not a capacity claim.",
      };

      const decodedAll = viewerReports.every((report) => report.decodedFrames > 0);
      addCheck(
        result,
        "all viewers decoding",
        decodedAll ? "PASS" : "FAIL",
        viewerReports.map((report) => `v${report.viewer}: ${report.decodedFrames} frames`).join(", "),
      );
      addCheck(
        result,
        "viewer p50 fps / bitrate",
        degraded ? "WARN" : "PASS",
        viewerReports
          .map(
            (report) =>
              `v${report.viewer}: p50 ${Math.round(report.p50Fps ?? 0)} fps / ${((report.p50Bitrate ?? 0) / 1e6).toFixed(2)} Mbps, p95 ${Math.round(report.p95Fps ?? 0)} fps / ${((report.p95Bitrate ?? 0) / 1e6).toFixed(2)} Mbps`,
          )
          .join(" | "),
      );
      addCheck(
        result,
        "expected room size",
        viewerReports.length === opts.expectPeers - 1 ? "PASS" : "FAIL",
        `${viewerReports.length + 1}/${opts.expectPeers} peers`,
      );

      await checkConsoleAndCsp(result, pages);
      result.manual.push(
        "This is a fan-out/decode check on one host, not a bandwidth or capacity guarantee.",
        "Report p50/p95 fps and bitrate as WARN telemetry; never gate on 19 x maxBitrate or uplink.",
      );
      return finish(result);
    }, failureHook(result, pages, opts));
  } catch (error) {
    if (!result.errors && !(error instanceof UserCancelError)) {
      result.errors = await collectFailure(pages, { room: opts.room, names: opts.names });
    }
    return fail(result, error);
  }
}

function audioDsp(constraints) {
  if (!constraints || typeof constraints !== "object") return null;
  const flags = [constraints.echoCancellation, constraints.noiseSuppression, constraints.autoGainControl];
  if (flags.every((flag) => flag === undefined)) return null;
  return flags.some((flag) => flag === true);
}

function audioOptionChecks(result, evidence, opts) {
  const [first, second] = evidence.gdmOpts;
  if (!first) {
    addCheck(result, "capture options", "FAIL", "getDisplayMedia was never called");
    return;
  }
  addCheck(
    result,
    "windowAudio",
    first.windowAudio === "window" ? "PASS" : "FAIL",
    `first pick recorded windowAudio=${JSON.stringify(first.windowAudio)}`,
  );
  addCheck(
    result,
    "system audio excluded",
    first.systemAudio === "exclude" ? "PASS" : "FAIL",
    `first pick recorded systemAudio=${JSON.stringify(first.systemAudio)}`,
  );

  const constraints = first.audio && typeof first.audio === "object" ? first.audio : null;
  const dsp = audioDsp(constraints);
  addCheck(
    result,
    "DSP disabled",
    dsp === false ? "PASS" : dsp === true ? "FAIL" : "WARN",
    dsp === true
      ? "echoCancellation/noiseSuppression/autoGainControl was requested on"
      : dsp === false
        ? "echoCancellation, noiseSuppression and autoGainControl were all requested off"
        : "the app did not expose DSP constraints; treated as missing evidence",
  );
  addCheck(
    result,
    "stereo / 48 kHz",
    constraints?.channelCount === 2 && constraints?.sampleRate === 48_000 ? "PASS" : "WARN",
    `requested channelCount=${constraints?.channelCount}, sampleRate=${constraints?.sampleRate}`,
  );

  const firstReturn = evidence.gdmReturns[0];
  if (opts.mode === "second-pick") {
    addCheck(
      result,
      "whole-screen first pick",
      firstReturn && firstReturn.hasAudio === false && firstReturn.videoSettings?.displaySurface === "monitor"
        ? "PASS"
        : "FAIL",
      `first pick returned audio=${firstReturn?.hasAudio}, displaySurface=${firstReturn?.videoSettings?.displaySurface}`,
    );
    addCheck(
      result,
      "audio-only second pick",
      second ? "PASS" : "FAIL",
      second
        ? `second pick video.displaySurface=${second.video?.displaySurface}, monitorTypeSurfaces=${second.monitorTypeSurfaces}`
        : "the app never opened the audio-only picker",
    );
    if (second) {
      addCheck(
        result,
        "second pick window constraints",
        second.video?.displaySurface === "window" &&
          second.monitorTypeSurfaces === "exclude" &&
          second.windowAudio === "window" &&
          second.systemAudio === "exclude"
          ? "PASS"
          : "FAIL",
        JSON.stringify({
          displaySurface: second.video?.displaySurface,
          monitorTypeSurfaces: second.monitorTypeSurfaces,
          windowAudio: second.windowAudio,
          systemAudio: second.systemAudio,
        }),
      );
    }
  } else {
    addCheck(
      result,
      "window pick returned audio",
      firstReturn?.hasAudio === true && firstReturn?.videoSettings?.displaySurface === "window"
        ? "PASS"
        : "FAIL",
      `first pick returned audio=${firstReturn?.hasAudio}, displaySurface=${firstReturn?.videoSettings?.displaySurface}`,
    );
  }

  const chip = evidence.chip ?? "";
  if (/^All system audio/i.test(chip)) {
    addCheck(result, "audio chip", "FAIL", `system mix would leak: ${chip}`);
  } else if (/^Game audio:\s*(?:window|screen|web-contents-media-stream):/i.test(chip)) {
    addCheck(result, "audio chip", "WARN", `opaque picker label: ${chip}`);
  } else if (/^Game audio:\s*\S/i.test(chip)) {
    addCheck(result, "audio chip", "PASS", chip);
  } else if (/^Tab audio/i.test(chip)) {
    addCheck(result, "audio chip", "PASS", chip);
  } else if (chip === "No audio") {
    addCheck(result, "audio chip", "FAIL", "the app reports no audio source");
  } else {
    addCheck(result, "audio chip", "WARN", `unrecognised chip: ${JSON.stringify(chip)}`);
  }

  const track = evidence.audioTracks[0];
  addCheck(
    result,
    "audio track",
    track ? "PASS" : "FAIL",
    track
      ? `label=${JSON.stringify(track.label)}, enabled=${track.enabled}, settings=${JSON.stringify(track.settings)} (observed evidence, not proof)`
      : "no audio track was captured",
  );
}

async function runAudio(opts) {
  const result = newResult(opts);
  const pages = [];
  try {
    return await withBrowser(opts, async ({ browser, track }) => {
      await recordEnvironment(result, browser, null);
      if (process.platform !== "win32") {
        result.environment.userAgent = await probeUserAgent(browser);
        addCheck(
          result,
          "platform",
          "SKIP",
          "game-only window audio is unsupported on macOS/Linux; skip this item instead of reporting FAIL",
        );
        return finish(result);
      }
      const major = chromeMajor(browser.version());
      if (major !== null && major < 141) {
        result.environment.userAgent = await probeUserAgent(browser);
        addCheck(
          result,
          "Chrome windowAudio",
          "SKIP",
          `windowAudio needs Chrome 141+; found ${browser.version()}`,
        );
        return finish(result);
      }

      const shared = {
        preset: opts.preset,
        codec: opts.codec,
        relayOnly: opts.relayOnly,
        audioMode: "app",
        media: opts.media,
        captureMode: opts.mode,
        viewport: { width: 1280, height: 720 },
      };
      const localBoth = opts.role === "both";
      let sharer = null;
      let viewer = null;

      if (localBoth || opts.role === "sharer") {
        sharer = await openPeer(
          browser,
          track,
          { ...shared, label: "sharer", name: "manual-sharer" },
          pages,
        );
        if (opts.create) {
          const created = await setupCreatedRoom(sharer, opts, result, { ...shared, name: "manual-sharer" });
          if (created.relayUnavailable) return finish(result);
        } else {
          await openBase(sharer.page, opts.url);
          await applySetup(sharer.page, { ...shared, name: "manual-sharer" });
          const joined = await setupJoinedRoom(sharer, opts);
          if (joined.relayUnavailable) {
            addCheck(result, "relay-only", "SKIP", "no TURN relay configured; not connecting");
            return finish(result);
          }
          result.room = "<room>";
        }
        if (!result.environment.userAgent) {
          result.environment.userAgent = await sharer.page.evaluate(() => navigator.userAgent).catch(() => null);
        }
      }

      if (localBoth || opts.role === "viewer") {
        viewer = await openPeer(
          browser,
          track,
          { ...shared, label: "viewer", name: "manual-viewer" },
          pages,
        );
        if (localBoth) {
          await openBase(viewer.page, opts.url);
          await applySetup(viewer.page, { ...shared, name: "manual-viewer" });
        }
        const joined = await setupJoinedRoom(viewer, opts);
        if (joined.relayUnavailable) {
          addCheck(result, "relay-only", "SKIP", "no TURN relay configured; not connecting");
          return finish(result);
        }
        result.room = "<room>";
        if (!result.environment.userAgent) {
          result.environment.userAgent = await viewer.page.evaluate(() => navigator.userAgent).catch(() => null);
        }
      }

      if (sharer) {
        await startSharing(sharer, opts, { secondPick: opts.mode === "second-pick" });
        const deadline = Date.now() + opts.shareTimeout;
        let evidence = null;
        while (Date.now() < deadline) {
          evidence = await readAudioEvidence(sharer.page);
          if (evidence.audioTracks.length > 0) break;
          if (sharer.watched.logs.some((log) => /audio pick cancelled or failed/.test(log.text))) {
            throw new UserCancelError("audio picker was cancelled");
          }
          await sleep(500);
        }
        if (!evidence || evidence.audioTracks.length === 0) {
          throw new TimeoutError("no audio track was captured");
        }
        result.audio = {
          evidence,
          requested: evidence.gdmOpts[0]?.audio ?? null,
          observedSettings: evidence.audioTracks.map((track) => track.settings),
        };
        audioOptionChecks(result, evidence, opts);
      }

      if (viewer) {
        await waitForMedia(viewer, "viewer", opts.connectTimeout);
        await waitForTileHealth(viewer, opts.connectTimeout);
      }

      progress(opts, `measuring audio RTP for ${opts.seconds}s`);
      const beforeSharer = sharer ? totals(await readStats(sharer.page)) : null;
      const beforeViewer = viewer ? totals(await readStats(viewer.page)) : null;
      await sleep(opts.seconds * 1000);
      const afterSharer = sharer ? totals(await readStats(sharer.page)) : null;
      const afterViewer = viewer ? totals(await readStats(viewer.page)) : null;

      if (sharer) {
        const delta = (afterSharer?.audioBytesSent ?? 0) - (beforeSharer?.audioBytesSent ?? 0);
        addCheck(
          result,
          "audio RTP sent",
          delta > 0 ? "PASS" : "FAIL",
          `${delta} bytes rose on the sharer over ${opts.seconds}s`,
        );
      }
      if (viewer) {
        const delta = (afterViewer?.audioBytesReceived ?? 0) - (beforeViewer?.audioBytesReceived ?? 0);
        addCheck(
          result,
          "audio RTP received",
          delta > 0 ? "PASS" : "FAIL",
          `${delta} bytes rose on the viewer over ${opts.seconds}s`,
        );
      }

      if (sharer) result.peers.push(peerSummary("sharer", await readStats(sharer.page)));
      if (viewer) result.peers.push(peerSummary("viewer", await readStats(viewer.page)));
      await checkConsoleAndCsp(result, pages);
      result.manual.push(
        "Human-only: only the game is audible (no Discord or music), it does not sound underwater, lip sync is within roughly 100 ms, and a live source swap keeps sync.",
        "getSettings() is observed evidence, not proof that Chrome honoured the request.",
        "macOS/Linux game-only audio is unsupported; SKIP with the windowAudioSupport reason.",
      );
      return finish(result);
    }, failureHook(result, pages, opts));
  } catch (error) {
    if (!result.errors && !(error instanceof UserCancelError)) {
      result.errors = await collectFailure(pages, { room: opts.room, names: opts.names });
    }
    return fail(result, error);
  }
}

async function runTimer(opts) {
  const result = newResult(opts);
  const pages = [];
  try {
    return await withBrowser(opts, async ({ browser, track }) => {
      const timer = await openTimer(browser);
      track(timer.context);
      pages.push({ ...timer, label: "timer" });
      await recordEnvironment(result, browser, timer.page);

      addCheck(result, "latency page", "PASS", `${latencyPageUrl} opened in its own context (file URL, no production route)`);
      const first = await timer.page.evaluate(() => ({
        clock: document.querySelector("#clock")?.textContent ?? "",
        frames: Number(document.querySelector("#frames")?.textContent ?? "0"),
      }));
      await sleep(1_000);
      const second = await timer.page.evaluate(() => ({
        clock: document.querySelector("#clock")?.textContent ?? "",
        frames: Number(document.querySelector("#frames")?.textContent ?? "0"),
      }));
      addCheck(
        result,
        "millisecond clock",
        /\d{2}:\d{2}:\d{2}\.\d{3}/.test(second.clock) ? "PASS" : "FAIL",
        second.clock,
      );
      addCheck(
        result,
        "frame counter",
        second.frames > first.frames ? "PASS" : "FAIL",
        `${first.frames} -> ${second.frames}`,
      );

      progress(
        opts,
        "Share this timer window from peer A; on peer B take five phone photos of both clocks. delta = A - B.",
      );
      if (opts.seconds > 0) {
        await sleep(opts.seconds * 1000);
      } else {
        progress(opts, "Timer stays open until you close the window or press Ctrl+C.");
        await new Promise((resolveWait) => {
          const done = () => {
            process.removeListener("SIGINT", done);
            timer.page.removeListener("close", done);
            resolveWait();
          };
          process.once("SIGINT", done);
          timer.page.once("close", done);
        });
      }

      result.manual.push(
        "Attach five phone photos showing both clocks to the #15 comment.",
        "PASS: median delta <=100 ms. WARN: 100-200 ms. FAIL: >200 ms or no photo.",
        "Record RTT and jitterBufferDelayMs from both peers as corroboration.",
      );
      await checkConsoleAndCsp(result, pages);
      return finish(result);
    }, failureHook(result, pages, opts));
  } catch (error) {
    if (!result.errors && !(error instanceof UserCancelError)) {
      result.errors = await collectFailure(pages, { room: opts.room, names: opts.names });
    }
    return fail(result, error);
  }
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n\n${HELP}\n`);
    return EXIT.SETUP;
  }
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return EXIT.PASS;
  }

  let result;
  try {
    if (opts.command === "pair") result = await runPair(opts);
    else if (opts.command === "load") result = await runLoad(opts);
    else if (opts.command === "audio") result = await runAudio(opts);
    else result = await runTimer(opts);
  } catch (error) {
    const unexpected = newResult(opts);
    unexpected.errors = { console: [], pageErrors: [String(error)], csp: [], pages: [] };
    result = fail(unexpected, error instanceof SetupError ? error : new SetupError(String(error)));
  }

  emit(result, opts);
  return result.exitCode;
}

const isEntry =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`fatal: ${error.stack ?? error}\n`);
      process.exitCode = EXIT.SETUP;
    });
}
