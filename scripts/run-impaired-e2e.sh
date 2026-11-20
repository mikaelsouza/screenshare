#!/usr/bin/env bash
set -euo pipefail

E2E_CMD=(node --test --test-concurrency=1 --test-force-exit test/e2e/impaired/impairment.test.ts)

if [ "$(uname -s)" = "Linux" ] && command -v tc >/dev/null 2>&1 && command -v ip >/dev/null 2>&1; then
  # Try unprivileged netns first; if AppArmor restricts unprivileged userns (Ubuntu 24.04),
  # try passwordless sudo netns so host loopback is never mutated.
  if command -v unshare >/dev/null 2>&1 && unshare --user --map-root-user --net true 2>/dev/null; then
    echo "[impaired-e2e] Running inside user+net namespace with tc netem (delay 60ms 15ms loss 2% rate 5mbit)"
    exec unshare --user --map-root-user --net bash -c '
      set -euo pipefail
      ip link set lo up
      tc qdisc add dev lo root netem delay 60ms 15ms loss 2% rate 5mbit
      export NETEM_ACTIVE=1
      exec "$@"
    ' _ "${E2E_CMD[@]}"
  elif command -v sudo >/dev/null 2>&1 && command -v unshare >/dev/null 2>&1 && sudo -n unshare --net true 2>/dev/null; then
    echo "[impaired-e2e] Running inside sudo netns with tc netem (delay 60ms 15ms loss 2% rate 5mbit)"
    exec sudo -n --preserve-env=CHROMIUM_BIN,PATH,HOME unshare --net bash -c '
      set -euo pipefail
      ip link set lo up
      tc qdisc add dev lo root netem delay 60ms 15ms loss 2% rate 5mbit
      export NETEM_ACTIVE=1
      exec "$@"
    ' _ "${E2E_CMD[@]}"
  else
    echo "[impaired-e2e] WARNING: Linux netns/CAP_NET_ADMIN unavailable; falling back to Chromium CDP network throttling" >&2
  fi
else
  echo "[impaired-e2e] Non-Linux or missing tc/ip; running with Chromium CDP network throttling fallback"
fi

exec "${E2E_CMD[@]}"
