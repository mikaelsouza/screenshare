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
  const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const proc = spawn(
    cmd,
    ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--log-level", "warn"],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env, shell: process.platform === "win32", detached: process.platform !== "win32" },
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
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(server.proc.pid)], { stdio: "ignore" });
      await new Promise((r) => killer.on("close", r));
    } catch {}
  } else {
    try { process.kill(-server.proc.pid, "SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    if (server.proc.exitCode === null) { try { process.kill(-server.proc.pid, "SIGKILL"); } catch {} }
    server.proc.stdout?.destroy();
    server.proc.stderr?.destroy();
    server.proc.unref();
  }
}

export async function launchBrowser() {
  const executablePath =
    process.env.CHROMIUM_BIN ??
    (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined);
  if (!executablePath) throw new Error("CHROMIUM_BIN is unset — run inside 'nix develop'.");
  return chromium.launch({
    executablePath,
    args: [
      "--no-sandbox",
      // Media flags: allow WebRTC to run unattended with no real devices or user
      // gesture, so the encode/decode path is exercised exactly as in production.
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      // Request the STRICT autoplay policy rather than the permissive one this suite
      // used to pass. Relaxing it hid a real defect: against the live deployment,
      // unmuted play() on a remote MediaStream IS rejected without a user gesture,
      // so relying on the `autoplay` attribute alone produced a silently black tile.
      // An earlier probe suggested MediaStream sources were exempt; that probe was
      // wrong — it used about:blank and a local canvas stream rather than a remote
      // track on a navigated page. Keep this strict.
      "--autoplay-policy=document-user-activation-required",
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
  // Every CSP or Trusted Types violation, so a suite can fail on one instead of the
  // page quietly losing a script or a style.
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
  });
  // What the app asks the screen picker for; the privacy defaults live there.
  window.__gdmOpts = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Native);

  navigator.mediaDevices.getDisplayMedia = async (options) => {
    window.__gdmOpts.push(JSON.parse(JSON.stringify(options ?? {})));
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
    (window.__gdmStreams ??= []).push(stream);
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
