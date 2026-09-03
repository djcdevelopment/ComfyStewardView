# ADR 0006: Exact selection-local WebGPU scenes

- Status: Accepted
- Date: 2026-09-03

## Context

The public map can identify a bounded construction selection and already has exact coordinate-backed
ZDO data. Earlier lab R&D produced a 974-prefab envelope lexicon from CAD-oriented architecture work,
but a DOM/CSS renderer reached a practical edge near 847 pieces. A browser scene must preserve the
map's evidence contract, remain useful at the observed 22,387-piece stress cluster, and avoid publishing
private ZDO fields or pretending a representative sample is complete.

## Decision

Extend only the lab's derived public cache and public profile:

- Public-cache schema v3 joins every published BUILDING row to its full-fidelity geometry export by
  immutable ZDO index and verifies name/hash/X/Z equality. It stores sanitized position and rotation
  plus the versioned prefab-envelope catalog; the production `viewer` schema remains unchanged.
- `/api/scene` rebuilds a declarative snapshot/lens/bounds/biome scope server-side. It serves at most
  5,000 pieces directly, requires an explicit override through 25,000, and rejects larger selections.
  It never returns a sample.
- For a fixed release and scope, the response is one deterministic binary package with a JSON manifest,
  integrity-bound fixed-stride instances, family-contiguous ordering, coverage receipts, and
  selection-local coordinates.
- Piece orientation uses Unity Euler order `Ry × Rx × Rz`; rotated prefab-center offsets place oriented
  envelopes correctly. Unknown prefabs are visible red pivot markers.
- The public representation omits creator/owner identity, flags, raw fields, source paths, absolute Y,
  and absolute origin. Known versus estimated versus unknown geometry remains explicit.
- The dependency-free browser renderer requires WebGPU. It uses shared-cube instancing for shaded and
  wireframe modes, family visibility controls, framed orbit navigation, and pointer-locked free flight.
  There is no WebGL fallback; unsupported hardware receives a clear return path.
- Scene generation has a dedicated six-requests-per-minute client limiter and a one-query concurrency
  gate. A shareable URL stores only scope and override, so every open is revalidated against the active
  immutable public cache.

## Consequences

The map and 3D view describe the same exact bounded evidence, and the large selection is opt-in rather
than accidental. One compact fetch and GPU instancing keep tens of thousands of pieces within the
measured browser budget. The public cache is larger and its exporter now depends on two checksummed
geometry inputs. Envelopes are deliberately less visually faithful than native meshes, terrain,
collision, or materials; adding those would require a new provenance, disclosure, and performance
decision rather than silently broadening this one.
