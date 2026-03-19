import net.kakoen.valheim.save.archive.hints.ValheimSaveReaderHints;
import net.kakoen.valheim.save.archive.save.Zdo;
import net.kakoen.valheim.save.parser.ZPackage;

import java.io.*;
import java.util.*;

/**
 * Combined pre-build probe covering all 5 hard/soft blockers:
 * 1. SpawntimeCalibration  — what are the units of spawntime longs?
 * 2. CreatorIdMapping      — creator long vs Steam ID format
 * 3. BedVariantAudit       — all bed prefab variants with counts
 * 4. TombstoneFullDump     — exact tombstone property keys
 * 5. PortalPrefabAudit     — exact portal prefab names and tag property
 * 6. TCDataDecoder         — decode hash:-494364525 / hash:650075310 byte arrays
 * 7. WorldBoundsProbe      — true world coordinate extents
 */
public class PreBuildProbes {

    public static void main(String[] args) throws Exception {
        String dbPath = args.length > 0 ? args[0] : "ComfyEra14.db";

        ValheimSaveReaderHints hints = ValheimSaveReaderHints.builder()
                .resolveNames(true).failOnUnsupportedVersion(false).build();

        // ---- Accumulators ----
        // Spawntime calibration
        double netTime = 0;
        List<Long> spawntimeSamples = new ArrayList<>();
        List<Long> lastTimeSamples = new ArrayList<>();

        // Creator mapping
        Map<Long, String> creatorToName = new LinkedHashMap<>();  // from beds
        List<String> signAuthors = new ArrayList<>();
        Map<String, String> tombProperties = new LinkedHashMap<>(); // key -> first value seen
        Set<String> tombStringKeys = new LinkedHashSet<>();
        Set<String> tombLongKeys = new LinkedHashSet<>();

        // Bed audit
        Map<String, Integer> bedPrefabCounts = new TreeMap<>();
        Map<String, Set<String>> bedStringKeys = new TreeMap<>();
        Map<String, Set<String>> bedLongKeys = new TreeMap<>();

        // Tombstone dump
        List<Map<String, Object>> tombDumps = new ArrayList<>();

        // Portal audit
        Map<String, Integer> portalPrefabCounts = new TreeMap<>();
        Map<String, Set<String>> portalStringKeys = new TreeMap<>();
        Map<String, Set<String>> portalLongKeys = new TreeMap<>();

        // TCData
        Map<Integer, List<byte[]>> tcDataSamples = new LinkedHashMap<>();
        tcDataSamples.put(-494364525, new ArrayList<>());
        tcDataSamples.put(650075310, new ArrayList<>());

        // World bounds
        float minX = Float.MAX_VALUE, maxX = -Float.MAX_VALUE;
        float minZ = Float.MAX_VALUE, maxZ = -Float.MAX_VALUE;
        float minY = Float.MAX_VALUE, maxY = -Float.MAX_VALUE;
        float pMinX = Float.MAX_VALUE, pMaxX = -Float.MAX_VALUE;
        float pMinZ = Float.MAX_VALUE, pMaxZ = -Float.MAX_VALUE;

        long t0 = System.currentTimeMillis();
        try (ZPackage pkg = new ZPackage(new File(dbPath))) {
            int worldVersion = pkg.readInt32();
            netTime = pkg.readDouble();
            pkg.readLong(); pkg.readUInt();
            int totalZdos = pkg.readInt32();
            System.err.println("worldVersion=" + worldVersion + " netTime=" + netTime + " totalZdos=" + totalZdos);

            for (int i = 0; i < totalZdos; i++) {
                if (i % 1_000_000 == 0) System.err.print(".");
                try {
                    Zdo zdo = new Zdo(pkg, worldVersion, hints);
                    int hash = zdo.getPrefab();
                    String prefab = zdo.getPrefabName();
                    float x = zdo.getPosition() != null ? zdo.getPosition().getX() : 0;
                    float y = zdo.getPosition() != null ? zdo.getPosition().getY() : 0;
                    float z = zdo.getPosition() != null ? zdo.getPosition().getZ() : 0;

                    // World bounds
                    if (x < minX) minX = x;  if (x > maxX) maxX = x;
                    if (z < minZ) minZ = z;  if (z > maxZ) maxZ = z;
                    if (y < minY) minY = y;  if (y > maxY) maxY = y;

                    // Spawntime calibration (from dropped items)
                    if (prefab == null && zdo.getLongsByName() != null) {
                        Long st = zdo.getLongsByName().get("spawntime");
                        if (st != null && spawntimeSamples.size() < 200) spawntimeSamples.add(st);
                        Long lt = zdo.getLongsByName().get("lastTime");
                        if (lt != null && lastTimeSamples.size() < 50) lastTimeSamples.add(lt);
                    }

                    boolean hasCreator = zdo.getLongsByName() != null && zdo.getLongsByName().containsKey("creator");
                    if (hasCreator) {
                        if (x < pMinX) pMinX = x;  if (x > pMaxX) pMaxX = x;
                        if (z < pMinZ) pMinZ = z;  if (z > pMaxZ) pMaxZ = z;
                    }

                    // Beds
                    boolean isBed = prefab != null && (prefab.contains("bed") || prefab.contains("Bed"));
                    if (isBed) {
                        bedPrefabCounts.merge(prefab, 1, Integer::sum);
                        bedStringKeys.computeIfAbsent(prefab, k -> new TreeSet<>())
                                .addAll(zdo.getStringsByName() != null ? zdo.getStringsByName().keySet() : Set.of());
                        bedLongKeys.computeIfAbsent(prefab, k -> new TreeSet<>())
                                .addAll(zdo.getLongsByName() != null ? zdo.getLongsByName().keySet() : Set.of());
                        // Collect owner mapping
                        if (zdo.getLongsByName() != null && zdo.getStringsByName() != null) {
                            Long ownerId = zdo.getLongsByName().get("owner");
                            String ownerName = zdo.getStringsByName().get("ownerName");
                            if (ownerName == null) ownerName = zdo.getStringsByName().get("owner");
                            if (ownerId != null && ownerId != 0 && ownerName != null && !ownerName.isEmpty()) {
                                creatorToName.put(ownerId, ownerName);
                            }
                        }
                    }

                    // Tombstones
                    boolean isTomb = prefab != null && prefab.toLowerCase().contains("tombstone");
                    if (isTomb && tombDumps.size() < 10) {
                        Map<String, Object> d = new LinkedHashMap<>();
                        d.put("prefab", prefab);
                        d.put("pos", String.format("%.1f,%.1f", x, z));
                        if (zdo.getStringsByName() != null) d.put("strings", zdo.getStringsByName());
                        if (zdo.getIntsByName() != null) d.put("ints", zdo.getIntsByName());
                        if (zdo.getFloatsByName() != null) d.put("floats", zdo.getFloatsByName());
                        if (zdo.getLongsByName() != null) d.put("longs", zdo.getLongsByName());
                        tombDumps.add(d);
                        if (zdo.getStringsByName() != null) tombStringKeys.addAll(zdo.getStringsByName().keySet());
                        if (zdo.getLongsByName() != null) tombLongKeys.addAll(zdo.getLongsByName().keySet());
                    }

                    // Portals
                    boolean isPortal = prefab != null && prefab.toLowerCase().contains("portal");
                    if (isPortal) {
                        portalPrefabCounts.merge(prefab, 1, Integer::sum);
                        portalStringKeys.computeIfAbsent(prefab, k -> new TreeSet<>())
                                .addAll(zdo.getStringsByName() != null ? zdo.getStringsByName().keySet() : Set.of());
                        portalLongKeys.computeIfAbsent(prefab, k -> new TreeSet<>())
                                .addAll(zdo.getLongsByName() != null ? zdo.getLongsByName().keySet() : Set.of());
                    }

                    // Signs — collect author field
                    if (("sign".equals(prefab) || "sign_notext".equals(prefab) || hash == 686545676)
                            && signAuthors.size() < 100 && zdo.getStringsByName() != null) {
                        String author = zdo.getStringsByName().get("author");
                        if (author != null && !author.isEmpty()) signAuthors.add(author);
                    }

                    // TCData decode
                    List<byte[]> tcList = tcDataSamples.get(hash);
                    if (tcList != null && tcList.size() < 5 && zdo.getByteArraysByName() != null) {
                        byte[] tc = zdo.getByteArraysByName().get("TCData");
                        if (tc != null) {
                            tcList.add(tc);
                            // Also print all string/int keys on this ZDO for cross-reference
                        }
                    }

                } catch (Throwable e) { }
            }
        }
        System.err.println("\nDone in " + (System.currentTimeMillis() - t0) + "ms");

        // ===== REPORT =====

        System.out.println("=== 1. SPAWNTIME CALIBRATION ===");
        System.out.printf("  netTime (header double, seconds): %.1f%n", netTime);
        System.out.printf("  netTime as days (netTime/86400): %.2f real days%n", netTime / 86400.0);
        System.out.printf("  netTime as Valheim days (netTime/1200): %.1f in-game days%n", netTime / 1200.0);
        System.out.println();
        if (!spawntimeSamples.isEmpty()) {
            long stMin = spawntimeSamples.stream().mapToLong(Long::longValue).min().getAsLong();
            long stMax = spawntimeSamples.stream().mapToLong(Long::longValue).max().getAsLong();
            long stMed = spawntimeSamples.stream().sorted().collect(java.util.stream.Collectors.toList())
                    .get(spawntimeSamples.size() / 2);
            System.out.println("  Spawntime samples collected: " + spawntimeSamples.size());
            System.out.println("  spawntime min: " + stMin);
            System.out.println("  spawntime max: " + stMax);
            System.out.println("  spawntime median: " + stMed);
            System.out.println();
            System.out.println("  Interpretations for MEDIAN spawntime (" + stMed + "):");
            System.out.printf("    As seconds:        %.0f s = %.1f real days = %.1f VH days%n",
                    (double)stMed, stMed/86400.0, stMed/1200.0);
            System.out.printf("    As milliseconds:   %.0f s = %.1f real days = %.1f VH days%n",
                    stMed/1000.0, stMed/1000.0/86400.0, stMed/1000.0/1200.0);
            System.out.printf("    As microseconds:   %.0f s = %.1f real days = %.1f VH days%n",
                    stMed/1e6, stMed/1e6/86400.0, stMed/1e6/1200.0);
            System.out.printf("    As 100ns ticks:    %.0f s = %.1f real days = %.1f VH days%n",
                    stMed/1e7, stMed/1e7/86400.0, stMed/1e7/1200.0);
            System.out.printf("    netTime / (stMed as ms): %.4f (should be ~1.0 if same epoch + units)%n",
                    netTime / (stMed / 1000.0));
            System.out.printf("    netTime / (stMed as µs): %.4f%n", netTime / (stMed / 1e6));
            System.out.printf("    netTime / (stMed as 100ns): %.4f%n", netTime / (stMed / 1e7));
            System.out.println();
            System.out.println("  First 20 spawntime samples:");
            spawntimeSamples.stream().limit(20).forEach(s ->
                System.out.printf("    %d  → as ms: %.0fs = %.2f VH-days%n",
                        s, s/1000.0, s/1000.0/1200.0));
        }
        if (!lastTimeSamples.isEmpty()) {
            System.out.println("  lastTime samples (fuel-burner ZDOs):");
            lastTimeSamples.stream().limit(10).forEach(s ->
                System.out.printf("    %d  → as ms: %.0fs = %.2f VH-days%n",
                        s, s/1000.0, s/1000.0/1200.0));
        }

        System.out.println("\n=== 2. CREATOR ID MAPPING ===");
        System.out.println("  Bed owner mappings built: " + creatorToName.size());
        System.out.println("  Sample (ownerId long → name):");
        creatorToName.entrySet().stream().limit(20)
                .forEach(e -> System.out.printf("    %20d → %s%n", e.getKey(), e.getValue()));
        System.out.println();
        System.out.println("  Sign author samples:");
        new HashSet<>(signAuthors).stream().limit(15).forEach(a -> System.out.println("    " + a));
        // Check if any bed owner long appears in sign author (try stripping "Steam_" prefix)
        System.out.println();
        System.out.println("  Cross-ref: checking if bed ownerId matches Steam64 low32 or Steam64 directly...");
        for (Map.Entry<Long, String> e : creatorToName.entrySet()) {
            for (String author : signAuthors) {
                if (author.startsWith("Steam_")) {
                    try {
                        long steamId = Long.parseLong(author.substring(6));
                        if (steamId == e.getKey()) {
                            System.out.printf("    FULL MATCH: ownerId=%d = Steam_%d (%s)%n",
                                    e.getKey(), steamId, e.getValue());
                        }
                        int low32 = (int)(steamId & 0xFFFFFFFFL);
                        if (low32 == e.getKey().intValue()) {
                            System.out.printf("    LOW32 MATCH: ownerId=%d ≡ low32 of Steam_%d (%s)%n",
                                    e.getKey(), steamId, e.getValue());
                        }
                        // Also try: steamId mod 2^31
                        long mod31 = steamId % 2_147_483_648L;
                        if (mod31 == e.getKey()) {
                            System.out.printf("    MOD31 MATCH: ownerId=%d ≡ Steam_%d mod 2^31 (%s)%n",
                                    e.getKey(), steamId, e.getValue());
                        }
                    } catch (NumberFormatException ex) { }
                }
            }
        }

        System.out.println("\n=== 3. BED VARIANT AUDIT ===");
        int totalBeds = bedPrefabCounts.values().stream().mapToInt(Integer::intValue).sum();
        System.out.println("  Total bed-containing ZDOs found: " + totalBeds);
        bedPrefabCounts.entrySet().stream()
                .sorted(Map.Entry.<String,Integer>comparingByValue().reversed())
                .forEach(e -> System.out.printf("  %5dx  %-40s  strKeys=%s  longKeys=%s%n",
                        e.getValue(), e.getKey(),
                        bedStringKeys.getOrDefault(e.getKey(), Set.of()),
                        bedLongKeys.getOrDefault(e.getKey(), Set.of())));

        System.out.println("\n=== 4. TOMBSTONE FULL DUMP ===");
        System.out.println("  Tombstone string keys seen: " + tombStringKeys);
        System.out.println("  Tombstone long keys seen:   " + tombLongKeys);
        System.out.println("  First " + tombDumps.size() + " tombstone ZDOs:");
        for (Map<String, Object> d : tombDumps) {
            System.out.println("  --- " + d.get("prefab") + " @ " + d.get("pos") + " ---");
            if (d.containsKey("strings")) System.out.println("    strings: " + d.get("strings"));
            if (d.containsKey("ints"))    System.out.println("    ints:    " + d.get("ints"));
            if (d.containsKey("floats"))  System.out.println("    floats:  " + d.get("floats"));
            if (d.containsKey("longs"))   System.out.println("    longs:   " + d.get("longs"));
        }

        System.out.println("\n=== 5. PORTAL PREFAB AUDIT ===");
        portalPrefabCounts.entrySet().stream()
                .sorted(Map.Entry.<String,Integer>comparingByValue().reversed())
                .forEach(e -> System.out.printf("  %5dx  %-40s  strKeys=%s  longKeys=%s%n",
                        e.getValue(), e.getKey(),
                        portalStringKeys.getOrDefault(e.getKey(), Set.of()),
                        portalLongKeys.getOrDefault(e.getKey(), Set.of())));

        System.out.println("\n=== 6. TCDATA DECODE ===");
        for (Map.Entry<Integer, List<byte[]>> e : tcDataSamples.entrySet()) {
            System.out.println("  hash:" + e.getKey() + " — " + e.getValue().size() + " TCData samples:");
            for (byte[] tc : e.getValue()) {
                System.out.println("    length=" + tc.length);
                // Hex dump first 64 bytes
                StringBuilder hex = new StringBuilder("    hex: ");
                for (int i = 0; i < Math.min(64, tc.length); i++) {
                    hex.append(String.format("%02x ", tc[i]));
                }
                System.out.println(hex.toString().trim());
                // Try to parse as ZPackage
                try (ZPackage tp = new ZPackage(tc)) {
                    System.out.println("    ZPackage parse attempt:");
                    // Try reading as int32 version + int32 count
                    int v1 = tp.readInt32();
                    System.out.println("      first int32: " + v1);
                    if (v1 >= 0 && v1 < 1000) {
                        int v2 = tp.readInt32();
                        System.out.println("      second int32: " + v2);
                        if (v2 >= 0 && v2 < 500) {
                            System.out.println("      (looks like version=" + v1 + " count=" + v2 + ")");
                            for (int i = 0; i < Math.min(v2, 3); i++) {
                                try {
                                    String s = tp.readString();
                                    System.out.println("      string[" + i + "]: " + s);
                                } catch (Exception ex) {
                                    System.out.println("      string[" + i + "]: READ_ERROR");
                                    break;
                                }
                            }
                        }
                    }
                } catch (Exception ex) {
                    System.out.println("    ZPackage parse error: " + ex.getMessage());
                }
                // Also try as UTF-8 string
                String asUtf8 = new String(tc, java.nio.charset.StandardCharsets.UTF_8);
                boolean printable = asUtf8.chars().allMatch(c -> c >= 32 && c < 127);
                if (printable) System.out.println("    as UTF-8: " + asUtf8.substring(0, Math.min(80, asUtf8.length())));
            }
        }

        System.out.println("\n=== 7. WORLD BOUNDS ===");
        System.out.printf("  ALL ZDOs:          x=[%.0f, %.0f]  y=[%.0f, %.0f]  z=[%.0f, %.0f]%n",
                minX, maxX, minY, maxY, minZ, maxZ);
        System.out.printf("  Player structures: x=[%.0f, %.0f]  z=[%.0f, %.0f]%n",
                pMinX, pMaxX, pMinZ, pMaxZ);
        System.out.printf("  World radius estimate: max(|%.0f|,|%.0f|,|%.0f|,|%.0f|) = %.0f%n",
                minX, maxX, minZ, maxZ,
                Math.max(Math.max(Math.abs(minX), Math.abs(maxX)),
                         Math.max(Math.abs(minZ), Math.abs(maxZ))));
    }
}
