import net.kakoen.valheim.save.archive.hints.ValheimSaveReaderHints;
import net.kakoen.valheim.save.archive.save.Zdo;
import net.kakoen.valheim.save.parser.ZPackage;
import net.kakoen.valheim.save.decode.StableHashCode;

import java.io.*;
import java.util.*;

/**
 * Dumps ALL properties of first N ZDOs for the unknown hashes,
 * and tries an extended list of Ashlands/creature-drop names.
 */
public class DumpUnknown {

    // The two unknown dropped-item hashes
    static final int[] TARGET_HASHES = {109649212, 1272849455, 538325542, -2119951934, -494364525};
    static final int DUMP_LIMIT = 3; // dump first 3 of each

    public static void main(String[] args) throws Exception {
        // --- Phase 1: Extended hash resolution ---
        System.out.println("=== EXTENDED HASH RESOLUTION ===");
        String[] candidates = buildExtendedCandidates();
        System.out.println("Trying " + candidates.length + " candidates...");

        Map<Integer, String> resolved = new HashMap<>();
        // also track ALL hashes we care about
        Set<Integer> targets = new HashSet<>();
        for (int h : TARGET_HASHES) targets.add(h);
        // add more unknown hashes from deep probe
        int[] moreHashes = {-2129458801, 650075310, -502993694, -62980316,
                1792656179, 1341839349, -2053541920, 1411875912,
                -1161852777, 686545676, -1161852776};
        for (int h : moreHashes) targets.add(h);

        for (String name : candidates) {
            int h = StableHashCode.getStableHashCode(name);
            if (targets.contains(h)) {
                resolved.put(h, name);
                System.out.println("  RESOLVED: hash:" + h + " = '" + name + "'");
            }
        }
        System.out.println("  Resolved " + resolved.size() + " / " + targets.size() + " target hashes");

        // --- Phase 2: Dump full properties of first N ZDOs for each target ---
        System.out.println("\n=== FULL PROPERTY DUMP (first " + DUMP_LIMIT + " of each target) ===");
        ValheimSaveReaderHints hints = ValheimSaveReaderHints.builder()
                .resolveNames(true).failOnUnsupportedVersion(false).build();

        Map<Integer, Integer> dumpCount = new HashMap<>();
        for (int h : TARGET_HASHES) dumpCount.put(h, 0);

        // Also collect ALL nearby ZDOs in the z≈-8000 area to see what's around
        Map<Integer, Integer> nearbyHashes = new TreeMap<>();

        try (ZPackage pkg = new ZPackage(new File(args.length > 0 ? args[0] : "ComfyEra14.db"))) {
            int worldVersion = pkg.readInt32();
            pkg.readDouble(); pkg.readLong(); pkg.readUInt();
            int totalZdos = pkg.readInt32();

            for (int i = 0; i < totalZdos; i++) {
                try {
                    Zdo zdo = new Zdo(pkg, worldVersion, hints);
                    int hash = zdo.getPrefab();
                    float x = zdo.getPosition() != null ? zdo.getPosition().getX() : 0;
                    float z = zdo.getPosition() != null ? zdo.getPosition().getZ() : 0;

                    // Track nearby hashes in z: -8200 to -7800, x: -1200 to 1200
                    if (z >= -8200 && z <= -7800 && x >= -1200 && x <= 1200) {
                        nearbyHashes.merge(hash, 1, Integer::sum);
                    }

                    // Dump target hashes
                    Integer cnt = dumpCount.get(hash);
                    if (cnt != null && cnt < DUMP_LIMIT) {
                        dumpCount.put(hash, cnt + 1);
                        System.out.println("\n--- hash:" + hash + " #" + (cnt+1) + " ---");
                        System.out.printf("  pos: x=%.1f y=%.1f z=%.1f%n",
                                x, zdo.getPosition() != null ? zdo.getPosition().getY() : 0, z);
                        System.out.println("  prefabName: " + zdo.getPrefabName());
                        if (zdo.getStringsByName() != null && !zdo.getStringsByName().isEmpty()) {
                            System.out.println("  strings: " + zdo.getStringsByName());
                        }
                        if (zdo.getIntsByName() != null && !zdo.getIntsByName().isEmpty()) {
                            System.out.println("  ints: " + zdo.getIntsByName());
                        }
                        if (zdo.getFloatsByName() != null && !zdo.getFloatsByName().isEmpty()) {
                            System.out.println("  floats: " + zdo.getFloatsByName());
                        }
                        if (zdo.getLongsByName() != null && !zdo.getLongsByName().isEmpty()) {
                            System.out.println("  longs: " + zdo.getLongsByName());
                        }
                        if (zdo.getByteArraysByName() != null && !zdo.getByteArraysByName().isEmpty()) {
                            System.out.println("  byteArrays (keys): " + zdo.getByteArraysByName().keySet());
                        }
                    }
                } catch (Throwable e) { }
            }
        }

        System.out.println("\n=== NEARBY ZDOs (z: -8200 to -7800, x: -1200 to 1200) ===");
        System.out.println("  Top 40 by count:");
        nearbyHashes.entrySet().stream()
                .sorted(Map.Entry.<Integer,Integer>comparingByValue().reversed())
                .limit(40)
                .forEach(e -> {
                    String name = resolved.getOrDefault(e.getKey(), "hash:" + e.getKey());
                    System.out.printf("  %6dx  %s%n", e.getValue(), name);
                });
    }

    static String[] buildExtendedCandidates() {
        List<String> list = new ArrayList<>();

        // Ashlands creature drops (exact Valheim internal names)
        list.addAll(Arrays.asList(
            // Asksvin (lizard horse)
            "AsksvinHide", "AsksvinMeat", "AsksvinEgg",
            // Morgen
            "MorgenHeart", "MorgenSinew",
            // Fallen Valkyrie
            "FallenValkyriePlume", "ValkyriePlume",
            // Volture (vulture)
            "VoltureFeather", "VoltureEgg", "VoltureMeat",
            // Charred
            "CharredBone", "CharredMeat", "CharredRemains",
            "CharcoalResin", "Resin_Charred",
            // Crab (Seeker from Ashlands?)
            "CrabMeat", "CrabClaw", "CrabShell",
            // Bone Serpent
            "BoneSerpentScale", "BoneSerpentMeat", "BoneSerpentSkin",
            // Generic Ashlands
            "AshMeat", "AshHide", "AshBone", "AshScale",
            "MarbledGlands", "MarbledScale",
            // Flametal
            "FlametalNew", "FlametalOreNew", "Flametal2",
            "FlametalBar", "FlametalIngot",
            // Ashstone/Grausten
            "Ashstone", "AshstoneBar", "GrauBarr",
            "Grausten", "GrauBar",
            // Vine Ash
            "VineAsh", "AshVine", "AshRoot",
            // Ashlands plants
            "GrauDvergr", "GrauVine", "GrauBranch", "GrauRoot",
            "AshLand", "AshSoil",
            // Misc Ashlands
            "EitrOre", "Eitr", "SoftTissue",
            "AshlandsFertileSoil", "AshlandsMetalBar",
            "BombBile", "CharcoalBomb",
            // Hut / Shelter
            "Hut", "AshHut",

            // Mistlands drops
            "Carapace", "CarapaceScrap", "BugMeat",
            "BlackCore", "BlackSoup",
            "SeekerAspic", "SeekerAspicOld",

            // More creature drops
            "TrophyJotun", "TrophyBoneSerpent", "TrophyCharred",
            "TrophyCharredArcher", "TrophyCharredMelee",
            "TrophyCharredTwitcherNew", "TrophyVolture",
            "TrophyCrab", "TrophyMorgenNew",
            "TrophyAsksvinNew", "TrophyFallenValkyrie",

            // Dropped item prefabs (the ZDO prefab for a dropped item)
            "itempickup", "item_drop", "ItemPickup",
            "drop_item", "DropItem",

            // Building materials
            "piece_ashwood_floor", "piece_ashwood_wall_1",
            "piece_ashwood_beam", "piece_ashwood_pole",
            "piece_ashwood_stair", "piece_ashwood_arch",
            "piece_ashwood_roof",
            "piece_grausten_floor", "piece_grausten_wall_1",
            "piece_grausten_beam", "piece_grausten_pole",
            "piece_grausten_stair", "piece_grausten_arch",
            "piece_grausten_roof",

            // Dvergr building pieces
            "piece_dvergr_pole", "piece_dvergr_beam",
            "piece_dvergr_beam_26", "piece_dvergr_beam_45",
            "piece_dvergr_wood_wall_1", "piece_dvergr_wood_wall_2",
            "piece_dvergr_wood_floor", "piece_dvergr_wood_stair",
            "piece_dvergr_floor", "piece_dvergr_wall",

            // Mistlands building pieces
            "piece_mistl_beam", "piece_mistl_floor",
            "piece_mistl_wall", "piece_mistl_pole",
            "piece_blackmarble_base", "piece_blackmarble_column",
            "piece_blackmarble_column_3", "piece_blackmarble_column_4",

            // Stone wall variants
            "stone_wall_1", "stone_wall_2", "stone_wall_4x2",
            "stone_arch", "stone_pillar",
            "iron_wall_1", "iron_wall_2",

            // Specific named drops
            "Coins", "Ruby", "Amber", "AmberPearl",
            "Pearl", "NecklaceRed",
            "TreasureChest_heath", "TreasureChest_meadows",

            // Ballista
            "piece_turret", "Turret", "ballista",
            "Ballista", "piece_ballista",

            // Specific furniture
            "piece_banner01", "piece_banner02",
            "ArmorStand", "ArmorStand_Female",

            // Animals / passive
            "Crab", "Tick", "Spider",
            "RockGolem",

            // Nature/environment objects
            "BirchTree", "OakTree", "PineTree",
            "FirTree", "Beech1", "Oak1", "Birch1",
            "Bush01", "Bush02",
            "Pickable_Stone", "Pickable_Mushroom",

            // More systematic: itemdrop_ prefix used in some cases
            "itemdrop_wood", "itemdrop_stone", "itemdrop_flint"
        ));

        // Try all combinations of common Ashlands names with different casing
        String[] ashNames = {"Asksvin", "Morgen", "Volture", "Charred", "BoneSerpent",
                "Crab", "Jotun", "FallenValkyrie"};
        String[] ashSuffixes = {"Hide", "Meat", "Scale", "Bone", "Heart", "Egg",
                "Feather", "Plume", "Sinew", "Claw", "Shell", "Tail", "Pelt"};
        for (String n : ashNames) {
            for (String s : ashSuffixes) {
                list.add(n + s);
                list.add("Trophy" + n);
            }
        }

        // Try "drop_" prefix variants
        String[] baseItems = {"Wood", "Stone", "Coal", "Flint", "Iron", "Copper", "Tin",
                "Bronze", "Silver", "BlackMetal", "Flametal"};
        for (String b : baseItems) {
            list.add("drop_" + b);
            list.add("Drop_" + b);
        }

        return list.toArray(new String[0]);
    }
}
