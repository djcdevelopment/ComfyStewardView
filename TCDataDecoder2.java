import net.kakoen.valheim.save.archive.hints.ValheimSaveReaderHints;
import net.kakoen.valheim.save.archive.save.Zdo;
import net.kakoen.valheim.save.parser.ZPackage;

import java.io.*;
import java.util.*;
import java.util.zip.GZIPInputStream;

/**
 * Decompresses TCData gzip bytes and parses the inner ZPackage.
 * Targets: hash:-494364525 (container variant) and hash:650075310 (item stand with TCData)
 */
public class TCDataDecoder2 {

    static byte[] gunzip(byte[] compressed) throws IOException {
        try (GZIPInputStream gz = new GZIPInputStream(new ByteArrayInputStream(compressed));
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = gz.read(buf)) != -1) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    public static void main(String[] args) throws Exception {
        ValheimSaveReaderHints hints = ValheimSaveReaderHints.builder()
                .resolveNames(true).failOnUnsupportedVersion(false).build();

        int[] targets = {-494364525, 650075310, 1411875912};
        Map<Integer, Integer> dumpCount = new HashMap<>();
        for (int h : targets) dumpCount.put(h, 0);

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

                    Integer cnt = dumpCount.get(hash);
                    if (cnt == null || cnt >= 3) continue;
                    dumpCount.put(hash, cnt + 1);

                    float x = zdo.getPosition() != null ? zdo.getPosition().getX() : 0;
                    float z = zdo.getPosition() != null ? zdo.getPosition().getZ() : 0;

                    System.out.println("\n=== hash:" + hash + " #" + (cnt+1) + " @ (" + (int)x + "," + (int)z + ") ===");
                    System.out.println("  All properties:");
                    if (zdo.getStringsByName() != null && !zdo.getStringsByName().isEmpty()) {
                        System.out.println("  strings: " + zdo.getStringsByName());
                    }
                    if (zdo.getIntsByName() != null && !zdo.getIntsByName().isEmpty()) {
                        System.out.println("  ints:    " + zdo.getIntsByName());
                    }
                    if (zdo.getFloatsByName() != null && !zdo.getFloatsByName().isEmpty()) {
                        System.out.println("  floats:  " + zdo.getFloatsByName());
                    }
                    if (zdo.getLongsByName() != null && !zdo.getLongsByName().isEmpty()) {
                        System.out.println("  longs:   " + zdo.getLongsByName());
                    }

                    if (zdo.getByteArraysByName() == null || !zdo.getByteArraysByName().containsKey("TCData")) {
                        System.out.println("  [no TCData]");
                        continue;
                    }

                    byte[] compressed = zdo.getByteArraysByName().get("TCData");
                    System.out.println("  TCData compressed length: " + compressed.length);

                    byte[] raw;
                    try {
                        raw = gunzip(compressed);
                    } catch (Exception e) {
                        System.out.println("  gunzip FAILED: " + e.getMessage());
                        continue;
                    }
                    System.out.println("  TCData decompressed length: " + raw.length);

                    // Try parsing as ZPackage (inner binary format)
                    try (ZPackage inner = new ZPackage(raw)) {
                        System.out.println("  --- Parsing inner ZPackage ---");
                        // Attempt 1: read as int32 version + int32 count + item list (inventory format)
                        int v1 = inner.readInt32();
                        System.out.println("  [0] int32 = " + v1 + " (possible version)");
                        int v2 = inner.readInt32();
                        System.out.println("  [4] int32 = " + v2 + " (possible count or second field)");

                        if (v1 >= 100 && v1 <= 120 && v2 >= 0 && v2 < 200) {
                            // Looks like inventory: version=v1, count=v2
                            System.out.println("  Interpreting as INVENTORY (version=" + v1 + ", items=" + v2 + "):");
                            for (int j = 0; j < Math.min(v2, 5); j++) {
                                try {
                                    String name = inner.readString();
                                    int stack = inner.readInt32();
                                    float dur = inner.readSingle();
                                    int px = inner.readInt32(); int py = inner.readInt32();
                                    boolean equipped = inner.readBool();
                                    int quality = v1 >= 101 ? inner.readInt32() : 1;
                                    int variant = v1 >= 102 ? inner.readInt32() : 0;
                                    if (v1 >= 103) { inner.readLong(); inner.readString(); }
                                    if (v1 >= 104) {
                                        int mc = inner.readInt32();
                                        for (int k = 0; k < mc; k++) { inner.readString(); inner.readString(); }
                                    }
                                    if (v1 >= 105) inner.readByte();
                                    System.out.printf("    Item[%d]: name=%-25s stack=%-4d quality=%d slot=%d,%d%n",
                                            j, name, stack, quality, px, py);
                                } catch (Exception e) {
                                    System.out.println("    Item[" + j + "]: READ ERROR: " + e.getMessage());
                                    break;
                                }
                            }
                        } else {
                            // Not inventory format — dump first 16 ints
                            System.out.println("  Not inventory format. Next 14 int32s:");
                            for (int j = 0; j < 14; j++) {
                                try {
                                    System.out.printf("    [%d] = %d%n", (j+2)*4, inner.readInt32());
                                } catch (Exception e) { break; }
                            }
                            // Try raw hex of decompressed
                            StringBuilder hex = new StringBuilder("  decompressed hex: ");
                            for (int j = 0; j < Math.min(80, raw.length); j++) {
                                hex.append(String.format("%02x ", raw[j]));
                            }
                            System.out.println(hex.toString().trim());
                        }
                    } catch (Exception e) {
                        System.out.println("  ZPackage parse error: " + e.getMessage());
                        // Hex dump raw
                        StringBuilder hex = new StringBuilder("  raw hex: ");
                        for (int j = 0; j < Math.min(80, raw.length); j++) {
                            hex.append(String.format("%02x ", raw[j]));
                        }
                        System.out.println(hex.toString().trim());
                    }

                } catch (Throwable e) { }
            }
        }
        System.err.println("\nDone in " + (System.currentTimeMillis() - t0) + "ms");
    }
}
