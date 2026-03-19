package com.valheim.viewer.extractor;

import com.valheim.viewer.contract.Classification;
import com.valheim.viewer.contract.DroppedItem;
import com.valheim.viewer.contract.DroppedItem.Taxonomy;

import java.util.*;

/**
 * Stamps Taxonomy and Classification on DroppedItem records.
 *
 * Classification:
 *   kind = "dropped_item" always.
 *
 * Taxonomy:
 *   category: weapon|armor|tool|consumable|resource|trophy|utility|unknown
 *   subcategory: more specific (e.g. sword, helmet, potion, ore)
 *   tier: meadows|black_forest|swamp|mountain|plains|mistlands|ashlands|all|unknown
 *   source: vanilla|mod|unknown
 *   confidence: 1.0 exact match, 0.8 pattern match, 0.5 unknown
 *
 * Economy:
 *   countUnknownEconomyItems(names) counts item names not in the vanilla table.
 */
public class TaxonomyClassifier {

    private static final class TaxEntry {
        final String category, subcategory, tier;
        TaxEntry(String cat, String sub, String tier) {
            this.category    = cat;
            this.subcategory = sub;
            this.tier        = tier;
        }
    }

    // ---- Vanilla item table: prefab/name → TaxEntry ----
    // Items use their display name (same as prefab in most cases).
    // Covers the most common items; unknowns fall back to pattern matching.

    private static final Map<String, TaxEntry> ITEMS = new HashMap<>(512);

    static {
        // ----- Weapons -----
        // Swords
        item("SwordBronze",        "weapon", "sword",   "black_forest");
        item("SwordIron",          "weapon", "sword",   "swamp");
        item("SwordSilver",        "weapon", "sword",   "mountain");
        item("SwordBlackmetal",    "weapon", "sword",   "plains");
        item("SwordMistwalker",    "weapon", "sword",   "mistlands");
        item("SwordNiedhogg",      "weapon", "sword",   "ashlands");

        // Axes (one-handed)
        item("AxeFlint",           "weapon", "axe",     "meadows");
        item("AxeBronze",          "weapon", "axe",     "black_forest");
        item("AxeIron",            "weapon", "axe",     "swamp");
        item("AxeBlackmetal",      "weapon", "axe",     "plains");
        item("AxeJotunBane",       "weapon", "axe",     "mistlands");

        // Battleaxes (two-handed)
        item("Battleaxe",          "weapon", "battleaxe","swamp");
        item("BattleaxeCrystal",   "weapon", "battleaxe","mountain");

        // Knives
        item("KnifeFlint",         "weapon", "knife",   "meadows");
        item("KnifeCopper",        "weapon", "knife",   "black_forest");
        item("KnifeChitin",        "weapon", "knife",   "ocean");
        item("KnifeBlackmetal",    "weapon", "knife",   "plains");
        item("KnifeSkildir",       "weapon", "knife",   "mountain");

        // Maces / clubs
        item("Club",               "weapon", "club",    "meadows");
        item("MaceBronze",         "weapon", "mace",    "black_forest");
        item("MaceIron",           "weapon", "mace",    "swamp");
        item("MaceSilver",         "weapon", "mace",    "mountain");
        item("MaceNeedle",         "weapon", "mace",    "plains");
        item("Stagbreaker",        "weapon", "club",    "black_forest");
        item("THSwordKrom",        "weapon", "sword",   "plains");

        // Polearms / spears / atgeirs
        item("SpearFlint",         "weapon", "spear",   "meadows");
        item("SpearBronze",        "weapon", "spear",   "black_forest");
        item("SpearElderbark",     "weapon", "spear",   "swamp");
        item("SpearWolfFang",      "weapon", "spear",   "mountain");
        item("SpearCarapace",      "weapon", "spear",   "mistlands");
        item("SpearChitin",        "weapon", "spear",   "ocean");
        item("Atgeir",             "weapon", "atgeir",  "black_forest");
        item("AtgeirBronze",       "weapon", "atgeir",  "black_forest");
        item("AtgeirIron",         "weapon", "atgeir",  "swamp");
        item("AtgeirBlackmetal",   "weapon", "atgeir",  "plains");
        item("AtgeirHimminAfl",    "weapon", "atgeir",  "mistlands");

        // Bows
        item("Bow",                "weapon", "bow",     "meadows");
        item("BowFineWood",        "weapon", "bow",     "black_forest");
        item("BowHuntsman",        "weapon", "bow",     "swamp");
        item("BowDraugrFang",      "weapon", "bow",     "swamp");
        item("BowSpineSnap",       "weapon", "bow",     "plains");
        item("BowAshlands",        "weapon", "bow",     "ashlands");

        // Crossbows
        item("CrossbowArbalest",   "weapon", "crossbow","mistlands");

        // Arrows
        item("ArrowFlint",         "weapon", "arrow",   "meadows");
        item("ArrowBronze",        "weapon", "arrow",   "black_forest");
        item("ArrowIron",          "weapon", "arrow",   "swamp");
        item("ArrowSilver",        "weapon", "arrow",   "mountain");
        item("ArrowPoison",        "weapon", "arrow",   "plains");
        item("ArrowObsidian",      "weapon", "arrow",   "mountain");
        item("ArrowFire",          "weapon", "arrow",   "all");
        item("ArrowNeedle",        "weapon", "arrow",   "plains");
        item("ArrowCarapace",      "weapon", "arrow",   "mistlands");
        item("ArrowCharred",       "weapon", "arrow",   "ashlands");
        item("BoltBone",           "weapon", "bolt",    "black_forest");
        item("BoltIron",           "weapon", "bolt",    "swamp");
        item("BoltBlackmetal",     "weapon", "bolt",    "plains");
        item("BoltCarapace",       "weapon", "bolt",    "mistlands");
        item("BoltAshlands",       "weapon", "bolt",    "ashlands");

        // Shields
        item("ShieldWood",         "weapon", "shield",  "meadows");
        item("ShieldBronzeBuckler","weapon", "shield",  "black_forest");
        item("ShieldIronSquare",   "weapon", "shield",  "swamp");
        item("ShieldIronTower",    "weapon", "shield",  "swamp");
        item("ShieldSilver",       "weapon", "shield",  "mountain");
        item("ShieldBlackmetal",   "weapon", "shield",  "plains");
        item("ShieldBlackmetalTower","weapon","shield", "plains");
        item("ShieldCarapace",     "weapon", "shield",  "mistlands");
        item("ShieldCarapaceBuckler","weapon","shield", "mistlands");
        item("ShieldFlametalTower","weapon", "shield",  "ashlands");
        item("ShieldDragonTear",   "weapon", "shield",  "mountain");
        item("ShieldOakwood",      "weapon", "shield",  "black_forest");
        item("ShieldFlametal",     "weapon", "shield",  "ashlands");

        // Fists / special
        item("FistFenris",         "weapon", "fist",    "mountain");

        // ----- Armor -----
        // Helmets
        item("HelmetLeather",      "armor", "helmet",   "meadows");
        item("HelmetBronze",       "armor", "helmet",   "black_forest");
        item("HelmetIron",         "armor", "helmet",   "swamp");
        item("HelmetDrake",        "armor", "helmet",   "mountain");
        item("HelmetPadded",       "armor", "helmet",   "plains");
        item("HelmetMage",         "armor", "helmet",   "mistlands");
        item("HelmetRoot",         "armor", "helmet",   "swamp");
        item("HelmetFenring",      "armor", "helmet",   "mountain");
        item("HelmetCarapace",     "armor", "helmet",   "mistlands");
        item("HelmetFlametal",     "armor", "helmet",   "ashlands");
        item("HelmetYule",         "armor", "helmet",   "all");

        // Chest armors
        item("ArmorLeatherChest",  "armor", "chest",    "meadows");
        item("ArmorBronzeChest",   "armor", "chest",    "black_forest");
        item("ArmorIronChest",     "armor", "chest",    "swamp");
        item("ArmorWolfChest",     "armor", "chest",    "mountain");
        item("ArmorPaddedCuirass", "armor", "chest",    "plains");
        item("ArmorMageChest",     "armor", "chest",    "mistlands");
        item("ArmorRootChest",     "armor", "chest",    "swamp");
        item("ArmorFenringChest",  "armor", "chest",    "mountain");
        item("ArmorCarapaceChest", "armor", "chest",    "mistlands");
        item("ArmorFlametalChest", "armor", "chest",    "ashlands");

        // Leg armors
        item("ArmorLeatherLegs",   "armor", "legs",     "meadows");
        item("ArmorBronzeLegs",    "armor", "legs",     "black_forest");
        item("ArmorIronLegs",      "armor", "legs",     "swamp");
        item("ArmorWolfLegs",      "armor", "legs",     "mountain");
        item("ArmorPaddedGreaves", "armor", "legs",     "plains");
        item("ArmorMageLegs",      "armor", "legs",     "mistlands");
        item("ArmorRootLegs",      "armor", "legs",     "swamp");
        item("ArmorFenringLegs",   "armor", "legs",     "mountain");
        item("ArmorCarapaceLegs",  "armor", "legs",     "mistlands");
        item("ArmorFlametalLegs",  "armor", "legs",     "ashlands");

        // Capes
        item("CapeDeerHide",       "armor", "cape",     "meadows");
        item("CapeWolf",           "armor", "cape",     "mountain");
        item("CapeLox",            "armor", "cape",     "plains");
        item("CapeFeather",        "armor", "cape",     "mistlands");
        item("CapeAsh",            "armor", "cape",     "ashlands");
        item("CapeOdin",           "armor", "cape",     "all");

        // ----- Tools -----
        item("Hammer",             "tool", "hammer",    "all");
        item("Hoe",                "tool", "hoe",       "all");
        item("Cultivator",         "tool", "cultivator","all");
        item("FishingRod",         "tool", "fishing",   "all");
        item("FishingRodIron",     "tool", "fishing",   "all");
        item("Torch",              "tool", "light",     "all");
        item("TorchMist",          "tool", "light",     "mistlands");

        // ----- Consumables: potions -----
        item("MeadHealthMinor",    "consumable", "potion", "all");
        item("MeadHealthMedium",   "consumable", "potion", "all");
        item("MeadHealthMajor",    "consumable", "potion", "all");
        item("MeadStaminaMinor",   "consumable", "potion", "all");
        item("MeadStaminaMedium",  "consumable", "potion", "all");
        item("MeadEitrMinor",      "consumable", "potion", "mistlands");
        item("MeadFrostResist",    "consumable", "potion", "all");
        item("MeadPoisonResist",   "consumable", "potion", "all");
        item("MeadBaseHealthMinor","consumable", "mead_base","all");
        item("MeadBaseHealthMedium","consumable","mead_base","all");
        item("MeadBaseHealthMajor","consumable", "mead_base","all");
        item("MeadBaseStaminaMinor","consumable","mead_base","all");
        item("MeadBaseStaminaMedium","consumable","mead_base","all");
        item("MeadBaseEitrMinor",  "consumable", "mead_base","mistlands");
        item("MeadBaseFrostResist","consumable", "mead_base","all");
        item("MeadBasePoisonResist","consumable","mead_base","all");

        // Consumables: food
        item("RawMeat",            "consumable", "food_raw",   "meadows");
        item("NeckTail",           "consumable", "food_raw",   "meadows");
        item("DeerMeat",           "consumable", "food_raw",   "meadows");
        item("Boar_Meat",          "consumable", "food_raw",   "meadows");
        item("Wolf_Meat",          "consumable", "food_raw",   "mountain");
        item("LoxMeat",            "consumable", "food_raw",   "plains");
        item("ChickenMeat",        "consumable", "food_raw",   "meadows");
        item("HareMeat",           "consumable", "food_raw",   "mistlands");
        item("AsksvinMeat",        "consumable", "food_raw",   "ashlands");
        item("CookedMeat",         "consumable", "food",       "meadows");
        item("CookedDeerMeat",     "consumable", "food",       "meadows");
        item("CookedLoxMeat",      "consumable", "food",       "plains");
        item("CookedWolfMeat",     "consumable", "food",       "mountain");
        item("CookedChickenMeat",  "consumable", "food",       "meadows");
        item("CookedHareMeat",     "consumable", "food",       "mistlands");
        item("CookedAsksvinMeat",  "consumable", "food",       "ashlands");
        item("Mushroom",           "consumable", "food",       "all");
        item("MushroomBlue",       "consumable", "food",       "mountain");
        item("MushroomYellow",     "consumable", "food",       "swamp");
        item("Raspberry",          "consumable", "food",       "meadows");
        item("Blueberries",        "consumable", "food",       "black_forest");
        item("Cloudberry",         "consumable", "food",       "plains");
        item("Carrot",             "consumable", "food",       "black_forest");
        item("Turnip",             "consumable", "food",       "swamp");
        item("Onion",              "consumable", "food",       "mountain");
        item("Barley",             "consumable", "food",       "plains");
        item("Flax",               "consumable", "food",       "plains");
        item("CarrotSoup",         "consumable", "food",       "black_forest");
        item("TurnipStew",         "consumable", "food",       "swamp");
        item("BlackSoup",          "consumable", "food",       "swamp");
        item("MisthareSupreme",    "consumable", "food",       "mistlands");
        item("SerpentStew",        "consumable", "food",       "ocean");
        item("WolfMeatSkewer",     "consumable", "food",       "mountain");
        item("LoxPie",             "consumable", "food",       "plains");
        item("BarleywineBase",     "consumable", "mead_base",  "plains");
        item("Barleywine",         "consumable", "potion",     "plains");
        item("FishCooked",         "consumable", "food",       "all");
        item("FishRaw",            "consumable", "food_raw",   "all");
        item("Egg",                "consumable", "food_raw",   "meadows");
        item("Bread",              "consumable", "food",       "plains");
        item("BreadDough",         "consumable", "food_raw",   "plains");
        item("HoneyGlazedChicken", "consumable", "food",       "meadows");
        item("MagicallyStuffedShroom","consumable","food",     "mistlands");
        item("Salad",              "consumable", "food",       "mistlands");
        item("Sap",                "consumable", "food_raw",   "mistlands");
        item("BugMeat",            "consumable", "food_raw",   "mistlands");
        item("CookedBugMeat",      "consumable", "food",       "mistlands");
        item("ScaleFilet",         "consumable", "food_raw",   "ashlands");
        item("CookedScaleFilet",   "consumable", "food",       "ashlands");
        item("ChickenEgg",         "consumable", "food_raw",   "meadows");
        item("Honey",              "consumable", "food",       "all");
        item("VoltureMeatCooked",  "consumable", "food",       "ashlands");
        item("VulturedMeatRaw",    "consumable", "food_raw",   "ashlands");

        // ----- Resources: wood / stone -----
        item("Wood",               "resource", "wood",    "all");
        item("FineWood",           "resource", "wood",    "black_forest");
        item("RoundLog",           "resource", "wood",    "mountain");
        item("ElderBark",          "resource", "bark",    "swamp");
        item("YggdrasilWood",      "resource", "wood",    "mistlands");
        item("Stone",              "resource", "stone",   "all");
        item("BlackMarble",        "resource", "stone",   "mistlands");
        item("Obsidian",           "resource", "stone",   "mountain");
        item("Flametal",           "resource", "ore",     "ashlands");
        item("FlametalOre",        "resource", "ore",     "ashlands");

        // Metals
        item("CopperOre",          "resource", "ore",     "black_forest");
        item("Copper",             "resource", "metal",   "black_forest");
        item("TinOre",             "resource", "ore",     "black_forest");
        item("Tin",                "resource", "metal",   "black_forest");
        item("Bronze",             "resource", "metal",   "black_forest");
        item("IronScrap",          "resource", "ore",     "swamp");
        item("Iron",               "resource", "metal",   "swamp");
        item("SilverOre",          "resource", "ore",     "mountain");
        item("Silver",             "resource", "metal",   "mountain");
        item("BlackMetalScrap",    "resource", "ore",     "plains");
        item("BlackMetal",         "resource", "metal",   "plains");
        item("CopperScrap",        "resource", "ore",     "black_forest");
        item("Softtissue",         "resource", "material","mistlands");
        item("Carapace",           "resource", "material","mistlands");
        item("MorgenSinew",        "resource", "material","ashlands");
        item("AncientSeed",        "resource", "seed",    "black_forest");
        item("WitheredBone",       "resource", "material","swamp");
        item("WolfClaw",           "resource", "material","mountain");
        item("WolfFang",           "resource", "material","mountain");
        item("ChainLink",          "resource", "material","swamp");
        item("Entrails",           "resource", "material","swamp");
        item("BoneFragments",      "resource", "material","all");
        item("FlintStone",         "resource", "stone",   "meadows");
        item("Flint",              "resource", "material","meadows");
        item("Resin",              "resource", "material","all");
        item("LeatherScraps",      "resource", "material","meadows");
        item("DeerHide",           "resource", "material","meadows");
        item("Feathers",           "resource", "material","all");
        item("Chitin",             "resource", "material","ocean");
        item("TrollHide",          "resource", "material","black_forest");
        item("WolfPelt",           "resource", "material","mountain");
        item("LoxPelt",            "resource", "material","plains");
        item("ScaleHide",          "resource", "material","ashlands");
        item("SerpentScale",       "resource", "material","ocean");
        item("Coal",               "resource", "material","all");
        item("Turnip_Seeds",       "resource", "seed",    "swamp");
        item("Carrot_Seeds",       "resource", "seed",    "black_forest");
        item("Onion_Seeds",        "resource", "seed",    "mountain");
        item("SeedCarrot",         "resource", "seed",    "black_forest");
        item("SeedTurnip",         "resource", "seed",    "swamp");
        item("SeedOnion",          "resource", "seed",    "mountain");
        item("SeedBarley",         "resource", "seed",    "plains");
        item("SeedFlax",           "resource", "seed",    "plains");
        item("JotunPuffs",         "resource", "seed",    "mistlands");
        item("Magecap",            "resource", "seed",    "mistlands");
        item("Bloodbag",           "resource", "material","swamp");
        item("Guck",               "resource", "material","swamp");
        item("Thistle",            "resource", "material","black_forest");
        item("Dandelion",          "resource", "material","meadows");
        item("Needle",             "resource", "material","plains");
        item("QueensJam",          "consumable","food",   "meadows");
        item("DvergerNeedle",      "resource", "material","mistlands");
        item("Eitr",               "resource", "material","mistlands");
        item("BlackCore",          "resource", "material","mistlands");
        item("Mandible",           "resource", "material","mistlands");
        item("GoblinTotem",        "resource", "material","plains");
        item("DragonTear",         "resource", "material","mountain");
        item("SurtlingCore",       "resource", "material","swamp");
        item("Amber",              "resource", "material","all");
        item("AmberPearl",         "resource", "material","all");
        item("Ruby",               "resource", "material","all");
        item("Coins",              "utility",  "currency","all");
        item("CryptKey",           "utility",  "key",     "swamp");
        item("SwampKey",           "utility",  "key",     "swamp");
        item("RustyKey",           "utility",  "key",     "all");
        item("BossStone_Eikthyr",  "utility",  "forsaken_tablet","meadows");

        // ----- Trophies -----
        item("TrophyBoar",         "trophy", "trophy", "meadows");
        item("TrophyNeck",         "trophy", "trophy", "meadows");
        item("TrophyDeer",         "trophy", "trophy", "meadows");
        item("TrophyGreydwarf",    "trophy", "trophy", "black_forest");
        item("TrophyGreydwarfBrute","trophy","trophy", "black_forest");
        item("TrophyGreydwarfShaman","trophy","trophy","black_forest");
        item("TrophySkeleton",     "trophy", "trophy", "black_forest");
        item("TrophyTroll",        "trophy", "trophy", "black_forest");
        item("TrophyTheElder",     "trophy", "boss_trophy","black_forest");
        item("TrophyLeech",        "trophy", "trophy", "swamp");
        item("TrophyDraugr",       "trophy", "trophy", "swamp");
        item("TrophyDraugrElite",  "trophy", "trophy", "swamp");
        item("TrophyBlob",         "trophy", "trophy", "swamp");
        item("TrophyAbomination",  "trophy", "trophy", "swamp");
        item("TrophyWraith",       "trophy", "trophy", "swamp");
        item("TrophyBonemass",     "trophy", "boss_trophy","swamp");
        item("TrophySurtling",     "trophy", "trophy", "swamp");
        item("TrophyGoblin",       "trophy", "trophy", "plains");
        item("TrophyGoblinKing",   "trophy", "boss_trophy","plains");
        item("TrophyGoblinBrute",  "trophy", "trophy", "plains");
        item("TrophyDeathsquito",  "trophy", "trophy", "plains");
        item("TrophyLox",          "trophy", "trophy", "plains");
        item("TrophyWolf",         "trophy", "trophy", "mountain");
        item("TrophyDrake",        "trophy", "trophy", "mountain");
        item("TrophyFenring",      "trophy", "trophy", "mountain");
        item("TrophySGolem",       "trophy", "trophy", "mountain");
        item("TrophyDragonQueen",  "trophy", "boss_trophy","mountain");
        item("TrophyHare",         "trophy", "trophy", "mistlands");
        item("TrophyTick",         "trophy", "trophy", "mistlands");
        item("TrophySeeker",       "trophy", "trophy", "mistlands");
        item("TrophySeekerBrute",  "trophy", "trophy", "mistlands");
        item("TrophyGjall",        "trophy", "trophy", "mistlands");
        item("TrophyQueenBee",     "trophy", "trophy", "all");
        item("TrophySeekerQueen",  "trophy", "boss_trophy","mistlands");
        item("TrophyCharredWarrior","trophy","trophy", "ashlands");
        item("TrophyAsksvin",      "trophy", "trophy", "ashlands");
        item("TrophyFader",        "trophy", "boss_trophy","ashlands");
        item("TrophyMorgen",       "trophy", "trophy", "ashlands");
        item("TrophySerpent",      "trophy", "trophy", "ocean");

        // ----- Utility -----
        item("Tankard",            "utility", "vessel", "all");
        item("TankardAnniversary", "utility", "vessel", "all");
        item("BeltStrength",       "utility", "belt",   "mountain");
        item("NecklaceOfTheSea",   "utility", "necklace","ocean");
        item("BikeHorn",           "utility", "misc",   "all");
        item("YmirRemains",        "utility", "misc",   "mountain");
        item("Demister",           "utility", "misc",   "mistlands");
        item("HelmetPointyHat",    "utility", "misc",   "all");
        item("Wishbone",           "utility", "misc",   "swamp");
        item("ThunderstoneRing",   "utility", "ring",   "all");
        item("GemRed",             "utility", "gem",    "all");
        item("GemGreen",           "utility", "gem",    "all");
        item("GemBlue",            "utility", "gem",    "all");
    }

    private static void item(String name, String cat, String sub, String tier) {
        ITEMS.put(name, new TaxEntry(cat, sub, tier));
    }

    // ---- DroppedItem classification ----

    public void classify(List<DroppedItem> items) {
        for (DroppedItem d : items) {
            d.taxonomy       = buildTaxonomy(d.name != null ? d.name : d.prefab);
            d.classification = Classification.of("dropped_item");
        }
    }

    private Taxonomy buildTaxonomy(String name) {
        Taxonomy t = new Taxonomy();
        if (name == null || name.startsWith("hash:")) {
            t.category    = "unknown";
            t.subcategory = null;
            t.tier        = "unknown";
            t.source      = "unknown";
            t.confidence  = 0.0;
            return t;
        }

        TaxEntry entry = ITEMS.get(name);
        if (entry != null) {
            t.category    = entry.category;
            t.subcategory = entry.subcategory;
            t.tier        = entry.tier;
            t.source      = "vanilla";
            t.confidence  = 1.0;
            return t;
        }

        // Pattern fallback
        t.source = "mod";
        t.confidence = 0.5;
        t.tier = "unknown";

        String lower = name.toLowerCase();
        if (matchesAny(lower, "sword","axe","bow","knife","shield","spear","atgeir","mace",
                               "club","crossbow","arrow","bolt","battleaxe","fist")) {
            t.category = "weapon"; t.subcategory = guessWeaponSub(lower);
        } else if (matchesAny(lower, "helmet","armor","cape","legs","greaves","cuirass")) {
            t.category = "armor"; t.subcategory = guessArmorSub(lower);
        } else if (matchesAny(lower, "hammer","hoe","cultivator","fishingrod","torch")) {
            t.category = "tool"; t.subcategory = null;
        } else if (matchesAny(lower, "mead","potion","elixir","tonic")) {
            t.category = "consumable"; t.subcategory = "potion";
        } else if (matchesAny(lower, "meat","fish","berry","soup","stew","bread","egg","honey")) {
            t.category = "consumable"; t.subcategory = "food";
        } else if (matchesAny(lower, "ore","scrap","ingot","metal","wood","stone","pelt","hide","scale")) {
            t.category = "resource"; t.subcategory = "material";
        } else if (lower.startsWith("trophy")) {
            t.category = "trophy"; t.subcategory = "trophy";
        } else if (matchesAny(lower, "seed","spore")) {
            t.category = "resource"; t.subcategory = "seed";
        } else {
            t.category = "unknown"; t.subcategory = null; t.source = "mod";
        }
        return t;
    }

    private static boolean matchesAny(String lower, String... keywords) {
        for (String kw : keywords) if (lower.contains(kw)) return true;
        return false;
    }

    private static String guessWeaponSub(String lower) {
        if (lower.contains("sword"))      return "sword";
        if (lower.contains("axe"))        return "axe";
        if (lower.contains("bow"))        return "bow";
        if (lower.contains("knife"))      return "knife";
        if (lower.contains("shield"))     return "shield";
        if (lower.contains("spear"))      return "spear";
        if (lower.contains("atgeir"))     return "atgeir";
        if (lower.contains("mace"))       return "mace";
        if (lower.contains("crossbow"))   return "crossbow";
        if (lower.contains("arrow"))      return "arrow";
        if (lower.contains("bolt"))       return "bolt";
        if (lower.contains("battleaxe"))  return "battleaxe";
        return "melee";
    }

    private static String guessArmorSub(String lower) {
        if (lower.contains("helmet"))     return "helmet";
        if (lower.contains("cape"))       return "cape";
        if (lower.contains("legs") || lower.contains("greaves")) return "legs";
        return "chest";
    }

    // ---- Economy unknown count ----

    /**
     * Returns the number of item names in the given set that are not in the
     * vanilla taxonomy table. Used to populate WorldSummary.stats.economy.unknown_types.
     */
    public int countUnknownEconomyItems(Collection<String> itemNames) {
        int unknown = 0;
        for (String name : itemNames) {
            if (!ITEMS.containsKey(name)) unknown++;
        }
        return unknown;
    }
}
