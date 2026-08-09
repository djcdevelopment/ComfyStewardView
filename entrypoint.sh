#!/bin/sh
# Two-phase startup: build the DuckDB analytics cache + rendered layers once,
# then serve. The marker file makes this restart-safe: a crash mid-build
# leaves no marker, so the next boot re-runs --rebuild-cache from scratch,
# while a completed build is never rebuilt (serve mode only reads the cache).
set -eu

WORLD_FILE="${WORLD_FILE:-/world/ComfyEra16.db}"
CACHE=/data/world-cache.duckdb
RENDER=/data/rendered
MARKER=/data/.cache-complete
# UI override, pushed by tools/Push-StewardUi.ps1. Empty is the normal state on a
# fresh volume and means "serve the copy baked into the jar".
STATIC=/data/static

if [ ! -f "$MARKER" ]; then
  echo "[entrypoint] no cache marker - running batch build (cache + rendered layers)"
  java $JAVA_OPTS -jar /app/world-viewer.jar "$WORLD_FILE" \
    --rebuild-cache --cache "$CACHE" --render-layers --render-dir "$RENDER" \
    --batch-only --no-browser
  touch "$MARKER"
  echo "[entrypoint] batch build complete"
fi

mkdir -p "$STATIC"

echo "[entrypoint] starting viewer"
exec java $JAVA_OPTS -jar /app/world-viewer.jar "$WORLD_FILE" \
  --cache "$CACHE" --render-dir "$RENDER" --static-dir "$STATIC" \
  --port 8003 --no-browser
