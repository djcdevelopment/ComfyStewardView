# Enhancement playbook — how to grow this on any worldfile

The integration that landed is a foundation, not a finished product. This doc tells you (a) what's portable to other Valheim saves vs. tuned for ComfyEra14, (b) a tiered ladder of enhancements ranked by cost-to-impact, and (c) for each one: architectural reasoning, code/schema template, paste-ready prompt for a free chat model, and a verify command.

If you only read three things in this folder: this file, [BUILD_GUIDE.md](BUILD_GUIDE.md), [diagrams/05-extension-map.svg](diagrams/05-extension-map.svg). For all-ZDO investigation work, also read [BATCH_ANALYTICS_PLAN.md](BATCH_ANALYTICS_PLAN.md).

## Premise

**Assumption:** you have at least one Valheim world save (`.db` + `.fwl`). It works on any save at world version 32+ that uses inventory format up to v106. If you have multiple saves, even better — Tier 2+ becomes possible.

**What's portable across any worldfile** (no changes needed):
- The batch analytics cache (`AnalyticsCache`, `AnalyticsCacheReader`, `RenderedLayerBuilder`) - writes full ZDO rows to DuckDB and pre-renders dense overlays without changing the live dashboard path
- The whole parser (`WorldParser.java`) — reads the binary, handles all known versions including v106
- The whole data model (`ZdoFlatStore.java`) — column-oriented in-memory store
- All API endpoints — they reflect whatever's in the save
- The 16-bucket item taxonomy — categories are universal Valheim concepts
- All the SPA tabs — they fetch from the endpoints
- The smoke-test architecture — change the specific counts, the assertion shape works

**What's tuned for ComfyEra14** (review before pointing at a different world):
- `classification.json` — 617 items mapped to category/tier/biome. The schema is universal, but the **specific items** include ComfyEra14 modpack additions. New modpacks → re-curate (Tier 4 below).
- `smoke-test.ps1` — hard-coded thresholds (`uniqueItemTypes >= 600`, `distinctIssuers >= 100`). These reflect ComfyEra14's scale. For a smaller world, lower the thresholds.
- Specific known-anomaly callout (DeerStew/Ditseey) — that's a ComfyEra14-specific exploit. If it doesn't exist in your world, the alert won't fire (which is correct behavior).
- Some hard-coded prefab hash sets in `WorldParser.java` (creature names, structure names) — these are vanilla Valheim + heuristics from ComfyEra14 observation. Universal-enough but a different modpack might add prefabs the hash list misses.

**What's vanilla Valheim-specific** (won't change unless Iron Gate ships a new patch):
- Stable hash code algorithm
- ZDO binary serialization format
- Inventory schema (v100-v106)
- Container "items" key (`StableHashCode("items") == -938864442`)
- Player bed `ownerName` string field

## How to think about extending

Four architectural primitives keep the codebase coherent. New work should land in exactly one of these layers:

| Layer | Where new code goes | When to use |
|---|---|---|
| **BATCH ANALYTICS** | `db/AnalyticsCache.java`, `db/AnalyticsCacheReader.java`, `db/RenderedLayerBuilder.java` | You need to keep or query millions of ZDOs, generate pre-rendered layers, or run bounded drilldowns that should not inflate the live in-memory store. |
| **PARSER** capture | `WorldParser.parseInventoryIntoTotals` (or new method) → `ZdoFlatStore` fields | You need data that's in the bytes but not currently captured. Example: per-item `crafterId` (we added this for the issuer roster). |
| **ENRICHMENT** | New file in `extractor/`, called from `Main` after parse | You're computing something from already-captured data. Example: density hotspots, structure detection, classification join. |
| **API + UI** | `ApiServer` route + handler + `index.html` tab | You're surfacing existing data in a new shape. Example: every PA5 forensics endpoint + PA6 tab. |

**Decision rule:** if the data is in the bytes but you don't have it in memory, you need PARSER work. If you need all-ZDO retention, world-scale counts, or pre-rendered density views, use BATCH ANALYTICS. If you have it in memory but the right query doesn't exist, you need ENRICHMENT. If you have the right query but no UI, you need API+UI.

Most enhancement requests live in API+UI. PARSER changes are rare and expensive (they cost a re-parse of the whole save).

## Working with free chat models — operating principles

Before the prompts: how to think about using ChatGPT/Claude.ai/Gemini-free as a pair for this work.

1. **One change per chat.** Fresh chat per task. Models drift over long contexts; you'll waste tokens explaining your project before you get to the real ask. Each prompt in this playbook is self-contained for exactly this reason.

2. **Lead with the schema, not the prose.** The model can't see your code. Paste the relevant 20-50 lines (a method signature, an existing endpoint, a sample JSON response) at the top of every prompt. The model's accuracy is bounded by what you show it.

3. **Always include a verify command in your ask.** "Add X" prompts often produce 3 changes when you only wanted 1. The verify command keeps the model honest and saves you debug time.

4. **Treat the model as a senior pair, not an oracle.** They peer-review your idea, sketch the shape, point out what could go wrong. You decide what to actually write. Don't paste their output into the JAR untouched — read it first, ask "does this match the existing patterns?", then apply.

5. **Use the model for plumbing, not for judgement.** Adding a new endpoint that aggregates existing data → great model task. Deciding whether to expose a player's death-spot publicly → not a model task; that's a steward judgement.

6. **When the model gives a wrong answer, paste the error back.** "Your code compiled but smoke-test PA5 fails — here's the output: ..." gets you to a fix in one more turn. Don't restart the chat unless context is genuinely poisoned.

7. **Save the working prompt back into this playbook.** When you discover a prompt that produces good results, add it to your fork of `LLM_PROMPT_GUIDE.md`. The next person extending will thank you.

---

## Tier ladder

Five tiers, from "any worldfile, hours of work, immediate value" to "multi-community infrastructure, weeks of work, strategic value." Pick what matches your time + goals.

### Tier 1 — Same world, deeper queries
Lowest cost, no new infrastructure. Works on whatever save you already have. Builds confidence with the codebase. Aim here first.

### Tier 2 — Multiple worldfiles, historical comparison
You parse two saves, you diff them. Requires the daemon to handle more than one world at a time, or a CLI mode that emits JSON snapshots you diff externally. Stewards constantly ask "what changed since last week" — this answers it.

### Tier 3 — Live monitoring
Cron the parser, alert on deltas (new CRITICAL, new orphaned portal, new player). Discord webhook integration is the natural sink. This is where the system goes from "audit tool" to "operations tool."

### Tier 4 — Modpack adaptation
Make `classification.json` regenerable from the gamer's mod-list + ZNetScene dump. Right now it's hand-curated for ComfyEra14; new modpack means manual additions. Schema is universal but the entries are tuned.

### Tier 5 — Cross-server / multi-tenant
Multiple communities running this. Different mods. Different scales. Federated views. Worth doing only if multiple communities actually adopt the tool.

---

## Tier 1 enhancements

### 1.0 - Cached ZDO explorer and rendered overlays

**Why:** GM questions such as "show me all player-built pieces in this area" or "where are the gold-heavy containers" require more rows than the live dashboard should hold or draw. The DuckDB cache keeps every ZDO and the rendered layers summarize dense data before the browser sees it.

**Architectural layer:** BATCH ANALYTICS + API+UI. Keep writes in `AnalyticsCache`, bounded reads in `AnalyticsCacheReader`, and high-density visuals in `RenderedLayerBuilder`.

**Current foundation:** `--build-cache`/`--rebuild-cache` writes `zdo` and `container_item`, `--render-layers` emits build-density and container-coin PNGs, and the API exposes `/api/v1/db/zdo/query`, `/api/v1/db/containers/items`, `/api/v1/db/selection-summary`, and `/api/v1/rendered/manifest`.

**Next slice:** add a UI panel over `/api/v1/db/zdo/query` with category, prefab, creatorId, and bounding-box filters. Keep the route paginated and continue using rendered layers for world-scale density.

**Verify:**

```bash
curl -s "http://localhost:7080/api/v1/rendered/manifest" | jq '.layers | length'
curl -s "http://localhost:7080/api/v1/db/zdo/query?category=BUILDING&limit=5" | jq '.rows | length'
```

### 1.1 — Per-biome wealth heatmap

**Why:** stewards want to know which biomes hold the most stored value. "Where's all the iron?" "Are players hoarding in Mistlands or are they trading down?" The data is in the save (`container_x`/`container_z` + item totals + classification), just not aggregated this way.

**Architectural layer:** ENRICHMENT + API+UI (no PARSER change). Group existing container-item rows by biome (derived from coordinates via biome boundaries) + sum-by-tier or sum-by-category.

**Template — biome inference from coordinates:**

Valheim biomes are roughly stratified by distance from world center + elevation. A simple approximation:

```java
public static String biomeAt(float x, float z, float y) {
    double r = Math.sqrt(x*x + z*z);
    if (y < -300) return "Underworld";       // tombstones in lava caves
    if (r > 12000) return "Ocean";           // far from center
    if (r > 10000) return "DeepNorth/Ashlands"; // outer ring
    if (r > 7000)  return "Mistlands";
    if (r > 5000)  return "Plains";
    if (r > 3000)  return "Mountains";
    if (r > 1500)  return "Swamp";
    if (r > 600)   return "BlackForest";
    return "Meadows";
}
```

(This is approximate — Valheim's actual biome is per-zone-seeded, but for stewardly reporting, radius works at ~80% accuracy.)

**Prompt to paste into ChatGPT/Claude/Gemini:**

> I have a Java method `parseInventoryIntoTotals(base64, totals, store, containerIdx, cx, cy, cz)` in a Valheim save parser. Currently it sums per-item counts globally. I want to also bucket by biome derived from the container's (cx, cz).
>
> Existing call signature + a snippet of how it accumulates:
>
> ```java
> if (stk > 0) totals.merge(name, (long) stk, Long::sum);
> ```
>
> Add a parallel accumulation: `Map<String, Map<String, Long>> totalsByBiome` keyed by biome name → item name → count. Biome inference: paste my function below.
>
> Then add a `/api/v1/economy/by-biome` Javalin endpoint that returns the biome→top-N-items breakdown as JSON.

**Verify:**

```bash
curl -s "http://localhost:7080/api/v1/economy/by-biome" | jq '.biomes | keys'
# Expected: ["Meadows","BlackForest","Swamp","Mountains","Plains","Mistlands","Ashlands","Underworld","Ocean","DeepNorth/Ashlands"]
```

### 1.2 — Player wealth ranking

**Why:** "who's the richest" is the most common steward question. Currently you can derive it by joining `/api/v1/players` (deaths, beds) with `/api/v1/forensics/server-issuers` (crafter aggregation), but there's no single endpoint. Make it one query.

**Architectural layer:** ENRICHMENT + API+UI. ZdoFlatStore already has `players` (PlayerRecord) and `chestItemTotals`. Cross-reference per-crafter item totals + container ownership inference.

**Template:**

```java
private void handlePlayerWealth(Context ctx) {
    ZdoFlatStore s = requireStore(ctx); if (s == null) return;

    // Per-player aggregations
    Map<Long, Long> coinsByCrafter = new HashMap<>();
    Map<Long, Integer> itemsByCrafter = new HashMap<>();
    // (you'd populate these during parse OR re-derive from saved data here)

    // Join with PlayerRecord for names
    List<ObjectNode> rows = new ArrayList<>();
    for (PlayerRecord pr : s.players.values()) {
        ObjectNode n = mapper.createObjectNode();
        n.put("player", pr.displayName != null ? pr.displayName : "Player#" + pr.internalId);
        n.put("coinsCrafted", coinsByCrafter.getOrDefault(pr.internalId, 0L));
        n.put("itemsCrafted", itemsByCrafter.getOrDefault(pr.internalId, 0));
        n.put("portalCount", pr.portalCount);
        n.put("bedCount", pr.bedCount);
        rows.add(n);
    }
    rows.sort((a, b) -> Long.compare(b.get("coinsCrafted").asLong(), a.get("coinsCrafted").asLong()));
    // ... emit
}
```

**Prompt:**

> I have a Valheim parser that already populates `Map<Long, PlayerRecord> players` indexed by `internalId` (long Steam ID). PlayerRecord has displayName, bedCount, deathCount, portalCount, buildCount.
>
> I want to add per-player **wealth ranking**: total Coins crafted by each player + total item instances they've crafted across the whole world.
>
> Coins live in container inventories. Each item has a `crafterId: long` field. Show me:
> 1. The diff to `parseInventoryIntoTotals` to accumulate `Map<Long, Long> coinsByCrafter` and `Map<Long, Integer> itemsByCrafter`.
> 2. A new Javalin endpoint `/api/v1/players/wealth` that joins these with the PlayerRecord roster and emits a sortable JSON.
>
> Match the style of the existing handleEconomy method (paste below).

**Verify:**

```bash
curl -s "http://localhost:7080/api/v1/players/wealth?limit=10" | jq '.players[0]'
# Expected: an object with player/coinsCrafted/itemsCrafted fields
```

### 1.3 — Death heatmap with player attribution

**Why:** "where do players die most?" answers two operational questions: (a) is there a dangerous bug in a particular location, (b) where should the next staff-built outpost go. Data exists — tombstone positions + owner names are all there.

**Architectural layer:** API+UI only. ZdoFlatStore.tombstoneIndices + label1 (owner name) → bucket positions into a grid.

**Prompt:**

> Add a new Javalin endpoint `/api/v1/deaths/heatmap?cellSize=N` that buckets tombstone positions into N-meter cells and returns:
>
> ```json
> { "cellSize": N, "cells": [{ "x": ..., "z": ..., "count": ..., "topPlayers": [{name, count}] }] }
> ```
>
> Source data: `s.tombstoneIndices` (List<Integer>), with positions at `s.posX[idx]` / `s.posZ[idx]` and owner at `s.label1[idx]`. Skip cells with fewer than 3 deaths (noise floor). Default cellSize 500m. Return top 10 cells by count.

**Verify:**

```bash
curl -s "http://localhost:7080/api/v1/deaths/heatmap?cellSize=500" | jq '.cells | length'
# Expected: 5-20 cells (depending on world activity)
```

### 1.4 — Sign keyword alerts

**Why:** signs are user-generated text. Stewards moderate. 35k unique sign texts in ComfyEra14 — manual review is infeasible, keyword matching is fast. Useful for catching offensive content, advertising, or specific keyword conventions (e.g., "for sale", "free", "trade").

**Architectural layer:** ENRICHMENT (during parse OR post-parse). Add to AlertBuilder.

**Prompt:**

> I have a List<Integer> of sign ZDO indices in ZdoFlatStore. Each sign's text is at `s.label1[idx]`, author at `s.label2[idx]`, position at `s.posX[idx]`/`s.posZ[idx]`.
>
> Add a new alert type `sign_keyword_match` to AlertBuilder that fires when a sign's text matches any pattern in a configurable list. Default patterns: `["fuck", "shit", "ass", "gay", "n[i1]gg[ae3]r"]` (case-insensitive regex). Severity medium. Title: `Sign keyword match: "<truncated text>"`. Include position + author in meta.
>
> Make the patterns loadable from a `sign-watchlist.txt` file alongside the daemon (one regex per line, # comments allowed).

**Verify:**

```bash
curl -s "http://localhost:7080/api/v1/alerts?type=sign_keyword_match" | jq '.total'
# Expected: 0 (good world) or N (alerts present)
```

### 1.5 — Time-based queries (when was X built?)

**Why:** every ZDO has a `spawntime` field (microseconds since world start). You can answer "show me everything built in the last in-game week" or "what existed before the Mistlands update went live" if you correlate spawntime to wall-clock dates.

**Architectural layer:** API+UI. Their `handlePoints` already supports `spawnedAfterFraction` / `spawnedBeforeFraction`. Generalize.

**Prompt:**

> Their existing `/api/v1/points` endpoint accepts `spawnedAfterFraction` and `spawnedBeforeFraction` (0.0-1.0 of world age). I want to add the same filter to:
> - `/api/v1/containers`
> - `/api/v1/portals`
> - `/api/v1/tombstones`
>
> Show me the 3 handler diffs, following the pattern from handlePoints (paste below).

**Verify:**

```bash
# Last 10% of world age
curl -s "http://localhost:7080/api/v1/containers?spawnedAfterFraction=0.9&limit=5" | jq '.total'
# Should be smaller than the unfiltered count
```

---

## Tier 2 enhancements

### 2.1 — Two-snapshot diff

**Why:** "what changed since last era?" / "what did we lose in the wipe?" — questions stewards ask after every major event. Two `.db` files in, one delta JSON out.

**Architectural layer:** CLI mode + ENRICHMENT. Don't run two daemons; run the parser twice in a separate CLI tool that emits diff JSON.

**Template — what a snapshot looks like:**

```json
{
  "world_name": "ComfyEra13.db",
  "parsed_at": "2026-05-26T10:00:00Z",
  "players": [{ "id": 123, "name": "Asclea", "deaths": 122, "beds": 9 }],
  "economy": { "topItems": [{"name": "Coins", "count": 4427737}] },
  "structures": [{ "type": "boss_altar", "count": 122 }],
  "checksums": { "totalZdos": 8013252 }
}
```

**Prompt:**

> Write a Java CLI `SnapshotDiff` that takes two snapshot JSON files (schema below) and emits a structured diff:
> - `players.appeared` (in new not old)
> - `players.departed` (in old not new)
> - `players.delta` (top 20 by absolute change in deaths)
> - `economy.appeared` / `economy.disappeared`
> - `economy.deltaTop20` (biggest count changes either direction)
> - `structures.delta` (per-type count change)
>
> Output should be human-readable text first (sorted, columnar), then JSON at the end for further processing.

**Verify:**

```bash
# After capturing two snapshots:
java -cp ... SnapshotDiff era13.json era14.json
# Should print a readable diff
```

### 2.2 — Era timeline

**Why:** scale up the diff to 3+ snapshots. Show "this player's death count over time" / "this item's prevalence by era."

**Architectural layer:** New CLI + simple Markdown/HTML output generator.

**Prompt:**

> Given N snapshot JSON files (filenames are dated like `era-13.json`, `era-14.json`), generate a Markdown report with:
> - Player roster (one row per player, columns per era) — show death counts over time
> - Economy roster (one row per item, columns per era)
> - Boss kill progression (Eikthyr → Fader columns)
> - Notable "first appearance" of mod items
>
> Output a single .md file ready to share. Keep total length under 5K lines.

---

## Tier 3 enhancements

### 3.1 — Cron-driven re-parse + delta alerts

**Why:** the parser runs in 8 seconds. Run it every 15 minutes. Diff against the previous run's snapshot. If new CRITICAL alerts appear, ping Discord. Now you have a real ops tool.

**Architectural layer:** External cron + a small `cron-runner.ps1` that wraps the JAR + a webhook caller.

**Prompt:**

> Write a PowerShell script `cron-runner.ps1` that:
> 1. Stops the existing daemon on port 7080
> 2. Parses the latest save via `java -jar ...` 
> 3. Once ready, fetches `/api/v1/alerts?severity=critical` and `/api/v1/alerts?severity=high`
> 4. Compares against the previous run's alert list (stored at `last-alerts.json`)
> 5. For each new alert not in the previous list, POSTs to a configurable Discord webhook URL
> 6. Saves the current alert list as the new `last-alerts.json`
> 7. Logs everything to `cron-runner.log`
>
> Use only built-in PowerShell cmdlets. Webhook URL from env var `DISCORD_WEBHOOK_URL`. Exit 0 on success, non-zero on any failure.

**Verify:**

```powershell
$env:DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/..."
.\cron-runner.ps1
# Should log + post to Discord if new alerts
```

### 3.2 — File-watcher hot reload

**Why:** the world save is rewritten by the game every ~20 minutes. Currently you restart the daemon manually. Better: watch the file's mtime, re-parse automatically.

**Architectural layer:** PARSER + Main loop. Java's `WatchService` API or a polling loop.

**Prompt:**

> The Valheim daemon parses a .db file once at startup and serves it as a static snapshot. The .db is rewritten periodically by the game server.
>
> Add a background thread that polls the .db file's mtime every 60 seconds. When mtime increases, re-parse the save into a new ZdoFlatStore and atomically swap it for the one the ApiServer is reading.
>
> Considerations:
> - The current parse is `~8 seconds`, so reads during parse can serve stale data — that's fine.
> - Use a `volatile` reference for the store swap.
> - Log when the swap happens.
> - Don't crash on a half-written save — wrap parse in try/catch and keep the old store.

**Verify:**

```powershell
# Touch the file (simulates the game rewriting it)
(Get-Item D:\work\temp\ComfyEra14.db).LastWriteTime = Get-Date
# Within 60s, check the daemon's log for "Re-parsed save"
```

### 3.3 — Discord-friendly summary endpoint

**Why:** stewards spend time in Discord, not in dashboards. Give them a one-call summary that fits in a chat embed: top alerts, top issuers this week, biggest cache, suspicious death cluster.

**Architectural layer:** API. New endpoint + template formatter.

**Prompt:**

> Add an endpoint `/api/v1/discord-summary` that returns a JSON payload formatted as a Discord embed (fields, title, description, color by severity). Should include:
> - Most-deaths player this snapshot
> - Top critical alert (if any)
> - Top 3 coin caches (anonymized — just position + count)
> - Most prolific server-issuer this week
> - "Notable item" — any quality > 100 item recently crafted
>
> Format following Discord's embed JSON spec (look it up). Keep total under 6000 chars.

**Verify:**

```bash
curl -s "http://localhost:7080/api/v1/discord-summary" | jq '.title'
```

---

## Tier 4 enhancements

### 4.1 — Generated classification from modpack source

**Why:** `classification.json` is hand-curated for ComfyEra14. When the modpack rotates, ~50-100 items become uncategorized (visible as `category: null` in /economy). Manual updates don't scale; build a generator.

**Architectural layer:** CLI tool (separate from the daemon).

**Prompt:**

> I have a directory of Valheim mod source code (cloned from `github.com/redseiko/ComfyMods` etc.) and a CSV file `prefab-hashes.csv` (a `ZNetScene.m_namedPrefabs` dump from a live mod-loaded game: `hash,name` pairs).
>
> Build a Python script `regen-classification.py` that:
> 1. Reads existing `classification.json` (don't break what works)
> 2. Scans every `.cs` file in the mod source directories for prefab name string literals (`name = "..."`, `RegisterPrefab("...")`, etc.)
> 3. Reads `prefab-hashes.csv` for the authoritative ZNetScene dump
> 4. For each prefab name in the dump that's NOT in classification.json:
>    a. Try to infer category from name patterns (prefix `Sword*` → Weapon/Sword1H, `Mead*` → Mead, etc.)
>    b. Try to infer tier from material keywords (`Bronze`→2, `Iron`→3, etc.)
>    c. Output to a `classification-additions.json` for human review before merging
> 5. Print a coverage report (how many added, how many still need manual categorization)

**Verify:**

```bash
python regen-classification.py \
  --mod-source ./mods \
  --prefab-dump prefab-hashes.csv \
  --existing classification.json \
  --output classification-additions.json
jq 'length' classification-additions.json
# Expected: <50 new entries needing review
```

### 4.2 — Tier inference from progression order

**Why:** if a modpack adds a "new tier" of weapons (e.g., between Mistlands and Ashlands), the existing tier 0-7 ladder doesn't fit. Make tier assignment configurable.

**Architectural layer:** Schema change + ClassificationStore loader.

**Prompt:**

> Extend `classification.json` schema to support a `tier_metadata` block at the root:
>
> ```json
> {
>   "_meta": {
>     "tier_definitions": {
>       "0": { "name": "Stone", "biome": "Meadows" },
>       "1": { "name": "Wood", "biome": "Meadows" },
>       ...
>       "8": { "name": "Mythic", "biome": "EndGame" }
>     }
>   },
>   "<itemName>": { ...existing fields... }
> }
> ```
>
> Update `ClassificationStore.loadOrEmpty` to parse this block and expose `tierName(int)` and `tierBiome(int)` methods. Default to the current 0-7 mapping if `_meta` is absent (backwards-compatible).
>
> Update `/api/v1/economy` to include tier name in the `byTier` aggregate response.

---

## Tier 5 enhancements

(These are sketches only — significant architectural work; cost > value unless multiple communities adopt.)

### 5.1 — Multi-tenant daemon

**Why:** one daemon serves multiple Valheim communities. Each community = one tenant with their own save, classification, alerts, dashboard.

**Sketch:** mount each save at `/tenants/{name}/` paths. Lazy-parse on first request per tenant. Shared classification dictionaries (vanilla items) + per-tenant overrides.

### 5.2 — Federated steward network

**Why:** stewards across communities want to compare notes — exploit patterns, mod recommendations, "who got banned for what." A federated pubsub between deployments.

**Sketch:** Each daemon publishes anonymized alert hashes to a shared Matrix/IRC channel. Stewards subscribe to peers. "Server X just flagged a quality-overflow pattern with crafter `Ditseey` — anyone seen this player?"

### 5.3 — Per-prefab provenance graph

**Why:** items move between containers, get crafted, get traded. Reconstruct the lifecycle: which player first crafted this DragonEgg, who held it, where is it now. Requires multi-snapshot tracking.

**Sketch:** Per-item-instance UUID derived from crafterId + crafterTime + item name. Track across snapshots. Render as a Sankey diagram.

---

## Anti-patterns — common ways extensions fail

These mistakes have cost me hours; learn from them.

| Anti-pattern | Why it hurts | What to do instead |
|---|---|---|
| **Adding fields to ZdoFlatStore for one-shot queries** | Memory grows. Every save parse is slower. Once you ship a field, you can't easily remove it. | If a query only fires occasionally, compute it in the handler, not in the parser. |
| **Skipping the smoke test "because the change is obvious"** | The change isn't obvious. Subtle classpath issues, stale JARs, forgotten static initializers will bite you. | Always run smoke-test.ps1. 30 seconds; saves an hour later. |
| **Editing classification.json by hand for hundreds of items** | Tedious, error-prone, no validation. | Use the regenerator from 4.1 even for small batches. Or write a tiny one-off script. |
| **Hardcoding ComfyEra14-specific values in new code** | Breaks portability. The next world won't have those values. | Read from config or compute from the data. Even "expected count: 122 boss altars" should be `>= 50` not `== 122`. |
| **Asking the LLM to write a whole feature from a prose description** | You'll get plausible-looking code that doesn't match your existing patterns. Wrong style, wrong abstraction layer. | Paste a sample of the existing pattern + ask for a parallel implementation. |
| **Pushing classes-only changes without source** | Future-you can't reproduce the build. Other devs can't extend. | Always commit source. Binaries are optional. |
| **Treating the daemon as a single-tenant when planning** | Tier 5 work locks you out if you assumed singleton everywhere. | When designing new state, even simple things, ask "what changes if we had 3 of these?" |

---

## Quick-start: I want to make one improvement right now

Pick the smallest enhancement that delivers value. From the Tier 1 list, **1.3 (Death heatmap)** is the highest payoff:

1. Read [BUILD_GUIDE.md](BUILD_GUIDE.md) Pre-flight + Components — orient yourself.
2. Open a free chat model. Paste the **1.3 prompt** above + the contents of `viewer/src/main/java/com/valheim/viewer/api/ApiServer.java` lines 386-420 (`handleTombstones` — the closest existing pattern).
3. Take the model's output. Drop into ApiServer.java.
4. Run BUILD_GUIDE steps 2-3 (compile + bundle) + step 5 (sync JAR) + steps 7-8 (restart).
5. `curl http://localhost:7080/api/v1/deaths/heatmap?cellSize=500 | jq` — see your data.
6. Commit, push, share with the steward who asked.

Total time: ~30 minutes for someone who's never touched the codebase. ~10 minutes for someone who has.

That's the iteration loop. The rest of this playbook is variations.
