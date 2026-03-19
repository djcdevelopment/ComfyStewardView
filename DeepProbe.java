import net.kakoen.valheim.save.archive.hints.ValheimSaveReaderHints;
import net.kakoen.valheim.save.archive.save.Zdo;
import net.kakoen.valheim.save.parser.ZPackage;
import net.kakoen.valheim.save.struct.ZdoId;

import java.io.*;
import java.util.*;
import java.util.stream.*;

/**
 * Deep probe: sign texts, item stand contents, unknown hash properties,
 * creature census, dead ZDO count, creator IDs.
 */
public class DeepProbe {

    // Known creature prefab names (not exhaustive, but covers main ones)
    static final Set<String> CREATURES = new HashSet<>(Arrays.asList(
        "Greydwarf","Greydwarf_Elite","Greydwarf_Shaman","Greyling",
        "Troll","GhostLastWish","Ghost","BlobElite","Blob","Leech",
        "Skeleton","Skeleton_Poison","Draugr","Draugr_Elite","Draugr_Ranged",
        "Surtling","Wraith","Wolf","Neck","Boar","Deer","Crow","Seagal",
        "Serpent","Leviathan","Bat","StoneGolem",
        "Lox","Deathsquito","Fuling","Fuling_Berserker","Fuling_Shaman","GoblinKing",
        "Gjall","Seeker","SeekerBrute","SeekerSoldier","Tick",
        "Dverger","DvergerMage","DvergerMageFireLarge","DvergerMageSupportLightning",
        "Fenring","Fenring_Cultist","Ulv","Hare","Hen","Chicken",
        "Fallen_Valkyrie","Fader","Morgen","CrawlerMelee",
        "Charred_Melee","Charred_Archer","Charred_Mage","Charred_Twitcher",
        "Asksvin","Volture","BlobTar","BoneSerpent","Jotun"
    ));

    // Known build-piece prefixes (player-built structures)
    static final List<String> BUILD_PREFIXES = Arrays.asList(
        "wood_","stone_","piece_","woodwall","darkwood_","blackmarble_",
        "irongate","dvergr_","goblin_","stake_","iron_","roundlog_","ashwood_","ashlog_"
    );

    // sign texts
    static final Map<String, Integer> signTextCounts = new LinkedHashMap<>();
    static int totalSigns = 0, blankSigns = 0;

    // item stands
    static final Map<String, Integer> itemStandItems = new TreeMap<>();
    static int totalItemStands = 0;

    // creatures
    static final Map<String, Integer> creatureCounts = new TreeMap<>();
    static int totalCreatures = 0;

    // dropped items (prefab = the item name, has "crafterName" property)
    static final Map<String, Integer> droppedItems = new TreeMap<>();

    // player creators
    static final Map<Long, Integer> creatorIds = new TreeMap<>();

    // unknown hash property profiles
    static final Map<Integer, Map<String, Object>> hashProfiles = new LinkedHashMap<>();
    static final Set<Integer> UNKNOWNS_TO_PROFILE = new HashSet<>(Arrays.asList(
        1411875912, -1161852777, 538325542, -494364525, -2119951934,
        -2129458801, 686545676, 650075310, -502993694, -62980316,
        109649212, 1792656179, 1272849455, -1195767551, 1341839349, -2053541920
    ));

    // dead ZDOs
    static int deadZdoCount = 0;

    public static void main(String[] args) throws Exception {
        String dbPath = args.length > 0 ? args[0] : "ComfyEra14.db";

        ValheimSaveReaderHints hints = ValheimSaveReaderHints.builder()
                .resolveNames(true).failOnUnsupportedVersion(false).build();

        long t0 = System.currentTimeMillis();
        try (ZPackage pkg = new ZPackage(new File(dbPath))) {
            int worldVersion = pkg.readInt32();
            pkg.readDouble(); // netTime
            pkg.readLong();   // myId
            pkg.readUInt();   // nextUid
            int totalZdos = pkg.readInt32();
            System.err.println("worldVersion=" + worldVersion + " zdos=" + totalZdos);

            for (int i = 0; i < totalZdos; i++) {
                if (i % 500_000 == 0) System.err.print(".");
                try {
                    Zdo zdo = new Zdo(pkg, worldVersion, hints);
                    processZdo(zdo);
                } catch (Throwable e) { /* skip */ }
            }
            System.err.println();

            // Read zones (mirror of Zones.load)
            try {
                int gzc = pkg.readInt32();
                System.err.println("generatedZones=" + gzc);
                for (int i = 0; i < gzc; i++) { pkg.readInt32(); pkg.readInt32(); }
                pkg.readInt32(); // pgwVersion
                pkg.readInt32(); // locationVersion (version >= 21)
                int gkc = pkg.readInt32();
                System.err.println("globalKeys=" + gkc);
                for (int i = 0; i < gkc; i++) pkg.readString();
                pkg.readBool(); // locationsGenerated
                int plc = pkg.readInt32();
                System.err.println("prefabLocations=" + plc);
                // PrefabLocation = string name + Vector3 pos (3 floats) + bool generated
                for (int i = 0; i < plc; i++) {
                    pkg.readString(); // name
                    pkg.readSingle(); pkg.readSingle(); pkg.readSingle(); // pos
                    pkg.readBool(); // generated
                }
            } catch (Throwable e) {
                System.err.println("Zones parse error: " + e.getMessage());
            }

            // RandomEvent (mirror of RandomEvent constructor)
            try {
                float eventTimer = pkg.readSingle();
                String eventName = pkg.readString();
                float eventNum = pkg.readSingle();
                // Vector3 position
                pkg.readSingle(); pkg.readSingle(); pkg.readSingle();
                System.err.println("RandomEvent: timer=" + eventTimer + " name='" + eventName + "'");
            } catch (Throwable e) {
                System.err.println("RandomEvent parse error: " + e.getMessage());
            }

            // Dead ZDOs: int32 count + [ZdoId(long+uint) + long timestamp] each
            try {
                deadZdoCount = pkg.readInt32();
                System.err.println("Dead ZDO count: " + deadZdoCount);
                // each = long + uint (ZdoId) + long (timestamp) = 8+4+8 = 20 bytes
                for (int i = 0; i < deadZdoCount; i++) {
                    pkg.readLong(); // userId
                    pkg.readUInt(); // id
                    pkg.readLong(); // timestamp
                }
                System.err.println("Dead ZDOs parsed OK");
            } catch (Throwable e) {
                System.err.println("Dead ZDO parse error: " + e.getMessage());
            }
        }

        System.err.println("Done in " + (System.currentTimeMillis() - t0) + "ms");
        printReport();
    }

    static void processZdo(Zdo zdo) {
        String prefab = zdo.getPrefabName();
        int hash = zdo.getPrefab();

        // --- signs ---
        if ("sign".equals(prefab) || "sign_notext".equals(prefab)
                || hash == 747145 || hash == 686545676) {
            totalSigns++;
            String text = getStr(zdo, "text");
            if (text == null || text.isBlank() || text.equals("----->") || text.equals(""))
                blankSigns++;
            else
                signTextCounts.merge(text.trim(), 1, Integer::sum);
        }

        // --- item stands ---
        if ("itemstandh".equals(prefab) || "itemstand".equals(prefab)
                || hash == -1161852777 || hash == 650075310 || hash == -1161852776) {
            totalItemStands++;
            String item = getStr(zdo, "item");
            if (item != null && !item.isEmpty())
                itemStandItems.merge(item, 1, Integer::sum);
        }

        // --- creatures ---
        if (prefab != null && CREATURES.contains(prefab)) {
            totalCreatures++;
            creatureCounts.merge(prefab, 1, Integer::sum);
        }

        // --- dropped items (have 'crafterName' string but no build flags) ---
        if (prefab == null && (hash == 109649212 || hash == 1272849455 || hash == -1195767551)) {
            // profile this unknown
            // nothing here yet, handled in hash profiling
        }

        // creator/owner tracking
        Long creator = getLong(zdo, "creator");
        if (creator != null && creator != 0) {
            creatorIds.merge(creator, 1, Integer::sum);
        }

        // --- profile unknown hashes ---
        if (prefab == null && UNKNOWNS_TO_PROFILE.contains(hash)) {
            Map<String, Object> profile = hashProfiles.computeIfAbsent(hash, k -> new LinkedHashMap<>());
            profile.merge("count", 1, (a, b) -> (Integer)a + (Integer)b);

            // sample properties on first occurrence
            if (!profile.containsKey("strKeys")) {
                if (zdo.getStringsByName() != null && !zdo.getStringsByName().isEmpty()) {
                    profile.put("strKeys", new ArrayList<>(zdo.getStringsByName().keySet()));
                    // show first value for each key
                    for (Map.Entry<String, String> e : zdo.getStringsByName().entrySet()) {
                        profile.put("str_" + e.getKey(), truncate(e.getValue(), 60));
                    }
                }
                if (zdo.getIntsByName() != null && !zdo.getIntsByName().isEmpty())
                    profile.put("intKeys", new ArrayList<>(zdo.getIntsByName().keySet()));
                if (zdo.getFloatsByName() != null && !zdo.getFloatsByName().isEmpty())
                    profile.put("floatKeys", new ArrayList<>(zdo.getFloatsByName().keySet()));
                if (zdo.getLongsByName() != null && !zdo.getLongsByName().isEmpty())
                    profile.put("longKeys", new ArrayList<>(zdo.getLongsByName().keySet()));
                if (zdo.getByteArraysByName() != null && !zdo.getByteArraysByName().isEmpty())
                    profile.put("baKeys", new ArrayList<>(zdo.getByteArraysByName().keySet()));
            }

            // collect items/ammo/text values (aggregate)
            if (zdo.getStringsByName() != null) {
                String item = zdo.getStringsByName().get("item");
                if (item != null && !item.isEmpty()) {
                    Map<String, Integer> items = (Map<String, Integer>) profile.computeIfAbsent("items", k -> new TreeMap<>());
                    items.merge(item, 1, Integer::sum);
                }
                String ammo = zdo.getStringsByName().get("ammoType");
                if (ammo != null && !ammo.isEmpty()) {
                    Map<String, Integer> ammos = (Map<String, Integer>) profile.computeIfAbsent("ammoTypes", k -> new TreeMap<>());
                    ammos.merge(ammo, 1, Integer::sum);
                }
                String text = zdo.getStringsByName().get("text");
                if (text != null && !text.isEmpty() && ((Map<String, Integer>) profile.computeIfAbsent("texts", k -> new TreeMap<>())).size() < 5) {
                    ((Map<String, Integer>) profile.get("texts")).merge(truncate(text, 40), 1, Integer::sum);
                }
            }
        }
    }

    static void printReport() {
        System.out.println("=== DEAD ZDOs ===");
        System.out.println("  count: " + deadZdoCount);

        System.out.println("\n=== SIGN TEXTS ===");
        System.out.println("  Total sign ZDOs: " + totalSigns);
        System.out.println("  Blank/arrow: " + blankSigns);
        System.out.println("  Unique non-blank texts: " + signTextCounts.size());
        System.out.println("  Top 30 most-used sign texts:");
        signTextCounts.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .limit(30)
                .forEach(e -> System.out.printf("    %4dx  %s%n", e.getValue(), e.getKey().replace("\n","\\n")));

        System.out.println("\n=== ITEM STANDS ===");
        System.out.println("  Total item stand ZDOs: " + totalItemStands);
        System.out.println("  Top 40 displayed items:");
        itemStandItems.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .limit(40)
                .forEach(e -> System.out.printf("    %5dx  %s%n", e.getValue(), e.getKey()));

        System.out.println("\n=== CREATURE CENSUS ===");
        System.out.println("  Total creature ZDOs: " + totalCreatures);
        System.out.println("  By type:");
        creatureCounts.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .forEach(e -> System.out.printf("    %5dx  %s%n", e.getValue(), e.getKey()));

        System.out.println("\n=== TOP CREATORS (by structure count) ===");
        creatorIds.entrySet().stream()
                .sorted(Map.Entry.<Long, Integer>comparingByValue().reversed())
                .limit(20)
                .forEach(e -> System.out.printf("    %6dx  uid=%d%n", e.getValue(), e.getKey()));
        System.out.println("  Total unique creators: " + creatorIds.size());

        System.out.println("\n=== UNKNOWN HASH PROFILES ===");
        for (Map.Entry<Integer, Map<String, Object>> e : hashProfiles.entrySet()) {
            System.out.println("  hash:" + e.getKey() + " count=" + e.getValue().get("count"));
            Map<String, Object> p = e.getValue();
            for (Map.Entry<String, Object> pe : p.entrySet()) {
                if (pe.getKey().equals("count")) continue;
                System.out.println("    " + pe.getKey() + ": " + pe.getValue());
            }
        }
    }

    static String getStr(Zdo zdo, String key) {
        if (zdo.getStringsByName() != null) return zdo.getStringsByName().get(key);
        return null;
    }
    static Long getLong(Zdo zdo, String key) {
        if (zdo.getLongsByName() != null) return zdo.getLongsByName().get(key);
        return null;
    }
    static String truncate(String s, int max) {
        if (s == null) return null;
        return s.length() <= max ? s : s.substring(0, max) + "...";
    }
}
