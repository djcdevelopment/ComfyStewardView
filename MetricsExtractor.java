import net.kakoen.valheim.save.archive.hints.ValheimSaveReaderHints;
import net.kakoen.valheim.save.archive.save.Zdo;
import net.kakoen.valheim.save.archive.hints.ValheimArchiveReaderHints;
import net.kakoen.valheim.save.parser.ZPackage;
import net.kakoen.valheim.save.exception.ValheimArchiveUnsupportedVersionException;

import java.io.*;
import java.util.*;
import java.util.stream.*;

/**
 * Dirty streaming metrics extractor for Valheim .db saves.
 * Reads ZDOs one at a time, aggregates counts/contents, outputs JSON.
 * Does NOT accumulate ZDOs in memory.
 */
public class MetricsExtractor {

    // ---- metrics ----
    static final Map<String, Integer> prefabCounts = new TreeMap<>();
    static int totalZdos = 0;
    static int parsedZdos = 0;
    static int failedZdos = 0;

    // coins
    static long totalCoins = 0;

    // containers: map prefabName -> list of {location, item summaries}
    static final List<Map<String, Object>> containers = new ArrayList<>();
    static int containerCount = 0;

    // portals
    static final List<Map<String, Object>> portals = new ArrayList<>();

    // beds
    static final List<Map<String, Object>> beds = new ArrayList<>();

    // player spawn (tombstones)
    static final List<Map<String, Object>> tombstones = new ArrayList<>();

    // all item counts across all containers
    static final Map<String, Integer> allContainerItemCounts = new TreeMap<>();

    // zones / global keys (read after ZDOs)
    static Set<String> globalKeys = new LinkedHashSet<>();
    static int generatedZonesCount = 0;
    static int prefabLocationsCount = 0;

    static final int MAX_CONTAINERS_DETAIL = 200; // cap detail output

    public static void main(String[] args) throws Exception {
        String dbPath = args.length > 0 ? args[0] : "ComfyEra14.db";
        File f = new File(dbPath);
        if (!f.exists()) {
            System.err.println("File not found: " + dbPath);
            System.exit(1);
        }
        System.err.println("Opening " + f.getAbsolutePath() + " (" + f.length() + " bytes)");

        ValheimSaveReaderHints hints = ValheimSaveReaderHints.builder()
                .resolveNames(true)
                .failOnUnsupportedVersion(false)
                .build();

        long t0 = System.currentTimeMillis();
        try (ZPackage pkg = new ZPackage(f)) {
            int worldVersion = pkg.readInt32();
            double netTime = pkg.readDouble();
            System.err.println("worldVersion=" + worldVersion + " netTime=" + netTime);

            long myId = pkg.readLong();
            long nextUid = pkg.readUInt();
            totalZdos = pkg.readInt32();
            System.err.println("ZDO count: " + totalZdos);

            for (int i = 0; i < totalZdos; i++) {
                if (i % 100_000 == 0) {
                    long elapsed = System.currentTimeMillis() - t0;
                    System.err.printf("  ... %d / %d (%.1fs, %.0f/s)%n",
                            i, totalZdos, elapsed / 1000.0, i / Math.max(elapsed / 1000.0, 0.001));
                }
                try {
                    Zdo zdo = new Zdo(pkg, worldVersion, hints);
                    processZdo(zdo);
                    parsedZdos++;
                } catch (Throwable e) {
                    failedZdos++;
                    System.err.println("Failed at ZDO #" + i + ": " + e.getMessage());
                    // can't recover stream position safely — bail
                    break;
                }
            }

            // Try to read zones section
            try {
                generatedZonesCount = pkg.readInt32();
                System.err.println("generatedZonesCount=" + generatedZonesCount);
                for (int i = 0; i < generatedZonesCount; i++) {
                    pkg.readInt32(); // x
                    pkg.readInt32(); // y
                }
                int pgwVersion = pkg.readInt32();
                int locationVersion = pkg.readInt32();
                System.err.println("pgwVersion=" + pgwVersion + " locationVersion=" + locationVersion);
                int globalKeyCount = pkg.readInt32();
                for (int i = 0; i < globalKeyCount; i++) {
                    globalKeys.add(pkg.readString());
                }
                boolean locationsGenerated = pkg.readBool();
                prefabLocationsCount = pkg.readInt32();
                System.err.println("prefabLocationsCount=" + prefabLocationsCount + " globalKeys=" + globalKeys.size());
            } catch (Throwable e) {
                System.err.println("Zones section read error (non-fatal): " + e.getMessage());
            }
        }

        long elapsed = System.currentTimeMillis() - t0;
        System.err.printf("Done in %.1fs. Parsed=%d Failed=%d%n", elapsed / 1000.0, parsedZdos, failedZdos);

        outputJson();
    }

    static void processZdo(Zdo zdo) {
        String prefab = zdo.getPrefabName();
        if (prefab == null) prefab = "hash:" + zdo.getPrefab();

        prefabCounts.merge(prefab, 1, Integer::sum);

        // --- coins ---
        if ("Coins".equals(prefab)) {
            Integer stack = getInt(zdo, "stack");
            if (stack != null) totalCoins += stack;
            else totalCoins += 1; // assume 1 if no stack property
        }

        // --- containers (chests) ---
        if (isContainer(prefab)) {
            containerCount++;
            // items are stored as a Base64-encoded string (not byte array)
            String itemsB64 = getString(zdo, "items");
            byte[] itemsBytes = null;
            if (itemsB64 != null && !itemsB64.isEmpty()) {
                try { itemsBytes = java.util.Base64.getDecoder().decode(itemsB64); }
                catch (Exception ex) { /* ignore */ }
            }
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("prefab", prefab);
            entry.put("x", zdo.getPosition() != null ? zdo.getPosition().getX() : null);
            entry.put("y", zdo.getPosition() != null ? zdo.getPosition().getY() : null);
            entry.put("z", zdo.getPosition() != null ? zdo.getPosition().getZ() : null);

            if (itemsBytes != null && itemsBytes.length > 0) {
                try {
                    List<Map<String, Object>> items = parseInventoryManual(itemsBytes);
                    for (Map<String, Object> item : items) {
                        String iname = (String) item.get("name");
                        int istack = (Integer) item.get("stack");
                        if (iname != null && !iname.isEmpty()) {
                            allContainerItemCounts.merge(iname, istack, Integer::sum);
                        }
                    }
                    entry.put("itemCount", items.size());
                    if (containers.size() < MAX_CONTAINERS_DETAIL) {
                        entry.put("items", items);
                    }
                } catch (Throwable e) {
                    entry.put("itemsParseError", e.getMessage());
                }
            } else {
                entry.put("itemCount", 0);
            }
            if (containers.size() < MAX_CONTAINERS_DETAIL) {
                containers.add(entry);
            }
        }

        // --- portals ---
        if ("portal_wood".equals(prefab) || "portal".equals(prefab) || prefab.contains("portal")) {
            String tag = getString(zdo, "tag");
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("prefab", prefab);
            p.put("tag", tag != null ? tag : "(no tag)");
            p.put("x", zdo.getPosition() != null ? zdo.getPosition().getX() : null);
            p.put("z", zdo.getPosition() != null ? zdo.getPosition().getZ() : null);
            portals.add(p);
        }

        // --- beds ---
        if ("bed".equals(prefab) || "piece_bed02".equals(prefab) || "piece_bed_cauldron".equals(prefab)
                || prefab.startsWith("piece_bed")) {
            Long owner = getLong(zdo, "owner");
            String ownerName = getString(zdo, "ownerName");
            Map<String, Object> b = new LinkedHashMap<>();
            b.put("prefab", prefab);
            b.put("owner", owner);
            b.put("ownerName", ownerName != null ? ownerName : "");
            b.put("x", zdo.getPosition() != null ? zdo.getPosition().getX() : null);
            b.put("z", zdo.getPosition() != null ? zdo.getPosition().getZ() : null);
            beds.add(b);
        }

        // --- tombstones ---
        if (prefab.contains("gravestone") || prefab.contains("tombstone")) {
            Map<String, Object> t = new LinkedHashMap<>();
            t.put("prefab", prefab);
            t.put("ownerName", getString(zdo, "ownerName") != null ? getString(zdo, "ownerName") : "");
            t.put("x", zdo.getPosition() != null ? zdo.getPosition().getX() : null);
            t.put("z", zdo.getPosition() != null ? zdo.getPosition().getZ() : null);
            tombstones.add(t);
        }
    }

    static boolean isContainer(String prefab) {
        if (prefab == null) return false;
        return prefab.startsWith("piece_chest")
                || "container_wood".equals(prefab)
                || "container_wood_reinforced".equals(prefab)
                || "container_private".equals(prefab)
                || prefab.contains("chest")
                || prefab.contains("container");
    }

    static Integer getInt(Zdo zdo, String key) {
        if (zdo.getIntsByName() != null && zdo.getIntsByName().containsKey(key)) {
            return zdo.getIntsByName().get(key);
        }
        return null;
    }

    static Long getLong(Zdo zdo, String key) {
        if (zdo.getLongsByName() != null && zdo.getLongsByName().containsKey(key)) {
            return zdo.getLongsByName().get(key);
        }
        return null;
    }

    static String getString(Zdo zdo, String key) {
        if (zdo.getStringsByName() != null && zdo.getStringsByName().containsKey(key)) {
            return zdo.getStringsByName().get(key);
        }
        return null;
    }

    static byte[] getByteArray(Zdo zdo, String key) {
        if (zdo.getByteArraysByName() != null && zdo.getByteArraysByName().containsKey(key)) {
            return zdo.getByteArraysByName().get(key);
        }
        return null;
    }

    static List<Map<String, Object>> parseInventoryManual(byte[] raw) throws Exception {
        ZPackage inv = new ZPackage(raw);
        int version = inv.readInt32();
        int count = inv.readInt32();
        List<Map<String, Object>> items = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            String name = inv.readString();
            int stack = inv.readInt32();
            float dur = inv.readSingle();
            int px = inv.readInt32();
            int py = inv.readInt32();
            boolean equipped = inv.readBool();
            int quality = version >= 101 ? inv.readInt32() : 1;
            int variant = version >= 102 ? inv.readInt32() : 0;
            if (version >= 103) { inv.readLong(); inv.readString(); } // crafterId, crafterName
            if (version >= 104) {
                // readMap: int32 count + key/value string pairs
                int mapCount = inv.readInt32();
                for (int k = 0; k < mapCount; k++) { inv.readString(); inv.readString(); }
            }
            if (version >= 105) { inv.readByte(); } // pickedUp bool added in v105

            // basic sanity: valid ASCII name, reasonable stack
            if (name != null && !name.isEmpty() && stack > 0 && stack < 100000
                    && name.chars().allMatch(c -> c >= 32 && c < 127)) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("name", name);
                m.put("stack", stack);
                m.put("quality", quality);
                m.put("slot", px + "," + py);
                items.add(m);
            }
        }
        return items;
    }

    static void outputJson() throws Exception {
        // top prefabs by count (top 100)
        List<Map.Entry<String, Integer>> topPrefabs = prefabCounts.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .limit(100)
                .collect(Collectors.toList());

        // top container items
        List<Map.Entry<String, Integer>> topItems = allContainerItemCounts.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .limit(100)
                .collect(Collectors.toList());

        StringBuilder sb = new StringBuilder();
        sb.append("{\n");
        sb.append("  \"summary\": {\n");
        sb.append("    \"totalZdos\": ").append(totalZdos).append(",\n");
        sb.append("    \"parsedZdos\": ").append(parsedZdos).append(",\n");
        sb.append("    \"failedZdos\": ").append(failedZdos).append(",\n");
        sb.append("    \"uniquePrefabs\": ").append(prefabCounts.size()).append(",\n");
        sb.append("    \"totalCoins\": ").append(totalCoins).append(",\n");
        sb.append("    \"containerCount\": ").append(containerCount).append(",\n");
        sb.append("    \"portalCount\": ").append(portals.size()).append(",\n");
        sb.append("    \"bedCount\": ").append(beds.size()).append(",\n");
        sb.append("    \"tombstoneCount\": ").append(tombstones.size()).append(",\n");
        sb.append("    \"generatedZonesCount\": ").append(generatedZonesCount).append(",\n");
        sb.append("    \"prefabLocationsCount\": ").append(prefabLocationsCount).append(",\n");
        sb.append("    \"globalKeys\": ").append(toJsonArray(new ArrayList<>(globalKeys))).append("\n");
        sb.append("  },\n");

        sb.append("  \"topPrefabsByCount\": [\n");
        for (int i = 0; i < topPrefabs.size(); i++) {
            Map.Entry<String, Integer> e = topPrefabs.get(i);
            sb.append("    {\"prefab\": ").append(jsonStr(e.getKey()))
              .append(", \"count\": ").append(e.getValue()).append("}");
            if (i < topPrefabs.size() - 1) sb.append(",");
            sb.append("\n");
        }
        sb.append("  ],\n");

        sb.append("  \"topContainerItemsByCount\": [\n");
        for (int i = 0; i < topItems.size(); i++) {
            Map.Entry<String, Integer> e = topItems.get(i);
            sb.append("    {\"item\": ").append(jsonStr(e.getKey()))
              .append(", \"totalStack\": ").append(e.getValue()).append("}");
            if (i < topItems.size() - 1) sb.append(",");
            sb.append("\n");
        }
        sb.append("  ],\n");

        sb.append("  \"portals\": [\n");
        for (int i = 0; i < portals.size(); i++) {
            Map<String, Object> p = portals.get(i);
            sb.append("    {\"tag\": ").append(jsonStr(String.valueOf(p.get("tag"))))
              .append(", \"x\": ").append(p.get("x"))
              .append(", \"z\": ").append(p.get("z")).append("}");
            if (i < portals.size() - 1) sb.append(",");
            sb.append("\n");
        }
        sb.append("  ],\n");

        sb.append("  \"beds\": [\n");
        for (int i = 0; i < beds.size() && i < 200; i++) {
            Map<String, Object> b = beds.get(i);
            sb.append("    {\"prefab\": ").append(jsonStr(String.valueOf(b.get("prefab"))))
              .append(", \"ownerName\": ").append(jsonStr(String.valueOf(b.get("ownerName"))))
              .append(", \"x\": ").append(b.get("x"))
              .append(", \"z\": ").append(b.get("z")).append("}");
            if (i < Math.min(beds.size(), 200) - 1) sb.append(",");
            sb.append("\n");
        }
        sb.append("  ],\n");

        sb.append("  \"containersSample\": [\n");
        for (int i = 0; i < containers.size(); i++) {
            Map<String, Object> c = containers.get(i);
            sb.append("    {\"prefab\": ").append(jsonStr(String.valueOf(c.get("prefab"))))
              .append(", \"itemCount\": ").append(c.get("itemCount"))
              .append(", \"x\": ").append(c.get("x"))
              .append(", \"z\": ").append(c.get("z"));
            Object items = c.get("items");
            if (items instanceof List) {
                List<Map<String, Object>> itemList = (List<Map<String, Object>>) items;
                sb.append(", \"items\": [");
                for (int j = 0; j < itemList.size(); j++) {
                    Map<String, Object> it = itemList.get(j);
                    sb.append("{\"name\": ").append(jsonStr(String.valueOf(it.get("name"))))
                      .append(", \"stack\": ").append(it.get("stack")).append("}");
                    if (j < itemList.size() - 1) sb.append(", ");
                }
                sb.append("]");
            }
            sb.append("}");
            if (i < containers.size() - 1) sb.append(",");
            sb.append("\n");
        }
        sb.append("  ]\n");

        sb.append("}\n");

        System.out.println(sb.toString());
    }

    static String toJsonArray(List<String> list) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < list.size(); i++) {
            sb.append(jsonStr(list.get(i)));
            if (i < list.size() - 1) sb.append(", ");
        }
        sb.append("]");
        return sb.toString();
    }

    static String jsonStr(String s) {
        if (s == null) return "null";
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }
}
