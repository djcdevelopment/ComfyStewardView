package com.valheim.viewer.db;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Measures how much of a known change the pipeline can see at all.
 *
 * <p>The synthetic corpus applies a scripted set of mutations and writes a per-object ledger of
 * exactly what it did — action, prefab and position, 581 objects across five intervals. That makes
 * a question answerable that is otherwise guesswork: when a change does not appear on the map, is
 * it because the rendering hid it, or because the pipeline never recorded it?
 *
 * <p>Those two failures look identical on screen and have completely different fixes. Tuning a
 * colour ramp cannot recover an object the delta never captured, and the corpus already shows that
 * happening — one interval applied 64 additions and Steward recorded 16. This class separates the
 * two:
 *
 * <ul>
 *   <li><b>Ceiling</b> — of the labelled objects, how many did the delta record? This is the upper
 *       bound on what any rendering could ever show, and it is a property of the identity rule.</li>
 *   <li><b>Headroom</b> — of the cells the delta did record, how many carry enough signal to be
 *       worth surfacing? That part is a rendering question.</li>
 * </ul>
 *
 * <p>The comparison uses {@link SnapshotDeltaEngine#missingIdentityPredicate} so "the same object"
 * means what it means everywhere else. A label that fails to match is a real miss, not a
 * definition mismatch.
 */
public final class GroundTruthScorer {

    /** Matches the engine's quantisation: identity is prefab plus position rounded to 1 cm. */
    private static final int POS_SCALE = 100;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** One applied mutation, as the corpus generator recorded it. */
    public record Label(String action, String prefab, String category, double x, double y, double z) {
        String key() { return prefab + "@" + q(x) + "," + q(y) + "," + q(z); }
        private static long q(double v) { return Math.round(v * POS_SCALE); }
    }

    /** One interval to score: a ground-truth step mapped onto an ingested snapshot pair. */
    public record Interval(int step, long fromSnapshotId, long toSnapshotId, File ledger) {}

    private final File cacheFile;

    public GroundTruthScorer(File cacheFile) {
        this.cacheFile = cacheFile;
    }

    public ObjectNode score(List<Interval> intervals, int[] cellSizes) throws Exception {
        Class.forName("org.duckdb.DuckDBDriver");
        ObjectNode root = MAPPER.createObjectNode();
        root.put("generatedAt", Instant.now().toString());
        root.put("identity", "prefab-name+position-cm");
        ArrayNode out = root.putArray("intervals");

        long labelsTotal = 0, capturedTotal = 0;
        try (Connection conn = DriverManager.getConnection("jdbc:duckdb:" + cacheFile.getAbsolutePath())) {
            for (Interval iv : intervals) {
                List<Label> labels = readLedger(iv.ledger());
                Set<String> recordedAdded = recordedKeys(conn, iv.toSnapshotId(), iv.fromSnapshotId());
                Set<String> recordedRemoved = recordedKeys(conn, iv.fromSnapshotId(), iv.toSnapshotId());

                ObjectNode node = out.addObject();
                node.put("step", iv.step());
                node.put("from", iv.fromSnapshotId());
                node.put("to", iv.toSnapshotId());

                for (String action : List.of("added", "removed")) {
                    Set<String> recorded = "added".equals(action) ? recordedAdded : recordedRemoved;
                    List<Label> subset = labels.stream().filter(l -> action.equals(l.action())).toList();
                    long captured = subset.stream().filter(l -> recorded.contains(l.key())).count();

                    ObjectNode a = node.putObject(action);
                    a.put("applied", subset.size());
                    a.put("captured", captured);
                    a.put("missed", subset.size() - captured);
                    a.put("capturedFraction", subset.isEmpty() ? 1.0
                        : Math.round(captured * 1000.0 / subset.size()) / 1000.0);
                    // Which prefabs go missing is the actionable part: a systematic miss on one
                    // prefab is a classifier or identity problem, a scattered miss is churn.
                    Map<String, Integer> missedBy = new TreeMap<>();
                    for (Label l : subset) {
                        if (!recorded.contains(l.key())) missedBy.merge(l.prefab(), 1, Integer::sum);
                    }
                    ObjectNode mb = a.putObject("missedByPrefab");
                    missedBy.forEach(mb::put);

                    labelsTotal += subset.size();
                    capturedTotal += captured;
                }

                node.set("spatial", spatialCeiling(labels, recordedAdded, recordedRemoved, cellSizes));
            }
        }

        ObjectNode summary = root.putObject("summary");
        summary.put("labelledObjects", labelsTotal);
        summary.put("capturedObjects", capturedTotal);
        summary.put("ceiling", labelsTotal == 0 ? 0.0
            : Math.round(capturedTotal * 1000.0 / labelsTotal) / 1000.0);
        summary.put("note", "ceiling is the share of applied mutations the delta recorded at all. "
            + "No rendering choice can exceed it; the remainder is lost before anything is drawn.");
        return root;
    }

    /**
     * Cell-level view of the same question.
     *
     * <p>A cell counts as reachable when at least one labelled object in it was recorded. A cell
     * where every object was missed cannot be drawn at any resolution, which is the number that
     * decides whether cell size is worth sweeping at all.
     */
    private ObjectNode spatialCeiling(List<Label> labels, Set<String> recordedAdded,
            Set<String> recordedRemoved, int[] cellSizes) {
        ObjectNode node = MAPPER.createObjectNode();
        for (int cellSize : cellSizes) {
            Map<String, int[]> cells = new LinkedHashMap<>();   // cell -> {labelled, captured}
            for (Label l : labels) {
                Set<String> recorded = "added".equals(l.action()) ? recordedAdded : recordedRemoved;
                String cell = Math.floorDiv((long) Math.floor(l.x()), cellSize) + ":"
                            + Math.floorDiv((long) Math.floor(l.z()), cellSize);
                int[] counts = cells.computeIfAbsent(cell, k -> new int[2]);
                counts[0]++;
                if (recorded.contains(l.key())) counts[1]++;
            }
            long reachable = cells.values().stream().filter(c -> c[1] > 0).count();
            ObjectNode c = node.putObject(String.valueOf(cellSize));
            c.put("labelledCells", cells.size());
            c.put("reachableCells", reachable);
            c.put("blindCells", cells.size() - reachable);
        }
        return node;
    }

    /** Identity keys of every object present in one snapshot and absent from the other. */
    private Set<String> recordedKeys(Connection conn, long presentIn, long absentFrom) throws SQLException {
        Set<String> keys = new HashSet<>();
        String sql =
            "SELECT b.prefab_name, b.x, b.y, b.z FROM zdo b " +
            "WHERE b.snapshot_id = ? AND " +
            SnapshotDeltaEngine.missingIdentityPredicate("b", "a");
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, presentIn);
            ps.setLong(2, absentFrom);
            ps.setFetchSize(10_000);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String prefab = rs.getString(1);
                    if (prefab == null) continue;
                    keys.add(prefab + "@" + Math.round(rs.getDouble(2) * POS_SCALE) + ","
                        + Math.round(rs.getDouble(3) * POS_SCALE) + ","
                        + Math.round(rs.getDouble(4) * POS_SCALE));
                }
            }
        }
        return keys;
    }

    /** JSONL, one applied mutation per line. Tolerates a BOM, which PowerShell writes by default. */
    public static List<Label> readLedger(File ledger) throws Exception {
        List<Label> labels = new ArrayList<>();
        String text = new String(Files.readAllBytes(ledger.toPath()), StandardCharsets.UTF_8);
        if (!text.isEmpty() && text.charAt(0) == '﻿') text = text.substring(1);
        for (String line : text.split("\\R")) {
            if (line.isBlank()) continue;
            var n = MAPPER.readTree(line);
            labels.add(new Label(
                n.path("action").asText(""), n.path("prefab").asText(""),
                n.path("category").asText(""),
                n.path("x").asDouble(), n.path("y").asDouble(), n.path("z").asDouble()));
        }
        return labels;
    }

    /**
     * Pair each ground-truth step with the snapshot pair that represents it.
     *
     * <p>The corpus records its own {@code stewardSnapshotId}s, and they go stale the moment the
     * corpus is re-ingested or the publish lane prunes a snapshot — which is exactly what happened
     * here. Rather than trust that mapping, the caller supplies the ingested ids and this only
     * checks that the ledger exists, so a stale corpus file cannot silently score the wrong pair.
     */
    public static List<Interval> intervals(File groundTruthDir, Map<Integer, long[]> stepToPair) {
        List<Interval> out = new ArrayList<>();
        for (Map.Entry<Integer, long[]> e : new TreeMap<>(stepToPair).entrySet()) {
            File ledger = new File(groundTruthDir, String.format("step-%02d.jsonl", e.getKey()));
            if (!ledger.isFile()) continue;
            out.add(new Interval(e.getKey(), e.getValue()[0], e.getValue()[1], ledger));
        }
        return out;
    }

    /** {@code <cache> <ground-truth-dir> <step>:<from>-<to> [...]} */
    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("usage: GroundTruthScorer <cache.duckdb> <ground-truth-dir> <step:from-to>...");
            System.exit(2);
        }
        Map<Integer, long[]> mapping = new HashMap<>();
        for (int i = 2; i < args.length; i++) {
            String[] parts = args[i].split("[:-]");
            mapping.put(Integer.parseInt(parts[0]),
                new long[]{ Long.parseLong(parts[1]), Long.parseLong(parts[2]) });
        }
        var scorer = new GroundTruthScorer(new File(args[0]));
        var result = scorer.score(intervals(new File(args[1]), mapping),
            RenderedDeltaLayerBuilder.CELL_SIZES);
        System.out.println(MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(result));
    }
}
