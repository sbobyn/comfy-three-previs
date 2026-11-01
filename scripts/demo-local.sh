#!/usr/bin/env bash
# Build the read-only demo (dist-demo/) from the bundled starters, with nothing else running:
#   pnpm run demo:local
# Loads examples/starters into a temporary data dir, starts a temporary server on it (no credentials, no paid
# execution), runs `pnpm run demo:build` against it, then stops the server and removes the temp dir.
# Serve the result under /comfy-three-previs/, e.g.:
#   mkdir -p www && ln -s "$PWD/dist-demo" www/comfy-three-previs && (cd www && python3 -m http.server 5393)
# Needs ffmpeg and ffprobe on PATH (or PREVIS_FFMPEG / PREVIS_FFPROBE). DEMO_PORT picks the server port.
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d "${TMPDIR:-/tmp}/previs-demo.XXXXXX")
SERVER_PID=
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

port=${DEMO_PORT:-5320}
if [ -z "${DEMO_PORT:-}" ]; then while (: <"/dev/tcp/127.0.0.1/$port") 2>/dev/null; do port=$((port + 1)); done; fi

echo "demo:local: loading the bundled starters into $TMP/data"
node scripts/import-starters.mjs --data-dir "$TMP/data" --force >"$TMP/import.log" 2>&1 || { cat "$TMP/import.log"; exit 1; }
echo "demo:local: temporary read-only server on :$port"
env -i HOME="$HOME" PATH="$PATH" PORT="$port" PREVIS_DATA_DIR="$TMP/data" PREVIS_COMFY_URL=http://127.0.0.1:9 \
  ${PREVIS_FFMPEG:+PREVIS_FFMPEG="$PREVIS_FFMPEG"} ${PREVIS_FFPROBE:+PREVIS_FFPROBE="$PREVIS_FFPROBE"} \
  node server/previs/server.mjs >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$port/api/director/projects" >/dev/null && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$port/api/director/projects" >/dev/null || { cat "$TMP/server.log"; echo "demo:local: the server did not start" >&2; exit 1; }
PREVIS_URL="http://127.0.0.1:$port" PREVIS_DATA="$TMP/data" pnpm run demo:build
echo "demo:local: done → dist-demo/"
