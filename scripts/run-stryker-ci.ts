import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ZERO_SHA = /^0+$/;

function readMutatePatterns(configPath: string): string[] {
  const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (typeof raw !== "object" || raw === null || !("mutate" in raw)) return [];
  const { mutate } = raw;
  if (!Array.isArray(mutate)) return [];
  return mutate.filter((item): item is string => typeof item === "string");
}

function toPosix(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

/**
 * Resolve all repository files matching Stryker's `mutate` include/exclude globs.
 */
export function resolveMutateFiles(patterns: readonly string[], cwd: string = process.cwd()): string[] {
  const included = new Set<string>();
  const excluded = new Set<string>();

  for (const raw of patterns) {
    const isExclude = raw.startsWith("!");
    const pattern = isExclude ? raw.slice(1) : raw;
    const target = isExclude ? excluded : included;
    for (const match of globSync(pattern, { cwd })) {
      target.add(toPosix(match));
    }
  }

  return [...included].filter((f) => !excluded.has(f)).sort();
}

/**
 * Intersect git-changed file paths with Stryker-eligible files (deterministic, sorted).
 */
export function selectChangedMutateFiles(
  eligibleFiles: readonly string[],
  changedFiles: readonly string[],
): string[] {
  const eligible = new Set(eligibleFiles.map(toPosix));
  const selected = new Set<string>();
  for (const file of changedFiles) {
    const normalized = toPosix(file.trim());
    if (normalized && eligible.has(normalized)) {
      selected.add(normalized);
    }
  }
  return [...selected].sort();
}

function resolveBaseRef(): string {
  const envBase = process.env["STRYKER_BASE_REF"]?.trim();
  if (envBase && !ZERO_SHA.test(envBase)) return envBase;
  return "origin/main";
}

function getChangedFiles(baseRef: string, cwd: string = process.cwd()): string[] {
  const threeDot = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...HEAD`], {
    cwd,
    encoding: "utf8",
  });
  if (threeDot.status === 0) {
    return threeDot.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  }
  const twoDot = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMR", baseRef, "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (twoDot.status === 0) {
    return twoDot.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  }
  const errMsg = (threeDot.stderr || twoDot.stderr || "").trim();
  throw new Error(`git diff against '${baseRef}' failed: ${errMsg}`);
}

function main(): void {
  const configPath = path.resolve(process.cwd(), "stryker.config.json");
  const patterns = readMutatePatterns(configPath);
  const eligibleFiles = resolveMutateFiles(patterns);
  if (eligibleFiles.length === 0) {
    console.error("[stryker-ci] No files matched stryker.config.json mutate patterns.");
    process.exit(1);
  }

  const baseRef = resolveBaseRef();
  const changedFiles = getChangedFiles(baseRef);
  const selected = selectChangedMutateFiles(eligibleFiles, changedFiles);

  if (selected.length === 0) {
    console.log(`[stryker-ci] No eligible mutate files changed vs ${baseRef}; skipping mutation testing.`);
    process.exit(0);
  }

  console.log(
    `[stryker-ci] Mutating ${selected.length} changed eligible file(s) vs ${baseRef} (of ${eligibleFiles.length} total):`,
  );
  for (const file of selected) {
    console.log(`  - ${file}`);
  }

  const extraArgs = process.argv.slice(2);
  const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(npxBin, ["stryker", "run", "-m", selected.join(","), ...extraArgs], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.error("[stryker-ci] Failed to launch stryker:", result.error);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

const isEntrypoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main();
}
