#!/bin/sh
set -eu
case "${BRIDGE_OUT:-}" in
  /*) ;;
  *) echo 'BRIDGE_OUT must be an existing absolute directory' >&2; exit 1 ;;
esac
[ -d "$BRIDGE_OUT" ] || { echo 'BRIDGE_OUT must be an existing directory' >&2; exit 1; }
BRIDGE_PORT=${BRIDGE_PORT:-7788}
case "$BRIDGE_PORT" in ''|*[!0-9]*) echo 'Invalid BRIDGE_PORT' >&2; exit 1 ;; esac
[ "$BRIDGE_PORT" -ge 1 ] && [ "$BRIDGE_PORT" -le 65535 ] || { echo 'Invalid BRIDGE_PORT' >&2; exit 1; }
BRIDGE_TOKEN=$(openssl rand -hex 24)
export BRIDGE_TOKEN BRIDGE_PORT BRIDGE_OUT
umask 077
# Exclusive creation avoids following a pre-existing descriptor symlink.
if [ -L "$BRIDGE_OUT/bridge.json" ]; then echo 'bridge.json must not be a symlink' >&2; exit 1; fi
rm -f "$BRIDGE_OUT/bridge.json"
(set -C; printf '{"url":"http://127.0.0.1:%s","token":"%s"}\n' "$BRIDGE_PORT" "$BRIDGE_TOKEN" > "$BRIDGE_OUT/bridge.json")
chmod 600 "$BRIDGE_OUT/bridge.json"
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node src/server.mjs
