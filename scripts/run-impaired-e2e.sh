#!/usr/bin/env bash
set -euo pipefail

E2E_CMD=(node --test --test-concurrency=1 --test-force-exit test/e2e/impaired/impairment.test.ts)
REQUIRE_NETEM="${REQUIRE_NETEM:-0}"

NETNS_SETUP='
  set -euo pipefail
  ip link set lo up
  # Chromium WebRTC ignores loopback-only network namespaces (no non-loopback
  # interface or default route). Provision a private non-loopback eth0 inside the
  # isolated netns so ICE gathers host UDP candidates; Linux routes self-to-self
  # traffic for local IPs through lo, so tc netem on lo impairs all WebRTC packets.
  if ip link add eth0 type dummy 2>/dev/null; then
    ip addr add 10.200.0.1/24 dev eth0
    ip link set eth0 up
  else
    ip link add eth0 type veth peer name eth0-peer
    ip addr add 10.200.0.1/24 dev eth0
    ip link set eth0 up
    ip link set eth0-peer up
  fi
  ip route replace default dev eth0
  tc qdisc add dev lo root netem delay 60ms 15ms loss 2% rate 5mbit
'

probe_netem_userns() {
  unshare --user --map-root-user --net bash -c "${NETNS_SETUP}" >/dev/null 2>&1
}

probe_netem_sudo() {
  sudo -n unshare --net bash -c "${NETNS_SETUP}" >/dev/null 2>&1
}

if [ "$(uname -s)" = "Linux" ] && command -v tc >/dev/null 2>&1 && command -v ip >/dev/null 2>&1; then
  # Try unprivileged netns first; if AppArmor restricts unprivileged userns (Ubuntu 24.04),
  # try passwordless sudo netns so host loopback is never mutated.
  if command -v unshare >/dev/null 2>&1 && probe_netem_userns; then
    echo "[impaired-e2e] Running inside user+net namespace with tc netem (delay 60ms 15ms loss 2% rate 5mbit)"
    exec unshare --user --map-root-user --net bash -c "
      ${NETNS_SETUP}
      export NETEM_ACTIVE=1
      exec \"\$@\"
    " _ "${E2E_CMD[@]}"
  elif command -v sudo >/dev/null 2>&1 && command -v unshare >/dev/null 2>&1 && probe_netem_sudo; then
    echo "[impaired-e2e] Running inside sudo netns with tc netem (delay 60ms 15ms loss 2% rate 5mbit)"
    exec sudo -n --preserve-env=CHROMIUM_BIN,PATH,HOME,DISPLAY,LD_LIBRARY_PATH,HTTP_PROXY,HTTPS_PROXY,NO_PROXY,E2E_DEBUG unshare --net bash -c "
      ${NETNS_SETUP}
      export NETEM_ACTIVE=1
      exec \"\$@\"
    " _ "${E2E_CMD[@]}"
  fi
fi

if [ "${REQUIRE_NETEM}" = "1" ]; then
  echo "[impaired-e2e] ERROR: REQUIRE_NETEM=1 set, but tc netem could not be initialized on lo" >&2
  exit 1
fi

echo "[impaired-e2e] WARNING: Linux netns/CAP_NET_ADMIN unavailable; falling back to Chromium CDP network throttling" >&2
exec "${E2E_CMD[@]}"
