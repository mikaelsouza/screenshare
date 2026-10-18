#!/usr/bin/env bash
# NixOS cannot execute the prebuilt `workerd` binaries that wrangler and
# vitest-pool-workers ship: they hardcode the FHS loader /lib64/ld-linux-x86-64.so.2,
# which does not exist here. workerd only links against glibc, so pointing it at the
# Nix loader and libc is enough to make it run.
#
# Safe to re-run, and it must be re-run after any `npm install` that repopulates
# node_modules. The `postinstall` script runs it automatically.
set -euo pipefail

if [ -z "${NIX_GLIBC:-}" ]; then
  echo "patch-workerd: NIX_GLIBC is unset — run inside 'nix develop'." >&2
  exit 1
fi

LOADER="$NIX_GLIBC/lib/ld-linux-x86-64.so.2"
[ -x "$LOADER" ] || { echo "patch-workerd: no loader at $LOADER" >&2; exit 1; }

patched=0
skipped=0
while IFS= read -r bin; do
  current="$(patchelf --print-interpreter "$bin" 2>/dev/null || true)"
  if [ "$current" = "$LOADER" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  patchelf --set-interpreter "$LOADER" --set-rpath "$NIX_GLIBC/lib" "$bin"
  patched=$((patched + 1))
done < <(find node_modules -type f -name workerd 2>/dev/null)

echo "patch-workerd: patched $patched, already-patched $skipped"
