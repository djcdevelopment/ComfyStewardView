package com.valheim.viewer.db;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.File;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Per-world history of what changed between consecutive saves.
 *
 * <p><b>What this is for.</b> A single delta has no distribution to judge itself against. The
 * snapshot raster at 64 m has ~27,600 occupied cells, so percentiles mean something; one delta
 * pair has two or three. The question "is 115 objects a lot?" is unanswerable from that pair and
 * perfectly answerable from the server's own history, which is what this builds. It is also what
 * makes a 5-player server and a 100-player server work off the same code with no configuration:
 * each develops its own baseline, so "unusual" calibrates itself.
 *
 * <p><b>Consecutive pairs only.</b> {@link RenderedDeltaLayerBuilder} renders the full matrix of
 * the latest six snapshots — 15 pairs — because any two of them are a valid comparison to look
 * at. A time series is a different question: a 101&rarr;106 span covers five intervals and a
 * 105&rarr;106 span covers one, and pooling them would compare rates measured over different
 * durations. Only adjacent pairs go in, and every snapshot in the cache is walked rather than
 * just the retained six, because the six-snapshot limit exists to bound raster disk cost and has
 * nothing to say about how much history a series should use.
 *
 * <p><b>Counts come from {@link SnapshotDeltaEngine#computeDelta}</b> rather than from a query of
 * this class's own. The baseline exists to judge what the map shows, so the two must agree about
 * what "the same object" means; sharing the implementation makes that true by construction rather
 * than by a test that could rot. It costs a few extra queries per pair, which is irrelevant in a
 * batch pass that already re-renders rasters.
 *
 * <p><b>Statistics are gated on sample count.</b> See {@link #MIN_SAMPLES_FOR_PERCENTILES}.
 */
public final class BaselineBuilder {

    /**
     * Below this many intervals, percentiles are not emitted at all.
     *
     * <p>A p99 over five samples is just the maximum wearing a percentile's name, and on the
     * corpus this was written against three of those five intervals have zero removals. Reporting
     * "3.1x your p99" from that would be a confident number with nothing behind it, which is
     * worse than reporting nothing: the whole point of a baseline is that a steward can trust the
     * comparison. Median and max are emitted at any sample count because they degrade honestly.
     */
    public static final int MIN_SAMPLES_FOR_PERCENTILES = 12;

    /** Bumped when the emitted shape or its meaning changes, so a stale file is rebuilt. */
    public static final int SCHEMA_VERSION = 1;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final File cacheFile;
    private final File renderRoot;
    private final ResourceGroups resources;

    public BaselineBuilder(File cacheFile, File renderRoot) {
        this(cacheFile, renderRoot, ResourceGroups.load());
    }

    public BaselineBuilder(File cacheFile, File renderRoot, ResourceGroups resources) {
        this.cacheFile = cacheFile;
        this.renderRoot = renderRoot;
        this.resources = resources;
    }

    /** Build a series for every world with at least two snapshots. Returns files written. */
    public List<File> buildAll() throws Exception {
        Class.forName("org.duckdb.DuckDBDriver");
        List<File> written = new ArrayList<>();
        try (Connection conn = DriverManager.getConnection("jdbc:duckdb:" + cacheFile.getAbsolutePath())) {
            for (Map.Entry<String, List<Long>> world : loadSnapshotsByWorld(conn).entrySet()) {
                List<Long> ids = world.getValue();
                if (ids.size() < 2) continue;
                written.add(buildWorld(conn, world.getKey(), ids));
            }
        }
        return written;
    }

    /** True when this world's series was written by the current schema. */
    public static boolean isCurrentSeries(File seriesFile) {
        if (!seriesFile.isFile()) return false;
        try {
            return MAPPER.readTree(seriesFile).path("schemaVersion").asInt(0) == SCHEMA_VERSION;
        } catch (Exception ignored) {
            return false;
        }
    }

    public File seriesFile(String worldId) {
        return new File(new File(renderRoot, "baseline"), pathSafe(worldId) + "-series.json");
    }

    private File buildWorld(Connection conn, String worldId, List<Long> ids) throws Exception {
        File out = seriesFile(worldId);
        if (!out.getParentFile().exists() && !out.getParentFile().mkdirs()) {
            throw new IllegalStateException("Could not create baseline directory: " + out.getParentFile());
        }

        // prefab -> per-interval counts, index-aligned with `intervals` below.
        Map<String, long[]> removedByPrefab = new TreeMap<>();
        Map<String, long[]> addedByPrefab = new TreeMap<>();
        ArrayNode intervals = MAPPER.createArrayNode();
        int n = ids.size() - 1;
        long totalRemoved = 0, groupedRemoved = 0;

        for (int i = 0; i < n; i++) {
            long from = ids.get(i), to = ids.get(i + 1);
            SnapshotDeltaEngine.DeltaResult delta = SnapshotDeltaEngine.computeDelta(conn, from, to);

            ObjectNode interval = intervals.addObject();
            interval.put("from", from);
            interval.put("to", to);
            interval.put("zdosAdded", delta.zdosAdded());
            interval.put("zdosRemoved", delta.zdosRemoved());
            // Surfaced per interval, not just per world: a pair whose counts do not reconcile is
            // a lower bound, and a rate computed from a lower bound is also a lower bound.
            interval.put("reconciles", delta.reconciles());
            interval.put("dictionaryMismatch", delta.dictionaryMismatch());

            for (Map.Entry<String, Integer> e : delta.removedPrefabs().entrySet()) {
                removedByPrefab.computeIfAbsent(e.getKey(), k -> new long[n])[i] = e.getValue();
                totalRemoved += e.getValue();
                if (resources.groupFor(e.getKey()) != null) groupedRemoved += e.getValue();
            }
            for (Map.Entry<String, Integer> e : delta.addedPrefabs().entrySet()) {
                addedByPrefab.computeIfAbsent(e.getKey(), k -> new long[n])[i] = e.getValue();
            }
        }

        ObjectNode root = MAPPER.createObjectNode();
        root.put("schemaVersion", SCHEMA_VERSION);
        root.put("worldId", worldId);
        root.put("generatedAt", Instant.now().toString());
        root.put("identity", "prefab-hash+position-cm");
        root.put("intervalCount", n);
        root.set("intervals", intervals);

        // Whether the numbers below can carry a threshold, stated once, at the top, in the file
        // that carries them — so a consumer cannot read a percentile without reading this.
        ObjectNode sufficiency = root.putObject("sufficiency");
        sufficiency.put("sampleCount", n);
        sufficiency.put("minSamplesForPercentiles", MIN_SAMPLES_FOR_PERCENTILES);
        boolean enough = n >= MIN_SAMPLES_FOR_PERCENTILES;
        sufficiency.put("percentilesEmitted", enough);
        long nonZero = 0;
        for (int i = 0; i < n; i++) {
            if (intervals.get(i).path("zdosRemoved").asLong() > 0) nonZero++;
        }
        sufficiency.put("intervalsWithRemovals", nonZero);
        sufficiency.put("note", enough
            ? "Percentiles are computed over " + n + " consecutive intervals."
            : "Only " + n + " consecutive interval(s), " + nonZero + " with any removals. Too few "
              + "for a percentile to mean anything, so median and max are emitted and percentiles "
              + "are withheld. This resolves itself as the publish lane accumulates snapshots.");

        ObjectNode coverage = root.putObject("coverage");
        coverage.put("resourceSource", resources.sourceDescription());
        coverage.put("totalRemovals", totalRemoved);
        coverage.put("groupedRemovals", groupedRemoved);
        coverage.put("groupedFraction", totalRemoved == 0 ? 0.0
            : Math.round(groupedRemoved * 1000.0 / totalRemoved) / 1000.0);

        root.set("prefabs", prefabStats(removedByPrefab, addedByPrefab, n, enough));
        root.set("groups", groupStats(removedByPrefab, addedByPrefab, n, enough));

        MAPPER.writerWithDefaultPrettyPrinter().writeValue(out, root);
        return out;
    }

    private ObjectNode prefabStats(Map<String, long[]> removed, Map<String, long[]> added,
            int n, boolean percentiles) {
        ObjectNode node = MAPPER.createObjectNode();
        // Union, so a prefab that is only ever added (regrowth with no observed harvest) still
        // appears — its absence from the removed map is a finding, not a reason to hide it.
        Map<String, Boolean> names = new TreeMap<>();
        removed.keySet().forEach(k -> names.put(k, true));
        added.keySet().forEach(k -> names.put(k, true));

        for (String name : names.keySet()) {
            long[] rem = removed.getOrDefault(name, new long[n]);
            long[] add = added.getOrDefault(name, new long[n]);
            ObjectNode p = node.putObject(name);
            String group = resources.groupFor(name);
            if (group != null) p.put("group", group);
            p.set("removed", longArray(rem));
            p.set("added", longArray(add));
            p.set("removedStats", stats(rem, percentiles));
            p.set("addedStats", stats(add, percentiles));
        }
        return node;
    }

    private ObjectNode groupStats(Map<String, long[]> removed, Map<String, long[]> added,
            int n, boolean percentiles) {
        Map<String, long[]> groupRemoved = new LinkedHashMap<>();
        Map<String, long[]> groupAdded = new LinkedHashMap<>();
        for (ResourceGroups.Group g : resources.groups()) {
            groupRemoved.put(g.id(), new long[n]);
            groupAdded.put(g.id(), new long[n]);
        }
        accumulate(removed, groupRemoved, n);
        accumulate(added, groupAdded, n);

        ObjectNode node = MAPPER.createObjectNode();
        for (ResourceGroups.Group g : resources.groups()) {
            ObjectNode gn = node.putObject(g.id());
            gn.put("label", g.label());
            long[] rem = groupRemoved.get(g.id()), add = groupAdded.get(g.id());
            gn.set("removed", longArray(rem));
            gn.set("added", longArray(add));
            gn.set("removedStats", stats(rem, percentiles));
            gn.set("addedStats", stats(add, percentiles));
        }
        return node;
    }

    private void accumulate(Map<String, long[]> byPrefab, Map<String, long[]> byGroup, int n) {
        for (Map.Entry<String, long[]> e : byPrefab.entrySet()) {
            String group = resources.groupFor(e.getKey());
            if (group == null) continue;
            long[] target = byGroup.get(group);
            if (target == null) continue;
            for (int i = 0; i < n; i++) target[i] += e.getValue()[i];
        }
    }

    /**
     * Summary of one per-interval series.
     *
     * <p>Median and max are always present; percentiles only when the caller says the sample count
     * supports them. Zero intervals are included deliberately — a week with no harvesting is real
     * information about the rate, and dropping the zeros would inflate every statistic.
     */
    private ObjectNode stats(long[] series, boolean percentiles) {
        ObjectNode node = MAPPER.createObjectNode();
        long[] sorted = series.clone();
        java.util.Arrays.sort(sorted);
        long total = 0, max = 0;
        for (long v : series) { total += v; max = Math.max(max, v); }
        node.put("total", total);
        node.put("max", max);
        node.put("mean", series.length == 0 ? 0.0
            : Math.round(total * 100.0 / series.length) / 100.0);
        node.put("median", percentile(sorted, 0.50));
        if (percentiles) {
            node.put("p90", percentile(sorted, 0.90));
            node.put("p99", percentile(sorted, 0.99));
        }
        return node;
    }

    /** Nearest-rank on the sorted series. Exact-enough for counts, and never interpolates a
     *  fractional object into existence. */
    private static double percentile(long[] sorted, double q) {
        if (sorted.length == 0) return 0;
        int idx = (int) Math.ceil(q * sorted.length) - 1;
        return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
    }

    private static ArrayNode longArray(long[] values) {
        ArrayNode a = MAPPER.createArrayNode();
        for (long v : values) a.add(v);
        return a;
    }

    /** Snapshot ids per world, ascending, so consecutive entries are consecutive saves. */
    private static Map<String, List<Long>> loadSnapshotsByWorld(Connection conn) throws SQLException {
        Map<String, List<Long>> byWorld = new LinkedHashMap<>();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT snapshot_id, world_id FROM world_snapshot ORDER BY world_id, snapshot_id");
             ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                String worldId = rs.getString("world_id");
                if (worldId == null || worldId.isBlank()) continue;
                byWorld.computeIfAbsent(worldId, k -> new ArrayList<>()).add(rs.getLong("snapshot_id"));
            }
        }
        return byWorld;
    }

    /** World ids are slugs from ingest; keep them from reaching the filesystem unfiltered. */
    static String pathSafe(String worldId) {
        String cleaned = worldId.replaceAll("[^A-Za-z0-9_.-]", "_");
        return cleaned.isBlank() ? "unknown" : cleaned;
    }

    /** Remove series files for worlds that are no longer in the cache. */
    public void pruneStale(java.util.Set<String> liveWorldIds) throws java.io.IOException {
        File dir = new File(renderRoot, "baseline");
        File[] children = dir.listFiles((d, name) -> name.endsWith("-series.json"));
        if (children == null) return;
        java.util.Set<String> keep = new java.util.HashSet<>();
        for (String id : liveWorldIds) keep.add(pathSafe(id) + "-series.json");
        for (File f : children) {
            if (!keep.contains(f.getName())) Files.deleteIfExists(f.toPath());
        }
    }
}
