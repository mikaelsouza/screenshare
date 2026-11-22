/**
 * Pure security and trust-boundary helpers for the Electron main process.
 *
 * Kept free of Electron runtime imports so every navigation, IPC origin,
 * permission, and HTML-escaping invariant can be unit-tested directly.
 */

const ALLOWED_EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set([
  "https:",
  "http:",
  "mailto:",
]);

const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "display-capture",
  "media",
  "clipboard-sanitized-write",
]);

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Returns true only when `url` parses cleanly as an `https:`, `http:`, or
 * `mailto:` URL (case-insensitive per WHATWG URL parsing) without ASCII
 * control characters.
 */
export function isAllowedExternalUrl(url: string | undefined): boolean {
  if (!url || hasControlChar(url)) return false;
  try {
    const parsed = new URL(url);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Fail-closed origin check for Electron frames, IPC `senderFrame.url`,
 * display-media `request.frame?.url`, and permission requesting origins.
 */
export function isTrustedFrameUrl(
  url: string | undefined,
  trustedOrigin: string | null,
): boolean {
  if (!url || !trustedOrigin || trustedOrigin === "null" || hasControlChar(url)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.origin !== "null" &&
      parsed.origin === trustedOrigin
    );
  } catch {
    return false;
  }
}

export type NavigationDecision = "allow" | "open-external" | "block";

/**
 * Decides how `will-navigate` should handle a navigation attempt:
 * - `"allow"`: same origin as `trustedOrigin` (continue in-app navigation).
 * - `"open-external"`: cross-origin with an allowlisted external scheme.
 * - `"block"`: malformed URL, control characters, or disallowed scheme.
 */
export function evaluateNavigation(
  url: string,
  trustedOrigin: string | null,
): NavigationDecision {
  if (!url || !trustedOrigin || trustedOrigin === "null" || hasControlChar(url)) {
    return "block";
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "block";
  }
  if (
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    parsed.origin !== "null" &&
    parsed.origin === trustedOrigin
  ) {
    return "allow";
  }
  return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol) ? "open-external" : "block";
}

/**
 * Fail-closed permission gate for `setPermissionRequestHandler` and
 * `setPermissionCheckHandler`.
 */
export function isAllowedPermission(
  permission: string,
  requestingUrl: string | undefined,
  trustedOrigin: string | null,
): boolean {
  return (
    ALLOWED_PERMISSIONS.has(permission) &&
    isTrustedFrameUrl(requestingUrl, trustedOrigin)
  );
}

/**
 * Escapes HTML special characters for safe interpolation into static HTML.
 */
export function escapeHtml(value: string): string {
  return value.replaceAll(/[&<>"']/g, (ch: string): string => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}

/**
 * Builds the `data:text/html` offline fallback page URL with all interpolated
 * values HTML-escaped.
 */
export function buildOfflinePageUrl(url: string, description: string): string {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  const safeHost = escapeHtml(host);
  const safeDescription = escapeHtml(description);
  const html = `<!doctype html><meta charset="utf-8"><title>Screenshare</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#121214;color:#e6e6e6;font:15px system-ui,sans-serif">
<div style="text-align:center;max-width:460px">
<h2 style="font-weight:600">Can't reach Screenshare</h2>
<p>Couldn't load <b>${safeHost}</b> (${safeDescription}).</p>
<p style="opacity:.7">Check your internet connection. Retrying automatically…</p>
</div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
