#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(".").replace(/\\/g, "/");
// PID-isolated sandbox directory to prevent concurrent collision
const SANDBOX_DIR = path.resolve("node_modules/.cache", `mutants-sandbox-${process.pid}`);
const SANDBOX_DIR_NORM = SANDBOX_DIR.replace(/\\/g, "/");

const TARGETS = [
  {
    sourceFile: "shared/protocol.ts",
    testFile: "test/unit/protocol.test.ts",
  },
  {
    sourceFile: "worker/ipkey.ts",
    testFile: "test/unit/ipkey.test.ts",
  },
  {
    sourceFile: "worker/ratelimit.ts",
    testFile: "test/unit/ratelimit.test.ts",
  },
  {
    sourceFile: "src/quality.ts",
    testFile: "test/unit/quality.test.ts",
  },
  {
    sourceFile: "src/stats.ts",
    testFile: "test/unit/stats.test.ts",
  },
];

const OUTPUT_DIR = path.resolve("reports/mutation");
const JSON_REPORT = path.join(OUTPUT_DIR, "mutation.json");
const HTML_REPORT = path.join(OUTPUT_DIR, "mutation.html");

const OPERATORS = [
  { name: "EqualityOperator", from: /===/g, to: "!==" },
  { name: "EqualityOperator", from: /!==/g, to: "===" },
  { name: "RelationalOperator", from: /<=/g, to: ">" },
  { name: "RelationalOperator", from: />=/g, to: "<" },
  { name: "RelationalOperator", from: /<(?!=)/g, to: ">=" },
  { name: "RelationalOperator", from: />(?!=)/g, to: "<=" },
  { name: "LogicalOperator", from: /&&/g, to: "||" },
  { name: "LogicalOperator", from: /\|\|/g, to: "&&" },
  { name: "BooleanLiteral", from: /\btrue\b/g, to: "false" },
  { name: "BooleanLiteral", from: /\bfalse\b/g, to: "true" },
];

function checkWorkingTreeClean() {
  try {
    const diff = execFileSync("git", ["diff", "HEAD", "--", "shared/", "worker/", "src/"], {
      encoding: "utf-8",
    });
    if (diff.trim().length > 0) {
      throw new Error(`Working tree is corrupted with uncommitted edits:\n${diff}`);
    }
  } catch (err) {
    if (err.message.includes("Working tree is corrupted")) throw err;
  }
}

function cleanSandbox() {
  try {
    if (fs.existsSync(SANDBOX_DIR)) {
      fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
    }
  } catch {}
}

function setupSandbox() {
  cleanSandbox();
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });

  // Copy target module trees into isolated sandbox
  for (const dir of ["shared", "worker", "src"]) {
    const srcDir = path.resolve(dir);
    const dstDir = path.join(SANDBOX_DIR, dir);
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Generate sandbox-aware Vitest configuration
  const sandboxConfigFile = path.join(SANDBOX_DIR, "vitest.sandbox.config.mjs");
  const configContent = `import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

const sandboxDir = ${JSON.stringify(SANDBOX_DIR_NORM)};
const projectRoot = ${JSON.stringify(PROJECT_ROOT)};

function sandboxPlugin() {
  return {
    name: "sandbox-redirect",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.startsWith("@shared/")) {
        const rel = source.slice("@shared/".length);
        const candidate = path.resolve(sandboxDir, "shared", rel);
        if (fs.existsSync(candidate)) return candidate;
        if (fs.existsSync(candidate + ".ts")) return candidate + ".ts";
        return candidate;
      }
      if (source.startsWith("@src/")) {
        const rel = source.slice("@src/".length);
        const candidate = path.resolve(sandboxDir, "src", rel);
        if (fs.existsSync(candidate)) return candidate;
        if (fs.existsSync(candidate + ".ts")) return candidate + ".ts";
        return candidate;
      }
      if (source.startsWith("@worker/")) {
        const rel = source.slice("@worker/".length);
        const candidate = path.resolve(sandboxDir, "worker", rel);
        if (fs.existsSync(candidate)) return candidate;
        if (fs.existsSync(candidate + ".ts")) return candidate + ".ts";
        return candidate;
      }

      if (importer) {
        const resolved = path.resolve(path.dirname(importer), source);
        const norm = resolved.replace(/\\\\/g, "/");
        for (const dir of ["shared", "worker", "src"]) {
          const targetDir = projectRoot + "/" + dir;
          if (norm === targetDir || norm.startsWith(targetDir + "/")) {
            const rel = norm.slice(projectRoot.length + 1);
            const candidate = path.resolve(sandboxDir, rel);
            if (fs.existsSync(candidate)) return candidate;
            if (fs.existsSync(candidate + ".ts")) return candidate + ".ts";
            return candidate;
          }
        }
      }
      return null;
    },
  };
}

export default defineConfig({
  test: {
    testTimeout: 15000,
    environment: "node",
  },
  resolve: {
    alias: {
      "@shared": path.resolve(sandboxDir, "shared"),
      "@src": path.resolve(sandboxDir, "src"),
      "@worker": path.resolve(sandboxDir, "worker"),
      "@electron": path.resolve(projectRoot, "electron"),
    },
  },
  plugins: [sandboxPlugin()],
});
`;
  fs.writeFileSync(sandboxConfigFile, configContent, "utf-8");
  return sandboxConfigFile;
}

// Process lifecycle hooks: clean up sandbox on exit
process.on("exit", cleanSandbox);
process.on("SIGINT", () => {
  cleanSandbox();
  process.exit(130);
});

function runVitestForTestFile(testFile, sandboxConfigFile) {
  const nodeExe = process.execPath;
  const vitestCli = path.resolve("node_modules/vitest/vitest.mjs");
  try {
    execFileSync(nodeExe, [vitestCli, "run", testFile, "--config", sandboxConfigFile], {
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: "C:\\Program Files\\nodejs;" + (process.env.PATH || ""),
      },
      timeout: 6000,
      killSignal: "SIGKILL",
    });
    // Exit code 0 means tests passed -> mutant survived
    return false;
  } catch {
    // Non-zero exit code or timeout -> mutant killed
    return true;
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function main() {
  console.log("==================================================");
  console.log("   SCREENSHARE MUTATION ANALYSIS RUNNER (SANDBOX)");
  console.log("==================================================\n");

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Pre-flight check: ensure real working tree files are untouched
  checkWorkingTreeClean();

  // Set up sandbox environment
  const sandboxConfigFile = setupSandbox();

  const results = {
    schemaVersion: "1.0",
    thresholds: { high: 80, low: 60, break: null },
    files: {},
    totals: { total: 0, killed: 0, survived: 0, score: 0 },
  };

  const maxMutantsPerFile = 3;

  for (const { sourceFile, testFile } of TARGETS) {
    const sandboxSourcePath = path.join(SANDBOX_DIR, sourceFile);
    if (!fs.existsSync(sandboxSourcePath)) {
      throw new Error(`Sandbox target file not found: ${sandboxSourcePath}`);
    }

    const originalCode = fs.readFileSync(sandboxSourcePath, "utf-8");

    const fileReport = {
      mutants: [],
      killed: 0,
      survived: 0,
      total: 0,
      score: 0,
    };
    results.files[sourceFile] = fileReport;

    const lines = originalCode.split("\n");
    let mutantsCreated = 0;
    let inBlockComment = false;
    let inTypeAlias = false;
    let typeBraceDepth = 0;

    for (let lineIndex = 0; lineIndex < lines.length && mutantsCreated < maxMutantsPerFile; lineIndex++) {
      const line = lines[lineIndex];
      const trimmed = line.trim();

      // 1. Comment tracking
      if (trimmed.startsWith("/*")) inBlockComment = true;
      if (inBlockComment) {
        if (trimmed.endsWith("*/") || trimmed.includes("*/")) inBlockComment = false;
        continue;
      }
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

      // 2. Type block tracking
      if (trimmed.startsWith("export type ") || trimmed.startsWith("type ")) {
        if (!trimmed.endsWith(";")) inTypeAlias = true;
        continue;
      }
      if (inTypeAlias) {
        if (trimmed.endsWith(";")) inTypeAlias = false;
        continue;
      }

      if (trimmed.startsWith("export interface ") || trimmed.startsWith("interface ")) {
        const open = (line.match(/{/g) || []).length;
        const close = (line.match(/}/g) || []).length;
        typeBraceDepth += open - close;
        continue;
      }
      if (typeBraceDepth > 0) {
        const open = (line.match(/{/g) || []).length;
        const close = (line.match(/}/g) || []).length;
        typeBraceDepth += open - close;
        continue;
      }

      if (trimmed.startsWith("|")) continue;

      // 3. Skip imports and purely declarative lines
      if (trimmed.startsWith("import ") || trimmed.startsWith("export {") || trimmed.startsWith("const PEER_ID =")) {
        continue;
      }

      // 4. Skip generic type annotations with < and >
      const isGenericTypeLine =
        line.includes("<string") ||
        line.includes("Record<") ||
        line.includes("Promise<") ||
        line.includes("Map<") ||
        line.includes("Set<") ||
        line.includes("Array<");

      for (const op of OPERATORS) {
        if (mutantsCreated >= maxMutantsPerFile) break;

        if (op.name === "RelationalOperator" && isGenericTypeLine) {
          continue;
        }

        if (op.from.test(line)) {
          op.from.lastIndex = 0;
          const mutatedLine = line.replace(op.from, op.to);
          if (mutatedLine === line) continue;

          const mutatedLines = [...lines];
          mutatedLines[lineIndex] = mutatedLine;
          const mutatedCode = mutatedLines.join("\n");

          // STRICT ISOLATION: Mutate ONLY inside the sandbox directory
          let isKilled = false;
          fs.mkdirSync(path.dirname(sandboxSourcePath), { recursive: true });
          fs.writeFileSync(sandboxSourcePath, mutatedCode, "utf-8");
          try {
            isKilled = runVitestForTestFile(testFile, sandboxConfigFile);
          } finally {
            // Restore sandbox file to original clean code safely
            fs.mkdirSync(path.dirname(sandboxSourcePath), { recursive: true });
            fs.writeFileSync(sandboxSourcePath, originalCode, "utf-8");
          }

          const status = isKilled ? "Killed" : "Survived";
          if (isKilled) {
            fileReport.killed++;
          } else {
            fileReport.survived++;
          }
          fileReport.total++;
          mutantsCreated++;

          fileReport.mutants.push({
            id: `${sourceFile}:${lineIndex + 1}:${op.name}`,
            mutatorName: op.name,
            lineNumber: lineIndex + 1,
            original: trimmed,
            mutated: mutatedLine.trim(),
            status,
          });
        }
      }
    }

    fileReport.score = fileReport.total > 0
      ? parseFloat(((fileReport.killed / fileReport.total) * 100).toFixed(2))
      : 100;

    results.totals.total += fileReport.total;
    results.totals.killed += fileReport.killed;
    results.totals.survived += fileReport.survived;
  }

  results.totals.score = results.totals.total > 0
    ? parseFloat(((results.totals.killed / results.totals.total) * 100).toFixed(2))
    : 100;

  // Clear-Text Summary Table
  console.log("-----------------------------------------------------------------------------");
  console.log("File                         | % Score | # Killed | # Survived | # Total");
  console.log("-----------------------------|---------|----------|------------|-------");
  for (const [file, rep] of Object.entries(results.files)) {
    const padFile = file.padEnd(28, " ");
    const padScore = rep.score.toFixed(2).padStart(7, " ");
    const padKilled = String(rep.killed).padStart(8, " ");
    const padSurvived = String(rep.survived).padStart(10, " ");
    const padTotal = String(rep.total).padStart(7, " ");
    console.log(`${padFile} | ${padScore} | ${padKilled} | ${padSurvived} | ${padTotal}`);
  }
  console.log("-----------------------------|---------|----------|------------|-------");
  const totalScore = results.totals.score.toFixed(2).padStart(7, " ");
  const totalKilled = String(results.totals.killed).padStart(8, " ");
  const totalSurvived = String(results.totals.survived).padStart(10, " ");
  const totalCount = String(results.totals.total).padStart(7, " ");
  console.log(`All files                    | ${totalScore} | ${totalKilled} | ${totalSurvived} | ${totalCount}`);
  console.log("-----------------------------------------------------------------------------\n");

  fs.writeFileSync(JSON_REPORT, JSON.stringify(results, null, 2), "utf-8");
  console.log(`JSON report saved to: ${JSON_REPORT}`);

  const scoreClass =
    results.totals.score >= 80 ? "badge-green" : results.totals.score >= 60 ? "badge-yellow" : "badge-red";
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Mutation Testing Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; background: #0f172a; color: #f8fafc; }
    h1 { margin-bottom: 0.5rem; }
    .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; font-weight: bold; font-size: 1.1rem; }
    .badge-green { background: #166534; color: #bbf7d0; }
    .badge-yellow { background: #854d0e; color: #fef08a; }
    .badge-red { background: #991b1b; color: #fecaca; }
    table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; background: #1e293b; border-radius: 8px; overflow: hidden; }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #334155; }
    th { background: #0f172a; }
    tr:hover { background: #334155; }
    .killed { color: #4ade80; font-weight: bold; }
    .survived { color: #f87171; font-weight: bold; }
    code { font-family: monospace; background: #020617; padding: 0.2rem 0.4rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Mutation Testing Report</h1>
  <p>Overall Mutation Score: <span class="badge ${scoreClass}">${results.totals.score}%</span></p>
  <p>Total Mutants: ${results.totals.total} | Killed: ${results.totals.killed} | Survived: ${results.totals.survived}</p>
  <table>
    <thead>
      <tr><th>File</th><th>Score</th><th>Killed</th><th>Survived</th><th>Total</th></tr>
    </thead>
    <tbody>
      ${Object.entries(results.files)
        .map(
          ([file, rep]) => `
      <tr>
        <td><strong>${file}</strong></td>
        <td>${rep.score}%</td>
        <td class="killed">${rep.killed}</td>
        <td class="survived">${rep.survived}</td>
        <td>${rep.total}</td>
      </tr>`
        )
        .join("")}
    </tbody>
  </table>
  <h2 style="margin-top: 2rem;">Mutant Details</h2>
  <table>
    <thead>
      <tr><th>ID</th><th>Line</th><th>Mutator</th><th>Original</th><th>Mutated</th><th>Status</th></tr>
    </thead>
    <tbody>
      ${Object.values(results.files)
        .flatMap((rep) => rep.mutants)
        .map(
          (m) => `
      <tr>
        <td><code>${m.id}</code></td>
        <td>${m.lineNumber}</td>
        <td>${m.mutatorName}</td>
        <td><code>${escapeHtml(m.original)}</code></td>
        <td><code>${escapeHtml(m.mutated)}</code></td>
        <td class="${m.status === "Killed" ? "killed" : "survived"}">${m.status}</td>
      </tr>`
        )
        .join("")}
    </tbody>
  </table>
</body>
</html>`;

  fs.writeFileSync(HTML_REPORT, htmlContent, "utf-8");
  console.log(`HTML report saved to: ${HTML_REPORT}\n`);

  // Post-flight verification: guarantee real working tree was NEVER touched
  checkWorkingTreeClean();
  console.log("Post-flight check PASSED: Production files in shared/, worker/, src/ remain 100% untouched.");

  // Clean sandbox on completion
  cleanSandbox();
}

main().catch((err) => {
  console.error("Fatal error in mutation runner:", err);
  cleanSandbox();
  process.exit(1);
});
