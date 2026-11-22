import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMutateFiles, selectRandomSubset } from "../../scripts/run-stryker-ci";

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

  it("selects a unique sorted subset bounded by sampleSize and file count", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"];
    let seed = 0;
    const deterministicRand = (max: number): number => {
      seed = (seed * 7 + 3) % max;
      return seed;
    };

    const subset = selectRandomSubset(files, 4, deterministicRand);
    expect(subset).toHaveLength(4);
    expect(new Set(subset).size).toBe(4);
    expect(subset).toEqual([...subset].sort());

    const capped = selectRandomSubset(files, 100, deterministicRand);
    expect(capped).toEqual(files);

    const minOne = selectRandomSubset(files, 0, deterministicRand);
    expect(minOne).toHaveLength(1);
  });
});
