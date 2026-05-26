# ComfyStewardView vs. our ComfyEra14 toolkit — differential analysis

**TL;DR.** They built a polished server-side app with a Leaflet map UI, REST API, portal/bed/sign/dropped-item awareness, sector density alerts, and zone-budget tracking — areas we don't touch. We built deeper *inventory* understanding: v106 format reverse-engineering, item-level classification with tier/biome, Engravings-mod awareness, and guild-gear / quality-cap exploit detection — areas they don't touch. **They explicitly skip 99% of containers in this save** (`if (version > 105) return;`), so their item economy data is unrepresentative. Best path forward: graft our parsing + item analysis into their server architecture, OR steal their map/portal/bed/sign tracking into ours. Recommendation at the bottom.

## What's in each project (high-level)

|  | **ComfyStewardView** (`D:\work\temp\`) | **Our toolkit** (`D:\work\comfy\`) |
|---|---|---|
| **Architecture** | Server-side: Javalin (Jetty) HTTP + 14-endpoint REST API + Tailwind/Leaflet SPA (54 KB single page) | Client-side: Java CLI tools dump CSV/JSON → drag-drop static HTML report with DataTables |
| **Build** | Maven, shaded fat-JAR (9.3 MB) — `java -jar world-viewer-1.0.0.jar` and a daemon starts | `gradle build` patched Kakoen + 6 standalone Java tools → `out/*.csv`, `out/classification.json`, `report/report.html` |
| **Parser** | Custom direct ZPackage reader — no Kakoen dependency, pre-computed property hashes, mmap | Patched Kakoen — leverages library, easier to maintain but tied to upstream cadence |
| **Parse time** | 8.1 s full classification + heatmaps for 8M ZDOs | 6.2 s smoke test, 1.4 s container-only pass |
| **State model** | Long-running in-memory store (`ZdoFlatStore`: column-oriented parallel arrays, ~800k–1M "interesting" ZDOs + heatmaps for everything) | One-shot Java tool runs, CSVs persist; browser loads CSV on each visit |
| **Visualization** | Leaflet map with categorized markers, heatmaps, density layers, bbox filtering | Inline SVG plot of containers, color by item tier, click-to-modal |
| **API surface** | 14 endpoints with pagination, filters, schema-versioned envelope | None — file-based |

## Same-world data diff (both run on `ComfyEra14.db`)

| Metric | Ours | Theirs | Notes |
|---|---|---|---|
| Total ZDOs | 8,016,512 | 8,013,252 | Theirs is 3,260 lower — likely positional filter `\|x\|>=100_000` |
| World version | 35 | 35 | match |
| Player count | 531 (by crafter_name unique) | **491** (by bed-owner / tombstone-owner / creator-id correlation) | Theirs is more accurate — see below |
| Tombstones | 606 | **613** | They got 7 more — better detection |
| Top dyer | "xatu" with 12 tombstones | **Asclea with 122 tombstones** | They link tombstones to BED_OWNER via `creatorId` long field — *we* infer owner from "most-common crafter inside" which is wrong for most cases |
| Containers labeled | 61,289 with `items` key | 162,996 categorized as CONTAINER | Different definition — they include item stands and building-pieces-with-data |
| Unique item types in chests | **617** | 110 | **They explicitly skip 99% of inventories (v106). We process them all.** This is the single biggest functional difference. |
| Portals tracked | 0 | **9,135** (3,857 paired, 3,347 orphaned, 1,929 blank, 430 cluster groups) | Massive blind spot for us |
| Beds tracked | 0 | **1,968** (434 unique owners — the basis for their player identity) | Same |
| Signs tracked | 0 | **160,961** (34k unique texts, searchable) | Same |
| Item stands | 0 | **444,239** | Same |
| Creatures | 0 | **89,846** (52 species census) | Same |
| Ballistae | 0 | **40,889** | Same |
| Dropped items on ground | 0 | **302,951** (407 unique types) | Same |
| Detected structures | 0 | 122 (all boss altars) | Their `StructureDetector` is narrow; the 18k dungeon prefab-locations they identified aren't exposed via `/structures` |
| Alerts / Anomalies | 6 (mostly quality / progression / Itemize-aware) | **3,852** (3,347 orphaned portals + 430 portal clusters + 42 dup-tag groups + 20 build hotspots + 10 dropped hotspots + 1 zone budget + 1 economy unknown surge + 1 blank-tag aggregate) | Different focus: ours is item-level forensics; theirs is operational/server-health |
| Sectors | 0 | 8,202 occupied, 262 high-density (200m grid) | They have density-based world-region analysis |
| Zone budget tracking | 0 | Yes — per-region ZDO count vs limit (Valheim's per-zone ZDO cap causes lag; their `zone_budget` alert flags regions ≥75%/90%/over budget) | Steward-critical concern they handle that we don't |

## The v106 gap (the load-bearing finding)

Their `WorldParser.java` line 662:

```java
int version   = readInt32LE(in);
int itemCount = readInt32LE(in);
if (version > 105) return; // unknown format — fields added in v106+ cause misalignment
if (itemCount < 0 || itemCount > 1000) return;
```

Their `handoff.md` § "Inventory serialization (CRITICAL)" speculates: *"`byte pickedUp (v≥105 — CRITICAL FIX, lib doesn't know this)`"* — they thought v105 added one byte. They never confirmed v106's actual diff (which our `InventoryProbe.java` showed is **5 bytes per item**: int32 `worldLevel` + bool `pickedUp`).

**Consequence:** in this save, of 61,289 containers with `items`:
- v103: 330 containers
- v104: 342 containers
- v106: **60,617 containers** (99%)
- v105: **0 containers** (the version they think they need to support never appears in the save)

So their `/api/v1/economy` endpoint reports `uniqueItemTypes: 110` and `totalItemCount: 65,195` — those numbers come from the 672 v103/v104 containers only. Our `inventory_named.csv` covers all 61,289 containers, 329,496 item rows, 617 unique item types, 4.4M coin units total. Their data is **systematically and silently wrong** on every chest contents query.

This is also why our `/findings.md` could detect things they cannot:
- The 15-chest coin vault rig (those chests are v106)
- The Engravings mod's quality repurposing (only visible in v106 customData)
- The Ditseey/DeerStew quality=781,879,803 anomaly (v106)
- All of the guild-issued item analysis (v106)

The fix on their side is exactly the patch we already wrote: read `int32 worldLevel` + `byte pickedUp` after `customData` when version >= 106. One method, ~10 lines.

## Where their work materially advances ours

These are things we should learn from / steal from, ranked by value:

### 1. Player identity via `BED_OWNER` + tombstone `creatorId`
The single best architectural choice they made. A bed's ZDO has an `ownerName` string AND a `creatorId` long, and the same `creatorId` appears on tombstones (and any building piece). They build a `PlayerRecord` indexed by `creatorId`, with `nameSource` provenance ("BED_OWNER" / "TOMBSTONE" / "ID_ONLY") and `confidence` flag. This gives them:
- 491 distinct players with names attached
- Asclea correctly identified as the top dyer (122 deaths, not our "xatu" guess)
- Per-player stats: bedCount, deathCount, buildCount, portalCount
- Identity persists across HTML-tagged crafter names (since `creatorId` is stable)

Our "most-common crafter inside the tombstone" heuristic is at best 30-40% accurate. **We can match their player identity in ~50 LOC**: read `creator` and `ownerName` props on building/bed/tombstone ZDOs (we'd need to extend V1's filter beyond just containers).

### 2. Portal network analysis
They identify 9,135 portals world-wide and detect:
- **Orphaned**: has a tag, no matching partner (3,347 of them — operationally significant, players can't transit)
- **Paired**: exactly 2 portals share a tag
- **Hub**: 3+ portals share a tag (routing ambiguity, high-severity alert)
- **Blank tag**: 1,929 portals can't be paired
- **Cluster**: spatial groupings of portals (430 clusters in this save — base-portal-spam detection)

Per-portal author attribution (`creatorId` linked to player roster). Top portal builders identified: nexu 274, hobb 133, woot 83.

We don't track portals at all. **Steward value: very high** — portal cleanup is one of the most-requested operations on big servers.

### 3. Operational alerts (zone budget, hotspots, dropped item piles)
Their `AlertBuilder` produces alerts oriented to **server health**, not item forensics:
- **`zone_budget`** — every region tracked vs the Valheim per-zone ZDO cap; warn at 75%, high at 90%, critical when over. Lag prevention. We don't have any concept of zone budget.
- **`build_hotspot`** — top 20 density cells (sigma-above-mean), flagged because dense areas increase server tick time. We don't track building density at all.
- **`dropped_hotspot`** — top 10 dropped-item clusters; flags player death sites or loot piles that hurt FPS. We don't track dropped items.
- **`portal_*`** — see above.
- **`economy_unknown_surge`** — flag if unknown item ratio in chests >= configurable threshold (mod-rotation signal).

Each alert has a `severity` (critical/high/medium/low), a stable `id`, a `world_x/world_z`, and metadata. Filterable via REST. This is *very well-designed* for an operator workflow.

### 4. Sign text corpus
160,961 signs with 34k unique texts, searchable via API. Surfaces the actual social fabric — guild ranks, server passwords, decorative pianos, etc. Useful for understanding server culture and detecting policy violations (offensive text, advertising, etc.).

### 5. Dropped items on the ground
302,951 dropped items (407 unique types) — these are ItemDrop ZDOs (not chest contents). High density of dropped items is a death-site / loot-pile signal AND is performance-relevant. We don't track these because our V1 only catches `items`-key containers.

### 6. Streaming column-oriented store
`ZdoFlatStore` is parallel arrays (`int[] prefabId`, `float[] posX/posY/posZ`, `byte[] category`, etc.) for the ~800k-1M "interesting" ZDOs plus three heatmap grids for everything. Excellent for cache locality and avoiding GC churn. Much better than our HashMap-per-ZDO + retain-everything approach. They built this knowing they'd query it many times via the REST API; for our one-shot CSV dump, we don't need it as urgently — but if we ever go server-side, this is the design.

### 7. Architecture: live HTTP service
Long-running daemon that loads once and serves many queries via REST. With paginated endpoints + bbox filters. Better UX for a steward who wants to come back to the report repeatedly. Our drag-drop static-HTML pattern requires re-parsing the CSV every load.

## Where our work materially advances theirs

### 1. v106 inventory format coverage (largest single gap)
We parse all 99% of containers they skip. Without this fix, no chest-contents query is trustworthy on a current Valheim save. Cost to port: ~10 LOC in their `ContractBuilder.java` around line 662.

### 2. Item-level classification (Category / Subcategory / Tier / Biome / Source / Mod)
Our `classification.json` covers 617 distinct items across 15 categories with progression-tier integers (0-7) and biome tags. Their `TaxonomyClassifier` covers ~250 items in 7 categories without tier numbers (uses biome string like `"swamp"` instead). Ours is also pattern-driven (catches new items via rules); theirs is mostly hand-mapped.

For comparison: their `TaxonomyClassifier` lists every weapon by name → category/subcategory/tier-biome-string. Ours auto-classifies by prefix (`Sword*` → Weapon/Sword1H/tier=keyword-derived). Means we catch `SwordIronFire`, `SwordDyrnwyn`, `SwordNiedhoggLightning` (Ashlands variants); they wouldn't — those aren't in their hand-curated table.

Also: their /world-summary's `top_prefabs_global` array has `category: null` on every entry. The TaxonomyClassifier output doesn't reach the global summary endpoint at all. Looks like the typed taxonomy is applied to `DroppedItem` records only.

### 3. Engravings mod + guild-gear awareness
We detected and accommodated:
- Engravings mod repurposing `quality` field (3 customData keys: `engravings.craftername`, `engravings.quality`, `engravings.stack`)
- Itemize mod provenance (`itemized.craftername`, `itemized.crafterid`, `itemized.quality`)
- HTML-tagged crafter names = server-issued reward items
- 306 distinct server-issuer identities + their reward catalogs
- The pattern that quality-≥5 items are mostly LEGIT guild rewards (we filter them out of the exploit anomaly)

They have none of this. Their quality field is just an int. Without the filter, any equivalent "high-quality outlier" alert would have a ~99% false-positive rate against this save.

### 4. Specific exploit detection (Ditseey/DeerStew, quality-int-overflow)
The genuine anomaly we surfaced — `DeerStew quality=781,879,803` — is only visible when you've decoded v106 inventory + cleaned out the engravings false-positives. Their system can't see it.

### 5. Documentation + upstreamable patches
We have a PR-ready diff for Kakoen (`kakoen-comfyera14.patch` + `PR_DRAFT.md`) covering the `readNumItems` unsigned-byte bug, world v35 cap bump, and inventory v106 with explanation. They built around the bug (custom parser, no library dependency) but didn't fix it for the community.

### 6. Container categorization (5 groups, 12 sub-groups)
Our container taxonomy (`A. Player Storage / B. Vehicles / C. World Loot (by biome) / D. Player Remains / E. Decorative / F. Anomaly`) maps every container to one path. Theirs has flat byte categories: `CONTAINER` is one bucket regardless of chest vs vehicle vs treasure chest vs tombstone (those are separate top-level categories — TOMBSTONE, etc., but the "container" bucket itself isn't sub-classified).

## Where the projects fully agree (cross-validation)

These independent confirmations are reassuring:
- World version 35
- ZDO count ~8M (within 0.04% of each other)
- Tombstone count 613 (we found 606, theirs found 613 — 7-tombstone delta likely from us missing some edge case)
- Top progression bosses killed: Eikthyr / Elder / Bonemass / Dragon / Yagluth / SeekerQueen / GoblinKing
- Coin economy roughly large (theirs: 13,549 instances they could parse; ours: 4.44M units across 3,848 chests)
- "Modded" prefabs are mostly vanilla (their analysis found this too — see `handoff.md` `### 5. Unknown hash classification`)
- Wolfinside / Asclea / Fortynine appear in both leaderboards

## Recommendations — three paths

### Path A — **Graft our parsing + item analysis into their server** (recommended)
Ship the most value with the least new code:
1. **Fix their v106 skip** (10 LOC). Now their `/economy`, `/containers`, and any chest-contents view is correct on current saves.
2. **Add a `/api/v1/classification` endpoint** that serves our `classification.json` — gives them Tier/Biome/Subcategory for every item.
3. **Add Engravings + guild-gear awareness** to their `AlertBuilder`: new alert types `guild_gear` (info-level), `quality_exploit` (with engravings filter; only fires when truly anomalous like our DeerStew/Ditseey case), `customdata_extreme` (e.g., quality field over 1M).
4. **Port our `findings.md` queries** as a new `/api/v1/forensics/{report}` family that returns top coin caches, top stuffed containers, server-issued item catalogs.

Net effort: ~1-2 days of careful Java work + we contribute back as PRs. Their UI is already production-quality; we get every visualization win for free. Their long-running daemon means analyses are cheap and re-queryable.

**Risk:** introducing into their code requires understanding their `ZdoFlatStore` design and contract boundaries. But their code is well-organized (cleanly separated `parser/`, `extractor/`, `contract/`, `api/`, `store/`) so this is tractable.

### Path B — **Steal their map + portal/bed/sign tracking into ours**
Keep our drag-drop simplicity, add the world-object dimension:
1. Extend our `ContainerCensus` to also emit `portals.csv`, `beds.csv`, `signs.csv`, `dropped_items.csv` (each is a separate `--type` mode or separate Java tool).
2. Add a Leaflet view to `report.html` (load the CSVs, plot dots — they already give us coords).
3. Add player-identity tracking via `creator`/`ownerName` reads on bed/tombstone/building ZDOs — gets us to the Asclea-level deaths-per-player accuracy.
4. Skip the server-side daemon; keep the CSV-based workflow.

Net effort: ~3-5 days; we touch more files but stay in our architecture. We catch up on the visualization gap but don't get their REST API.

**Risk:** we end up rebuilding what already exists. Their server is *already running*. We'd be reimplementing for the sake of staying client-side.

### Path C — **Hybrid: their server is the production tool, our toolkit is the forensics layer**
Both projects coexist:
1. Their app is the day-to-day operator dashboard (map view, portal/bed alerts, sign search).
2. Our CSVs + Java tools are the forensics workbench (decode current v106 chests, run ad-hoc queries on guild gear, investigate specific anomalies).
3. We contribute the v106 patch upstream so their numbers stop being misleading, but otherwise we don't merge.

Net effort: ~1 day (just the v106 PR). Zero integration risk. Loses synergy.

## My recommendation

**Path A.** Reasons:
- Their architecture is genuinely better for a steward's workflow (live HTTP, paginated API, Leaflet map, real-time filters). Reimplementing that in our drag-drop world is wasted effort.
- Our value-add is narrow but deep: v106 parsing, item-level classification, mod-economy awareness, specific exploit detection. All of these can be added as small surgical changes without disrupting their architecture.
- The v106 patch alone is so urgent — it's the difference between their app being misleading (110 item types reported) and accurate (617). One bug fix = 5x correctness improvement on every chest endpoint.
- Their work is well-engineered; our patches make it more correct; everyone wins.

**Concrete first slice (1-2 hours):**
1. Fork their viewer/, apply our v106 fix to `WorldParser.java` (the inventory reader is around line 660 — change `if (version > 105) return;` to read 4-byte int + 1 byte for v106+, then read `customData` map).
2. Restart their daemon, check that `/api/v1/economy` now shows ~600 unique item types instead of 110.
3. Diff their numbers before/after — confirm the parse rate is unchanged.
4. Write up the diff and propose as a PR (to them, or back to Kakoen if they want to remove their custom parser).

That single step recovers 99% of the container data they're currently dropping. Then we layer classification + Engravings awareness on top in subsequent slices.

## File references

Their project:
- Source root: `D:\work\temp\viewer\src\main\java\com\valheim\viewer\`
- Key files: `parser/WorldParser.java` (30 KB), `extractor/ContractBuilder.java` (17 KB), `extractor/TaxonomyClassifier.java` (28 KB), `extractor/AlertBuilder.java` (11 KB), `store/ZdoFlatStore.java` (9 KB), `api/ApiServer.java` (35 KB), `resources/static/index.html` (54 KB)
- Live: `http://localhost:7080/` (UI), `http://localhost:7080/api/v1/...` (REST)
- Docs: `D:\work\temp\handoff.md` (10 KB), `D:\work\temp\viewer\HANDOFF.md` (19 KB)
- The v106 skip: `parser/WorldParser.java` line 662

Our project:
- All in `D:\work\comfy\` — see `STRATEGY.md`, memory under `C:\Users\derek\.claude\projects\D--work-comfy\memory\`
