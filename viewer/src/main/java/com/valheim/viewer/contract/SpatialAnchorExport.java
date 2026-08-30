package com.valheim.viewer.contract;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Contract DTO for SpatialAnchor/v1 export from StewardView design geometry into comfy-quest format.
 *
 * Rules:
 * - Geometry is relative to a local reference frame (e.g. structure:village_01).
 * - Never contains absolute world coordinates in frame or local_bounds.
 * - Binding is resolved into world space at runtime by ComfyQuestRuntime.
 */
public class SpatialAnchorExport {

    @JsonProperty("anchor_id")
    public String anchorId;

    @JsonProperty("frame")
    public String frame;

    @JsonProperty("local_bounds")
    public LocalBounds localBounds;

    @JsonProperty("world_binding")
    public WorldBinding worldBinding;

    public static class LocalBounds {
        @JsonProperty("center")
        public Vec3 center;

        @JsonProperty("radius_meters")
        public double radiusMeters;

        public LocalBounds() {}

        public LocalBounds(Vec3 center, double radiusMeters) {
            this.center = center;
            this.radiusMeters = radiusMeters;
        }
    }

    public static class WorldBinding {
        @JsonProperty("mode")
        public String mode;

        @JsonProperty("reference")
        public String reference;

        public WorldBinding() {}

        public WorldBinding(String mode, String reference) {
            this.mode = mode;
            this.reference = reference;
        }
    }

    public SpatialAnchorExport() {}

    public SpatialAnchorExport(String anchorId, String frame, Vec3 localCenter, double radiusMeters, String bindingMode, String reference) {
        this.anchorId = anchorId;
        this.frame = frame;
        this.localBounds = new LocalBounds(localCenter, radiusMeters);
        this.worldBinding = new WorldBinding(bindingMode, reference);
    }
}
