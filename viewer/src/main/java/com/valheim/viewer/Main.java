package com.valheim.viewer;

import com.valheim.viewer.api.ApiServer;
import com.valheim.viewer.config.StConfig;
import com.valheim.viewer.contract.Region;
import com.valheim.viewer.contract.WorldContracts;
import com.valheim.viewer.extractor.AlertBuilder;
import com.valheim.viewer.extractor.AlertResult;
import com.valheim.viewer.extractor.ContractBuilder;
import com.valheim.viewer.extractor.MetricsBuilder;
import com.valheim.viewer.extractor.MetricsResult;
import com.valheim.viewer.extractor.RegionLoader;
import com.valheim.viewer.extractor.SectorBuilder;
import com.valheim.viewer.extractor.SectorResult;
import com.valheim.viewer.extractor.StructureDetector;
import com.valheim.viewer.parser.WorldParser;
import com.valheim.viewer.store.ZdoFlatStore;

import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.Desktop;
import java.io.File;
import java.net.URI;

/**
 * Entry point for Valheim World Viewer.
 *
 * Usage:
 *   java -Xmx3g -jar world-viewer.jar [path/to/save.db] [--port 7070] [--no-browser]
 */
public class Main {

    private static final Logger log = LoggerFactory.getLogger(Main.class);
    private static final int DEFAULT_PORT = 7070;

    public static void main(String[] args) throws Exception {
        String dbPath    = "ComfyEra14.db";
        int    port      = DEFAULT_PORT;
        boolean noBrowser = false;

        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--port":
                    if (i + 1 < args.length) port = Integer.parseInt(args[++i]);
                    break;
                case "--no-browser":
                    noBrowser = true;
                    break;
                default:
                    if (!args[i].startsWith("--")) dbPath = args[i];
            }
        }

        StConfig.load();

        File dbFile = new File(dbPath);
        if (!dbFile.exists()) {
            System.err.println("ERROR: Save file not found: " + dbFile.getAbsolutePath());
            System.err.println("Usage: java -Xmx3g -jar world-viewer.jar [save.db] [--port 7070]");
            System.exit(1);
        }

        log.info("Loading: {}", dbFile.getAbsolutePath());

        WorldParser parser = new WorldParser();

        // Parse FIRST (synchronously), then start Javalin
        // This tests whether Javalin startup interferes with parse performance
        log.info("Parsing world data...");
        ZdoFlatStore store;
        try {
            store = parser.parse(dbFile);
        } catch (Exception e) {
            log.error("Parse failed", e);
            System.exit(1);
            return;
        }
        log.info("Parse complete: {} ZDOs (interesting) in {}ms", store.size(), store.parseDurationMs);

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
            alerts = new AlertBuilder().build(contracts, metrics);
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

        ApiServer server = new ApiServer(parser);
        server.setStore(store);
        server.setContracts(contracts);
        server.setMetrics(metrics);
        server.setAlerts(alerts);
        server.setSectors(sectors);
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
}
