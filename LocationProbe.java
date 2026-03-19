import net.kakoen.valheim.save.archive.hints.ValheimSaveReaderHints;
import net.kakoen.valheim.save.archive.save.Zdo;
import net.kakoen.valheim.save.parser.ZPackage;
import net.kakoen.valheim.save.decode.StableHashCode;

import java.io.*;
import java.util.*;
import java.util.stream.*;

/**
 * Probes:
 * 1. World location names (dungeon/POI inventory)
 * 2. Dropped item identification (by resolving hashes for item names)
 * 3. Better creature census (add Goblin variants + Fuling names)
 * 4. Building piece hash resolution attempt
 */
public class LocationProbe {

    static final Map<String, Integer> locationCounts = new TreeMap<>();
    static final Map<String, Integer> droppedItemCounts = new TreeMap<>();
    static final Map<String, Integer> creatureCounts = new TreeMap<>();

    // Dropped item ZDO hashes (from DeepProbe analysis)
    static final Set<Integer> DROPPED_ITEM_HASHES = new HashSet<>(Arrays.asList(109649212, 1272849455));

    // All creature prefab names (expanded list including Goblin/Fuling names)
    static final Set<String> CREATURES = new HashSet<>(Arrays.asList(
        // Meadows
        "Greyling","Neck","Boar","Deer","Crow","Seagal",
        // Black Forest
        "Greydwarf","Greydwarf_Elite","Greydwarf_Shaman","Troll",
        "Skeleton","Skeleton_Poison","Ghost","GhostLastWish",
        // Swamp
        "Draugr","Draugr_Elite","Draugr_Ranged",
        "Blob","BlobElite","Leech","Wraith","Abomination",
        // Mountains
        "Wolf","StoneGolem","Bat","Fenring","Fenring_Cultist","Hare","Ulv",
        // Plains
        "Goblin","Goblin_Berserker","Goblin_Shaman","GoblinBrute","GoblinArcher",
        "Deathsquito","Lox","BlobTar",
        // Ocean
        "Serpent","Leviathan",
        // Mistlands
        "Tick","Seeker","SeekerBrute","SeekerSoldier","Gjall",
        "Dverger","DvergerMage","DvergerMageFireLarge","DvergerMageSupportLightning",
        "SeekerQueen",
        // Ashlands
        "Fallen_Valkyrie","Fader","Morgen","CrawlerMelee",
        "Charred_Melee","Charred_Archer","Charred_Mage","Charred_Twitcher",
        "Asksvin","Volture","BoneSerpent","Jotun",
        // Misc
        "Surtling","Hen","Chicken","Boar_piggy","Wolf_cub","Lox_Calf"
    ));

    public static void main(String[] args) throws Exception {
        String dbPath = args.length > 0 ? args[0] : "ComfyEra14.db";

        // First build a hash->name lookup for item names
        Map<Integer, String> itemHashLookup = buildItemHashLookup();
        System.err.println("Item hash lookup size: " + itemHashLookup.size());

        ValheimSaveReaderHints hints = ValheimSaveReaderHints.builder()
                .resolveNames(true).failOnUnsupportedVersion(false).build();

        Map<Integer, String> hashToName = new HashMap<>(itemHashLookup);

        long t0 = System.currentTimeMillis();
        try (ZPackage pkg = new ZPackage(new File(dbPath))) {
            int worldVersion = pkg.readInt32();
            pkg.readDouble();
            pkg.readLong();
            pkg.readUInt();
            int totalZdos = pkg.readInt32();

            for (int i = 0; i < totalZdos; i++) {
                if (i % 500_000 == 0) System.err.print(".");
                try {
                    Zdo zdo = new Zdo(pkg, worldVersion, hints);
                    int hash = zdo.getPrefab();
                    String prefab = zdo.getPrefabName();
                    if (prefab == null) prefab = hashToName.get(hash);

                    // creatures
                    if (prefab != null && CREATURES.contains(prefab)) {
                        creatureCounts.merge(prefab, 1, Integer::sum);
                    }

                    // dropped items
                    if (DROPPED_ITEM_HASHES.contains(hash)) {
                        String itemName = hashToName.getOrDefault(hash, "hash:" + hash);
                        droppedItemCounts.merge(itemName, 1, Integer::sum);
                    }

                } catch (Throwable e) { }
            }
            System.err.println();

            // Read zones to get location names
            try {
                int gzc = pkg.readInt32();
                for (int i = 0; i < gzc; i++) { pkg.readInt32(); pkg.readInt32(); }
                pkg.readInt32(); // pgwVersion
                pkg.readInt32(); // locationVersion
                int gkc = pkg.readInt32();
                for (int i = 0; i < gkc; i++) pkg.readString();
                pkg.readBool();
                int plc = pkg.readInt32();
                System.err.println("Reading " + plc + " prefab locations...");
                for (int i = 0; i < plc; i++) {
                    String name = pkg.readString();
                    pkg.readSingle(); pkg.readSingle(); pkg.readSingle(); // pos
                    pkg.readBool(); // generated
                    locationCounts.merge(name, 1, Integer::sum);
                }
            } catch (Throwable e) {
                System.err.println("Zones error: " + e.getMessage());
            }
        }

        System.err.println("Done in " + (System.currentTimeMillis() - t0) + "ms");

        System.out.println("=== WORLD LOCATIONS (prefab location names) ===");
        System.out.println("  Total unique location types: " + locationCounts.size());
        locationCounts.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .forEach(e -> System.out.printf("  %5dx  %s%n", e.getValue(), e.getKey()));

        System.out.println("\n=== DROPPED ITEMS ON GROUND ===");
        System.out.println("  (ZDOs with dropped-item property pattern)");
        droppedItemCounts.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .forEach(e -> System.out.printf("  %5dx  %s%n", e.getValue(), e.getKey()));

        System.out.println("\n=== FULL CREATURE CENSUS ===");
        int total = creatureCounts.values().stream().mapToInt(Integer::intValue).sum();
        System.out.println("  Total: " + total);
        creatureCounts.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .forEach(e -> System.out.printf("  %5dx  %s%n", e.getValue(), e.getKey()));
    }

    static Map<Integer, String> buildItemHashLookup() {
        // All known Valheim items/prefabs that might appear as dropped items
        String[] items = {
            // Resources
            "Wood","FineWood","RoundLog","YggdrasilWood","ElderBark","Blackwood","AshTreeFloor",
            "Stone","Coal","Flint","Obsidian","Tar","BlackMarble","Grausten",
            "BoneFragments","TrophySkeleton","TrophyDraugr","TrophyDraugrElite",
            "TrophyGreydwarf","TrophyGreydwarfShaman","TrophyGreydwarfBrute",
            "TrophyTroll","TrophyBlob","TrophyLeech","TrophyAbomination",
            "TrophyBoar","TrophyNeck","TrophyDeer","TrophyWolf","TrophyFenring",
            "TrophyDeathsquito","TrophyGoblin","TrophyGoblinShaman","TrophyGoblinBrute","TrophyGoblinKing",
            "TrophyLox","TrophySerpent","TrophyBat","TrophyStoneGolem","TrophyHare",
            "TrophySeeker","TrophySeekerBrute","TrophySeekerSoldier","TrophyGjall","TrophySeekerQueen",
            "TrophyDverger","TrophyFader","TrophySkeletonHildir",
            "TrophySurtling","TrophyCharredTwitcher","TrophyCharredMage",
            "TrophyMorgen","TrophyAsksvin","TrophyFallenValkyrie","TrophyVolture","TrophyCrawler",
            // Metals
            "Copper","CopperOre","CopperScrap","Tin","TinOre","Bronze","BronzeScrap",
            "Iron","IronOre","IronScrap","Silver","SilverOre","BlackMetal","BlackMetalScrap",
            "Flametal","FlametalOre",
            // Misc drops
            "GreydwarfEye","Resin","Thistle","Mushroom","Blueberries","Raspberry","CloudberryBush",
            "Dandelion","Barley","Flax","Carrot","Turnip","Onion",
            "CarrotSeeds","TurnipSeeds","OnionSeeds","JotunPuffs","Magecap",
            "MushroomBlue","MushroomYellow","MushroomJotunPuffs","MushroomMagecap",
            "Feathers","LeatherScraps","Entrails","DeerHide","LoxPelt","WolfHide","WolfClaw","WolfPelt",
            "Honey","FreezeGland","DragonTear","Wishbone","Thunderstone","Sap",
            "AncientSeed","CryptKey","SwampKey","Kingsroot","AskHide",
            "Chain","Ruby","GemstoneRed","GemstoneGreen","GemstoneBlue",
            "HelmetDverger","DvergrKey","Lantern","BombSiege",
            "SerpentScale","SerpentMeat","LoxMeat","WolfMeat","ChickenMeat","HareMeat","NeckTail",
            "MeadPoisonResist","MeadFrostResist","MeadStaminaLingering","MeadEitrMinor",
            "MisthareSupreme","SeekerAspic","MeatPlatter","Salad","HoneyGlazedChicken",
            // Weapons/tools dropped
            "SwordBronze","SwordIron","SwordBlackmetal","SwordNiedhogg",
            "AtgeirBronze","AtgeirIron","AtgeirBlackmetal","AtgeirHimminAfl",
            "SpearBronze","SpearElderbark","SpearWolfFang","SpearCarapace",
            "AxeBronze","AxeIron","AxeBlackMetal","AxeJotunBane",
            "KnifeChitin","KnifeBlackMetal","KnifeSkollAndHati",
            "BowFineWood","BowHuntsman","BowDraugrFang","BowAshlands",
            "ShieldBronzeBuckler","ShieldIronBuckler","ShieldBlackmetal",
            "ArmorBronzeLegs","ArmorIronLegs","ArmorPaddedLegs","ArmorCarapaceLegs",
            "CapeLinen","CapeFeather","CapeWolf","CapeTrollHide","CapeTwilight",
            "SurtlingCore","WitheredBone","Tankard","Tankard_dvergr","TankardAnniversary",
            "BombSiege","BombOoze","ArrowWood","ArrowFire","ArrowPoison",
            "ArrowSilver","ArrowCarapace","ArrowCharred",
            // ItemDrop prefab names
            "ItemDrop",
        };
        Map<Integer, String> lookup = new HashMap<>();
        for (String name : items) {
            lookup.put(StableHashCode.getStableHashCode(name), name);
        }
        return lookup;
    }
}
