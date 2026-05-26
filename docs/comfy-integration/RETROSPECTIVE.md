# Retrospective — Comfy steward-tooling session, 2026-05-25 → 26

Audience: the dev who was on the call. Quick read; not exhaustive.

## What we set out to do

Extract items + analytics from `ComfyEra14.db` (1.1 GB, 8M ZDOs) for steward use. Started fresh — no awareness of the integrated viewer already running at `D:\work\temp\` until late in the session.

## What we shipped

| Slice | Output |
|---|---|
| Standalone toolkit (`D:\work\comfy\`) | Java extractors → CSV / JSON files, drag-drop HTML report |
| **Integrated patches (this repo)** | v106 parse fix, 617-item classification, 3 forensics endpoints, 3 new SPA tabs, 3 new alert types |

Headline business numbers: chest data went from 110 unique item types reported to 618. Total items tracked went from 65k to 13.7M. Server-issued items went from 0 visibility to a 337-issuer catalog. Coin vault rig identified (15+ chests holding exactly 31,968 coins each).

## Decision tree of the session

```
1. Initial framing: build steward tools for ComfyEra14
   ↓
2. Path picked: standalone Java extractors + drag-drop static HTML report
   - Did the work in D:\work\comfy\
   - Built V0 (smoke test) → V4 (drag-drop UI) over a few hours
   - Discovered + patched a real bug in Kakoen's library (readNumItems
     unsigned-byte sign extension)
   - Reverse-engineered v106 inventory format (5 bytes per item added
     after customData: int32 worldLevel + bool pickedUp)
   - Built classification.json with 617 items × tier/biome
   - Detected Engravings mod quality repurposing + guild gear pattern
   - Identified specific exploit (DeerStew/Ditseey quality=781,879,803)
   ↓
3. User reveals: there's ALREADY an integrated viewer at D:\work\temp\
   running on localhost:7080. Asks for comparative analysis.
   ↓
4. Analysis done (ANALYSIS_DIFFERENTIAL.md):
   - Theirs has better architecture: live HTTP, Leaflet SPA, REST API,
     player attribution via BED_OWNER, portal pair detection, sign corpus,
     8 alert types, sectors, structures
   - Ours has better content: v106 (THEY DROP 99% OF CONTAINERS), item
     classification, mod awareness, guild gear detection
   - Recommendation in the doc: Path A (merge ours into theirs)
   ↓
5. User picks Path B in follow-up question:
   "steal their UI patterns into ours"
   ↓
6. ~4 hours rebuilding Leaflet map + 6 new tabs in our drag-drop HTML
   ↓
7. User pivots: "i had to reboot, checking in" + later "we need to merge
   our data and lessons learned into their UI and visualization layer
   --- this was less than awesome"
   ↓
8. Path A executed in ~3 hours:
   PA1 (v106 patch)          → 110 → 618 item types
   PA2 (rebuild + restart)
   PA3 (classification inject) → category/tier/biome on every item
   PA4 (forensics alerts)    → DeerStew detector + 2 info alerts
   PA5 (3 forensics endpoints) → coin caches + server issuers + guild gear
   PA6 (3 SPA tabs + economy enhancement)
   ↓
9. User: "perfect. now i need to package all this up..."
```

## What worked

- **Spawning research agents at the start** to characterize the save format, find existing parsers, survey the modding ecosystem. The agent output became the foundation for everything that followed.
- **InventoryProbe.java for v106 RE.** Iterative byte-walking with hex dumps. Confirmed 5-byte addition with consistent pattern across hundreds of items.
- **Building extractors as one-shot Java tools first.** Quick to iterate, easy to debug, output is just CSV. Could have started server-side but exploration was faster as CLI tools.
- **The "verify after every change" loop.** After every PA slice we hit `/api/v1/economy` and checked the number moved. Caught two bugs early.
- **PowerShell as the daemon harness.** `Get-NetTCPConnection -LocalPort 7080` + `Stop-Process` + `Start-Process java -jar ...` made the restart loop ~5 seconds.

## What didn't work

- **Going past the initial analysis without checking for prior art.** The integrated viewer existed the whole time at `D:\work\temp\`. We could have started there if we'd known on day one. ~4 hours sunk into the drag-drop HTML before pivot.
- **My initial path-selection question phrasing.** The analysis doc recommended Path A explicitly. My AskUserQuestion follow-up offered Path B alongside Path A with similar-sounding descriptions, and the user picked Path B. After the pivot they noted: "trust the analysis-doc recommendation by default when there's a conflict with the AskUserQuestion phrasing." Memory updated.
- **`mvn package` blocked by a corrupt lib jar.** Lost ~10 minutes diagnosing before falling back to targeted javac. The corrupt jar should be fixed; see [diagrams/05-extension-map.svg](diagrams/05-extension-map.svg) "KNOWN BUGS" column.
- **Tombstone owner inference via "most-common crafter inside" was a bad heuristic.** Gave us a top dyer of "xatu (12 deaths)". Their `creator` long + `ownerName` string approach gave the correct top dyer "Asclea (122 deaths)". A 10× miss. Always read the actual field if it exists.

## What to keep doing

- Verify-after-every-change. Even when it's "obviously" correct.
- Capture each technical discovery as a memory note with "how to apply" included.
- Spawn research agents for survey work; they're cheap and parallelize.
- Keep at least one reference dataset (we used findings.md) for cross-checking.

## What to stop doing

- Asking "which path" when the analysis already picked one. Lead with the recommendation; let the user override.
- Building anything user-facing without first asking "is there an existing UI we should extend?"
- Treating "in_progress" status as binding when the user pivots — clean up old tasks promptly.

## Concrete numbers from the session

```
Total session duration            ~14 hours (across multiple turns + a reboot)
Reference docs generated          5  (STRATEGY, ANALYSIS, CATEGORIZATION, PR_DRAFT, findings)
Java tools written                10 (SmokeTest, ContainerCensus, InventoryExtract,
                                       InventoryProbe, PrefabMerge, V0Redux, Classify,
                                       Findings, QualityProbe, WorldEntities, PlayerRoster,
                                       Density — calling it 10 ish, lost count)
Bugs found in Kakoen library      1  (readNumItems unsigned-byte)
Patches applied to their server   7 files
SPA tabs added                    3
REST endpoints added              3
Alert types added                 3
Item classification coverage      617 items (99.998% of in-world items)
Final integrated build time       ~15 sec per recompile/restart cycle
```

## For the next sprint

1. Start with `diagrams/05-extension-map.svg`. The green-box items are 1-2 hr wins; do those first to build dev momentum.
2. Fix `lib/jetty-servlet.jar` (the corrupt stub) so `mvn package` works again. ~5 min job.
3. Address the AlertBuilder boundary breach properly (add ForensicsContract). Half day.
4. Refresh classification.json against current modpack — `redseiko/ComfyMods` may have changed since May.

## What we did NOT do (intentionally, scoped out)

- Building piece census (too much memory; deferred)
- Live server attach (architecture change; deferred)
- Steam ID resolution (needs external API; deferred)
- Multi-world snapshot comparison (one-world UX simpler; deferred)
- Sign moderation queue (sign corpus exists; tab not built)
- Player session reconstruction from spawntime (data exists; analysis not built)
