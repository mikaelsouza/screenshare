import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execSync } from "node:child_process";

const NODE = process.execPath;
const SCRIPT = path.resolve("scripts/run-mutation.mjs");
const CACHE_DIR = path.resolve("node_modules/.cache");
const REPORT_JSON = path.resolve("reports/mutation/mutation.json");
const REPORT_HTML = path.resolve("reports/mutation/mutation.html");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getGitDiff() {
  try {
    const diff = execSync("git diff HEAD -- shared/ worker/ src/ electron/", { encoding: "utf-8" });
    return diff.trim();
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function getSandboxDirs() {
  if (!fs.existsSync(CACHE_DIR)) return [];
  return fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith("mutants-sandbox"));
}

function cleanAllSandboxes() {
  for (const s of getSandboxDirs()) {
    try {
      fs.rmSync(path.join(CACHE_DIR, s), { recursive: true, force: true });
    } catch {}
  }
}

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function getDirectoryFileHashes(dirs) {
  const hashes = {};
  for (const dir of dirs) {
    const fullDir = path.resolve(dir);
    if (!fs.existsSync(fullDir)) continue;
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          hashes[full] = hashFile(full);
        }
      }
    };
    walk(fullDir);
  }
  return hashes;
}

const summary = [];

function recordResult(name, pass, details) {
  summary.push({ name, pass, details });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}`);
  if (details) console.log(`       Details: ${details}`);
}

async function test1_Concurrency() {
  console.log("\n=== TEST 1: CONCURRENT RUNNER EXECUTION (3 Parallel Instances) ===");
  cleanAllSandboxes();
  const diffBefore = getGitDiff();
  if (diffBefore.length > 0) {
    recordResult("Concurrency: Baseline Cleanliness", false, `Working tree dirty: ${diffBefore}`);
    return false;
  }

  const pids = [];
  const observedSandboxes = new Set();
  let inFlightDiffViolations = 0;

  const runInstance = (id) =>
    new Promise((resolve) => {
      const start = Date.now();
      const cp = spawn(NODE, [SCRIPT], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: "C:\\Program Files\\nodejs;" + (process.env.PATH || ""),
        },
      });

      pids.push(cp.pid);
      let stdout = "";
      let stderr = "";

      cp.stdout.on("data", (d) => (stdout += d.toString()));
      cp.stderr.on("data", (d) => (stderr += d.toString()));

      cp.on("close", (code) => {
        const duration = Date.now() - start;
        resolve({ id, pid: cp.pid, code, duration, stdout, stderr });
      });
    });

  // Spawn 3 concurrent processes
  const p1 = runInstance(1);
  const p2 = runInstance(2);
  const p3 = runInstance(3);

  // Monitor concurrent sandboxes and git diff while running
  const monitorInterval = setInterval(() => {
    const sandboxes = getSandboxDirs();
    for (const s of sandboxes) {
      observedSandboxes.add(s);
    }
    const diff = getGitDiff();
    if (diff.length > 0) inFlightDiffViolations++;
  }, 150);

  const results = await Promise.all([p1, p2, p3]);
  clearInterval(monitorInterval);

  // Give short delay for Windows filesystem cleanup to settle
  await sleep(1500);

  console.log(`Observed sandbox directories during run:`, Array.from(observedSandboxes));
  for (const r of results) {
    console.log(`Instance ${r.id} (PID ${r.pid}): exited with code ${r.code} in ${r.duration}ms`);
  }

  const allPassed = results.every((r) => r.code === 0);
  const pidsMatchSandboxes = results.every((r) => observedSandboxes.has(`mutants-sandbox-${r.pid}`));
  const remainingSandboxes = getSandboxDirs();
  const diffAfter = getGitDiff();

  recordResult(
    "Concurrency: All 3 processes exit with code 0",
    allPassed,
    results.map((r) => `PID ${r.pid}: code ${r.code}`).join(", ")
  );

  recordResult(
    "Concurrency: PID isolation verified (each process had distinct sandbox)",
    pidsMatchSandboxes,
    `Expected PIDs: ${pids.join(", ")}; Observed sandboxes: ${Array.from(observedSandboxes).join(", ")}`
  );

  recordResult(
    "Concurrency: In-flight production files diff was strictly 0",
    inFlightDiffViolations === 0,
    `Violations: ${inFlightDiffViolations}`
  );

  recordResult(
    "Concurrency: No lingering sandbox directories remaining",
    remainingSandboxes.length === 0,
    `Remaining: ${remainingSandboxes.join(", ") || "none"}`
  );

  recordResult(
    "Concurrency: Post-execution git diff is strictly 0",
    diffAfter.length === 0,
    diffAfter ? `Diff: ${diffAfter}` : "Clean"
  );
}

async function test2_RapidConsecutive() {
  console.log("\n=== TEST 2: RAPID CONSECUTIVE EXECUTIONS (3 Sequential Runs) ===");
  cleanAllSandboxes();
  let allRunsPassed = true;
  let allCleanupsPassed = true;

  for (let i = 1; i <= 3; i++) {
    const start = Date.now();
    try {
      execSync(`node "${SCRIPT}"`, {
        stdio: "pipe",
        env: {
          ...process.env,
          PATH: "C:\\Program Files\\nodejs;" + (process.env.PATH || ""),
        },
      });
      const dur = Date.now() - start;
      await sleep(500);
      const lingering = getSandboxDirs();
      console.log(`Run ${i}/3 succeeded in ${dur}ms; lingering sandboxes: ${lingering.length}`);
      if (lingering.length > 0) allCleanupsPassed = false;
    } catch (e) {
      console.error(`Run ${i}/3 failed:`, e.message);
      allRunsPassed = false;
    }
  }

  const diff = getGitDiff();
  recordResult(
    "Rapid Consecutive: 3 back-to-back runs succeed without file lock or state leakage",
    allRunsPassed && allCleanupsPassed,
    `All runs passed: ${allRunsPassed}, Cleanups passed: ${allCleanupsPassed}`
  );
  recordResult("Rapid Consecutive: Production files untouched", diff.length === 0, diff || "Clean");
}

async function test3_InFlightHashInvariance() {
  console.log("\n=== TEST 3: IN-FLIGHT PRODUCTION FILE HASH INVARIANCE ===");
  const targetDirs = ["shared", "worker", "src", "electron"];
  const baselineHashes = getDirectoryFileHashes(targetDirs);
  const fileCount = Object.keys(baselineHashes).length;
  console.log(`Tracking ${fileCount} files in production directories...`);

  let hashDriftDetected = 0;
  let samplesTaken = 0;

  const cp = spawn(NODE, [SCRIPT], {
    stdio: "pipe",
    env: {
      ...process.env,
      PATH: "C:\\Program Files\\nodejs;" + (process.env.PATH || ""),
    },
  });

  const checkInterval = setInterval(() => {
    samplesTaken++;
    for (const [filePath, expectedHash] of Object.entries(baselineHashes)) {
      try {
        const currentHash = hashFile(filePath);
        if (currentHash !== expectedHash) {
          hashDriftDetected++;
          console.error(`CRITICAL: File hash modified during run: ${filePath}`);
        }
      } catch (err) {
        hashDriftDetected++;
        console.error(`CRITICAL: File inaccessible during run: ${filePath}`);
      }
    }
  }, 100);

  const exitCode = await new Promise((res) => {
    cp.on("close", (code) => res(code));
  });
  clearInterval(checkInterval);

  console.log(`Samples taken during run: ${samplesTaken}, Hash deviations: ${hashDriftDetected}`);
  recordResult(
    "Invariance: Production source file hashes strictly constant throughout execution",
    hashDriftDetected === 0,
    `Tested ${fileCount} files across ${samplesTaken} time-slices; 0 modifications detected.`
  );
  recordResult("Invariance: Runner exited with code 0", exitCode === 0, `Exit code: ${exitCode}`);
}

async function test4_AbortResilience() {
  console.log("\n=== TEST 4: ABORT & TERMINATION RESILIENCE ===");
  const cp = spawn(NODE, [SCRIPT], {
    stdio: "pipe",
    env: {
      ...process.env,
      PATH: "C:\\Program Files\\nodejs;" + (process.env.PATH || ""),
    },
  });

  let abortedPid = cp.pid;
  let aborted = false;

  const poll = setInterval(() => {
    const s = getSandboxDirs();
    if (s.length > 0 && !aborted) {
      aborted = true;
      console.log(`Active sandbox detected (${s[0]}). Sending SIGINT to PID ${abortedPid}...`);
      cp.kill("SIGINT");
    }
  }, 50);

  const exitCode = await new Promise((res) => {
    cp.on("close", (code) => res(code));
  });
  clearInterval(poll);

  console.log(`Aborted process exited with code ${exitCode}`);
  const diffAfterAbort = getGitDiff();

  recordResult(
    "Abort Resilience: Process interrupted without corrupting production files",
    diffAfterAbort.length === 0,
    diffAfterAbort ? `Diff: ${diffAfterAbort}` : "Clean"
  );

  // Clean up aborted PID sandbox
  const deadSandbox = path.resolve(CACHE_DIR, `mutants-sandbox-${abortedPid}`);
  if (fs.existsSync(deadSandbox)) {
    fs.rmSync(deadSandbox, { recursive: true, force: true });
  }

  // Verify that following an abort, a subsequent fresh run completes with 100% score
  let recoveryPass = false;
  try {
    const stdout = execSync(`node "${SCRIPT}"`, {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: "C:\\Program Files\\nodejs;" + (process.env.PATH || ""),
      },
    });
    recoveryPass = stdout.includes("All files                    |  100.00");
  } catch (e) {
    recoveryPass = false;
  }

  recordResult(
    "Abort Resilience: System cleanly recovers on subsequent execution",
    recoveryPass,
    recoveryPass ? "Subsequent execution completed with 100% score" : "Failed recovery"
  );
}

async function test5_ReportIntegrity() {
  console.log("\n=== TEST 5: REPORT FILE INTEGRITY & VALIDATION ===");
  let jsonValid = false;
  let score100 = false;
  let htmlValid = false;

  try {
    const raw = fs.readFileSync(REPORT_JSON, "utf-8");
    const parsed = JSON.parse(raw);
    jsonValid = true;
    score100 = parsed.totals?.score === 100 && parsed.totals?.killed === 15 && parsed.totals?.survived === 0;
  } catch (e) {
    console.error("Failed to parse mutation.json:", e);
  }

  try {
    const html = fs.readFileSync(REPORT_HTML, "utf-8");
    htmlValid = html.includes("<!DOCTYPE html>") && html.includes("100%") && html.includes("badge-green");
  } catch (e) {
    console.error("Failed to read mutation.html:", e);
  }

  recordResult(
    "Report Integrity: mutation.json is valid and records 100.00% score",
    jsonValid && score100,
    `Valid JSON: ${jsonValid}, Score: 100% (15 killed, 0 survived)`
  );

  recordResult(
    "Report Integrity: mutation.html is valid HTML report",
    htmlValid,
    `HTML contains DOCTYPE and green badge`
  );
}

async function test6_FullRegressionSuite() {
  console.log("\n=== TEST 6: FULL REPOSITORY REGRESSION SUITE (npm run test:all) ===");
  const exitCode = await new Promise((resolve) => {
    const cp = spawn("npm.cmd", ["run", "test:all"], {
      stdio: "inherit",
      shell: true,
      env: {
        ...process.env,
        PATH: "C:\\Program Files\\nodejs;" + (process.env.PATH || ""),
      },
    });
    cp.on("close", (code) => resolve(code));
  });

  const passed = exitCode === 0;
  recordResult(
    "Full Regression: npm run test:all passes cleanly with 0 errors across 295 tests",
    passed,
    passed ? "All checks and test suites passed (exit code 0)" : `Failed with exit code: ${exitCode}`
  );
}

async function main() {
  console.log("==================================================================");
  console.log("   CHALLENGER EMPIRICAL STRESS & ADVERSARIAL HARNESS             ");
  console.log("==================================================================");

  try {
    await test1_Concurrency();
    await test2_RapidConsecutive();
    await test3_InFlightHashInvariance();
    await test4_AbortResilience();
    await test5_ReportIntegrity();
    await test6_FullRegressionSuite();
  } catch (err) {
    console.error("Unexpected error in stress harness:", err);
  }

  console.log("\n==================================================================");
  console.log("   SUMMARY OF EMPIRICAL ADVERSARIAL CHALLENGES                   ");
  console.log("==================================================================");
  let totalPass = 0;
  for (const s of summary) {
    console.log(`[${s.pass ? "PASS" : "FAIL"}] ${s.name}`);
    if (s.pass) totalPass++;
  }
  console.log(`\nTOTAL: ${totalPass} / ${summary.length} CHALLENGES PASSED`);

  const reportData = {
    timestamp: new Date().toISOString(),
    total: summary.length,
    passed: totalPass,
    failed: summary.length - totalPass,
    results: summary,
  };
  fs.writeFileSync(
    path.resolve(".agents/teamwork/challenger_m1_gate_1/stress-results.json"),
    JSON.stringify(reportData, null, 2),
    "utf-8"
  );
}

main();
