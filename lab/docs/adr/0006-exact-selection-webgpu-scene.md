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
  5,000 pieces directly, requires an explicit inline override through 250,000, and rejects larger
  selections before materializing their rows. It never returns a sample. Heatmap and Biomes expose the
  gate in the same right-column inspection card. Whole-biome queries intentionally span every matching
  territory in the published bounds and must be labeled as worldwide in the map handoff and scene.
- For a fixed release and scope, the response is one deterministic binary package with a JSON manifest,
  integrity-bound fixed-stride instances, family-contiguous ordering, coverage receipts, and
  selection-local coordinates.
- Piece orientation uses Unity Euler order `Ry × Rx × Rz`; rotated prefab-center offsets place oriented
  envelopes correctly. Unknown prefabs are visible red pivot markers. Non-finite bounds,
  an envelope axis over 20 m, or proxy volume over 2,000 m³ are treated as unsafe catalog proxies and
  reduced to the same marker while retaining and counting their ZDOs.
- The public representation omits creator/owner identity, flags, raw fields, source paths, absolute Y,
  and absolute origin. Known versus estimated versus unknown geometry remains explicit.
- The dependency-free browser renderer requires WebGPU. It uses shared-cube instancing for shaded and
  wireframe modes, family visibility controls, mouse-orbit navigation with WASD/QE travel, and pointer-locked free flight.
  The current camera, surface, and visible families can be captured directly from its canvas as a PNG.
  There is no WebGL fallback; unsupported hardware receives a clear return path.
- Compact scenes frame every piece. When a selection spans more than 600 m on any axis, a deterministic
  64 m three-dimensional density grid supplies a local **Home** frame; **Frame all** retains the complete
  selection view. This changes only the starting camera, never scene membership.
- Scene generation has a dedicated six-requests-per-minute client limiter and a one-query concurrency
  gate. A shareable URL stores only scope and override, so every open is revalidated against the active
  immutable public cache.

## Consequences

The map and 3D view describe the same exact bounded evidence, and the large selection is opt-in rather
than accidental. One compact fetch and GPU instancing keep large selections within the measured browser
budget; PNG export reuses that representation rather than introducing server-side image generation.
The public cache is larger and its exporter now depends on two checksummed geometry inputs. Envelope
guardrails sacrifice the apparent size of environmental/compound outliers to preserve useful framing
and honest geometry confidence. Envelopes remain less visually faithful than native meshes, terrain,
collision, or materials; adding those would require a new provenance, disclosure, and performance
decision rather than silently broadening this one.
