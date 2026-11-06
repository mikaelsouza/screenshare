# screenshare

Low-latency screen sharing for a small group of friends. One or more people share a
screen with game audio; everyone else watches. Rooms hold up to 20 people.

**Video never touches a server.** The Worker coordinates a few KB of signalling and then goes
quiet; media flows directly browser-to-browser via WebRTC.

[![The room view with an active share](assets/screenshot.png)](https://screenshare.webmikas.com)

**Live:** [screenshare.webmikas.com](https://screenshare.webmikas.com)

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

## How it works

```
Browser A ──┐                                    ┌── Browser B
            │  WebSocket (signalling only)       │
            └──►  Worker ──► RoomDO (per room) ◄─┘

Browser A ═══════════ SRTP media, peer-to-peer ═══════════ Browser B
```

- **Worker** (`worker/index.ts`) serves the frontend, hands out room codes at
  `/api/room`, and routes `/ws/:code` to a per-room Durable Object.
- **RoomDO** (`worker/room.ts`) coordinates signalling, membership and room state. It never
  parses SDP or sees media.
- **Frontend** (`src/`) does capture, encoding, the partial mesh, and per-peer bitrate
  adaptation. Viewers connect only to sharers, never to each other.

## Privacy

- **Peer-to-peer connections** are direct between browsers using STUN for NAT traversal.
  People in the room you connect with can see your IP address.
- **Room passwords** are optional and set by the room's creator, who becomes the host.
  The host can remove people or lock the room; bans, locks and rejoin tickets are
  enforced by the Durable Object.
- **The server sees** your IP, the room code and your name while you are connected. A
  room's password and settings are erased 12 hours after it empties.

Known limitations and open defects are tracked in
[Issues](https://github.com/mikaelsouza/screenshare/issues).

## Audio

Screen and window sharing always enables Chrome's native audio toggle: per-application
audio on the **Window** tab (`windowAudio: "window"`) and system audio (excluding this
browser's own playback via `restrictOwnAudio: true`) on the **Entire Screen** tab. In the
desktop app, WASAPI captures the shared window's process tree (following games between
lobby and match windows) or system audio excluding the app itself. While streaming, the
**Mute audio** button next to **Stop sharing** mutes or unmutes your outbound audio track
in place.

## Deploy

1. Set the custom domain in `routes` in `wrangler.jsonc` (replace the `<tld>` placeholder).
2. Push to `main`. CI runs the checks and deploys with `cloudflare/wrangler-action`;
   `npm run deploy` builds and deploys locally without running any checks.

## Development

```bash
npm run check        # typecheck client + worker
npm run test:unit    # pure logic (protocol, SDP, stats, limits)
npm run test:worker  # RoomDO in real workerd
npm run test:e2e     # Chromium peers: p2p, edge cases
npm test             # check + unit + worker
```

Set `CHROMIUM_BIN` if you are not inside `nix develop`.

## License

[MIT](LICENSE) © Mikael Souza
