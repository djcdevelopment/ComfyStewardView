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

# --render-layers on the serve process, not as a second batch run. The marker above means "the
# cache is built", not "the rasters match this jar", so without a render pass here a bump to a
# render schema could never reach a volume that had already been built once - the deployment
# would keep serving rasters the new code refuses to accept, and the map would silently fall
# back to snapshot mode. Rendering is version-aware and idempotent, so a current volume costs a
# few seconds of manifest checks. It goes here rather than in a second java invocation because
# Main parses the world before doing anything else: a separate batch run would re-parse the
# 1.3 GB world on every container start, while this process has to parse it anyway.
echo "[entrypoint] starting viewer (refreshing any stale rendered layers first)"
exec java $JAVA_OPTS -jar /app/world-viewer.jar "$WORLD_FILE" \
  --cache "$CACHE" --render-layers --render-dir "$RENDER" --static-dir "$STATIC" \
  --port 8003 --no-browser
