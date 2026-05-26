# LLM prompt cookbook — extending the system with a free chat model

This is a paste-ready collection of prompts for common extension tasks. Open any free model (ChatGPT free, Claude.ai free, Gemini free), copy the **Prompt** block, paste it with the **Context** block attached, paste the response into your editor, then run the **Verify** command.

Each section is self-contained — no need to share project history across chats.

## Operating principles

- **Lead with the goal**, not the file. The model needs the "what" before the "where."
- **Paste actual code, not file paths.** Models can't fetch files; include the snippet you want changed.
- **Specify the verification command up front.** The model often suggests an additional change you didn't know you needed; the verify step catches that.
- **One change per chat.** Fresh chat per task = no context pollution.
- **Keep prompts under ~2K tokens (~1500 words).** Free tiers truncate; the context block is the variable, prompts stay short.

---

## Prompt 1 — Add a new item to the classification

**When you use this:** a new mod adds an item that shows up in `/api/v1/economy` topItems with `category: null`. You want it categorized.

### Prompt to paste

> I need to add a new item to a Valheim item classification JSON.
>
> The file is `classification.json` keyed by item name → object with `category`, `subcategory`, `tier`, `biome`, `source`, optional `mod: true`.
>
> Valid categories: Material, Food, Mead, Weapon, Ammo, Bomb, Shield, Armor, Tool, Trophy, Quest/Key, Cosmetic/Event, Creature drop, Misc/Component, Currency.
>
> Valid biomes: Meadows, BlackForest, Swamp, Mountains, Plains, Mistlands, Ashlands, DeepNorth, Ocean.
>
> Valid sources: Crafted, Looted, Foraged, Event, Quest, ServerIssued, Modded.
>
> Tier is integer 0-7 (Stone, Wood, Bronze, Iron, Silver, BlackMetal, Mistlands/Carapace, Ashlands/Flametal), or omit if not applicable.
>
> Examples of existing entries (paste 3-5 representative entries below).
>
> Give me a JSON entry for: **<ITEM_NAME>** which is **<ONE-LINE DESCRIPTION>**.

### Context to attach (paste sample entries)

```json
"SwordIron": {"category":"Weapon","subcategory":"Sword1H","tier":3,"biome":"Swamp","source":"Crafted"},
"ArrowCharred": {"category":"Ammo","subcategory":"Arrow","tier":7,"biome":"Ashlands","source":"Crafted"},
"MeadHealthMajor": {"category":"Mead","subcategory":"Active","source":"Crafted"},
"Wishbone": {"category":"Quest/Key","subcategory":"BossDrop","tier":3,"biome":"Swamp","source":"Quest"}
```

### Verify

After editing `viewer/classification.json` and restarting:

```bash
curl -s "http://localhost:7080/api/v1/economy?topN=200" | jq '.topItems[] | select(.name == "<ITEM_NAME>")'
```

Should return an object with your new category/tier/biome.

---

## Prompt 2 — Add a new alert type

**When you use this:** you want to flag a new server-health concern (e.g., "player has more than 50 portals," "any chest with stack > 5000 of single item").

### Prompt to paste

> I'm extending a Valheim steward-tool's `AlertBuilder` in Java. The existing pattern: each `buildXxxAlerts(...)` method appends `Alert` objects to a `List<Alert> out`. Each alert has `(id, type, severity, title, description)` constructor + chained `.at(x, z)` for position + `.meta(key, value)` for arbitrary data.
>
> Severities: critical, high, medium, low.
>
> Here's a sample existing alert builder (paste 1 below).
>
> Write me a new method `buildXxxAlerts(WorldContracts contracts, MetricsResult metrics, List<Alert> out)` that emits alerts when **<YOUR CONDITION>**. Use severity **<critical|high|medium|low>**. Include position when relevant.

### Context to attach (paste one existing alert method)

```java
private void buildEconomySurgeAlert(WorldContracts contracts, StConfig cfg, List<Alert> out) {
    int unique  = contracts.summary.stats.economy.unique_items;
    int unknown = contracts.summary.stats.economy.unknown_types;
    if (unique == 0) return;
    int unknownPct = (int) Math.round(unknown * 100.0 / unique);
    if (unknownPct < cfg.unknownSurgeThresholdPct) return;
    out.add(new Alert(
        "economy-surge",
        "economy_unknown_surge", "medium",
        unknownPct + "% of chest item types are unrecognised (" + unknown + "/" + unique + ")",
        unknown + " of " + unique + " distinct item types are not in the vanilla registry."
    ).meta("unknown_types", unknown)
     .meta("unknown_pct", unknownPct));
}
```

### Verify

After patching `AlertBuilder.java`, recompile + restart the daemon, then:

```bash
curl -s "http://localhost:7080/api/v1/alerts?type=<your_new_type>" | jq '.total'
```

Should be > 0 if your condition triggered.

---

## Prompt 3 — Add a new REST endpoint

**When you use this:** you have data already in the parser (or accessible via existing endpoints) but want a focused new query exposed.

### Prompt to paste

> I'm adding a new endpoint to a Javalin-based Java HTTP server. The pattern: register a route in `registerRoutes()`, write a `handleXxx(Context ctx)` method that reads query params, queries `ZdoFlatStore` (the in-memory data), builds a Jackson `ObjectNode` envelope, calls `ctx.json(node.toString())`.
>
> Here's a sample existing handler (paste below).
>
> Add a new endpoint **GET /api/v1/<your_path>** that returns **<DESCRIPTION OF DATA SHAPE>**. Query params: **<list them or "none">**. Pagination via `?limit=N&offset=N` if applicable.

### Context to attach

```java
// Route registration
app.get("/api/v1/economy", this::handleEconomy);

// Handler
private void handleEconomy(Context ctx) {
    ZdoFlatStore s = requireStore(ctx);
    if (s == null) return;
    int topN = ctx.queryParamAsClass("topN", Integer.class).getOrDefault(50);

    List<Map.Entry<String, Long>> sorted = new ArrayList<>(s.chestItemTotals.entrySet());
    sorted.sort((a, b) -> Long.compare(b.getValue(), a.getValue()));

    ObjectNode root = envelope(s);
    root.put("uniqueItemTypes", s.chestItemTotals.size());
    ArrayNode items = root.putArray("topItems");
    for (int i = 0; i < Math.min(topN, sorted.size()); i++) {
        Map.Entry<String, Long> e = sorted.get(i);
        ObjectNode item = items.addObject();
        item.put("name", e.getKey());
        item.put("count", e.getValue());
    }
    ctx.json(root.toString());
}
```

### Verify

```bash
curl -s "http://localhost:7080/api/v1/<your_path>?limit=5" | jq .
```

---

## Prompt 4 — Investigate a suspicious data anomaly

**When you use this:** you spotted a row in some endpoint that looks weird (huge stack, wrong tier, modded-looking name).

### Prompt to paste

> I have a Valheim save analyzed by a parser. I'm seeing a suspicious data point and want to understand if it's a real exploit, a mod artifact, or a parser bug.
>
> The anomalous data:
> ```json
> <PASTE THE ROW OR OBJECT HERE>
> ```
>
> Context about the world: Valheim community server "Comfy", world version 35, runs mods like Engravings (repurposes `quality` field), Itemize (vouchers via `customData["itemized.crafterid"]`), and various guild systems issuing items with HTML-tagged crafter names.
>
> Known patterns:
> - quality ≥ 5 with HTML-tagged crafter → guild gear (normal)
> - quality ≥ 5 with `engravings.quality` in customData → Engravings tracking (normal)
> - quality > 1,000,000 → int overflow (likely exploit or save corruption)
> - stacks > theoretical max for the item type → mod-altered cap or exploit
>
> Walk me through the analysis: is this normal, suspicious, or clearly broken? What follow-up query would I run to confirm?

### Verify

The model gives you a follow-up query suggestion (e.g., `curl /api/v1/forensics/guild-gear?issuer=<crafter>` to see what else that issuer issued). Run it.

---

## Prompt 5 — Refresh the classification against a new modpack

**When you use this:** the Comfy modpack rotated and new items are showing up uncategorized. You want to extend `classification.json`.

### Prompt to paste

> I need to extend a Valheim item classification covering ~617 items. The new modpack added items I haven't categorized yet.
>
> Here are the uncategorized item names (paste the list):
> ```
> <ITEM1>
> <ITEM2>
> ...
> ```
>
> For each item, look up what it is in Valheim's modded ecosystem (Therzie's Warfare/Monstrum/Wizardry, Smoothbrain's Jewelcrafting/Backpacks, RandyKnapp's EpicLoot, ComfyMods's PlantThings, etc.) and give me the JSON entry following this schema:
>
> ```
> "<name>": {"category":"...","subcategory":"...","tier":N,"biome":"...","source":"..."}
> ```
>
> Categories: Material, Food, Mead, Weapon, Ammo, Bomb, Shield, Armor, Tool, Trophy, Quest/Key, Cosmetic/Event, Creature drop, Misc/Component, Currency.
>
> If you can't identify the item, mark it `"mod": true` and `"source": "Modded"` with best-guess category.

### How to get the uncategorized list

```bash
curl -s "http://localhost:7080/api/v1/economy?topN=1000" \
  | jq -r '.topItems[] | select(.category == null) | .name'
```

### Verify

After updating `classification.json` + restarting:

```bash
curl -s "http://localhost:7080/api/v1/economy?topN=1000" \
  | jq -r '.topItems[] | select(.category == null) | .name' \
  | wc -l
```

Should be lower (or zero) than before.

---

## Prompt 6 — Build a new SPA tab

**When you use this:** you have a working endpoint and want it visible in the UI.

### Prompt to paste

> I have an existing Alpine.js + Tailwind single-page app with a tab system. Each tab is:
> 1. An entry in the `tabs:` array
> 2. A DOM section with `x-show="activeTab === '<id>'"`
> 3. A case in `switchTab(id)` that triggers a loader
> 4. An async `loadXxx()` method
>
> Here's the pattern (paste one existing tab below).
>
> Add a new tab labeled **"<EMOJI> <NAME>"** with id `<id>` that fetches `GET /api/v1/<endpoint>` and displays **<DESCRIPTION OF WHAT TO SHOW>**.

### Context to attach

```html
<!-- Tab entry (in the tabs: array) -->
{ id: 'caches', label: '🪙 Coin Caches' },

<!-- DOM section -->
<div class="flex flex-1 overflow-hidden flex-col" x-show="activeTab === 'caches'">
  <div class="p-4 flex-1 overflow-y-auto">
    <template x-if="coinCaches">
      <table class="w-full text-xs">
        <thead><tr><th class="text-left p-1">Container</th><th class="text-right p-1">Coins</th></tr></thead>
        <tbody>
          <template x-for="(c, i) in coinCaches.caches" :key="i">
            <tr class="border-b border-gray-800 hover:bg-gray-800 cursor-pointer"
                @click="flyMapTo(c.x, c.z); switchTab('map')">
              <td class="p-1" x-text="c.containerPrefab"></td>
              <td class="p-1 text-right" x-text="c.coins.toLocaleString()"></td>
            </tr>
          </template>
        </tbody>
      </table>
    </template>
  </div>
</div>

<!-- Loader -->
coinCaches: null,
async loadCoinCaches() {
  this.coinCaches = await fetchJson(`${API}/forensics/top-coin-caches?limit=50`);
},

<!-- switchTab dispatch -->
if (id === 'caches' && !this.coinCaches) this.loadCoinCaches();
```

### Verify

Reload `http://localhost:7080/`. The new tab button should appear. Click it; data should load.

---

## Prompt 7 — Debug a parse failure

**When you use this:** the daemon crashes during parse or some specific ZDO type isn't being detected.

### Prompt to paste

> A Valheim save parser is failing. The error / unexpected behavior:
> ```
> <PASTE THE STACK TRACE OR LOG OUTPUT>
> ```
>
> The relevant parser method is (paste below).
>
> The ZPackage binary format uses: little-endian, length-prefixed strings via 7-bit varint, primitive types (int32, int64, float, double, byte, bool=byte).
>
> ZDO structure: `uint16 flags + Vector2s sector + Vector3 position + int32 prefabHash + [Vector3 rotation if flags & 0x1000] + typed bags (floats/vec3s/quats/ints/longs/strings/byteArrays)`.
>
> Diagnose the failure: where in the parse is it likely going wrong? What's the next debug step? If it's a misalignment, what byte should I dump?

### Verify

The model usually suggests a hex-dump probe. Add it (similar to `InventoryProbe.java` from the standalone toolkit) and re-run.

---

## Prompt 8 — Cross-server snapshot comparison (extension idea)

**When you use this:** you have multiple `.db` files (era 13 vs era 14 vs current) and want a delta.

### Prompt to paste

> I need to compare two Valheim world saves to show what changed. Each save produces a JSON snapshot with this shape:
>
> ```json
> {
>   "players": [{ "name": "...", "deathCount": N, "bedCount": N, "portalCount": N }],
>   "economy": { "topItems": [{ "name": "...", "count": N }] },
>   "structures": [{ "type": "...", "count": N }]
> }
> ```
>
> Write a Java function `Map<String, Object> diff(JsonNode oldSnap, JsonNode newSnap)` that returns:
> - new_players (in new not old)
> - departed_players (in old not new)
> - delta_per_player.deathCount, bedCount, portalCount (sorted by abs(delta) desc, top 20)
> - economy.appeared (items new this era)
> - economy.disappeared (items gone this era)
> - economy.delta_top_20 (biggest count changes)
>
> Output schema clean enough to render in the existing Alpine SPA.

### Verify

Save two snapshots from `/api/v1/world-summary` at different times, run the diff, eyeball results.

---

## Prompt 9 — Optimize the per-restart parse cost

**When you use this:** the 8-second restart loop is annoying during development.

### Prompt to paste

> A Java app parses a 1.1 GB binary file into a `ZdoFlatStore` (parallel primitive arrays + maps) on every startup. Currently ~8 seconds.
>
> I want to cache the parsed state to disk and reload it on startup if the source `.db` file's mtime is unchanged.
>
> The store class has these fields (paste below). Use Java's built-in `ObjectOutputStream` for the cache (don't pull in new dependencies). Cache file path: `<save_path>.cache`. Validate via mtime + file size on load.
>
> Suggest implementation + show the diff to `Main.java` to wire it in.

### Context to attach

```java
public class ZdoFlatStore implements java.io.Serializable {
    public int[]   prefabId;
    public float[] posX, posY, posZ;
    public byte[]  category;
    public long[]  spawnTimeMicros, creatorId;
    public String[] label1, label2;
    public int[]   stackOrCount, quality;
    public final Map<String, Long> chestItemTotals = new LinkedHashMap<>();
    public final List<Integer> portalIndices = new ArrayList<>(10_000);
    // ... ~20 more fields
}
```

### Verify

Time the cold (no cache) vs warm (cache hit) startup. Warm should be < 1 second.

---

## Prompt 10 — Generate a steward weekly summary

**When you use this:** you want a written report a non-technical steward can read.

### Prompt to paste

> Generate a weekly summary email for a Valheim community-server steward based on the following dashboard data:
>
> ```json
> <PASTE OUTPUT OF: /api/v1/world-summary AND /api/v1/alerts?limit=20 AND /api/v1/players?sortBy=deaths>
> ```
>
> Tone: friendly, concise, ~300 words. Sections:
> 1. **What's new this week** (3-5 bullets: top players, notable activity)
> 2. **Concerns** (any HIGH or CRITICAL alerts — explain in plain English, suggest action)
> 3. **Fun fact** (one interesting data point — biggest base, most-deaths player, weirdest item, etc.)
> 4. **Reminder** (any operational note — orphaned portal cleanup, etc.)
>
> No code, no JSON in the output. Plain text that a human posts to Discord.

### Verify

Read it. Does it sound like a human wrote it? If yes, ship.

---

## Meta-prompt — "I want to do something not on this list"

> I'm extending a Valheim steward tool. The project structure: Java backend (Javalin + Jetty serving REST), Alpine.js SPA on top, fat JAR deployment. Data source is a `.db` binary save file parsed once at startup into a `ZdoFlatStore` (parallel arrays + indices + aggregations).
>
> What I want to do: **<DESCRIBE YOUR GOAL IN 2 SENTENCES>**
>
> Walk me through:
> 1. Where in the existing architecture this fits (parser? store? contract? api? ui?)
> 2. What new code is needed (rough sketch is fine, ~50 lines)
> 3. What to test after implementing
> 4. What could go wrong

The model usually gives you a coherent plan + sketch. Treat it as a peer-review of your idea before writing real code.
