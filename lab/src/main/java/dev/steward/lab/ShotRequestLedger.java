package dev.steward.lab;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Locale;

/**
 * A viewer's camera, turned into the one row the capture mod understands, appended to a ledger.
 *
 * The scene page knows a camera in selection-local, X-mirrored coordinates; the mod wants the
 * player's feet in absolute world metres plus yaw (degrees clockwise from +Z) and pitch (degrees,
 * positive looking down), and an aim point. That conversion is done here, once, in the same
 * conventions as ComfyStewardView/tools/era-archive/refine_worker.py, so a requested pose and a
 * shot receipt are comparable metre for metre. Nothing here talks to the capture host: the ledger
 * is a file an operator-run session reads later, and the row it carries is the request.
 */
public final class ShotRequestLedger {
    /** Height of the lens above the placed feet, as the receipts measure it (lens_offset_m). */
    static final double EYE_HEIGHT_M = 1.65;
    /** A camera this far outside the build's exact bounds is not a photograph of the build. */
    static final double MAX_OUTSIDE_M = 150.0;
    static final double MIN_RANGE_M = 4.0, MAX_RANGE_M = 250.0;
    static final int MAX_NOTE = 280;

    public record Request(String era, String build, long snapshot, double[] origin, double[] eye,
                          double[] forward, double fov, String note, boolean identify, String website) {}

    public record Bounds(double minX, double maxX, double minY, double maxY, double minZ, double maxZ, long pieces) {
        double[] center() { return new double[] {(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2}; }
    }

    public record Row(String id, String tsv, double[] feet, double[] lens, double[] aim, double yaw, double pitch) {}

    private final Path file;
    private final ObjectMapper mapper;

    public ShotRequestLedger(Path file, ObjectMapper mapper) {
        this.file = file;
        this.mapper = mapper;
    }

    public boolean enabled() { return file != null; }

    /** Validate and convert; throws IllegalArgumentException with a message safe to show. */
    public static Row toRow(Request request, Bounds bounds) {
        if (request.website() != null && !request.website().isBlank()) {
            throw new IllegalArgumentException("The request could not be submitted");
        }
        if (request.build() == null || !request.build().matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("A build key is required");
        }
        if (bounds == null || bounds.pieces() <= 0) throw new IllegalArgumentException("The build has no published pieces");
        double[] origin = vector(request.origin(), "origin"), eye = vector(request.eye(), "eye"), fwd = vector(request.forward(), "forward");
        // Scene-local is right-handed with X mirrored: local = [-(x-ox), y-oy, z-oz]; undo it.
        double[] lens = {origin[0] - eye[0], origin[1] + eye[1], origin[2] + eye[2]};
        double[] forward = {-fwd[0], fwd[1], fwd[2]};
        double length = Math.sqrt(forward[0] * forward[0] + forward[1] * forward[1] + forward[2] * forward[2]);
        if (!(length > 1e-6)) throw new IllegalArgumentException("The camera has no direction");
        for (int i = 0; i < 3; i++) forward[i] /= length;
        if (lens[0] < bounds.minX() - MAX_OUTSIDE_M || lens[0] > bounds.maxX() + MAX_OUTSIDE_M
                || lens[2] < bounds.minZ() - MAX_OUTSIDE_M || lens[2] > bounds.maxZ() + MAX_OUTSIDE_M
                || lens[1] < bounds.minY() - MAX_OUTSIDE_M || lens[1] > bounds.maxY() + MAX_OUTSIDE_M) {
            throw new IllegalArgumentException("The camera is too far from this build to be a photograph of it");
        }
        double[] center = bounds.center();
        double range = Math.sqrt(sq(lens[0] - center[0]) + sq(lens[1] - center[1]) + sq(lens[2] - center[2]));
        range = Math.max(MIN_RANGE_M, Math.min(MAX_RANGE_M, range));
        // The aim is where the view ray reaches the build's range: what the photographer was looking at.
        double[] aim = {lens[0] + forward[0] * range, lens[1] + forward[1] * range, lens[2] + forward[2] * range};
        double[] feet = {lens[0], lens[1] - EYE_HEIGHT_M, lens[2]};
        // plan_shots.camera_for / refine_worker.look_angles: yaw clockwise from +Z, pitch positive down.
        double dx = aim[0] - feet[0], dy = aim[1] - feet[1], dz = aim[2] - feet[2];
        double n = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (!(n > 1e-6)) throw new IllegalArgumentException("The camera has no aim");
        double yaw = (Math.toDegrees(Math.atan2(dx, dz)) + 360.0) % 360.0;
        double pitch = Math.toDegrees(-Math.asin(Math.max(-1.0, Math.min(1.0, dy / n))));
        String id = id(request, lens);
        String tsv = String.join("\t",
            "0", "request-" + id,
            fmt(feet[0], 1), fmt(feet[1], 1), fmt(feet[2], 1),
            fmt(yaw, 2), fmt(pitch, 2), "Clear", "0.64",
            fmt(aim[0], 1), fmt(aim[1], 1), fmt(aim[2], 1),
            "Request " + id, "", "0", "");
        return new Row(id, tsv, feet, lens, aim, round(yaw, 2), round(pitch, 2));
    }

    /** Append one ledger line; returns the JSON written. */
    public synchronized ObjectNode append(Request request, Row row, String requestedBy, String release) throws IOException {
        if (!enabled()) throw new IllegalStateException("Shot requests are not enabled here");
        ObjectNode line = mapper.createObjectNode();
        line.put("schema", "steward-shot-request/v1");
        line.put("id", row.id());
        line.put("at", Instant.now().toString());
        line.put("era", request.era());
        line.put("build", request.build());
        line.put("snapshot", request.snapshot());
        line.put("requestedBy", requestedBy == null ? "Anonymous" : requestedBy);
        String note = request.note() == null ? "" : request.note().trim();
        if (note.length() > MAX_NOTE) note = note.substring(0, MAX_NOTE);
        line.put("note", note);
        ObjectNode camera = line.putObject("camera");
        camera.putArray("lens").add(round(row.lens()[0], 3)).add(round(row.lens()[1], 3)).add(round(row.lens()[2], 3));
        camera.putArray("aim").add(round(row.aim()[0], 3)).add(round(row.aim()[1], 3)).add(round(row.aim()[2], 3));
        camera.put("yaw", row.yaw());
        camera.put("pitch", row.pitch());
        camera.put("fov", request.fov() > 0 ? request.fov() : 65.0);
        line.put("tsv", row.tsv());
        line.put("release", release == null ? "" : release);
        Files.createDirectories(file.toAbsolutePath().getParent());
        Files.writeString(file, mapper.writeValueAsString(line) + "\n", StandardCharsets.UTF_8,
            StandardOpenOption.CREATE, StandardOpenOption.APPEND, StandardOpenOption.WRITE);
        return line;
    }

    private static String id(Request request, double[] lens) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            String seed = request.era() + ":" + request.build() + ":" + fmt(lens[0], 2) + "," + fmt(lens[1], 2) + ","
                + fmt(lens[2], 2) + ":" + Instant.now().toEpochMilli();
            return HexFormat.of().formatHex(digest.digest(seed.getBytes(StandardCharsets.UTF_8))).substring(0, 12);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static double[] vector(double[] value, String name) {
        if (value == null || value.length != 3) throw new IllegalArgumentException("A camera " + name + " is required");
        for (double component : value) {
            if (!Double.isFinite(component)) throw new IllegalArgumentException("The camera " + name + " is not a number");
        }
        return value;
    }

    private static double sq(double value) { return value * value; }
    private static double round(double value, int places) {
        double scale = Math.pow(10, places);
        return Math.round(value * scale) / scale;
    }
    private static String fmt(double value, int places) {
        return String.format(Locale.ROOT, "%." + places + "f", value);
    }
}
