package com.valheim.viewer;

import com.valheim.viewer.api.ApiServer;
import com.valheim.viewer.config.StConfig;
import com.valheim.viewer.contract.Region;
import com.valheim.viewer.contract.WorldContracts;
import com.valheim.viewer.db.AnalyticsCache;
import com.valheim.viewer.db.AnalyticsCacheReader;
import com.valheim.viewer.db.RenderedLayerBuilder;
import com.valheim.viewer.db.SnapshotIngestService;
import com.valheim.viewer.db.SnapshotProvenance;
import com.valheim.viewer.extractor.AlertBuilder;
import com.valheim.viewer.extractor.AlertResult;
import com.valheim.viewer.extractor.ClassificationStore;
import com.valheim.viewer.extractor.ContractBuilder;
import com.valheim.viewer.extractor.MetricsBuilder;
import com.valheim.viewer.extractor.MetricsResult;
import com.valheim.viewer.extractor.RegionLoader;
import com.valheim.viewer.extractor.SectorBuilder;
import com.valheim.viewer.extractor.SectorResult;
import com.valheim.viewer.extractor.StructureDetector;
import com.valheim.viewer.parser.WorldParser;
import com.valheim.viewer.store.ZdoFlatStore;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.Desktop;
import java.io.File;
import java.net.URI;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Instant;

/**
 * Entry point for Valheim World Viewer.
 *
 * Usage:
 *   java -Xmx3g -jar world-viewer.jar [path/to/save.db] [--port 8003] [--no-browser]
 *   java -Xmx4g -jar world-viewer.jar world.db --build-cache --render-layers --no-browser
 */
public class Main {

    private static final Logger log = LoggerFactory.getLogger(Main.class);
    private static final int DEFAULT_PORT = 8003;

    public static void main(String[] args) throws Exception {
        String dbPath    = "ComfyEra14.db";
        int    port      = DEFAULT_PORT;
        boolean noBrowser = false;
        boolean buildCache = false;
        boolean rebuildCache = false;
        boolean renderLayers = false;
        boolean batchOnly = false;
        boolean cacheFields = false;
        String cachePath = "world-cache.duckdb";
        String renderDirPath = "rendered";
        String probeHashArg = null;
        // Provenance for a batch cache build. Without these a --build-cache run derives world_id
        // from the filename, which is why snapshots built by the container never matched the
        // world ids Islet ingests under.
        String worldIdArg = null, worldNameArg = null, sourceArg = null, backupIdArg = null;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--port":
                    if (i + 1 < args.length) port = Integer.parseInt(args[++i]);
                    break;
                case "--no-browser":
                    noBrowser = true;
                    break;
                case "--build-cache":
                    buildCache = true;
                    break;
                case "--rebuild-cache":
                    buildCache = true;
                    rebuildCache = true;
                    break;
                case "--cache":
                    if (i + 1 < args.length) cachePath = args[++i];
                    break;
                case "--render-layers":
                    renderLayers = true;
                    break;
                case "--batch-only":
                    batchOnly = true;
                    break;
                case "--cache-fields":
                    cacheFields = true;
                    break;
                case "--render-dir":
                    if (i + 1 < args.length) renderDirPath = args[++i];
                    break;
                case "--probe-hash":
                    if (i + 1 < args.length) probeHashArg = args[++i];
                    break;
                case "--world-id":
                    if (i + 1 < args.length) worldIdArg = args[++i];
                    break;
                case "--world-name":
                    if (i + 1 < args.length) worldNameArg = args[++i];
                    break;
                case "--source":
                    if (i + 1 < args.length) sourceArg = args[++i];
                    break;
                case "--backup-id":
                    if (i + 1 < args.length) backupIdArg = args[++i];
                    break;
                default:
                    if (!args[i].startsWith("--")) dbPath = args[i];
            }
        }

        StConfig.load();

        File dbFile = new File(dbPath);
        if (!dbFile.exists()) {
            System.err.println("ERROR: Save file not found: " + dbFile.getAbsolutePath());
            System.err.println("Usage: java -Xmx3g -jar world-viewer.jar [save.db] [--port 8003] [--build-cache] [--render-layers] [--batch-only] [--cache-fields]");
            System.exit(1);
        }

        log.info("Loading: {}", dbFile.getAbsolutePath());

        WorldParser parser = new WorldParser();
        if (probeHashArg != null) {
            Set<Integer> probes = new LinkedHashSet<>();
            for (String s : probeHashArg.split(",")) {
                s = s.trim();
                if (!s.isEmpty()) probes.add(Integer.parseInt(s));
            }
            parser.setProbeHashes(probes);
            log.info("Reconciliation probe active for {} hashes: {}", probes.size(), probes);
        }
        File cacheFile = new File(cachePath);
        File renderRoot = new File(renderDirPath);
        AnalyticsCache analyticsCache = null;
        if (buildCache) {
            try {
                log.info("Analytics cache enabled: {} (rebuild={}, fields={})",
                    cacheFile.getAbsolutePath(), rebuildCache, cacheFields);
                analyticsCache = new AnalyticsCache(cacheFile, rebuildCache, cacheFields);
                parser.setAnalyticsCache(analyticsCache);
                if (worldIdArg != null) {
                    // Staged before the parse: WorldParser opens the snapshot itself, and a
                    // beginSnapshot afterwards would open a second, empty one.
                    String hash = SnapshotIngestService.sha256(dbFile);
                    analyticsCache.setPendingProvenance(new SnapshotProvenance(
                        worldIdArg, worldNameArg, sourceArg, backupIdArg,
                        Instant.ofEpochMilli(dbFile.lastModified()).toString(), hash,
                        SnapshotProvenance.DEFAULT_PARSER_VERSION,
                        SnapshotProvenance.CURRENT_SCHEMA_VERSION));
                    log.info("Snapshot provenance: worldId={} source={} backupId={} sha256={}",
                        worldIdArg, sourceArg, backupIdArg, hash);
                }
            } catch (Exception e) {
                log.error("Failed to initialize analytics cache", e);
                System.exit(1);
                return;
            }
        }

        // Parse FIRST (synchronously), then start Javalin
        // This tests whether Javalin startup interferes with parse performance
        log.info("Parsing world data...");
        ZdoFlatStore store;
        try {
            store = parser.parse(dbFile);
        } catch (Exception e) {
            log.error("Parse failed", e);
            if (analyticsCache != null) {
                try { analyticsCache.close(); } catch (Exception ignored) {}
            }
            System.exit(1);
            return;
        }
        if (analyticsCache != null) {
            try {
                // close(), not finish() — finish() no longer releases the connection, and the
                // AnalyticsCacheReader opened further down needs the write handle released first.
                analyticsCache.close();
                log.info("Analytics cache ready: {}", cacheFile.getAbsolutePath());
            } catch (Exception e) {
                log.error("Failed to finalize analytics cache", e);
                System.exit(1);
                return;
            }
        }
        log.info("Parse complete: {} ZDOs (interesting) in {}ms", store.size(), store.parseDurationMs);

        if (probeHashArg != null) {
            printProbeReport(parser, store);
            System.exit(0);
            return;
        }

        if (renderLayers) {
            // Render every snapshot missing a manifest, not just the latest — keeps
            // multi-snapshot caches (publish appends, ingests) fully rendered and is idempotent.
            try (AnalyticsCacheReader reader = new AnalyticsCacheReader(cacheFile, renderRoot);
                 Statement st = reader.connection().createStatement();
                 ResultSet rs = st.executeQuery("SELECT snapshot_id FROM world_snapshot ORDER BY snapshot_id")) {
                while (rs.next()) {
                    long snapId = rs.getLong(1);
                    if (reader.manifestFile(snapId).exists()) {
                        log.info("Rendered layers already present for snapshot {}; skipping", snapId);
                        continue;
                    }
                    log.info("Rendering static layers for snapshot {} into {}",
                        snapId, renderRoot.getAbsolutePath());
                    File manifest = new RenderedLayerBuilder(cacheFile, renderRoot, snapId)
                        .renderDefaults();
                    log.info("Rendered layer manifest: {}", manifest.getAbsolutePath());
                }
            } catch (Exception e) {
                log.error("Failed to render static layers", e);
                System.exit(1);
                return;
            }
        }

        if (batchOnly) {
            log.info("Batch work complete; exiting before API startup.");
            return;
        }

        log.info("Building contracts...");
        WorldContracts contracts;
        try {
            contracts = new ContractBuilder().build(store);
        } catch (Exception e) {
            log.error("ContractBuilder failed", e);
            System.exit(1);
            return;
        }
        log.info("Contracts ready: {} portals, {} dropped items, {} entities, {} containers",
            contracts.portals.size(), contracts.droppedItems.size(),
            contracts.entities.size(), contracts.containers.size());

        log.info("Computing metrics...");
        List<Region> regions = RegionLoader.load();
        MetricsResult metrics;
        try {
            metrics = new MetricsBuilder().build(contracts, regions, RegionLoader.isFileFound());
        } catch (Exception e) {
            log.error("MetricsBuilder failed", e);
            System.exit(1);
            return;
        }

        // Back-fill WorldSummary fields that depend on metrics
        contracts.summary.regions_loaded         = metrics.regionsLoaded;
        contracts.summary.stats.portals.clusters = metrics.portalClusters.size();

        log.info("Metrics ready: {} portal clusters, {} zone budgets, {} hotspots",
            metrics.portalClusters.size(), metrics.zoneBudgets.size(), metrics.hotspots.size());

        log.info("Building sectors...");
        SectorResult sectors;
        try {
            sectors = new SectorBuilder().build(contracts, metrics);
        } catch (Exception e) {
            log.error("SectorBuilder failed", e);
            System.exit(1);
            return;
        }

        // Back-fill WorldSummary sector stats
        contracts.summary.stats.sectors.total_occupied = sectors.total_occupied;
        contracts.summary.stats.sectors.high_density   = sectors.high_density;

        log.info("Detecting structures...");
        try {
            new StructureDetector().classify(contracts, sectors.cell_size_m);
        } catch (Exception e) {
            log.error("StructureDetector failed", e);
            System.exit(1);
            return;
        }

        // Back-fill WorldSummary structure stats
        int sActive = 0, sCleared = 0, sUnknown = 0;
        for (com.valheim.viewer.contract.Structure st : contracts.structures) {
            if ("active".equals(st.status))          sActive++;
            else if ("likely_cleared".equals(st.status)) sCleared++;
            else                                         sUnknown++;
        }
        contracts.summary.stats.structures.total          = contracts.structures.size();
        contracts.summary.stats.structures.active         = sActive;
        contracts.summary.stats.structures.likely_cleared = sCleared;
        contracts.summary.stats.structures.unknown        = sUnknown;
        log.info("Structures ready: {} total ({} active, {} cleared, {} unknown)",
            contracts.structures.size(), sActive, sCleared, sUnknown);

        log.info("Building alerts...");
        AlertResult alerts;
        try {
            // Pass store for PA4 forensics alerts (quality overflow / server-issued / engravings)
            alerts = new AlertBuilder().build(contracts, metrics, store);
        } catch (Exception e) {
            log.error("AlertBuilder failed", e);
            System.exit(1);
            return;
        }

        // Back-fill WorldSummary alert counts
        contracts.summary.stats.alerts.critical = alerts.critical_count;
        contracts.summary.stats.alerts.high     = alerts.high_count;
        contracts.summary.stats.alerts.medium   = alerts.medium_count;
        contracts.summary.stats.alerts.low      = alerts.low_count;
        log.info("Alerts ready: {} total (critical={} high={} medium={} low={})",
            alerts.alerts.size(), alerts.critical_count, alerts.high_count,
            alerts.medium_count, alerts.low_count);

        // Load item classification (category/tier/biome/source/mod) from JSON.
        // Tries the viewer dir first, then the save file's directory.
        ClassificationStore classification = ClassificationStore.loadOrEmpty(
            "classification.json",
            new File(dbFile.getParentFile(), "classification.json").getAbsolutePath()
        );
        log.info("Item classification: {} entries loaded", classification.size());

        ApiServer server = new ApiServer(parser);
        server.setStore(store);
        server.setContracts(contracts);
        server.setMetrics(metrics);
        server.setAlerts(alerts);
        server.setSectors(sectors);
        server.setClassification(classification);
        if (cacheFile.exists()) {
            try {
                server.setAnalyticsCacheReader(new AnalyticsCacheReader(cacheFile, renderRoot));
                log.info("Analytics cache reader attached: {}", cacheFile.getAbsolutePath());
            } catch (Exception e) {
                log.warn("Analytics cache exists but could not be opened: {}", e.toString());
            }
        }
        server.start(port);

        String url = "http://localhost:" + port;
        log.info("Viewer ready: {}", url);

        if (!noBrowser) {
            openBrowser(url);
        }

        // Dummy parse thread reference for compatibility
        Thread parseThread = new Thread(() -> {}, "world-parser");
        parseThread.setDaemon(false);
        parseThread.start();

        // Keep main thread alive
        parseThread.join();
        log.info("Ready. Press Ctrl+C to stop.");

        // Block indefinitely
        Thread.currentThread().join();
    }

    private static void openBrowser(String url) {
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(new URI(url));
                return;
            }
        } catch (Exception ignored) {}

        // Fallback: try OS-specific commands
        String os = System.getProperty("os.name").toLowerCase();
        try {
            if (os.contains("win")) {
                Runtime.getRuntime().exec(new String[]{"cmd", "/c", "start", url});
            } else if (os.contains("mac")) {
                Runtime.getRuntime().exec(new String[]{"open", url});
            } else {
                Runtime.getRuntime().exec(new String[]{"xdg-open", url});
            }
        } catch (Exception e) {
            log.warn("Could not open browser: {}", e.getMessage());
        }
    }

    /**
     * Print the reconciliation probe report.
     *
     * The load-bearing column is the PERCENTAGE, not the count. A property present on
     * a handful of a hash's ZDOs identifies nothing; that is how "ammoType=TurretBolt"
     * on 12 of 40,889 ZDOs became a "confirmed" ballista.
     */
    private static void printProbeReport(WorldParser parser, ZdoFlatStore store) {
        StringBuilder sb = new StringBuilder();
        sb.append("\n");
        sb.append("================ RECONCILIATION PROBE ================\n");
        sb.append("world ZDOs: ").append(String.format("%,d", store.zdosSeen())).append("\n");

        for (Map.Entry<Integer, WorldParser.ProbeStats> e : parser.getProbeResults().entrySet()) {
            int hash = e.getKey();
            WorldParser.ProbeStats st = e.getValue();
            String resolved = store.rawNameForHash(hash);
            sb.append("\n--- hash ").append(hash)
              .append("  count=").append(String.format("%,d", st.count))
              .append("  name=").append(resolved != null ? resolved : "<unresolved>")
              .append("\n");

            if (st.count == 0) {
                sb.append("    (no ZDOs with this hash in this world)\n");
                continue;
            }
            if (st.fieldPresence.isEmpty()) {
                sb.append("    NO PROPERTIES on any of its ZDOs\n");
            }
            for (Map.Entry<String, Long> f : st.fieldPresence.entrySet()) {
                double pct = (double) f.getValue() / st.count * 100.0;
                sb.append(String.format("    %-22s %10s  %7.3f%%%n",
                    f.getKey(), String.format("%,d", f.getValue()), pct));
            }
            for (int i = 0; i < st.samples.size(); i++) {
                sb.append("    sample[").append(i).append("]: ").append(st.samples.get(i)).append("\n");
            }
        }
        sb.append("\n======================================================\n");
        System.out.println(sb);
    }
}
