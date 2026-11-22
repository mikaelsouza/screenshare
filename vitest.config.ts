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
        "electron/config.ts",
        "electron/follow/**/*.ts",
        "electron/audio/**/*.ts",
        "electron/picker.ts",
        "electron/updater.ts",
        "scripts/check-guardrails-diff.ts",
        "scripts/smoke-test-packaged.ts",
        "worker/ipkey.ts",
        "worker/ratelimit.ts",
        "worker/room-chat.ts",
        "worker/room-crypto.ts",
        "worker/room-models.ts",
        "worker/room-policy.ts",
        "worker/upgrade.ts",
      ],
      exclude: ["**/*.d.ts", "src/main.ts", "src/views/**/*.ts", "src/platform/types.ts"],
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
