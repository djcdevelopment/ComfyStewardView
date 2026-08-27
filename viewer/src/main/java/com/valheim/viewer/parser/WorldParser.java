package com.valheim.viewer.parser;

import com.valheim.viewer.db.AnalyticsCache;
import com.valheim.viewer.export.BuildingGeometryExporter;
import com.valheim.viewer.store.ZdoFlatStore;
import com.valheim.viewer.store.ZdoFlatStore.Categories;
import com.valheim.viewer.store.ZdoFlatStore.PlayerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.io.ByteArrayInputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.Base64;

/**
 * Direct binary ZDO parser — bypasses the library's Zdo class entirely.
 *
 * Performance strategy:
 * - Reads file via mmap into a ByteBuffer (no copy, OS-cache-backed)
 * - For nature ZDOs: zero allocation — just skip properties by advancing buf position
 * - For interesting ZDOs: extract only the specific fields we need
 * - Pre-computed StableHashCode integers for all property names
 */
public class WorldParser {

    private static final Logger log = LoggerFactory.getLogger(WorldParser.class);

    // ----- Pre-computed StableHashCode for all property names we access -----
    private static final int H_CREATOR      = sh("creator");
    private static final int H_OWNER        = sh("owner");
    private static final int H_SPAWNTIME    = sh("spawntime");
    private static final int H_HEALTH       = sh("health");
    private static final int H_SUPPORT      = sh("support");
    private static final int H_STACK        = sh("stack");
    private static final int H_QUALITY      = sh("quality");
    private static final int H_OWNER_NAME   = sh("ownerName");
    private static final int H_TEXT         = sh("text");
    private static final int H_AUTHOR       = sh("author");
    private static final int H_TAG          = sh("tag");
    private static final int H_ITEM         = sh("item");
    private static final int H_ITEMS        = sh("items");
    private static final int H_CRAFTER_NAME = sh("crafterName");

    // ----- Known prefab hashes -----
    private static final int HASH_PORTAL_WOOD  = sh("portal_wood");
    private static final int HASH_BED          = sh("bed");
    private static final int HASH_BED02        = sh("piece_bed02");
    private static final int HASH_GOBLIN_BED   = sh("goblin_bed");
    private static final int HASH_TOMBSTONE    = sh("Player_tombstone");
    private static final int HASH_SIGN1        = sh("sign");
    private static final int HASH_SIGN2        = sh("sign_notext");
    // Was the literal -1195767551, labelled "turret". The dictionary names that hash
    // blackmarble_1x1, and a probe found ammoType on 9 of its 41,651 ZDOs (0.022%) while
    // 99.8% carry health+support — a building piece. The real ballista is piece_turret.
    private static final int HASH_BALLISTA     = sh("piece_turret");   // -816396091

    // Every hash below is a name the verified dictionary confirms is a real prefab.
    // Three literals were removed here — 1411875912 (cliff_mistlands2, 173k ZDOs, 98.5%
    // scaleScalar), 650075310 (crystal_wall_1x1) and -1161852777 (blackmarble_2x2x2) — none of
    // which carried an "item" property on more than 0.02% of their ZDOs.
    private static final Set<Integer> ITEM_STAND_HASHES = new HashSet<>(Arrays.asList(
        sh("itemstand"), sh("itemstandh"),
        sh("ArmorStand"), sh("ArmorStand_Male"), sh("ArmorStand_Female")
    ));
    // Removed: -494364525 (caverock_ice_stalagtite — 0% carried "items") and piece_chest_cart,
    // which is not a prefab in any Valheim build. Added the remaining vanilla containers so
    // that an *empty* one is still counted; a non-empty one was already caught by hasItems.
    private static final Set<Integer> CONTAINER_HASHES = new HashSet<>(Arrays.asList(
        sh("piece_chest_wood"), sh("piece_chest"), sh("piece_chest_blackmetal"),
        sh("piece_chest_private"), sh("piece_chest_barrel"), sh("piece_chest_treasure"),
        sh("loot_chest_wood"), sh("loot_chest_stone"), sh("stonechest"), sh("Cart")
    ));
    private static final Set<Integer> BED_HASHES = new HashSet<>(Arrays.asList(HASH_BED, HASH_BED02));
    // 686545676 was HASH_SIGN3 "sign_hmHildir"; it is Piece_grausten_floor_4x4 and carried
    // text on 1 of 79,881 ZDOs. Signs now also match on content — see the classification below.
    private static final Set<Integer> SIGN_HASHES = new HashSet<>(Arrays.asList(HASH_SIGN1, HASH_SIGN2));

    private static final Set<String> KNOWN_CREATURES = new HashSet<>(Arrays.asList(
        "Seagal","Skeleton","Deer","Leech","Greydwarf","Crow","Draugr","Surtling",
        "Wolf","Deathsquito","Boar","Bird","Neck","Blob","Ghost","Troll","Abomination",
        "Serpent","Dragon","GoblinArcher","GoblinBrute","Goblin","GoblinShaman",
        "BlobElite","Wraith","Drake","StoneGolem","Bat","Lox","Tick","Growth",
        "Seeker","SeekerBrute","SeekerQueen","Dverger","DvergerArbalest","DvergerMage",
        "DvergerRogue","Hare","Gjall","Charred","CharredArcher","CharredMage",
        "CharredTwitcher","FaderMinion","MorgenBrute","Morgen","Asksvin",
        "CharredWarrior","Fader","Hildir","Hens","Hen","Chicken","Rooster"
    ));
    private static final Set<Integer> CREATURE_HASHES = new HashSet<>();
    static {
        for (String name : KNOWN_CREATURES) CREATURE_HASHES.add(sh(name));
    }

    // Dungeon entrances, boss altars, and other notable world structures.
    // Stored in structureIndices rather than discarded with generic buildings.
    private static final Set<String> KNOWN_ENTRANCES = new HashSet<>(Arrays.asList(
        // Black Forest
        "Crypt1", "Crypt2", "Crypt3", "Crypt4", "BurialChamber",
        // Swamp
        "SunkenCrypt1", "SunkenCrypt2", "SunkenCrypt3", "SunkenCrypt4",
        // Mountain
        "FrostCaves", "MountainCave",
        // Plains
        "GoblinCamp",
        // Mistlands
        "Mistlands_DvergrTownEntrance1", "Mistlands_DvergrTownEntrance2",
        "Mistlands_DvergrTownEntrance3",
        // Ashlands
        "AshlandsGjall", "Inferno_NiddavalirGate",
        // Boss altars (all biomes)
        "BossStone_Eikthyr",
        "BossStone_TheElder",
        "BossStone_Bonemass",
        "BossStone_Dragon",
        "BossStone_Yagluth",
        "GoblinKing_BossStone",
        "SeekerQueen_BossStone",
        "FaderAltar",
        // Tar pits
        "TarPit1", "TarPit2", "TarPit3"
    ));
    private static final Set<Integer> ENTRANCE_HASHES = new HashSet<>();
    static {
        for (String name : KNOWN_ENTRANCES) ENTRANCE_HASHES.add(sh(name));
    }

    // ZDO binary format flags
    private static final int FLAG_CONNECTIONS = 1;
    private static final int FLAG_FLOATS      = 2;
    private static final int FLAG_VECTOR3S    = 4;
    private static final int FLAG_QUATS       = 8;
    private static final int FLAG_INTS        = 16;
    private static final int FLAG_LONGS       = 32;
    private static final int FLAG_STRINGS     = 64;
    private static final int FLAG_BYTEARRAYS  = 128;
    private static final int FLAG_ROTATION    = 4096;

    // ----- Progress tracking -----
    private final AtomicInteger zdosParsed = new AtomicInteger(0);
    private final AtomicInteger totalZdos  = new AtomicInteger(0);
    private final AtomicReference<String> statusMsg = new AtomicReference<>("Initializing...");
    private volatile boolean done = false;
    private AnalyticsCache analyticsCache = null;

    public void setAnalyticsCache(AnalyticsCache analyticsCache) {
        this.analyticsCache = analyticsCache;
    }

    // Optional one-shot geometry sink (--export-building-geometry). When attached, the
    // 12-byte rotation the parser otherwise seeks over is decoded into these scratch
    // fields, which parseZdo fills before any recordCacheZdo call. Safe as instance
    // state because parse() drives parseZdo from a single-threaded loop.
    private BuildingGeometryExporter geometryExporter = null;
    private boolean curHasRot = false;
    private float curRotX, curRotY, curRotZ;

    public void setGeometryExporter(BuildingGeometryExporter exporter) {
        this.geometryExporter = exporter;
    }

    // ----- Reconciliation probe (diagnostic; empty = off) -------------------
    // Measures, for a set of prefab hashes, what FRACTION of their ZDOs actually
    // carries each property. Prior hash identifications were made from probes that
    // reported presence without a denominator, which is how a property occurring on
    // 12 of 40,889 ZDOs got recorded as "confirmed".

    private Set<Integer> probeHashes = Collections.emptySet();
    private final Map<Integer, ProbeStats> probeResults = new LinkedHashMap<>();

    /** Field names worth naming in a probe report. Anything else is shown as its raw hash. */
    private static final String[] PROBE_FIELD_NAMES = {
        "creator", "owner", "spawntime", "health", "support", "stack", "quality",
        "ownerName", "text", "author", "tag", "item", "items", "crafterName",
        "crafterID", "ammoType", "ammo", "targets", "TCData", "picked", "enabled",
        "scaleScalar", "durability", "fuel", "lastTime", "variant", "worldLevel",
        "pickedUp", "dataCount", "seed", "level", "haveTarget", "InUse"
    };
    private static final Map<Integer, String> PROBE_FIELD_BY_HASH = new HashMap<>();
    static {
        for (String n : PROBE_FIELD_NAMES) PROBE_FIELD_BY_HASH.put(sh(n), n);
    }

    public static final class ProbeStats {
        public long count = 0;
        /** field name → number of ZDOs of this hash that carried it */
        public final Map<String, Long> fieldPresence = new TreeMap<>();
        /** up to 3 full property dumps */
        public final List<String> samples = new ArrayList<>();
    }

    public void setProbeHashes(Set<Integer> hashes) {
        this.probeHashes = (hashes == null) ? Collections.emptySet() : hashes;
        this.probeResults.clear();
        for (Integer h : this.probeHashes) this.probeResults.put(h, new ProbeStats());
    }

    public Map<Integer, ProbeStats> getProbeResults() { return probeResults; }

    private static String probeFieldName(int hash) {
        String n = PROBE_FIELD_BY_HASH.get(hash);
        return n != null ? n : ("hash:" + hash);
    }

    private static void probeNote(Map<String, String> props, int fieldHash, String value) {
        props.put(probeFieldName(fieldHash), value);
    }

    public ParseProgress getProgress() {
        int parsed = zdosParsed.get(), total = totalZdos.get();
        return new ParseProgress(statusMsg.get(), parsed, total,
            total > 0 ? (double) parsed / total * 100.0 : 0, done);
    }

    public static class ParseProgress {
        public final String status;
        public final int parsed, total;
        public final double pct;
        public final boolean done;
        ParseProgress(String s, int p, int t, double pct, boolean d) {
            status = s; parsed = p; total = t; this.pct = pct; this.done = d;
        }
    }

    public ZdoFlatStore parse(File dbFile) throws Exception {
        long t0 = System.currentTimeMillis();
        statusMsg.set("Opening save file...");

        ZdoFlatStore store = new ZdoFlatStore(1_100_000);
        store.initHeatmaps(500);
        // Order matters: the verified dictionary claims its hashes first, so the
        // hand-maintained table below can only fill gaps, never overwrite.
        registerDictionaryNames(store, dbFile.getParentFile());
        registerKnownNames(store);
        // Stamp the snapshot with the dictionary that named it — deltas group by prefab_name.
        if (analyticsCache != null) {
            analyticsCache.setPrefabDictionaryInfo(store.dictionaryGameVersion, store.dictionaryEntries);
        }

        statusMsg.set("Reading " + dbFile.length() / 1048576 + "MB save file...");
        long readStart = System.currentTimeMillis();
        byte[] data = Files.readAllBytes(dbFile.toPath());
        log.info("File read into memory: {}ms ({} MB)", System.currentTimeMillis() - readStart,
            data.length / 1048576);

        {
            ByteBuffer buf = ByteBuffer.wrap(data);
            buf.order(ByteOrder.LITTLE_ENDIAN);

            // --- Header ---
            int worldVersion = buf.getInt();
            store.worldVersion = worldVersion;
            store.netTimeSeconds = buf.getDouble();
            buf.getLong();   // myId
            buf.getInt();    // nextUid (uint32)

            int count = buf.getInt();
            totalZdos.set(count);
            statusMsg.set("Parsing " + String.format("%,d", count) + " world objects...");
            log.info("World version={}, ZDOs={}", worldVersion, count);

            if (analyticsCache != null) {
                statusMsg.set("Initializing analytics cache...");
                analyticsCache.beginSnapshot(dbFile, worldVersion, store.netTimeSeconds);
            }

            // --- ZDO loop ---
            for (int i = 0; i < count; i++) {
                if (i == 1_000 || i == 10_000 || i == 100_000 || (i % 500_000 == 0 && i > 0)) {
                    long elapsed = System.currentTimeMillis() - t0;
                    long rate = elapsed > 0 ? i * 1000L / elapsed : 0;
                    log.info("Parsing {}/{} ZDOs ({}%) — {}/sec",
                        i, count, (int)((double)i/count*100), rate);
                    statusMsg.set(String.format("Parsing %,d / %,d ZDOs (%.0f%%)...",
                        i, count, (double)i/count*100));
                }
                zdosParsed.set(i);
                parseZdo(buf, worldVersion, store, t0, i);
            }
        }

        // Portal builder counts
        statusMsg.set("Finalizing...");
        for (int idx : store.portalIndices) {
            long cid = store.creatorId[idx];
            if (cid != 0) {
                PlayerRecord pr = store.players.get(cid);
                if (pr != null) pr.portalCount++;
            }
        }

        store.parseDurationMs = System.currentTimeMillis() - t0;
        zdosParsed.set(totalZdos.get());
        statusMsg.set("Ready");
        done = true;
        log.info("Parsed {} ZDOs in {}ms. Store: {} entries, {} buildings, {} dropped",
            totalZdos.get(), store.parseDurationMs, store.size(),
            store.buildingCount,
            store.droppedItemCounts.values().stream().mapToInt(Integer::intValue).sum());
        logPrefabCoverage(store);
        return store;
    }

    /**
     * Report how many ZDOs got a real prefab name. Makes the dictionary's contribution
     * measurable rather than asserted, and prints the worklist for the next refresh.
     */
    private static void logPrefabCoverage(ZdoFlatStore store) {
        log.info("Prefab name coverage: {} / {} ZDOs resolved ({}%) — {} unresolved across {} distinct hashes",
            String.format("%,d", store.resolvedZdoCount),
            String.format("%,d", store.zdosSeen()),
            String.format("%.1f", store.resolvedPct()),
            String.format("%,d", store.unresolvedZdoCount),
            String.format("%,d", store.unknownHashCounts.size()));

        if (store.dictionarySource != null) {
            log.info("  Dictionary: {} entries, game {}, {} — {} of them construction pieces",
                store.dictionaryEntries, store.dictionaryGameVersion, store.dictionarySource,
                store.buildPieceHashes.size());
        } else {
            log.info("  Dictionary: not loaded — hardcoded names only");
        }

        StringBuilder cats = new StringBuilder();
        for (byte c = 0; c < store.categoryCounts.length; c++) {
            if (store.categoryCounts[c] == 0) continue;
            if (cats.length() > 0) cats.append(", ");
            cats.append(Categories.name(c)).append('=').append(String.format("%,d", store.categoryCounts[c]));
        }
        log.info("Category census: {}", cats);

        List<Map.Entry<Integer, Integer>> top = store.topUnresolvedHashes(10);
        if (!top.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            for (Map.Entry<Integer, Integer> e : top) {
                if (sb.length() > 0) sb.append(", ");
                sb.append("hash:").append(e.getKey()).append(" (")
                  .append(String.format("%,d", e.getValue())).append(")");
            }
            log.info("  Top unresolved: {}", sb);
        }
    }

    // ----- Pre-register all known prefab hashes so nameForHash returns real names -----

    /** Load the verified dictionary and claim its hashes before anything hand-written runs. */
    private static void registerDictionaryNames(ZdoFlatStore store, File saveFileDir) {
        PrefabDictionary dict = PrefabDictionary.load(saveFileDir);
        for (PrefabDictionary.Entry e : dict.entries()) {
            store.registerHashName(e.hash, e.name);
        }
        store.buildPieceHashes      = dict.buildPieceHashes();
        store.dictionaryEntries     = dict.size();
        store.dictionaryGameVersion = dict.gameVersion();
        store.dictionaryGeneratedAt = dict.generatedAt();
        store.dictionarySource      = dict.sourceDescription();
    }

    /**
     * Register a hand-maintained name, reporting rather than silently losing a disagreement.
     *
     * <p>The dictionary has already claimed its hashes, so a false return means this hand entry
     * contradicts a name whose {@code sh(name) == hash} was verified at load. Historically eight
     * of these were wrong; a probe measured the "confirming" property on as few as 1 of 79,881
     * ZDOs. The WARN keeps that class of drift visible instead of letting it accumulate.
     */
    private static void reg(ZdoFlatStore store, int hash, String name) {
        if (!store.registerHashName(hash, name)) {
            String existing = store.rawNameForHash(hash);
            if (!name.equals(existing)) {
                log.warn("Hand-registered name for hash {} is '{}' but the verified dictionary "
                    + "says '{}' — ignoring the hand entry", hash, name, existing);
            }
        }
    }

    private static void registerKnownNames(ZdoFlatStore store) {
        // Portals / beds / signs / tombstones
        reg(store, HASH_PORTAL_WOOD, "portal_wood");
        reg(store, HASH_BED,         "bed");
        reg(store, HASH_BED02,       "piece_bed02");
        reg(store, HASH_SIGN1,       "sign");
        reg(store, HASH_SIGN2,       "sign_notext");
        reg(store, HASH_TOMBSTONE,   "Player_tombstone");

        // Item stands
        reg(store, sh("itemstand"),  "itemstand");
        reg(store, sh("itemstandh"), "itemstandh");

        // Containers (chests)
        reg(store, sh("piece_chest_wood"),       "piece_chest_wood");
        reg(store, sh("piece_chest"),            "piece_chest");
        reg(store, sh("piece_chest_blackmetal"), "piece_chest_blackmetal");
        reg(store, sh("piece_chest_private"),    "piece_chest_private");

        // Ships (their ZDOs carry the "items" property = container category)
        reg(store, sh("VikingShip"), "VikingShip");
        reg(store, sh("Karve"),      "Karve");
        reg(store, sh("Raft"),       "Raft");
        reg(store, sh("Cart"),       "Cart");

        // Creatures
        for (String name : KNOWN_CREATURES) {
            reg(store, sh(name), name);
        }

        // Dungeon / boss-site entrances.
        // These are ZoneSystem *location* prefabs — a separate namespace from ZNetScene, so the
        // dictionary does not contain them and this block remains the only source for them.
        for (String name : KNOWN_ENTRANCES) {
            reg(store, sh(name), name);
        }

        // NOTE: the former "dungeon interiors / crypt components" block was removed. Its ~20
        // entries were hand-applied display labels, and the dictionary supplies the real prefab
        // names for the same hashes — several of which the labels got wrong, e.g.
        // -1471593253 was labelled "Vegvisir (Boss Stone)" but is Pickable_Stone (the 3rd most
        // common prefab in the world), and 1620622954 was labelled "Crypt Decoration" but is
        // Spawner_Draugr. See docs/comfy-integration/PREFAB_DICTIONARY.md.
    }

    // ----- Direct ZDO parser -----

    private void parseZdo(ByteBuffer buf, int worldVersion, ZdoFlatStore store, long t0, int zdoIndex) throws Exception {
        int flags = Short.toUnsignedInt(buf.getShort());

        // Skip sector (2×int16)
        buf.getShort(); buf.getShort();

        // Read position
        float x = buf.getFloat();
        float y = buf.getFloat();
        float z = buf.getFloat();

        // Read prefab hash
        int hash = buf.getInt();
        store.noteHashSeen(hash);

        // Probe bookkeeping: count EVERY ZDO of a probed hash, including the ones that
        // return early below with no properties at all — an empty property set is a result.
        ProbeStats probe = probeResults.isEmpty() ? null : probeResults.get(hash);
        if (probe != null) probe.count++;
        Map<String, String> probeProps = (probe != null) ? new LinkedHashMap<>() : null;

        // Rotation: 12 bytes (Vector3 euler) when the flag is set. Decoded only for the
        // geometry export lane; otherwise skipped exactly as before.
        curHasRot = (flags & FLAG_ROTATION) != 0;
        if (curHasRot) {
            if (geometryExporter != null) {
                curRotX = buf.getFloat();
                curRotY = buf.getFloat();
                curRotZ = buf.getFloat();
            } else {
                buf.position(buf.position() + 12);
            }
        } else {
            curRotX = curRotY = curRotZ = 0f;
        }

        boolean validPos = Math.abs(x) < 100_000f && Math.abs(z) < 100_000f;
        boolean cacheEnabled = analyticsCache != null;
        boolean cacheFields = cacheEnabled && analyticsCache.capturesFields();
        // A probe run has to read the full property block for every ZDO, so the
        // hash fast-paths below (which skip properties wholesale) must be disabled.
        boolean fullRead = cacheFields || probe != null;
        boolean isEntrance = ENTRANCE_HASHES.contains(hash);

        // Dungeon / boss-site entrance — check BEFORE property-flag early return
        // because some entrance ZDOs (Crypt*, FrostCaves) have no property flags
        if (isEntrance && (!fullRead || (flags & 0xFF) == 0)) {
            if ((flags & 0xFF) != 0) skipProperties(buf, flags, worldVersion);
            store.structureIndices.add(
                store.add(hash, x, y, z, Categories.STRUCTURE, 0L, 0L, null, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            recordCacheZdo(zdoIndex, store, hash, Categories.STRUCTURE, x, y, z, 0L, 0L, 0L, flags);
            return;
        }

        // Valheim places all dungeon interiors at high elevations (Y > 3000)
        // Store them so they can be queried, but DON'T return early so other categories
        // or heatmaps can still process them if necessary.
        if (y > 3000f) {
            store.interiorIndices.add(
                store.add(hash, x, y, z, Categories.INTERIOR, 0L, 0L, null, null, 0, 0)
            );
        }

        // No property flags → pure positional ZDO (very lightweight nature object), unless the
        // prefab itself is construction. A piece with no properties at all is what a scripted
        // placer leaves behind; nothing about it is nature.
        if ((flags & 0xFF) == 0) {
            if (validPos) store.allHeatmap.increment(x, z);
            if (store.buildPieceHashes.contains(hash)) {
                store.buildingCount++;
                if (validPos) store.buildingHeatmap.increment(x, z);
                recordCacheZdo(zdoIndex, store, hash, Categories.BUILDING, x, y, z, 0L, 0L, 0L, flags);
                return;
            }
            byte cat = y > 3000f ? Categories.INTERIOR : Categories.NATURE;
            recordCacheZdo(zdoIndex, store, hash, cat, x, y, z, 0L, 0L, 0L, flags);
            return;
        }

        // ---- Fast-path checks based on prefab hash ----

        // Goblin bed: NPC
        if (!fullRead && hash == HASH_GOBLIN_BED) {
            skipProperties(buf, flags, worldVersion);
            if (validPos) store.allHeatmap.increment(x, z);
            recordCacheZdo(zdoIndex, store, hash, Categories.UNKNOWN, x, y, z, 0L, 0L, 0L, flags);
            return;
        }

        // Known creature
        if (!fullRead && CREATURE_HASHES.contains(hash)) {
            skipProperties(buf, flags, worldVersion);
            store.creatureIndices.add(
                store.add(hash, x, y, z, Categories.CREATURE, 0L, 0L, null, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            recordCacheZdo(zdoIndex, store, hash, Categories.CREATURE, x, y, z, 0L, 0L, 0L, flags);
            return;
        }

        // Ballista
        if (!fullRead && hash == HASH_BALLISTA) {
            skipProperties(buf, flags, worldVersion);
            store.add(hash, x, y, z, Categories.BALLISTA, 0L, 0L, null, null, 0, 0);
            if (validPos) store.allHeatmap.increment(x, z);
            recordCacheZdo(zdoIndex, store, hash, Categories.BALLISTA, x, y, z, 0L, 0L, 0L, flags);
            return;
        }

        // Known-hash categories that need specific properties
        boolean isPortal    = hash == HASH_PORTAL_WOOD;
        boolean isTombstone = hash == HASH_TOMBSTONE;
        boolean isBed       = BED_HASHES.contains(hash);
        boolean isSign      = SIGN_HASHES.contains(hash);
        boolean isContainer = CONTAINER_HASHES.contains(hash);
        boolean isItemStand = ITEM_STAND_HASHES.contains(hash);

        boolean knownHash = isPortal || isTombstone || isBed || isSign || isContainer || isItemStand;

        // ----- Read properties -----
        // We read all property groups in order, extracting what we need
        float  health = 0, support = 0;
        int    stack  = 0, quality = 0;
        long   creator = 0, owner = 0, spawntime = 0;
        String ownerName = null, tag = null, text = null, author = null,
               item = null, items = null, crafterName = null;
        boolean hasCreator = false, hasCrafterName = false, hasItems = false,
                hasItem = false, hasSpawntime = false, hasStack = false,
                hasHealth = false, hasSupport = false;

        // Connections
        if ((flags & FLAG_CONNECTIONS) != 0) {
            int connectionType = buf.get() & 0xFF;
            int connectionHash = buf.getInt();
            if (cacheEnabled) {
                analyticsCache.insertIntField(zdoIndex, "connection", 0, "connectionType", connectionType);
                analyticsCache.insertIntField(zdoIndex, "connection", connectionHash, "connectionHash", connectionHash);
            }
        }

        // Floats
        if ((flags & FLAG_FLOATS) != 0) {
            int n = readNumItems(buf, worldVersion);
            for (int j = 0; j < n; j++) {
                int h = buf.getInt();
                float v = buf.getFloat();
                if (cacheEnabled) analyticsCache.insertFloatField(zdoIndex, "float", h, fieldName(h), v);
                if (probeProps != null) probeNote(probeProps, h, Float.toString(v));
                if      (h == H_HEALTH)  { health = v;  hasHealth  = true; }
                else if (h == H_SUPPORT) { support = v; hasSupport = true; }
            }
        }

        // Vector3s (skip — we don't use any)
        if ((flags & FLAG_VECTOR3S) != 0) {
            int n = readNumItems(buf, worldVersion);
            if (!cacheEnabled) {
                buf.position(buf.position() + n * 16);  // 4 hash + 12 float3
            } else {
                for (int j = 0; j < n; j++) {
                    int h = buf.getInt();
                    float vx = buf.getFloat();
                    float vy = buf.getFloat();
                    float vz = buf.getFloat();
                    analyticsCache.insertVectorField(zdoIndex, "vec3", h, fieldName(h),
                        Float.toString(vx) + "," + Float.toString(vy) + "," + Float.toString(vz));
                }
            }
        }

        // Quaternions (skip)
        if ((flags & FLAG_QUATS) != 0) {
            int n = readNumItems(buf, worldVersion);
            if (!cacheEnabled) {
                buf.position(buf.position() + n * 20);  // 4 hash + 16 float4
            } else {
                for (int j = 0; j < n; j++) {
                    int h = buf.getInt();
                    float qx = buf.getFloat();
                    float qy = buf.getFloat();
                    float qz = buf.getFloat();
                    float qw = buf.getFloat();
                    analyticsCache.insertVectorField(zdoIndex, "quat", h, fieldName(h),
                        Float.toString(qx) + "," + Float.toString(qy) + "," +
                        Float.toString(qz) + "," + Float.toString(qw));
                }
            }
        }

        // Ints
        if ((flags & FLAG_INTS) != 0) {
            int n = readNumItems(buf, worldVersion);
            for (int j = 0; j < n; j++) {
                int h = buf.getInt();
                int v = buf.getInt();
                if (cacheEnabled) analyticsCache.insertIntField(zdoIndex, "int", h, fieldName(h), v);
                if (probeProps != null) probeNote(probeProps, h, Integer.toString(v));
                if      (h == H_STACK)   { stack   = v; hasStack   = true; }
                else if (h == H_QUALITY) quality = v;
            }
        }

        // Longs
        if ((flags & FLAG_LONGS) != 0) {
            int n = readNumItems(buf, worldVersion);
            for (int j = 0; j < n; j++) {
                int  h = buf.getInt();
                long v = buf.getLong();
                if (cacheEnabled) analyticsCache.insertLongField(zdoIndex, "long", h, fieldName(h), v);
                if (probeProps != null) probeNote(probeProps, h, Long.toString(v));
                if      (h == H_CREATOR)   { creator   = v; hasCreator   = true; }
                else if (h == H_OWNER)     { owner     = v; }
                else if (h == H_SPAWNTIME) { spawntime = v; hasSpawntime = true; }
            }
        }

        // Strings
        if ((flags & FLAG_STRINGS) != 0) {
            int n = readNumItems(buf, worldVersion);
            for (int j = 0; j < n; j++) {
                int    h = buf.getInt();
                String v = readString(buf);
                if (cacheEnabled) {
                    if (h == H_ITEMS) analyticsCache.insertBlobField(zdoIndex, "string", h, fieldName(h), v.length());
                    else analyticsCache.insertStringField(zdoIndex, "string", h, fieldName(h), v);
                }
                if (probeProps != null) {
                    // Empty strings are recorded as absent — a zero-length "text" is not a sign.
                    if (v != null && !v.isEmpty()) {
                        probeNote(probeProps, h, v.length() > 60 ? v.substring(0, 60) + "..." : v);
                    }
                }
                if      (h == H_OWNER_NAME)   { ownerName   = nullIfEmpty(v); }
                else if (h == H_TAG)          { tag         = nullIfEmpty(v); }
                else if (h == H_TEXT)         { text        = nullIfEmpty(v); }
                else if (h == H_AUTHOR)       { author      = nullIfEmpty(v); }
                else if (h == H_ITEM)         { item        = nullIfEmpty(v); hasItem  = true; }
                else if (h == H_ITEMS)        { items       = nullIfEmpty(v); hasItems = true; }
                else if (h == H_CRAFTER_NAME) { crafterName = nullIfEmpty(v); hasCrafterName = true; }
            }
        }

        // ByteArrays (skip — we don't use any)
        if ((flags & FLAG_BYTEARRAYS) != 0) {
            int n = readNumItems(buf, worldVersion);
            for (int j = 0; j < n; j++) {
                int h = buf.getInt();
                int len = buf.getInt();
                if (cacheEnabled) analyticsCache.insertBlobField(zdoIndex, "bytearray", h, fieldName(h), len);
                if (probeProps != null) probeNote(probeProps, h, "<" + len + " bytes>");
                buf.position(buf.position() + len);
            }
        }

        // Probe: fold this ZDO's property set into the per-hash presence histogram.
        if (probe != null) {
            for (String key : probeProps.keySet()) probe.fieldPresence.merge(key, 1L, Long::sum);
            if (probe.samples.size() < 3) probe.samples.add(probeProps.toString());
        }

        // ----- Classification -----

        if (isEntrance) {
            store.structureIndices.add(
                store.add(hash, x, y, z, Categories.STRUCTURE, spawntime, creator, null, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            recordCacheZdo(zdoIndex, store, hash, Categories.STRUCTURE, x, y, z, creator, owner, spawntime, flags);
            return;
        }

        if (CREATURE_HASHES.contains(hash)) {
            store.creatureIndices.add(
                store.add(hash, x, y, z, Categories.CREATURE, spawntime, creator, null, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            recordCacheZdo(zdoIndex, store, hash, Categories.CREATURE, x, y, z, creator, owner, spawntime, flags);
            return;
        }

        if (hash == HASH_BALLISTA) {
            store.add(hash, x, y, z, Categories.BALLISTA, spawntime, creator, null, null, 0, 0);
            if (validPos) store.allHeatmap.increment(x, z);
            recordCacheZdo(zdoIndex, store, hash, Categories.BALLISTA, x, y, z, creator, owner, spawntime, flags);
            return;
        }

        if (hash == HASH_GOBLIN_BED) {
            if (validPos) store.allHeatmap.increment(x, z);
            recordCacheZdo(zdoIndex, store, hash, Categories.UNKNOWN, x, y, z, creator, owner, spawntime, flags);
            return;
        }

        if (isTombstone) {
            store.tombstoneIndices.add(
                store.add(hash, x, y, z, Categories.TOMBSTONE,
                    spawntime, owner, ownerName, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            recordCacheZdo(zdoIndex, store, hash, Categories.TOMBSTONE, x, y, z, creator, owner, spawntime, flags);
            if (owner != 0) {
                final String capturedName = ownerName;
                PlayerRecord pr = store.players.computeIfAbsent(owner,
                    id -> new PlayerRecord(id, capturedName, "TOMBSTONE"));
                if (capturedName != null && (pr.displayName == null || pr.displayName.isEmpty()))
                    pr.displayName = capturedName;
                pr.deathCount++;
            }
            return;
        }

        if (isPortal) {
            store.portalIndices.add(
                store.add(hash, x, y, z, Categories.PORTAL,
                    spawntime, creator, tag, author, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            recordCacheZdo(zdoIndex, store, hash, Categories.PORTAL, x, y, z, creator, owner, spawntime, flags);
            return;
        }

        if (isBed) {
            store.bedIndices.add(
                store.add(hash, x, y, z, Categories.BED,
                    spawntime, owner, ownerName, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            recordCacheZdo(zdoIndex, store, hash, Categories.BED, x, y, z, creator, owner, spawntime, flags);
            if (owner != 0) {
                final String capturedName2 = ownerName;
                store.players.computeIfAbsent(owner,
                    id -> new PlayerRecord(id, capturedName2, "BED_OWNER"))
                    .bedCount++;
            }
            return;
        }

        // Signs were the only category with no content-based fallback, so dropping a hash from
        // SIGN_HASHES would have lost real signs. Match on content instead: the component atlas
        // (valheim-component-atlas.json, ZdoKeyIndex) records Sign.SetText as the only writer of
        // "text" and Sign.UpdateText as the only writer of "author" — nothing else in the game
        // writes either key. This also picks up hanging signs, Hildir boards and modded signs.
        if (isSign || text != null || author != null) {
            store.signIndices.add(
                store.add(hash, x, y, z, Categories.SIGN,
                    spawntime, creator, text, author, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            recordCacheZdo(zdoIndex, store, hash, Categories.SIGN, x, y, z, creator, owner, spawntime, flags);
            return;
        }

        if (isContainer || hasItems) {
            store.containerIndices.add(
                store.add(hash, x, y, z, Categories.CONTAINER,
                    spawntime, creator, null, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            if (items != null) {
                try {
                    int containerIdx = store.size() - 1;
                    parseInventoryIntoTotals(items, store.chestItemTotals, store,
                        containerIdx, zdoIndex, x, y, z, analyticsCache);
                }
                catch (Exception ignored) {}
            }
            recordCacheZdo(zdoIndex, store, hash, Categories.CONTAINER, x, y, z, creator, owner, spawntime, flags);
            return;
        }

        if (isItemStand || (hasItem && hasCreator)) {
            store.itemStandIndices.add(
                store.add(hash, x, y, z, Categories.ITEM_STAND,
                    spawntime, creator, item, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            // Register dropped-item hash for name resolution (prefab name == item name)
            if (item != null) store.registerHashName(sh(item), item);
            recordCacheZdo(zdoIndex, store, hash, Categories.ITEM_STAND, x, y, z, creator, owner, spawntime, flags);
            return;
        }

        // Dropped item
        if (hasCrafterName && hasSpawntime && hasStack) {
            store.droppedItemCounts.merge(hash, 1, Integer::sum);
            if (validPos) {
                store.allHeatmap.increment(x, z);
                store.droppedItemHeatmap.increment(x, z);
            }
            recordCacheZdo(zdoIndex, store, hash, Categories.DROPPED_ITEM, x, y, z, creator, owner, spawntime, flags);
            return;
        }

        // Building piece. Two independent sufficient signals:
        //
        //  1. the property shape a player-placed piece leaves behind (creator + health/support);
        //  2. prefab identity — the verified dictionary says this prefab is a construction piece.
        //
        // (2) was added because a piece that carries neither creator nor health is still a piece.
        // On ComfyEra16, 895,488 of the 4,720,394 UNKNOWN ZDOs are dictionary-confirmed
        // construction with no creator field — world-generated blackmarble_*, stone_wall_2x1,
        // woodwall, wood_floor, wood_beam_* — and the synthetic-history corpus places wood_floor
        // with no properties beyond a string, which is what surfaced the gap.
        //
        // Order matters: chests, beds, signs, portals and item stands are all pieces too, and
        // every one of those branches has already returned above.
        if ((hasCreator && (hasSupport || hasHealth)) || store.buildPieceHashes.contains(hash)) {
            store.buildingCount++;
            if (validPos) {
                store.allHeatmap.increment(x, z);
                store.buildingHeatmap.increment(x, z);
            }
            if (creator != 0) {
                PlayerRecord pr = store.players.get(creator);
                if (pr != null) pr.buildCount++;
            }
            recordCacheZdo(zdoIndex, store, hash, Categories.BUILDING, x, y, z, creator, owner, spawntime, flags);
            return;
        }

        // Nature / unclassified
        if (validPos) store.allHeatmap.increment(x, z);
        byte fallbackCategory = y > 3000f ? Categories.INTERIOR : Categories.UNKNOWN;
        recordCacheZdo(zdoIndex, store, hash, fallbackCategory, x, y, z, creator, owner, spawntime, flags);
    }

    private void recordCacheZdo(int zdoIndex, ZdoFlatStore store, int hash, byte category,
            float x, float y, float z, long creator, long owner, long spawntime, int flags) throws Exception {
        // Census first: every classification path funnels through here, and the count must not
        // depend on whether the analytics cache happens to be enabled.
        if (category >= 0 && category < store.categoryCounts.length) store.categoryCounts[category]++;
        if (geometryExporter != null && geometryExporter.wants(category)) {
            geometryExporter.accept(zdoIndex, hash, store.nameForHash(hash), category,
                x, y, z, curHasRot, curRotX, curRotY, curRotZ, creator, flags);
        }
        if (analyticsCache == null) return;
        analyticsCache.insertZdo(zdoIndex, hash, store.nameForHash(hash), category,
            x, y, z, creator, owner, spawntime, flags);
    }

    // ----- Skip all remaining properties (fast path for nature ZDOs) -----
    private void skipProperties(ByteBuffer buf, int flags, int worldVersion) {
        if ((flags & 0xFF) == 0) return;

        if ((flags & FLAG_CONNECTIONS) != 0) buf.position(buf.position() + 5);

        if ((flags & FLAG_FLOATS) != 0) {
            int n = readNumItems(buf, worldVersion);
            buf.position(buf.position() + n * 8);
        }
        if ((flags & FLAG_VECTOR3S) != 0) {
            int n = readNumItems(buf, worldVersion);
            buf.position(buf.position() + n * 16);
        }
        if ((flags & FLAG_QUATS) != 0) {
            int n = readNumItems(buf, worldVersion);
            buf.position(buf.position() + n * 20);
        }
        if ((flags & FLAG_INTS) != 0) {
            int n = readNumItems(buf, worldVersion);
            buf.position(buf.position() + n * 8);
        }
        if ((flags & FLAG_LONGS) != 0) {
            int n = readNumItems(buf, worldVersion);
            buf.position(buf.position() + n * 12);
        }
        if ((flags & FLAG_STRINGS) != 0) {
            int n = readNumItems(buf, worldVersion);
            for (int j = 0; j < n; j++) {
                buf.position(buf.position() + 4); // skip hash
                int len = readStringLen(buf);
                buf.position(buf.position() + len);
            }
        }
        if ((flags & FLAG_BYTEARRAYS) != 0) {
            int n = readNumItems(buf, worldVersion);
            for (int j = 0; j < n; j++) {
                buf.position(buf.position() + 4);
                int len = buf.getInt();
                buf.position(buf.position() + len);
            }
        }
    }

    // ----- Low-level binary read helpers -----

    /** Valheim numItems encoding: 1 byte for <128, 2 bytes for >=128 (worldVersion>=33) */
    private static int readNumItems(ByteBuffer buf, int worldVersion) {
        if (worldVersion < 33) {
            // readChar() — full UTF-8 code point
            int first = buf.get() & 0xFF;
            if (first < 0x80) return first;
            if (first < 0xE0) return ((first & 0x1F) << 6) | (buf.get() & 0x3F);
            if (first < 0xF0) return ((first & 0x0F) << 12) | ((buf.get() & 0x3F) << 6) | (buf.get() & 0x3F);
            return ((first & 0x07) << 18) | ((buf.get() & 0x3F) << 12) | ((buf.get() & 0x3F) << 6) | (buf.get() & 0x3F);
        }
        int num = buf.get() & 0xFF;
        if ((num & 128) != 0) {
            num = ((num & 127) << 8) | (buf.get() & 0xFF);
        }
        return num;
    }

    /** Read string length — little-endian 7-bit varint (LSB group first) */
    private static int readStringLen(ByteBuffer buf) {
        int result = 0, shift = 0;
        byte b;
        do {
            b = buf.get();
            result |= (b & 0x7F) << shift;
            shift += 7;
        } while (b < 0);
        return result;
    }

    /** Read a length-prefixed UTF-8 string */
    private static String readString(ByteBuffer buf) {
        int len = readStringLen(buf);
        if (len == 0) return "";
        byte[] bytes = new byte[len];
        buf.get(bytes);
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private static String nullIfEmpty(String s) {
        return (s == null || s.isEmpty()) ? null : s;
    }

    /** Valheim StableHashCode */
    public static int sh(String s) {
        int h1 = 5381, h2 = h1;
        for (int i = 0; i < s.length(); i += 2) {
            h1 = ((h1 << 5) + h1) ^ s.charAt(i);
            if (i + 1 < s.length()) h2 = ((h2 << 5) + h2) ^ s.charAt(i + 1);
        }
        return h1 + h2 * 1566083941;
    }

    public static int stableHash(String s) { return sh(s); }

    private static String fieldName(int hash) {
        if (hash == H_CREATOR) return "creator";
        if (hash == H_OWNER) return "owner";
        if (hash == H_SPAWNTIME) return "spawntime";
        if (hash == H_HEALTH) return "health";
        if (hash == H_SUPPORT) return "support";
        if (hash == H_STACK) return "stack";
        if (hash == H_QUALITY) return "quality";
        if (hash == H_OWNER_NAME) return "ownerName";
        if (hash == H_TEXT) return "text";
        if (hash == H_AUTHOR) return "author";
        if (hash == H_TAG) return "tag";
        if (hash == H_ITEM) return "item";
        if (hash == H_ITEMS) return "items";
        if (hash == H_CRAFTER_NAME) return "crafterName";
        return null;
    }

    // ----- Inventory parsing -----

    private static void parseInventoryIntoTotals(String base64, Map<String, Long> totals,
            ZdoFlatStore store, int containerIdx, int cacheZdoIndex, float cx, float cy, float cz,
            AnalyticsCache analyticsCache) throws Exception {
        byte[] raw = Base64.getDecoder().decode(base64);
        java.io.DataInputStream in = new java.io.DataInputStream(
            new ByteArrayInputStream(raw));
        int version   = readInt32LE(in);
        int itemCount = readInt32LE(in);
        if (version > 106) return; // genuinely unknown format
        if (itemCount < 0 || itemCount > 1000) return;

        long containerCoinTotal = 0;

        for (int j = 0; j < itemCount; j++) {
            String name = readInvString(in);
            int    stk  = readInt32LE(in);
            float durability = readFloat(in);
            readInt32LE(in); readInt32LE(in); // slot pos
            in.read();                        // equipped

            // PA4: capture quality + crafterName + customData keys for forensics
            int    qual         = (version >= 101) ? readInt32LE(in) : 0;
            int    variant      = (version >= 102) ? readInt32LE(in) : 0;
            long   crafterId    = 0;
            String crafterName  = null;
            if (version >= 103) {
                crafterId   = readInt64LE(in);
                crafterName = readInvString(in);
            }
            boolean hasEngravingsQuality = false;
            StringBuilder customJson = null;
            if (version >= 104) {
                int mc = readInt32LE(in);
                if (mc < 0 || mc > 200) return; // safety cap - abnormal = misaligned
                if (mc > 0) customJson = new StringBuilder("{");
                for (int k = 0; k < mc; k++) {
                    String key = readInvString(in);
                    String val = readInvString(in);
                    if (customJson != null) {
                        if (k > 0) customJson.append(',');
                        appendJsonPair(customJson, key, val);
                    }
                    if ("engravings.quality".equals(key)) hasEngravingsQuality = true;
                }
                if (customJson != null) customJson.append('}');
            }
            if (version >= 106) {
                readInt32LE(in);    // worldLevel
                in.read();          // pickedUp
            } else if (version >= 105) {
                in.read();          // pickedUp only
            }

            if (name == null || name.isEmpty()) continue;

            // Existing: register name + accumulate totals
            store.registerHashName(sh(name), name);
            if (stk > 0) totals.merge(name, (long) stk, Long::sum);
            if (analyticsCache != null) {
                analyticsCache.insertContainerItem(cacheZdoIndex, name, stk, durability, qual, variant,
                    crafterId, crafterName, customJson == null ? null : customJson.toString(), cx, cy, cz);
            }

            // PA4/PA5 forensics tracking
            if ("Coins".equals(name) && stk > 0) containerCoinTotal += stk;

            // Quality overflow (DeerStew-style int field corruption / overflow)
            if (qual > 1_000_000) {
                store.qualityOverflowCount++;
                if (store.qualityOverflowSamples.size() < 20) {
                    store.qualityOverflowSamples.add(name + " q=" + qual
                        + " by " + (crafterName == null ? "" : crafterName));
                }
            }

            // Engravings tracked (mod-issued, quality field repurposed)
            if (hasEngravingsQuality) store.engravingsTrackedCount++;

            // Server-issued items (HTML-tagged crafter)
            if (crafterName != null && (crafterName.indexOf('<') >= 0 || crafterName.indexOf('>') >= 0)) {
                store.serverIssuedItemCount++;
                Map<String, Integer> cat = store.serverIssuerCatalog.computeIfAbsent(crafterName, k -> new LinkedHashMap<>());
                cat.merge(name, 1, Integer::sum);
            }
        }

        // Per-container coin total — track top 100 caches
        if (containerCoinTotal > 0) {
            store.topCoinCaches.add(new ZdoFlatStore.CoinCache(
                containerIdx, cx, cy, cz, containerCoinTotal));
            // Periodically trim to top 100 to bound memory
            if (store.topCoinCaches.size() > 200) {
                store.topCoinCaches.sort((a, b) -> Long.compare(b.coins, a.coins));
                while (store.topCoinCaches.size() > 100) {
                    store.topCoinCaches.remove(store.topCoinCaches.size() - 1);
                }
            }
        }
    }

    private static void appendJsonPair(StringBuilder sb, String key, String value) {
        sb.append('"').append(jsonEscape(key)).append('"')
          .append(':')
          .append('"').append(jsonEscape(value)).append('"');
    }

    private static String jsonEscape(String value) {
        if (value == null) return "";
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.toString();
    }

    private static int readInt32LE(java.io.DataInputStream in) throws java.io.IOException {
        int b0 = in.read(), b1 = in.read(), b2 = in.read(), b3 = in.read();
        return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    }
    private static long readInt64LE(java.io.DataInputStream in) throws java.io.IOException {
        return (readInt32LE(in) & 0xFFFFFFFFL) | ((readInt32LE(in) & 0xFFFFFFFFL) << 32);
    }
    private static float readFloat(java.io.DataInputStream in) throws java.io.IOException {
        return Float.intBitsToFloat(readInt32LE(in));
    }
    private static String readInvString(java.io.DataInputStream in) throws java.io.IOException {
        int len = 0, shift = 0, b;
        do {
            b = in.read();
            if (b < 0) return "";
            len |= (b & 0x7F) << shift;
            shift += 7;
        } while ((b & 0x80) != 0);
        if (len <= 0) return "";
        if (len > 32767) throw new java.io.IOException("inv string length overflow: " + len);
        byte[] bytes = new byte[len];
        int read = 0;
        while (read < len) {
            int r = in.read(bytes, read, len - read);
            if (r < 0) break;
            read += r;
        }
        return new String(bytes, 0, read, StandardCharsets.UTF_8);
    }
}
