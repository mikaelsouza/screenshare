# Security Policy

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues, pull requests, or discussions.

Instead, report vulnerabilities privately via [GitHub Private Vulnerability Reporting](https://github.com/mikaelsouza/screenshare/security/advisories/new).

When submitting a report, please include:

- A clear description of the vulnerability and its potential impact
- Affected component(s) and version or commit SHA
- Step-by-step reproduction instructions or a minimal proof of concept
- Any suggested remediation, if known

You can expect an initial acknowledgement within **72 hours** and status updates as the report is triaged and resolved. Please allow reasonable time for a fix and coordinated disclosure before sharing details publicly.

## Supported Scope

Security reports are welcomed for the latest code on `main` and the latest published releases across all three components:

| Component | Scope |
| --- | --- |
| **Web Client** (`src/`, `shared/`) | WebRTC signaling & partial mesh, invite link fragment handling, `localStorage`/`sessionStorage` token storage, strict CSP & Trusted Types compliance, P2P data-channel validation |
| **Cloudflare Worker & Durable Object** (`worker/`) | HTTP/WebSocket upgrade validation, origin enforcement, per-IP rate limiting, `RoomDO` auth/moderation/lifecycle invariants, constant-time secret verification, bounded storage |
| **Windows Electron Desktop App** (`electron/`, `src/platform/`) | Process isolation (`contextIsolation`, `sandbox`, `nodeIntegration: false`), IPC origin pinning, `@electron/fuses`, WASAPI audio capture, window follower, auto-updater verification |

### Out of Scope

- Direct peer IP visibility during active WebRTC media sessions (inherent to peer-to-peer WebRTC with STUN, documented in `README.md` and `privacy.html`)
- Denial-of-service attacks requiring volumetric network traffic beyond Cloudflare edge rate limits
- Vulnerabilities in third-party browsers, operating systems, or unmaintained forks

## Security Architecture Highlights

- **Strict CSP & Trusted Types:** The Worker serves `script-src 'self'`, `connect-src 'self'`, `require-trusted-types-for 'script'`, and `trusted-types 'none'`. All DOM rendering avoids raw HTML sinks (`innerHTML`, `eval`, `blob:`/`data:` script or worklet URLs), and runtime schema validation uses Zod in `jitless` mode.
- **URL Fragment Privacy & Credential Hygiene:** Room invite secrets live exclusively in the URL fragment (`#CODE-SECRET`) and are scrubbed from the address bar immediately on load. Unclaimed rooms perform zero persistent Durable Object storage writes and run constant-time sentinel hash checks.
- **Electron Trust Boundary & Supply Chain:** Packaged Windows builds burn all 6 `@electron/fuses` (`runAsNode: false`, `enableCookieEncryption: true`, `enableNodeOptionsEnvironmentVariable: false`, `enableNodeCliInspectArguments: false`, `enableEmbeddedAsarIntegrityValidation: true`, `onlyLoadAppFromAsar: true`), gate all dev/smoke overrides behind `!app.isPackaged`, and publish SLSA build provenance attestations alongside `SHA256SUMS.txt`.
- **Automated Verification:** CI enforces CodeQL (JavaScript/TypeScript and GitHub Actions), dependency review on pull requests, production `npm audit`, SHA-pinned GitHub Actions, and protected guardrail diff checks.
