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
                                  └──► Cloudflare Realtime (mints TURN creds,
                                       delivered inside the `welcome` message)

Browser A ═══════════ SRTP media, direct P2P ═══════════ Browser B
                  (never touches any server)
```

- **Worker** (`worker/index.ts`) — serves the built frontend with security headers,
  hands out room codes at `/api/room`, and routes `/ws/:code` to the Durable Object.

  There is deliberately **no public endpoint that mints TURN credentials.** An earlier
  design had `POST /api/ice` gated on a room code, which authorises nothing: room codes
  are client-forgeable, so anyone could mint relay credentials on our Cloudflare
  allocation. The Durable Object now issues them inside the `welcome` message, so
  holding a WebSocket that has been accepted into a room is the authorisation. (That
  bar is still low — see Known issues.) Each person gets their own credential, which the
  room revokes when they leave or are removed.
- **RoomDO** (`worker/room.ts`) — one Durable Object per room code, holding the
  WebSocket connections and routing signalling between peers. It forwards `data`
  verbatim and never parses SDP. Uses the WebSocket Hibernation API, so idle rooms
  cost nothing — which is also the source of the subtlest bug this project has had
  (see Room passwords below).
- **Frontend** (`src/`) — all the WebRTC work: capture, encoder tuning, mesh peer
  management, and per-peer bitrate adaptation.

Roughly 10% of peer pairs sit behind CGNAT or a symmetric NAT and cannot connect
directly; those fall back to a TURN relay automatically. `/diagnostics` reports which
path a given network actually took.

### Rooms, passwords and privacy

Room codes are 8 characters from a 31-character alphabet with `O/0/I/1/L` removed, so
they survive being read aloud. The code maps to a Durable Object via `idFromName`, which
is deterministic — hence the entropy.

**Room passwords** are optional and set by the join that *creates* the room. Two things
about the implementation are load-bearing:

- The password lives in **durable storage**, not an instance field. This object
  hibernates as soon as signalling quiets down, which is seconds after ICE completes,
  so an in-memory password read back as `null` on the next wake while the original
  peers were still connected — and because the "first peer sets it" branch only fires
  for an empty room, it was never re-armed. A protected room silently became a
  permanently open one. It is stored salted-hashed (SHA-256 over the Durable Object id
  plus the password), never in plaintext.
- Only the **claiming** join may set a password, tracked by a persisted flag. "First
  peer into an empty room" is not sufficient: a room is empty for the length of every
  reconnect, and permanently once a session ends while its code lives on in a shared
  link, so that rule let a stranger claim someone else's room and lock them out.

Wrong guesses are throttled with a growing delay rather than a lockout, so the throttle
cannot be turned around into a denial of service against the room's own users. A
*missing* password is not counted as a guess — every deep link and every refresh
arrives without one.

**Privacy mode** (`Hide IP`) forces `iceTransportPolicy: "relay"` so peers see only the
TURN relay's address, never yours. It **fails closed**: if no TURN server is available
the app refuses to connect and says so, rather than quietly downgrading to a direct
connection that would leak the very thing the checkbox promises to hide.

Its checkbox reads **Hide my IP**, because it hides only your own address; others in the
room who leave it off are still visible to you. Changing it inside a room reconnects at
once rather than on the next join, and in relay mode every outgoing SDP is also stripped
of non-relay candidate lines, so the policy is checked on the way out rather than trusted.

**Who connects to whom.** A peer connection runs ICE, and ICE gives the far end your
public address, so the mesh is not a full mesh: two people are connected only while at
least one of them is sharing. Viewers never connect to each other. A room link (`/#CODE`)
fills in the code and waits for **Join**, so a first-time visitor sees the Hide my IP
option, and the short "what others can see" note under it, before anything connects.

**Everyone is listed.** The participant list above the video shows every member, with
the first four characters of their id so two people with the same name can be told
apart. People who only watch never get a tile, so before the list existed a sharer could
not tell they were there. Names are cleaned on the server (NFKC, then control and format
characters such as bidi overrides and zero-width spaces are removed) so nobody can pose
as a friend with an invisible character.

**The room's creator is its host.** Their browser tab keeps a host token (in
`sessionStorage`, so a refresh keeps it and a new tab or a forwarded link does not). The
host sees **Remove** beside each person and a **Lock room** button. A removed person is
disconnected at once and their address cannot rejoin for 15 minutes; a locked room
refuses everyone new except the host. The ban is by address, so on a shared connection it
also shuts out whoever shares it; for anything lasting, lock the room.

### Abuse limits

Per-IP, and all of them chosen to be invisible in normal use. "IP" means the IPv4 address, or
the /64 prefix for IPv6, since one IPv6 subscriber can use any address in their /64. The
per-IP request limits run twice: in memory, and through Cloudflare's rate-limiting binding
(`ratelimits` in `wrangler.jsonc`), which is shared across isolates.

| Limit | Value | Why it is where it is |
| ----- | ----- | --------------------- |
| Room creation | 20/min | `/api/room` only returns a random string |
| WebSocket upgrades | 60/min | The expensive route: `idFromName` instantiates a Durable Object for any valid code |
| Sockets per IP per room | 16 (`MAX_ROOM_SIZE * 2`) | A household or CGNAT block shares one address, so this must exceed the room cap, with headroom for half-open sockets |
| Sockets per room | 32 (`MAX_ROOM_SIZE * 4`) | Unjoined sockets do not count against the room cap and would otherwise pile up |
| SDP / ICE candidate size | 64 KB / 1 KB | Unbounded, a joined peer could loop 1 MB blobs at another peer through the object |
| Frame size | 80 KB | Checked before parsing; closes with 1009 |
| Messages per socket | burst 200, then 20/s | Covers joining a full room with TURN; a flood past it closes with 1008 |
| Time to join | 10 s | A socket that never sends `join` is closed when the next one arrives, so idle sockets cannot fill a room |
| Unparseable messages | 5 per socket | Then the socket is closed |
| Wrong room passwords | 50 per 15 min, 200 per day | Per room. The right password always gets in, so guessing cannot lock the owners out |
| New room password | at least 8 characters | Checked when the room is created; **Generate** fills in a 12-character one |
| TURN credentials | 20/min | Each join mints its own; past the limit a join still succeeds, with STUN only |

A refusal **completes the WebSocket handshake and then closes**, rather than answering
with a 4xx. This is not incidental: a non-101 answer reaches the browser as a bare close
code 1006 with no body, which is indistinguishable from a network blip, so the client
reconnects forever and the user is never told why. Terminal refusals close 1008;
transient capacity refusals close 1013, which the client retries with backoff a bounded
number of times before giving up with a message.

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
- **Game-only audio needs Chrome or Edge 141+** (the `windowAudio` option). Older versions
  ignore it and offer system audio instead; the Share button warns.

## Game audio without Discord or music

The Audio selector next to Share screen picks where sound comes from. The default,
**Game only**, never sends system audio, because system audio includes voice chat and
music.

- **Share a window** (the game): Chrome is asked for that window's own audio
  (`windowAudio: "window"`).
- **Share the whole screen**: whole-screen shares can only carry system audio, so none is
  requested. The app then asks "Which app should viewers hear?" and opens Chrome's
  picker a second time, windows only, so you can pick the game. It keeps that capture's
  audio and discards its picture. This second picker needs its own click; Chrome only
  opens a picker from a click, and the first one used it up.
- The audio chip next to Stop sharing shows the current source. **Change** swaps it live
  without reconnecting anyone. **Use all system audio** is the fallback when a window
  has no audio Chrome can share.

Games whose launcher and match are separate windows, such as League of Legends, need a
re-pick when the match starts: the client's audio does not include the game's. When a
picked window closes, the chip turns yellow and offers **Pick again**. The video keeps
going throughout.

The audio track is always negotiated, even while silent, so every swap is a
`replaceTrack` with no renegotiation, and it shares the video's `MediaStream` so viewers
keep lip sync.

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
synthetic stream, and assert that frames actually decode on the far side and that the
selected ICE candidate pair is not a relay. `getDisplayMedia` is stubbed with a canvas
stream because headless Chrome has no screen picker; everything downstream of the
picker is real.

**These tests do not validate NAT traversal.** Both browsers run on one machine, so the
pair they select is `host <-> host`. They prove signalling, negotiation, encode and
decode; they say nothing about whether two people on different networks connect
directly, which is the premise of the whole design. Only two humans on two networks can
answer that, and `/diagnostics` is the tool for it.

## Deploying

1. Create a TURN key in the Cloudflare dashboard (Realtime → TURN).
2. Set the secrets:
   ```bash
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_API_TOKEN
   ```
3. Optionally, in the Cloudflare dashboard, add a billing notification for Realtime
   usage, so a surprise in relay traffic reaches you before the invoice does.
4. Attach your custom domain by uncommenting `routes` in `wrangler.jsonc`.
5. Push to `main`. `.github/workflows/deploy.yml` runs the typecheck, the unit suite and
   the workerd suite, builds, and deploys with `cloudflare/wrangler-action`. `npm run
   deploy` does the same thing by hand.

`wrangler.jsonc` sets `run_worker_first: true`, which routes *every* request through the
Worker rather than serving matched assets straight off the edge. That is what makes the
security headers actually reach the document — with a path list, `applySecurityHeaders`
decorated `/api/room` and nothing else, and the page a browser loads shipped with no CSP
and no `X-Frame-Options` at all. The cost is a Worker invocation per asset, which is
negligible against 100k/day.

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
`package-lock.json` plus `npm ci` pins exact versions instead.

`package.json` overrides `sharp` to `^0.35.4`: `@cloudflare/vitest-pool-workers` pins an
older miniflare whose `sharp` carries a libheif advisory. It is dev tooling only and
never ships to a browser; drop the override once the pool's own pin moves past it.

## Layout

```
index.html, diagnostics.html   entry points (Vite roots them here)
shared/protocol.ts             message types shared by worker and frontend
shared/ice.ts                  ICE server filtering (see the port 53 note below)
worker/index.ts                routing, rate limits, security headers
worker/room.ts                 RoomDO: membership, signalling, passwords
worker/turn.ts                 Cloudflare Realtime TURN credential minting
worker/upgrade.ts              WebSocket refusals that a browser can actually read
worker/ratelimit.ts            bounded fixed-window per-key throttle
src/capture.ts                 getDisplayMedia + track configuration
src/quality.ts                 encoder params, codec choice, Opus SDP, bitrate adaptation
src/mesh.ts                    peer connections (sharer to everyone, never viewer to viewer), perfect negotiation
src/signaling.ts               WebSocket client with reconnect and keepalive
src/stats.ts                   getStats extraction and ICE candidate parsing
src/diagnostics.ts             connection test page
test/unit, test/worker, test/e2e
```

## The port 53 trap

Cloudflare's TURN allocation includes endpoints on UDP port 53. **We filter every one of
them out** (`shared/ice.ts`), and the reason is worth recording, because the symptom
looks nothing like the cause.

Port 53 is DNS, and many networks intercept it. When one ICE endpoint black-holes, Chrome
does not merely skip it — on the network this was found on, it produced **zero**
server-reflexive candidates overall. Measured in isolation: `cloudflare:3478` alone gave
`srflx=1`; `cloudflare:53` alone gave `srflx=0`; all three servers including `:53` gave
`srflx=0`. With the port filtered, `host=2 srflx=1 relay=6`; without it, `host=2 srflx=0
relay=8`.

The consequence is that every connection is forced onto a TURN relay — the exact thing
this architecture exists to avoid — while the app looks like it is working fine. The
diagnostics page reports it as "No server-reflexive candidate", which reads like a
firewall problem.

The filter regex is `/:53(?:\?|$)/`, and the `(?:\?|$)` is load-bearing: a bare `:53`
substring also matches `:5349`, and silently dropping `turns:5349` would remove the TLS
relay that restrictive networks depend on. There is a test for exactly that trap.

## Known issues

Open defects, in rough order of how likely you are to hit them:

- **Transceiver leak on repeated sharing** (`src/mesh.ts`). `addTrack`/`removeTrack`
  mean every share -> unshare cycle permanently adds two transceivers and two SDP
  m-lines to every peer connection: `removeTrack` leaves the transceiver in place
  already marked as having sent, so the next `addTrack` cannot reuse it. Toggle sharing
  twenty times in an evening and a 7-peer mesh is carrying 40 m-lines per connection.
  The fix is one persistent transceiver per link plus `replaceTrack`.
- **TURN credentials are cheap to obtain.** Anyone can create a room, join it, and
  receive two-hour relay credentials on our Cloudflare allocation. They are now per
  person, revoked on leave, and capped at 20 a minute per address, which blunts this
  without preventing it. Cloudflare does not say whether revoking also ends a relay
  already in use. If relay traffic ever runs away, switch TURN off without a deploy:
  `echo true | npx wrangler secret put TURN_DISABLED` (delete the secret to switch it
  back on). Direct connections keep working; Hide my IP then refuses to connect, as it
  must.
- **`/diagnostics` reports symmetric NAT falsely on multi-homed machines.** It compares
  srflx ports across all local interfaces rather than across STUN servers, so a laptop
  with Wi-Fi and Ethernet both up, or any VPN adapter, looks symmetric even behind a
  plain cone NAT.
- **The 720p/6 Mbps floor is not enforced.** `BitrateAdapter`'s floor is 1.5 Mbps and the
  `720p30` preset ships at 4 Mbps, both below the figure stated as a hard commitment.
  Either the floor is real and both should change, or it is not and the claim should go.

## Not yet verified

Distinct from the above: these are not known to be broken, they have simply never been
tested.

- **NAT traversal between two real networks.** The premise of the design. See Testing.
- **Glass-to-glass latency.** The headline requirement — latency wins over quality when
  they conflict — has never once been measured. Put a millisecond timer on the sharer's
  screen, photograph both monitors, read the difference.
- **Game audio**, on any platform where it can be captured at all. In particular: whether
  Chrome on Windows honours `windowAudio: "window"` (per-app audio), whether the
  audio-only second capture stays in sync with the screen video, and whether Chrome
  exposes the picked window's title (the chip falls back to "game window").
- **8-person rooms with real media**, and multiple simultaneous sharers.
- **Hardware H.264 encoding.** Check `encoderImplementation` in `chrome://webrtc-internals`
  is not a software fallback; if it is, the encoder is competing with the game for CPU.
