package com.valheim.viewer.contract;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.valheim.viewer.db.AnalyticsCacheReader;
import com.valheim.viewer.db.QuestEvidenceStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SpatialExchangeContractTest {

    private static final String ANCHOR_HASH =
        "0d46982b8031537cbb1b452e25713007223be885300aeba26a3f28b24ef074ca";
    private static final String EVIDENCE_HASH =
        "cb90445ab11832cd55f3307487a3c5a7047b3f2461f72180847983c595b44430";
    private static final String EDGE_ANCHOR_HASH =
        "064f8d44e15f020ed985e89cfd97d9bf6065513181c9b399620b0cfd86dcad4f";

    @TempDir
    Path tempDir;

    @Test
    void anchorHashMatchesTheQuestConsumerFixture() throws Exception {
        SpatialAnchorExport.SpatialAnchorRequest request =
            SpatialAnchorExport.parseRequest("""
                {
                  "snapshot_id": 42,
                  "zdo_index": 17,
                  "anchor_id": "hearth-sphere",
                  "mode": "world",
                  "radius_meters": 12.5
                }
                """);
        SpatialAnchorExport value = SpatialAnchorExport.fromSnapshot(
            request,
            new AnalyticsCacheReader.SnapshotInfo(42, "ComfyEra16", "dictionary", "a".repeat(64)),
            new AnalyticsCacheReader.ZdoInfo(17, "piece_hearth", 100, 32.5, -200),
            "b".repeat(40));

        assertEquals(ANCHOR_HASH, value.contentSha256);
        assertEquals(ANCHOR_HASH, SpatialAnchorExport.computeHash(value));
        assertEquals(32.5, value.piece.position.y);

        SpatialAnchorExport.ContractException unknown = assertThrows(
            SpatialAnchorExport.ContractException.class,
            () -> SpatialAnchorExport.parseRequest("""
                {"snapshot_id":42,"zdo_index":17,"anchor_id":"hearth-sphere",
                 "mode":"world","radius_meters":12.5,"center_x":100}
                """));
        assertEquals("anchor_request_json_invalid", unknown.code());
    }

    @Test
    void numericHashMatchesQuestAtDecimalAndSignedZeroEdges() throws Exception {
        SpatialAnchorExport.SpatialAnchorRequest request =
            SpatialAnchorExport.parseRequest("""
                {"snapshot_id":42,"zdo_index":17,"anchor_id":"numeric-edge",
                 "mode":"world","radius_meters":1}
                """);
        SpatialAnchorExport value = SpatialAnchorExport.fromSnapshot(
            request,
            new AnalyticsCacheReader.SnapshotInfo(42, "ComfyEra16", "dictionary", "a".repeat(64)),
            new AnalyticsCacheReader.ZdoInfo(17, "piece_hearth", 0.0001, -0.0d, 10_500),
            "b".repeat(40));

        assertEquals("0000000000000000", SpatialAnchorExport.number(-0.0d));
        assertEquals(EDGE_ANCHOR_HASH, value.contentSha256);
    }

    @Test
    void evidenceHashDistanceAndDedicatedPersistenceMatchQuest() throws Exception {
        String json = evidenceJson();
        SpatialEvidenceContract.Bundle parsed = SpatialEvidenceContract.parse(json);
        assertEquals(EVIDENCE_HASH, SpatialEvidenceContract.computeHash(parsed));
        assertEquals(35.5, parsed.records.get(0).observedPosition.y);

        SpatialEvidenceContract.ContractException badDistance = assertThrows(
            SpatialEvidenceContract.ContractException.class,
            () -> SpatialEvidenceContract.parse(
                json.replace("\"distance_meters\": 5", "\"distance_meters\": 4")));
        assertEquals("evidence_record_invalid", badDistance.code());

        Path evidencePath = tempDir.resolve("quest-evidence.duckdb");
        try (QuestEvidenceStore store = new QuestEvidenceStore(evidencePath.toFile())) {
            QuestEvidenceStore.ImportReceipt first = store.importJson(json);
            QuestEvidenceStore.ImportReceipt second = store.importJson(json);
            assertFalse(first.alreadyPresent());
            assertTrue(second.alreadyPresent());
            assertEquals(1, first.recordCount());

            AnalyticsCacheReader.SnapshotInfo snapshot = new AnalyticsCacheReader.SnapshotInfo(
                42, "ComfyEra16", "dictionary", "a".repeat(64));
            ObjectMapper mapper = new ObjectMapper();
            JsonNode overlays = store.overlays(mapper, snapshot);
            assertEquals(1, overlays.path("total").asInt());
            assertEquals(42, overlays.path("snapshotId").asLong());
            assertEquals("a".repeat(64), overlays.path("snapshotFileSha256").asText());
            JsonNode row = overlays.path("data").get(0);
            assertEquals("area-hearth-sphere", row.path("areaId").asText());
            assertEquals(1, row.path("currentCount").asInt());
            assertEquals(1, row.path("requiredCount").asInt());
            assertEquals(32.5, row.path("resolvedCenter").path("y").asDouble());
            assertEquals(35.5, row.path("observedPosition").path("y").asDouble());
            assertEquals(5.0, row.path("distanceMeters").asDouble());
            assertTrue(row.path("satisfied").asBoolean());

            JsonNode reusedId = store.overlays(new ObjectMapper(),
                new AnalyticsCacheReader.SnapshotInfo(
                    42, "ComfyEra16", "dictionary", "e".repeat(64)));
            assertEquals(0, reusedId.path("total").asInt());
            assertEquals(0, reusedId.path("data").size());

            store.importJson(countEvidenceJson());
            JsonNode countedOverlays = store.overlays(mapper, snapshot);
            assertEquals(2, countedOverlays.path("total").asInt());
            JsonNode countRow = null;
            for (JsonNode candidate : countedOverlays.path("data")) {
                if ("count_in_area".equals(candidate.path("predicate").asText())) {
                    countRow = candidate;
                    break;
                }
            }
            assertTrue(countRow != null);
            assertEquals(2, countRow.path("currentCount").asInt());
            assertEquals(3, countRow.path("requiredCount").asInt());
            assertTrue(countRow.path("observedPosition").isNull());
            assertTrue(countRow.path("distanceMeters").isNull());
        }
        assertTrue(evidencePath.toFile().isFile());
    }

    @Test
    void pointOnlyRehearsalStoreMigratesBeforeCountEvidenceIsInserted() throws Exception {
        Path evidencePath = tempDir.resolve("point-only-evidence.duckdb");
        Class.forName("org.duckdb.DuckDBDriver");
        try (Connection conn = DriverManager.getConnection(
                "jdbc:duckdb:" + evidencePath.toAbsolutePath());
             Statement st = conn.createStatement()) {
            st.executeUpdate(
                "CREATE TABLE quest_spatial_evidence (" +
                "bundle_sha256 VARCHAR NOT NULL, record_index INTEGER NOT NULL, " +
                "receipt_id VARCHAR NOT NULL, at_utc VARCHAR NOT NULL, " +
                "correlation_id VARCHAR, transition_id VARCHAR, event_name VARCHAR, " +
                "area_id VARCHAR NOT NULL, predicate VARCHAR NOT NULL, anchor_sha256 VARCHAR NOT NULL, " +
                "snapshot_id BIGINT NOT NULL, snapshot_world_id VARCHAR NOT NULL, " +
                "snapshot_file_sha256 VARCHAR NOT NULL, zdo_index INTEGER NOT NULL, " +
                "prefab VARCHAR NOT NULL, piece_x DOUBLE NOT NULL, piece_y DOUBLE NOT NULL, " +
                "piece_z DOUBLE NOT NULL, center_x DOUBLE NOT NULL, center_y DOUBLE NOT NULL, " +
                "center_z DOUBLE NOT NULL, radius_meters DOUBLE NOT NULL, " +
                "observed_x DOUBLE NOT NULL, observed_y DOUBLE NOT NULL, observed_z DOUBLE NOT NULL, " +
                "distance_meters DOUBLE, satisfied BOOLEAN NOT NULL, " +
                "PRIMARY KEY (bundle_sha256, record_index))");
        }
        try (QuestEvidenceStore store = new QuestEvidenceStore(evidencePath.toFile())) {
            QuestEvidenceStore.ImportReceipt receipt = store.importJson(countEvidenceJson());
            assertEquals(1, receipt.recordCount());
            JsonNode overlays = store.overlays(new ObjectMapper(),
                new AnalyticsCacheReader.SnapshotInfo(
                    42, "ComfyEra16", "dictionary", "a".repeat(64)));
            assertEquals(1, overlays.path("total").asInt());
            assertTrue(overlays.path("data").get(0).path("observedPosition").isNull());
        }
    }

    @Test
    void evidenceParserRejectsUnknownMembersAndTampering() {
        String json = evidenceJson();
        SpatialEvidenceContract.ContractException oversized = assertThrows(
            SpatialEvidenceContract.ContractException.class,
            () -> SpatialEvidenceContract.parse(
                " ".repeat(SpatialEvidenceContract.MAX_DOCUMENT_BYTES + 1)));
        assertEquals("evidence_document_size", oversized.code());

        SpatialEvidenceContract.ContractException unknown = assertThrows(
            SpatialEvidenceContract.ContractException.class,
            () -> SpatialEvidenceContract.parse(
                json.replace("\"area_id\":", "\"unexpected\": true, \"area_id\":")));
        assertEquals("evidence_json_invalid", unknown.code());

        SpatialEvidenceContract.ContractException hash = assertThrows(
            SpatialEvidenceContract.ContractException.class,
            () -> SpatialEvidenceContract.parse(
                json.replace("\"predicate\": \"within_radius\"",
                    "\"predicate\": \"entered\"")));
        assertEquals("evidence_hash_mismatch", hash.code());
    }

    private static String evidenceJson() {
        return """
            {
              "schema": "comfy-quest-spatial-evidence/v1",
              "exported_utc": "2026-08-30T12:01:00+00:00",
              "project_id": "project",
              "experience_id": "experience",
              "pack_id": "pack",
              "content_hash": "%s",
              "activation_id": "activation",
              "run_id": "run",
              "world_uid": "world",
              "records": [
                {
                  "receipt_id": "receipt-1",
                  "at_utc": "2026-08-30T12:00:00+00:00",
                  "correlation_id": "correlation-1",
                  "transition_id": "finish",
                  "event_name": "piece_damaged",
                  "area_id": "area-hearth-sphere",
                  "predicate": "within_radius",
                  "current_count": 1,
                  "required_count": 1,
                  "anchor_sha256": "%s",
                  "snapshot": {
                    "snapshot_id": 42,
                    "world_id": "ComfyEra16",
                    "file_sha256": "%s"
                  },
                  "piece": {
                    "zdo_index": 17,
                    "prefab": "piece_hearth",
                    "position": {"x": 100, "y": 32.5, "z": -200}
                  },
                  "resolved_center": {"x": 100, "y": 32.5, "z": -200},
                  "radius_meters": 5,
                  "observed_position": {"x": 100, "y": 35.5, "z": -196},
                  "distance_meters": 5,
                  "satisfied": true
                }
              ],
              "content_sha256": "%s"
            }
            """.formatted("d".repeat(64), "c".repeat(64), "a".repeat(64), EVIDENCE_HASH);
    }

    private static String countEvidenceJson() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        SpatialEvidenceContract.Bundle counted = mapper.readValue(
            evidenceJson(), SpatialEvidenceContract.Bundle.class);
        SpatialEvidenceContract.Record record = counted.records.get(0);
        record.receiptId = "receipt-count";
        record.atUtc = "2026-08-30T12:00:01+00:00";
        record.predicate = "count_in_area";
        record.currentCount = 2;
        record.requiredCount = 3;
        record.observedPosition = null;
        record.distanceMeters = null;
        record.satisfied = false;
        counted.contentSha256 = SpatialEvidenceContract.computeHash(counted);
        return mapper.writeValueAsString(counted);
    }
}
