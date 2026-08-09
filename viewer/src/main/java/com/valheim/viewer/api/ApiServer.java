package com.valheim.viewer.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.*;
import com.valheim.viewer.contract.Alert;
import com.valheim.viewer.contract.Sector;
import com.valheim.viewer.contract.Structure;
import com.valheim.viewer.contract.WorldContracts;
import com.valheim.viewer.db.AnalyticsCache;
import com.valheim.viewer.db.AnalyticsCacheReader;
import com.valheim.viewer.db.RenderedDeltaLayerBuilder;
import com.valheim.viewer.db.RenderedLayerBuilder;
import com.valheim.viewer.db.SnapshotDeltaEngine;
import com.valheim.viewer.db.SnapshotIngestService;
import com.valheim.viewer.db.SnapshotProvenance;
import com.valheim.viewer.extractor.AlertResult;
import com.valheim.viewer.extractor.ClassificationStore;
import com.valheim.viewer.extractor.MetricsResult;
import com.valheim.viewer.extractor.SectorResult;
import com.valheim.viewer.store.ZdoFlatStore;
import com.valheim.viewer.store.ZdoFlatStore.Categories;
import com.valheim.viewer.store.ZdoFlatStore.PlayerRecord;
import com.valheim.viewer.parser.WorldParser;
import io.javalin.Javalin;
import io.javalin.http.Context;
import io.javalin.http.Header;
import io.javalin.http.staticfiles.Location;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.nio.file.Files;
import java.time.Instant;
import java.util.*;
import java.util.stream.*;

/**
 * Javalin HTTP server exposing the world viewer REST API.
 *
 * All endpoints return JSON with envelope:
 * { "apiVersion":"1.0", "schemaVersion":1, "snapshotNetTime": ..., ...data... }
 */
public class ApiServer {

    private static final Logger log = LoggerFactory.getLogger(ApiServer.class);
    private static final String API_VERSION = "1.0";
    private static final int SCHEMA_VERSION = 1;

    private final Javalin app;
    private final ObjectMapper mapper = new ObjectMapper();
    private final WorldParser parser;

    private volatile ZdoFlatStore store = null;
    private volatile WorldContracts contracts = null;
    private volatile MetricsResult metrics = null;
    private volatile AlertResult alerts = null;
    private volatile SectorResult sectorResult = null;
    private volatile ClassificationStore classification = null;
    private volatile AnalyticsCacheReader analyticsCacheReader = null;

    public ApiServer(WorldParser parser) {
        this(parser, null);
    }

    /**
     * @param staticDirPath directory to serve the UI from instead of the copy baked into the jar,
     *                      or null to use only the baked copy. Lets a UI change ship by writing one
     *                      file, rather than by rebuilding the image and restarting the container —
     *                      a restart re-parses the whole world before the port opens.
     */
    public ApiServer(WorldParser parser, String staticDirPath) {
        this.parser = parser;
        File staticDir = (staticDirPath == null || staticDirPath.isBlank())
            ? null : new File(staticDirPath);
        // A path that does not resolve is a misconfiguration, not a reason to serve nothing.
        boolean useExternal = staticDir != null && staticDir.isDirectory();
        if (staticDir != null && !useExternal) {
            log.warn("--static-dir {} is not a directory; serving the UI baked into the jar",
                staticDir.getAbsolutePath());
        }
        this.app = Javalin.create(config -> {
            // Registered ahead of the classpath handler so it shadows the baked copy. The classpath
            // handler stays registered as a fallback: the override directory lives in a Docker
            // volume that can legitimately be empty, and an empty override must degrade to the
            // shipped UI rather than 404 a publicly funnelled page.
            if (useExternal) {
                config.staticFiles.add(staticConfig -> {
                    staticConfig.directory  = staticDir.getAbsolutePath();
                    staticConfig.location   = Location.EXTERNAL;
                    staticConfig.hostedPath = "/";
                    // The whole point of this path is that a push lands without a restart, so
                    // nothing downstream may hold a stale copy. Javalin's default here is
                    // max-age=0, which still permits revalidated caching.
                    staticConfig.headers    = Map.of(Header.CACHE_CONTROL, "no-store");
                });
            }
            config.staticFiles.add("/static");
            config.bundledPlugins.enableCors(cors -> cors.addRule(rule -> {
                rule.anyHost();
            }));
        });
        if (useExternal) {
            log.info("Serving UI from {} (jar copy is the fallback)", staticDir.getAbsolutePath());
        }
        registerRoutes();
    }

    public void start(int port) {
        app.start(port);
        log.info("API server started on port {}", port);
    }

    public void setStore(ZdoFlatStore store) {
        this.store = store;
    }

    public void setContracts(WorldContracts contracts) {
        this.contracts = contracts;
    }

    public void setMetrics(MetricsResult metrics) {
        this.metrics = metrics;
    }

    public void setAlerts(AlertResult alerts) {
        this.alerts = alerts;
    }

    public void setSectors(SectorResult sectors) {
        this.sectorResult = sectors;
    }

    public void setClassification(ClassificationStore classification) {
        this.classification = classification;
    }

    public void setAnalyticsCacheReader(AnalyticsCacheReader analyticsCacheReader) {
        this.analyticsCacheReader = analyticsCacheReader;
    }

    private void registerRoutes() {
        // Loading status — polled by frontend during parse
        app.get("/api/v1/status", this::handleStatus);

        // Summary stats
        app.get("/api/v1/summary", this::handleSummary);
        app.get("/api/v1/prefabs/unresolved", this::handleUnresolvedPrefabs);

        // Portal list with pairing info
        app.get("/api/v1/portals", this::handlePortals);

        // Container list (no inventory detail — just location + name)
        app.get("/api/v1/containers", this::handleContainers);

        // Economy: items in chests totals
        app.get("/api/v1/economy", this::handleEconomy);

        // Player list + stats
        app.get("/api/v1/players", this::handlePlayers);

        // Tombstones
        app.get("/api/v1/tombstones", this::handleTombstones);

        // Signs (text corpus)
        app.get("/api/v1/signs", this::handleSigns);

        // Beds
        app.get("/api/v1/beds", this::handleBeds);

        // Dropped items: counts by hash
        app.get("/api/v1/dropped", this::handleDropped);

        // ZDO point data for map — filtered by category/bounds
        // query: ?cat=PORTAL&minX=-5000&maxX=5000&minZ=-5000&maxZ=5000&limit=10000
        app.get("/api/v1/points", this::handlePoints);

        // Contract endpoints — schema-versioned envelope
        app.get("/api/v1/world-summary", this::handleWorldSummary);
        app.get("/api/v1/metrics/summary", this::handleMetricsSummary);

        // Phase 2b — classified contract data
        // query: ?type=monster|boss|npc|animal &hostility=hostile|passive|neutral
        // &biome=meadows|swamp|... &source=vanilla|mod
        // &limit=N &offset=N
        app.get("/api/v1/entities", this::handleEntities);

        // Phase 3a — steward alerts
        // query: ?severity=critical|high|medium|low &type=portal_orphaned|...
        // &limit=N &offset=N
        app.get("/api/v1/alerts", this::handleAlerts);

        // Phase 3b — world sectors
        // query: ?density=normal|high|hotspot
        // &minX= &maxX= &minZ= &maxZ= (world-coordinate bounding box)
        // &limit=N &offset=N
        app.get("/api/v1/sectors", this::handleSectors);

        // Phase 4 — detected structures
        // query: ?type=dungeon_entrance|cave_entrance|camp|boss_altar|ruin
        // &status=active|likely_cleared|unknown
        // &biome=meadows|black_forest|swamp|mountain|plains|mistlands|ashlands
        // &limit=N &offset=N
        app.get("/api/v1/structures", this::handleStructures);

        // PA5 — Forensics endpoints (item-level intelligence sourced from inventory parse)
        // Per-container coin caches sorted desc
        app.get("/api/v1/forensics/top-coin-caches", this::handleTopCoinCaches);
        // Server-issuer crafters with item counts
        app.get("/api/v1/forensics/server-issuers", this::handleServerIssuers);
        // Items issued by a specific server identity (query: ?issuer=<name>)
        app.get("/api/v1/forensics/guild-gear", this::handleGuildGear);

        // Batch analytics cache & snapshot history endpoints
        app.get("/api/v1/rendered/delta/manifest", this::handleRenderedDeltaManifest);
        app.get("/api/v1/rendered/delta/{file}", this::handleRenderedDeltaFile);
        app.get("/api/v1/rendered/manifest", this::handleRenderedManifest);
        app.get("/api/v1/rendered/{file}", this::handleRenderedFile);
        app.get("/api/v1/db/zdo/query", this::handleDbZdoQuery);
        app.get("/api/v1/db/containers/items", this::handleDbContainerItems);
        app.get("/api/v1/db/selection-summary", this::handleDbSelectionSummary);
        app.get("/api/v1/db/selection-delta", this::handleDbSelectionDelta);
        app.get("/api/v1/db/spawn-histogram", this::handleDbSpawnHistogram);

        // World Intelligence & Ingest endpoints
        app.post("/api/v1/db/snapshots/ingest", this::handleDbSnapshotIngest);
        app.get("/api/v1/db/snapshots", this::handleDbSnapshotsList);
        app.get("/api/v1/db/snapshots/delta", this::handleDbSnapshotDelta);
        app.get("/api/v1/db/snapshots/compare", this::handleDbSnapshotsCompare);
    }

    // ----- Handlers -----

    private void handleStatus(Context ctx) {
        WorldParser.ParseProgress p = parser.getProgress();
        ObjectNode node = mapper.createObjectNode();
        node.put("status", p.status);
        node.put("parsed", p.parsed);
        node.put("total", p.total);
        node.put("pct", p.pct);
        node.put("done", p.done);
        ctx.json(node.toString());
    }

    private void handleSummary(Context ctx) {
        ZdoFlatStore s = requireStore(ctx);
        if (s == null)
            return;

        // Count categories
        int[] catCounts = new int[14];
        for (int i = 0; i < s.size(); i++)
            catCounts[s.category[i]]++;

        // Total ZDOs = sum of all category index lists + heatmap counts for stored-only
        // categories
        int storedZdos = s.size();
        int totalZdos = s.allHeatmap.getTotalCount(); // all valid-position ZDOs

        ObjectNode root = envelope(s);
        root.put("totalZdos", totalZdos);
        root.put("storedZdos", storedZdos);
        root.put("buildingCount", s.buildingCount);
        root.put("parseDurationMs", s.parseDurationMs);
        root.put("worldVersion", s.worldVersion);

        ObjectNode cats = root.putObject("categoryCounts");
        for (int c = 0; c < 14; c++) {
            cats.put(Categories.name((byte) c), catCounts[c]);
        }

        root.put("playerCount", s.players.size());
        root.put("portalCount", s.portalIndices.size());
        root.put("containerCount", s.containerIndices.size());
        root.put("tombstoneCount", s.tombstoneIndices.size());
        root.put("signCount", s.signIndices.size());
        root.put("bedCount", s.bedIndices.size());
        root.put("droppedItemCount", s.droppedItemCounts.values().stream().mapToInt(Integer::intValue).sum());

        ObjectNode cov = root.putObject("prefabCoverage");
        cov.put("dictionaryEntries",       s.dictionaryEntries);
        cov.put("dictionaryGameVersion",   s.dictionaryGameVersion);
        cov.put("dictionaryGeneratedAt",   s.dictionaryGeneratedAt);
        cov.put("dictionarySource",        s.dictionarySource);
        cov.put("zdosTotal",               s.zdosSeen());
        cov.put("zdosResolved",            s.resolvedZdoCount);
        cov.put("zdosUnresolved",          s.unresolvedZdoCount);
        cov.put("pctResolved",             Math.round(s.resolvedPct() * 100.0) / 100.0);
        cov.put("distinctUnresolvedHashes", s.unknownHashCounts.size());

        ctx.json(root.toString());
    }

    /**
     * Unresolved prefab hashes by ZDO count. This is the worklist for the next dictionary
     * refresh — the vanilla dump cannot name modded prefabs or ZoneSystem location prefabs,
     * and this endpoint is what makes that residue visible rather than invisible.
     */
    private void handleUnresolvedPrefabs(Context ctx) {
        ZdoFlatStore s = requireStore(ctx);
        if (s == null)
            return;

        int limit = 100;
        String raw = ctx.queryParam("limit");
        if (raw != null) {
            try { limit = Math.max(1, Math.min(5000, Integer.parseInt(raw))); }
            catch (NumberFormatException ignored) {}
        }

        ObjectNode root = envelope(s);
        root.put("distinctUnresolvedHashes", s.unknownHashCounts.size());
        root.put("zdosUnresolved", s.unresolvedZdoCount);
        ArrayNode arr = root.putArray("unresolved");
        for (Map.Entry<Integer, Integer> e : s.topUnresolvedHashes(limit)) {
            ObjectNode n = arr.addObject();
            n.put("hash", e.getKey());
            n.put("count", e.getValue());
        }
        ctx.json(root.toString());
    }

    private void handlePortals(Context ctx) {
        ZdoFlatStore s = requireStore(ctx);
        if (s == null)
            return;

        Map<Integer, Integer> pairs = s.buildPortalPairMap();

        // Group by tag for hub detection
        Map<String, Integer> tagCount = new HashMap<>();
        for (int idx : s.portalIndices) {
            String tag = s.label1[idx] != null ? s.label1[idx] : "";
            tagCount.merge(tag, 1, Integer::sum);
        }

        ObjectNode root = envelope(s);
        ArrayNode list = root.putArray("portals");

        for (int idx : s.portalIndices) {
            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000)
                continue;

            String tag = s.label1[idx] != null ? s.label1[idx] : "";
            String author = s.label2[idx];
            Integer paired = pairs.get(idx);

            String status;
            if (paired != null && paired >= 0) {
                int tagCnt = tagCount.getOrDefault(tag, 1);
                status = tagCnt >= 3 ? "HUB" : "PAIRED";
            } else if (tag.isEmpty()) {
                status = "BLANK_TAG";
            } else {
                status = "ORPHANED";
            }

            ObjectNode p = list.addObject();
            p.put("id", String.valueOf(idx));
            p.put("x", x);
            p.put("z", z);
            p.put("tag", tag);
            p.put("status", status);
            if (author != null)
                p.put("author", author);
            if (paired != null && paired >= 0) {
                p.put("pairedId", String.valueOf(paired));
                p.put("pairedX", s.posX[paired]);
                p.put("pairedZ", s.posZ[paired]);
            }
        }
        ctx.json(root.toString());
    }

    private void handleContainers(Context ctx) {
        ZdoFlatStore s = requireStore(ctx);
        if (s == null)
            return;
        int limit = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(500);
        int offset = ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0);

        ObjectNode root = envelope(s);
        root.put("total", s.containerIndices.size());
        ArrayNode list = root.putArray("containers");

        int end = Math.min(offset + limit, s.containerIndices.size());
        for (int j = offset; j < end; j++) {
            int idx = s.containerIndices.get(j);
            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000)
                continue;

            ObjectNode c = list.addObject();
            c.put("id", String.valueOf(idx));
            c.put("name", s.nameForHash(s.prefabId[idx]));
            c.put("x", x);
            c.put("z", z);
        }
        ctx.json(root.toString());
    }

    private void handleEconomy(Context ctx) {
        ZdoFlatStore s = requireStore(ctx);
        if (s == null)
            return;
        int topN = ctx.queryParamAsClass("topN", Integer.class).getOrDefault(50);

        // Sort by count desc
        List<Map.Entry<String, Long>> sorted = new ArrayList<>(s.chestItemTotals.entrySet());
        sorted.sort((a, b) -> Long.compare(b.getValue(), a.getValue()));

        ObjectNode root = envelope(s);
        root.put("uniqueItemTypes", s.chestItemTotals.size());
        long totalItems = s.chestItemTotals.values().stream().mapToLong(Long::longValue).sum();
        root.put("totalItemCount", totalItems);

        ArrayNode items = root.putArray("topItems");
        for (int i = 0; i < Math.min(topN, sorted.size()); i++) {
            Map.Entry<String, Long> e = sorted.get(i);
            ObjectNode item = items.addObject();
            item.put("name", e.getKey());
            item.put("count", e.getValue());
            if (classification != null) classification.enrich(e.getKey(), item);
        }
        // Aggregate counts by category for a top-level breakdown
        if (classification != null) {
            Map<String, Long> byCategory = new java.util.TreeMap<>();
            Map<String, Long> byTier = new java.util.TreeMap<>();
            for (Map.Entry<String, Long> e : sorted) {
                ClassificationStore.Entry c = classification.get(e.getKey());
                if (c == null) { byCategory.merge("(unknown)", e.getValue(), Long::sum); continue; }
                byCategory.merge(c.category, e.getValue(), Long::sum);
                if (c.tier >= 0) byTier.merge("tier" + c.tier, e.getValue(), Long::sum);
            }
            ObjectNode cats = root.putObject("byCategory");
            byCategory.forEach(cats::put);
            ObjectNode tiers = root.putObject("byTier");
            byTier.forEach(tiers::put);
        }
        ctx.json(root.toString());
    }

    private void handlePlayers(Context ctx) {
        ZdoFlatStore s = requireStore(ctx);
        if (s == null)
            return;
        String sortBy = ctx.queryParamAsClass("sortBy", String.class).getOrDefault("beds");

        List<PlayerRecord> players = new ArrayList<>(s.players.values());
        switch (sortBy) {
            case "deaths":
                players.sort((a, b) -> b.deathCount - a.deathCount);
                break;
            case "builds":
                players.sort((a, b) -> b.buildCount - a.buildCount);
                break;
            case "portals":
                players.sort((a, b) -> b.portalCount - a.portalCount);
                break;
            default:
                players.sort((a, b) -> b.bedCount - a.bedCount);
                break;
        }

        ObjectNode root = envelope(s);
        root.put("total", players.size());
        ArrayNode list = root.putArray("players");

        for (PlayerRecord pr : players) {
            ObjectNode p = list.addObject();
            p.put("internalId", pr.internalId);
            p.put("displayName", pr.displayName != null ? pr.displayName : "Player #" + pr.internalId);
            p.put("nameSource", pr.nameSource);
            p.put("confidence", pr.confidence);
            p.put("bedCount", pr.bedCount);
            p.put("deathCount", pr.deathCount);
            p.put("buildCount", pr.buildCount);
            p.put("portalCount", pr.portalCount);
            if (pr.steam64 != null)
                p.put("steam64", pr.steam64);
        }
        ctx.json(root.toString());
    }

    private void handleTombstones(Context ctx) {
        ZdoFlatStore s = requireStore(ctx);
        if (s == null)
            return;
        String player = ctx.queryParam("player");

        ObjectNode root = envelope(s);
        ArrayNode list = root.putArray("tombstones");

        for (int idx : s.tombstoneIndices) {
            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000)
                continue;

            String ownerName = s.label1[idx];
            if (player != null && !player.isEmpty()) {
                if (ownerName == null || !ownerName.toLowerCase().contains(player.toLowerCase()))
                    continue;
            }

            double spawnSec = s.spawnTimeMicros[idx] / 1_000_000.0;
            double worldFrac = s.netTimeSeconds > 0 ? spawnSec / s.netTimeSeconds : 0;

            ObjectNode t = list.addObject();
            t.put("id", String.valueOf(idx));
            t.put("ownerName", ownerName != null ? ownerName : "Unknown");
            t.put("ownerId", s.creatorId[idx]);
            t.put("x", x);
            t.put("z", z);
            t.put("deathTimeSeconds", spawnSec);
            t.put("worldFraction", worldFrac);
        }
        root.put("total", list.size());
        ctx.json(root.toString());
    }

    private void handleSigns(Context ctx) {
        ZdoFlatStore s = requireStore(ctx);
        if (s == null)
            return;
        String search = ctx.queryParam("search");
        int limit = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(200);

        ObjectNode root = envelope(s);
        ArrayNode list = root.putArray("signs");
        int count = 0;

        for (int idx : s.signIndices) {
            if (count >= limit)
                break;
            String text = s.label1[idx];
            if (text == null || text.isEmpty())
                continue;
            if (search != null && !search.isEmpty() &&
                    !text.toLowerCase().contains(search.toLowerCase()))
                continue;

            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000)
                continue;

            ObjectNode sg = list.addObject();
            sg.put("text", text);
            sg.put("x", x);
            sg.put("z", z);
            if (s.label2[idx] != null)
                sg.put("author", s.label2[idx]);
            count++;
        }
        root.put("total", s.signIndices.size());
        ctx.json(root.toString());
    }

    private void handleBeds(Context ctx) {
        ZdoFlatStore s = requireStore(ctx);
        if (s == null)
            return;
        String player = ctx.queryParam("player");

        ObjectNode root = envelope(s);
        ArrayNode list = root.putArray("beds");

        for (int idx : s.bedIndices) {
            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000)
                continue;

            String ownerName = s.label1[idx];
            if (player != null && !player.isEmpty()) {
                if (ownerName == null || !ownerName.toLowerCase().contains(player.toLowerCase()))
                    continue;
            }

            ObjectNode b = list.addObject();
            b.put("id", String.valueOf(idx));
            b.put("ownerName", ownerName != null ? ownerName : "");
            b.put("ownerId", s.creatorId[idx]);
            b.put("x", x);
            b.put("z", z);
            b.put("prefab", s.nameForHash(s.prefabId[idx]));
        }
        root.put("total", s.bedIndices.size());
        ctx.json(root.toString());
    }

    private void handleDropped(Context ctx) {
        ZdoFlatStore s = requireStore(ctx);
        if (s == null)
            return;

        List<Map.Entry<Integer, Integer>> sorted = new ArrayList<>(s.droppedItemCounts.entrySet());
        sorted.sort((a, b) -> b.getValue() - a.getValue());

        ObjectNode root = envelope(s);
        root.put("totalDropped", sorted.stream().mapToInt(Map.Entry::getValue).sum());
        ArrayNode list = root.putArray("types");
        for (Map.Entry<Integer, Integer> e : sorted) {
            ObjectNode item = list.addObject();
            item.put("hash", e.getKey());
            item.put("name", s.nameForHash(e.getKey()));
            item.put("count", e.getValue());
        }
        ctx.json(root.toString());
    }

    private void handlePoints(Context ctx) {
        ZdoFlatStore s = requireStore(ctx);
        if (s == null)
            return;

        String catStr = ctx.queryParamAsClass("cat", String.class).getOrDefault("PORTAL");
        float minX = ctx.queryParamAsClass("minX", Float.class).getOrDefault(-100_000f);
        float maxX = ctx.queryParamAsClass("maxX", Float.class).getOrDefault(100_000f);
        float minZ = ctx.queryParamAsClass("minZ", Float.class).getOrDefault(-100_000f);
        float maxZ = ctx.queryParamAsClass("maxZ", Float.class).getOrDefault(100_000f);
        int limit = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(10_000);

        byte targetCat = catToByte(catStr);
        boolean spawnAfterFilter = ctx.queryParam("spawnedAfterFraction") != null;
        boolean spawnBeforeFilter = ctx.queryParam("spawnedBeforeFraction") != null;
        double spawnAfter = spawnAfterFilter ? Double.parseDouble(ctx.queryParam("spawnedAfterFraction")) : 0;
        double spawnBefore = spawnBeforeFilter ? Double.parseDouble(ctx.queryParam("spawnedBeforeFraction"))
                : Double.MAX_VALUE;

        // Use pre-built category index lists when available — avoids scanning all
        // ZDOs sequentially and prevents truncation when a category has many entries.
        List<Integer> indexList = categoryIndexList(s, targetCat);

        ObjectNode root = envelope(s);
        root.put("category", catStr);
        ArrayNode list = root.putArray("points");
        int count = 0;

        if (indexList != null) {
            // Fast path: iterate only matching indices
            for (int j = 0; j < indexList.size() && count < limit; j++) {
                int i = indexList.get(j);
                float x = s.posX[i], z = s.posZ[i];
                if (x < minX || x > maxX || z < minZ || z > maxZ)
                    continue;
                if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000)
                    continue;

                if (spawnAfterFilter || spawnBeforeFilter) {
                    double frac = s.netTimeSeconds > 0
                            ? (s.spawnTimeMicros[i] / 1_000_000.0) / s.netTimeSeconds
                            : 0;
                    if (frac < spawnAfter || frac > spawnBefore)
                        continue;
                }

                ObjectNode pt = list.addObject();
                pt.put("x", x);
                pt.put("z", z);
                if (targetCat == Categories.INTERIOR) {
                    pt.put("y", s.posY[i]);
                    pt.put("prefab", s.nameForHash(s.prefabId[i]));
                }
                if (s.label1[i] != null)
                    pt.put("label", s.label1[i]);
                if (s.creatorId[i] != 0) {
                    PlayerRecord pr = s.players.get(s.creatorId[i]);
                    if (pr != null)
                        pt.put("owner", pr.displayName);
                }
                count++;
            }
        } else {
            // Fallback: full scan for categories without a dedicated index list
            for (int i = 0; i < s.size() && count < limit; i++) {
                if (s.category[i] != targetCat)
                    continue;
                float x = s.posX[i], z = s.posZ[i];
                if (x < minX || x > maxX || z < minZ || z > maxZ)
                    continue;
                if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000)
                    continue;

                if (spawnAfterFilter || spawnBeforeFilter) {
                    double frac = s.netTimeSeconds > 0
                            ? (s.spawnTimeMicros[i] / 1_000_000.0) / s.netTimeSeconds
                            : 0;
                    if (frac < spawnAfter || frac > spawnBefore)
                        continue;
                }

                ObjectNode pt = list.addObject();
                pt.put("x", x);
                pt.put("z", z);
                if (targetCat == Categories.INTERIOR) {
                    pt.put("y", s.posY[i]);
                    pt.put("prefab", s.nameForHash(s.prefabId[i]));
                }
                if (s.label1[i] != null)
                    pt.put("label", s.label1[i]);
                if (s.creatorId[i] != 0) {
                    PlayerRecord pr = s.players.get(s.creatorId[i]);
                    if (pr != null)
                        pt.put("owner", pr.displayName);
                }
                count++;
            }
        }
        root.put("returned", count);
        ctx.json(root.toString());
    }

    /** Returns the pre-built index list for a category, or null if none exists. */
    private static List<Integer> categoryIndexList(ZdoFlatStore s, byte cat) {
        switch (cat) {
            case Categories.PORTAL:
                return s.portalIndices;
            case Categories.CONTAINER:
                return s.containerIndices;
            case Categories.BED:
                return s.bedIndices;
            case Categories.TOMBSTONE:
                return s.tombstoneIndices;
            case Categories.SIGN:
                return s.signIndices;
            case Categories.CREATURE:
                return s.creatureIndices;
            case Categories.ITEM_STAND:
                return s.itemStandIndices;
            case Categories.STRUCTURE:
                return s.structureIndices;
            case Categories.INTERIOR:
                return s.interiorIndices;
            default:
                return null;
        }
    }

    // ----- Contract handlers -----

    private void handleStructures(Context ctx) {
        if (contracts == null) {
            ctx.status(503).json("{\"error\":\"World data still loading\"}");
            return;
        }
        String typeFilter = ctx.queryParam("type");
        String statusFilter = ctx.queryParam("status");
        String biomeFilter = ctx.queryParam("biome");
        int limit = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(5_000);
        int offset = ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0);

        try {
            List<Structure> filtered = new ArrayList<>();
            for (Structure st : contracts.structures) {
                if (typeFilter != null && !typeFilter.equals(st.type))
                    continue;
                if (statusFilter != null && !statusFilter.equals(st.status))
                    continue;
                if (biomeFilter != null && !biomeFilter.equals(st.biome))
                    continue;
                filtered.add(st);
            }

            int total = filtered.size();
            int end = Math.min(offset + limit, total);
            List<Structure> page = (offset < total) ? filtered.subList(offset, end)
                    : Collections.emptyList();

            ObjectNode envelope = mapper.createObjectNode();
            envelope.put("schema_version", "1");
            envelope.put("generated_at", Instant.now().toString());
            envelope.put("total", total);
            envelope.put("offset", offset);
            envelope.put("limit", limit);
            envelope.set("data", mapper.valueToTree(page));
            ctx.json(mapper.writeValueAsString(envelope));
        } catch (Exception e) {
            log.error("Failed to serialize structures", e);
            ctx.status(500).json("{\"error\":\"serialization failure\"}");
        }
    }

    private void handleSectors(Context ctx) {
        if (sectorResult == null) {
            ctx.status(503).json("{\"error\":\"Sectors not yet computed\"}");
            return;
        }
        String densityFilter = ctx.queryParam("density");
        float minX = ctx.queryParamAsClass("minX", Float.class).getOrDefault(-Float.MAX_VALUE);
        float maxX = ctx.queryParamAsClass("maxX", Float.class).getOrDefault(Float.MAX_VALUE);
        float minZ = ctx.queryParamAsClass("minZ", Float.class).getOrDefault(-Float.MAX_VALUE);
        float maxZ = ctx.queryParamAsClass("maxZ", Float.class).getOrDefault(Float.MAX_VALUE);
        int limit = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(10_000);
        int offset = ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0);

        boolean spatialFilter = ctx.queryParam("minX") != null || ctx.queryParam("maxX") != null
                || ctx.queryParam("minZ") != null || ctx.queryParam("maxZ") != null;

        try {
            List<Sector> filtered = new ArrayList<>();
            for (Sector s : sectorResult.sectors) {
                if (densityFilter != null && !densityFilter.equals(s.density))
                    continue;
                if (spatialFilter) {
                    if (s.world_x < minX || s.world_x > maxX)
                        continue;
                    if (s.world_z < minZ || s.world_z > maxZ)
                        continue;
                }
                filtered.add(s);
            }

            int total = filtered.size();
            int end = Math.min(offset + limit, total);
            List<Sector> page = (offset < total) ? filtered.subList(offset, end) : Collections.emptyList();

            ObjectNode envelope = mapper.createObjectNode();
            envelope.put("schema_version", "1");
            envelope.put("generated_at", Instant.now().toString());
            envelope.put("total", total);
            envelope.put("offset", offset);
            envelope.put("limit", limit);
            envelope.put("total_occupied", sectorResult.total_occupied);
            envelope.put("high_density", sectorResult.high_density);
            envelope.put("hotspot_count", sectorResult.hotspot_count);
            envelope.put("cell_size_m", sectorResult.cell_size_m);
            envelope.set("data", mapper.valueToTree(page));
            ctx.json(mapper.writeValueAsString(envelope));
        } catch (Exception e) {
            log.error("Failed to serialize sectors", e);
            ctx.status(500).json("{\"error\":\"serialization failure\"}");
        }
    }

    private void handleAlerts(Context ctx) {
        if (alerts == null) {
            ctx.status(503).json("{\"error\":\"Alerts not yet computed\"}");
            return;
        }
        String severityFilter = ctx.queryParam("severity");
        String typeFilter = ctx.queryParam("type");
        int limit = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(1_000);
        int offset = ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0);

        try {
            List<Alert> filtered = new ArrayList<>();
            for (Alert a : alerts.alerts) {
                if (severityFilter != null && !severityFilter.equals(a.severity))
                    continue;
                if (typeFilter != null && !typeFilter.equals(a.type))
                    continue;
                filtered.add(a);
            }

            int total = filtered.size();
            int end = Math.min(offset + limit, total);
            List<Alert> page = (offset < total) ? filtered.subList(offset, end) : Collections.emptyList();

            ObjectNode envelope = mapper.createObjectNode();
            envelope.put("schema_version", "1");
            envelope.put("generated_at", Instant.now().toString());
            envelope.put("total", total);
            envelope.put("offset", offset);
            envelope.put("limit", limit);
            envelope.put("critical", alerts.critical_count);
            envelope.put("high", alerts.high_count);
            envelope.put("medium", alerts.medium_count);
            envelope.put("low", alerts.low_count);
            envelope.set("data", mapper.valueToTree(page));
            ctx.json(mapper.writeValueAsString(envelope));
        } catch (Exception e) {
            log.error("Failed to serialize alerts", e);
            ctx.status(500).json("{\"error\":\"serialization failure\"}");
        }
    }

    private void handleEntities(Context ctx) {
        if (contracts == null) {
            ctx.status(503).json("{\"error\":\"World data still loading\"}");
            return;
        }
        String typeFilter = ctx.queryParam("type");
        String hostilityFilter = ctx.queryParam("hostility");
        String biomeFilter = ctx.queryParam("biome");
        String sourceFilter = ctx.queryParam("source");
        int limit = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(10_000);
        int offset = ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0);

        try {
            List<com.valheim.viewer.contract.ContractEntity> all = contracts.entities;
            List<com.valheim.viewer.contract.ContractEntity> filtered = new ArrayList<>();

            for (com.valheim.viewer.contract.ContractEntity e : all) {
                if (typeFilter != null && !typeFilter.equals(e.entity_type))
                    continue;
                if (hostilityFilter != null && !hostilityFilter.equals(e.hostility))
                    continue;
                if (biomeFilter != null && !biomeFilter.equals(e.biome_affinity))
                    continue;
                if (sourceFilter != null && !sourceFilter.equals(e.source))
                    continue;
                filtered.add(e);
            }

            int total = filtered.size();
            int end = Math.min(offset + limit, total);
            List<com.valheim.viewer.contract.ContractEntity> page = (offset < total) ? filtered.subList(offset, end)
                    : Collections.emptyList();

            ObjectNode envelope = mapper.createObjectNode();
            envelope.put("schema_version", "1");
            envelope.put("generated_at", Instant.now().toString());
            envelope.put("total", total);
            envelope.put("offset", offset);
            envelope.put("limit", limit);
            envelope.set("data", mapper.valueToTree(page));
            ctx.json(mapper.writeValueAsString(envelope));
        } catch (Exception e) {
            log.error("Failed to serialize entities", e);
            ctx.status(500).json("{\"error\":\"serialization failure\"}");
        }
    }

    private void handleWorldSummary(Context ctx) {
        if (contracts == null) {
            ObjectNode n = mapper.createObjectNode();
            n.put("error", "World data still loading");
            n.put("done", false);
            ctx.status(503).json(n.toString());
            return;
        }
        try {
            ObjectNode envelope = mapper.createObjectNode();
            envelope.put("schema_version", "1");
            envelope.put("generated_at", Instant.now().toString());
            envelope.set("data", mapper.valueToTree(contracts.summary));
            ctx.json(mapper.writeValueAsString(envelope));
        } catch (Exception e) {
            log.error("Failed to serialize world-summary", e);
            ctx.status(500).json("{\"error\":\"serialization failure\"}");
        }
    }

    private void handleMetricsSummary(Context ctx) {
        if (metrics == null) {
            ObjectNode n = mapper.createObjectNode();
            n.put("error", "Metrics not yet computed");
            n.put("done", false);
            ctx.status(503).json(n.toString());
            return;
        }
        try {
            ObjectNode envelope = mapper.createObjectNode();
            envelope.put("schema_version", "1");
            envelope.put("generated_at", Instant.now().toString());
            envelope.set("data", mapper.valueToTree(metrics));
            ctx.json(mapper.writeValueAsString(envelope));
        } catch (Exception e) {
            log.error("Failed to serialize metrics/summary", e);
            ctx.status(500).json("{\"error\":\"serialization failure\"}");
        }
    }

    // ----- PA5 Forensics handlers -----

    private void handleTopCoinCaches(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;
        int limit = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(50);

        // Sort + trim (the inline parser trims to 100; we may want fewer here)
        List<ZdoFlatStore.CoinCache> sorted = new ArrayList<>(s.topCoinCaches);
        sorted.sort((a, b) -> Long.compare(b.coins, a.coins));

        long totalCoins = 0;
        for (ZdoFlatStore.CoinCache c : sorted) totalCoins += c.coins;

        ObjectNode root = envelope(s);
        root.put("totalCachesTracked", sorted.size());
        root.put("totalCoinsTracked", totalCoins);
        ArrayNode arr = root.putArray("caches");
        for (int i = 0; i < Math.min(limit, sorted.size()); i++) {
            ZdoFlatStore.CoinCache c = sorted.get(i);
            ObjectNode n = arr.addObject();
            n.put("zdoIndex", c.zdoIndex);
            n.put("x", c.x); n.put("y", c.y); n.put("z", c.z);
            n.put("coins", c.coins);
            String prefab = (c.zdoIndex >= 0 && c.zdoIndex < s.size()) ? s.nameForHash(s.prefabId[c.zdoIndex]) : null;
            if (prefab != null) n.put("containerPrefab", prefab);
        }
        ctx.json(root.toString());
    }

    private void handleServerIssuers(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;
        int limit = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(100);

        // Compute totals per crafter
        List<Map.Entry<String, Map<String, Integer>>> sorted =
            new ArrayList<>(s.serverIssuerCatalog.entrySet());
        sorted.sort((a, b) -> Integer.compare(totalItems(b.getValue()), totalItems(a.getValue())));

        ObjectNode root = envelope(s);
        root.put("distinctIssuers", s.serverIssuerCatalog.size());
        root.put("totalServerIssuedItems", s.serverIssuedItemCount);
        ArrayNode arr = root.putArray("issuers");
        for (int i = 0; i < Math.min(limit, sorted.size()); i++) {
            Map.Entry<String, Map<String, Integer>> e = sorted.get(i);
            ObjectNode n = arr.addObject();
            n.put("crafter", e.getKey());
            int items = totalItems(e.getValue());
            n.put("itemCount", items);
            n.put("distinctTypes", e.getValue().size());
            // Top 5 sample items
            ArrayNode samples = n.putArray("topItems");
            e.getValue().entrySet().stream()
                .sorted((x, y) -> y.getValue() - x.getValue())
                .limit(5)
                .forEach(it -> {
                    ObjectNode o = samples.addObject();
                    o.put("name", it.getKey());
                    o.put("count", it.getValue());
                });
        }
        ctx.json(root.toString());
    }

    private void handleGuildGear(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;
        String issuer = ctx.queryParam("issuer");

        ObjectNode root = envelope(s);
        if (issuer == null || issuer.isEmpty()) {
            root.put("error", "?issuer=<crafterName> required. Use /api/v1/forensics/server-issuers to list available.");
            ctx.status(400).json(root.toString());
            return;
        }
        Map<String, Integer> cat = s.serverIssuerCatalog.get(issuer);
        if (cat == null) {
            root.put("error", "no items found for issuer '" + issuer + "'");
            root.put("hint", "GET /api/v1/forensics/server-issuers");
            ctx.status(404).json(root.toString());
            return;
        }
        root.put("issuer", issuer);
        root.put("totalItems", totalItems(cat));
        root.put("distinctTypes", cat.size());
        ArrayNode arr = root.putArray("items");
        cat.entrySet().stream()
            .sorted((a, b) -> b.getValue() - a.getValue())
            .forEach(e -> {
                ObjectNode n = arr.addObject();
                n.put("name", e.getKey());
                n.put("count", e.getValue());
                if (classification != null) classification.enrich(e.getKey(), n);
            });
        ctx.json(root.toString());
    }

    private static int totalItems(Map<String, Integer> cat) {
        int sum = 0; for (Integer v : cat.values()) sum += v; return sum;
    }

    // ----- Batch analytics cache handlers -----

    private void handleRenderedManifest(Context ctx) {
        AnalyticsCacheReader reader = requireAnalyticsCache(ctx);
        if (reader == null) return;
        try {
            Long snapshot = resolveSnapshotParam(ctx, reader, "snapshot", false);
            if (snapshot == null) return;
            File manifest = reader.manifestFile(snapshot);
            if (!manifest.exists()) {
                apiError(ctx, 404, "rendered manifest not found for snapshot " + snapshot);
                return;
            }
            ctx.contentType("application/json").result(Files.readString(manifest.toPath()));
        } catch (Exception e) {
            log.error("Failed to read rendered manifest", e);
            ctx.status(500).json("{\"error\":\"rendered manifest read failure\"}");
        }
    }

    private void handleRenderedFile(Context ctx) {
        AnalyticsCacheReader reader = requireAnalyticsCache(ctx);
        if (reader == null) return;
        try {
            Long snapshot = resolveSnapshotParam(ctx, reader, "snapshot", false);
            if (snapshot == null) return;
            File file = reader.renderedFile(snapshot, ctx.pathParam("file"));
            if (file == null) {
                ctx.status(400).json("{\"error\":\"invalid rendered file\"}");
                return;
            }
            if (!file.exists()) {
                ctx.status(404).json("{\"error\":\"rendered file not found\"}");
                return;
            }
            ctx.contentType("image/png").result(Files.readAllBytes(file.toPath()));
        } catch (Exception e) {
            log.error("Failed to read rendered file", e);
            ctx.status(500).json("{\"error\":\"rendered file read failure\"}");
        }
    }

    private void handleRenderedDeltaManifest(Context ctx) {
        AnalyticsCacheReader reader = requireAnalyticsCache(ctx);
        if (reader == null) return;
        try {
            long[] pair = resolveSnapshotPair(ctx, reader, true);
            if (pair == null) return;
            if (!reader.isDeltaPairInRecentMatrix(pair[0], pair[1])) {
                apiError(ctx, 404, "delta raster pair is outside this world's latest-six matrix");
                return;
            }
            File manifest = reader.deltaManifestFile(pair[0], pair[1]);
            if (!reader.deltaRasterAvailable(pair[0], pair[1])) {
                apiError(ctx, 404, "pre-rendered delta raster unavailable for pair " +
                    pair[0] + " -> " + pair[1]);
                return;
            }
            ctx.contentType("application/json").result(Files.readString(manifest.toPath()));
        } catch (Exception e) {
            log.error("Failed to read rendered delta manifest", e);
            ctx.status(500).json("{\"error\":\"rendered delta manifest read failure\"}");
        }
    }

    private void handleRenderedDeltaFile(Context ctx) {
        AnalyticsCacheReader reader = requireAnalyticsCache(ctx);
        if (reader == null) return;
        try {
            long[] pair = resolveSnapshotPair(ctx, reader, true);
            if (pair == null) return;
            if (!reader.isDeltaPairInRecentMatrix(pair[0], pair[1])) {
                apiError(ctx, 404, "delta raster pair is outside this world's latest-six matrix");
                return;
            }
            File file = reader.deltaRenderedFile(pair[0], pair[1], ctx.pathParam("file"));
            if (file == null) {
                apiError(ctx, 400, "invalid rendered delta file");
                return;
            }
            // This check also validates the manifest and all aligned pair channels.
            if (!reader.deltaRenderedFileAdvertised(pair[0], pair[1], ctx.pathParam("file"))) {
                apiError(ctx, 404, "rendered delta file is not advertised by this pair's manifest");
                return;
            }
            if (!file.isFile()) {
                apiError(ctx, 404, "rendered delta file not found");
                return;
            }
            ctx.contentType("image/png").result(Files.readAllBytes(file.toPath()));
        } catch (Exception e) {
            log.error("Failed to read rendered delta file", e);
            ctx.status(500).json("{\"error\":\"rendered delta file read failure\"}");
        }
    }

    private void handleDbZdoQuery(Context ctx) {
        AnalyticsCacheReader reader = requireAnalyticsCache(ctx);
        if (reader == null) return;
        try {
            Long snapshot = resolveSnapshotParam(ctx, reader, "snapshot", false);
            if (snapshot == null) return;
            float minX = ctx.queryParamAsClass("minX", Float.class).getOrDefault(-100_000f);
            float maxX = ctx.queryParamAsClass("maxX", Float.class).getOrDefault(100_000f);
            float minZ = ctx.queryParamAsClass("minZ", Float.class).getOrDefault(-100_000f);
            float maxZ = ctx.queryParamAsClass("maxZ", Float.class).getOrDefault(100_000f);
            String category = ctx.queryParam("category");
            String prefab = ctx.queryParam("prefab");
            Long creatorId = longQueryParam(ctx, "creatorId");
            int limit = clampLimit(ctx.queryParamAsClass("limit", Integer.class).getOrDefault(1_000), 20_000);
            int offset = Math.max(0, ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0));

            ctx.json(mapper.writeValueAsString(reader.queryZdos(
                mapper, snapshot, minX, maxX, minZ, maxZ, category, prefab, creatorId, limit, offset)));
        } catch (Exception e) {
            log.error("Failed DB ZDO query", e);
            ctx.status(500).json("{\"error\":\"db zdo query failure\"}");
        }
    }

    private void handleDbContainerItems(Context ctx) {
        AnalyticsCacheReader reader = requireAnalyticsCache(ctx);
        if (reader == null) return;
        try {
            Long snapshot = resolveSnapshotParam(ctx, reader, "snapshot", false);
            if (snapshot == null) return;
            float minX = ctx.queryParamAsClass("minX", Float.class).getOrDefault(-100_000f);
            float maxX = ctx.queryParamAsClass("maxX", Float.class).getOrDefault(100_000f);
            float minZ = ctx.queryParamAsClass("minZ", Float.class).getOrDefault(-100_000f);
            float maxZ = ctx.queryParamAsClass("maxZ", Float.class).getOrDefault(100_000f);
            String item = ctx.queryParam("item");
            int limit = clampLimit(ctx.queryParamAsClass("limit", Integer.class).getOrDefault(1_000), 20_000);
            int offset = Math.max(0, ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0));

            ctx.json(mapper.writeValueAsString(reader.queryContainerItems(
                mapper, snapshot, minX, maxX, minZ, maxZ, item, limit, offset)));
        } catch (Exception e) {
            log.error("Failed DB container item query", e);
            ctx.status(500).json("{\"error\":\"db container item query failure\"}");
        }
    }

    private void handleDbSelectionSummary(Context ctx) {
        AnalyticsCacheReader reader = requireAnalyticsCache(ctx);
        if (reader == null) return;
        try {
            Long snapshot = resolveSnapshotParam(ctx, reader, "snapshot", false);
            if (snapshot == null) return;
            float minX = ctx.queryParamAsClass("minX", Float.class).getOrDefault(-100_000f);
            float maxX = ctx.queryParamAsClass("maxX", Float.class).getOrDefault(100_000f);
            float minZ = ctx.queryParamAsClass("minZ", Float.class).getOrDefault(-100_000f);
            float maxZ = ctx.queryParamAsClass("maxZ", Float.class).getOrDefault(100_000f);
            int topN = clampLimit(ctx.queryParamAsClass("topN", Integer.class).getOrDefault(20), 100);
            ctx.json(mapper.writeValueAsString(reader.selectedAreaSummary(
                mapper, snapshot, minX, maxX, minZ, maxZ, topN)));
        } catch (Exception e) {
            log.error("Failed DB selection summary", e);
            ctx.status(500).json("{\"error\":\"db selection summary failure\"}");
        }
    }

    /**
     * What changed inside one rectangle between two snapshots — the drill-down behind a spatial
     * hotspot. selection-summary answers the same shape of question for a single snapshot.
     */
    private void handleDbSelectionDelta(Context ctx) {
        AnalyticsCacheReader reader = requireAnalyticsCache(ctx);
        if (reader == null) return;
        try {
            // Canonical order, so "added" always means "appeared in the newer snapshot" and the
            // drill-down agrees with the raster it was launched from.
            long[] pair = resolveSnapshotPair(ctx, reader, true);
            if (pair == null) return;
            double minX = ctx.queryParamAsClass("minX", Double.class).getOrDefault(-100_000d);
            double maxX = ctx.queryParamAsClass("maxX", Double.class).getOrDefault(100_000d);
            double minZ = ctx.queryParamAsClass("minZ", Double.class).getOrDefault(-100_000d);
            double maxZ = ctx.queryParamAsClass("maxZ", Double.class).getOrDefault(100_000d);
            int topN = clampLimit(ctx.queryParamAsClass("topN", Integer.class).getOrDefault(20), 100);

            SnapshotDeltaEngine.BoundedDelta d = SnapshotDeltaEngine.computeBoundedDelta(
                reader.connection(), pair[0], pair[1], minX, maxX, minZ, maxZ, topN);

            ObjectNode root = mapper.createObjectNode();
            root.put("fromSnapshotId", pair[0]);
            root.put("toSnapshotId", pair[1]);
            ObjectNode bounds = root.putObject("bounds");
            bounds.put("minX", minX); bounds.put("maxX", maxX);
            bounds.put("minZ", minZ); bounds.put("maxZ", maxZ);
            root.put("addedTotal", d.addedTotal());
            root.put("removedTotal", d.removedTotal());
            // {key,value} rows so the frontend reuses the same ranked-bar renderer as
            // selection-summary rather than growing a second row shape.
            putPrefabRows(root.putArray("addedPrefabs"), d.addedPrefabs());
            putPrefabRows(root.putArray("removedPrefabs"), d.removedPrefabs());
            ObjectNode addedCat = root.putObject("addedByCategory");
            d.addedByCategory().forEach(addedCat::put);
            ObjectNode removedCat = root.putObject("removedByCategory");
            d.removedByCategory().forEach(removedCat::put);
            root.put("truncated", d.truncated());
            ctx.json(mapper.writeValueAsString(root));
        } catch (Exception e) {
            log.error("Failed DB selection delta", e);
            ctx.status(500).json("{\"error\":\"db selection delta failure\"}");
        }
    }

    private void putPrefabRows(ArrayNode arr, java.util.List<SnapshotDeltaEngine.PrefabDelta> rows) {
        for (SnapshotDeltaEngine.PrefabDelta r : rows) {
            ObjectNode n = arr.addObject();
            n.put("key", r.prefab());
            n.put("value", r.count());
            n.put("category", r.category());
        }
    }

    private static final Set<String> KNOWN_ZDO_CATEGORIES = Set.of(
        "NATURE", "BUILDING", "DROPPED_ITEM", "ITEM_STAND", "CONTAINER", "CREATURE",
        "PORTAL", "BED", "TOMBSTONE", "SIGN", "BALLISTA", "UNKNOWN", "STRUCTURE", "INTERIOR");

    private void handleDbSpawnHistogram(Context ctx) {
        AnalyticsCacheReader reader = requireAnalyticsCache(ctx);
        if (reader == null) return;
        try {
            Long snapshot = resolveSnapshotParam(ctx, reader, "snapshot", false);
            if (snapshot == null) return;
            int buckets = Math.max(8, Math.min(80,
                ctx.queryParamAsClass("buckets", Integer.class).getOrDefault(40)));
            String category = ctx.queryParam("category");
            if (category != null && !category.isBlank() &&
                    !KNOWN_ZDO_CATEGORIES.contains(category.toUpperCase())) {
                apiError(ctx, 400, "unknown category: " + category);
                return;
            }
            ctx.json(mapper.writeValueAsString(reader.spawnFractionHistogram(
                mapper, snapshot, buckets,
                category == null || category.isBlank() ? null : category.toUpperCase())));
        } catch (Exception e) {
            log.error("Failed DB spawn histogram", e);
            ctx.status(500).json("{\"error\":\"db spawn histogram failure\"}");
        }
    }

    /** Serializes post-ingest work (delta compute + raster renders) behind the response. */
    private final java.util.concurrent.ExecutorService ingestPostWork =
        java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "ingest-post-work");
            t.setDaemon(true);
            return t;
        });

    private static boolean ingestDisabled() {
        String v = System.getenv("STEWARD_DISABLE_INGEST");
        return v != null && (v.equals("1") || v.equalsIgnoreCase("true"));
    }

    private void handleDbSnapshotIngest(Context ctx) {
        if (ingestDisabled()) {
            ctx.status(403).json("{\"error\":\"ingest is disabled on this instance; " +
                "production history flows through the publish lane\"}");
            return;
        }
        AnalyticsCacheReader reader = requireAnalyticsCache(ctx);
        if (reader == null) return;
        try {
            ObjectNode body = (ObjectNode) mapper.readTree(ctx.body());
            String filePath = body.has("filePath") ? body.get("filePath").asText() : "";
            if (filePath.isBlank()) {
                ctx.status(400).json("{\"error\":\"missing required 'filePath' parameter\"}");
                return;
            }

            File saveFile = new File(filePath);
            SnapshotProvenance prov = new SnapshotProvenance(
                    body.has("worldId") ? body.get("worldId").asText() : saveFile.getName().replace(".db", ""),
                    body.has("worldName") ? body.get("worldName").asText() : saveFile.getName().replace(".db", ""),
                    body.has("source") ? body.get("source").asText() : "local",
                    body.has("backupId") ? body.get("backupId").asText() : "bak_manual",
                    body.has("saveTimestamp") ? body.get("saveTimestamp").asText() : null,
                    body.has("fileHash") ? body.get("fileHash").asText() : "",
                    SnapshotProvenance.DEFAULT_PARSER_VERSION,
                    SnapshotProvenance.CURRENT_SCHEMA_VERSION
            );

            // Run ingestion through writable cache: parse + unindexed append + index rebuild.
            // Delta compute and raster renders run after the response — the delta of a 9M-ZDO
            // world can take minutes and blocking the HTTP response on it caused client timeouts.
            ObjectNode receipt;
            try (AnalyticsCache cache = new AnalyticsCache(reader.dbFile(), false)) {
                receipt = SnapshotIngestService.processIngest(saveFile, prov, cache, true);
            }

            long newSnapshotId = receipt.path("snapshotId").asLong(0);
            long prevSnapshotId = receipt.path("delta").path("prevSnapshotId").asLong(-1);
            if (newSnapshotId > 0) {
                receipt.put("postWorkQueued", true);
                ingestPostWork.submit(() -> runIngestPostWork(reader, prevSnapshotId, newSnapshotId));
            }
            ctx.json(receipt.toString());
        } catch (Exception e) {
            log.error("Snapshot ingestion failed", e);
            ctx.status(500).json("{\"error\":\"snapshot ingestion failed: " + e.getMessage() + "\"}");
        }
    }

    /** Post-response ingest work: delta compute + raster renders. Failures log, never throw. */
    private void runIngestPostWork(AnalyticsCacheReader reader, long prevSnapshotId, long newSnapshotId) {
        if (prevSnapshotId > 0) {
            try (AnalyticsCache cache = new AnalyticsCache(reader.dbFile(), false)) {
                SnapshotDeltaEngine.DeltaResult delta =
                    SnapshotDeltaEngine.computeDelta(cache.connection(), prevSnapshotId, newSnapshotId);
                cache.recordDelta(prevSnapshotId, delta.zdosAdded(), delta.zdosRemoved(),
                    delta.zdosModified(), delta.containerItemsDelta());
                log.info("Deferred delta recorded for {} -> {}: +{} -{}", prevSnapshotId, newSnapshotId,
                    delta.zdosAdded(), delta.zdosRemoved());
            } catch (Exception e) {
                log.error("Deferred delta compute failed for {} -> {}", prevSnapshotId, newSnapshotId, e);
            }
        }
        try {
            new RenderedLayerBuilder(reader.dbFile(), reader.renderDir(), newSnapshotId).renderDefaults();
        } catch (Exception e) {
            log.error("Rendered layer build failed for snapshot {}", newSnapshotId, e);
        }
        try {
            int pairs = new RenderedDeltaLayerBuilder(reader.dbFile(), reader.renderDir()).renderRecentPairs();
            log.info("Post-ingest delta raster pass rendered {} pair(s)", pairs);
        } catch (Exception e) {
            log.error("Rendered delta layer build failed after snapshot {}", newSnapshotId, e);
        }
        try {
            reader.refreshLatestSnapshotId();
        } catch (Exception e) {
            log.warn("Could not refresh latest analytics snapshot after ingest: {}", e.toString());
        }
    }

    private void handleDbSnapshotsList(Context ctx) {
        AnalyticsCacheReader reader = requireAnalyticsCache(ctx);
        if (reader == null) return;
        try {
            String worldId = ctx.queryParam("worldId");
            if (worldId != null && !worldId.isBlank() && !reader.worldExists(worldId)) {
                apiError(ctx, 404, "world not found: " + worldId);
                return;
            }
            ctx.json(mapper.writeValueAsString(reader.listSnapshots(mapper, worldId)));
        } catch (Exception e) {
            log.error("Failed listing snapshots", e);
            ctx.status(500).json("{\"error\":\"failed listing snapshots\"}");
        }
    }

    private void handleDbSnapshotDelta(Context ctx) {
        AnalyticsCacheReader reader = requireAnalyticsCache(ctx);
        if (reader == null) return;
        try {
            Long snapshotId = resolveSnapshotParam(ctx, reader, "snapshotId", false);
            if (snapshotId == null) return;
            ctx.json(mapper.writeValueAsString(reader.getSnapshotDelta(mapper, snapshotId)));
        } catch (Exception e) {
            log.error("Failed fetching snapshot delta", e);
            ctx.status(500).json("{\"error\":\"failed fetching snapshot delta\"}");
        }
    }

    private void handleDbSnapshotsCompare(Context ctx) {
        AnalyticsCacheReader reader = requireAnalyticsCache(ctx);
        if (reader == null) return;
        try {
            long[] pair = resolveSnapshotPair(ctx, reader, false);
            if (pair == null) return;
            long fromId = pair[0];
            long toId = pair[1];

            SnapshotDeltaEngine.DeltaResult delta = SnapshotDeltaEngine.computeDelta(reader.connection(), fromId, toId);
            ObjectNode root = mapper.createObjectNode();
            root.put("fromSnapshotId", delta.fromSnapshotId());
            root.put("toSnapshotId", delta.toSnapshotId());
            root.put("zdosAdded", delta.zdosAdded());
            root.put("zdosRemoved", delta.zdosRemoved());
            root.put("zdosModified", delta.zdosModified());
            root.put("containerItemsDelta", delta.containerItemsDelta());
            root.put("newPortals", delta.newPortals());
            root.put("newTombstones", delta.newTombstones());

            ObjectNode addedObj = root.putObject("addedPrefabs");
            delta.addedPrefabs().forEach(addedObj::put);

            ObjectNode removedObj = root.putObject("removedPrefabs");
            delta.removedPrefabs().forEach(removedObj::put);

            // Added alongside the maps above, not in place of them. The maps are ordered
            // descending server-side, but JSON object key order is not a contract and a JS
            // client reorders integer-like keys regardless — so a client that wants a ranked,
            // category-aware list needs an array. Invoke-SyntheticHistory's Validate stage
            // records this payload verbatim, so the existing fields must not move.
            ArrayNode addedDetail = root.putArray("addedPrefabDetail");
            delta.addedPrefabs().forEach((prefab, count) -> {
                ObjectNode n = addedDetail.addObject();
                n.put("prefab", prefab);
                n.put("count", count);
            });
            ArrayNode removedDetail = root.putArray("removedPrefabDetail");
            delta.removedPrefabs().forEach((prefab, count) -> {
                ObjectNode n = removedDetail.addObject();
                n.put("prefab", prefab);
                n.put("count", count);
            });

            // Per-category breakdown: CREATURE and DROPPED_ITEM churn between any two saves
            // because those objects move. Surfacing it keeps movement out of "build activity".
            ObjectNode addedCat = root.putObject("addedByCategory");
            delta.addedByCategory().forEach(addedCat::put);
            ObjectNode removedCat = root.putObject("removedByCategory");
            delta.removedByCategory().forEach(removedCat::put);

            root.put("zdoCountFrom", delta.zdoCountFrom());
            root.put("zdoCountTo",   delta.zdoCountTo());
            root.put("reconciles",   delta.reconciles());
            if (!delta.reconciles()) {
                root.put("reconcileWarning", "added - removed != countTo - countFrom. Some objects share "
                    + "identical coordinates, and a change in how many sit at one spot is invisible to a "
                    + "presence-based comparison. Treat these counts as a lower bound on real churn.");
            }

            root.put("fromDictionaryVersion", delta.fromDictionaryVersion());
            root.put("toDictionaryVersion",   delta.toDictionaryVersion());
            root.put("dictionaryMismatch",    delta.dictionaryMismatch());
            if (delta.dictionaryMismatch()) {
                root.put("warning", "These snapshots were named by different prefab dictionaries ("
                    + delta.fromDictionaryVersion() + " vs " + delta.toDictionaryVersion()
                    + "). Prefab breakdowns are not comparable — renames will read as world changes.");
            }

            ctx.json(root.toString());
        } catch (Exception e) {
            log.error("Failed comparing snapshots", e);
            ctx.status(500).json("{\"error\":\"failed comparing snapshots\"}");
        }
    }

    // ----- Helpers -----

    private ZdoFlatStore requireStore(Context ctx) {
        if (store == null) {
            ObjectNode n = mapper.createObjectNode();
            n.put("error", "World data still loading");
            n.put("done", false);
            ctx.status(503).json(n.toString());
            return null;
        }
        return store;
    }

    private AnalyticsCacheReader requireAnalyticsCache(Context ctx) {
        if (analyticsCacheReader == null) {
            ctx.status(503).json("{\"error\":\"analytics cache not available\"}");
            return null;
        }
        return analyticsCacheReader;
    }

    /** Resolve and validate an optional/required snapshot id without treating malformed input as absent. */
    private Long resolveSnapshotParam(Context ctx, AnalyticsCacheReader reader,
            String paramName, boolean required) throws Exception {
        String raw = ctx.queryParam(paramName);
        long snapshotId;
        if (raw == null || raw.isBlank()) {
            if (required) {
                apiError(ctx, 400, "missing required '" + paramName + "' snapshot parameter");
                return null;
            }
            snapshotId = reader.snapshotId();
        } else {
            try {
                snapshotId = Long.parseLong(raw);
            } catch (NumberFormatException e) {
                apiError(ctx, 400, "'" + paramName + "' must be a positive integer snapshot id");
                return null;
            }
        }
        if (snapshotId <= 0) {
            apiError(ctx, 400, "'" + paramName + "' must be a positive integer snapshot id");
            return null;
        }

        AnalyticsCacheReader.SnapshotInfo info = reader.snapshotInfo(snapshotId);
        if (info == null) {
            apiError(ctx, 404, "snapshot not found: " + snapshotId);
            return null;
        }
        String requestedWorld = ctx.queryParam("worldId");
        if (requestedWorld != null && !requestedWorld.isBlank() &&
                !Objects.equals(requestedWorld, info.worldId())) {
            apiError(ctx, 409, "snapshot " + snapshotId + " belongs to world '" +
                info.worldId() + "', not '" + requestedWorld + "'");
            return null;
        }
        return snapshotId;
    }

    /** Validate existence/world membership for a pair; optionally require canonical raster order. */
    private long[] resolveSnapshotPair(Context ctx, AnalyticsCacheReader reader, boolean canonicalRasterOrder)
            throws Exception {
        Long fromId = resolveSnapshotParam(ctx, reader, "from", true);
        if (fromId == null) return null;
        Long toId = resolveSnapshotParam(ctx, reader, "to", true);
        if (toId == null) return null;
        if (fromId.equals(toId)) {
            apiError(ctx, 400, "'from' and 'to' must identify different snapshots");
            return null;
        }

        AnalyticsCacheReader.SnapshotInfo from = reader.snapshotInfo(fromId);
        AnalyticsCacheReader.SnapshotInfo to = reader.snapshotInfo(toId);
        if (from.worldId() == null || from.worldId().isBlank() ||
                to.worldId() == null || to.worldId().isBlank()) {
            apiError(ctx, 409, "both snapshots must have world provenance before they can be compared");
            return null;
        }
        if (!Objects.equals(from.worldId(), to.worldId())) {
            apiError(ctx, 409, "snapshots belong to different worlds ('" + from.worldId() +
                "' vs '" + to.worldId() + "')");
            return null;
        }
        if (canonicalRasterOrder && fromId >= toId) {
            apiError(ctx, 400, "delta rasters use canonical order: older/lower snapshot as 'from' " +
                "and newer/higher snapshot as 'to'");
            return null;
        }
        return new long[] {fromId, toId};
    }

    private void apiError(Context ctx, int status, String message) {
        ObjectNode error = mapper.createObjectNode();
        error.put("error", message);
        ctx.status(status).json(error.toString());
    }

    private ObjectNode envelope(ZdoFlatStore s) {
        ObjectNode node = mapper.createObjectNode();
        node.put("apiVersion", API_VERSION);
        node.put("schemaVersion", SCHEMA_VERSION);
        node.put("snapshotNetTime", s.netTimeSeconds);
        return node;
    }

    private static byte catToByte(String name) {
        switch (name.toUpperCase()) {
            case "BUILDING":
                return Categories.BUILDING;
            case "DROPPED_ITEM":
                return Categories.DROPPED_ITEM;
            case "ITEM_STAND":
                return Categories.ITEM_STAND;
            case "CONTAINER":
                return Categories.CONTAINER;
            case "CREATURE":
                return Categories.CREATURE;
            case "PORTAL":
                return Categories.PORTAL;
            case "BED":
                return Categories.BED;
            case "TOMBSTONE":
                return Categories.TOMBSTONE;
            case "SIGN":
                return Categories.SIGN;
            case "BALLISTA":
                return Categories.BALLISTA;
            case "NATURE":
                return Categories.NATURE;
            case "STRUCTURE":
                return Categories.STRUCTURE;
            case "INTERIOR":
                return Categories.INTERIOR;
            default:
                return Categories.UNKNOWN;
        }
    }

    private static int clampLimit(int value, int max) {
        if (value < 1) return 1;
        return Math.min(value, max);
    }

    private static Long longQueryParam(Context ctx, String name) {
        String raw = ctx.queryParam(name);
        if (raw == null || raw.isEmpty()) return null;
        try {
            return Long.parseLong(raw);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
