# ComfyEra14 — Steward Tooling Strategy

## What we have
- `D:\work\comfy\ComfyEra14.db` (1,100,176,663 bytes, ~1.1 GB)
- `D:\work\comfy\ComfyEra14.fwl` (73 bytes)
- 9 reference repos cloned to `D:\work\comfy\research\`

## Ground truth from the bytes (verified by direct read of header)

| Field | Offset | Bytes | Value |
|---|---|---|---|
| worldVersion | 0 | `23 00 00 00` | **35** |
| netTime | 4 | `7e ac 01 a3 aa 62 64 41` | 10,687,829 s (≈124 in-game days) |
| myId | 12 | `8b 9b 88 cd 00 00 00 00` | 3,448,281,995 |
| nextUid | 20 | `81 52 7a 00` | 8,016,513 |
| numZdos | 24 | `80 52 7a 00` | **8,016,512** |

8M ZDOs is the operative constraint — *everything* downstream must stream.

## Format cheat-sheet (full detail in `memory/ref_valheim_save_format.md`)

- ZPackage binary, little-endian, 7-bit varint strings.
- Each ZDO = `flags(2) + sector(4) + position(12) + prefab(4) + [rotation(12)?] + bags…`. ZDOs with no bags are 22–34 bytes (fast skip).
- Container contents live on the ZDO's `strings` bag under key hash **`-938864442`** (= `StableHashCode("items")`). Value is base64; decode → ZPackage → `Inventory{version=104, count, items[]}`. **Item names inside are plaintext** — no hash reversal needed.
- Smelters/kilns use per-slot keys `item0`, `item1`, … instead of one `items` blob.
- Player tombstones (`Player_tombstone`) = same `items` payload + a name string.
- `StableHashCode` is a paired DJB2 on UTF-16. Not reversible — needs a rainbow table.

## The Comfy modpack ≠ a heavy content pack

Published `ComfyMods/ComfyValheimPack` is 40 mods, almost all QoL. The only ones likely to introduce new ZDO prefabs are `PlantThings` (Shovel + plant prefabs) and possibly a few building-piece exposers. **Unknown-prefab surface is small** — most non-vanilla hashes will resolve against ComfyMods source on GitHub plus the Discord-pinned allowed-list. We can punt mod-name resolution until V3 without losing data.

## Recommended tool choice

**Kakoen `valheim-save-tools` (Java 17)** — most maintained, only one cap to lift (`MAX_SUPPORTED_WORLD_VERSION 34→35`), proven format coverage through Bog Witch. Container decoding is *almost* in the library — `Zdo.byteArraysByName["items"]` is exposed as raw bytes; ~50 lines of glue feeds it back through the same `Inventory` decoder. License is missing from the repo (asterisk for any redistribution; fine for internal use).

Alternatives:
- **Avledet (C++ server reimpl)** — bleeding-edge format, but heavy lift to extract just parsing.
- **Port to Python** — 2-day port of ~600 LOC; faster for our 8M-ZDO streaming case; worth it after V2 lands. Not for V0.
- **calico-crusade C#** — drop, no `.db` support.

## Vertical slices

Each slice ends in a tangible artifact the steward can actually look at.

### V0 — Smoke test (30–90 min) ★ start here
**Output:** `comfyera14_header.json` + a 200-line sample of parsed ZDOs printed to console.
- Java/Maven up on Windows
- Fork Kakoen, bump constant 34→35, set `failOnUnsupportedVersion=false`
- Run on a *copy* of the .db (never touch the original)
- Confirm: worldVersion=35, ZDO count matches header (8,016,512), no parser crash, recognizable vanilla prefab names in the first 200 ZDOs
**Verifies:** the file is healthy, our tool reads v35, format claims hold

### V1 — Container census (2–4 hrs)
**Output:** `containers.csv` — every container ZDO with its prefab, world position, sector.
- Add a streaming filter that *only keeps* ZDOs whose prefab hash is in a curated container set: `piece_chest_*`, `Container`, `TreasureChest_*`, `Player_tombstone`, `piece_chest_private`, `piece_chest_blackmetal`, `piece_chest_personal`, `smelter`, `charcoal_kiln`, `blastfurnace`, `spinningwheel`, `windmill`, `piece_cookingstation`, `piece_oven`, `ItemDrop`, etc.
- Skip-don't-parse the bags for any non-container ZDO (huge speedup vs full JSON dump)
**Verifies:** the population shape (how many chests? where? do positions cluster on player bases?) — this alone is interesting to a steward.

### V2 — Inventory extraction (half day)
**Output:** `inventory.csv` — one row per item, joined to its container.
Columns: `container_id, container_prefab, container_x, container_y, container_z, item_name, stack, durability, quality, variant, crafter_name, crafter_id, custom_data_json`
- For each container ZDO from V1, base64-decode `items` (or walk `item0..N` for stations), run through Kakoen's `Inventory` decoder
- Tombstones get the player_name column too
**Verifies:** "what's in every chest in the world" — this is the primary steward deliverable. Even with no UI, a CSV is enough for queries like *"who owns the most blackmetal?"* / *"is anyone hoarding portal materials?"* / *"where are the lost tombstones of player X?"* in Excel or DuckDB.

### V3 — Mod-aware naming (half day)
**Output:** `prefab_dictionary.json` — every prefab hash seen in the save → human name + source mod.
- Take all unresolved hashes from V1 (the ones still showing as raw int32)
- Scrape candidate names from: Jotunn's prefab-list.html (vanilla, current to 0.221.12), `github.com/redseiko/ComfyMods` (whole org grep for `name = "..."` in C# sources), plus any allowed-list mods we can reach via Thunderstore
- Hash each candidate with `StableHashCode`, match against the unresolved set
- Anything still unresolved gets logged as `"unknown:0x<hex>"` with the file offsets of one or two example ZDOs so a human can investigate
**Verifies:** we have full coverage of what's stored. Establishes a per-server "rosetta stone" we can reuse for future exports.

### V4 — Steward UI (1–2 days, branch as needed)
Three forks at this point — pick after V3 based on what we learn:
- **A. Static HTML report** — single `report.html` with a searchable table (DataTables.js), a Leaflet-style world map of container positions, top-N reports. Self-contained file, share via Discord.
- **B. DuckDB + Observable notebook** — pipe the CSVs into DuckDB, build an Observable Framework dashboard. Faster iteration, but requires a hosting story.
- **C. Local FastAPI + React** — full app. Skip unless we need write-back (e.g., "open a recovery ticket on this tombstone").

**Recommendation:** start at A. The most useful artifact for a steward is *"show me a chest's contents by location, search by player name or item"* — DataTables does this in 100 lines.

## What we are NOT doing (yet)

- Touching the live server. Everything is offline on the .db copy.
- Modifying the save (Kakoen has clean/reset/addGlobalKey ops; ignored for now — we're read-only).
- Hash-cracking modded prefabs with rainbow tables. The candidate-list approach in V3 is enough given the small Comfy mod footprint.
- Per-character `.fch` parsing. We can do it later if the server uses `ServerCharacters` (worth asking the admin) and that data is interesting.
- Web hosting / multi-user access. Local first.

## Branching decision points

1. **Java vs Python after V0** — if Kakoen's whole-file load chokes on 1.1 GB / 8M ZDOs (likely needs `-Xmx8g`+), do we (a) just throw RAM at it for now, (b) write a streaming patch to Kakoen, or (c) port the ZDO loop to Python? Decide after measuring V0.
2. **Modded prefab strategy if V3 leaves many unresolved** — escalate to: scrape Comfy Discord allowed-list, ask admin for a `ZNetScene.m_namedPrefabs` dump (the gold standard; one tiny BepInEx mod gives us *every* prefab→hash on the live server).
3. **What ships first to the steward** — V2 CSV alone is publishable. V4 is for steady-state usage.

## File references

- Main save: `D:\work\comfy\ComfyEra14.db`
- World metadata: `D:\work\comfy\ComfyEra14.fwl`
- Reference repos: `D:\work\comfy\research\`
- Memory: `C:\Users\derek\.claude\projects\D--work-comfy\memory\`
