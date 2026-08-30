package com.valheim.viewer.contract;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.valheim.viewer.db.AnalyticsCacheReader;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Strict, content-addressed handoff from one real Steward snapshot row to Quest Studio.
 * Browser-supplied coordinates are deliberately absent: the API resolves all geometry from
 * {@code world_snapshot} and {@code zdo} before constructing this document.
 */
@JsonIgnoreProperties(ignoreUnknown = false)
public final class SpatialAnchorExport {

    public static final String SCHEMA = "comfy-quest-spatial-anchor/v1";
    public static final int MAX_DOCUMENT_BYTES = 256 * 1024;
    public static final double MIN_RADIUS_METERS = 1.0;
    public static final double MAX_RADIUS_METERS = 100.0;
    public static final double MAX_WORLD_COORDINATE = 10_500.0;

    private static final Pattern STABLE_ID = Pattern.compile("^[A-Za-z0-9_$-]{1,64}$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-fA-F]{64}$");
    private static final Pattern REVISION = Pattern.compile("^[0-9a-fA-F]{40}$");
    private static final ObjectMapper STRICT_MAPPER = new ObjectMapper()
        .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
        .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    @JsonProperty("schema")
    public String schema = SCHEMA;

    @JsonProperty("anchor_id")
    public String anchorId;

    @JsonProperty("mode")
    public String mode;

    @JsonProperty("shape")
    public String shape = "sphere";

    @JsonProperty("radius_meters")
    public double radiusMeters;

    @JsonProperty("snapshot")
    public SnapshotReference snapshot;

    @JsonProperty("piece")
    public PieceReference piece;

    @JsonProperty("producer")
    public ProducerReference producer;

    @JsonProperty("content_sha256")
    public String contentSha256;

    public SpatialAnchorExport() {}

    public static SpatialAnchorRequest parseRequest(String json) throws ContractException {
        if (json == null || json.isBlank() ||
                json.getBytes(StandardCharsets.UTF_8).length > MAX_DOCUMENT_BYTES) {
            throw new ContractException("anchor_request_size");
        }
        try {
            SpatialAnchorRequest request = STRICT_MAPPER.readValue(json, SpatialAnchorRequest.class);
            validateRequest(request);
            return request;
        } catch (ContractException e) {
            throw e;
        } catch (Exception e) {
            throw new ContractException("anchor_request_json_invalid", e);
        }
    }

    public static SpatialAnchorExport fromSnapshot(
            SpatialAnchorRequest request,
            AnalyticsCacheReader.SnapshotInfo snapshot,
            AnalyticsCacheReader.ZdoInfo piece,
            String producerRevision) throws ContractException {
        validateRequest(request);
        if (snapshot == null || snapshot.snapshotId() <= 0 ||
                !boundedText(snapshot.worldId(), 128) || !isSha(snapshot.fileHash())) {
            throw new ContractException("anchor_snapshot_provenance_invalid");
        }
        if (piece == null || piece.zdoIndex() < 0 || !boundedText(piece.prefab(), 256) ||
                !coordinate(piece.x()) || !coordinate(piece.y()) || !coordinate(piece.z())) {
            throw new ContractException("anchor_piece_invalid");
        }
        if (producerRevision == null || !REVISION.matcher(producerRevision).matches()) {
            throw new ContractException("source_revision_unavailable");
        }

        SpatialAnchorExport value = new SpatialAnchorExport();
        value.anchorId = request.anchorId;
        value.mode = request.mode;
        value.radiusMeters = request.radiusMeters;
        value.snapshot = new SnapshotReference(
            snapshot.snapshotId(), snapshot.worldId(), snapshot.fileHash().toLowerCase(Locale.ROOT));
        value.piece = new PieceReference(
            piece.zdoIndex(), piece.prefab(), new Point(piece.x(), piece.y(), piece.z()));
        value.producer = new ProducerReference(
            "ComfyStewardView", producerRevision.toLowerCase(Locale.ROOT));
        value.contentSha256 = computeHash(value);
        return value;
    }

    public static String computeHash(SpatialAnchorExport value) throws ContractException {
        if (value == null) throw new ContractException("anchor_required");
        String canonical = String.join("\n",
            empty(value.schema),
            empty(value.anchorId),
            empty(value.mode),
            empty(value.shape),
            number(value.radiusMeters),
            value.snapshot == null ? "" : Long.toString(value.snapshot.snapshotId),
            value.snapshot == null ? "" : empty(value.snapshot.worldId),
            value.snapshot == null ? "" : empty(value.snapshot.fileSha256).toLowerCase(Locale.ROOT),
            value.piece == null ? "" : Integer.toString(value.piece.zdoIndex),
            value.piece == null ? "" : empty(value.piece.prefab),
            value.piece == null || value.piece.position == null ? "" : number(value.piece.position.x),
            value.piece == null || value.piece.position == null ? "" : number(value.piece.position.y),
            value.piece == null || value.piece.position == null ? "" : number(value.piece.position.z),
            value.producer == null ? "" : empty(value.producer.repository),
            value.producer == null ? "" : empty(value.producer.revision).toLowerCase(Locale.ROOT));
        return sha256(canonical);
    }

    private static void validateRequest(SpatialAnchorRequest request) throws ContractException {
        if (request == null || request.snapshotId <= 0 || request.zdoIndex < 0 ||
                request.anchorId == null || !STABLE_ID.matcher(request.anchorId).matches() ||
                !("world".equals(request.mode) || "binding_relative".equals(request.mode)) ||
                !Double.isFinite(request.radiusMeters) ||
                request.radiusMeters < MIN_RADIUS_METERS ||
                request.radiusMeters > MAX_RADIUS_METERS) {
            throw new ContractException("anchor_request_invalid");
        }
    }

    private static boolean boundedText(String value, int max) {
        if (value == null || value.isBlank() || value.length() > max) return false;
        return value.chars().noneMatch(Character::isISOControl);
    }

    private static boolean coordinate(double value) {
        return Double.isFinite(value) && Math.abs(value) <= MAX_WORLD_COORDINATE;
    }

    private static boolean isSha(String value) {
        return value != null && SHA256.matcher(value).matches();
    }

    /** Cross-runtime numeric canonicalization shared with Quest's .NET consumer. */
    public static String number(double value) throws ContractException {
        if (!Double.isFinite(value)) throw new ContractException("number_invalid");
        if (value == 0.0d) return "0000000000000000";
        return String.format(Locale.ROOT, "%016x", Double.doubleToRawLongBits(value));
    }

    public static String sha256(String value) throws ContractException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new ContractException("sha256_unavailable", e);
        }
    }

    public static String empty(String value) {
        return value == null ? "" : value;
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public static final class SpatialAnchorRequest {
        @JsonProperty("snapshot_id") public long snapshotId;
        @JsonProperty("zdo_index") public int zdoIndex = -1;
        @JsonProperty("anchor_id") public String anchorId;
        @JsonProperty("mode") public String mode;
        @JsonProperty("radius_meters") public double radiusMeters;
        public SpatialAnchorRequest() {}
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public static final class SnapshotReference {
        @JsonProperty("snapshot_id") public long snapshotId;
        @JsonProperty("world_id") public String worldId;
        @JsonProperty("file_sha256") public String fileSha256;
        public SnapshotReference() {}
        public SnapshotReference(long snapshotId, String worldId, String fileSha256) {
            this.snapshotId = snapshotId;
            this.worldId = worldId;
            this.fileSha256 = fileSha256;
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public static final class PieceReference {
        @JsonProperty("zdo_index") public int zdoIndex;
        @JsonProperty("prefab") public String prefab;
        @JsonProperty("position") public Point position;
        public PieceReference() {}
        public PieceReference(int zdoIndex, String prefab, Point position) {
            this.zdoIndex = zdoIndex;
            this.prefab = prefab;
            this.position = position;
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public static final class ProducerReference {
        @JsonProperty("repository") public String repository;
        @JsonProperty("revision") public String revision;
        public ProducerReference() {}
        public ProducerReference(String repository, String revision) {
            this.repository = repository;
            this.revision = revision;
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public static final class Point {
        @JsonProperty("x") public double x;
        @JsonProperty("y") public double y;
        @JsonProperty("z") public double z;
        public Point() {}
        public Point(double x, double y, double z) {
            this.x = x;
            this.y = y;
            this.z = z;
        }
    }

    public static final class ContractException extends Exception {
        private final String code;
        public ContractException(String code) { super(code); this.code = code; }
        public ContractException(String code, Throwable cause) {
            super(code, cause);
            this.code = code;
        }
        public String code() { return code; }
    }
}
