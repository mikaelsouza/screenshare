# Project: screenshare Comprehensive Test Suite

## Architecture
The screenshare application is a WebRTC screen-sharing and media streaming platform with an asymmetric partial mesh topology:
- **Shared Module (`shared/protocol.ts`)**: Wire protocol types, message schemas, serialization/parsing, room code generation (rejection sampling).
- **Backend Cloudflare Worker (`worker/`)**: Edge signaling and admission server using SQLite-backed Durable Objects (`RoomDO`), WebSocket hibernation, IP normalization (`worker/ipkey.ts`), token bucket rate limiting (`worker/ratelimit.ts`), and strict security headers (`worker/index.ts`).
- **Frontend Client (`src/`)**: Single-page application orchestrating WebRTC `PeerLink` connections, perfect negotiation with glare resolution, partial mesh filtering (viewers connect only to sharers), send-side video pausing via RTCDataChannel, Opus stereo SDP munging, adaptive bitrate control (`src/quality.ts`), and Web Audio boost pipes (`src/main.ts`).
- **Desktop Electron App (`electron/`)**: Cross-platform wrapper providing native desktop capture (`desktopCapturer`), strict origin isolation (`electron/main.js`), secure preload bridge (`electron/preload.cjs`), and an embedded RFC 6455 local signaling server (`electron/server.js`) matching RoomDO protocol semantics.

## Code Layout
- `shared/` - Pure TypeScript wire protocol, constants, types, parsing
- `worker/` - Cloudflare Worker and RoomDO Durable Object signaling
- `src/` - Frontend WebRTC client, media capture, quality, signaling, UI
- `electron/` - Desktop wrapper and embedded local Node.js signaling server
- `test/unit/` - Unit tests for shared, worker, frontend, desktop modules
- `test/formal/` - Formal proof tests verifying protocol and state invariants with `fast-check`
- `test/fuzz/` - Boundary and corrupted input fuzzers
- `test/mutant/` / `stryker.config.json` - Mutation testing configuration and analysis
- `package.json` - Tooling scripts (`test:unit`, `test:formal`, `test:fuzz`, `test:mutant`, `test:all`)

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Tooling & Harness Setup | Configure fast-check, Stryker, npm test scripts in package.json | M1 | survey |
| 2 | Room Code Generation | Uniform rejection sampling over 31-character alphabet | M2 | survey |
| 3 | Room Code Validation | Strict 8-char alphabet validation without regex recompilation | M2 | survey |
| 4 | Client Message Parser | Strict discriminant validation, payload bounds, UUID peer ID | M2 | survey |
| 5 | IP Key Normalization | IPv4 passthrough, IPv4-mapped extract, IPv6 /64 CIDR subnet | M2 | survey |
| 6 | In-Memory Rate Limiting | Fixed-window token budget and two-phase stale/oldest eviction | M2 | survey |
| 7 | WebSocket Upgrade Helper | Graceful 101 WebSocket rejection handshake (1008/1013) | M2 | survey |
| 8 | Security Headers & Routing | CSP, HSTS, Permissions-Policy, COOP/CORP, DO fetch routing | M2 | survey |
| 9 | Room Claiming & Passwords | Unclaimed room password setup (>=8 chars), salted SHA-256 hash | M2 | survey |
| 10 | Password Verification | Constant-time comparison, exponential delay, brute-force caps | M2 | survey |
| 11 | Room Capacity Bounds | Max 20 peers, 80 sockets, 40 per IP, 10s join deadline | M2 | survey |
| 12 | In-Place Session Resume | Rejoin token validation, peer ID preservation, zero drop | M2 | survey |
| 13 | Host Actions & Ban | Kick revokes ticket and bans IP 15m; lock state persistence | M2 | survey |
| 14 | Orphaned Lock Grace | 5m grace period unlocks room automatically if host gone | M2 | survey |
| 15 | Offer Privacy Isolation | Rejects WebRTC offer if neither peer is currently sharing | M2 | survey |
| 16 | Frame Flooding & Token Bucket | 200 burst, 20/sec refill, >80KB 1009, >5 bad messages 1008 | M2 | survey |
| 17 | Room Abandonment Alarm | 12h DO alarm erases storage when 0 peers remain | M2 | survey |
| 18 | Frontend Signaling Client | Ping keepalive (15s), jittered backoff, 64-msg offline queue | M2 | survey |
| 19 | Perfect Negotiation | Total ordering glare resolution (polite = selfId < peerId) | M2 | survey |
| 20 | Asymmetric Partial Mesh | Viewers connect only to sharers; zero viewer-viewer links | M2 | survey |
| 21 | Send-Side Video Pausing | Control channel {"c":"view","want":false} halts video upload | M2 | survey |
| 22 | Opus Stereo SDP Munging | Forces stereo=1, sprop-stereo=1, 256k bitrate, no DTX | M2 | survey |
| 23 | Latency & Degradation Tuning | maintain-framerate preference, zero jitter buffer target | M2 | survey |
| 24 | Adaptive Bitrate Control | Loss-based 75% step-down, 15% recovery, 1.5M floor | M2 | survey |
| 25 | Audio Capture Modes | App window vs system loopback, non-voice DSP constraints | M2 | survey |
| 26 | Web Audio Boost Pipe | DynamicsCompressor + GainNode amplification without clipping | M2 | survey |
| 27 | Link Health Monitoring | Delta stats computation, packet loss ratio, candidate type | M2 | survey |
| 28 | Electron Desktop Capturer | Source picker, loopback audio, strict origin verification | M2 | survey |
| 29 | Electron Preload Bridge | Secure contextIsolation bridge exposing electronAPI | M2 | survey |
| 30 | Electron WebSocket Server | RFC 6455 7/16/64-bit frame decoder, masking, ping/pong | M2 | survey |
| 31 | Electron LocalRoom State | In-memory room DO parity, ticket store, 15m kick ban | M2 | survey |
| 32 | Formal Invariant: Host Uniqueness | At most 1 host socket per room across all state transitions | M3 | survey |
| 33 | Formal Invariant: Capacity Bounds | Total joined peers <= 20, sockets <= 80, per IP <= 40 | M3 | survey |
| 34 | Formal Invariant: Mesh Privacy | hasLink(A, B) -> sharing(A) or sharing(B) | M3 | survey |
| 35 | Formal Invariant: Kick Ban | Kicked IP rejected for 15m; ticket permanently revoked | M3 | survey |
| 36 | Formal Invariant: Lock Grace | Orphaned locked room unlocks after >= 5m without host | M3 | survey |
| 37 | Formal Invariant: Password Safety | Stored hash immutable; timing-safe check independent of mismatch | M3 | survey |
| 38 | Formal Invariant: Rate Limits | Monotonic sliding window bounds; token bucket refill math | M3 | survey |
| 39 | Formal Invariant: Glare Liveness | Polite asymmetry guarantees deadlock-free convergence | M3 | survey |
| 40 | Formal Invariant: Resume Idempotence | Rejoin with resume preserves selfId and emits no peer-left | M3 | survey |
| 41 | Fuzz: Client Message Parser | Arbitrary byte streams, corrupt JSON, prototype pollution | M4 | survey |
| 42 | Fuzz: Opus SDP Munging | Corrupted SDP blocks, missing fmtp, unexpected codecs | M4 | survey |
| 43 | Fuzz: IP Key Normalizer | Edge-case IPv4/IPv6, zone IDs, compressed hextets | M4 | survey |
| 44 | Fuzz: Control Channel Parser | Malformed JSON, non-boolean wants, oversized payloads | M4 | survey |
| 45 | Fuzz: Candidate SDP Parser | Corrupted candidate lines, missing fields | M4 | survey |
| 46 | Fuzz: Electron Frame Decoder | Stream fragmentation, unmasked/masked frames, invalid opcodes | M4 | survey |
| 47 | Fuzz: Name Sanitizer | Unicode bidi, zero-width joiners, emoji surrogates, 1MB input | M4 | survey |
| 48 | Mutation Analysis & Resilience | Stryker mutation runs across pure algorithmic modules | M5 | survey |
| 49 | Non-Regression Execution | npm run test:all executes cleanly across unit, formal, fuzz, e2e | M6 | survey |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Tooling & Integration Setup | package.json scripts (test:formal, test:fuzz, test:mutant), dependencies (fast-check, stryker) | none | DONE |
| M2 | Comprehensive Unit Test Suite | Unit tests across shared, worker, frontend (src), and electron | M1 | DONE |
| M3 | Formal Proof Test Suite | Fast-check model-based state machine and property invariant proofs | M1, M2 | DONE |
| M4 | Fuzzing Suite | Property-based fuzzers for parsers, decoders, mungers, sanitizers | M1, M2 | DONE |
| M5 | Mutant Testing & Reporting | Stryker mutation test execution, mutant killer verification, report generation | M1, M2 | DONE |
| M6 | Full Regression & Verification Audit | Run npm run test:all, verify clean exit 0 across all suites | M1, M2, M3, M4, M5 | DONE |

## Interface Contracts
### Test Harness ↔ package.json
- `npm run test:unit`: Executes all unit tests in Vitest across `test/unit/**/*.test.ts`.
- `npm run test:formal`: Executes all formal invariant proof tests in Vitest across `test/formal/**/*.test.ts`.
- `npm run test:fuzz`: Executes fuzz test suites across `test/fuzz/**/*.test.ts`.
- `npm run test:mutant`: Executes Stryker mutation testing and outputs reports in `reports/mutation/`.
- `npm run test:all`: Executes `npm run test && npm run test:formal && npm run test:fuzz && npm run test:e2e` (must pass cleanly with exit code 0).
