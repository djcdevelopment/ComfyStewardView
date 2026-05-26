# Categorization proposal — ComfyEra14 steward report

**What we have in the data:** 617 distinct items + 70 distinct container types. Currently the report's "Map" tab uses 6 buckets (chest / tomb / treasure / ship / station / unknown) and the tables have no grouping at all — items are a flat sortable list. Stewards have to mentally re-categorize on every search.

**What this proposal adds:** a two-level taxonomy (Category → Subcategory) plus orthogonal tags (Tier, Biome, Era, Source). A filter sidebar that lets a steward say *"show me all Mistlands-or-later weapons"* or *"show me every container under the 'World Loot > Mistlands' bucket"* in two clicks.

## Top-level item categories

Designed so every one of the 617 items maps to exactly ONE top-level category. Sub-categories add precision but a steward can always fall back to top-level.

| # | Category | Approx item count | Examples |
|---|---|---|---|
| 1 | **Material** | ~80 | Wood, Stone, Iron, Eitr, BlackMarble, LeatherScraps, Flax, JuteRed |
| 2 | **Food** | ~150 | RawMeat, CookedDeerMeat, Bread, Salad, PiquantPie, Sausages, Mushroom, Honey |
| 3 | **Mead** | ~35 | MeadHealthMajor, MeadStaminaLingering, MeadBaseEitrMinor, BarleyWine |
| 4 | **Weapon** | ~90 | SwordIron, AxeBerzerkr, BowAshlands, StaffFireball, MaceEldnerBlood, FistFenrirClaw |
| 5 | **Ammo** | ~20 | ArrowCharred, BoltCarapace, TurretBoltFlametal, Catapult_ammo |
| 6 | **Bomb** | 5 | BombBile, BombLava, BombOoze, BombSmoke, BombSiege |
| 7 | **Shield** | ~16 | ShieldWood, ShieldBlackmetal, ShieldFlametalTower, ShieldCarapaceBuckler |
| 8 | **Armor** | ~70 | ArmorIronChest, HelmetTrollLeather, CapeLox, BeltStrength, SaddleLox |
| 9 | **Tool** | ~15 | Hammer, Hoe, Cultivator, PickaxeIron, FishingRod, Demister, Torch, BarberKit |
| 10 | **Trophy** | ~55 | TrophyDeer, TrophyEikthyr, TrophyDragonQueen, TrophyFader |
| 11 | **Quest / Key** | ~20 | CryptKey, DvergrKey, HildirKey_*, DragonEgg, DyrnwynBladeFragment, Wishbone |
| 12 | **Cosmetic / Event** | ~30 | TankardOdin, FireworksRocket_*, Sparkler, ArmorDress*, ArmorTunic*, HelmetHat*, FragrantBundle |
| 13 | **Creature drop** | ~50 | WolfFang, MorgenHeart, FreezeGland, Carapace, BonemawSerpentTooth, ChickenEgg, GiantBloodSack |
| 14 | **Misc / Component** | ~10 | SurtlingCore, MoltenCore, MechanicalSpring, BarrelRings, Demister, CharcoalResin, Wisp |
| 15 | **Currency** | 1 | Coins (singled out — it dominates wealth analytics and deserves its own bucket) |
| 16 | **Mod-flagged** | ~6 | $PlumgaPlantItShovel, TankardAnniversary, anything with `customData["itemized.*"]` |

## Sub-categories — examples for the highest-traffic categories

### Material (the steward needs to find raw resources fast)

- **Wood**: Wood, FineWood, ElderBark, RoundLog, Blackwood, YggdrasilWood
- **Stone**: Stone, Grausten, BlackMarble, StoneRock
- **Ore**: CopperOre, TinOre, IronOre, SilverOre, FlametalOre, FlametalOreNew
- **Metal ingot**: Copper, Tin, Bronze, Iron, Silver, BlackMetal, Flametal, FlametalNew
- **Scrap**: CopperScrap, BronzeScrap, IronScrap, BlackMetalScrap
- **Crafting component**: BronzeNails, IronNails, Chain, BarrelRings, MechanicalSpring
- **Hide / leather**: DeerHide, TrollHide, WolfPelt, LoxPelt, AskHide, ScaleHide, LeatherScraps
- **Fiber / textile**: Flax, LinenThread, JuteRed, JuteBlue
- **Bone / chitin**: BoneFragments, CharredBone, WitheredBone, Chitin, HardAntler, Mandible, Needle, Carapace, BonemawSerpentTooth, BonemawSerpentScale, SerpentScale
- **Gem / crystal**: Crystal, Obsidian, Flint, Ruby, GemstoneRed, GemstoneGreen, GemstoneBlue, Amber, AmberPearl, ProustitePowder, Thunderstone
- **Animal product**: Resin, Tar, Sap, Coal, CharcoalResin, Honey, RoyalJelly, QueenBee
- **Magical / boss material**: Eitr, Wishbone, YmirRemains, MorgenHeart, MorgenSinew, CelestialFeather, DragonTear, BlackCore, MoltenCore, SurtlingCore

### Food (most diverse — sub-categorization helps a lot)

- **Raw meat**: RawMeat, DeerMeat, WolfMeat, LoxMeat, etc.
- **Cooked meat**: CookedMeat, CookedDeerMeat, etc. (mirror of raw)
- **Jerky / cured**: WolfJerky, BoarJerky, CuredSquirrelHamstring
- **Fish (raw)**: FishRaw, Fish1..Fish12, Fish4_cave
- **Fish (cooked / dish)**: FishCooked, FishAndBread, FishWraps
- **Berries / foraged**: Raspberry, Blueberries, Cloudberry, Pukeberries, Vineberry
- **Mushroom**: Mushroom, MushroomYellow, MushroomBlue, MushroomMagecap, MushroomJotunPuffs, MushroomSmokePuff, MushroomBzerker
- **Plant / vegetable**: Carrot, Onion, Turnip, Thistle, Fiddleheadfern, Root, Dandelion, FreshSeaweed
- **Grain / seed / sapling**: Barley, BarleyFlour, CarrotSeeds, TurnipSeeds, OnionSeeds, VineberrySeeds, BirchSeeds, BeechSeeds, FirCone, PineCone, Acorn, AncientSeed, VineGreenSeeds
- **Bread / baked**: Bread, BreadDough
- **Pie / pastry**: PiquantPie, RoastedCrustPie, LoxPie, MagicallyStuffedShroom
- **Soup / stew / broth**: OnionSoup, CarrotSoup, TurnipStew, DeerStew, SerpentStew, BlackSoup, SizzlingBerryBroth, FierySvinstew
- **Egg**: ChickenEgg, AsksvinEgg, VoltureEgg, CookedEgg
- **Spice**: SpiceAshlands, SpiceMistlands, SpiceForests, SpicePlains, SpiceMountains, SpiceOceans
- **Feast (raid food)**: FeastAshlands_Material, FeastMountains_Material, FeastPlains_Material, FeastMistlands_Material, FeastMeadows_Material, FeastSwamps_Material, FeastBlackforest_Material, FeastOceans_Material
- **Other prepared**: Salad, MeatPlatter, Sausages, BloodPudding, ShocklateSmoothie, HoneyGlazedChicken, MisthareSupreme, SeekerAspic, MinceMeatSauce, SpicyMarmalade, QueensJam, YggdrasilPorridge, ScorchingMedley, Eyescream, MashedMeat, MarinatedGreens, SparklingShroomshake, BarleyWine

### Weapon (sub by class — natural Valheim mental model)

- **Sword (1H)**: SwordIron, SwordBronze, SwordBlackmetal, SwordSilver, SwordMistwalker, SwordIronFire, SwordDyrnwyn, SwordNiedhogg*
- **Sword (2H)**: THSwordSlayer*, THSwordKrom
- **Axe (1H)**: AxeBronze, AxeStone, AxeIron, AxeFlint, AxeBlackMetal, AxeBerzerkr*, AxeJotunBane
- **Battleaxe (2H)**: Battleaxe, BattleaxeCrystal
- **Mace**: MaceBronze, MaceIron, MaceSilver, MaceEldner*, MaceNeedle, Club
- **Spear**: SpearChitin, SpearBronze, SpearElderbark, SpearFlint, SpearCarapace, SpearWolfFang, SpearSplitner*
- **Atgeir**: AtgeirBronze, AtgeirIron, AtgeirBlackmetal, AtgeirHimminAfl
- **Knife**: KnifeFlint, KnifeCopper, KnifeChitin, KnifeBlackMetal, KnifeSilver, KnifeButcher, KnifeSkollAndHati
- **Sledge**: SledgeStagbreaker, SledgeIron, SledgeDemolisher
- **Bow**: Bow, BowFineWood, BowHuntsman, BowDraugrFang, BowSpineSnap, BowAshlands*
- **Crossbow**: CrossbowArbalest, CrossbowRipper*
- **Staff (magic)**: StaffShield, StaffLightning, StaffSkeleton, StaffFireball, StaffIceShards, StaffClusterbomb, StaffGreenRoots, StaffRedTroll
- **Scythe**: Scythe (and ScytheHandle = component, recategorize)
- **Fist**: FistFenrirClaw, Feaster

### Armor (sub by slot — also natural)

- **Chest**: every `Armor*Chest` (~25)
- **Legs**: every `Armor*Legs` / `Armor*Greaves` (~25)
- **Helmet**: every `Helmet*` (~20)
- **Cape**: every `Cape*` (~10)
- **Belt**: BeltStrength
- **Saddle**: SaddleLox, SaddleAsksvin

## Orthogonal tags (apply ALONGSIDE category)

These are *cross-cutting* attributes that any item can have. A Bronze Axe is both `Weapon/Axe` (category/subcategory) AND `Tier=Bronze` AND `Era=BlackForest`.

### Tier (progression)

Every Valheim crafted item slots into a known tier ladder. Numbering keeps them sortable:

| # | Tier | Era / biome unlock | Examples |
|---|---|---|---|
| 0 | Stone | Meadows starter | StoneRock, AxeStone, KnifeFlint |
| 1 | Flint / Wood | Meadows | Bow, ArrowWood, AxeFlint, ShieldWood |
| 2 | Bronze | Black Forest | SwordBronze, ArmorBronzeChest, HelmetBronze, ArrowBronze |
| 3 | Iron | Swamp | SwordIron, ArmorIronChest, AtgeirIron, ArrowIron |
| 4 | Silver / Obsidian | Mountains | SwordSilver, ArmorWolfChest, HelmetDrake, ArrowObsidian, ArrowFrost |
| 5 | BlackMetal | Plains | SwordBlackmetal, ArmorPaddedCuirass, ArmorFenringChest, ArrowNeedle, AtgeirBlackmetal |
| 6 | Carapace / Mistwalker | Mistlands | SwordMistwalker, ArmorCarapaceChest, ArmorRootChest, ArmorMageChest, ArrowCarapace, StaffFireball |
| 7 | Flametal / Ashlands | Ashlands | BowAshlands*, ArmorFlametalChest, HelmetFlametal, SwordDyrnwyn, ArrowCharred, MaceEldner* |
| 8 | Boss / Unique | drops/quests | TrophyDragonQueen, TrophyFader, Wishbone, CelestialFeather, DragonEgg |

### Biome (where the item is sourced / primarily used)

`Meadows`, `BlackForest`, `Swamp`, `Mountains`, `Plains`, `Mistlands`, `Ashlands`, `DeepNorth`, `Ocean`, `None`.

Useful for: *"show me all Ashlands-tier weapons being hoarded in low-tier biomes"* (audit progression cheats).

### Source (how the item enters the world)

- `Crafted` — has a recipe; player workbench output
- `Looted` — drops from monsters / treasure chests
- `Foraged` — picked up off the ground
- `Event` — Yule, midsummer, anniversary
- `Quest` — boss drops, Hildir's Request, Dyrnwyn fragments
- `ServerIssued` — has `customData["itemized.*"]` or HTML-tagged crafter name
- `Modded` — added by a mod (1 item in our data: `$PlumgaPlantItShovel`)

### Rarity / count-in-world

Computed from the data, not a fixed property: `Unique` (1 instance), `Rare` (2–10), `Uncommon` (11–100), `Common` (101–1000), `Bulk` (1000+). Drives the "anomaly" tab.

## Container groupings

Cleaner version of the current 6-bucket map view, expanded to 5 groups + 12 sub-groups. Each container resolves to exactly one path.

### A. Player Storage (player-placed)
- A.1 Wood-tier chest — `piece_chest_wood`, `piece_chest_barrel`, `Chest` (mini)
- A.2 Upgraded chest — `piece_chest`, `piece_chest_blackmetal`, `stonechest`
- A.3 Private (locked) chest — `piece_chest_private`

### B. Vehicles
- B.1 Land — `Cart`
- B.2 Sea (boats) — `Karve`, `VikingShip`, `VikingShip_Ashlands`
- B.3 Cargo — `CargoCrate`

### C. World Loot (procedurally placed)
- C.1 Meadows — `TreasureChest_meadows`, `TreasureChest_meadows_buried`
- C.2 Black Forest — `TreasureChest_blackforest`, `TreasureChest_forestcrypt`, `TreasureChest_fCrypt`, `TreasureChest_forestcrypt_hildir`
- C.3 Swamp — `TreasureChest_swamp`, `TreasureChest_sunkencrypt`, `TreasureChest_trollcave`
- C.4 Mountains — `TreasureChest_mountains`, `TreasureChest_mountaincave`, `TreasureChest_mountaincave_hildir`
- C.5 Plains — `TreasureChest_heath`, `TreasureChest_plains_stone`, `TreasureChest_plainsfortress_hildir`, `TreasureChest_heath_hildir`
- C.6 Mistlands — `TreasureChest_dvergrtown`, `TreasureChest_dvergrtower`, `TreasureChest_dvergr_loose_stone`
- C.7 Ashlands — `TreasureChest_charredfortress`, `TreasureChest_ashland_stone`
- C.8 Generic / wreckage — `loot_chest_wood`, `loot_chest_stone`, `shipwreck_karve_chest`

### D. Player Remains
- D.1 Tombstone — `Player_tombstone`

### E. Decorative / Ephemeral
- E.1 Ashlands pots — `piece_pot1`, `piece_pot1_cracked`, `piece_pot1_red`, `piece_pot2`, `piece_pot2_cracked`, `piece_pot2_red`, `piece_pot3`, `piece_pot3_cracked`, `piece_pot3_red`
- E.2 Yule gift boxes — `piece_gift1`, `piece_gift2`, `piece_gift3`
- E.3 Hildir's Request — `chest_hildir1/2/3` (technically items? double-check)
- E.4 Incinerator — `incinerator` (consumes input, technically a 1-shot inventory)

### F. Anomaly — building pieces with `items` key
- F.1 `woodwall`, `wood_floor*`, `wood_beam*`, `wood_pole*`, `sign`, `stone_wall_4x2` — only a handful of instances total but suspicious. Likely a mod that lets players attach storage to walls, OR a quirky ZDO encoding we should investigate.

## Design choices to flag

1. **Coins gets its own top-level category.** Treating it as a "Material" (its mechanical type) buries it; stewards reach for it constantly for wealth analytics. Singling it out costs nothing and saves clicks.

2. **`Trophy` is its own top-level, not under `Quest`.** Trophies aren't quest-bound; they're collectibles. Boss trophies (Eikthyr, DragonQueen, Yagluth, Fader) are flagged as `Quest` in the *Source* tag so they still surface in quest queries.

3. **`Cosmetic / Event` consolidates ArmorTunic*/ArmorDress*/HelmetHat*/Tankards/Fireworks** rather than splitting them under Armor and Tools and Misc. A steward looking at "what cosmetics are being collected" wants one bucket.

4. **`Mead` is its own category, not a Food sub.** They mechanically work differently (active buff vs hunger), and there are 35 of them — enough to deserve a top-level. Sub by `Active` vs `Base` (the unfermented pre-craft).

5. **Tier ladder uses integers 0–8.** Lets "show me ≥ Mistlands tier" be a single `>=6` comparison in any filter. The cosmetic items get tier `null`/`X` so they don't pollute progression queries.

6. **Suffixes vs prefixes drive most categorization.** `*_TW` would have marked Therzie mods (none observed). `Cooked*` flags cooked food. `Arrow*`/`Bolt*` ammo. `Mead*`/`MeadBase*` mead distinction. The pattern-match rules cover ~90% of items; a small override map handles the rest.

7. **Mod-flagged is BOTH a category AND a tag.** A modded item is most usefully shown alongside its vanilla peers (so a modded sword shows up in "weapons" filter) but also gets a tag-badge so it's visually distinct. Currently only 1 mod item in the data (`$PlumgaPlantItShovel`).

## Implementation paths (pick one)

**Path A — Static rules JSON** (recommended for V4 polish)
A single `D:\work\comfy\out\classification.json` keyed by item name → `{category, subcategory, tier, biome, source}`. Generated once by a Java tool that applies pattern rules to inventory.csv. Re-runnable if the modpack changes.

The report.html loads it on startup and uses it for:
- A category filter sidebar on the Items tab
- Sub-grouping on the Containers tab (collapse "World Loot > Mistlands")
- Color-coding by tier on the Map
- A new "Progression audit" tab in Anomalies — "show me Ashlands items in chests at Meadows coords"

Cost: ~2 hours. JSON is ~20 KB.

**Path B — Embedded in inventory.csv columns**
Add 4 columns to inventory.csv (`category, subcategory, tier, biome`) by re-running a small tool. Simpler client (no separate fetch) but the CSV grows by ~5 MB and you can't iterate on the classification without re-emitting.

**Path C — Hybrid**
Ship classification.json AS the source of truth, but ALSO bake the columns into inventory.csv as a convenience for users who want to query the CSV directly in Excel/DuckDB.

Recommendation: **Path A first** — fast, decoupled, easy to iterate. Add Path C later if a steward asks for it.

## Open questions (worth your call)

- **Hildir's Request chests** (`chest_hildir1/2/3`) — these appear as ITEM names in inventory.csv, not container names. Likely they're quest items dropped during Hildir's questline, stored inside player chests/tombstones. Confirm by checking a few `inventory.csv` rows where `item_name = chest_hildir1`.
- **The `woodwall` / `wood_floor` containers with `items` key** — only a handful of instances. Could be a real Comfy mod feature (storage walls?) or a save-corruption artifact. Worth one investigation pass before deciding what to do with them.
- **Tier mapping for borderline items** — is `ArmorRagsChest` Tier 0 or Tier 1? Does the Padded set sit at Plains-tier or as a separate "civilian" line? These are judgment calls; happy to defer to your read of the meta.

---

Next step: tell me which path (A / B / C), and I'll generate the classification + wire it into the report. Or push back on any category boundaries you'd draw differently — this is meant to be a starting point, not a fixed answer.
