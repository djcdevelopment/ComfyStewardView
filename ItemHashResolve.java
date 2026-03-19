import net.kakoen.valheim.save.decode.StableHashCode;
import net.kakoen.valheim.save.archive.hints.ValheimSaveReaderHints;
import net.kakoen.valheim.save.archive.save.Zdo;
import net.kakoen.valheim.save.parser.ZPackage;

import java.io.*;
import java.util.*;

/**
 * - Tries MANY item names to resolve hashes 109649212 and 1272849455
 * - Samples actual property values from these dropped-item ZDOs (stack sizes, prefab positions)
 * - Gets sign text samples (deduplicated, sorted by frequency)
 * - Profiles the hash:-1161852777 (fuel+item) objects in detail
 */
public class ItemHashResolve {

    static final int HASH_A = 109649212;
    static final int HASH_B = 1272849455;

    static final Map<String, Integer> signTexts = new LinkedHashMap<>();
    static int[] stackSamplesA = new int[10];
    static int[] stackSamplesB = new int[10];
    static int sampleIdxA = 0, sampleIdxB = 0;

    // For hash:-1161852777 (fuel type) — sample items and coordinates
    static final Map<String, Integer> fuelItemCounts = new TreeMap<>();
    static final Map<String, Integer> fuelItemB_counts = new TreeMap<>(); // hash:650075310

    public static void main(String[] args) throws Exception {
        // --- Phase 1: Try to resolve the two unknown dropped-item hashes ---
        System.out.println("=== HASH RESOLUTION ATTEMPT ===");
        String[] candidates = buildCandidateList();
        boolean foundA = false, foundB = false;
        for (String name : candidates) {
            int h = StableHashCode.getStableHashCode(name);
            if (h == HASH_A) { System.out.println("  HASH_A (" + HASH_A + ") = '" + name + "'"); foundA = true; }
            if (h == HASH_B) { System.out.println("  HASH_B (" + HASH_B + ") = '" + name + "'"); foundB = true; }
        }
        if (!foundA) System.out.println("  HASH_A (" + HASH_A + ") = UNRESOLVED");
        if (!foundB) System.out.println("  HASH_B (" + HASH_B + ") = UNRESOLVED");

        // Also try some building piece hashes
        int[] buildHashes = {538325542, -2119951934, -502993694, 1792656179, 1341839349};
        String[] buildNames = new String[buildHashes.length];
        Arrays.fill(buildNames, "UNRESOLVED");
        for (String name : candidates) {
            int h = StableHashCode.getStableHashCode(name);
            for (int i = 0; i < buildHashes.length; i++) {
                if (h == buildHashes[i]) buildNames[i] = name;
            }
        }
        System.out.println("\n  Build piece hashes:");
        for (int i = 0; i < buildHashes.length; i++) {
            System.out.printf("  hash:%-12d = %s%n", buildHashes[i], buildNames[i]);
        }

        // --- Phase 2: Stream ZDOs to sample properties ---
        System.out.println("\n=== ZDO PROPERTY SAMPLES ===");
        ValheimSaveReaderHints hints = ValheimSaveReaderHints.builder()
                .resolveNames(true).failOnUnsupportedVersion(false).build();

        // Collect: stack distribution for HASH_A and HASH_B
        Map<Integer, Integer> stackDistA = new TreeMap<>();
        Map<Integer, Integer> stackDistB = new TreeMap<>();
        // Collect: positions for dropped items (to see if they're in a specific area)
        List<float[]> posA = new ArrayList<>();
        List<float[]> posB = new ArrayList<>();

        // Sign text samples
        Map<String, Integer> uniqueSignTexts = new TreeMap<>();

        long t0 = System.currentTimeMillis();
        try (ZPackage pkg = new ZPackage(new File(args.length > 0 ? args[0] : "ComfyEra14.db"))) {
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

                    // dropped items A and B
                    if (hash == HASH_A || hash == HASH_B) {
                        Integer stack = null;
                        if (zdo.getIntsByName() != null) stack = zdo.getIntsByName().get("stack");
                        float x = zdo.getPosition() != null ? zdo.getPosition().getX() : 0;
                        float z = zdo.getPosition() != null ? zdo.getPosition().getZ() : 0;
                        Map<Integer, Integer> dist = hash == HASH_A ? stackDistA : stackDistB;
                        List<float[]> pos = hash == HASH_A ? posA : posB;
                        if (stack != null) dist.merge(stack, 1, Integer::sum);
                        if (pos.size() < 20) pos.add(new float[]{x, z});
                    }

                    // fuel+item stands (hash:-1161852777 and hash:650075310)
                    if (hash == -1161852777 || hash == -1161852776) {
                        if (zdo.getStringsByName() != null) {
                            String item = zdo.getStringsByName().get("item");
                            if (item != null && !item.isEmpty()) {
                                fuelItemCounts.merge(item, 1, Integer::sum);
                            }
                        }
                    }
                    if (hash == 650075310 || hash == 1411875912) {
                        if (zdo.getStringsByName() != null) {
                            String item = zdo.getStringsByName().get("item");
                            if (item != null && !item.isEmpty()) {
                                fuelItemB_counts.merge("h" + hash + ":" + item, 1, Integer::sum);
                            }
                        }
                    }

                    // signs (all variants)
                    if ("sign".equals(prefab) || hash == 747145 || hash == 686545676) {
                        if (zdo.getStringsByName() != null) {
                            String text = zdo.getStringsByName().get("text");
                            if (text != null && !text.isBlank()
                                    && !text.equals("----->") && !text.startsWith("<size=7")
                                    && !text.startsWith("<size=720") && !text.startsWith("<size=480")
                                    && !text.startsWith("<voffset") && !text.startsWith("<size=240")
                                    && !text.startsWith("<color=black>")) {
                                // keep text ≤ 80 chars for readability
                                String key = text.trim().substring(0, Math.min(80, text.trim().length()));
                                uniqueSignTexts.merge(key, 1, Integer::sum);
                            }
                        }
                    }

                } catch (Throwable e) { }
            }
        }
        System.err.println();
        System.err.println("Done in " + (System.currentTimeMillis() - t0) + "ms");

        System.out.println("\nStack distribution for HASH_A (" + HASH_A + "):");
        stackDistA.entrySet().stream()
                .sorted(Map.Entry.<Integer,Integer>comparingByValue().reversed())
                .limit(15)
                .forEach(e -> System.out.printf("  stack=%-5d  count=%d%n", e.getKey(), e.getValue()));

        System.out.println("Stack distribution for HASH_B (" + HASH_B + "):");
        stackDistB.entrySet().stream()
                .sorted(Map.Entry.<Integer,Integer>comparingByValue().reversed())
                .limit(15)
                .forEach(e -> System.out.printf("  stack=%-5d  count=%d%n", e.getKey(), e.getValue()));

        System.out.println("\nPosition samples HASH_A:");
        for (float[] p : posA.subList(0, Math.min(10, posA.size())))
            System.out.printf("  x=%.0f z=%.0f%n", p[0], p[1]);

        System.out.println("Position samples HASH_B:");
        for (float[] p : posB.subList(0, Math.min(10, posB.size())))
            System.out.printf("  x=%.0f z=%.0f%n", p[0], p[1]);

        System.out.println("\n=== FUEL-TYPE ITEM STAND CONTENTS (hash:-1161852777) ===");
        System.out.println("  Top 30 items displayed:");
        fuelItemCounts.entrySet().stream()
                .sorted(Map.Entry.<String,Integer>comparingByValue().reversed())
                .limit(30)
                .forEach(e -> System.out.printf("  %5dx  %s%n", e.getValue(), e.getKey()));

        System.out.println("\n=== ITEM STAND B CONTENTS (hash:650075310 + hash:1411875912) ===");
        fuelItemB_counts.entrySet().stream()
                .sorted(Map.Entry.<String,Integer>comparingByValue().reversed())
                .limit(30)
                .forEach(e -> System.out.printf("  %5dx  %s%n", e.getValue(), e.getKey()));

        System.out.println("\n=== UNIQUE SIGN TEXTS (top 60 by frequency) ===");
        uniqueSignTexts.entrySet().stream()
                .sorted(Map.Entry.<String,Integer>comparingByValue().reversed())
                .limit(60)
                .forEach(e -> System.out.printf("  %4dx  %s%n", e.getValue(),
                        e.getKey().replace("\n","\\n").replace("\r","")));
        System.out.println("  Total unique texts: " + uniqueSignTexts.size());
    }

    static String[] buildCandidateList() {
        List<String> list = new ArrayList<>(Arrays.asList(
            // Ashlands items
            "AsksvinHide","VoltureFeather","FallenValkyriePlume","MorgenHeart","CharcoalResin",
            "MarbledGlands","EitrOre","Eitr","SoftTissue","GrauDvergr","AshlandsMetalBar",
            "FlametalNew","FlametalOreNew","Ashstone","AshlandsFertileSoil",
            "CrabMeat","AshMeat","Grausten","GrauVine","GrauBranch",
            "BombBile","VoltureEgg","AsksvinMeat","CrabClaw","Hut",
            // Mistlands items
            "GoblinTotem","BlackSoup","SeekerAspic","MisthareSupreme","Magecap",
            "JotunPuffs","MushroomMagecap","MushroomJotunPuffs","YggdrasilWood",
            "JuteRed","JuteBlue","GemstoneBlue","GemstoneGreen","GemstoneRed",
            "SoftTissue","Carapace","CarapaceScrap","BugMeat","ScaleSkin",
            "TrophyGjall","TrophySeeker","TrophySeekerBrute","TrophySeekerSoldier",
            "TrophySeekerQueen","TrophyDvergerMage","TrophyDverger",
            "DvergrKey","BombSiege","StaffClusterbomb","StaffFireball","StaffShield",
            "StaffSummon","StaffRedTroll","SpearCarapace","KnifeSkollAndHati",
            "SwordNiedhogg","AtgeirHimminAfl","AxeJotunBane","BowAshlands",
            "ThrownClub","CrossbowArbalest","BoltBone","BoltIron","BoltBlackmetal","BoltCarapace",
            // Food items from new biomes
            "HoneyGlazedChicken","MeatPlatter","Salad","SeekerAspicOld",
            "MushroomSalad","FishCooked","FishRaw","FishRaw_trollfish",
            "LoxMeatPie","BloodPudding","FishWraps","WolfMeatSkewer",
            "CookedWolfMeat","CookedLoxMeat","CookedChickenMeat","CookedHareMeat",
            // More building pieces
            "piece_blackmarble_floor","piece_blackmarble_floor_large","piece_blackmarble_2x2x1",
            "piece_blackmarble_arch","piece_blackmarble_stair",
            "stone_floor_1x1","stone_floor_2x2","stone_floor_large",
            "iron_floor_1x1","iron_floor_2x2",
            "darkwood_wall_1","darkwood_wall_2","darkwood_wall_roof",
            "piece_dvergr_pole","piece_dvergr_beam","piece_dvergr_beam_26",
            "piece_dvergr_wood_wall_1","piece_dvergr_wood_wall_2",
            "piece_ashwood_floor","piece_ashwood_wall_1","piece_ashwood_beam",
            "piece_grausten_floor","piece_grausten_wall_1","piece_grausten_beam",
            "woodwall_1x1","woodwall_2x1","woodwall_2x1_ribs",
            // Signs
            "sign_notext","piece_sign02","RuneStone_Eikthyr",
            "Vegvisir_Eikthyr","Vegvisir_Elder","Vegvisir_Bonemass",
            "piece_banner01","piece_banner02","piece_banner03",
            "piece_banner04","piece_banner05","piece_banner06",
            // Torches
            "piece_walltorch","piece_walltorch_iron","piece_groundtorch_green",
            "piece_groundtorch_blue","piece_groundtorch_mist","piece_ironpole",
            "piece_dvergr_lantern","piece_dvergr_lantern_pole",
            "piece_brazierceiling01","piece_brazier",
            // Beds
            "piece_bed01","piece_bed_valhalla","piece_bed02_Hildir",
            "piece_bed_barleywine",
            // Other
            "piece_sapcollector","SapCollector",
            "piece_fermenter","piece_beehive",
            "piece_windmill","piece_blast_furnace",
            "piece_spinning_wheel","piece_galdr_table","piece_blackforge",
            "piece_maypole","piece_throne01","piece_chair","piece_chair02",
            "piece_table_oak","piece_bench01",
            "PickableBogIronOre","Pickable_Grausten","Pickable_Flax_Wild",
            "Pickable_Barley_Wild","Pickable_BlackMarble","Pickable_DolmenTreasure",
            "Pickable_SmokePuff","Pickable_ForestCryptRemains03",
            "Pickable_DvalinnMimir","Pickable_Vegvisir_DragonQueen",
            "Turnip","Carrot","Onion","Barley","Flax",
            // Armor sets
            "ArmorCarapaceLegs","ArmorCarapaceChest","HelmetCarapace",
            "ArmorFenrirLegs","ArmorFenrirChest","HelmetFenring",
            "ArmorMageLegs","ArmorMageChest","HelmetMage",
            "ArmorRobeLegs","ArmorRobeChest","HelmetRobeMage",
            "ArmorAshlandsLegs","ArmorAshlandsChest","HelmetAshlands",
            "BeltStrength","BeltStrength2",
            // Common world items
            "Coins","Wood","FineWood","Stone","Coal","Flint",
            "Iron","Bronze","Copper","Tin","Silver","BlackMetal","Flametal"
        ));

        // Generate variants
        String[] prefabs = {"darkwood","dvergr","ashwood","grausten","blackmarble","mistl"};
        String[] suffixes = {"_pole","_beam","_floor","_wall_1","_stair","_arch","_rafter"};
        for (String p : prefabs) for (String s : suffixes) {
            list.add("piece_" + p + s);
            list.add(p + s);
        }

        return list.toArray(new String[0]);
    }
}
