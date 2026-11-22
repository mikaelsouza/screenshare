import { describe, expect, it } from "vitest";
import {
  buildOfflinePageUrl,
  escapeHtml,
  evaluateNavigation,
  isAllowedExternalUrl,
  isAllowedPermission,
  isTrustedFrameUrl,
} from "@electron/security";

const TRUSTED_ORIGIN = "https://screenshare.webmikas.com";

describe("electron/security", () => {
  describe("isAllowedExternalUrl", () => {
    it("allows https, http, and mailto URLs including mixed/uppercase schemes", () => {
      const allowed = [
        "https://example.com",
        "https://example.com/path?q=1#hash",
        "HTTPS://EXAMPLE.COM/UPPER",
        "HtTpS://mixed.example/test",
        "http://example.com:8080/page",
        "HTTP://LOCALHOST:5173",
        "mailto:support@example.com",
        "MAILTO:Support@Example.com?subject=Help",
      ];
      for (const url of allowed) {
        expect({ url, allowed: isAllowedExternalUrl(url) }).toEqual({ url, allowed: true });
      }
    });

    it("rejects dangerous OS/shell schemes, script schemes, malformed URLs, and control chars", () => {
      const blocked: Array<string | undefined> = [
        undefined,
        "",
        "   ",
        "not a url",
        "://missing-scheme",
        "https://[::1",
        "file:///C:/Windows/System32/cmd.exe",
        "FILE:///etc/passwd",
        "smb://attacker.example/share/payload.exe",
        "SMB://192.168.1.10/share",
        "ms-msdt:/id PCWDiagnostic /skip force",
        "MS-MSDT:/id PCWDiagnostic",
        "ms-officecmd:ofe|u|https://evil.example/doc.docx",
        "search-ms:query=test&crumb=location:\\\\evil\\share",
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "vbscript:msgbox(1)",
        "data:text/html,<script>alert(1)</script>",
        "about:blank",
        "blob:https://screenshare.webmikas.com/550e8400-e29b-41d4-a716-446655440000",
        "ftp://files.example.com/archive.zip",
        "chrome://settings",
        "devtools://devtools/bundled/inspector.html",
        "ht\ttps://example.com",
        "https://example.com/\r\nX-Injected: 1",
        "https://example.com/\0null",
      ];
      for (const url of blocked) {
        expect({ url, allowed: isAllowedExternalUrl(url) }).toEqual({ url, allowed: false });
      }
    });
  });

  describe("evaluateNavigation", () => {
    it("allows same-origin navigation to the trusted origin", () => {
      expect(evaluateNavigation("https://screenshare.webmikas.com/", TRUSTED_ORIGIN)).toBe("allow");
      expect(
        evaluateNavigation("https://screenshare.webmikas.com/room/abc?x=1#top", TRUSTED_ORIGIN),
      ).toBe("allow");
      expect(evaluateNavigation("HTTPS://SCREENSHARE.WEBMIKAS.COM/app", TRUSTED_ORIGIN)).toBe(
        "allow",
      );
    });

    it("routes cross-origin https, http, and mailto navigations to open-external", () => {
      const external = [
        "https://other.example/docs",
        "HTTPS://OTHER.EXAMPLE/DOCS",
        "http://screenshare.webmikas.com/",
        "https://sub.screenshare.webmikas.com/",
        "https://screenshare.webmikas.com:8443/",
        "mailto:help@webmikas.com",
        "MAILTO:help@webmikas.com",
      ];
      for (const url of external) {
        expect({ url, decision: evaluateNavigation(url, TRUSTED_ORIGIN) }).toEqual({
          url,
          decision: "open-external",
        });
      }
    });

    it("blocks disallowed schemes, blob spoofing, malformed URLs, and missing trustedOrigin", () => {
      const blocked = [
        "",
        "not-a-valid-url",
        "http://[::1",
        "file:///C:/Windows/win.ini",
        "smb://evil.example/share",
        "ms-msdt:/id PCWDiagnostic",
        "javascript:alert(1)",
        "data:text/html,<h1>phish</h1>",
        "blob:https://screenshare.webmikas.com/550e8400-e29b-41d4-a716-446655440000",
        "about:blank",
        "https://screenshare.webmikas.com/\nnewline",
      ];
      for (const url of blocked) {
        expect({ url, decision: evaluateNavigation(url, TRUSTED_ORIGIN) }).toEqual({
          url,
          decision: "block",
        });
      }

      expect(evaluateNavigation("https://screenshare.webmikas.com/", null)).toBe("block");
      expect(evaluateNavigation("https://screenshare.webmikas.com/", "")).toBe("block");
      expect(evaluateNavigation("data:text/html,hi", "null")).toBe("block");
    });
  });

  describe("isTrustedFrameUrl", () => {
    it("accepts only http/https URLs matching trustedOrigin", () => {
      expect(isTrustedFrameUrl("https://screenshare.webmikas.com/", TRUSTED_ORIGIN)).toBe(true);
      expect(isTrustedFrameUrl("https://screenshare.webmikas.com/room/123", TRUSTED_ORIGIN)).toBe(
        true,
      );
      expect(isTrustedFrameUrl("HTTPS://SCREENSHARE.WEBMIKAS.COM/path", TRUSTED_ORIGIN)).toBe(true);
      expect(isTrustedFrameUrl("http://127.0.0.1:5173/room", "http://127.0.0.1:5173")).toBe(true);
    });

    it("fails closed on missing senderFrame URL, null trustedOrigin, wrong origin, or non-http(s) schemes", () => {
      const untrusted: Array<string | undefined> = [
        undefined,
        "",
        "   ",
        "not a url",
        "https://evil.example/",
        "https://screenshare.webmikas.com.evil.example/",
        "http://screenshare.webmikas.com/",
        "https://screenshare.webmikas.com:8443/",
        "about:blank",
        "data:text/html,hi",
        "file:///C:/index.html",
        "javascript:alert(1)",
        "blob:https://screenshare.webmikas.com/550e8400-e29b-41d4-a716-446655440000",
        "https://screenshare.webmikas.com/\r\n",
      ];
      for (const url of untrusted) {
        expect({ url, trusted: isTrustedFrameUrl(url, TRUSTED_ORIGIN) }).toEqual({
          url,
          trusted: false,
        });
      }

      expect(isTrustedFrameUrl("https://screenshare.webmikas.com/", null)).toBe(false);
      expect(isTrustedFrameUrl("https://screenshare.webmikas.com/", "")).toBe(false);
      expect(isTrustedFrameUrl("data:text/html,hi", "null")).toBe(false);
    });
  });

  describe("isAllowedPermission", () => {
    it("grants only allowlisted permissions to the trusted origin", () => {
      for (const perm of ["display-capture", "media", "clipboard-sanitized-write"]) {
        expect({
          perm,
          allowed: isAllowedPermission(perm, `${TRUSTED_ORIGIN}/room`, TRUSTED_ORIGIN),
        }).toEqual({ perm, allowed: true });
      }
    });

    it("denies non-allowlisted permissions and missing/untrusted requestingUrl", () => {
      expect(isAllowedPermission("notifications", `${TRUSTED_ORIGIN}/`, TRUSTED_ORIGIN)).toBe(false);
      expect(isAllowedPermission("geolocation", `${TRUSTED_ORIGIN}/`, TRUSTED_ORIGIN)).toBe(false);
      expect(isAllowedPermission("openExternal", `${TRUSTED_ORIGIN}/`, TRUSTED_ORIGIN)).toBe(false);
      expect(isAllowedPermission("media", undefined, TRUSTED_ORIGIN)).toBe(false);
      expect(isAllowedPermission("media", "", TRUSTED_ORIGIN)).toBe(false);
      expect(isAllowedPermission("display-capture", "https://evil.example/", TRUSTED_ORIGIN)).toBe(
        false,
      );
      expect(isAllowedPermission("media", `${TRUSTED_ORIGIN}/`, null)).toBe(false);
    });
  });

  describe("escapeHtml and buildOfflinePageUrl", () => {
    it("escapes all five HTML-significant characters", () => {
      expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
      expect(escapeHtml(`<script>alert("xss")</script>`)).toBe(
        "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
      );
      expect(escapeHtml(`' onclick='alert(1)&amp;`)).toBe(
        "&#39; onclick=&#39;alert(1)&amp;amp;",
      );
      expect(escapeHtml("ERR_INTERNET_DISCONNECTED")).toBe("ERR_INTERNET_DISCONNECTED");
    });

    it("escapes HTML injection payloads in offlinePage description and malformed target URLs", () => {
      const payload = `</b><img src=x onerror="alert('pwn')">&<script>alert(1)</script>`;
      const dataUrl = buildOfflinePageUrl("https://screenshare.webmikas.com/room", payload);
      expect(dataUrl.startsWith("data:text/html;charset=utf-8,")).toBe(true);

      const html = decodeURIComponent(dataUrl.slice("data:text/html;charset=utf-8,".length));
      expect(html).toContain("<b>screenshare.webmikas.com</b>");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<img ");
      expect(html).toContain(
        "&lt;/b&gt;&lt;img src=x onerror=&quot;alert(&#39;pwn&#39;)&quot;&gt;&amp;&lt;script&gt;alert(1)&lt;/script&gt;",
      );

      const badUrlData = buildOfflinePageUrl(`<svg onload="alert(1)">`, "ERR_FAILED");
      const badUrlHtml = decodeURIComponent(
        badUrlData.slice("data:text/html;charset=utf-8,".length),
      );
      expect(badUrlHtml).not.toContain("<svg");
      expect(badUrlHtml).toContain("&lt;svg onload=&quot;alert(1)&quot;&gt;");
    });
  });
});
