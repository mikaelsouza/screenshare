/**
 * Packaged Electron Fuse & ASAR Integrity Startup Verifier.
 *
 * Unlike `scripts/smoke-test.ts` (unpackaged Playwright DOM/IPC test), packaged
 * binaries ignore all env/CLI overrides and burn all 6 `@electron/fuses`. This
 * verifier inspects the built `Screenshare.exe` directly:
 * 1. Verifies all 6 required security fuses via `getCurrentFuseWire(execPath)`.
 * 2. Verifies `ELECTRON_RUN_AS_NODE=1` cannot execute inline Node code (`-e`).
 * 3. Verifies `--inspect=127.0.0.1:<port>` does not expose a V8 inspector socket.
 * 4. Verifies clean native startup for 4s without ASAR integrity crash (`exitCode === null`),
 *    then cleanly terminates the binary.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Byte values stored in the Electron binary's SENTINEL fuse wire (`@electron/fuses/dist/constants`). */
export const FUSE_STATE_DISABLE = 48; // '0'
export const FUSE_STATE_ENABLE = 49; // '1'
export const FUSE_STATE_REMOVED = 114; // 'r'
export const FUSE_STATE_INHERIT = 144;

/** Fuse wire indices matching `@electron/fuses` `FuseV1Options`. */
export const FUSE_V1_VERSION = "1";
export const FUSE_V1_RUN_AS_NODE = 0;
export const FUSE_V1_ENABLE_COOKIE_ENCRYPTION = 1;
export const FUSE_V1_ENABLE_NODE_OPTIONS_ENV = 2;
export const FUSE_V1_ENABLE_NODE_CLI_INSPECT = 3;
export const FUSE_V1_ENABLE_ASAR_INTEGRITY = 4;
export const FUSE_V1_ONLY_LOAD_APP_FROM_ASAR = 5;

export interface RequiredFuseExpectation {
  option: number;
  name: string;
  expected: boolean;
}

export const REQUIRED_ELECTRON_FUSES: readonly RequiredFuseExpectation[] = [
  { option: FUSE_V1_RUN_AS_NODE, name: "runAsNode", expected: false },
  { option: FUSE_V1_ENABLE_COOKIE_ENCRYPTION, name: "enableCookieEncryption", expected: true },
  {
    option: FUSE_V1_ENABLE_NODE_OPTIONS_ENV,
    name: "enableNodeOptionsEnvironmentVariable",
    expected: false,
  },
  { option: FUSE_V1_ENABLE_NODE_CLI_INSPECT, name: "enableNodeCliInspectArguments", expected: false },
  {
    option: FUSE_V1_ENABLE_ASAR_INTEGRITY,
    name: "enableEmbeddedAsarIntegrityValidation",
    expected: true,
  },
  { option: FUSE_V1_ONLY_LOAD_APP_FROM_ASAR, name: "onlyLoadAppFromAsar", expected: true },
] as const;

export interface FuseVerificationResult {
  ok: boolean;
  failures: string[];
}

export function verifyFuseWire(
  wire: Partial<Record<number, number>> & { version?: string },
): FuseVerificationResult {
  const failures: string[] = [];
  if (wire.version !== undefined && wire.version !== FUSE_V1_VERSION) {
    failures.push(`Expected fuse wire version ${FUSE_V1_VERSION}, got ${wire.version}`);
  }
  for (const spec of REQUIRED_ELECTRON_FUSES) {
    const expectedState = spec.expected ? FUSE_STATE_ENABLE : FUSE_STATE_DISABLE;
    const actualState = wire[spec.option];
    if (actualState !== expectedState) {
      failures.push(
        `Fuse ${spec.name} mismatch: expected ${String(expectedState)} (${spec.expected ? "ENABLE" : "DISABLE"}), got ${String(actualState)}`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}

export function verifyElectronBuilderFuseConfig(rawConfig: unknown): FuseVerificationResult {
  if (typeof rawConfig !== "object" || rawConfig === null) {
    return { ok: false, failures: ["electron-builder.json root must be an object"] };
  }
  const fuses: unknown = Reflect.get(rawConfig, "electronFuses");
  if (typeof fuses !== "object" || fuses === null) {
    return { ok: false, failures: ["electron-builder.json is missing electronFuses"] };
  }
  const failures: string[] = [];
  if (Reflect.get(rawConfig, "asar") !== true) {
    failures.push("electron-builder.json must keep asar: true for ASAR integrity fuses");
  }
  for (const spec of REQUIRED_ELECTRON_FUSES) {
    const actual: unknown = Reflect.get(fuses, spec.name);
    if (actual !== spec.expected) {
      failures.push(`electronFuses.${spec.name} must be ${String(spec.expected)}, got ${String(actual)}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/* v8 ignore start */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function resolvePackagedExecutable(): string {
  const custom = process.env["ELECTRON_EXEC_PATH"]?.trim();
  const target = custom
    ? path.resolve(projectRoot, custom)
    : path.join(projectRoot, "release", "win-unpacked", "Screenshare.exe");
  if (!fs.existsSync(target)) {
    throw new Error(`Packaged Electron executable not found: ${target}`);
  }
  return target;
}

function getUnusedLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("Failed to allocate local probe port")));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function canConnectTcp(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    const done = (connected: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(connected);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

async function terminateProcessTree(pid: number | undefined, proc: ReturnType<typeof spawn>): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }
  await new Promise<void>((resolve) => {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 2_000);
    timer.unref();
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function checkRunAsNodeBlocked(execPath: string): Promise<void> {
  const marker = "PACKAGED_FUSE_RUN_AS_NODE_BYPASSED";
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const child = spawn(
    execPath,
    ["-e", `process.stdout.write(${JSON.stringify(marker)}); process.exit(42);`],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  await new Promise((r) => setTimeout(r, 1500));
  if (stdout.includes(marker) || child.exitCode === 42) {
    await terminateProcessTree(child.pid, child);
    throw new Error("ELECTRON_RUN_AS_NODE=1 executed arbitrary -e script despite RunAsNode=DISABLE fuse");
  }
  await terminateProcessTree(child.pid, child);
}

async function checkInspectAndNativeStartup(execPath: string): Promise<void> {
  const inspectPort = await getUnusedLocalPort();
  const child = spawn(execPath, [`--inspect=127.0.0.1:${String(inspectPort)}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  try {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `Packaged executable exited prematurely (code=${String(child.exitCode)}):\n${stderr}`,
        );
      }
      if (await canConnectTcp(inspectPort, 250)) {
        throw new Error(`V8 inspector port 127.0.0.1:${String(inspectPort)} opened despite EnableNodeCliInspectArguments=DISABLE`);
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    if (child.exitCode !== null) {
      throw new Error(`Packaged executable exited within 4s window (code=${String(child.exitCode)}):\n${stderr}`);
    }
    if (/debugger listening/i.test(stderr)) {
      throw new Error(`Packaged executable printed inspector listener banner:\n${stderr}`);
    }
  } finally {
    await terminateProcessTree(child.pid, child);
  }
}

async function runPackagedSmokeVerifier(): Promise<void> {
  const execPath = resolvePackagedExecutable();
  console.log(`[smoke-packaged] Inspecting binary fuses: ${execPath}`);

  const { getCurrentFuseWire } = await import("@electron/fuses");
  const wire: Partial<Record<number, number>> & { version?: string } = await getCurrentFuseWire(execPath);
  const verdict = verifyFuseWire(wire);
  if (!verdict.ok) {
    throw new Error(`Packaged fuse verification failed:\n${verdict.failures.join("\n")}`);
  }
  console.log("[smoke-packaged] All 6 Electron security fuses verified.");

  await checkRunAsNodeBlocked(execPath);
  console.log("[smoke-packaged] Verified ELECTRON_RUN_AS_NODE=1 is disabled.");

  await checkInspectAndNativeStartup(execPath);
  console.log("[smoke-packaged] Verified --inspect is disabled and binary survived 4s native ASAR integrity startup.");
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await runPackagedSmokeVerifier();
}
/* v8 ignore stop */
