# ADR 0007: Metrics-gated prefab representations

- Status: Accepted
- Date: 2026-09-03

## Context

Exact selection-local scenes proved that coordinate-backed ZDO membership and shared-box WebGPU
rendering scale well, but one envelope per prefab is not always an honest visual representation.
Environmental entries can become enormous featureless blocks, while compound structures such as a
windmill lose their recognizable moving parts. The existing selfie-stick corpus contains thousands of
snapshot-matched Valheim frames and camera receipts, and a local game client can observe renderer bounds.
Neither source should become a public image/asset API, and a visually appealing one-off comparison is not
enough evidence to change every placed instance of a prefab.

## Decision

- Public-cache schema v4 adds two small, checksummed tables: an exact-name representation catalog and
  optional promoted primitive matrices. The exporter requires representation name/hash agreement with
  the geometry catalog and binds both the catalog and promotion receipt into release metadata. The
  production `viewer` schema remains unchanged.
- Context classification is an explicit name-and-hash list, never a substring or family heuristic.
  Context entries are small green pivot markers, hidden by default and excluded from camera framing.
  Fires, furniture, logs, and stumps are not reclassified. Unsafe uncataloged envelopes retain the
  existing red-marker guardrail.
- A private BepInEx probe may generate compound candidates from active LOD0 renderer bounds. Its receipt
  records game version, prefab name/hash, at most 32 affine box matrices, and observed animation axis and
  pivot. It excludes meshes, materials, textures, colliders, particles, trails, and line renderers. A
  probe receipt is evidence, not permission to publish a representation.
- The non-public `/rnd/fidelity` workbench joins external gallery images, camera/shot receipts, cluster
  bounds, exact scene scopes, and local candidates. It reproduces the recorded 65-degree vertical FOV and
  supports baseline/candidate, side-by-side, wipe, overlay, and isolated-prefab review. It streams images
  from their existing local corpus and does not copy them into this repository or a cache.
- Public mode does not register the workbench, API, or gallery image routes and never loads the local
  candidate receipt. Candidate and baseline scene variants are accepted only in non-public R&D mode.
- Promotion requires at least three matched views per fixture, median silhouette IoU of 0.50, depth
  ordering of 0.80 over at least 500 paired pixels, median IoU improvement of 0.15, no holdout regression
  beyond 0.05, and no more than 32 boxes. The checked-in promotion receipt is authoritative and can
  record rejection as a valid outcome.
- A promoted compound expands one exact ZDO into one or more render instances. Animated boxes use a
  deterministic static phase derived from `zdo_index`; saved runtime animation phase is unavailable and
  is not invented. A known compound without an accepted promotion renders as an unresolved marker.
- Scene package v2 separates exact selected `pieces` from `renderInstances`, records semantic class and
  default visibility per draw group, and limits presentation to 500,000 instances. If compound expansion
  would exceed that limit, compounds collapse to one marker each. Exact membership is never sampled or
  dropped.

The initial windmill candidate is rejected. Its four boxes improved median silhouette IoU by 0.4777 and
reached 0.5050 overall, but holdout median IoU was 0.4975 and all ten depth-qualified views missed the
0.80 requirement. It remains available for local comparison; the public representation is an explicit
unresolved-compound marker.

## Consequences

Representation quality can improve incrementally without changing scene membership or publishing game
assets. Gallery evidence and the local client become repeatable calibration instruments, while exact
catalog matching, held-out metrics, and immutable receipts prevent heuristic drift and attractive
overfitting. Hidden context no longer distorts the initial camera, giant environmental blocks are less
likely, and manifests explain when one piece becomes several boxes or is reduced to a marker.

The public scene remains a proxy explorer, not a native-mesh replica. Compound fidelity advances more
slowly because rejection is expected and retained. The local workbench depends on external paths and is
intentionally unavailable when those inputs are absent. Terrain, lighting, roof reconstruction, native
meshes, and CAD alignment remain separate R&D decisions with their own provenance and acceptance gates.
