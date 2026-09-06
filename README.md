# screenshare

Low-latency screen sharing for a small group of friends. One person shares their
screen with game audio; everyone else in the room watches. Rooms hold up to 8 people
and multiple people can share at once.

**Video never touches a server.** After a handshake through the signalling server,
media flows directly between browsers over WebRTC. The server carries a few KB of
signalling per session and then goes quiet.

## Architecture

```
Browser A ──┐                                    ┌── Browser B
            │  WebSocket (signalling only)       │
            └──►  Worker ──► RoomDO (per room) ◄─┘
                    │
                    └──► POST /api/ice ──► Cloudflare Realtime (mints TURN creds)

Browser A ═══════════ SRTP media, direct P2P ═══════════ Browser B
                  (never touches any server)
```

- **Worker** (`worker/index.ts`) — serves the built frontend, routes `/ws/:code` to the
  Durable Object, and mints short-lived TURN credentials at `/api/ice` (the Cloudflare
  API token must not reach the browser).
- **RoomDO** (`worker/room.ts`) — one Durable Object per room code, holding the
  WebSocket connections and routing signalling between peers. It forwards `data`
  verbatim and never parses SDP. Uses the WebSocket Hibernation API, so idle rooms
  cost nothing.
- **Frontend** (`src/`) — all the WebRTC work: capture, encoder tuning, full-mesh peer
  management, and per-peer bitrate adaptation.

Roughly 10% of peer pairs sit behind CGNAT or a symmetric NAT and cannot connect
directly; those fall back to a TURN relay automatically. `/diagnostics` reports which
path a given network actually took.

### Bandwidth

Mesh cost is linear in room size and paid by the **sharer's uplink**:

| Room | Sharers | Sharer uploads | Each viewer downloads |
| ---- | ------- | -------------- | --------------------- |
| 4    | 1       | 18 Mbps        | 6 Mbps                |
| 8    | 1       | 42 Mbps        | 6 Mbps                |
| 8    | 2       | 42 Mbps each   | 12 Mbps               |

A full 8-person room needs a fiber-class uplink from the sharer. Two mitigations do
the heavy lifting and are always on: senders are paused for tiles the viewer is not
looking at (`IntersectionObserver` -> a peer-to-peer data channel -> `encodings[0].active`),
and each peer's bitrate adapts independently on sustained packet loss. Because mesh
connections are independent, one person on bad wifi degrades only their own stream.

## Requirements

- Chrome or Edge on desktop. Only Chromium reliably captures system/game audio, and
  only it exposes the encoder controls this app depends on.
- **macOS Chrome cannot capture system audio** — tab audio only. Screen sharing works;
  game audio does not. There is no workaround. Linux/Wayland is similar.

## Getting started

```bash
nix develop        # Node 22, patchelf, Chromium
npm install        # postinstall patches workerd for NixOS (see below)
npm run dev        # Vite dev server (frontend only)
npm run preview    # full stack: built assets + Worker via wrangler dev
```

For TURN credentials locally, create a gitignored `.dev.vars`:

```ini
TURN_KEY_ID=your_turn_key_id
TURN_API_TOKEN=your_turn_api_token
```

Without these the app falls back to STUN only. Direct P2P still works; only the relay
fallback is unavailable.

## Testing

```bash
npm run check        # typecheck client + worker
npm run test:unit    # pure logic (protocol, SDP munging, stats)
npm run test:worker  # RoomDO inside real workerd via vitest-pool-workers
npm run test:e2e     # two real Chromium peers establishing an actual P2P connection
npm test             # check + unit + worker
npm run test:all     # everything, including the browser tests
```

The end-to-end tests launch two Chromium browsers, join them to one room, share a
synthetic stream, and assert that frames actually decode on the far side **and** that
the selected ICE candidate pair is direct rather than a relay — the premise of the
whole design. `getDisplayMedia` is stubbed with a canvas stream because headless
Chrome has no screen picker; everything downstream of the picker is real.

## Deploying

1. Create a TURN key in the Cloudflare dashboard (Realtime → TURN).
2. Set the secrets:
   ```bash
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_API_TOKEN
   ```
3. Attach your custom domain by uncommenting `routes` in `wrangler.jsonc`.
4. `npm run deploy`

Cloudflare terminates TLS automatically for a Worker custom domain, which
`getDisplayMedia` requires. Note that the Cloudflare proxy drops idle WebSockets after
about 100 seconds — the client pings every 30s, answered by the Durable Object's
`setWebSocketAutoResponse` without waking it, so keepalives cost nothing.

## NixOS notes

`wrangler` and `vitest-pool-workers` ship prebuilt `workerd` binaries that hardcode the
FHS loader `/lib64/ld-linux-x86-64.so.2`, which NixOS does not have.
`scripts/patch-workerd.sh` repoints them at the Nix loader via patchelf. It runs
automatically on `npm install` (`postinstall`) and is safe to re-run.

`.npmrc` sets `legacy-peer-deps=true`: `@cloudflare/vitest-pool-workers` declares an
optional peer on `@vitest/browser-playwright` that makes npm's peer resolver crash.
Exact versions are pinned in `package.json` instead.

## Layout

```
index.html, diagnostics.html   entry points (Vite roots them here)
shared/protocol.ts             message types shared by worker and frontend
worker/                        Worker entry, RoomDO, TURN credential minting
src/capture.ts                 getDisplayMedia + track configuration
src/quality.ts                 encoder params, codec choice, Opus SDP, bitrate adaptation
src/mesh.ts                    full-mesh peer connections, perfect negotiation
src/signaling.ts               WebSocket client with reconnect and keepalive
src/stats.ts                   getStats extraction and ICE candidate parsing
src/diagnostics.ts             connection test page
test/unit, test/worker, test/e2e
```
