import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FUSE_STATE_DISABLE,
  FUSE_STATE_ENABLE,
  FUSE_STATE_INHERIT,
  FUSE_STATE_REMOVED,
  FUSE_V1_ENABLE_ASAR_INTEGRITY,
  FUSE_V1_ENABLE_COOKIE_ENCRYPTION,
  FUSE_V1_ENABLE_NODE_CLI_INSPECT,
  FUSE_V1_ENABLE_NODE_OPTIONS_ENV,
  FUSE_V1_ONLY_LOAD_APP_FROM_ASAR,
  FUSE_V1_RUN_AS_NODE,
  FUSE_V1_VERSION,
  REQUIRED_ELECTRON_FUSES,
  verifyElectronBuilderFuseConfig,
  verifyFuseWire,
  verifyPackagedResourceEntries,
} from "../../scripts/smoke-test-packaged";

describe("Electron packaged fuse & ASAR integrity verification", () => {
  it("accepts the locked 6-fuse wire configuration", () => {
    const lockedWire: Partial<Record<number, number>> & { version: string } = {
      version: FUSE_V1_VERSION,
      [FUSE_V1_RUN_AS_NODE]: FUSE_STATE_DISABLE,
      [FUSE_V1_ENABLE_COOKIE_ENCRYPTION]: FUSE_STATE_ENABLE,
      [FUSE_V1_ENABLE_NODE_OPTIONS_ENV]: FUSE_STATE_DISABLE,
      [FUSE_V1_ENABLE_NODE_CLI_INSPECT]: FUSE_STATE_DISABLE,
      [FUSE_V1_ENABLE_ASAR_INTEGRITY]: FUSE_STATE_ENABLE,
      [FUSE_V1_ONLY_LOAD_APP_FROM_ASAR]: FUSE_STATE_ENABLE,
    };

    expect(verifyFuseWire(lockedWire)).toEqual({ ok: true, failures: [] });
  });

  it("rejects any flipped, inherited, removed, missing, or wrong-version fuse", () => {
    const baseWire: Partial<Record<number, number>> & { version: string } = {
      version: FUSE_V1_VERSION,
      [FUSE_V1_RUN_AS_NODE]: FUSE_STATE_DISABLE,
      [FUSE_V1_ENABLE_COOKIE_ENCRYPTION]: FUSE_STATE_ENABLE,
      [FUSE_V1_ENABLE_NODE_OPTIONS_ENV]: FUSE_STATE_DISABLE,
      [FUSE_V1_ENABLE_NODE_CLI_INSPECT]: FUSE_STATE_DISABLE,
      [FUSE_V1_ENABLE_ASAR_INTEGRITY]: FUSE_STATE_ENABLE,
      [FUSE_V1_ONLY_LOAD_APP_FROM_ASAR]: FUSE_STATE_ENABLE,
    };

    for (const spec of REQUIRED_ELECTRON_FUSES) {
      const flipped = {
        ...baseWire,
        [spec.option]: spec.expected ? FUSE_STATE_DISABLE : FUSE_STATE_ENABLE,
      };
      const res = verifyFuseWire(flipped);
      expect(res.ok).toBe(false);
      expect(res.failures.some((f) => f.includes(spec.name) && f.includes(spec.expected ? "ENABLE" : "DISABLE"))).toBe(
        true,
      );

      const inherited = { ...baseWire, [spec.option]: FUSE_STATE_INHERIT };
      expect(verifyFuseWire(inherited).ok).toBe(false);

      const removed = { ...baseWire, [spec.option]: FUSE_STATE_REMOVED };
      expect(verifyFuseWire(removed).ok).toBe(false);
    }

    const wrongVer = verifyFuseWire({ ...baseWire, version: "2" });
    expect(wrongVer.ok).toBe(false);
    expect(wrongVer.failures[0]).toContain("Expected fuse wire version");
    const { version: _omitted, ...withoutVersion } = baseWire;
    expect(verifyFuseWire(withoutVersion).ok).toBe(false);
    expect(verifyFuseWire({}).ok).toBe(false);
  });

  it("validates packaged resources contain app.asar without loose app directory", () => {
    expect(verifyPackagedResourceEntries(["app.asar", "app.asar.unpacked", "app-update.yml"])).toEqual({
      ok: true,
      failures: [],
    });
    const missingAsar = verifyPackagedResourceEntries(["app-update.yml"]);
    expect(missingAsar.ok).toBe(false);
    expect(missingAsar.failures[0]).toContain("app.asar");
    const looseApp = verifyPackagedResourceEntries(["app.asar", "app"]);
    expect(looseApp.ok).toBe(false);
    expect(looseApp.failures[0]).toContain("resources/app");
  });

  it("validates electron-builder.json enables asar and burns all 6 security fuses", () => {
    const builderPath = path.resolve(import.meta.dirname, "../../electron-builder.json");
    const parsed: unknown = JSON.parse(fs.readFileSync(builderPath, "utf8"));
    expect(verifyElectronBuilderFuseConfig(parsed)).toEqual({ ok: true, failures: [] });

    const nullRoot = verifyElectronBuilderFuseConfig(null);
    expect(nullRoot.ok).toBe(false);
    expect(nullRoot.failures[0]).toContain("root must be an object");
    expect(verifyElectronBuilderFuseConfig("not-an-object").ok).toBe(false);
    const missingFuses = verifyElectronBuilderFuseConfig({});
    expect(missingFuses.ok).toBe(false);
    expect(missingFuses.failures[0]).toContain("missing electronFuses");
    expect(verifyElectronBuilderFuseConfig({ electronFuses: null }).ok).toBe(false);
    const noAsar = verifyElectronBuilderFuseConfig({
      asar: false,
      electronFuses: {
        runAsNode: false,
        enableCookieEncryption: true,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
        enableEmbeddedAsarIntegrityValidation: true,
        onlyLoadAppFromAsar: true,
      },
    });
    expect(noAsar.ok).toBe(false);
    expect(noAsar.failures[0]).toContain("asar: true");
    const badFuse = verifyElectronBuilderFuseConfig({
      asar: true,
      electronFuses: {
        runAsNode: true,
        enableCookieEncryption: true,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
        enableEmbeddedAsarIntegrityValidation: true,
        onlyLoadAppFromAsar: true,
      },
    });
    expect(badFuse.ok).toBe(false);
    expect(badFuse.failures[0]).toContain("electronFuses.runAsNode");
  });
});
