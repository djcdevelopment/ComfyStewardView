import net.kakoen.valheim.save.archive.hints.ValheimSaveReaderHints;
import net.kakoen.valheim.save.archive.save.Zdo;
import net.kakoen.valheim.save.parser.ZPackage;

import java.io.*;
import java.util.*;

/**
 * Geographic analysis: where are player structures, creatures, and dropped items concentrated?
 * Also reads bed owner names and tombstone players.
 */
public class GeoAnalysis {

    // Known build-piece property signature: health + support + creator (long)
    // Nature: health or scaleScalar, no creator
    // Dropped items: crafterName string + spawntime long + stack int

    static final int CELL = 500; // 500-unit grid cells

    public static void main(String[] args) throws Exception {
        ValheimSaveReaderHints hints = ValheimSaveReaderHints.builder()
                .resolveNames(true).failOnUnsupportedVersion(false).build();

        // Grid: count player structures by (x/CELL, z/CELL)
        Map<String, int[]> buildGrid = new TreeMap<>(); // cell -> [count]
        Map<Integer, Integer> zBandBuilds = new TreeMap<>();
        Map<Integer, Integer> zBandDrops = new TreeMap<>();
        Map<Integer, Integer> zBandCreatures = new TreeMap<>();

        // Bed owners
        Map<String, Integer> bedOwners = new TreeMap<>();
        List<String> tombstonePlayers = new ArrayList<>();

        // Dropped items count globally
        int droppedTotal = 0;

        // Known creature prefabs
        Set<String> creatures = new HashSet<>(Arrays.asList(
            "Greydwarf","Greydwarf_Elite","Greydwarf_Shaman","Greyling",
            "Troll","Ghost","BlobElite","Blob","Leech",
            "Skeleton","Skeleton_Poison","Draugr","Draugr_Elite","Draugr_Ranged",
            "Surtling","Wraith","Wolf","Neck","Boar","Deer","Crow","Seagal",
            "Serpent","Leviathan","Bat","StoneGolem",
            "Lox","Deathsquito","GoblinKing","Fuling","Fuling_Berserker","Fuling_Shaman",
            "Goblin","Goblin_Berserker","Goblin_Shaman","GoblinBrute","GoblinArcher",
            "Gjall","Seeker","SeekerBrute","SeekerSoldier","SeekerQueen","Tick",
            "Dverger","DvergerMage","DvergerMageFireLarge","DvergerMageSupportLightning",
            "Fenring","Fenring_Cultist","Ulv","Hare","Hen","Chicken","Boar_piggy",
            "Fallen_Valkyrie","Fader","Morgen","CrawlerMelee",
            "Charred_Melee","Charred_Archer","Charred_Mage","Charred_Twitcher",
            "Asksvin","Volture","BlobTar","BoneSerpent","Jotun",
            "Wolf_cub","Lox_Calf","Abomination","BonePileSpawner"
        ));

        long t0 = System.currentTimeMillis();
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
                    float x = zdo.getPosition() != null ? zdo.getPosition().getX() : 0;
                    float z = zdo.getPosition() != null ? zdo.getPosition().getZ() : 0;

                    boolean hasCreator = zdo.getLongsByName() != null && zdo.getLongsByName().containsKey("creator");
                    boolean hasSupport = zdo.getFloatsByName() != null && zdo.getFloatsByName().containsKey("support");
                    boolean hasHealth = zdo.getFloatsByName() != null && zdo.getFloatsByName().containsKey("health");
                    boolean hasCrafterName = zdo.getStringsByName() != null && zdo.getStringsByName().containsKey("crafterName");
                    boolean hasSpawntime = zdo.getLongsByName() != null && zdo.getLongsByName().containsKey("spawntime");
                    boolean hasStack = zdo.getIntsByName() != null && zdo.getIntsByName().containsKey("stack");

                    // Player-built structures: have creator + (support or health)
                    if (hasCreator && (hasSupport || hasHealth)) {
                        int cx = (int) Math.floor(x / CELL);
                        int cz = (int) Math.floor(z / CELL);
                        String key = cx + "," + cz;
                        buildGrid.computeIfAbsent(key, k -> new int[]{0})[0]++;

                        int zBand = (int) Math.floor(z / 1000) * 1000;
                        zBandBuilds.merge(zBand, 1, Integer::sum);
                    }

                    // Dropped items
                    if (hasCrafterName && hasSpawntime && hasStack && prefab == null) {
                        droppedTotal++;
                        int zBand = (int) Math.floor(z / 1000) * 1000;
                        zBandDrops.merge(zBand, 1, Integer::sum);
                    }

                    // Creatures
                    if (prefab != null && creatures.contains(prefab)) {
                        int zBand = (int) Math.floor(z / 1000) * 1000;
                        zBandCreatures.merge(zBand, 1, Integer::sum);
                    }

                    // Beds — read owner name
                    if ("bed".equals(prefab) || "piece_bed01".equals(prefab)
                            || "piece_bed02".equals(prefab) || "piece_bed_valhalla".equals(prefab)
                            || "piece_bed02_Hildir".equals(prefab) || "piece_bed_barleywine".equals(prefab)) {
                        String ownerName = null;
                        if (zdo.getStringsByName() != null) {
                            ownerName = zdo.getStringsByName().get("owner");
                            if (ownerName == null) ownerName = zdo.getStringsByName().get("ownerName");
                        }
                        if (ownerName != null && !ownerName.isEmpty()) {
                            bedOwners.merge(ownerName, 1, Integer::sum);
                        } else {
                            // Try to get player ID from longs
                            if (zdo.getLongsByName() != null) {
                                Long ownerId = zdo.getLongsByName().get("owner");
                                if (ownerId != null && ownerId != 0) {
                                    bedOwners.merge("id:" + ownerId, 1, Integer::sum);
                                }
                            }
                        }
                    }

                    // Tombstones
                    if ("Player_tombstone".equals(prefab) || "player_tombstone".equals(prefab)) {
                        String player = null;
                        if (zdo.getStringsByName() != null) {
                            player = zdo.getStringsByName().get("ownerName");
                            if (player == null) player = zdo.getStringsByName().get("playerName");
                        }
                        tombstonePlayers.add(player != null ? player : "unknown");
                    }

                } catch (Throwable e) { }
            }
        }
        System.err.println();
        System.err.println("Done in " + (System.currentTimeMillis() - t0) + "ms");

        // Print results
        System.out.println("=== Z-BAND ANALYSIS (1000-unit bands) ===");
        System.out.println("  Biome reference: Meadows ≈ 0-2000, BF ≈ 2000-4000, Swamp/Mountain ≈ 4000-6000,");
        System.out.println("  Plains ≈ -2000 to -4000, Mistlands ≈ -4000 to -6000, Ashlands ≈ -6000+");
        System.out.printf("  %-12s  %-10s  %-10s  %-10s%n", "Z-band", "Builds", "Drops", "Creatures");
        System.out.println("  " + "-".repeat(50));

        // Collect all z-bands
        Set<Integer> allBands = new TreeSet<>(Comparator.reverseOrder());
        allBands.addAll(zBandBuilds.keySet());
        allBands.addAll(zBandDrops.keySet());
        allBands.addAll(zBandCreatures.keySet());

        for (int band : allBands) {
            int b = zBandBuilds.getOrDefault(band, 0);
            int d = zBandDrops.getOrDefault(band, 0);
            int c = zBandCreatures.getOrDefault(band, 0);
            if (b + d + c > 0) {
                System.out.printf("  z=%-8d  %-10d  %-10d  %-10d%n", band, b, d, c);
            }
        }

        System.out.println("\n=== TOP 30 BUILD GRID CELLS (highest structure concentration) ===");
        buildGrid.entrySet().stream()
                .sorted((a, b) -> b.getValue()[0] - a.getValue()[0])
                .limit(30)
                .forEach(e -> {
                    String[] parts = e.getKey().split(",");
                    int cx = Integer.parseInt(parts[0]);
                    int cz = Integer.parseInt(parts[1]);
                    System.out.printf("  %6d structures  area: x=[%d,%d] z=[%d,%d]%n",
                            e.getValue()[0],
                            cx * CELL, (cx+1) * CELL,
                            cz * CELL, (cz+1) * CELL);
                });

        System.out.println("\n=== BED OWNERS ===");
        System.out.println("  Total beds: " + bedOwners.values().stream().mapToInt(Integer::intValue).sum());
        System.out.println("  Unique owners: " + bedOwners.size());
        bedOwners.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .limit(30)
                .forEach(e -> System.out.printf("  %3dx  %s%n", e.getValue(), e.getKey()));

        System.out.println("\n=== TOMBSTONES ===");
        System.out.println("  Total tombstones: " + tombstonePlayers.size());
        Map<String, Integer> tombCounts = new TreeMap<>();
        for (String p : tombstonePlayers) tombCounts.merge(p, 1, Integer::sum);
        tombCounts.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .forEach(e -> System.out.printf("  %3dx  %s%n", e.getValue(), e.getKey()));

        System.out.println("\n=== TOTAL DROPPED ITEMS: " + droppedTotal + " ===");
    }
}
