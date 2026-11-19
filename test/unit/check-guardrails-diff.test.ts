import { describe, expect, it } from "vitest";
import {
  APPROVED_GUARDRAIL_LABEL,
  evaluateGuardrailChanges,
  formatGuardrailSummary,
  isGuardrailFile,
  parsePrLabelsJson,
} from "../../scripts/check-guardrails-diff";

describe("check-guardrails-diff", () => {
  describe("isGuardrailFile", () => {
    it("matches every exact protected guardrail file", () => {
      const exactFiles = [
        "AGENTS.md",
        ".oxlintrc.json",
        "stryker.config.json",
        "vitest.config.ts",
        "vitest.workers.config.ts",
        "electron-builder.json",
        "shared/protocol.ts",
        "worker/index.ts",
        "scripts/check-guardrails-diff.ts",
      ];
      for (const file of exactFiles) {
        expect(isGuardrailFile(file)).toBe(true);
        expect(isGuardrailFile(`./${file}`)).toBe(true);
      }
    });

    it("matches protected directory prefixes including Windows separators", () => {
      expect(isGuardrailFile("test/formal/encoding-invariants.test.ts")).toBe(true);
      expect(isGuardrailFile("test\\formal\\room-stateful.test.ts")).toBe(true);
      expect(isGuardrailFile(".github/workflows/ci.yml")).toBe(true);
      expect(isGuardrailFile(".github/CODEOWNERS")).toBe(true);
    });

    it("ignores non-guardrail source, test, and empty paths", () => {
      expect(isGuardrailFile("")).toBe(false);
      expect(isGuardrailFile("   ")).toBe(false);
      expect(isGuardrailFile("src/mesh.ts")).toBe(false);
      expect(isGuardrailFile("worker/room.ts")).toBe(false);
      expect(isGuardrailFile("test/unit/mesh.test.ts")).toBe(false);
      expect(isGuardrailFile("README.md")).toBe(false);
    });
  });

  describe("parsePrLabelsJson", () => {
    it("parses valid JSON arrays of strings and filters non-strings", () => {
      expect(parsePrLabelsJson('["bug", "approved-guardrail-change", 123, null]')).toEqual([
        "bug",
        "approved-guardrail-change",
      ]);
    });

    it("returns an empty array for undefined, blank, non-array, or invalid JSON", () => {
      expect(parsePrLabelsJson(undefined)).toEqual([]);
      expect(parsePrLabelsJson("   ")).toEqual([]);
      expect(parsePrLabelsJson('{"label": true}')).toEqual([]);
      expect(parsePrLabelsJson("{not-json")).toEqual([]);
    });
  });

  describe("evaluateGuardrailChanges", () => {
    it("passes when no protected guardrail files are changed", () => {
      const result = evaluateGuardrailChanges({
        eventName: "pull_request",
        changedFiles: ["src/mesh.ts", "test/unit/mesh.test.ts"],
        prLabels: [],
      });
      expect(result.touchedGuardrails).toEqual([]);
      expect(result.approved).toBe(false);
      expect(result.shouldFail).toBe(false);
      expect(result.message).toContain("No protected guardrail files");
    });

    it("fails on pull_request when guardrail files are modified without approval label", () => {
      const result = evaluateGuardrailChanges({
        eventName: "pull_request",
        changedFiles: [
          "worker/index.ts",
          "./worker/index.ts",
          ".oxlintrc.json",
          "src/main.ts",
        ],
        prLabels: ["enhancement"],
      });
      expect(result.touchedGuardrails).toEqual([".oxlintrc.json", "worker/index.ts"]);
      expect(result.approved).toBe(false);
      expect(result.shouldFail).toBe(true);
      expect(result.message).toContain(APPROVED_GUARDRAIL_LABEL);
    });

    it("passes on pull_request when approved-guardrail-change label is present", () => {
      const result = evaluateGuardrailChanges({
        eventName: "pull_request",
        changedFiles: ["stryker.config.json", "test/formal/ui-invariants.test.ts"],
        prLabels: ["documentation", APPROVED_GUARDRAIL_LABEL],
      });
      expect(result.touchedGuardrails).toEqual([
        "stryker.config.json",
        "test/formal/ui-invariants.test.ts",
      ]);
      expect(result.approved).toBe(true);
      expect(result.shouldFail).toBe(false);
      expect(result.message).toContain("approved");
    });

    it("stays informational on push or local events even without the label", () => {
      const pushResult = evaluateGuardrailChanges({
        eventName: "push",
        changedFiles: ["AGENTS.md"],
        prLabels: [],
      });
      expect(pushResult.shouldFail).toBe(false);
      expect(pushResult.message).toContain("push");

      const localResult = evaluateGuardrailChanges({
        eventName: "",
        changedFiles: ["AGENTS.md"],
        prLabels: [],
      });
      expect(localResult.shouldFail).toBe(false);
      expect(localResult.message).toContain("local");
    });
  });

  describe("formatGuardrailSummary", () => {
    it("renders concise markdown when no guardrails were touched", () => {
      const result = evaluateGuardrailChanges({
        eventName: "pull_request",
        changedFiles: ["src/mesh.ts"],
        prLabels: [],
      });
      const md = formatGuardrailSummary(result, "");
      expect(md).toContain("## Guardrail Diff Check");
      expect(md).not.toContain("### Modified Guardrail Files");
    });

    it("lists modified guardrail files and embeds diff when non-empty", () => {
      const result = evaluateGuardrailChanges({
        eventName: "pull_request",
        changedFiles: [".oxlintrc.json"],
        prLabels: [],
      });
      const md = formatGuardrailSummary(result, "diff --git a/.oxlintrc.json b/.oxlintrc.json\n+rule");
      expect(md).toContain("- `.oxlintrc.json`");
      expect(md).toContain("```diff");
      expect(md).toContain("+rule");

      const mdNoDiff = formatGuardrailSummary(result, "   ");
      expect(mdNoDiff).toContain("- `.oxlintrc.json`");
      expect(mdNoDiff).not.toContain("```diff");
    });
  });
});
