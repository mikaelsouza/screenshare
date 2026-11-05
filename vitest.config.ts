import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/** Pure-logic tests. The Durable Object has its own config (vitest.workers.config.ts). */
export default defineConfig({
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
      include: ["shared/**/*.ts", "src/**/*.ts", "worker/ratelimit.ts"],
      exclude: ["src/main.ts", "src/platform/types.ts"],
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
