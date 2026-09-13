# Eight-era second-pass intake — 2026-09-13

VERIFIED on OMEN. The eight saves that arrived on 2026-09-12 — eras 1–6 (Valheim world
formats 26–28, 2021–2022) and eras 13 and 15 — were extracted without launching Valheim, with
the lessons of the first pass applied rather than re-learned. Every declared object count
reconciles, the rebuilt parser is proven row-identical to the frozen one on the eras it
inherited, and the cross-era projection was rebuilt once, with every capture manifest named.

| Era | Format | World name | Objects | Typed fields | Inventory rows | Construction members |
|---|---:|---|---:|---:|---:|---:|
| 1 | 26 | Booty | 4624771 | 7261622 | 41497 | 672184 |
| 2 | 27 | comfy | 5945527 | 12979097 | 152632 | 2172386 |
| 3 | 28 | ComfyEra3 | 6686661 | 13130289 | 142913 | 1910715 |
| 4 | 28 | ComfyEra4 | 5199780 | 12048036 | 151260 | 1857300 |
| 5 | 28 | ComfyEra5 | 8167336 | 16986357 | 209270 | 2456847 |
| 6 | 28 | ComfyEra6 | 6641613 | 17846259 | 274530 | 3089696 |
| 13 | 35 | ComfyEra13 | 7719355 | 59657671 | 302064 | 3646771 |
| 15 | 36 | ComfyEra15 | 8766148 | 79631812 | 397997 | 4700174 |

Totals for the eight: **53,751,191 objects**, **219,541,143 typed fields**, **1,672,163
inventory rows**, **1,165,136 exact payloads**, **20,506,073 construction memberships**. The
catalog now holds sixteen verified eras (113,763,557 declared objects); the projection holds
597,100 build albums, 7,360 builders and **14,016 photographs from ten capture manifests** —
the count the deployed era-11 refine release published, restored after the 2026-09-12 era-16
rebuild had dropped every capture import.

## What the first pass taught, and what changed

- **One bad file no longer aborts intake.** `archive.py inventory` judges each save on its
  own, writes `intake-report.json` (accepted, rejected with reasons, catalogued eras whose
  source did not answer), and keeps a catalogued era whose source is missing. The two
  pre-convention worlds (`Booty`, `comfy`) take their era from the archive folder; the
  catalog records `worldId` (what the game calls the save) beside `archiveWorldId`
  (`ComfyEraN`, what every snapshot is stamped with).
- **Formats 26–28.** The legacy decoder already read 29–30; the only difference below is that
  the byte-array property group arrived at v27, so a v26 package carries six counts. One
  version gate (`records.MIN/MAX_WORLD_VERSION` = 26/37) is mirrored in `WorldParser` and a
  test asserts they agree. A read-only walk of every record in all six saves preceded the
  change; the ingest gates (declared == rows == distinct index, geometry membership) and the
  payload identity check passed on all six after it.
- **A rebuilt parser must earn its place.** `archive.py parser-check` re-parses named verified
  eras with the candidate jar into scratch and requires every content table to be
  row-identical (`EXCEPT ALL` both ways) before recording the jar in `catalog.parsers` as
  superseding the old digest. Jar `35447e3d…` passed on era 7 (legacy path, 19.5 M field rows)
  and era 16 (compact path, 81.8 M) and is what ingested the eight.
- **Every stage after ingest covers exactly the verified eras**, so a pending era in the
  catalog no longer breaks the read-model rebuild.
- **The driver remembers the flags.** `Invoke-EraArchive.ps1` reads `run-manifest.json`
  (legacy galleries, curated links, every capture manifest), snapshots `analysis/` first,
  runs the cross-era rebuild once, cleans stale candidates and headless-Chrome profiles, and
  writes `runs/<stamp>/run-receipt.json`; `run_receipt.py` fails the run if the projection
  imported fewer manifests than the run manifest names. `community.py` refuses the same
  loss on its own. Run `20260913T042116Z`: nine stages, 7.5 minutes, no failures,
  integrity verified over sixteen eras, 23 stale items removed.
- **Build identity backfilled in place.** Seven first-pass analyses predated `templateKey`;
  it is derived from the saved membership, so the cached receipts caught up without a key
  moving, and the coverage queue now deduplicates stamped lots in every era.
- **The game's own account is kept.** `load_census.py` reads what the client counted on load
  (declared objects, data version, unresolved prefabs, every conversion pass, objects saved
  back) from `Player.log` into the terrain receipt, on both client generations.
  `converted_worlds.py` keeps the v37 rewrite a 0.221.12 session leaves behind and compares
  it with the frozen package: era 7 lost 2,945 of 2,746,682 construction pieces in
  conversion (0.107 %) and gained none; era 12 lost none. The parser reads the original
  bytes; it never under-reads what the game keeps.

## Photography: compare and reshoot

Per the 2026-09-12 calibration (`baseline/docs/evidence/2026-09-12-refine-loop-calibration/`)
the refine fan is a measured regression and is off: `refine_worker.py` shoots every planned
pose once, moves the camera only off a vetoed one, and `--rounds` defaults to 0.
`frame_judge.replay_pairs` pins the bar any between-pose rule must beat (25 of 43 decided
pairs; the fan's own rule scored 18). `plan_detail_shots.py` now plans up to five
forecast-ranked poses per build across its masses, with the build's principal axis and
typology (harvested from deepagents-shot-director) as the prior; `rank_frames.py` prunes on
AM4 (veto, duplicates, forecast, then the two statistics the eye favoured) so only
thumbnails of 1–3 survivors travel; `light_table.py` is the committed instrument
(build-pairs, page, harvest; the 77-pair round trip reproduces the committed verdicts);
`import_captures.py --verdicts` publishes exactly what the eye kept. `subject_gate.py`
removes bare floors and debris before any shutter with two physically stated rules — the
fitted-threshold attempt is recorded and rejected in
`baseline/docs/evidence/2026-09-13-subject-gate-calibration/`.

`prepare_campaign.py` chains coverage plan → orbit campaign → subject gate → detail poses →
refine root under `campaigns/<era>/`. Eight campaigns are prepared and **not dispatched**:
9,870 planned poses over 2,461 builds, 18 bare-floor lots gated out (≈102 GB of 4K masters on AM4 if every pose of every era were shot at once; 7–17 GB per era, pruned after verdicts).

## Terrain and world view

All eight worlds are staged and hash-verified on AM4 (`staged-worlds/`). The first launch
overturned a premise: AM4's client is **Valheim l-1.0.7** (assembly dated 2026-09-11), not
the 0.221.12 that shot era 14 — so no host holds the old instrument any more, and the eight
new eras' terrain and photographs are 1.0.x, recorded as such per receipt (`gameBuild`,
`loadCensus.gameVersion`). Three things had to change in `am4_terrain_cache.py` before era 13
produced a receipt: the launch is the capture worker's (fullscreen 3840x2160 — `-batchmode`
with a windowed surface segfaults under Vulkan on this host), the cache wait accepts either
generation and decodes the 1.0 gzip set through the new shared `terrain_caches.py` (moved out
of the OMEN harness), and the seed check reads the staged `.fwl` because the client renames
the original on quit. `--no-handoff` lets the worker run with no campaign; the chunked
`_main.1.db2` re-save is described by digest, not copied. Three failed attempts are kept
under `runs/` with their reasons in the directory names.

All eight receipts landed (`import_am4_terrain.py` brings them into the lake in the OMEN
receipt shape, digests re-checked, the load census re-read on this side) and all eight
terrain contexts were built by `omen_biome_context.py` (`world-view-v3/terrain-schema3-20260913-am4/`).
Eras 1, 2, 3, 5 and 6 loaded under **world generator 1** — the client keeps the
pre-Mistlands terrain for those saves. Era 4 is the one exception worth knowing: the 1.0.7
client converted it and then refused it (`EndOfStreamException` in `Inventory.LoadOld`, one
malformed item string in one container), bounced to the menu, and the worker harvested the
seed-checked minimap caches it had already written; the receipt records
`loadCensus.worldLoadFailed` and the context binds generator 1 (the wrapper now reads the
generator line that precedes `Load world:`, not the menu's afterwards). The archive of era 4
is unaffected — the parser and the payload identity check both passed — but **no 1.0.x client
can photograph era 4 until that container is repaired in a derived working copy**.

Validation: viewer Java suite (LegacyZdoDecoderTest across 26/27/29); 198 era-archive Python
tests; 91 selfie-stick tests. Artifacts under `E:\omen\steward-multi-era`: `catalog.json`
(`parsers`), `intake-report.json`, `run-manifest.json`, `runs/20260913T042116Z/`,
`parser-check/<sha>/receipt.json`, `converted-worlds/<era>/{receipt,check}.json`,
`campaigns/<era>/prepare-receipt.json`, `am4-staging-20260913/`.
