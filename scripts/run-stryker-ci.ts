import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SAMPLE_SIZE = 6;

function readMutatePatterns(configPath: string): string[] {
  const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (typeof raw !== "object" || raw === null || !("mutate" in raw)) return [];
  const { mutate } = raw;
  if (!Array.isArray(mutate)) return [];
  return mutate.filter((item): item is string => typeof item === "string");
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
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
 * Pick a uniformly random subset of at most `sampleSize` items without replacement.
 */
export function selectRandomSubset(
  files: readonly string[],
  sampleSize: number,
  randInt: (maxExclusive: number) => number = (max) => randomInt(max),
): string[] {
  const count = Math.max(1, Math.min(sampleSize, files.length));
  const pool = [...files];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const tmp = pool[i];
    const swap = pool[j];
    if (tmp !== undefined && swap !== undefined) {
      pool[i] = swap;
      pool[j] = tmp;
    }
  }
  return pool.slice(0, count).sort();
}

function parseSampleSize(raw: string | undefined): number {
  if (!raw) return DEFAULT_SAMPLE_SIZE;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAMPLE_SIZE;
}

function main(): void {
  const configPath = path.resolve(process.cwd(), "stryker.config.json");
  const patterns = readMutatePatterns(configPath);
  const allFiles = resolveMutateFiles(patterns);
  if (allFiles.length === 0) {
    console.error("[stryker-ci] No files matched stryker.config.json mutate patterns.");
    process.exit(1);
  }

  const sampleSize = parseSampleSize(process.env["STRYKER_CI_SAMPLE_SIZE"]);
  const selected = selectRandomSubset(allFiles, sampleSize);

  console.log(
    `[stryker-ci] Selected ${selected.length} / ${allFiles.length} eligible files for CI mutation testing:`,
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
