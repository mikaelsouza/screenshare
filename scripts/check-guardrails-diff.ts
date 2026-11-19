/**
 * "Guard the Guards" CI check.
 *
 * Flags edits to protected verification guardrails, protocol schemas, CSP headers,
 * and workflow definitions. On pull_request events, fails unless the PR carries the
 * `approved-guardrail-change` label, and always writes the exact guardrail diff to
 * `$GITHUB_STEP_SUMMARY` when available.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APPROVED_GUARDRAIL_LABEL = "approved-guardrail-change";

const EXACT_GUARDRAIL_FILES = new Set<string>([
  "AGENTS.md",
  ".oxlintrc.json",
  "stryker.config.json",
  "vitest.config.ts",
  "vitest.workers.config.ts",
  "electron-builder.json",
  "shared/protocol.ts",
  "worker/index.ts",
  "scripts/check-guardrails-diff.ts",
]);

const GUARDRAIL_PREFIXES: readonly string[] = ["test/formal/", ".github/"];

export interface GuardrailEvaluationInput {
  eventName: string;
  changedFiles: readonly string[];
  prLabels: readonly string[];
}

export interface GuardrailEvaluationResult {
  touchedGuardrails: string[];
  approved: boolean;
  shouldFail: boolean;
  message: string;
}

/** Normalize git-style relative paths and check whether a path is a protected guardrail file. */
export function isGuardrailFile(filePath: string): boolean {
  const normalized = filePath.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.length === 0) return false;
  if (EXACT_GUARDRAIL_FILES.has(normalized)) return true;
  return GUARDRAIL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Parse a JSON-encoded array of PR label strings (tolerating empty or malformed values). */
export function parsePrLabelsJson(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/** Evaluate whether a change set requires maintainer guardrail approval. */
export function evaluateGuardrailChanges(
  input: GuardrailEvaluationInput,
): GuardrailEvaluationResult {
  const seen = new Set<string>();
  const touchedGuardrails: string[] = [];
  for (const rawFile of input.changedFiles) {
    const normalized = rawFile.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (isGuardrailFile(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      touchedGuardrails.push(normalized);
    }
  }
  touchedGuardrails.sort();

  const approved = input.prLabels.includes(APPROVED_GUARDRAIL_LABEL);
  const isPullRequest =
    input.eventName === "pull_request" || input.eventName === "pull_request_target";
  const shouldFail = isPullRequest && touchedGuardrails.length > 0 && !approved;

  if (touchedGuardrails.length === 0) {
    return {
      touchedGuardrails,
      approved,
      shouldFail: false,
      message: "No protected guardrail files modified.",
    };
  }
  if (shouldFail) {
    return {
      touchedGuardrails,
      approved,
      shouldFail: true,
      message: `Protected guardrail files modified (${String(touchedGuardrails.length)}). Apply the "${APPROVED_GUARDRAIL_LABEL}" label after explicit review.`,
    };
  }
  return {
    touchedGuardrails,
    approved,
    shouldFail: false,
    message: approved
      ? `Protected guardrail edits approved via "${APPROVED_GUARDRAIL_LABEL}" label.`
      : `Protected guardrail files modified on ${input.eventName || "local"} event (informational).`,
  };
}

/** Render a GitHub step summary markdown block for touched guardrail files. */
export function formatGuardrailSummary(
  result: GuardrailEvaluationResult,
  diffText: string,
): string {
  const lines: string[] = ["## Guardrail Diff Check", "", result.message];
  if (result.touchedGuardrails.length === 0) {
    return `${lines.join("\n")}\n`;
  }
  lines.push("", "### Modified Guardrail Files", "");
  for (const file of result.touchedGuardrails) {
    lines.push(`- \`${file}\``);
  }
  const trimmedDiff = diffText.trim();
  if (trimmedDiff.length > 0) {
    if (result.approved) {
      lines.push("", "### Exact Guardrail Diff", "", "```diff", trimmedDiff, "```");
    } else {
      lines.push(
        "",
        `Exact guardrail diff omitted from step summary for unapproved changes; inspect the PR diff directly before applying \`${APPROVED_GUARDRAIL_LABEL}\`.`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Parse NUL-delimited `git diff --name-only -z` output into literal relative paths. */
export function parseNullDelimitedPaths(raw: string): string[] {
  return raw.split("\0").filter((entry) => entry.length > 0);
}

const ZERO_SHA = /^0+$/;

/** Build a two-dot/three-dot git diff range from base/head SHAs, ignoring empty or all-zero SHAs. */
export function buildDiffRange(
  baseSha: string | undefined,
  headSha: string | undefined,
  eventName: string,
): string | null {
  const base = baseSha?.trim() ?? "";
  const head = headSha?.trim() ?? "";
  if (base.length === 0 || head.length === 0) return null;
  if (ZERO_SHA.test(base) || ZERO_SHA.test(head)) return null;
  return eventName === "push" ? `${base}..${head}` : `${base}...${head}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract `filename` and `previous_filename` entries from a GitHub REST API
 * `pulls/{number}/files` response (either a single array or a `--slurp` array of page arrays).
 */
export function parsePrFilesApiJson(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: unknown[] = [];
  for (const item of parsed as unknown[]) {
    if (Array.isArray(item)) {
      for (const sub of item as unknown[]) entries.push(sub);
    } else {
      entries.push(item);
    }
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (typeof entry["filename"] === "string" && entry["filename"].length > 0) {
      files.push(entry["filename"]);
    }
    if (typeof entry["previous_filename"] === "string" && entry["previous_filename"].length > 0) {
      files.push(entry["previous_filename"]);
    }
  }
  return files;
}

/* v8 ignore start */
function runGit(args: readonly string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function resolveDiffRange(env: NodeJS.ProcessEnv): string | null {
  const explicit = buildDiffRange(env["BASE_SHA"], env["HEAD_SHA"], env["GITHUB_EVENT_NAME"] ?? "");
  if (explicit) return explicit;
  try {
    runGit(["rev-parse", "--verify", "origin/main"]);
    return "origin/main...HEAD";
  } catch {
    return null;
  }
}

function runCli(): void {
  const eventName = process.env["GITHUB_EVENT_NAME"] ?? "";
  const prLabels = parsePrLabelsJson(process.env["PR_LABELS_JSON"]);
  const changedFilesPath = process.env["CHANGED_FILES_PATH"]?.trim();
  const range = changedFilesPath ? null : resolveDiffRange(process.env);
  const changedFiles = changedFilesPath
    ? parsePrFilesApiJson(fs.readFileSync(changedFilesPath, "utf8"))
    : range
      ? parseNullDelimitedPaths(runGit(["diff", "--name-only", "--no-renames", "-z", range]))
      : [];

  const result = evaluateGuardrailChanges({ eventName, changedFiles, prLabels });
  const diffText =
    range && result.touchedGuardrails.length > 0
      ? runGit(["diff", "--no-renames", range, "--", ...result.touchedGuardrails])
      : "";

  const summary = formatGuardrailSummary(result, diffText);
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath) {
    fs.appendFileSync(summaryPath, summary, "utf8");
  }

  console.log(result.message);
  if (result.shouldFail) {
    console.error(`::error::${result.message}`);
    process.exitCode = 1;
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  runCli();
}
/* v8 ignore stop */
