package com.valheim.viewer.db;

/**
 * Immutable data model representing provenance metadata for a world save snapshot ingest.
 */
public record SnapshotProvenance(
        String worldId,
        String worldName,
        String source,
        String backupId,
        String saveTimestamp,
        String fileHash,
        String parserVersion,
        int schemaVersion
) {
    /**
     * 1.1.0 classifies dictionary-confirmed construction pieces as BUILDING regardless of whether
     * the ZDO carries a creator field. Snapshots ingested under 1.0.0 hold the old categories
     * until they are re-ingested, so a pair spanning the two versions under-counts the removed
     * channel of build-activity; {@code world_snapshot.parser_version} is how that is detected.
     */
    public static final String DEFAULT_PARSER_VERSION = "1.1.0";
    /** 3 adds world_snapshot.prefab_dictionary_version / prefab_dictionary_entries. */
    public static final int CURRENT_SCHEMA_VERSION = 3;

    public SnapshotProvenance {
        if (worldId == null || worldId.isBlank()) {
            worldId = "default";
        }
        if (worldName == null || worldName.isBlank()) {
            worldName = worldId;
        }
        if (source == null || source.isBlank()) {
            source = "local";
        }
        if (backupId == null || backupId.isBlank()) {
            backupId = "bak_manual";
        }
        if (parserVersion == null || parserVersion.isBlank()) {
            parserVersion = DEFAULT_PARSER_VERSION;
        }
        if (schemaVersion <= 0) {
            schemaVersion = CURRENT_SCHEMA_VERSION;
        }
    }
}
