# ADR 0004: Isolated `/world/` deployment

- Status: Accepted
- Date: 2026-09-03

## Context

The public map runs on the same host as the existing Steward service. A map release must not mutate the
production database, replace the production container, reset existing Tailscale Funnel routes, or make
rollback depend on reconstructing an ad hoc build.

## Decision

Deploy the public profile as a separate `steward-world` container on loopback port 7081 and mount it at
the additive `/world/` path. The container:

- mounts the derived cache, analysis artifacts, and terrain package read-only;
- runs as an unprivileged user with a read-only root filesystem, dropped capabilities, bounded CPU and
  memory, and a dedicated executable temporary filesystem for DuckDB JDBC;
- receives a versioned source release and reports that release through health/bootstrap metadata; and
- never mounts the production DuckDB file.

`Deploy-World.ps1` validates source manifests, snapshot identity, checksums, available capacity, remote
paths, and feedback configuration before replacement. After startup it verifies the narrow public API,
expected denials, terrain assets, biome queries, paging, OAuth route shape, and both `/world/` and the
unchanged `/steward` health. It prints an additive Funnel command only when the route is absent.

The deployment source must be a clean Git revision and is archived from the committed `lab/` tree,
not from platform-normalized working-tree bytes. This keeps the release label exact and preserves LF
entrypoint bytes when staging from Windows.

Binary scene responses leave transfer length and compression framing to Javalin/Jetty. The release
gate requests both exact scene fixtures with compression negotiation enabled, matching the behavior of
the Funnel reverse proxy and preventing an internally readable but externally truncated response.

## Consequences

The public view can be released and rolled back independently, with a short container replacement
window rather than a production-service migration. The host carries another image, cache, and release
tree, so disk retention must be managed. Deployment is intentionally opinionated about AM4 and Comfy
Era 17 until a second public world justifies generalizing it.
