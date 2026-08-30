package com.valheim.viewer.contract;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.temporal.ChronoField;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/** Strict consumer for Quest Studio's bounded runtime observation bundle. */
public final class SpatialEvidenceContract {

    public static final String SCHEMA = "comfy-quest-spatial-evidence/v1";
    public static final int MAX_DOCUMENT_BYTES = 256 * 1024;
    private static final int MAX_RECORDS = 512;
    private static final Pattern STABLE_ID = Pattern.compile("^[A-Za-z0-9_$-]{1,64}$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-fA-F]{64}$");
    private static final Set<String> PREDICATES = Set.of(
        "within_radius", "entered", "left", "remained", "count_in_area");
    private static final ObjectMapper STRICT_MAPPER = new ObjectMapper()
        .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
        .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final DateTimeFormatter ROUND_TRIP_UTC = new DateTimeFormatterBuilder()
        .appendPattern("uuuu-MM-dd'T'HH:mm:ss")
        .appendLiteral('.')
        .appendFraction(ChronoField.NANO_OF_SECOND, 7, 7, false)
        .appendOffset("+HH:MM", "+00:00")
        .toFormatter(Locale.ROOT);

    private SpatialEvidenceContract() {}

    public static Bundle parse(String json) throws ContractException {
        if (json == null || json.isBlank() ||
                json.getBytes(StandardCharsets.UTF_8).length > MAX_DOCUMENT_BYTES) {
            throw new ContractException("evidence_document_size");
        }
        Bundle value;
        try {
            value = STRICT_MAPPER.readValue(json, Bundle.class);
        } catch (Exception e) {
            throw new ContractException("evidence_json_invalid", e);
        }
        validate(value, true);
        return value;
    }

    public static void validate(Bundle value, boolean verifyHash) throws ContractException {
        if (value == null || !SCHEMA.equals(value.schema) ||
                !date(value.exportedUtc) || !boundedText(value.projectId, 80) ||
                !stable(value.experienceId) || !stable(value.packId) ||
                !sha(value.contentHash) || !boundedText(value.activationId, 128) ||
                !boundedText(value.runId, 128) || !boundedText(value.worldUid, 64) ||
                value.records == null || value.records.isEmpty() ||
                value.records.size() > MAX_RECORDS) {
            throw new ContractException("evidence_envelope_invalid");
        }
        for (Record item : value.records) validateRecord(item);
        if (verifyHash && (!sha(value.contentSha256) ||
                !value.contentSha256.equalsIgnoreCase(computeHash(value)))) {
            throw new ContractException("evidence_hash_mismatch");
        }
    }

    private static void validateRecord(Record item) throws ContractException {
        if (item == null || !boundedText(item.receiptId, 160) || !date(item.atUtc) ||
                !optionalText(item.correlationId, 160) || !optionalStable(item.transitionId) ||
                !optionalText(item.eventName, 128) || !stable(item.areaId) ||
                !PREDICATES.contains(item.predicate) || item.currentCount == null ||
                item.requiredCount == null || item.currentCount < 0 || item.requiredCount < 1 ||
                item.currentCount > item.requiredCount ||
                item.satisfied == null || item.satisfied != (item.currentCount >= item.requiredCount) ||
                !sha(item.anchorSha256) ||
                !snapshot(item.snapshot) || !piece(item.piece) ||
                !point(item.resolvedCenter) ||
                item.radiusMeters == null || !Double.isFinite(item.radiusMeters) ||
                item.radiusMeters < SpatialAnchorExport.MIN_RADIUS_METERS ||
                item.radiusMeters > SpatialAnchorExport.MAX_RADIUS_METERS) {
            throw new ContractException("evidence_record_invalid");
        }
        boolean counted = "count_in_area".equals(item.predicate);
        if (counted) {
            if (item.observedPosition != null || item.distanceMeters != null) {
                throw new ContractException("evidence_record_invalid");
            }
        } else {
            if (!point(item.observedPosition) || item.distanceMeters == null) {
                throw new ContractException("evidence_record_invalid");
            }
            double actual = distance(item.resolvedCenter, item.observedPosition);
            if (!Double.isFinite(item.distanceMeters) || item.distanceMeters < 0 ||
                    Math.abs(item.distanceMeters - actual) > 0.000001) {
                throw new ContractException("evidence_record_invalid");
            }
        }
    }

    public static String computeHash(Bundle value) throws ContractException {
        if (value == null) throw new ContractException("evidence_required");
        List<String> lines = new ArrayList<>();
        lines.add(value.schema);
        lines.add(canonicalDate(value.exportedUtc));
        lines.add(value.projectId);
        lines.add(value.experienceId);
        lines.add(value.packId);
        lines.add(lower(value.contentHash));
        lines.add(value.activationId);
        lines.add(value.runId);
        lines.add(value.worldUid);
        if (value.records != null) {
            for (Record item : value.records) {
                lines.add(item == null ? "" : item.receiptId);
                lines.add(item == null ? "" : canonicalDate(item.atUtc));
                lines.add(item == null ? "" : item.correlationId);
                lines.add(item == null ? "" : item.transitionId);
                lines.add(item == null ? "" : item.eventName);
                lines.add(item == null ? "" : item.areaId);
                lines.add(item == null ? "" : item.predicate);
                lines.add(item == null || item.currentCount == null
                    ? "" : Integer.toString(item.currentCount));
                lines.add(item == null || item.requiredCount == null
                    ? "" : Integer.toString(item.requiredCount));
                lines.add(item == null ? "" : lower(item.anchorSha256));
                lines.add(item == null || item.snapshot == null || item.snapshot.snapshotId == null
                    ? "" : Long.toString(item.snapshot.snapshotId));
                lines.add(item == null || item.snapshot == null ? "" : item.snapshot.worldId);
                lines.add(item == null || item.snapshot == null ? "" : lower(item.snapshot.fileSha256));
                lines.add(item == null || item.piece == null || item.piece.zdoIndex == null
                    ? "" : Integer.toString(item.piece.zdoIndex));
                lines.add(item == null || item.piece == null ? "" : item.piece.prefab);
                addPoint(lines, item == null || item.piece == null ? null : item.piece.position);
                addPoint(lines, item == null ? null : item.resolvedCenter);
                lines.add(item == null || item.radiusMeters == null
                    ? "" : number(item.radiusMeters));
                addPoint(lines, item == null ? null : item.observedPosition);
                lines.add(item == null || item.distanceMeters == null
                    ? "" : number(item.distanceMeters));
                lines.add(item != null && Boolean.TRUE.equals(item.satisfied) ? "true" : "false");
            }
        }
        for (int i = 0; i < lines.size(); i++) {
            if (lines.get(i) == null) lines.set(i, "");
        }
        return sha256(String.join("\n", lines));
    }

    private static void addPoint(List<String> lines, Point point) throws ContractException {
        lines.add(point == null || point.x == null ? "" : number(point.x));
        lines.add(point == null || point.y == null ? "" : number(point.y));
        lines.add(point == null || point.z == null ? "" : number(point.z));
    }

    private static String number(double value) throws ContractException {
        try {
            return SpatialAnchorExport.number(value);
        } catch (SpatialAnchorExport.ContractException e) {
            throw new ContractException(e.code(), e);
        }
    }

    private static String sha256(String value) throws ContractException {
        try {
            return SpatialAnchorExport.sha256(value);
        } catch (SpatialAnchorExport.ContractException e) {
            throw new ContractException(e.code(), e);
        }
    }

    private static String canonicalDate(String input) throws ContractException {
        try {
            OffsetDateTime parsed = OffsetDateTime.parse(input);
            return ROUND_TRIP_UTC.format(parsed.toInstant().atOffset(ZoneOffset.UTC));
        } catch (Exception e) {
            throw new ContractException("evidence_date_invalid", e);
        }
    }

    private static boolean date(String input) {
        if (input == null) return false;
        try {
            OffsetDateTime value = OffsetDateTime.parse(input);
            return value.getYear() > 1;
        } catch (Exception e) {
            return false;
        }
    }

    private static double distance(Point left, Point right) {
        double x = left.x - right.x;
        double y = left.y - right.y;
        double z = left.z - right.z;
        return Math.sqrt(x * x + y * y + z * z);
    }

    private static boolean snapshot(SnapshotReference value) {
        return value != null && value.snapshotId != null && value.snapshotId > 0 &&
            boundedText(value.worldId, 128) && sha(value.fileSha256);
    }

    private static boolean piece(PieceReference value) {
        return value != null && value.zdoIndex != null && value.zdoIndex >= 0 &&
            boundedText(value.prefab, 256) && point(value.position);
    }

    private static boolean point(Point value) {
        return value != null && coordinate(value.x) && coordinate(value.y) && coordinate(value.z);
    }

    private static boolean coordinate(Double value) {
        return value != null && Double.isFinite(value) &&
            Math.abs(value) <= SpatialAnchorExport.MAX_WORLD_COORDINATE;
    }

    private static boolean stable(String value) {
        return value != null && STABLE_ID.matcher(value).matches();
    }

    private static boolean boundedText(String value, int max) {
        if (value == null || value.isBlank() || value.length() > max) return false;
        return value.chars().noneMatch(Character::isISOControl);
    }

    private static boolean optionalText(String value, int max) {
        return value == null || (value.length() <= max &&
            value.chars().noneMatch(Character::isISOControl));
    }

    private static boolean optionalStable(String value) {
        return value == null || stable(value);
    }

    private static boolean sha(String value) {
        return value != null && SHA256.matcher(value).matches();
    }

    private static String lower(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT);
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public static final class Bundle {
        @JsonProperty("schema") public String schema;
        @JsonProperty("exported_utc") public String exportedUtc;
        @JsonProperty("project_id") public String projectId;
        @JsonProperty("experience_id") public String experienceId;
        @JsonProperty("pack_id") public String packId;
        @JsonProperty("content_hash") public String contentHash;
        @JsonProperty("activation_id") public String activationId;
        @JsonProperty("run_id") public String runId;
        @JsonProperty("world_uid") public String worldUid;
        @JsonProperty("records") public List<Record> records;
        @JsonProperty("content_sha256") public String contentSha256;
        public Bundle() {}
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public static final class Record {
        @JsonProperty("receipt_id") public String receiptId;
        @JsonProperty("at_utc") public String atUtc;
        @JsonProperty("correlation_id") public String correlationId;
        @JsonProperty("transition_id") public String transitionId;
        @JsonProperty("event_name") public String eventName;
        @JsonProperty("area_id") public String areaId;
        @JsonProperty("predicate") public String predicate;
        @JsonProperty("current_count") public Integer currentCount;
        @JsonProperty("required_count") public Integer requiredCount;
        @JsonProperty("anchor_sha256") public String anchorSha256;
        @JsonProperty("snapshot") public SnapshotReference snapshot;
        @JsonProperty("piece") public PieceReference piece;
        @JsonProperty("resolved_center") public Point resolvedCenter;
        @JsonProperty("radius_meters") public Double radiusMeters;
        @JsonProperty("observed_position") public Point observedPosition;
        @JsonProperty("distance_meters") public Double distanceMeters;
        @JsonProperty("satisfied") public Boolean satisfied;
        public Record() {}
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public static final class SnapshotReference {
        @JsonProperty("snapshot_id") public Long snapshotId;
        @JsonProperty("world_id") public String worldId;
        @JsonProperty("file_sha256") public String fileSha256;
        public SnapshotReference() {}
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public static final class PieceReference {
        @JsonProperty("zdo_index") public Integer zdoIndex;
        @JsonProperty("prefab") public String prefab;
        @JsonProperty("position") public Point position;
        public PieceReference() {}
    }

    @JsonIgnoreProperties(ignoreUnknown = false)
    public static final class Point {
        @JsonProperty("x") public Double x;
        @JsonProperty("y") public Double y;
        @JsonProperty("z") public Double z;
        public Point() {}
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
