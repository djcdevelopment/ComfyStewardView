# Selection-to-3D R&D retrospective — 2026-09-03

## Outcome

The public Comfy Era 17 map can now turn an inspected green area into an exact, shareable WebGPU scene
in a new tab. The scene keeps every selected BUILDING ZDO through 5,000 pieces, or through 25,000 after
an explicit confirmation. It preserves position, rotation, prefab family, geometry confidence, and the
scope that produced the selection while withholding private identity and absolute-origin data.

This closes a long R&D loop. Earlier experiments moved architectural source material through a
multi-step CAD/geometry workflow, reconstructed Valheim building assemblies, and explored orthographic
wireframe/shaded presentation. The public map supplied the missing product entry point: its coordinate-
backed selection already knew which ZDOs belonged together. The useful promotion was therefore not a
second generalized model viewer, but a narrow bridge from an evidence-backed 2D inspection to the same
exact pieces in a freely navigable 3D frame.

## What `/rnd` mode means

`/rnd` is a working discipline for uncertain engineering edges:

1. Isolate one uncertainty and state a falsifiable prediction before broad implementation.
2. Use the smallest real-data fixture that can disprove the idea; synthetic data alone cannot retire a
   world-format, transform, density, or rendering risk.
3. Keep the probe reversible and outside the production contract. Raw screenshots, hashes, counts, and
   timings are receipts, not polish.
4. Stop at the first meaningful failure edge, learn why it exists, and change the representation or
   boundary rather than hiding it.
5. Once the shape is stable, encode it in deterministic tests, an ADR, deployment verification, and
   user-facing language before calling it a feature.

That is not permission to skip rigor. It changes the order of rigor: evidence first, commitments second.
The DOM/CSS prototype exposing a practical edge around 847 pieces was useful precisely because it failed
cheaply. It ruled out scaling that representation and focused the next probe on one binary fetch,
instancing, and WebGPU. The public limits were then set around measured user intent and hardware behavior,
not around an arbitrary database page size.

## R&D lineage

The working lineage was:

```text
Valheim prefab dump and mod/game geometry observations
  → normalized prefab geometry lexicon
  → full BUILDING position/rotation Parquet export
  → clustered architectural reconstruction and CAD/replica experiments
  → oriented envelope and pivot validation
  → DOM/CSS wireframe probe and its density edge
  → selection-local binary scene package
  → shared-cube WebGPU shaded/wireframe renderer
  → exact public map inspection link
```

The integrated `lab/` subdirectory owns the final cache exporter, service endpoint, browser client,
regression harness, deployment gate, and decision record. Historical source experiments remain inputs,
not runtime dependencies or public downloads.

## Input and export receipts

Snapshot 107 is pinned by source world SHA-256
`3acee92b99f37ec991b85bddf031760a8eeef5261ef25005a1e173547f1f49c7`.

| Input | Role | SHA-256 |
|---|---|---|
| `E:\omen\steward-era17\out\world-cache.duckdb` | Production analytics source, opened read-only during export | Bound by the snapshot hash above |
| `E:\omen\steward-era17-arch\building-geometry.parquet` | Full BUILDING position/rotation receipt keyed by ZDO index | `45d8642551ca904fbba0ddfe51f15294977ad3087fc530d5a41c86d99558691b` |
| `C:\work\baseline\tools\selfie-stick\out\era17\arch\piece-geometry.json` | Normalized prefab envelope/family catalog | `74ecc5e164766defa5553251aaa8bb8115d2e8f7d1d7cebb5826917b350bd86c` |
| Context biome mask | Authoritative territory membership | `e0bad1949deec16b3971c34d8082d5d053d6edd37673e666c3e7789687b41c8d` |

The exporter failed closed unless all 4,359,570 published BUILDING rows joined by ZDO index and matched
prefab name/hash and X/Z coordinates. Public-cache v3 was 168,308,736 bytes with SHA-256
`ced2c5b3eeb3b4bde818e1568d2d72046286c37a8e0100542f299efb08af21a8`.

| Geometry class | Rows | Share of published BUILDING rows |
|---|---:|---:|
| Real measured envelope | 4,305,146 | 98.75% |
| Estimated envelope | 16,721 | 0.38% |
| Unknown, explicit pivot marker | 37,703 | 0.86% |
| Total | 4,359,570 | 100% |

The catalog has 974 prefab entries. Unknown rows are not silently dropped: each receives a 0.35 m red
pivot marker, keeping scene count and spatial evidence exact even when visual fidelity is unknown.

## Predictions and measured edges

Before promotion, the acceptance prediction was that a single compact package plus instanced shared-cube
geometry could keep both a representative village selection and the largest intended opt-in selection
inside a 2,000 ms startup and 20 ms p95 frame budget on hardware WebGPU, with no validation errors or
device loss. Exact population and geometry-coverage counts had to match the server query; sampling was a
failure, regardless of frame rate.

| Probe | Exact scope | Result |
|---|---|---|
| Pilot | X `467.8..511.6`, Z `5501.4..5535.9` | 862 pieces; 862 real; 13 families; 68,960 instance bytes; 367.0 ms startup; 16.9 ms p95 |
| Forced stress | X `2021.7..2101.9`, Z `-4851.3..-4751.8` | 22,387 pieces; 22,199 real + 188 unknown; 13 displayed families including Unknown; 1,790,960 instance bytes; 210.2 ms startup; 16.9 ms p95 |

Both probes ran for 300 measured frames on hardware-classified Intel Xe-LPG WebGPU. Both passed shaded
and wireframe rendering, family filtering, orbit and free-flight camera exercises, deterministic package
integrity, zero browser/WebGPU validation errors, and zero device loss. The 22,387-piece result also
proved the confirmation lane. The same scope without `override=true` returned 409; a forced whole-world
request returned 413 instead of allocating a package.

The pilot instance SHA-256 was
`3fc0ca61ccddde927b14049f76818816d9d71ae3187b189d5e5ca66a47083c93`; the stress instance SHA-256 was
`5e530097f4f634476e637642e4700fdb384aa9bdb71f1546453c3c0abf6bb78a`.

## Decisions that survived contact with the data

- WebGPU, not OpenGL terminology or a WebGL compatibility layer, is the browser contract. Unsupported
  browsers get a plain explanation and a route back to the map.
- A package contains matrices and extents, not duplicated cube vertices. Family-contiguous ordering
  keeps draw calls bounded and permits local visibility changes without a refetch.
- The Unity transform is reconstructed as `Ry × Rx × Rz`, with the local geometry-center offset rotated
  before translation. Mirroring X creates a right-handed browser frame without changing selection shape.
- The scene origin is the selection center and the floor is relative. This improves floating-point and
  camera behavior while avoiding disclosure of an absolute 3D origin.
- A shareable URL is a query recipe. The server rebuilds the package against the currently active,
  immutable public cache instead of accepting serialized object lists from the browser.
- The 2D map may use a deterministic representative sample for context while retaining complete totals.
  The 3D view may not: it either receives the complete selection or refuses it.
- The production `viewer` schema stays untouched. Sanitized geometry lives only in the replaceable lab
  derivative, maintaining the repository's two-application and two-deployment-lane structure.

## What went well

The strongest shortcut was recognizing that the hard acquisition work already existed. Snapshot IDs,
ZDO indices, prefab hashes, X/Z positions, biome masks, and full rotation exports could be joined and
proved rather than re-derived in JavaScript. That changed the browser task from “understand a Valheim
save” to “render a verified package.”

The prediction ledger also prevented a visually compelling pilot from ending the experiment too early.
The 862-piece scene proved transforms and interaction; the 22,387-piece scene proved the representation
and resource boundary. Treating unknown geometry as evidence instead of cleanup kept the stress result
honest.

Finally, keeping the work under `lab/` made promotion safe. The public cache, endpoint, static scene,
tests, and deployment checks are cohesive, while `/steward/` remains independently built and deployed.

## What was difficult

Three coordinate systems had to agree: Valheim/Unity world transforms, prefab-local envelope centers,
and the browser's right-handed camera space. Axis-aligned dimensions looked plausible even when rotation
order or center-offset handling was wrong, so unit tests had to assert matrices and rotated bounds rather
than screenshots alone.

“Exact” also forced a stricter API design than the 2D UI. A selection can have a complete aggregate,
paged rows, and a useful representative map sample simultaneously; none of those samples can stand in
for an explorable building. The direct/confirmed/refused thresholds therefore belong to both UI and
server, with the server authoritative.

The geometry catalog originally appeared complete when filtered to only catalog rows marked BUILDING,
but that produced 914 entries and lost legitimate matches. Exporting all 974 normalized lexicon entries
and measuring coverage against actual snapshot BUILDING rows fixed the category-assumption error.

The first clean remote release attempt found one more boundary: `core.autocrlf` had left the local shell
entrypoint with CRLF bytes even though Git stored it as LF. Archiving the working tree built a valid image
whose Linux entrypoint could not execute. The previous verified container was restored immediately; the
deployment tool now refuses dirty trees and archives its source from the committed `lab/` tree through Git.
That makes source bytes, release SHA, and platform line endings one auditable unit.

## Verification commands

```powershell
.\mvnw.cmd test
python -m unittest discover -s tools\tests -p 'test_*.py'
node --check src\main\resources\static\lab.js
node --check src\main\resources\static\scene.js
node --check tools\browser-smoke.mjs
node --check tools\scene-browser-smoke.mjs
node tools\browser-smoke.mjs http://127.0.0.1:8092/ data\scene-map-regression.png --public-inspect --terrain --biomes --terrain-close
node tools\scene-browser-smoke.mjs http://127.0.0.1:8092/ data\scene-browser-smoke-rnd
```

Deployment repeats the pilot, direct stress denial, forced stress package, over-cap denial, public-map
health, and `/steward/` health against the staged immutable cache before declaring success.

## Remaining limits and next experiments

- Envelopes communicate assembly, orientation, density, and navigation—not exact meshes, materials,
  terrain, collision, wear state, or interiors. Those are separate evidence and performance questions.
- The hardware receipt covers the release workstation's Intel path. Broader device/browser telemetry is
  useful, but should not weaken the explicit unsupported state.
- Object picking, prefab labels in-world, first-person collision, terrain, and native mesh streaming may
  improve exploration. Each should begin as a separate `/rnd` prediction rather than accreting into the
  initial scene contract.
- A future era needs a new immutable cache export and receipts; a share URL deliberately does not pin or
  smuggle an obsolete binary scene.

## Lasting lesson

The breakthrough was not a new renderer in isolation. It was joining years of exploratory geometry work
to a small, authoritative product transition: select evidence on the map, then step inside exactly that
evidence. `/rnd` mode made the long path productive because every prototype was allowed to answer one
question, expose its own edge, and hand a narrower truth to the next experiment.
