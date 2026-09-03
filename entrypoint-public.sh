#!/bin/sh
set -eu

: "${CACHE_PATH:=/data/world-cache.duckdb}"
: "${ARTIFACTS_PATH:=/artifacts}"
: "${CONTEXT_MANIFEST:=/context/manifest.json}"
: "${SNAPSHOT_ID:=107}"
: "${PUBLIC_URL:=https://am4.tail8e749c.ts.net/world/}"
: "${STEWARD_RELEASE_VERSION:=dev}"

exec java ${JAVA_OPTS:-} -jar /app/steward-spatial-lab.jar serve \
  --cache "$CACHE_PATH" \
  --artifacts "$ARTIFACTS_PATH" \
  --context-manifest "$CONTEXT_MANIFEST" \
  --bind 0.0.0.0 \
  --port 8091 \
  --snapshot "$SNAPSHOT_ID" \
  --public \
  --public-url "$PUBLIC_URL" \
  --release-version "$STEWARD_RELEASE_VERSION" \
  --no-browser
