import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseNullDelimitedPaths, resolveMutateFiles, selectChangedMutateFiles } from "../../scripts/run-stryker-ci";

describe("run-stryker-ci", () => {
  it("resolves stryker.config.json mutate globs while respecting exclusions", () => {
    const configPath = path.resolve(process.cwd(), "stryker.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { mutate: string[] };
    const files = resolveMutateFiles(config.mutate);

    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("worker/room-chat.ts");
    expect(files).toContain("src/mesh.ts");
    expect(files).toContain("electron/security.ts");
    expect(files).not.toContain("src/main.ts");
    expect(files).not.toContain("src/vite-env.d.ts");
    expect(files).not.toContain("worker/room.ts");
    expect(files).not.toContain("electron/main.ts");
  });

  it("intersects changed files with eligible mutate files deterministically", () => {
    const eligible = ["electron/security.ts", "src/mesh.ts", "worker/room-chat.ts"];
    const changed = [
      "README.md",
      "src\\mesh.ts",
      "src/main.ts",
      "electron/security.ts",
      "electron/security.ts",
    ];

    expect(selectChangedMutateFiles(eligible, changed)).toEqual([
      "electron/security.ts",
      "src/mesh.ts",
    ]);
    expect(selectChangedMutateFiles(eligible, ["README.md", "docs/notes.md"])).toEqual([]);
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
});
