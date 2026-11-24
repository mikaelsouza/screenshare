import { resolve } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, type ViteUserConfig } from "vitest/config";

/**
 * Runs the Durable Object tests inside workerd itself, so hibernation, WebSocket
 * attachments and getWebSockets() behave exactly as they will in production.
 * A mock would prove nothing about the parts most likely to break.
 */
const config: ViteUserConfig = defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/worker/**/*.test.ts"],
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: [
        "worker/index.ts",
        "worker/room.ts",
        "worker/room-actions.ts",
        "worker/room-lifecycle.ts",
        "worker/room-membership.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 92,
        branches: 86,
        functions: 95,
        lines: 94,
      },
    },
  },
  resolve: {
    alias: {
      "@shared": resolve(import.meta.dirname, "shared"),
      "@src": resolve(import.meta.dirname, "src"),
    },
  },
});

export default config;
