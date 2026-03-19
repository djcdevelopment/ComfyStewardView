import net.kakoen.valheim.save.archive.hints.ValheimSaveReaderHints;
import net.kakoen.valheim.save.archive.save.Zdo;
import net.kakoen.valheim.save.parser.ZPackage;
import java.io.*;
import java.util.*;

/**
 * Dumps sign text samples + resolves some unknown hash prefabs
 */
public class SignsProbe {
    public static void main(String[] args) throws Exception {
        String dbPath = args.length > 0 ? args[0] : "ComfyEra14.db";
        ValheimSaveReaderHints hints = ValheimSaveReaderHints.builder()
                .resolveNames(true).failOnUnsupportedVersion(false).build();

        List<String> signTexts = new ArrayList<>();
        Map<Integer, Integer> unknownPrefabs = new TreeMap<>();
        Map<String, String> prefabSampleStrings = new LinkedHashMap<>(); // unknown hash -> sample string props

        try (ZPackage pkg = new ZPackage(new File(dbPath))) {
            int worldVersion = pkg.readInt32();
            pkg.readDouble(); // netTime
            pkg.readLong(); // myId
            pkg.readUInt(); // nextUid
            int totalZdos = pkg.readInt32();

            for (int i = 0; i < totalZdos; i++) {
                try {
                    Zdo zdo = new Zdo(pkg, worldVersion, hints);
                    String prefab = zdo.getPrefabName();

                    // sign text
                    if ("sign".equals(prefab)) {
                        String text = null;
                        if (zdo.getStringsByName() != null) text = zdo.getStringsByName().get("text");
                        if (text != null && !text.isEmpty() && signTexts.size() < 30) {
                            signTexts.add(text);
                        }
                    }

                    // unknown prefabs: track and sample their string properties
                    if (prefab == null) {
                        int hash = zdo.getPrefab();
                        unknownPrefabs.merge(hash, 1, Integer::sum);
                        // for first occurrence, capture string props
                        String hashKey = "hash:" + hash;
                        if (!prefabSampleStrings.containsKey(hashKey) && zdo.getStringsByName() != null && !zdo.getStringsByName().isEmpty()) {
                            prefabSampleStrings.put(hashKey, zdo.getStringsByName().toString().substring(0, Math.min(100, zdo.getStringsByName().toString().length())));
                        }
                    }

                } catch (Throwable e) { /* skip */ }
            }
        }

        System.out.println("=== SIGN SAMPLES (" + signTexts.size() + " shown) ===");
        for (String t : signTexts) {
            System.out.println("  " + t.replace("\n", "\\n").substring(0, Math.min(80, t.length())));
        }

        System.out.println("\n=== TOP 20 UNKNOWN HASH PREFABS ===");
        unknownPrefabs.entrySet().stream()
                .sorted(Map.Entry.<Integer, Integer>comparingByValue().reversed())
                .limit(20)
                .forEach(e -> {
                    String sample = prefabSampleStrings.get("hash:" + e.getKey());
                    System.out.printf("  hash:%-15d count=%d  sample=%s%n",
                            e.getKey(), e.getValue(),
                            sample != null ? sample : "(no string props)");
                });
    }
}
