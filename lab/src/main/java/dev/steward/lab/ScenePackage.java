package dev.steward.lab;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Deterministic, exact-membership, selection-local WebGPU scene package. */
public final class ScenePackage {
    public static final int DIRECT_LIMIT = 5_000;
    public static final int OVERRIDE_LIMIT = 250_000;
    public static final int PRESENTATION_INSTANCE_LIMIT = 500_000;
    public static final int INSTANCE_STRIDE = 80;
    public static final String CONTENT_TYPE = "application/vnd.comfysteward.scene";
    private static final double MIN_VISIBLE_AXIS = 0.01;
    private static final double UNKNOWN_MARKER_AXIS = 0.35;
    private static final double MAX_PROXY_AXIS = 20.0;
    private static final double MAX_PROXY_VOLUME = 2_000.0;
    private static final double HOME_ALL_MAX_SPAN = 600.0;
    private static final double HOME_CELL_METERS = 64.0;
    private static final Map<String, String> FAMILY_COLORS = familyColors();

    private final SnapshotRepository snapshots;
    private final ObjectMapper mapper;
    private final Map<Integer, RndCandidate> rndCandidates;
    private final String rndCandidateSha256;

    public ScenePackage(SnapshotRepository snapshots, ObjectMapper mapper) {
        this.snapshots = snapshots;
        this.mapper = mapper;
        this.rndCandidates = Map.of();
        this.rndCandidateSha256 = "";
    }

    ScenePackage(SnapshotRepository snapshots, ObjectMapper mapper, Path rndCandidateReceipt) throws Exception {
        this.snapshots = snapshots;
        this.mapper = mapper;
        if (rndCandidateReceipt == null) {
            this.rndCandidates = Map.of();
            this.rndCandidateSha256 = "";
        } else {
            Path path = rndCandidateReceipt.toAbsolutePath().normalize();
            this.rndCandidates = readRndCandidates(path, mapper);
            this.rndCandidateSha256 = sha256(Files.readAllBytes(path));
        }
    }

    public Result build(long snapshotId, String lensId,
            double minX, double maxX, double minZ, double maxZ,
            List<String> biomes, boolean forced, String release) throws Exception {
        return build(snapshotId, lensId, minX, maxX, minZ, maxZ, biomes, forced,
            release, "candidate", false);
    }

    Result build(long snapshotId, String lensId,
            double minX, double maxX, double minZ, double maxZ,
            List<String> biomes, boolean forced, String release,
            String presentationVariant, boolean exposeRndCameraOrigin) throws Exception {
        boolean baseline = "baseline".equals(presentationVariant);
        if (!baseline && !"candidate".equals(presentationVariant)) {
            throw new IllegalArgumentException("presentation must be candidate or baseline");
        }
        if (!"build-density".equals(lensId)) {
            throw new IllegalArgumentException("3D exploration is available for Build density only");
        }
        validateBounds(minX, maxX, minZ, maxZ);
        long pieceCount = count(snapshotId, minX, maxX, minZ, maxZ, biomes);
        if (pieceCount > OVERRIDE_LIMIT) {
            throw new CapacityException(false,
                "This selection exceeds the 250,000-piece 3D safety limit. Tighten the green area.");
        }
        if (!forced && pieceCount > DIRECT_LIMIT) {
            throw new CapacityException(true,
                "This selection exceeds 5,000 pieces. Confirm the exact 3D override from the map.");
        }
        if (pieceCount == 0) {
            throw new IllegalArgumentException("This selection contains no building pieces to explore in 3D");
        }

        Map<Integer, List<Primitive>> primitives = queryPrimitives();
        List<Piece> pieces = query(snapshotId, minX, maxX, minZ, maxZ, biomes, (int) pieceCount);
        if (pieces.size() != pieceCount) {
            throw new IllegalStateException("The exact scene changed while it was being assembled");
        }
        boolean usingRndCandidates = exposeRndCameraOrigin && !baseline && !rndCandidates.isEmpty();
        if (usingRndCandidates) {
            primitives = new HashMap<>(primitives);
            for (var entry : rndCandidates.entrySet()) primitives.put(entry.getKey(), entry.getValue().primitives);
            pieces = pieces.stream().map(this::withRndCandidate).toList();
        }

        long desiredInstances = 0;
        for (Piece piece : pieces) desiredInstances += desiredInstanceCount(piece, primitives, baseline);
        boolean presentationCapped = desiredInstances > PRESENTATION_INSTANCE_LIMIT;
        Coverage coverage = new Coverage();
        List<Visual> visuals = new ArrayList<>((int) Math.min(
            presentationCapped ? pieces.size() : desiredInstances, PRESENTATION_INSTANCE_LIMIT));
        for (Piece piece : pieces) visuals.addAll(visualize(
            piece, primitives, presentationCapped, baseline, coverage));
        if (visuals.isEmpty() || visuals.size() > PRESENTATION_INSTANCE_LIMIT) {
            throw new IllegalStateException("The scene presentation budget could not preserve exact membership");
        }

        List<Visual> framingVisuals = visuals.stream().filter(Visual::defaultVisible).toList();
        if (framingVisuals.isEmpty()) framingVisuals = visuals;
        Bounds bounds = orientedBounds(framingVisuals);
        double[] origin = bounds.center();
        double framingRadius = 0;
        for (Visual visual : framingVisuals) {
            framingRadius = Math.max(framingRadius,
                length(localCenter(visual.center, origin)) + visualRadius(visual.linear));
        }
        List<GroupBuilder> groups = groupVisuals(visuals);
        ByteBuffer instanceBuffer = ByteBuffer.allocate(visuals.size() * INSTANCE_STRIDE)
            .order(ByteOrder.LITTLE_ENDIAN);
        double radius = 0;
        int start = 0;
        for (GroupBuilder group : groups) {
            group.start = start;
            for (Visual visual : group.visuals) {
                double[] localCenter = localCenter(visual.center, origin);
                putModel(instanceBuffer, mirrorX(visual.linear), localCenter);
                for (float channel : hexColor(visual.color)) instanceBuffer.putFloat(channel);
                radius = Math.max(radius, length(localCenter) + visualRadius(visual.linear));
                start++;
            }
        }
        byte[] instanceBytes = instanceBuffer.array();
        String instanceSha = sha256(instanceBytes);
        ReleaseReceipt receipt = releaseReceipt();
        HomeFrame home = homeFrame(framingVisuals, bounds, origin, framingRadius);

        ObjectNode manifest = mapper.createObjectNode();
        manifest.put("schema", "steward-zdo-scene/v2");
        manifest.put("snapshotId", snapshotId);
        manifest.put("snapshotHash", receipt.snapshotHash);
        manifest.put("release", release == null ? "" : release);
        manifest.put("lens", lensId);
        manifest.put("exact", true);
        manifest.put("membershipContract", "pieces is the exact selected ZDO count; presentation never samples or drops membership");
        manifest.put("forced", forced);
        manifest.put("presentationVariant", presentationVariant);
        if (usingRndCandidates) {
            manifest.put("rndCandidate", true);
            manifest.put("rndCandidateSha256", rndCandidateSha256);
        }
        manifest.put("pieces", pieces.size());
        manifest.put("renderInstances", visuals.size());
        manifest.put("triangles", visuals.size() * 12L);
        manifest.put("instanceStride", INSTANCE_STRIDE);
        manifest.put("instanceBytes", instanceBytes.length);
        manifest.put("instanceSha256", instanceSha);
        manifest.put("buildingGeometrySha256", receipt.buildingGeometrySha256);
        manifest.put("pieceGeometrySha256", receipt.pieceGeometrySha256);
        manifest.put("representationCatalogSha256", receipt.representationCatalogSha256);
        manifest.put("promotionReceiptSha256", receipt.promotionReceiptSha256);
        manifest.put("coordinateContract", "selection-local right-handed; absolute origin withheld");
        if (exposeRndCameraOrigin) {
            ArrayNode cameraOrigin = manifest.putArray("rndCameraOrigin");
            cameraOrigin.add(origin[0]).add(origin[1]).add(origin[2]);
        }
        manifest.put("floorY", round(bounds.low[1] - origin[1], 3));
        manifest.put("radiusM", round(Math.max(radius, 1.0), 3));
        ArrayNode dimensions = manifest.putArray("dimensionsM");
        dimensions.add(round(bounds.high[0] - bounds.low[0], 2));
        dimensions.add(round(bounds.high[1] - bounds.low[1], 2));
        dimensions.add(round(bounds.high[2] - bounds.low[2], 2));

        ObjectNode homeNode = manifest.putObject("home");
        homeNode.put("strategy", home.strategy);
        homeNode.put("pieces", home.pieces);
        homeNode.put("radiusM", round(home.radius, 3));
        homeNode.put("floorY", round(home.floorY, 3));
        ArrayNode homeTarget = homeNode.putArray("target");
        for (double value : home.target) homeTarget.add(round(value, 3));

        ObjectNode scope = manifest.putObject("scope");
        scope.put("minX", minX); scope.put("maxX", maxX);
        scope.put("minZ", minZ); scope.put("maxZ", maxZ);
        ArrayNode selectedBiomes = scope.putArray("biomes");
        biomes.forEach(selectedBiomes::add);

        ObjectNode quality = manifest.putObject("representationQuality");
        quality.put("measuredEnvelope", coverage.measuredEnvelope);
        quality.put("runtimeCompoundProxy", coverage.runtimeCompoundProxy);
        quality.put("estimatedEnvelope", coverage.estimatedEnvelope);
        quality.put("pivotMarker", coverage.pivotMarker);
        quality.put("contextMarkers", coverage.contextMarkers);
        quality.put("hiddenContextPieces", coverage.hiddenContextPieces);
        quality.put("unresolvedCompoundMarkers", coverage.unresolvedCompoundMarkers);
        quality.put("outlierMarkers", coverage.outlierMarkers);
        quality.put("compoundBudgetMarkers", coverage.compoundBudgetMarkers);
        quality.put("markerAxisM", UNKNOWN_MARKER_AXIS);
        quality.put("animationState", "deterministic static phase from zdo_index; saved runtime animation state unavailable");

        ObjectNode presentation = manifest.putObject("presentationBudget");
        presentation.put("limit", PRESENTATION_INSTANCE_LIMIT);
        presentation.put("desiredInstances", desiredInstances);
        presentation.put("capped", presentationCapped);
        presentation.put("membershipDropped", 0);

        ArrayNode groupNodes = manifest.putArray("drawGroups");
        for (GroupBuilder group : groups) {
            ObjectNode node = groupNodes.addObject();
            node.put("name", group.name);
            node.put("color", group.color);
            node.put("semanticClass", group.semanticClass);
            node.put("defaultVisible", group.defaultVisible);
            node.put("start", group.start);
            node.put("count", group.visuals.size());
            node.put("pieces", group.pieceIds.size());
        }
        manifest.put("warmupFrames", 30);
        manifest.put("benchmarkFrames", 300);

        byte[] manifestBytes = mapper.writeValueAsBytes(manifest);
        int instanceOffset = align4(16 + manifestBytes.length);
        ByteBuffer result = ByteBuffer.allocate(instanceOffset + instanceBytes.length)
            .order(ByteOrder.LITTLE_ENDIAN);
        result.put("SV3D".getBytes(StandardCharsets.US_ASCII));
        result.putInt(2);
        result.putInt(manifestBytes.length);
        result.putInt(instanceOffset);
        result.put(manifestBytes);
        while (result.position() < instanceOffset) result.put((byte) 0);
        result.put(instanceBytes);
        return new Result(result.array(), manifest, pieces.size(), visuals.size());
    }

    private List<Piece> query(long snapshotId, double minX, double maxX,
            double minZ, double maxZ, List<String> biomes, int limit) throws SQLException {
        StringBuilder biomeSql = new StringBuilder();
        if (!biomes.isEmpty()) {
            biomeSql.append(" AND z.biome IN (");
            for (int i = 0; i < biomes.size(); i++) {
                if (i > 0) biomeSql.append(',');
                biomeSql.append('?');
            }
            biomeSql.append(')');
        }
        String sql = "SELECT z.zdo_index, z.prefab_hash, z.prefab_name, z.x, z.y, z.z, " +
            "z.has_rot, z.rot_x, z.rot_y, z.rot_z, pg.family, pg.geometry_source, " +
            "pg.extent_x, pg.extent_y, pg.extent_z, pg.center_x, pg.center_y, pg.center_z, " +
            "pr.semantic_class, pr.strategy, pr.authority, pr.default_visible, pr.marker_axis, " +
            "pr.primitive_count, pr.animation_axis, pr.animation_pivot_x, " +
            "pr.animation_pivot_y, pr.animation_pivot_z FROM zdo z " +
            "LEFT JOIN prefab_geometry pg USING (prefab_hash) " +
            "LEFT JOIN prefab_representation pr USING (prefab_hash) WHERE z.snapshot_id = ? " +
            "AND z.category = 'BUILDING' AND z.x >= ? AND z.x <= ? AND z.z >= ? AND z.z <= ?" +
            biomeSql + " ORDER BY COALESCE(pg.family, 'unknown'), z.zdo_index LIMIT ?";
        List<Piece> result = new ArrayList<>(Math.min(limit + 1, 8_192));
        try (Connection connection = snapshots.open();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            int parameter = 1;
            statement.setLong(parameter++, snapshotId);
            statement.setDouble(parameter++, minX);
            statement.setDouble(parameter++, maxX);
            statement.setDouble(parameter++, minZ);
            statement.setDouble(parameter++, maxZ);
            for (String biome : biomes) statement.setString(parameter++, biome);
            statement.setInt(parameter, limit + 1);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) result.add(readPiece(rows));
            }
        }
        return result;
    }

    private Map<Integer, List<Primitive>> queryPrimitives() throws SQLException {
        Map<Integer, List<Primitive>> result = new HashMap<>();
        try (Connection connection = snapshots.open();
             PreparedStatement statement = connection.prepareStatement(
                 "SELECT * FROM prefab_representation_primitive ORDER BY prefab_hash, ordinal");
             ResultSet rows = statement.executeQuery()) {
            while (rows.next()) {
                double[] matrix = new double[16];
                for (int i = 0; i < matrix.length; i++) matrix[i] = rows.getDouble(4 + i);
                int hash = rows.getInt("prefab_hash");
                result.computeIfAbsent(hash, ignored -> new ArrayList<>()).add(
                    new Primitive(rows.getInt("ordinal"), rows.getBoolean("animated"), matrix));
            }
        }
        return result;
    }

    private Piece withRndCandidate(Piece piece) {
        RndCandidate candidate = rndCandidates.get(piece.prefabHash);
        if (candidate == null || !candidate.prefabName.equals(piece.prefabName)) return piece;
        return new Piece(piece.zdoIndex, piece.prefabHash, piece.prefabName, piece.family,
            piece.geometrySource, piece.extents, piece.centerOffset, piece.rotation, piece.pivot,
            candidate.representation);
    }

    private static Map<Integer, RndCandidate> readRndCandidates(Path path, ObjectMapper mapper) throws Exception {
        JsonNode root = mapper.readTree(path.toFile());
        if (!"steward-prefab-renderers/v1".equals(root.path("schema").asText())) {
            throw new IllegalArgumentException("Unsupported local renderer candidate schema");
        }
        Map<Integer, RndCandidate> result = new HashMap<>();
        Set<String> names = new HashSet<>();
        for (JsonNode row : root.path("prefabs")) {
            String name = row.path("name").asText("").trim();
            if (name.isEmpty() || !row.path("hash").canConvertToInt() ||
                    !"candidate".equals(row.path("status").asText())) {
                throw new IllegalArgumentException("Invalid local renderer candidate");
            }
            if (!names.add(name)) {
                throw new IllegalArgumentException("Duplicate local renderer candidate: " + name);
            }
            List<Primitive> boxes = new ArrayList<>();
            int ordinal = 0;
            for (JsonNode box : row.path("boxes")) {
                JsonNode values = box.path("matrix");
                if (!values.isArray() || values.size() != 16) {
                    throw new IllegalArgumentException("Local renderer candidate matrix must contain 16 values: " + name);
                }
                double[] matrix = new double[16];
                for (int index = 0; index < matrix.length; index++) {
                    matrix[index] = values.path(index).asDouble(Double.NaN);
                    if (!Double.isFinite(matrix[index])) {
                        throw new IllegalArgumentException("Local renderer candidate matrix must be finite: " + name);
                    }
                }
                if (Math.abs(matrix[3]) > .0001 || Math.abs(matrix[7]) > .0001 ||
                        Math.abs(matrix[11]) > .0001 || Math.abs(matrix[15] - 1) > .0001) {
                    throw new IllegalArgumentException("Local renderer candidate matrix is not affine: " + name);
                }
                boxes.add(new Primitive(ordinal++, box.path("animated").asBoolean(false), matrix));
            }
            if (boxes.isEmpty() || boxes.size() > 32 || row.path("boxCount").asInt() != boxes.size()) {
                throw new IllegalArgumentException("Local renderer candidate must contain 1..32 audited boxes: " + name);
            }
            String axis = row.path("animationAxis").asText("z").toLowerCase();
            if (!Set.of("x", "y", "z").contains(axis)) {
                throw new IllegalArgumentException("Invalid local renderer animation axis: " + name);
            }
            JsonNode pivotNode = row.path("animationPivot");
            if (!pivotNode.isArray() || pivotNode.size() != 3) {
                throw new IllegalArgumentException("Local renderer candidate animation pivot is missing: " + name);
            }
            double[] pivot = new double[3];
            for (int index = 0; index < pivot.length; index++) {
                pivot[index] = pivotNode.path(index).asDouble(Double.NaN);
                if (!Double.isFinite(pivot[index])) {
                    throw new IllegalArgumentException("Local renderer animation pivot must be finite: " + name);
                }
            }
            int hash = row.path("hash").asInt();
            RndCandidate previous = result.put(hash, new RndCandidate(
                name,
                new Representation("structure", "runtime-compound", "local-rnd-renderer-probe",
                    true, UNKNOWN_MARKER_AXIS, boxes.size(), axis, pivot), List.copyOf(boxes)));
            if (previous != null) throw new IllegalArgumentException("Duplicate local renderer candidate: " + name);
        }
        return Map.copyOf(result);
    }

    private long count(long snapshotId, double minX, double maxX,
            double minZ, double maxZ, List<String> biomes) throws SQLException {
        StringBuilder biomeSql = new StringBuilder();
        if (!biomes.isEmpty()) {
            biomeSql.append(" AND biome IN (");
            for (int i = 0; i < biomes.size(); i++) {
                if (i > 0) biomeSql.append(',');
                biomeSql.append('?');
            }
            biomeSql.append(')');
        }
        String sql = "SELECT COUNT(*) FROM zdo WHERE snapshot_id = ? AND category = 'BUILDING' " +
            "AND x >= ? AND x <= ? AND z >= ? AND z <= ?" + biomeSql;
        try (Connection connection = snapshots.open();
             PreparedStatement statement = connection.prepareStatement(sql)) {
            int parameter = 1;
            statement.setLong(parameter++, snapshotId);
            statement.setDouble(parameter++, minX);
            statement.setDouble(parameter++, maxX);
            statement.setDouble(parameter++, minZ);
            statement.setDouble(parameter++, maxZ);
            for (String biome : biomes) statement.setString(parameter++, biome);
            try (ResultSet row = statement.executeQuery()) {
                if (!row.next()) throw new IllegalStateException("The exact scene count is unavailable");
                return row.getLong(1);
            }
        }
    }

    private static Piece readPiece(ResultSet row) throws SQLException {
        String family = row.getString("family");
        String geometrySource = row.getString("geometry_source");
        double[] extents = family == null ? null : new double[] {
            row.getDouble("extent_x"), row.getDouble("extent_y"), row.getDouble("extent_z")
        };
        double[] centerOffset = family == null ? new double[3] : new double[] {
            row.getDouble("center_x"), row.getDouble("center_y"), row.getDouble("center_z")
        };
        double[][] rotation = row.getBoolean("has_rot")
            ? rotation(row.getDouble("rot_x"), row.getDouble("rot_y"), row.getDouble("rot_z"))
            : identity();
        double[] pivot = { row.getDouble("x"), row.getDouble("y"), row.getDouble("z") };
        for (double value : pivot) {
            if (!Double.isFinite(value)) throw new IllegalStateException("Scene contains a non-finite transform");
        }
        Representation representation = null;
        String strategy = row.getString("strategy");
        if (strategy != null) {
            representation = new Representation(row.getString("semantic_class"), strategy,
                row.getString("authority"), row.getBoolean("default_visible"),
                row.getDouble("marker_axis"), row.getInt("primitive_count"),
                row.getString("animation_axis"), new double[] {
                    row.getDouble("animation_pivot_x"), row.getDouble("animation_pivot_y"),
                    row.getDouble("animation_pivot_z")
                });
        }
        return new Piece(row.getLong("zdo_index"), row.getInt("prefab_hash"),
            row.getString("prefab_name"), family == null ? "unknown" : family,
            geometrySource, extents, centerOffset, rotation, pivot, representation);
    }

    private static long desiredInstanceCount(Piece piece, Map<Integer, List<Primitive>> primitives,
            boolean baseline) {
        if (baseline) return 1;
        if (piece.representation != null && "runtime-compound".equals(piece.representation.strategy)) {
            return Math.max(1, primitives.getOrDefault(piece.prefabHash, List.of()).size());
        }
        return 1;
    }

    private static List<Visual> visualize(Piece piece, Map<Integer, List<Primitive>> primitives,
            boolean collapseCompounds, boolean baseline, Coverage coverage) {
        Representation representation = piece.representation;
        if (baseline) return envelope(piece, representation, coverage);
        if (representation != null && "context".equals(representation.semanticClass)) {
            coverage.contextMarkers++;
            coverage.hiddenContextPieces++;
            return List.of(marker(piece, "context", "context", false,
                representation.markerAxis, FAMILY_COLORS.get("context"), Kind.CONTEXT));
        }
        if (representation != null && "runtime-compound".equals(representation.strategy)) {
            List<Primitive> boxes = primitives.getOrDefault(piece.prefabHash, List.of());
            if (collapseCompounds) {
                coverage.pivotMarker++;
                coverage.compoundBudgetMarkers++;
                return List.of(marker(piece, "compound_budget", "structure", true,
                    UNKNOWN_MARKER_AXIS, FAMILY_COLORS.get("unknown"), Kind.PIVOT));
            }
            if (!boxes.isEmpty()) {
                coverage.runtimeCompoundProxy++;
                List<Visual> result = new ArrayList<>(boxes.size());
                for (Primitive primitive : boxes) result.add(compound(piece, primitive));
                return result;
            }
        }
        if (representation != null && "unresolved-compound".equals(representation.strategy)) {
            coverage.pivotMarker++;
            coverage.unresolvedCompoundMarkers++;
            return List.of(marker(piece, "unresolved", "structure", true,
                representation.markerAxis, FAMILY_COLORS.get("unknown"), Kind.PIVOT));
        }
        return envelope(piece, representation, coverage);
    }

    private static List<Visual> envelope(Piece piece, Representation representation, Coverage coverage) {
        if (piece.extents == null) {
            coverage.pivotMarker++;
            return List.of(marker(piece, "unknown", "structure", true,
                UNKNOWN_MARKER_AXIS, FAMILY_COLORS.get("unknown"), Kind.PIVOT));
        }
        boolean outlier = !safeProxyEnvelope(piece.extents);
        if (outlier) {
            coverage.pivotMarker++;
            coverage.outlierMarkers++;
            return List.of(marker(piece, "unresolved", "structure", true,
                UNKNOWN_MARKER_AXIS, FAMILY_COLORS.get("unknown"), Kind.PIVOT));
        }
        if ("family_median".equals(piece.geometrySource)) coverage.estimatedEnvelope++;
        else coverage.measuredEnvelope++;
        double[] extents = piece.extents.clone();
        for (int i = 0; i < 3; i++) extents[i] = Math.max(MIN_VISIBLE_AXIS, extents[i]);
        double[][] linear = multiply(piece.rotation, diagonal(extents));
        double[] center = add(piece.pivot, multiply(piece.rotation, piece.centerOffset));
        String group = representation != null && "structure".equals(representation.semanticClass)
            ? piece.prefabName : piece.family;
        return List.of(new Visual(piece.zdoIndex, group, "structure", true,
            color(piece.family), linear, center,
            "family_median".equals(piece.geometrySource) ? Kind.ESTIMATED : Kind.MEASURED));
    }

    private static Visual marker(Piece piece, String group, String semanticClass,
            boolean defaultVisible, double axis, String color, Kind kind) {
        double safeAxis = Math.max(MIN_VISIBLE_AXIS, axis);
        return new Visual(piece.zdoIndex, group, semanticClass, defaultVisible, color,
            multiply(piece.rotation, diagonal(new double[] { safeAxis, safeAxis, safeAxis })),
            piece.pivot.clone(), kind);
    }

    private static Visual compound(Piece piece, Primitive primitive) {
        double[][] localLinear = new double[3][3];
        for (int column = 0; column < 3; column++) {
            for (int row = 0; row < 3; row++) localLinear[row][column] = primitive.matrix[column * 4 + row];
        }
        double[] localCenter = { primitive.matrix[12], primitive.matrix[13], primitive.matrix[14] };
        if (primitive.animated && piece.representation.animationAxis != null) {
            double phase = Math.floorMod(Long.hashCode(piece.zdoIndex), 24) * 15.0;
            double[][] spin = axisRotation(piece.representation.animationAxis, phase);
            localLinear = multiply(spin, localLinear);
            double[] relative = subtract(localCenter, piece.representation.animationPivot);
            localCenter = add(piece.representation.animationPivot, multiply(spin, relative));
        }
        double[][] linear = multiply(piece.rotation, localLinear);
        double[] center = add(piece.pivot, multiply(piece.rotation, localCenter));
        return new Visual(piece.zdoIndex, piece.prefabName, "structure", true,
            color(piece.family), linear, center, Kind.COMPOUND);
    }

    private static List<GroupBuilder> groupVisuals(List<Visual> visuals) {
        Map<String, GroupBuilder> byKey = new LinkedHashMap<>();
        for (Visual visual : visuals) {
            String key = visual.group + "\u0000" + visual.semanticClass + "\u0000" + visual.defaultVisible;
            GroupBuilder group = byKey.computeIfAbsent(key, ignored -> new GroupBuilder(
                visual.group, visual.color, visual.semanticClass, visual.defaultVisible));
            group.visuals.add(visual);
            group.pieceIds.add(visual.zdoIndex);
        }
        List<GroupBuilder> result = new ArrayList<>(byKey.values());
        result.sort(Comparator.comparing((GroupBuilder value) -> !value.defaultVisible)
            .thenComparing(value -> value.name));
        return result;
    }

    private static boolean safeProxyEnvelope(double[] extents) {
        double volume = 1;
        for (double extent : extents) {
            if (!Double.isFinite(extent) || extent > MAX_PROXY_AXIS || extent < 0) return false;
            volume *= Math.max(MIN_VISIBLE_AXIS, extent);
        }
        return Double.isFinite(volume) && volume <= MAX_PROXY_VOLUME;
    }

    private static HomeFrame homeFrame(List<Visual> visuals, Bounds bounds, double[] origin, double radius) {
        double maxSpan = Math.max(bounds.high[0] - bounds.low[0],
            Math.max(bounds.high[1] - bounds.low[1], bounds.high[2] - bounds.low[2]));
        Set<Long> allPieces = new HashSet<>();
        visuals.forEach(value -> allPieces.add(value.zdoIndex));
        if (maxSpan <= HOME_ALL_MAX_SPAN) {
            return new HomeFrame("selection-all", allPieces.size(), new double[3],
                Math.max(radius, 1.0), bounds.low[1] - origin[1]);
        }

        Map<Long, PieceFrame> frames = pieceFrames(visuals);
        LinkedHashMap<Cell, Integer> cellCounts = new LinkedHashMap<>();
        for (PieceFrame frame : frames.values()) cellCounts.merge(cell(localCenter(frame.center(), origin)), 1, Integer::sum);
        Cell best = null;
        int bestCount = -1;
        double bestDistance = Double.POSITIVE_INFINITY;
        for (Cell candidate : cellCounts.keySet()) {
            int neighborhood = 0;
            for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) for (int dz = -1; dz <= 1; dz++) {
                neighborhood += cellCounts.getOrDefault(
                    new Cell(candidate.x + dx, candidate.y + dy, candidate.z + dz), 0);
            }
            double distance = candidate.x * candidate.x + candidate.y * candidate.y + candidate.z * candidate.z;
            if (neighborhood > bestCount || neighborhood == bestCount && distance < bestDistance) {
                best = candidate; bestCount = neighborhood; bestDistance = distance;
            }
        }

        double[] low = { Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY };
        double[] high = { Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY };
        int homePieces = 0;
        for (PieceFrame frame : frames.values()) {
            Cell candidate = cell(localCenter(frame.center(), origin));
            if (Math.abs(candidate.x - best.x) > 1 || Math.abs(candidate.y - best.y) > 1 ||
                    Math.abs(candidate.z - best.z) > 1) continue;
            homePieces++;
            for (int axis = 0; axis < 3; axis++) {
                low[axis] = Math.min(low[axis], frame.low[axis] - origin[axis]);
                high[axis] = Math.max(high[axis], frame.high[axis] - origin[axis]);
            }
        }
        double localLowX = -high[0], localHighX = -low[0];
        low[0] = localLowX; high[0] = localHighX;
        double[] target = {
            (low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2
        };
        return new HomeFrame("densest-cluster", homePieces, target,
            Math.max(boundsRadius(low, high, target), 1.0), low[1]);
    }

    private static Map<Long, PieceFrame> pieceFrames(List<Visual> visuals) {
        Map<Long, PieceFrame> result = new LinkedHashMap<>();
        for (Visual visual : visuals) {
            double[] reach = reach(visual.linear);
            PieceFrame frame = result.computeIfAbsent(visual.zdoIndex, ignored -> new PieceFrame());
            for (int axis = 0; axis < 3; axis++) {
                frame.low[axis] = Math.min(frame.low[axis], visual.center[axis] - reach[axis]);
                frame.high[axis] = Math.max(frame.high[axis], visual.center[axis] + reach[axis]);
            }
        }
        return result;
    }

    private static Cell cell(double[] center) {
        return new Cell((long) Math.floor(center[0] / HOME_CELL_METERS),
            (long) Math.floor(center[1] / HOME_CELL_METERS),
            (long) Math.floor(center[2] / HOME_CELL_METERS));
    }

    private ReleaseReceipt releaseReceipt() throws SQLException {
        try (Connection connection = snapshots.open();
             PreparedStatement statement = connection.prepareStatement(
                 "SELECT snapshot_hash, building_geometry_sha256, piece_geometry_sha256, " +
                 "representation_catalog_sha256, promotion_receipt_sha256 FROM release_metadata");
             ResultSet row = statement.executeQuery()) {
            if (!row.next()) throw new IllegalStateException("Public scene metadata is missing");
            return new ReleaseReceipt(row.getString(1), row.getString(2), row.getString(3),
                row.getString(4), row.getString(5));
        }
    }

    private static Bounds orientedBounds(List<Visual> visuals) {
        double[] low = { Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY };
        double[] high = { Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY };
        for (Visual visual : visuals) {
            double[] reach = reach(visual.linear);
            for (int axis = 0; axis < 3; axis++) {
                low[axis] = Math.min(low[axis], visual.center[axis] - reach[axis]);
                high[axis] = Math.max(high[axis], visual.center[axis] + reach[axis]);
            }
        }
        return new Bounds(low, high);
    }

    private static double[] reach(double[][] linear) {
        double[] result = new double[3];
        for (int row = 0; row < 3; row++) {
            result[row] = (Math.abs(linear[row][0]) + Math.abs(linear[row][1]) + Math.abs(linear[row][2])) / 2;
        }
        return result;
    }

    private static double visualRadius(double[][] linear) { return length(reach(linear)); }

    private static double boundsRadius(double[] low, double[] high, double[] target) {
        double result = 0;
        for (int mask = 0; mask < 8; mask++) {
            double[] corner = {
                (mask & 1) == 0 ? low[0] : high[0],
                (mask & 2) == 0 ? low[1] : high[1],
                (mask & 4) == 0 ? low[2] : high[2]
            };
            result = Math.max(result, length(subtract(corner, target)));
        }
        return result;
    }

    /** Unity Euler: apply Z, then X, then Y; column-vector product Ry * Rx * Rz. */
    static double[][] rotation(double xDegrees, double yDegrees, double zDegrees) {
        double x = Math.toRadians(xDegrees), y = Math.toRadians(yDegrees), z = Math.toRadians(zDegrees);
        double cx = Math.cos(x), sx = Math.sin(x);
        double cy = Math.cos(y), sy = Math.sin(y);
        double cz = Math.cos(z), sz = Math.sin(z);
        double[][] rx = {{1,0,0},{0,cx,-sx},{0,sx,cx}};
        double[][] ry = {{cy,0,sy},{0,1,0},{-sy,0,cy}};
        double[][] rz = {{cz,-sz,0},{sz,cz,0},{0,0,1}};
        return multiply(multiply(ry, rx), rz);
    }

    private static double[][] axisRotation(String axis, double degrees) {
        if ("x".equals(axis)) return rotation(degrees, 0, 0);
        if ("y".equals(axis)) return rotation(0, degrees, 0);
        return rotation(0, 0, degrees);
    }

    private static double[][] identity() { return new double[][] {{1,0,0},{0,1,0},{0,0,1}}; }

    private static double[][] diagonal(double[] values) {
        return new double[][] {{values[0],0,0},{0,values[1],0},{0,0,values[2]}};
    }

    private static double[][] multiply(double[][] a, double[][] b) {
        double[][] result = new double[3][3];
        for (int row = 0; row < 3; row++) for (int column = 0; column < 3; column++) {
            for (int k = 0; k < 3; k++) result[row][column] += a[row][k] * b[k][column];
        }
        return result;
    }

    private static double[] multiply(double[][] matrix, double[] vector) {
        return new double[] {
            matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
            matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
            matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2]
        };
    }

    private static double[] add(double[] a, double[] b) {
        return new double[] { a[0] + b[0], a[1] + b[1], a[2] + b[2] };
    }

    private static double[] subtract(double[] a, double[] b) {
        return new double[] { a[0] - b[0], a[1] - b[1], a[2] - b[2] };
    }

    private static double[] localCenter(double[] center, double[] origin) {
        return new double[] { -(center[0] - origin[0]), center[1] - origin[1], center[2] - origin[2] };
    }

    private static double[][] mirrorX(double[][] matrix) {
        double[] mirror = {-1, 1, 1};
        double[][] result = new double[3][3];
        for (int row = 0; row < 3; row++) for (int column = 0; column < 3; column++) {
            result[row][column] = mirror[row] * matrix[row][column] * mirror[column];
        }
        return result;
    }

    private static void putModel(ByteBuffer buffer, double[][] linear, double[] center) {
        for (int column = 0; column < 4; column++) for (int row = 0; row < 4; row++) {
            double value;
            if (column < 3 && row < 3) value = linear[row][column];
            else if (column == 3 && row < 3) value = center[row];
            else value = column == 3 && row == 3 ? 1 : 0;
            buffer.putFloat((float) value);
        }
    }

    private static int align4(int value) { return (value + 3) & ~3; }
    private static double length(double[] value) {
        return Math.sqrt(value[0] * value[0] + value[1] * value[1] + value[2] * value[2]);
    }
    private static double round(double value, int places) {
        double scale = Math.pow(10, places);
        return Math.round(value * scale) / scale;
    }
    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static String color(String family) {
        return FAMILY_COLORS.getOrDefault(family, FAMILY_COLORS.get("misc"));
    }

    private static float[] hexColor(String value) {
        return new float[] {
            Integer.parseInt(value.substring(1, 3), 16) / 255f,
            Integer.parseInt(value.substring(3, 5), 16) / 255f,
            Integer.parseInt(value.substring(5, 7), 16) / 255f,
            1f
        };
    }

    private static Map<String, String> familyColors() {
        LinkedHashMap<String, String> result = new LinkedHashMap<>();
        result.put("wall", "#9e9e9e"); result.put("roof", "#c0392b");
        result.put("floor", "#79553d"); result.put("door", "#27ae60");
        result.put("gate", "#16a085"); result.put("window", "#29b6f6");
        result.put("stair", "#e67e22"); result.put("beam", "#6d4c41");
        result.put("pole", "#8d6e63"); result.put("fence", "#a1887f");
        result.put("light", "#f1c40f"); result.put("seat", "#9b59b6");
        result.put("table", "#8e44ad"); result.put("bed", "#ba68c8");
        result.put("container", "#af7ac5"); result.put("portal", "#00e5ff");
        result.put("sign", "#fff176"); result.put("item_stand", "#ce93d8");
        result.put("ballista", "#ff8a65"); result.put("unknown", "#ff5b62");
        result.put("context", "#70d29a"); result.put("misc", "#cfd8dc");
        return Map.copyOf(result);
    }

    private static void validateBounds(double minX, double maxX, double minZ, double maxZ) {
        if (!Double.isFinite(minX) || !Double.isFinite(maxX) || !Double.isFinite(minZ) ||
                !Double.isFinite(maxZ) || minX >= maxX || minZ >= maxZ) {
            throw new IllegalArgumentException("Invalid selection bounds");
        }
    }

    public record Result(byte[] bytes, ObjectNode manifest, int pieces, int renderInstances) {}

    public static final class CapacityException extends IllegalArgumentException {
        private final boolean overrideAvailable;
        CapacityException(boolean overrideAvailable, String message) {
            super(message); this.overrideAvailable = overrideAvailable;
        }
        public boolean overrideAvailable() { return overrideAvailable; }
    }

    private enum Kind { MEASURED, COMPOUND, ESTIMATED, PIVOT, CONTEXT }
    private record Primitive(int ordinal, boolean animated, double[] matrix) {}
    private record Representation(String semanticClass, String strategy, String authority,
            boolean defaultVisible, double markerAxis, int primitiveCount,
            String animationAxis, double[] animationPivot) {}
    private record RndCandidate(String prefabName, Representation representation, List<Primitive> primitives) {}
    private record Piece(long zdoIndex, int prefabHash, String prefabName, String family,
            String geometrySource, double[] extents, double[] centerOffset,
            double[][] rotation, double[] pivot, Representation representation) {}
    private record Visual(long zdoIndex, String group, String semanticClass, boolean defaultVisible,
            String color, double[][] linear, double[] center, Kind kind) {}
    private record Cell(long x, long y, long z) {}
    private record HomeFrame(String strategy, int pieces, double[] target, double radius, double floorY) {}
    private record ReleaseReceipt(String snapshotHash, String buildingGeometrySha256,
            String pieceGeometrySha256, String representationCatalogSha256,
            String promotionReceiptSha256) {}
    private record Bounds(double[] low, double[] high) {
        double[] center() {
            return new double[] {
                (low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2
            };
        }
    }

    private static final class Coverage {
        private int measuredEnvelope;
        private int runtimeCompoundProxy;
        private int estimatedEnvelope;
        private int pivotMarker;
        private int contextMarkers;
        private int hiddenContextPieces;
        private int unresolvedCompoundMarkers;
        private int outlierMarkers;
        private int compoundBudgetMarkers;
    }

    private static final class GroupBuilder {
        private final String name;
        private final String color;
        private final String semanticClass;
        private final boolean defaultVisible;
        private final List<Visual> visuals = new ArrayList<>();
        private final Set<Long> pieceIds = new HashSet<>();
        private int start;
        private GroupBuilder(String name, String color, String semanticClass, boolean defaultVisible) {
            this.name = name; this.color = color; this.semanticClass = semanticClass;
            this.defaultVisible = defaultVisible;
        }
    }

    private static final class PieceFrame {
        private final double[] low = { Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY };
        private final double[] high = { Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY, Double.NEGATIVE_INFINITY };
        private double[] center() {
            return new double[] {
                (low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2
            };
        }
    }
}
