import { resolve } from "node:path";
import { defineConfig, type ViteUserConfig } from "vitest/config";

/** Pure-logic tests. The Durable Object has its own config (vitest.workers.config.ts). */
const config: ViteUserConfig = defineConfig({
  test: {
    include: [
      "test/unit/**/*.test.ts",
      "test/formal/**/*.test.ts",
      "test/fuzz/**/*.test.ts",
    ],
    testTimeout: 15000,
    environment: "node",
    coverage: {
      provider: "v8",
      include: [
        "shared/**/*.ts",
        "src/**/*.ts",
        "electron/**/*.ts",
        "worker/**/*.ts",
        "scripts/check-guardrails-diff.ts",
        "scripts/run-stryker-ci.ts",
        "scripts/smoke-test-packaged.ts",
      ],
      exclude: [
        "**/*.d.ts",
        "src/main.ts",
        "src/views/**/*.ts",
        "src/platform/types.ts",
        "electron/main.ts",
        "electron/preload.cts",
        "worker/index.ts",
        "worker/room.ts",
        "worker/room-actions.ts",
        "worker/room-lifecycle.ts",
        "worker/room-membership.ts",
      ],
      reporter: ["text", "json", "html", "lcov"],
      thresholds: {
        statements: 93,
        branches: 88,
        functions: 92,
        lines: 94,
      },
    },
  },
  resolve: {
    alias: {
      "@shared": resolve(import.meta.dirname, "shared"),
      "@src": resolve(import.meta.dirname, "src"),
      "@worker": resolve(import.meta.dirname, "worker"),
      "@electron": resolve(import.meta.dirname, "electron"),
    },
  },
});

export default config;
