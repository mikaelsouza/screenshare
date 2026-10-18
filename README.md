# screenshare

Low-latency screen sharing for a small group of friends. One or more people share a
screen with game audio; everyone else watches. Rooms hold up to 20 people.

**Video never touches a server.** The Worker relays a few KB of signalling and then goes
quiet; media flows browser-to-browser, directly or through a TURN relay when a direct path
is impossible.

[![The room view with an active share](assets/screenshot.png)](https://screenshare.webmikas.com)

**Live:** [screenshare.webmikas.com](https://screenshare.webmikas.com) ·
**Diagnostics:** [screenshare.webmikas.com/diagnostics](https://screenshare.webmikas.com/diagnostics)

## Requirements

- Chrome or Edge on desktop. Only Chromium captures system/game audio and exposes the
  encoder controls the app depends on.
- Game-only audio needs Chrome or Edge 141+ (`windowAudio`).
- macOS Chrome captures tab audio only; Linux/Wayland has similar limits. Screen sharing
  works, system audio does not.

## Quick start

```bash
nix develop        # Node 22, patchelf, Chromium (optional)
npm install        # patches workerd for NixOS
npm run dev        # frontend only
npm run preview    # built assets + Worker via wrangler dev
```

For TURN credentials locally, create a gitignored `.dev.vars` with `TURN_KEY_ID` and
`TURN_API_TOKEN`. Without them the app falls back to STUN only; direct P2P still works.

## How it works

```
Browser A ──┐                                    ┌── Browser B
            │  WebSocket (signalling only)       │
            └──►  Worker ──► RoomDO (per room) ◄─┘
                                  │
                                  └──► Cloudflare Realtime (TURN credentials)

Browser A ═══════════ SRTP media, peer-to-peer ═══════════ Browser B
```

- **Worker** (`worker/index.ts`) serves the frontend, hands out room codes at
  `/api/room`, and routes `/ws/:code` to a per-room Durable Object.
- **RoomDO** (`worker/room.ts`) relays signalling, membership and room state. It never
  parses SDP or sees media.
- **Frontend** (`src/`) does capture, encoding, the partial mesh, and per-peer bitrate
  adaptation. Viewers connect only to sharers, never to each other.

## Privacy

- **Hide my IP** forces relay-only ICE, so peers see the TURN relay rather than your
  address. It fails closed: with no relay available, it refuses to connect.
- **Room passwords** are optional and set by the room's creator, who becomes the host.
  The host can remove people or lock the room; bans, locks and rejoin tickets are
  enforced by the Durable Object.
- **The server sees** your IP, the room code and your name while you are connected. A
  room's password and settings are erased 12 hours after it empties.

Known limitations and open defects are tracked in
[Issues](https://github.com/mikaelsouza/screenshare/issues).

## Audio

The **Audio** selector defaults to **Game only**, which never sends system audio, so
Discord and music stay private. Sharing a window captures that window's sound. Sharing a
whole screen in Game only mode asks for a second, windows-only pick, so you can choose the
game. The chip next to **Stop sharing** shows the source and can swap it live without
reconnecting.

## Deploy

1. Create a TURN key in the Cloudflare dashboard (Realtime → TURN).
2. `npx wrangler secret put TURN_KEY_ID` and `npx wrangler secret put TURN_API_TOKEN`.
3. Set the custom domain in `routes` in `wrangler.jsonc` (replace the `<tld>` placeholder).
4. Push to `main`. CI runs the checks and deploys with `cloudflare/wrangler-action`;
   `npm run deploy` builds and deploys locally without running any checks.

## Development

```bash
npm run check        # typecheck client + worker
npm run test:unit    # pure logic (protocol, SDP, stats, limits)
npm run test:worker  # RoomDO in real workerd
npm run test:e2e     # Chromium peers: p2p, edge cases, diagnostics
npm test             # check + unit + worker
```

The e2e suite expects TURN to be absent: move `.dev.vars` aside before running it, and
set `CHROMIUM_BIN` if you are not inside `nix develop`.

## License

[MIT](LICENSE) © Mikael Souza
