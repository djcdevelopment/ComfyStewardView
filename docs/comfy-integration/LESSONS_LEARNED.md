# Lessons learned — technical knowledge worth carrying forward

This is the "things we wish we knew on day one" document. If you're extending the system, read this first.

## 1. The v106 inventory format

The single load-bearing finding. Their parser bailed on `if (version > 105) return;` — silently dropping 99% of containers in current saves. We RE'd v106 by:

1. Decoding a known-good v104 container manually (works fine).
2. Decoding a v106 container per the v104 layout → string-length errors mid-item, meaning misalignment.
3. Writing `InventoryProbe.java` (in `D:\work\comfy\src\`) that walks bytes per-field and scans forward for the next item's plausible name string.
4. Discovering a consistent **5-byte gap per item** between "expected end of v104 layout" and "start of next item's name varint".
5. Confirming pattern across 100+ items in 2 minutes: always `00 00 00 00 01`.

Interpretation: `int32 worldLevel + bool pickedUp` (defaults 0 and true). The names are our hypothesis; the bytes are what matter.

Patch is at `WorldParser.java:660-700`. Code reads:

```java
if (version >= 106) {
    readInt32LE(in);    // worldLevel
    in.read();          // pickedUp
} else if (version >= 105) {
    in.read();          // pickedUp only (legacy v105 hypothesis preserved)
}
```

Their original `if (version >= 105) in.read();` was correct for *hypothetical* v105 but wrong for v106. Both branches now coexist.

**Operational fact:** in this save 60,617 of 61,289 containers are v106. v105 doesn't appear at all. The v105 hypothesis is unproven but we kept it for forward safety.

## 2. The Engravings mod repurposes the quality field

10K+ items in this save have `customData["engravings.quality"]`. The Engravings mod stores the *original* Valheim upgrade quality in customData and overwrites the live `quality` field with an engraving-tier number. Result: many items show quality 35, 40, 100 — these are NOT exploits, they're guild reward tiers or repeated engravings.

**Steward-tooling implication:** any "quality outlier" alert MUST filter out items where:

- `crafter_name` contains `<` or `>` (HTML-tagged = server-issued = guild gear), OR
- `customData` contains `engravings.quality`

After the filter, residual quality-≥5 items are the real signal. We caught the genuine exploit this way: `DeerStew quality=781,879,803` — that's a timestamp/hash overflow into the quality int, by a plain-text crafter name "Ditseey", with no engravings tracking. One CRITICAL alert in the entire save.

Code: see `AlertBuilder.buildForensicsAlerts()` for the implementation. `WorldParser.parseInventoryIntoTotals` is where the customData keys are scanned.

## 3. Server-issued items have HTML-tagged crafter names

Valheim allows colored/styled crafter names via Unity rich text tags: `<color=#ff0000>`, `<b>`, `<#0A0>`, `<sup>`, etc. The Comfy server uses this for a sophisticated guild reward system. 337 distinct "server identities" issue 33,000 items.

Examples we cataloged:
- `<b><color=#FFFFFF>Best West Reward</color></b>` (5,550 items)
- `<color=#09bf49>Builders Guild Era 14</color>` (2,989 items)
- `<#0A0>The Rangers Guild</color><br>- Comfy Era 14 Scout Reward -`
- `<color=Yellow>Comfy Era XIV</color>` (the server itself)
- A `rep` badge system with gradient text
- `<color=red>S?? L??? GM</color>` (player-issued admin gear)

**Implication:** when you see a "weird" item (high quality, custom name, unusual stack), check the crafter. If it has `<` or `>`, it's almost certainly legitimate server output. Filter these out of exploit-detection queries.

The Guild Gear tab in the SPA renders these names as actual HTML (using Alpine's `x-html`) so the colors show.

## 4. Player attribution: BED_OWNER > TOMBSTONE_OWNER > anything else

Our initial heuristic was "most common crafter_name inside the tombstone" → gave us "xatu (12 deaths)" as top dyer. Wrong by 10×.

Their approach: read the `creator` long on building/bed/tombstone ZDOs + the `ownerName` string on beds → join into a roster indexed by internal_id. Gave us "Asclea (122 deaths)" — the actual top dyer.

The Valheim format stores creator as a long (Steam ID truncated/internal) on every ZDO with an author. Beds also store `ownerName` (the player who placed it). Tombstones store both. By aggregating all the (creator_id, ownerName) tuples and de-duplicating by creator_id, you get a clean player roster with names attached.

Source preference: BED_OWNER (highest, explicit) → TOMBSTONE_OWNER → SIGN_AUTHOR → INV_CRAFTER (fallback, often wrong).

In our standalone toolkit this is in `PlayerRoster.java`. Their integrated app builds it in `WorldParser` + exposes via `/api/v1/players`.

## 5. The 31,968-coin pattern is a vault rig

15+ chests world-wide hold *exactly* 31,968 coins each. That number is `32 slots × 999 coins/stack` — every slot maxed out at Valheim's per-stack cap. Locations cluster:

- (-7733, 34, ~152) — 3 chests stacked
- (-9010, 62, ~3729) — 4 chests stacked
- (-3850, 35, 3080) — 2 chests stacked

This is deliberate vault construction by one or more players. Top 15 caches alone = ~480K coins, ~11% of the server's coin supply.

**Steward implication:** when reviewing complaints about hoarding or server economy imbalance, this rig is the smoking gun. Not necessarily exploit (Coins are dropped not crafted, so they don't show in crafter_name) but worth knowing about.

The Coin Caches tab in the SPA surfaces this — top 50 caches sorted descending.

## 6. Kakoen's library has an unsigned-byte bug in `readNumItems`

Their original library's `ZPackage.readNumItems(int worldVersion)` does:

```java
int num = readByte();          // signed!
if ((num & 128) != 0) {
    num = ((num & 127) << 8) | readByte();   // second byte also signed
}
```

When the second byte has its high bit set (i.e., values 128-255 unsigned), Java sign-extends → result is negative → the surrounding `for (i = 0; i < num; i++)` skips → stream drifts → eventually `IllegalStateException` mid-file.

Fix: `int num = readByte() & 0xFF; ... | (readByte() & 0xFF);`. We patched our local fork in `D:\work\comfy\research\valheim-save-tools\`; their app doesn't use Kakoen (custom parser) so they're unaffected.

There's a PR draft at `D:\work\comfy\PR_DRAFT.md` if anyone wants to push it upstream.

## 7. Most "unknown" prefab hashes were vanilla, not modded

Our first census reported 1,150 unknown prefab hashes (42% of all ZDOs). We pivoted to "must be modded" and tried scraping mod repos. The real story: Kakoen's bundled `known_strings.txt` is stale (pre-Mistlands). A Jotunn-generated prefab list (0.221.12) plus the gamer's live `ZNetScene.m_namedPrefabs` dump resolved every hash — they were all *newer vanilla content* (Dvergr structures, Hildir chests, Ashlands pots, Yule gifts, etc.).

**Lesson:** when you see lots of "unknowns" against a stale dictionary, refresh the dictionary before assuming mod content.

The gamer's dump is at `D:\work\comfy\comfyera14_prefabs.csv` (3,569 entries). It's reusable across saves on the same modpack version.

## 8. Their architecture vs ours — what each got right

| | Their integrated app | Our standalone toolkit |
|---|---|---|
| Architecture | Live daemon + REST + Leaflet SPA | Java CLI → CSV → drag-drop HTML |
| Parse speed | 8.1s full classify | 6.2s smoke + 1.4s per slice |
| Player attribution | Excellent (BED_OWNER, 122 for Asclea) | Bad (crafter heuristic, 12 for xatu) |
| Container inventory | **Skipped 99% (v106 bug)** | Full (we patched v106) |
| Item classification | ~250 hand-mapped, never reaches UI | 617 items, pattern-driven |
| Mod awareness | None | Engravings + Itemize + guild gear |
| Portal network | Excellent (paired/orphaned/hub/cluster) | None |
| Sign corpus | Excellent (text + search) | None |
| Creatures | Tracked (52 species) | We added 50 species |
| Boss/dungeon structures | Detected (122) | We added (122 — matched) |
| Alerts | 8 types (server-health focus) | 3 our forensics types |
| Dropped items | 302k tracked | We added (303k) |
| Build heatmap | sigma-above-mean | sigma-above-mean |
| Zone budget | Yes (Valheim's per-zone lag cap) | None |

The merge in Path A landed all the right combinations: their UI/portals/beds/signs/structures + our v106 + classification + forensics.

## 9. Forensics tabs (PA5/PA6 reference)

Three new tabs in the SPA, each backed by a `/api/v1/forensics/*` endpoint:

- **🪙 Coin Caches** (`/forensics/top-coin-caches`) — per-container coin totals. Built during inventory parse (`containerCoinTotal` accumulator in `parseInventoryIntoTotals`). Stored as `topCoinCaches: List<CoinCache>` on `ZdoFlatStore`. Sorted desc + trimmed to top 100 inline.
- **👑 Server Issuers** (`/forensics/server-issuers`) — every HTML-tagged crafter with their item catalog. Built as `serverIssuerCatalog: Map<String, Map<String, Integer>>` during parse. Renders crafter names as actual HTML in the UI (so Valheim color tags display).
- **🎁 Guild Gear** (`/forensics/guild-gear?issuer=<name>`) — drill into one issuer's full catalog. Each item gets enriched with our classification (category + tier + biome).

The Economy tab also gained `byCategory` + `byTier` chip rows and a third column on each item row showing its category + tier.

## 10. Don't trust default values — verify byte layouts

The v106 5-byte gap was sitting in plain sight: any hex dump of a v106 container showed it. The previous parser maintainer hypothesized "v105 adds 1 byte (pickedUp)" without dumping bytes to verify; that hypothesis was wrong, and the bailout on v>105 was the safe (but data-losing) consequence.

Always: when you have a format that "works for v104 but not v106", base64-decode one container, walk every byte, and confirm what's actually there. It's 30 minutes of work vs months of silently-wrong data.

## Where to find each lesson's code

- v106 patch: `viewer/src/main/java/com/valheim/viewer/parser/WorldParser.java` ~line 660
- Engravings detection: same file, capture loop
- Server-issued detection: same file, looking for `<` / `>` in crafter
- Player attribution: `viewer/src/main/java/com/valheim/viewer/parser/WorldParser.java` ~line 200 (where beds + tombstones are processed)
- Coin cache pattern: detected via `topCoinCaches` aggregation in `parseInventoryIntoTotals`
- Quality outlier alert: `viewer/src/main/java/com/valheim/viewer/extractor/AlertBuilder.java` `buildForensicsAlerts()`
- Classification injection: `viewer/src/main/java/com/valheim/viewer/extractor/ClassificationStore.java` + wiring in Main + ApiServer
