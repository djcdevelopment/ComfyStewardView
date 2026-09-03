package dev.steward.lab;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

public record LabConfig(
        String mode,
        Path cachePath,
        Path artifactsPath,
        Path contextImage,
        Path contextManifest,
        String bindAddress,
        int port,
        boolean noBrowser,
        long snapshotId,
        List<String> lensIds,
        List<Integer> resolutions,
        boolean force,
        boolean publicMode,
        String publicUrl,
        String releaseVersion,
        Path fidelityGallery,
        Path fidelityReceipts,
        Path fidelityClusters,
        Path fidelityCandidates,
        FeedbackConfig feedback) {

    public static final List<Integer> ALLOWED_RESOLUTIONS = List.of(16, 64, 80, 160, 320, 500, 1000);

    public static LabConfig parse(String[] arguments) {
        List<String> args = new ArrayList<>(Arrays.asList(arguments));
        String mode = !args.isEmpty() && !args.get(0).startsWith("--")
            ? args.remove(0).toLowerCase(Locale.ROOT) : "serve";
        if (!List.of("serve", "render").contains(mode)) {
            throw new IllegalArgumentException("Mode must be serve or render, got: " + mode);
        }

        Path cache = defaultCache();
        Path artifacts = Path.of("data", "artifacts");
        Path context = null;
        Path contextManifest = null;
        String bindAddress = "127.0.0.1";
        int port = 8091;
        boolean noBrowser = false;
        long snapshot = 0;
        List<String> lenses = List.of("build-density", "birch-trees", "all-zdos");
        List<Integer> resolutions = List.of(320, 160, 80, 64, 16);
        boolean force = false;
        boolean publicMode = false;
        String publicUrl = environment("STEWARD_PUBLIC_URL", "");
        String releaseVersion = environment("STEWARD_RELEASE_VERSION", "dev");
        Path fidelityGallery = optionalPath("STEWARD_FIDELITY_GALLERY",
            Path.of("C:/work/baseline/tools/selfie-stick/out/era17/gallery"), true);
        Path fidelityReceipts = optionalPath("STEWARD_FIDELITY_RECEIPTS",
            Path.of("C:/Program Files (x86)/Steam/steamapps/common/Valheim/BepInEx/config/shotplan-receipts.jsonl"), false);
        Path fidelityClusters = optionalPath("STEWARD_FIDELITY_CLUSTERS",
            Path.of("C:/work/baseline/tools/selfie-stick/out/era17/clusters.json"), false);
        Path fidelityCandidates = optionalPath("STEWARD_FIDELITY_CANDIDATES",
            Path.of("tools/prefab-renderer-probe/receipts/windmill-0.221.12.json"), false);

        for (int i = 0; i < args.size(); i++) {
            String arg = args.get(i);
            switch (arg) {
                case "--cache" -> cache = Path.of(requireValue(args, ++i, arg));
                case "--artifacts" -> artifacts = Path.of(requireValue(args, ++i, arg));
                case "--context-image" -> context = Path.of(requireValue(args, ++i, arg));
                case "--context-manifest" -> contextManifest = Path.of(requireValue(args, ++i, arg));
                case "--bind" -> bindAddress = requireValue(args, ++i, arg);
                case "--port" -> port = Integer.parseInt(requireValue(args, ++i, arg));
                case "--snapshot" -> snapshot = Long.parseLong(requireValue(args, ++i, arg));
                case "--lenses" -> lenses = split(requireValue(args, ++i, arg));
                case "--resolutions" -> resolutions = split(requireValue(args, ++i, arg)).stream()
                    .map(Integer::parseInt).toList();
                case "--no-browser" -> noBrowser = true;
                case "--force" -> force = true;
                case "--public" -> publicMode = true;
                case "--public-url" -> publicUrl = requireValue(args, ++i, arg);
                case "--release-version" -> releaseVersion = requireValue(args, ++i, arg);
                case "--fidelity-gallery" -> fidelityGallery = Path.of(requireValue(args, ++i, arg));
                case "--fidelity-receipts" -> fidelityReceipts = Path.of(requireValue(args, ++i, arg));
                case "--fidelity-clusters" -> fidelityClusters = Path.of(requireValue(args, ++i, arg));
                case "--fidelity-candidates" -> fidelityCandidates = Path.of(requireValue(args, ++i, arg));
                default -> throw new IllegalArgumentException("Unknown option: " + arg);
            }
        }

        if (port < 1 || port > 65_535) throw new IllegalArgumentException("Invalid port: " + port);
        for (int resolution : resolutions) {
            if (!ALLOWED_RESOLUTIONS.contains(resolution)) {
                throw new IllegalArgumentException("Unsupported resolution " + resolution +
                    "; choose from " + ALLOWED_RESOLUTIONS);
            }
        }
        if (context != null && !Files.isRegularFile(context)) {
            throw new IllegalArgumentException("Context image not found: " + context);
        }
        if (contextManifest != null && !Files.isRegularFile(contextManifest)) {
            throw new IllegalArgumentException("Context manifest not found: " + contextManifest);
        }
        if (context != null && contextManifest != null) {
            throw new IllegalArgumentException("Choose --context-manifest or --context-image, not both");
        }
        if (bindAddress.isBlank()) throw new IllegalArgumentException("Bind address cannot be blank");
        if (publicMode && snapshot <= 0) {
            throw new IllegalArgumentException("Public mode requires an explicit --snapshot");
        }
        if (publicUrl.isBlank()) publicUrl = "http://127.0.0.1:" + port + "/";
        publicUrl = normalizePublicUrl(publicUrl);
        if (fidelityGallery != null && !Files.isDirectory(fidelityGallery)) {
            throw new IllegalArgumentException("Fidelity gallery not found: " + fidelityGallery);
        }
        if (fidelityReceipts != null && !Files.isRegularFile(fidelityReceipts)) {
            throw new IllegalArgumentException("Fidelity receipts not found: " + fidelityReceipts);
        }
        if (fidelityClusters != null && !Files.isRegularFile(fidelityClusters)) {
            throw new IllegalArgumentException("Fidelity clusters not found: " + fidelityClusters);
        }
        if (fidelityCandidates != null && !Files.isRegularFile(fidelityCandidates)) {
            throw new IllegalArgumentException("Fidelity candidates not found: " + fidelityCandidates);
        }

        FeedbackConfig feedback = FeedbackConfig.fromEnvironment(publicUrl);
        return new LabConfig(mode, absolute(cache), absolute(artifacts),
            context == null ? null : absolute(context),
            contextManifest == null ? null : absolute(contextManifest), bindAddress, port, noBrowser, snapshot,
            List.copyOf(lenses), List.copyOf(resolutions), force, publicMode, publicUrl,
            releaseVersion.isBlank() ? "dev" : releaseVersion,
            fidelityGallery == null ? null : absolute(fidelityGallery),
            fidelityReceipts == null ? null : absolute(fidelityReceipts),
            fidelityClusters == null ? null : absolute(fidelityClusters),
            fidelityCandidates == null ? null : absolute(fidelityCandidates), feedback);
    }

    private static Path defaultCache() {
        String local = System.getenv("LOCALAPPDATA");
        if (local != null) {
            Path published = Path.of(local, "steward-publish", "out", "world-cache.duckdb");
            if (Files.isRegularFile(published)) return published;
        }
        return Path.of("data", "world-cache.duckdb");
    }

    private static String requireValue(List<String> args, int index, String option) {
        if (index >= args.size()) throw new IllegalArgumentException(option + " requires a value");
        return args.get(index);
    }

    private static List<String> split(String raw) {
        return Arrays.stream(raw.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
    }

    private static Path absolute(Path path) {
        return path.toAbsolutePath().normalize();
    }

    private static String environment(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    private static Path optionalPath(String environmentName, Path fallback, boolean directory) {
        String configured = System.getenv(environmentName);
        Path candidate = configured == null || configured.isBlank() ? fallback : Path.of(configured.trim());
        if (directory ? Files.isDirectory(candidate) : Files.isRegularFile(candidate)) return candidate;
        return configured == null || configured.isBlank() ? null : candidate;
    }

    private static String normalizePublicUrl(String raw) {
        String value = raw.trim();
        if (!value.matches("https?://.+")) {
            throw new IllegalArgumentException("Public URL must be absolute: " + raw);
        }
        return value.endsWith("/") ? value : value + "/";
    }
}
