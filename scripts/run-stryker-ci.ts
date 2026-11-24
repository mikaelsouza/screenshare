import { spawnSync } from "node:child_process";
import { appendFileSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ZERO_SHA = /^0+$/;
const RUNTIME_SOURCE_PATTERN = /^(src|worker|shared|electron|scripts)\/.*\.tsx?$/;

export function readMutatePatterns(configPath: string): string[] {
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
  const includePatterns: string[] = [];
  const excludePatterns: string[] = [];

  for (const raw of patterns) {
    if (raw.startsWith("!")) {
      excludePatterns.push(toPosix(raw.slice(1)));
    } else {
      includePatterns.push(toPosix(raw));
    }
  }

  const included = new Set<string>();
  for (const pattern of includePatterns) {
    for (const match of globSync(pattern, { cwd })) {
      included.add(toPosix(match));
    }
  }

  return [...included]
    .filter((file) => !excludePatterns.some((pattern) => path.matchesGlob(file, pattern)))
    .sort();
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
    const normalized = toPosix(file);
    if (normalized.length > 0 && eligible.has(normalized)) {
      selected.add(normalized);
    }
  }
  return [...selected].sort();
}

export function parseNullDelimitedPaths(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

export function resolveBaseRef(): string {
  const envBase = process.env["STRYKER_BASE_REF"]?.trim();
  if (envBase && !ZERO_SHA.test(envBase)) return envBase;
  return "origin/main";
}

/**
 * Return changed runtime `.ts`/`.tsx` files excluded from Stryker's `mutate` scope (sorted, unique).
 */
export function selectExcludedMutateFiles(
  eligibleFiles: readonly string[],
  changedFiles: readonly string[],
): string[] {
  const eligible = new Set(eligibleFiles.map(toPosix));
  const excluded = new Set<string>();
  for (const file of changedFiles) {
    const normalized = toPosix(file);
    if (
      RUNTIME_SOURCE_PATTERN.test(normalized) &&
      !normalized.endsWith(".d.ts") &&
      !eligible.has(normalized)
    ) {
      excluded.add(normalized);
    }
  }
  return [...excluded].sort();
}

/**
 * Format a Markdown step summary of Stryker-mutated and excluded changed runtime files.
 */
export function formatExcludedSummary(
  selected: readonly string[],
  excluded: readonly string[],
  baseRef: string,
): string {
  const lines = [
    `### Mutation Testing (Stryker vs \`${baseRef}\`)`,
    `- Mutated eligible files (${selected.length}): ${selected.length > 0 ? selected.map((f) => `\`${f}\``).join(", ") : "_none_"}`,
  ];
  if (excluded.length > 0) {
    lines.push(
      `- Skipped excluded runtime files (${excluded.length}): ${excluded.map((f) => `\`${f}\``).join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// Stryker disable all: CLI git/stryker process entrypoint
/* v8 ignore start */
function getChangedFiles(baseRef: string, cwd: string = process.cwd()): string[] {
  const threeDot = spawnSync("git", ["diff", "--name-only", "-z", "--diff-filter=ACMR", `${baseRef}...HEAD`], {
    cwd,
    encoding: "utf8",
  });
  if (threeDot.status === 0) {
    return parseNullDelimitedPaths(threeDot.stdout);
  }
  const twoDot = spawnSync("git", ["diff", "--name-only", "-z", "--diff-filter=ACMR", baseRef, "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (twoDot.status === 0) {
    return parseNullDelimitedPaths(twoDot.stdout);
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
  const excluded = selectExcludedMutateFiles(eligibleFiles, changedFiles);

  if (excluded.length > 0) {
    console.log(
      `::notice title=Stryker skipped excluded files::${excluded.length} changed runtime file(s) outside stryker.config.json mutate scope: ${excluded.join(", ")}`,
    );
  }
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath) {
    appendFileSync(summaryPath, formatExcludedSummary(selected, excluded, baseRef), "utf8");
  }

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
/* v8 ignore stop */
// Stryker restore all
