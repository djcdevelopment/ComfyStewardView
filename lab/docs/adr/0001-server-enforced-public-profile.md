# ADR 0001: Server-enforced public profile

- Status: Accepted
- Date: 2026-09-03

## Context

The spatial lab can inspect multiple snapshots and lenses and can start rendering jobs. The public map
needs one understandable community view without exposing the broader analytics cache, filesystem paths,
job controls, or experimental APIs. Hiding those controls in HTML would not create a security boundary.

## Decision

Run the same application with an explicit `--public` profile that requires a snapshot ID. In that
profile the server:

- publishes only the configured snapshot and Build density lens in bootstrap and manifests;
- validates snapshot and lens scope again for every selection, point, item, and artifact request;
- does not register render-job endpoints;
- removes private paths and provenance from public metadata;
- applies bounded-query validation, concurrency limits, and per-client rate limits; and
- reads a separately exported snapshot-only DuckDB cache.

Client-side hiding remains presentation only. It is never the sole enforcement mechanism.

## Consequences

The public route has a small, auditable answer surface and cannot become the full lab through a client
bug. Publishing another snapshot or lens requires an explicit release change and cache export. Some
logic is intentionally checked at both routing and repository layers because defense in depth is more
valuable here than eliminating every duplicate condition.

ADR 0006 extends this profile with one bounded scene-package route. It preserves the same server-side
snapshot/lens enforcement and derived-cache boundary rather than turning public mode into general ZDO
access.
