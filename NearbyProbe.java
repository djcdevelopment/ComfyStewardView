import net.kakoen.valheim.save.archive.hints.ValheimSaveReaderHints;
import net.kakoen.valheim.save.archive.save.Zdo;
import net.kakoen.valheim.save.parser.ZPackage;
import net.kakoen.valheim.save.decode.StableHashCode;

import java.io.*;
import java.util.*;

/**
 * Profiles ALL unresolved hashes found near z=-8000 (Ashlands area)
 * and also builds a world-wide count of all unresolved hashes that look
 * like dropped items (have stack/crafterName/spawntime properties).
 */
public class NearbyProbe {

    // From the DumpUnknown nearby analysis — hashes found near z=-8000
    static final int[] NEARBY_UNKNOWNS = {
        1703108136, -293234486, -1661430005, -1799123710,
        109649211, 1576173780, 109649213, 109649207,
        1172889253, 109649209, 432248582, -405903669,
        // also add our main targets
        109649212, 1272849455
    };

    static final int DUMP_LIMIT = 2;

    public static void main(String[] args) throws Exception {
        // Phase 1: Try to resolve nearby hashes
        System.out.println("=== RESOLVING NEARBY ASHLANDS HASHES ===");
        // Build extended candidate list including systematic generation
        Map<Integer, String> resolved = new HashMap<>();
        String[] candidates = buildMassiveCandidateList();
        System.out.println("Trying " + candidates.length + " candidates...");
        Set<Integer> targets = new HashSet<>();
        for (int h : NEARBY_UNKNOWNS) targets.add(h);

        for (String name : candidates) {
            int h = StableHashCode.getStableHashCode(name);
            if (targets.contains(h) && !resolved.containsKey(h)) {
                resolved.put(h, name);
                System.out.println("  RESOLVED: hash:" + h + " = '" + name + "'");
            }
        }

        // Phase 2: Profile all nearby unknowns and count world-wide
        System.out.println("\n=== PROPERTY PROFILES + WORLD COUNTS ===");
        ValheimSaveReaderHints hints = ValheimSaveReaderHints.builder()
                .resolveNames(true).failOnUnsupportedVersion(false).build();

        Map<Integer, Integer> worldCounts = new TreeMap<>();
        Map<Integer, Map<String, Object>> profiles = new LinkedHashMap<>();
        Map<Integer, Integer> dumpCounts = new HashMap<>();
        for (int h : NEARBY_UNKNOWNS) {
            worldCounts.put(h, 0);
            dumpCounts.put(h, 0);
        }

        // Also: count ALL dropped-item-looking ZDOs globally to build a full roster
        // (has stack + crafterName + spawntime + no "health" property)
        Map<Integer, Integer> droppedItemHashes = new TreeMap<>();
        Map<Integer, Integer> droppedItemDumped = new TreeMap<>();

        try (ZPackage pkg = new ZPackage(new File(args.length > 0 ? args[0] : "ComfyEra14.db"))) {
            int worldVersion = pkg.readInt32();
            pkg.readDouble(); pkg.readLong(); pkg.readUInt();
            int totalZdos = pkg.readInt32();

            for (int i = 0; i < totalZdos; i++) {
                if (i % 1_000_000 == 0) System.err.print(".");
                try {
                    Zdo zdo = new Zdo(pkg, worldVersion, hints);
                    int hash = zdo.getPrefab();
                    String prefab = zdo.getPrefabName();

                    // Count our nearby unknowns globally
                    if (worldCounts.containsKey(hash)) {
                        worldCounts.merge(hash, 1, Integer::sum);

                        // Dump first N
                        int cnt = dumpCounts.getOrDefault(hash, 0);
                        if (cnt < DUMP_LIMIT) {
                            dumpCounts.put(hash, cnt + 1);
                            Map<String, Object> p = profiles.computeIfAbsent(hash, k -> new LinkedHashMap<>());
                            if (!p.containsKey("sample")) {
                                p.put("sample", buildSample(zdo));
                            }
                        }
                    }

                    // Identify dropped items by property signature
                    // (null prefab, has "stack" int, has "spawntime" long, has "crafterName" string)
                    if (prefab == null) {
                        boolean isDropped = false;
                        if (zdo.getIntsByName() != null && zdo.getIntsByName().containsKey("stack")) {
                            if (zdo.getLongsByName() != null && zdo.getLongsByName().containsKey("spawntime")) {
                                if (zdo.getStringsByName() != null && zdo.getStringsByName().containsKey("crafterName")) {
                                    isDropped = true;
                                }
                            }
                        }
                        if (isDropped) {
                            droppedItemHashes.merge(hash, 1, Integer::sum);
                            // Dump first occurrence of new hashes
                            if (!droppedItemDumped.containsKey(hash)) {
                                droppedItemDumped.put(hash, 1);
                                float x = zdo.getPosition() != null ? zdo.getPosition().getX() : 0;
                                float z = zdo.getPosition() != null ? zdo.getPosition().getZ() : 0;
                                int stack = zdo.getIntsByName().getOrDefault("stack", 0);
                                int quality = zdo.getIntsByName().getOrDefault("quality", 0);
                                System.out.printf("  NEW_DROP hash:%-12d  stack=%-3d quality=%-2d  x=%.0f z=%.0f%n",
                                        hash, stack, quality, x, z);
                            }
                        }
                    }

                } catch (Throwable e) { }
            }
        }
        System.err.println();

        System.out.println("\n=== NEARBY HASH WORLD COUNTS ===");
        for (int h : NEARBY_UNKNOWNS) {
            String name = resolved.getOrDefault(h, "hash:" + h);
            Map<String, Object> p = profiles.get(h);
            System.out.printf("  %6dx  %s%n", worldCounts.getOrDefault(h,0), name);
            if (p != null && p.containsKey("sample")) {
                System.out.println("          " + p.get("sample"));
            }
        }

        System.out.println("\n=== ALL DROPPED ITEM HASHES (world-wide, sorted by count) ===");
        System.out.println("  Total distinct dropped-item hashes: " + droppedItemHashes.size());
        droppedItemHashes.entrySet().stream()
                .sorted(Map.Entry.<Integer,Integer>comparingByValue().reversed())
                .forEach(e -> {
                    String name = resolved.getOrDefault(e.getKey(), "hash:" + e.getKey());
                    System.out.printf("  %6dx  %s%n", e.getValue(), name);
                });
    }

    static String buildSample(Zdo zdo) {
        StringBuilder sb = new StringBuilder();
        if (zdo.getStringsByName() != null && !zdo.getStringsByName().isEmpty())
            sb.append("strings=").append(zdo.getStringsByName()).append(" ");
        if (zdo.getIntsByName() != null && !zdo.getIntsByName().isEmpty())
            sb.append("ints=").append(zdo.getIntsByName()).append(" ");
        if (zdo.getFloatsByName() != null && !zdo.getFloatsByName().isEmpty())
            sb.append("floats=").append(zdo.getFloatsByName()).append(" ");
        if (zdo.getLongsByName() != null && !zdo.getLongsByName().isEmpty())
            sb.append("longs=").append(zdo.getLongsByName()).append(" ");
        float x = zdo.getPosition() != null ? zdo.getPosition().getX() : 0;
        float z = zdo.getPosition() != null ? zdo.getPosition().getZ() : 0;
        sb.append(String.format("pos=(%.0f,%.0f)", x, z));
        return sb.toString();
    }

    static String[] buildMassiveCandidateList() {
        List<String> list = new ArrayList<>();

        // Try every Valheim item name format systematically
        // Base materials
        String[] bases = {
            "Wood","FineWood","RoundLog","YggdrasilWood","ElderBark","Blackwood",
            "Stone","Coal","Flint","Obsidian","Tar","BlackMarble","Grausten","Ashstone",
            "BoneFragments","Feathers","LeatherScraps","Entrails","DeerHide",
            "LoxPelt","WolfHide","WolfClaw","WolfPelt","WolfFang",
            "Honey","FreezeGland","DragonTear","Wishbone","Thunderstone","Sap",
            "AncientSeed","CryptKey","SwampKey","Kingsroot",
            "Chain","Ruby","Amber","AmberPearl",
            "GreydwarfEye","Resin","Thistle","Mushroom","Blueberries","Raspberry","Cloudberry",
            "Dandelion","Barley","Flax","Carrot","Turnip","Onion",
            "JotunPuffs","Magecap","MushroomBlue","MushroomYellow",
            "Copper","CopperOre","CopperScrap","Tin","TinOre","Bronze","BronzeScrap",
            "Iron","IronOre","IronScrap","Silver","SilverOre","BlackMetal","BlackMetalScrap",
            "Flametal","FlametalOre","FlametalNew","FlametalOreNew",
            // Ashlands specific
            "AsksvinHide","AsksvinMeat","VoltureFeather","VoltureEgg","VoltureMeat",
            "FallenValkyriePlume","MorgenHeart","MarbledGlands","CharcoalResin",
            "EitrOre","Eitr","SoftTissue","GrauDvergr","AshlandsMetalBar",
            "Ashstone","AshlandsFertileSoil","CrabMeat","AshMeat","Grausten",
            "GrauVine","GrauBranch","BombBile","VoltureEgg",
            "CrabClaw","MorgenSinew","CharredBone","CharredMeat","CharredRemains",
            "BoneSerpentScale","BoneSerpentMeat","BoneSerpentSkin",
            "SurtlingCore","WitheredBone",
            // Mistlands specific
            "Carapace","CarapaceScrap","BugMeat","BlackCore","BlackSoup",
            "SeekerAspic","GemstoneRed","GemstoneGreen","GemstoneBlue",
            "JuteRed","JuteBlue","DvergrKey",
            // Foods
            "SerpentMeat","LoxMeat","WolfMeat","ChickenMeat","HareMeat","NeckTail",
            "MeadPoisonResist","MeadFrostResist","MeadStaminaLingering","MeadEitrMinor",
            "MisthareSupreme","SeekerAspic","MeatPlatter","Salad","HoneyGlazedChicken",
            "FishRaw","FishCooked","FishRaw_trollfish",
            "CookedWolfMeat","CookedLoxMeat","CookedChickenMeat","CookedHareMeat",
            "LoxMeatPie","BloodPudding","FishWraps","WolfMeatSkewer","BlackSoup",
            // Misc drops
            "AskHide","SerpentScale","Coins",
            "TrophySkeleton","TrophyDraugr","TrophyDraugrElite",
            "TrophyGreydwarf","TrophyGreydwarfShaman","TrophyGreydwarfBrute",
            "TrophyTroll","TrophyBlob","TrophyLeech","TrophyAbomination",
            "TrophyBoar","TrophyNeck","TrophyDeer","TrophyWolf","TrophyFenring",
            "TrophyDeathsquito","TrophyGoblin","TrophyGoblinShaman","TrophyGoblinBrute","TrophyGoblinKing",
            "TrophyLox","TrophySerpent","TrophyBat","TrophyStoneGolem","TrophyHare",
            "TrophySeeker","TrophySeekerBrute","TrophySeekerSoldier","TrophyGjall","TrophySeekerQueen",
            "TrophyDverger","TrophyFader","TrophySkeletonHildir","TrophySurtling",
            "TrophyCharredTwitcher","TrophyCharredMage","TrophyMorgen",
            "TrophyAsksvin","TrophyFallenValkyrie","TrophyVolture","TrophyCrawler",
            "TrophyCharred","TrophyCharredArcher","TrophyCharredMelee",
            "TrophyBoneSerpent","TrophyCrab","TrophyJotun",
        };
        list.addAll(Arrays.asList(bases));

        // Weapons/tools
        String[] weapons = {
            "SwordBronze","SwordIron","SwordBlackmetal","SwordNiedhogg",
            "AtgeirBronze","AtgeirIron","AtgeirBlackmetal","AtgeirHimminAfl",
            "SpearBronze","SpearElderbark","SpearWolfFang","SpearCarapace",
            "AxeBronze","AxeIron","AxeBlackMetal","AxeJotunBane",
            "KnifeChitin","KnifeBlackMetal","KnifeSkollAndHati",
            "BowFineWood","BowHuntsman","BowDraugrFang","BowAshlands",
            "CrossbowArbalest","ThrownClub",
            "ShieldBronzeBuckler","ShieldIronBuckler","ShieldBlackmetal",
            "ArmorBronzeLegs","ArmorBronzeChest","HelmetBronze",
            "ArmorIronLegs","ArmorIronChest","HelmetIron",
            "ArmorPaddedLegs","ArmorPaddedCuirass","HelmetPadded",
            "ArmorCarapaceLegs","ArmorCarapaceChest","HelmetCarapace",
            "ArmorFenrirLegs","ArmorFenrirChest","HelmetFenring",
            "ArmorMageLegs","ArmorMageChest","HelmetMage",
            "ArmorRobeLegs","ArmorRobeChest","HelmetRobeMage",
            "ArmorAshlandsLegs","ArmorAshlandsChest","HelmetAshlands",
            "CapeLinen","CapeFeather","CapeWolf","CapeTrollHide","CapeTwilight",
            "BeltStrength","BeltStrength2",
            "ArrowWood","ArrowFire","ArrowPoison","ArrowSilver",
            "ArrowCarapace","ArrowCharred",
            "BoltBone","BoltIron","BoltBlackmetal","BoltCarapace",
            "BombSiege","BombOoze",
            "StaffClusterbomb","StaffFireball","StaffShield","StaffSummon",
            "StaffRedTroll","StaffIceShard",
            "Tankard","Tankard_dvergr","TankardAnniversary",
            "Lantern","HelmetDverger","BombSiege",
        };
        list.addAll(Arrays.asList(weapons));

        // Building pieces (try many variants)
        String[] buildPieces = {
            "wood_pole2",  "wood_pole4", "wood_pole4_log", "wood_log", "wood_log_26", "wood_log_45",
            "wood_beam", "wood_beam_26", "wood_beam_45",
            "wood_wall_roof", "wood_wall_roof_45", "wood_wall_roof_top", "wood_wall_roof_top_45",
            "wood_gate", "wood_door", "wood_window",
            "stone_wall_2x1", "stone_wall_4x2",
            "roundlog_beam", "roundlog_joist", "roundlog_rafter",
            "blackmarble_2x2x1", "blackmarble_floor", "blackmarble_floor_large",
            "blackmarble_arch", "blackmarble_stair", "blackmarble_post",
            "blackmarble_column_1", "blackmarble_column_3", "blackmarble_column_4",
            "blackmarble_out_2", "blackmarble_out_1",
            "blackmarble_base", "blackmarble_tile_floor_1x1", "blackmarble_tile_floor_2x2",
            "blackmarble_tile_wall_1x1", "blackmarble_tile_wall_2x4",
            "dvergr_wood_wall_1", "dvergr_wood_wall_2", "dvergr_pole",
            "dvergr_beam", "dvergr_beam_26", "dvergr_stair", "dvergr_floor",
            "dvergr_wall", "dvergr_base",
            "piece_dvergr_wood_wall_1", "piece_dvergr_wood_wall_2",
            "piece_dvergr_pole", "piece_dvergr_beam",
            "piece_dvergr_stair", "piece_dvergr_floor",
            "ashwood_pole", "ashwood_beam", "ashwood_floor",
            "ashwood_wall", "ashwood_arch", "ashwood_stair",
            "piece_ashwood_pole", "piece_ashwood_beam", "piece_ashwood_floor",
            "piece_ashwood_wall_1", "piece_ashwood_arch", "piece_ashwood_stair",
            "grausten_pole", "grausten_beam", "grausten_floor",
            "grausten_wall", "grausten_arch", "grausten_stair",
            "piece_grausten_pole", "piece_grausten_beam", "piece_grausten_floor",
            "piece_grausten_wall_1", "piece_grausten_arch", "piece_grausten_stair",
            "piece_ashwood_roof", "piece_ashwood_roof_45",
            "piece_ashwood_roof_top", "piece_ashwood_roof_top_45",
            "piece_grausten_roof", "piece_grausten_roof_45",
            "piece_grausten_roof_top", "piece_grausten_roof_top_45",
        };
        list.addAll(Arrays.asList(buildPieces));

        // Nature objects
        String[] nature = {
            "Pickable_Barleywine","Pickable_BogIronOre","Pickable_Carrot",
            "Pickable_DolmenTreasure","Pickable_Flax","Pickable_FlintStone",
            "Pickable_ForestCryptRemains01","Pickable_ForestCryptRemains02","Pickable_ForestCryptRemains03",
            "Pickable_Mushroom","Pickable_Mushroom_blue","Pickable_Mushroom_yellow",
            "Pickable_Onion","Pickable_SurtlingCore","Pickable_Thistle","Pickable_Turnip",
            "Pickable_Stone","Pickable_Tar","Pickable_Obsidian",
            "Pickable_Flax_Wild","Pickable_Barley_Wild",
            "Pickable_BlackMarble","Pickable_Grausten","Pickable_Ashstone",
            "Pickable_EitrOre","Pickable_Eitr",
            "Pickable_SoftTissue","Pickable_GrauDvergr",
            "Pickable_VineAsh","Pickable_GrauVine","Pickable_GrauBranch",
            "Pickable_DvalinnMimir","Pickable_Vegvisir_DragonQueen",
            "Pickable_SmokePuff",
            "Rock_1","Rock_2","Rock_3","Rock_4","Rock_5","Rock_7",
            "RockFinger","RockFinger_frac","Rock_Ashlands","Ashlands_Rock",
            "MineRock_Iron","MineRock_Tin","MineRock_Copper","MineRock_Silver",
            "MineRock_Obsidian","MineRock_BlackMarble",
            "VineAsh","YggaShoot_small1","YggaShoot_small2","YggaShoot_small3",
            "YggaShoot_log","CloudberryBush","RaspberryBush","BlueberryBush",
            "Birch1","Birch2","Birch1_aut","Birch2_aut",
            "Oak1","SwampTree1","SwampTree2","Beech1","Beech_small1",
            "FirTree","PineTree","PineTree_log","SwampTree1_log",
            "Stub1","Stub2",
            "Bush01","Bush01_heath","Bush02","Bush02_en",
        };
        list.addAll(Arrays.asList(nature));

        // Ashlands nature/rocks specifically
        String[] ashlandsNature = {
            "Rock_Ashlands_1","Rock_Ashlands_2","Rock_Ashlands_3","Rock_Ashlands_4",
            "AshlandsRock1","AshlandsRock2","AshlandsRock3",
            "AshTree1","AshTree2","AshTree_log","AshTree_stub",
            "CharredTree","CharredStump","CharredLog",
            "AshGrass","AshlandsFertileSoil","AshlandsGround",
            "MineRock_Ashlands","MineRock_Flametal","MineRock_FlametalNew",
            "Ashlands_MineRock","Flametal_vein","FlametalVein",
            "Lava1","Lava2","AshlandsLava",
            "BonePillar","Bonepillar","BonePile","Ashlandsbone",
            "CharredForge","AshlandsForge",
        };
        list.addAll(Arrays.asList(ashlandsNature));

        return list.toArray(new String[0]);
    }
}
