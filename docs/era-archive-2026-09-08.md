# Seven-era archive intake — 2026-09-08

VERIFIED on OMEN. The seven original DB/FWL pairs were extracted without launching Valheim. All declared object counts reconcile, reruns produce seven verified cache hits, and the combined DuckDB was reconstructed from archived Parquet. Original hashes were rechecked after extraction and at final integrity verification.

| Era | Objects | Typed fields | Inventory rows | Construction members | Quarantined positions |
|---|---:|---:|---:|---:|---:|
| 7 | 7049984 | 19515582 | 282749 | 2746682 | 0 |
| 8 | 6840281 | 21877635 | 322548 | 3092090 | 0 |
| 9 | 7024585 | 35291871 | 275966 | 3153849 | 0 |
| 10 | 7342406 | 48451528 | 360047 | 3291909 | 8 |
| 11 | 7209960 | 50504629 | 417242 | 3008433 | 0 |
| 12 | 7373045 | 52759877 | 382992 | 3105792 | 0 |
| 14 | 8016512 | 65486241 | 325456 | 3652409 | 0 |

Totals: **50,856,773 objects**, **293,887,363 typed fields**, **2,367,000 inventory rows**, **593,849 exact binary/inventory payloads**, and **22,051,164 spatial construction memberships**. Eight non-finite construction positions in Era 10 remain in the original data and a spatial quarantine.

The private community tables contain 3,328 observed character identities, 12,033 name observations, 318,319 build albums and 283,476 contribution rows. The public directory includes 2,747 identities with construction or historical photo attribution. **5,176 of 5,200 historical photos** have recorded creator attribution; the other **24** remain in their original galleries pending attribution. Names alone do not join characters. Full historical cluster membership is unresolved and is labeled accordingly.

VERIFIED: seven CPU raster ladders at 320/160/80/64/16 m; 21 pilot builds and 84 validated exterior-shot TSV rows. The larger queue contains 234,927 manually dispatched candidates; it is a coverage-prioritized candidate inventory, not a commitment to photograph every remnant.

BLOCKED for historical terrain and new photography: era-matched runtimes, measured runtime prefab availability, isolated cache-generation adapters and capture-plugin compatibility. Unknown dictionary names are audited separately from missing runtime assets. Publication gates use measured 5% per-era and 10% per-selected-build thresholds. Existing Era 17 terrain, item inspection, scene limits and PNG behavior are retained.

Validation: complete viewer and lab Java suites; seven archive Python tests; twelve terrain/promotion Python tests; JavaScript syntax checks; browser search, historical thread, pending-era isolation, era switching, terrain and item-inspection checks. No feedback message or OAuth login was submitted during testing.

Reproduce with the [pipeline runbook](../tools/era-archive/README.md). Operator artifacts are under `E:\omen\steward-multi-era`: `catalog.json`, `world-cache.duckdb`, `analysis/read-model.json`, `validation/integrity.json`, `validation/browser/receipt.json`, `raster-jobs/catalog.json` and `pilots/<era>/plan.json`. Preserve the private identity registry and curated links with archive backups.

The ingestion parser is pinned by SHA-256 `6cae91977a4ba7c094342bb04a81a8dc7b11f7b6bcb5ace3827e38c4ea1bd173` (93,731,603 bytes). Migrated helpers came from pushed Baseline revision `7a30d2d7f5319008cf811db9bdbf9bb3e4b404fa`; their transfer receipt records original source bytes before Steward modifications.

## Publication verification

VERIFIED live on 2026-09-09 UTC:

- [Creator directory](https://fx99.tail8e749c.ts.net/valheim/creators/): release
  `c921457977a5-a44dac4f2df4`, 5,498 files verified before activation. Navigation
  was added to the current gallery and Era 16 page. Photo indexes and assets retain
  their existing URLs.
- [World catalog](https://am4.tail8e749c.ts.net/world/): release
  `b245c3875560-7222471ddccd`. Candidate and active-container checks passed. Era 17
  remains ready; all seven new archives report `awaiting-runtime`. Requests for
  pending or mismatched eras cannot return the active era's data.
- Live browser checks passed for creator search, a nine-era historical thread,
  pending terrain, era switching and request scoping. The existing 862-piece 3D
  pilot passed camera/control checks and produced a 1264×900 PNG (300,079 bytes),
  with no browser or WebGPU validation errors.
- Validation counts: viewer 18 Java tests; lab 34 Java tests; archive 7 Python tests;
  terrain/promotion 12 Python tests. Baseline's 104 unit tests, 8 corpus tests,
  deterministic projection check and entrypoint-link test also passed.

Operator receipts: `validation/deploy-gallery.json`, `validation/deploy-world.json`,
`validation/browser-live/receipt.json`, `validation/scene-live/receipt.json` beneath
the processing root. AM4 retains the previous stopped world container
`steward-world-before-b245c3875560-7222471ddccd` for rollback. No Funnel route or
`/steward` deployment was changed. Historical runtime prerequisites remain as listed
above; this release does not claim new historical terrain or photography is complete.

## Original source hashes

- Era 7 DB: `3419099c08c2d970af9e9e8ae675c64c85e156e566c0835b44e5ce7b2d4fda28` (991526610 bytes); FWL: `f205e7357324963102f2772e2d1e96bdc580822cde60c87a67f12c4cb4aa174a` (42 bytes).
- Era 8 DB: `1870c193edfad949be4aae3c3a1d1b0aa49e1b25cdbff4eb46f9be49e7d55d89` (1000337058 bytes); FWL: `45d80441be3f73047dffdf3c34c84dc6338fe575d35ca2a2b452968d79d8051b` (42 bytes).
- Era 9 DB: `f07c09f654022088fb5946b68c8818ccc0c7a8d50fbecefdd7aaf572bf17ce43` (721713952 bytes); FWL: `a15d0c267ff2501d81042096fe7530bd00c72f724fe6516766a1f5f90a825914` (50 bytes).
- Era 10 DB: `bf2983dd69d134f39087901f49d4099ff87916adf26a38537ee70ed194a0cb9f` (947272970 bytes); FWL: `24ee684d7df9338845a079ca8281a409275f9931ef04639624f93f77d3d1df7e` (48 bytes).
- Era 11 DB: `669577ea12a2e85516d451efb7a4fd96716599e3274b2b99b353b7b47a053267` (939354876 bytes); FWL: `1094304e320d73e28677d16b8eb1fdca2eba14615c9781e2fa5bb84f82380f57` (72 bytes).
- Era 12 DB: `2b7e70fa860f51cd288f815ae7f789a10e55fc6787e057ee4f604e48fc4b3863` (945596062 bytes); FWL: `8c0f84d5add36352422409acf12ee3623791a77ca2434bdaadfa0529cf2800b3` (72 bytes).
- Era 14 DB: `fec4871a396dff5a1ec919a64ca535d7289a9021aa517e069d243c2614b86f68` (1100176663 bytes); FWL: `37e4b1635151c9217475566629e689e3883252ec4bcfafccc9815c34dca677c4` (73 bytes).
