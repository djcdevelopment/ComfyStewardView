package com.valheim.viewer.parser;

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
    private static final int HASH_SIGN3        = 686545676;
    private static final int HASH_BALLISTA     = -1195767551;

    private static final Set<Integer> ITEM_STAND_HASHES = new HashSet<>(Arrays.asList(
        sh("itemstand"), 1411875912, 650075310, -1161852777
    ));
    private static final Set<Integer> CONTAINER_HASHES = new HashSet<>(Arrays.asList(
        sh("piece_chest_wood"), sh("piece_chest"), sh("piece_chest_blackmetal"),
        sh("piece_chest_private"), sh("piece_chest_cart"), -494364525
    ));
    private static final Set<Integer> BED_HASHES = new HashSet<>(Arrays.asList(HASH_BED, HASH_BED02));
    private static final Set<Integer> SIGN_HASHES = new HashSet<>(Arrays.asList(HASH_SIGN1, HASH_SIGN2, HASH_SIGN3));

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
        registerKnownNames(store);

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
                parseZdo(buf, worldVersion, store, t0);
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
        return store;
    }

    // ----- Pre-register all known prefab hashes so nameForHash returns real names -----

    private static void registerKnownNames(ZdoFlatStore store) {
        // Portals / beds / signs / tombstones
        store.registerHashName(HASH_PORTAL_WOOD, "portal_wood");
        store.registerHashName(HASH_BED,         "bed");
        store.registerHashName(HASH_BED02,       "piece_bed02");
        store.registerHashName(HASH_SIGN1,       "sign");
        store.registerHashName(HASH_SIGN2,       "sign_notext");
        store.registerHashName(HASH_SIGN3,       "sign_hmHildir");   // Hildir sign
        store.registerHashName(HASH_BALLISTA,    "turret");           // Dvergr ballista
        store.registerHashName(HASH_TOMBSTONE,   "Player_tombstone");

        // Item stands
        store.registerHashName(sh("itemstand"),       "itemstand");
        store.registerHashName(1411875912,             "itemstandh");      // horizontal stand
        store.registerHashName(650075310,              "itemstand_rooster");
        store.registerHashName(-1161852777,            "ArmorStand");

        // Containers (chests)
        store.registerHashName(sh("piece_chest_wood"),        "piece_chest_wood");
        store.registerHashName(sh("piece_chest"),             "piece_chest");
        store.registerHashName(sh("piece_chest_blackmetal"),  "piece_chest_blackmetal");
        store.registerHashName(sh("piece_chest_private"),     "piece_chest_private");
        store.registerHashName(sh("piece_chest_cart"),        "piece_chest_cart");

        // Ships (their ZDOs carry the "items" property = container category)
        store.registerHashName(sh("VikingShip"), "VikingShip");
        store.registerHashName(sh("Karve"),      "Karve");
        store.registerHashName(sh("Raft"),       "Raft");
        store.registerHashName(sh("Longship"),   "Longship");
        store.registerHashName(sh("Cart"),       "Cart");

        // Creatures
        for (String name : KNOWN_CREATURES) {
            store.registerHashName(sh(name), name);
        }

        // Dungeon / boss-site entrances
        for (String name : KNOWN_ENTRANCES) {
            store.registerHashName(sh(name), name);
        }

        // Dungeon interiors / crypt components
        store.registerHashName((int)3800928356L, "Burial Crypt Chest");
        store.registerHashName((int)4104329089L, "Crypt Chest");
        store.registerHashName((int)4252449299L, "Muddy Scrap Pile");
        store.registerHashName((int)1756993846L, "Muddy Scrap Pile");
        store.registerHashName((int)3848155824L, "Crypt Exit");
        store.registerHashName((int)3955100387L, "Crypt Gate");
        store.registerHashName((int)849594011L,  "Crypt Loot");
        store.registerHashName((int)2275296700L, "Iron Gate");
        store.registerHashName((int)2952831755L, "Yellow Mushroom");
        store.registerHashName((int)1520650186L, "Mushroom");
        store.registerHashName((int)2823374043L, "Vegvisir (Boss Stone)");
        store.registerHashName(2034747966,       "Barrel");
        store.registerHashName(757858766,        "Burial Crypt Item");
        store.registerHashName(1577361568,       "Burial Crypt Item");
        store.registerHashName(449644523,        "Skeletal Remains");
        store.registerHashName(449644525,        "Skeletal Remains");
        store.registerHashName((int)4036512582L, "Crypt Decoration");
        store.registerHashName((int)1620622954L, "Crypt Decoration");
        store.registerHashName(951398868,        "Crypt Decoration");
    }

    // ----- Direct ZDO parser -----

    private void parseZdo(ByteBuffer buf, int worldVersion, ZdoFlatStore store, long t0) {
        int flags = Short.toUnsignedInt(buf.getShort());

        // Skip sector (2×int16)
        buf.getShort(); buf.getShort();

        // Read position
        float x = buf.getFloat();
        float y = buf.getFloat();
        float z = buf.getFloat();

        // Read prefab hash
        int hash = buf.getInt();

        // Skip rotation if present
        if ((flags & FLAG_ROTATION) != 0) {
            buf.position(buf.position() + 12);
        }

        boolean validPos = Math.abs(x) < 100_000f && Math.abs(z) < 100_000f;

        // Dungeon / boss-site entrance — check BEFORE property-flag early return
        // because some entrance ZDOs (Crypt*, FrostCaves) have no property flags
        if (ENTRANCE_HASHES.contains(hash)) {
            if ((flags & 0xFF) != 0) skipProperties(buf, flags, worldVersion);
            store.structureIndices.add(
                store.add(hash, x, y, z, Categories.STRUCTURE, 0L, 0L, null, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
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

        // No property flags → pure positional ZDO (very lightweight nature object)
        if ((flags & 0xFF) == 0) {
            if (validPos) store.allHeatmap.increment(x, z);
            return;
        }

        // ---- Fast-path checks based on prefab hash ----

        // Goblin bed: NPC
        if (hash == HASH_GOBLIN_BED) {
            skipProperties(buf, flags, worldVersion);
            if (validPos) store.allHeatmap.increment(x, z);
            return;
        }

        // Known creature
        if (CREATURE_HASHES.contains(hash)) {
            skipProperties(buf, flags, worldVersion);
            store.creatureIndices.add(
                store.add(hash, x, y, z, Categories.CREATURE, 0L, 0L, null, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            return;
        }

        // Ballista
        if (hash == HASH_BALLISTA) {
            skipProperties(buf, flags, worldVersion);
            store.add(hash, x, y, z, Categories.BALLISTA, 0L, 0L, null, null, 0, 0);
            if (validPos) store.allHeatmap.increment(x, z);
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
            buf.get();       // connectionType
            buf.getInt();    // connectionHash
        }

        // Floats
        if ((flags & FLAG_FLOATS) != 0) {
            int n = readNumItems(buf, worldVersion);
            for (int j = 0; j < n; j++) {
                int h = buf.getInt();
                float v = buf.getFloat();
                if      (h == H_HEALTH)  { health = v;  hasHealth  = true; }
                else if (h == H_SUPPORT) { support = v; hasSupport = true; }
            }
        }

        // Vector3s (skip — we don't use any)
        if ((flags & FLAG_VECTOR3S) != 0) {
            int n = readNumItems(buf, worldVersion);
            buf.position(buf.position() + n * 16);  // 4 hash + 12 float3
        }

        // Quaternions (skip)
        if ((flags & FLAG_QUATS) != 0) {
            int n = readNumItems(buf, worldVersion);
            buf.position(buf.position() + n * 20);  // 4 hash + 16 float4
        }

        // Ints
        if ((flags & FLAG_INTS) != 0) {
            int n = readNumItems(buf, worldVersion);
            for (int j = 0; j < n; j++) {
                int h = buf.getInt();
                int v = buf.getInt();
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
                buf.position(buf.position() + 4);  // skip hash
                int len = buf.getInt();
                buf.position(buf.position() + len);
            }
        }

        // ----- Classification -----

        if (isTombstone) {
            store.tombstoneIndices.add(
                store.add(hash, x, y, z, Categories.TOMBSTONE,
                    spawntime, owner, ownerName, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
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
            return;
        }

        if (isBed) {
            store.bedIndices.add(
                store.add(hash, x, y, z, Categories.BED,
                    spawntime, owner, ownerName, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            if (owner != 0) {
                final String capturedName2 = ownerName;
                store.players.computeIfAbsent(owner,
                    id -> new PlayerRecord(id, capturedName2, "BED_OWNER"))
                    .bedCount++;
            }
            return;
        }

        if (isSign) {
            store.signIndices.add(
                store.add(hash, x, y, z, Categories.SIGN,
                    spawntime, creator, text, author, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            return;
        }

        if (isContainer || hasItems) {
            store.containerIndices.add(
                store.add(hash, x, y, z, Categories.CONTAINER,
                    spawntime, creator, null, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            if (items != null) {
                try { parseInventoryIntoTotals(items, store.chestItemTotals, store); }
                catch (Exception ignored) {}
            }
            return;
        }

        if (isItemStand || (hasItem && hasCreator)) {
            store.itemStandIndices.add(
                store.add(hash, x, y, z, Categories.ITEM_STAND,
                    spawntime, creator, item, null, 0, 0));
            if (validPos) store.allHeatmap.increment(x, z);
            // Register dropped-item hash for name resolution (prefab name == item name)
            if (item != null) store.registerHashName(sh(item), item);
            return;
        }

        // Dropped item
        if (hasCrafterName && hasSpawntime && hasStack) {
            store.droppedItemCounts.merge(hash, 1, Integer::sum);
            if (validPos) {
                store.allHeatmap.increment(x, z);
                store.droppedItemHeatmap.increment(x, z);
            }
            return;
        }

        // Building piece
        if (hasCreator && (hasSupport || hasHealth)) {
            store.buildingCount++;
            if (validPos) {
                store.allHeatmap.increment(x, z);
                store.buildingHeatmap.increment(x, z);
            }
            if (creator != 0) {
                PlayerRecord pr = store.players.get(creator);
                if (pr != null) pr.buildCount++;
            }
            return;
        }

        // Nature / unclassified
        if (validPos) store.allHeatmap.increment(x, z);
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

    // ----- Inventory parsing -----

    private static void parseInventoryIntoTotals(String base64, Map<String, Long> totals,
            ZdoFlatStore store) throws Exception {
        byte[] raw = Base64.getDecoder().decode(base64);
        java.io.DataInputStream in = new java.io.DataInputStream(
            new ByteArrayInputStream(raw));
        int version   = readInt32LE(in);
        int itemCount = readInt32LE(in);
        if (version > 105) return; // unknown format — fields added in v106+ cause misalignment
        if (itemCount < 0 || itemCount > 1000) return;

        for (int j = 0; j < itemCount; j++) {
            String name = readInvString(in);
            int    stk  = readInt32LE(in);
            readFloat(in);
            readInt32LE(in); readInt32LE(in);
            in.read(); // equipped
            if (version >= 101) readInt32LE(in);
            if (version >= 102) readInt32LE(in);
            if (version >= 103) { readInt64LE(in); readInvString(in); }
            if (version >= 104) {
                int mc = readInt32LE(in);
                if (mc < 0 || mc > 200) return; // safety cap - abnormal = misaligned
                for (int k = 0; k < mc; k++) { readInvString(in); readInvString(in); }
            }
            if (version >= 105) in.read();
            if (name != null && !name.isEmpty()) {
                // Register hash→name for dropped item resolution (prefab name == item name)
                store.registerHashName(sh(name), name);
                if (stk > 0) totals.merge(name, (long) stk, Long::sum);
            }
        }
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
