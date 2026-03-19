package com.valheim.viewer.store;

import java.util.*;

/**
 * Compact parallel-array ZDO store.
 *
 * DESIGN: Only "interesting" ZDOs are stored here (portals, containers, signs,
 * beds, tombstones, item stands, creatures, ballistas, unknowns).
 * NATURE and pure BUILDING objects are NOT stored — they only contribute to
 * heatmaps which are built inline during parsing.
 *
 * This keeps the store at ~800k–1M entries vs 8M, making it ~8x smaller.
 */
public class ZdoFlatStore {

    // ----- Position & identity -----
    public int[]   prefabId;
    public float[] posX;
    public float[] posZ;
    public float[] posY;

    // ----- Category -----
    // Values defined in Categories inner class
    public byte[]  category;

    // ----- Time & creator -----
    public long[]  spawnTimeMicros;
    public long[]  creatorId;

    // ----- String labels -----
    //   label1: prefab name, ownerName, tag, sign text, item name (context-dependent)
    //   label2: author, crafterName, secondary string
    public String[] label1;
    public String[] label2;

    // ----- Numeric extras -----
    public int[]   stackOrCount;
    public int[]   quality;

    // ----- Size -----
    private int size;
    private int capacity;

    // ----- Heatmap grids (built inline during parse, then finalized) -----
    public HeatmapGrid buildingHeatmap;
    public HeatmapGrid droppedItemHeatmap;
    public HeatmapGrid allHeatmap;

    // ----- World metadata -----
    public double netTimeSeconds;
    public int    worldVersion;
    public long   parseDurationMs;

    // ----- Prefab hash → name -----
    private final Map<Integer, String> hashToName = new HashMap<>(2048);

    // ----- Player registry (built from beds + tombstones) -----
    public final Map<Long, PlayerRecord> players = new LinkedHashMap<>();

    // ----- Category index lists (store indices) -----
    public final List<Integer> portalIndices    = new ArrayList<>(10_000);
    public final List<Integer> containerIndices = new ArrayList<>(130_000);
    public final List<Integer> tombstoneIndices = new ArrayList<>(700);
    public final List<Integer> signIndices      = new ArrayList<>(225_000);
    public final List<Integer> bedIndices       = new ArrayList<>(2_000);
    public final List<Integer> itemStandIndices = new ArrayList<>(400_000);
    public final List<Integer> creatureIndices  = new ArrayList<>(55_000);
    public final List<Integer> structureIndices = new ArrayList<>(5_000);

    // ----- Aggregate stats (accumulated inline during parse) -----
    public final Map<Integer, Integer> droppedItemCounts = new LinkedHashMap<>();
    public final Map<String, Long>     chestItemTotals   = new LinkedHashMap<>();

    // Counter for building ZDOs (not stored in flat arrays)
    public int buildingCount;

    public ZdoFlatStore(int initialCapacity) {
        this.capacity = initialCapacity;
        allocate(initialCapacity);
    }

    private void allocate(int cap) {
        prefabId        = new int[cap];
        posX            = new float[cap];
        posZ            = new float[cap];
        posY            = new float[cap];
        category        = new byte[cap];
        spawnTimeMicros = new long[cap];
        creatorId       = new long[cap];
        label1          = new String[cap];
        label2          = new String[cap];
        stackOrCount    = new int[cap];
        quality         = new int[cap];
    }

    public int add(
            int hash, float x, float y, float z, byte cat,
            long spawnMicros, long creator,
            String lbl1, String lbl2,
            int stack, int qual) {

        if (size == capacity) grow();
        int i = size++;
        prefabId[i]        = hash;
        posX[i]            = x;
        posY[i]            = y;
        posZ[i]            = z;
        category[i]        = cat;
        spawnTimeMicros[i] = spawnMicros;
        creatorId[i]       = creator;
        label1[i]          = lbl1;
        label2[i]          = lbl2;
        stackOrCount[i]    = stack;
        quality[i]         = qual;
        return i;
    }

    private void grow() {
        int newCap = (int) (capacity * 1.5);
        prefabId        = Arrays.copyOf(prefabId,        newCap);
        posX            = Arrays.copyOf(posX,            newCap);
        posZ            = Arrays.copyOf(posZ,            newCap);
        posY            = Arrays.copyOf(posY,            newCap);
        category        = Arrays.copyOf(category,        newCap);
        spawnTimeMicros = Arrays.copyOf(spawnTimeMicros, newCap);
        creatorId       = Arrays.copyOf(creatorId,       newCap);
        label1          = Arrays.copyOf(label1,          newCap);
        label2          = Arrays.copyOf(label2,          newCap);
        stackOrCount    = Arrays.copyOf(stackOrCount,    newCap);
        quality         = Arrays.copyOf(quality,         newCap);
        capacity = newCap;
    }

    public int size() { return size; }

    public void registerHashName(int hash, String name) {
        hashToName.put(hash, name);
    }

    public String nameForHash(int hash) {
        return hashToName.getOrDefault(hash, "hash:" + hash);
    }

    /** Initialize heatmap grids. Call before parse begins. */
    public void initHeatmaps(int cellSize) {
        allHeatmap          = new HeatmapGrid(cellSize);
        buildingHeatmap     = new HeatmapGrid(cellSize);
        droppedItemHeatmap  = new HeatmapGrid(cellSize);
    }

    /**
     * Resolve portal pairs by tag matching.
     * Exactly 2 portals sharing a non-empty tag = paired.
     */
    public Map<Integer, Integer> buildPortalPairMap() {
        Map<String, List<Integer>> byTag = new HashMap<>();
        for (int idx : portalIndices) {
            String tag = label1[idx];
            if (tag == null || tag.isEmpty()) continue;
            byTag.computeIfAbsent(tag, _k -> new ArrayList<>()).add(idx);
        }
        Map<Integer, Integer> pairs = new HashMap<>(portalIndices.size() * 2);
        for (int idx : portalIndices) {
            String tag = label1[idx];
            if (tag == null || tag.isEmpty()) { pairs.put(idx, -1); continue; }
            List<Integer> group = byTag.get(tag);
            if (group == null || group.size() != 2) { pairs.put(idx, -1); continue; }
            int partner = group.get(0) == idx ? group.get(1) : group.get(0);
            pairs.put(idx, partner);
        }
        return pairs;
    }

    // -------- Category constants --------
    public static final class Categories {
        public static final byte NATURE       = 0;
        public static final byte BUILDING     = 1;
        public static final byte DROPPED_ITEM = 2;
        public static final byte ITEM_STAND   = 3;
        public static final byte CONTAINER    = 4;
        public static final byte CREATURE     = 5;
        public static final byte PORTAL       = 6;
        public static final byte BED          = 7;
        public static final byte TOMBSTONE    = 8;
        public static final byte SIGN         = 9;
        public static final byte BALLISTA     = 10;
        public static final byte UNKNOWN      = 11;
        public static final byte STRUCTURE    = 12; // dungeon/boss-site entrance

        public static String name(byte cat) {
            switch (cat) {
                case NATURE:       return "NATURE";
                case BUILDING:     return "BUILDING";
                case DROPPED_ITEM: return "DROPPED_ITEM";
                case ITEM_STAND:   return "ITEM_STAND";
                case CONTAINER:    return "CONTAINER";
                case CREATURE:     return "CREATURE";
                case PORTAL:       return "PORTAL";
                case BED:          return "BED";
                case TOMBSTONE:    return "TOMBSTONE";
                case SIGN:         return "SIGN";
                case BALLISTA:     return "BALLISTA";
                case STRUCTURE:    return "STRUCTURE";
                default:           return "UNKNOWN";
            }
        }
    }

    // -------- Player record --------
    public static final class PlayerRecord {
        public final long   internalId;
        public String       displayName;
        public String       steam64;
        public String       nameSource;
        public String       confidence;
        public int          bedCount;
        public int          deathCount;
        public int          buildCount;
        public int          portalCount;

        public PlayerRecord(long id, String name, String source) {
            this.internalId  = id;
            this.displayName = name;
            this.nameSource  = source;
            this.confidence  = (name != null && !name.isEmpty()) ? "NAME_CONFIRMED" : "ID_ONLY";
        }
    }
}
