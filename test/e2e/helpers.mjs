import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

/**
 * Each test file gets its own port: `node --test` runs files in separate processes
 * concurrently, so a shared port would make them collide.
 */
export function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

/** Start `wrangler dev` on `port` and wait until it actually answers. */
export async function startServer(port) {
  const BASE_URL = baseUrl(port);
  const proc = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--log-level", "warn"],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`wrangler exited early:\n${log}`);
    try {
      const res = await fetch(`${BASE_URL}/api/room`);
      if (res.ok) return { proc, log: () => log };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  proc.kill("SIGKILL");
  throw new Error(`wrangler dev never became ready:\n${log}`);
}

export async function stopServer(server) {
  if (!server) return;
  server.proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  if (server.proc.exitCode === null) server.proc.kill("SIGKILL");
}

export async function launchBrowser() {
  const executablePath = process.env.CHROMIUM_BIN;
  if (!executablePath) throw new Error("CHROMIUM_BIN is unset — run inside 'nix develop'.");
  return chromium.launch({
    executablePath,
    args: [
      "--no-sandbox",
      // Media flags: allow WebRTC to run unattended with no real devices or user
      // gesture, so the encode/decode path is exercised exactly as in production.
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--allow-running-insecure-content",
      "--disable-dev-shm-usage",
    ],
  });
}

/**
 * Instrumentation injected before any page script runs.
 *
 * 1. Stubs getDisplayMedia with a canvas + oscillator stream. Headless Chrome cannot
 *    show a screen picker, and the picker is not what we are testing — everything
 *    downstream of it (negotiation, encoding, transport, decode) is real.
 * 2. Records every RTCPeerConnection so the test can inspect real getStats() output,
 *    without the app having to export anything for testability.
 */
export const INSTRUMENT = () => {
  window.__pcs = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Native);

  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    let frame = 0;
    // Content must actually change every frame, or the encoder sends almost nothing
    // and framesDecoded on the far side stays flat.
    setInterval(() => {
      frame++;
      ctx.fillStyle = `hsl(${frame % 360}, 90%, 50%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.font = "72px monospace";
      ctx.fillText(String(frame), 60, 400);
    }, 1000 / 30);

    const stream = canvas.captureStream(30);
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const osc = audioCtx.createOscillator();
    osc.connect(dest);
    osc.start();
    for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
    return stream;
  };
};

/** Poll an in-page predicate until it returns truthy. */
export async function waitFor(page, fn, { timeout = 30_000, interval = 500, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(fn);
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
}
