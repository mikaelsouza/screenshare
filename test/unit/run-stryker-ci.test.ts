import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatExcludedSummary,
  parseNullDelimitedPaths,
  readMutatePatterns,
  resolveBaseRef,
  resolveMutateFiles,
  selectChangedMutateFiles,
  selectExcludedMutateFiles,
} from "../../scripts/run-stryker-ci";

describe("run-stryker-ci", () => {
  const tempDirs: string[] = [];
  const originalBaseRef = process.env["STRYKER_BASE_REF"];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "run-stryker-ci-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    if (originalBaseRef === undefined) {
      delete process.env["STRYKER_BASE_REF"];
    } else {
      process.env["STRYKER_BASE_REF"] = originalBaseRef;
    }
  });

  describe("readMutatePatterns", () => {
    it("reads string mutate patterns from a valid config and filters non-string entries", () => {
      const dir = makeTempDir();
      const configPath = path.join(dir, "stryker.json");
      writeFileSync(
        configPath,
        JSON.stringify({ mutate: ["src/**/*.ts", 42, null, "!**/*.d.ts", true] }),
        "utf8",
      );

      expect(readMutatePatterns(configPath)).toEqual(["src/**/*.ts", "!**/*.d.ts"]);
    });

    it("returns an empty array when mutate is missing, non-array, or JSON is non-object", () => {
      const dir = makeTempDir();
      const missingKey = path.join(dir, "missing.json");
      const nonArray = path.join(dir, "non-array.json");
      const nullJson = path.join(dir, "null.json");
      const primitiveJson = path.join(dir, "primitive.json");

      writeFileSync(missingKey, JSON.stringify({ thresholds: { break: 85 } }), "utf8");
      writeFileSync(nonArray, JSON.stringify({ mutate: "src/**/*.ts" }), "utf8");
      writeFileSync(nullJson, "null", "utf8");
      writeFileSync(primitiveJson, "42", "utf8");

      expect(readMutatePatterns(missingKey)).toEqual([]);
      expect(readMutatePatterns(nonArray)).toEqual([]);
      expect(readMutatePatterns(nullJson)).toEqual([]);
      expect(readMutatePatterns(primitiveJson)).toEqual([]);
    });
  });

  describe("resolveBaseRef", () => {
    it("returns trimmed STRYKER_BASE_REF when set and non-zero", () => {
      process.env["STRYKER_BASE_REF"] = "  origin/release  ";
      expect(resolveBaseRef()).toBe("origin/release");

      process.env["STRYKER_BASE_REF"] = "0abc0";
      expect(resolveBaseRef()).toBe("0abc0");
    });

    it("falls back to origin/main when unset, blank, or all-zero SHA", () => {
      delete process.env["STRYKER_BASE_REF"];
      expect(resolveBaseRef()).toBe("origin/main");

      process.env["STRYKER_BASE_REF"] = "   ";
      expect(resolveBaseRef()).toBe("origin/main");

      process.env["STRYKER_BASE_REF"] = "0000000000000000000000000000000000000000";
      expect(resolveBaseRef()).toBe("origin/main");
    });
  });

  describe("resolveMutateFiles", () => {
    it("resolves stryker.config.json mutate globs while respecting exclusions", () => {
      const configPath = path.resolve(process.cwd(), "stryker.config.json");
      const patterns = readMutatePatterns(configPath);
      const files = resolveMutateFiles(patterns);

      expect(files.length).toBeGreaterThan(20);
      expect(files).toContain("worker/room-chat.ts");
      expect(files).toContain("src/mesh.ts");
      expect(files).toContain("electron/security.ts");
      expect(files).toContain("scripts/run-stryker-ci.ts");
      expect(files).not.toContain("src/main.ts");
      expect(files).not.toContain("src/vite-env.d.ts");
      expect(files).not.toContain("worker/room.ts");
      expect(files).not.toContain("electron/main.ts");
    });

    it("filters exclude globs without traversing node_modules and normalizes separators", () => {
      const dir = makeTempDir();
      mkdirSync(path.join(dir, "src", "views"), { recursive: true });
      mkdirSync(path.join(dir, "sub"), { recursive: true });
      mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });

      writeFileSync(path.join(dir, "src", "app.ts"), "export const a = 1;\n", "utf8");
      writeFileSync(path.join(dir, "src", "types.d.ts"), "export {};\n", "utf8");
      writeFileSync(path.join(dir, "src", "views", "dom.ts"), "export {};\n", "utf8");
      writeFileSync(path.join(dir, "sub", "kept.ts"), "export const b = 2;\n", "utf8");
      writeFileSync(path.join(dir, "sub", "excluded.ts"), "export const c = 3;\n", "utf8");
      writeFileSync(path.join(dir, "node_modules", "pkg", "index.ts"), "export {};\n", "utf8");
      writeFileSync(path.join(dir, "node_modules", "pkg", "index.d.ts"), "export {};\n", "utf8");

      const resolved = resolveMutateFiles(
        ["src/**/*.ts", "sub\\**\\*.ts", "!**/*.d.ts", "!src/views/**/*.ts", "!sub\\excluded.ts"],
        dir,
      );

      expect(resolved).toEqual(["src/app.ts", "sub/kept.ts"]);
      expect(resolveMutateFiles(["!**/*.d.ts"], dir)).toEqual([]);
    });
  });

  describe("selectChangedMutateFiles", () => {
    it("intersects changed files with eligible mutate files deterministically", () => {
      const eligible = ["electron\\security.ts", "src/mesh.ts", "worker/room-chat.ts"];
      const changed = [
        "README.md",
        "   ",
        "src\\mesh.ts",
        "src/main.ts",
        "  electron/security.ts  ",
        "electron/security.ts",
      ];

      expect(selectChangedMutateFiles(eligible, changed)).toEqual([
        "electron/security.ts",
        "src/mesh.ts",
      ]);
      expect(selectChangedMutateFiles(eligible, ["README.md", "docs/notes.md"])).toEqual([]);
    });
  });

  it("parses NUL-delimited git paths including non-ASCII filenames without quoting or trimming", () => {
    const raw = "src/café.ts\0electron/security.ts\0\0";
    const parsed = parseNullDelimitedPaths(raw);
    expect(parsed).toEqual(["src/café.ts", "electron/security.ts"]);
    expect(selectChangedMutateFiles(["src/café.ts", "electron/security.ts"], parsed)).toEqual([
      "electron/security.ts",
      "src/café.ts",
    ]);
  });

  describe("selectExcludedMutateFiles", () => {
    it("returns unique sorted runtime files excluded from mutate scope and ignores non-runtime or declaration files", () => {
      const eligible = ["electron\\security.ts", "src/mesh.ts"];
      const changed = [
        "src/mesh.ts",
        "src\\main.ts",
        "src/main.ts",
        "src/views/Badge.tsx",
        "worker/room.ts",
        "shared/protocol.ts",
        "electron/main.ts",
        "electron/preload.cts",
        "scripts/custom.ts",
        "scripts/mod.mts",
        "src/vite-env.d.ts",
        "electron/types.d.cts",
        "scripts/types.d.mts",
        "test/unit/mesh.test.ts",
        "README.md",
        ".github/workflows/ci.yml",
        "src/not-ts.css",
      ];

      expect(selectExcludedMutateFiles(eligible, changed)).toEqual([
        "electron/main.ts",
        "electron/preload.cts",
        "scripts/custom.ts",
        "scripts/mod.mts",
        "shared/protocol.ts",
        "src/main.ts",
        "src/views/Badge.tsx",
        "worker/room.ts",
      ]);
      expect(
        selectExcludedMutateFiles(eligible, [
          "test/unit/foo.test.ts",
          "src/vite-env.d.ts",
          "electron/types.d.cts",
          "scripts/types.d.mts",
        ]),
      ).toEqual([]);
    });
  });

  describe("formatExcludedSummary", () => {
    it("formats step summaries with and without skipped excluded runtime files", () => {
      const withExcluded = formatExcludedSummary(["src/mesh.ts"], ["worker/room.ts", "src/main.ts"], "origin/main");
      expect(withExcluded).toBe(
        [
          "### Mutation Testing (Stryker vs `origin/main`)",
          "- Mutated eligible files (1): `src/mesh.ts`",
          "- Skipped excluded runtime files (2): `worker/room.ts`, `src/main.ts`",
          "",
        ].join("\n"),
      );

      const withoutExcluded = formatExcludedSummary([], [], "origin/release");
      expect(withoutExcluded).toBe(
        [
          "### Mutation Testing (Stryker vs `origin/release`)",
          "- Mutated eligible files (0): _none_",
          "",
        ].join("\n"),
      );
    });
  });
});
