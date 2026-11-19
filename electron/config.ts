/**
 * Centralized Electron runtime configuration and trust boundary.
 *
 * Packaged builds ignore all environment and CLI overrides unconditionally so a
 * local environment variable cannot redirect a packaged binary carrying native
 * capture IPC (`preload.cts`) to an untrusted origin or alter its profile path.
 */

export const DEFAULT_REMOTE_APP_URL = "https://screenshare.webmikas.com";
const DEFAULT_ALLOWED_ORIGIN: string = new URL(DEFAULT_REMOTE_APP_URL).origin;

export interface ElectronConfigInput {
  isPackaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
  argv: readonly string[];
}

export interface ResolvedElectronConfig {
  isDev: boolean;
  isSmokeTest: boolean;
  remoteAppUrl: string;
  targetUrl: string;
  allowedAppOrigin: string;
  devServerUrl: string | undefined;
  smokeUserDataDir: string | undefined;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseAllowedHttpUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || hasControlChar(raw) || raw.includes("\\")) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username.length > 0 || parsed.password.length > 0) return undefined;
  return parsed.href;
}

function parseSmokeUserDataDir(raw: string | undefined): string | undefined {
  if (raw === undefined || hasControlChar(raw)) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

/**
 * Resolve runtime configuration from packaging state, environment variables, and CLI flags.
 */
export function resolveElectronConfig(input: ElectronConfigInput): ResolvedElectronConfig {
  if (input.isPackaged) {
    return {
      isDev: false,
      isSmokeTest: false,
      remoteAppUrl: DEFAULT_REMOTE_APP_URL,
      targetUrl: DEFAULT_REMOTE_APP_URL,
      allowedAppOrigin: DEFAULT_ALLOWED_ORIGIN,
      devServerUrl: undefined,
      smokeUserDataDir: undefined,
    };
  }

  const isDev =
    input.env["ELECTRON_DEV"] === "1" || input.env["NODE_ENV"] === "development";
  const isSmokeTest =
    input.argv.includes("--smoke-test") || input.env["SMOKE_TEST"] === "1";
  const remoteAppUrl =
    parseAllowedHttpUrl(input.env["SCREENSHARE_URL"]) ?? DEFAULT_REMOTE_APP_URL;
  const devServerUrl = isDev
    ? parseAllowedHttpUrl(input.env["VITE_DEV_SERVER_URL"])
    : undefined;
  const targetUrl = devServerUrl ?? remoteAppUrl;
  const allowedAppOrigin = new URL(targetUrl).origin;
  const smokeUserDataDir = isSmokeTest
    ? parseSmokeUserDataDir(input.env["SMOKE_USER_DATA_DIR"])
    : undefined;

  return {
    isDev,
    isSmokeTest,
    remoteAppUrl,
    targetUrl,
    allowedAppOrigin,
    devServerUrl,
    smokeUserDataDir,
  };
}

/**
 * Convenience wrapper reading `process.env` and `process.argv` inside the sole
 * permitted Electron env-access boundary.
 */
export function resolveProcessElectronConfig(isPackaged: boolean): ResolvedElectronConfig {
  return resolveElectronConfig({
    isPackaged,
    env: process.env,
    argv: process.argv,
  });
}
