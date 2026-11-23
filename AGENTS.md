# Agent Engineering Contract (`mikaelsouza/screenshare`)

This repository is a P2P screen-sharing web & Windows Electron app backed by a Cloudflare Worker and Durable Object (`RoomDO`). Every change — human or AI-assisted — must uphold the non-negotiable invariants below.

---

## 1. WebRTC, Media & Capture Invariants

- **Partial Mesh Topology (No Viewer-to-Viewer Links):** Viewers connect **only** to active sharers, never to each other. Both `src/mesh.ts` and `worker/room.ts` enforce this invariant: zero open `RTCPeerConnection`s whenever `!localSharing && !remoteSharing`. When `Mesh.setCapture(null)` runs, links to non-sharing peers MUST be closed via `removePeer`.
- **Glare Tie-Breaking & Initiator Ownership:** Only a sharer initiates links (`addPeer(id)`). Viewers create links solely on receiving an offer (`answering = true`). When both peers share simultaneously, `polite = selfId < peerId` and `createsControl = !answering && (!peerSharing || selfId >= peerId)`.
- **Persistent `sendonly` Transceivers:** Never call `pc.addTransceiver` / `pc.removeTrack` repeatedly on share/unshare cycles on an open link. Allocate at most **one** persistent `sendonly` video transceiver and **one** persistent `sendonly` audio transceiver per `PeerLink` (`direction: "sendonly"`), swap media via `sender.replaceTrack(track)` / `sender.replaceTrack(null)` serialized through a per-link `mediaQueue` + `captureGeneration`, and re-emit retained `remoteStream` on `false -> true` `setMemberSharing` transitions. Steady-state SDP `m=`-line count stays constant (`<= 3` one-way, `<= 5` mutual share).
- **`contentHint` & Encoding Parameters:**
  - Always set `videoTrack.contentHint = "motion"` and `audioTrack.contentHint = "music"` (`src/capture.ts`, `src/platform/electron.ts`, `src/platform/pcm-audio.ts`, `test/formal/encoding-invariants.test.ts`). Never reset video `contentHint` to `""` (triggers Chromium `ZeroHertzMode` FPS drops).
  - Control Clarity vs. Framerate solely via `RTCRtpSendParameters.degradationPreference`: Framerate uses `"maintain-framerate"` (default); Clarity requests `"maintain-framerate-and-resolution"` with fallback to `"maintain-resolution"` and then `"maintain-framerate"`.
  - Always call `sender.getParameters()` immediately before `sender.setParameters(...)`.
- **Audio Capture Path:** Native Windows PCM audio (`src/platform/pcm-audio.ts`) must run off the renderer main thread via a same-origin `AudioWorkletNode` (`?worker&url` compiled asset, 400 ms / 19,200-frame stereo ring buffer) — never `ScriptProcessorNode`, `blob:`, or `data:` URLs.

---

## 2. Cloudflare Worker & Durable Object (`RoomDO`) Invariants

- **Input-Gate Atomicity (Pre-Compute Crypto Before Storage I/O):** In `worker/room.ts`, pre-compute **all** `crypto.subtle` digests (`hashSecret`, `preMintRotationCredentials`, `preMintEmptyResetSecret`) *before* entering `this.ctx.blockConcurrencyWhile(...)` or performing any `this.ctx.storage.get` / `put` / `delete`. Async WebCrypto work interleaved with storage I/O breaks DO input-gate atomicity.
- **Zero Writes on Unclaimed Rooms:** Uninitialized rooms (`CLAIMED_KEY !== true`) MUST perform zero persistent storage writes and run constant-time sentinel hash checks (`DUMMY_HASH_HEX`) so unclaimed rooms cannot be probed or used to exhaust storage.
- **Hibernation & Bounded Storage:** Always persist per-socket state via `ws.serializeAttachment(...)`, cap persisted `members` and `denyList` maps at `MAX_STORED_ENTRIES` (`128`), and call `syncAlarm()` / `scheduleAlarmWithUnjoined()` after state changes.
- **Close Codes:** Return WebSocket close code `1008` for fatal auth/policy rejections (`bad-password`, `bad-room-code`, `kicked`, `room-locked`, `session-replaced`, `forbidden-origin`), `1013` for retryable capacity/rate limits, and `1001` for room expiry.
- **Multi-Tier Room Lifecycle (PR #52):**
  - **Unused rooms (`!everJoined`):** Expire completely after `UNUSED_ROOM_TTL_MS` (**12 hours**).
  - **Used rooms after emptying:** Clear ephemeral session state (`members` rejoin tickets, `denyList` kick bans, `locked`, `promotedHost`, `hostPromoted`) after `EMPTY_SESSION_CLEANUP_MS` (**15 minutes**). If the room ended `locked`, rotate `PASSWORD_KEY` + `ROOM_PASSWORD_KEY` during cleanup so pre-lock links stay invalid. Restore `CREATOR_HOST_KEY` -> `HOST_KEY` (or revoke `HOST_KEY` for already-promoted pre-deploy legacy rooms without `CREATOR_HOST_KEY`).
  - **Reusable credentials cap:** Retain room credentials for `EMPTY_ROOM_TTL_MS` (**90 days**) anchored to `LAST_HOST_ACTIVE_KEY` (creator activity), enforced even while occupied by promoted guests (`OCCUPIED_FALLBACK_ALARM_MS` + `creatorActivityCap`). Pre-deploy rooms lacking `CREATOR_HOST_KEY` stay on their non-sliding 12-hour TTL.
  - **Lazy pre-admit reconciliation:** `reconcileEmptyTimersBeforeAdmit()` must expire overdue rooms (closing sibling sockets with `1001`) before `admit()` without charging `passwordFailures`.
- **Host Token Provenance (Client):** Persist creator `hostToken`s only in `localStorage` (`host-rooms` via `src/host-tokens.ts`, bounded to 20 rooms, 90d TTL, 5m clock-skew guard, Web Locks `screenshare:host-rooms` + cross-tab `storage` sync). Keep mid-session promoted guest tokens strictly in memory (`sessionHostTokens`), never overwriting creator provenance.
- **Recent Rooms Persistence (Client):** Persist recent room rejoin state only in `localStorage` (`recent-rooms` and opt-out flag `recent-rooms-disabled` via `src/recent-rooms.ts`, `src/recent-rooms-model.ts`, and `src/controllers/recent-rooms-controller.ts`), bounded to `20` rooms, `90d` TTL, `5m` clock-skew guard, `4` peer names, `40`-char local label, and `128`-char invite secret. Serialize updates across tabs via Web Lock `screenshare:recent-rooms` + `storage` sync, driven by a single-flight FIFO queue and pure replay reducer (`applyRecentRoomOp`, `replayRecentRoomOps`). Opt-out (`recent-rooms-disabled`) suppresses persistence and clears stored rooms.

---

## 3. Strict CSP & Trusted Types Boundary

- `worker/index.ts` enforces `script-src 'self'`, `connect-src 'self'`, `require-trusted-types-for 'script'`, and `trusted-types 'none'`.
- **Never** import `"zod"` directly outside `shared/protocol.ts` (which runs `z.config({ jitless: true })` and re-exports `{ z }`).
- **Never** use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, or `blob:`/`data:` script/Worker/`AudioWorklet` URLs. Build all DOM with `createElement`, `textContent`, and `replaceChildren`.

---

## 4. Electron Desktop Trust Boundary

- Keep `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and strict `senderFrame.url` origin pinning on all privileged IPC handlers.
- **Never** read `process.env` in `electron/**` outside `electron/config.ts`.
- Gate all dev/smoke URL, CLI, and `userData` overrides (`SCREENSHARE_URL`, `SMOKE_TEST`, `--smoke-test`, `SMOKE_USER_DATA_DIR`, `ELECTRON_DEV`, `NODE_ENV`, `VITE_DEV_SERVER_URL`) strictly behind `!app.isPackaged`.
- Burn all 6 `@electron/fuses` on packaged builds (`runAsNode: false`, `enableCookieEncryption: true`, `enableNodeOptionsEnvironmentVariable: false`, `enableNodeCliInspectArguments: false`, `enableEmbeddedAsarIntegrityValidation: true`, `onlyLoadAppFromAsar: true`).

---

## 5. TypeScript 7.0, Lint & Verification Gates

- **TypeScript 7.0 strictness (`tsconfig.json`, `tsconfig.worker.json`, `tsconfig.electron.json`):**
  - `isolatedDeclarations: true`: explicit type annotations on all exported functions, methods, properties, and constants.
  - `erasableSyntaxOnly: true`: no `enum`, `namespace`, or constructor parameter properties.
  - `verbatimModuleSyntax: true`: always use `import type` for type-only imports.
  - `exactOptionalPropertyTypes: true`: never pass `{ k: undefined }` to optional properties; conditionally spread.
  - `noUncheckedIndexedAccess: true` & `noPropertyAccessFromIndexSignature: true`: handle `undefined` on indexed access and use bracket notation on index signatures.
  - `electron/**/*.ts` uses `"module": "NodeNext"`: relative imports MUST include `.js` extensions.
- **Static & Test Gates:**
  - `npm run check`, `npm run lint:knip` (zero unused files/exports/cycles), `npm run lint:deadcode` (`oxlint --type-aware --deny-warnings`, `max-lines <= 500`, `complexity <= 15`, zero `as unknown as T` outside `test/**`).
  - `npm test` (`check` + `lint:all` + `test:unit` + `test:worker`) and Vitest coverage (`statements >= 93%`, `branches >= 88%`, `functions >= 92%`, `lines >= 94%`).
- **Protected Guardrail Files:** Edits to `AGENTS.md`, `.oxlintrc.json`, `stryker.config.json`, `vitest.config.ts`, `vitest.workers.config.ts`, `electron-builder.json`, `shared/protocol.ts`, `worker/index.ts`, `test/formal/**`, `.github/**`, `scripts/check-guardrails-diff.ts`, or `scripts/run-stryker-ci.ts` require explicit maintainer review (`CODEOWNERS` + `approved-guardrail-change` label on PRs).

---

## 6. CLI, Backlog & Review Hygiene

- Always pass PR and issue bodies via `--body-file` (written cleanly to a file or heredoc), never inline double-quoted `--body "..."` strings (avoids shell escape corruption such as `\t`/`^G`).
- Before closing any issue referencing a PR, verify `gh pr view <num> --json state,mergedAt` confirms `mergedAt != null`.
- Every deferred follow-up from a PR review or security audit must be tracked as a GitHub Issue or an `it.todo("...")` entry before merge.
- For runtime and security changes, run a context-isolated **Breaker** verification pass (given only `AGENTS.md` and `git diff`, with no implementation rationale) to write adversarial tests against the diff.
