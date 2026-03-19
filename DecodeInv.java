import net.kakoen.valheim.save.archive.hints.ValheimSaveReaderHints;
import net.kakoen.valheim.save.archive.save.Zdo;
import net.kakoen.valheim.save.parser.ZPackage;

import java.io.*;
import java.util.Base64;

/**
 * Dumps raw bytes of first N non-empty chest inventories for format analysis.
 */
public class DecodeInv {
    public static void main(String[] args) throws Exception {
        String dbPath = args.length > 0 ? args[0] : "ComfyEra14.db";
        int maxDump = 3;

        ValheimSaveReaderHints hints = ValheimSaveReaderHints.builder()
                .resolveNames(true).failOnUnsupportedVersion(false).build();

        try (ZPackage pkg = new ZPackage(new File(dbPath))) {
            int worldVersion = pkg.readInt32();
            double netTime = pkg.readDouble();
            pkg.readLong(); // myId
            pkg.readUInt(); // nextUid
            int totalZdos = pkg.readInt32();
            System.err.println("worldVersion=" + worldVersion + " zdos=" + totalZdos);

            int found = 0;
            for (int i = 0; i < totalZdos && found < maxDump; i++) {
                try {
                    Zdo zdo = new Zdo(pkg, worldVersion, hints);
                    String prefab = zdo.getPrefabName();
                    if (prefab == null) continue;
                    if (!prefab.startsWith("piece_chest") && !prefab.contains("chest")) continue;

                    String itemsB64 = null;
                    if (zdo.getStringsByName() != null) {
                        itemsB64 = zdo.getStringsByName().get("items");
                    }
                    if (itemsB64 == null || itemsB64.isEmpty()) continue;

                    byte[] raw = Base64.getDecoder().decode(itemsB64);
                    if (raw.length <= 8) continue; // empty inventory

                    found++;
                    System.out.println("=== Chest #" + found + " prefab=" + prefab + " pos=" + zdo.getPosition());
                    System.out.println("raw bytes (" + raw.length + "): " + bytesToHex(raw, Math.min(raw.length, 200)));
                    System.out.println("base64: " + itemsB64.substring(0, Math.min(50, itemsB64.length())));

                    // Try to parse manually
                    ZPackage inv = new ZPackage(raw);
                    int version = inv.readInt32();
                    int count = inv.readInt32();
                    System.out.println("  inv version=" + version + " count=" + count);
                    for (int j = 0; j < count && j < 5; j++) {
                        int pos = inv.getPosition();
                        try {
                            String name = inv.readString();
                            int stack = inv.readInt32();
                            float durability = inv.readSingle();
                            int px = inv.readInt32(); // pos x
                            int py = inv.readInt32(); // pos y
                            boolean equipped = inv.readBool();
                            int quality = version >= 101 ? inv.readInt32() : 1;
                            int variant = version >= 102 ? inv.readInt32() : 0;
                            long crafterId = version >= 103 ? inv.readLong() : 0;
                            String crafterName = version >= 103 ? inv.readString() : "";
                            int customDataCount = version >= 104 ? inv.readInt32() : 0;
                            for (int k = 0; k < customDataCount; k++) {
                                inv.readString();
                                inv.readString();
                            }
                            System.out.printf("  item[%d] name='%s' stack=%d dur=%.1f slot=%d,%d quality=%d crafterName='%s' customData=%d%n",
                                    j, name, stack, durability, px, py, quality, crafterName, customDataCount);
                        } catch (Exception e) {
                            System.out.println("  item[" + j + "] PARSE ERROR at pos=" + pos + ": " + e.getMessage());
                            break;
                        }
                    }
                    System.out.println("  remaining bytes after " + count + " items: " + (raw.length - inv.getPosition()));
                } catch (Throwable e) {
                    // skip
                }
            }
        }
    }

    static String bytesToHex(byte[] b, int len) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < len; i++) {
            sb.append(String.format("%02x ", b[i]));
        }
        return sb.toString();
    }
}
