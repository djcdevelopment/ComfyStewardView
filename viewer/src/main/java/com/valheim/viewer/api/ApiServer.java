package com.valheim.viewer.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.*;
import com.valheim.viewer.contract.Alert;
import com.valheim.viewer.contract.Sector;
import com.valheim.viewer.contract.Structure;
import com.valheim.viewer.contract.WorldContracts;
import com.valheim.viewer.extractor.AlertResult;
import com.valheim.viewer.extractor.MetricsResult;
import com.valheim.viewer.extractor.SectorResult;
import com.valheim.viewer.store.HeatmapGrid;
import com.valheim.viewer.store.ZdoFlatStore;
import com.valheim.viewer.store.ZdoFlatStore.Categories;
import com.valheim.viewer.store.ZdoFlatStore.PlayerRecord;
import com.valheim.viewer.parser.WorldParser;
import io.javalin.Javalin;
import io.javalin.http.Context;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.*;
import java.util.stream.*;

/**
 * Javalin HTTP server exposing the world viewer REST API.
 *
 * All endpoints return JSON with envelope:
 *   { "apiVersion":"1.0", "schemaVersion":1, "snapshotNetTime": ..., ...data... }
 */
public class ApiServer {

    private static final Logger log = LoggerFactory.getLogger(ApiServer.class);
    private static final String API_VERSION    = "1.0";
    private static final int    SCHEMA_VERSION = 1;

    private final Javalin app;
    private final ObjectMapper mapper = new ObjectMapper();
    private final WorldParser parser;

    private volatile ZdoFlatStore   store     = null;
    private volatile WorldContracts contracts = null;
    private volatile MetricsResult  metrics   = null;
    private volatile AlertResult    alerts    = null;
    private volatile SectorResult   sectorResult = null;

    public ApiServer(WorldParser parser) {
        this.parser = parser;
        this.app = Javalin.create(config -> {
            config.staticFiles.add("/static");
            config.bundledPlugins.enableCors(cors -> cors.addRule(rule -> {
                rule.anyHost();
            }));
        });
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

    private void registerRoutes() {
        // Loading status — polled by frontend during parse
        app.get("/api/v1/status", this::handleStatus);

        // Summary stats
        app.get("/api/v1/summary", this::handleSummary);

        // Heatmap data — query: ?type=BUILDING|DROPPED_ITEM|ALL&cellSize=500
        app.get("/api/v1/heatmap", this::handleHeatmap);

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
        app.get("/api/v1/world-summary",    this::handleWorldSummary);
        app.get("/api/v1/metrics/summary",  this::handleMetricsSummary);

        // Phase 2b — classified contract data
        // query: ?type=monster|boss|npc|animal  &hostility=hostile|passive|neutral
        //        &biome=meadows|swamp|...        &source=vanilla|mod
        //        &limit=N  &offset=N
        app.get("/api/v1/entities",         this::handleEntities);

        // Phase 3a — steward alerts
        // query: ?severity=critical|high|medium|low  &type=portal_orphaned|...
        //        &limit=N  &offset=N
        app.get("/api/v1/alerts",           this::handleAlerts);

        // Phase 3b — world sectors
        // query: ?density=normal|high|hotspot
        //        &minX=  &maxX=  &minZ=  &maxZ=  (world-coordinate bounding box)
        //        &limit=N  &offset=N
        app.get("/api/v1/sectors",          this::handleSectors);

        // Phase 4 — detected structures
        // query: ?type=dungeon_entrance|cave_entrance|camp|boss_altar|ruin
        //        &status=active|likely_cleared|unknown
        //        &biome=meadows|black_forest|swamp|mountain|plains|mistlands|ashlands
        //        &limit=N  &offset=N
        app.get("/api/v1/structures",       this::handleStructures);
    }

    // ----- Handlers -----

    private void handleStatus(Context ctx) {
        WorldParser.ParseProgress p = parser.getProgress();
        ObjectNode node = mapper.createObjectNode();
        node.put("status",  p.status);
        node.put("parsed",  p.parsed);
        node.put("total",   p.total);
        node.put("pct",     p.pct);
        node.put("done",    p.done);
        ctx.json(node.toString());
    }

    private void handleSummary(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;

        // Count categories
        int[] catCounts = new int[12];
        for (int i = 0; i < s.size(); i++) catCounts[s.category[i]]++;

        // Total ZDOs = sum of all category index lists + heatmap counts for stored-only categories
        int storedZdos = s.size();
        int totalZdos  = s.allHeatmap.getTotalCount(); // all valid-position ZDOs

        ObjectNode root = envelope(s);
        root.put("totalZdos",       totalZdos);
        root.put("storedZdos",      storedZdos);
        root.put("buildingCount",   s.buildingCount);
        root.put("parseDurationMs", s.parseDurationMs);
        root.put("worldVersion",    s.worldVersion);

        ObjectNode cats = root.putObject("categoryCounts");
        for (int c = 0; c < 12; c++) {
            cats.put(Categories.name((byte)c), catCounts[c]);
        }

        root.put("playerCount",    s.players.size());
        root.put("portalCount",    s.portalIndices.size());
        root.put("containerCount", s.containerIndices.size());
        root.put("tombstoneCount", s.tombstoneIndices.size());
        root.put("signCount",      s.signIndices.size());
        root.put("bedCount",       s.bedIndices.size());
        root.put("droppedItemCount", s.droppedItemCounts.values().stream().mapToInt(Integer::intValue).sum());

        ctx.json(root.toString());
    }

    private void handleHeatmap(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;

        String type = ctx.queryParamAsClass("type", String.class).getOrDefault("BUILDING");
        HeatmapGrid grid;
        switch (type.toUpperCase()) {
            case "DROPPED_ITEM": grid = s.droppedItemHeatmap; break;
            case "ALL":          grid = s.allHeatmap;         break;
            default:             grid = s.buildingHeatmap;    break;
        }

        ObjectNode root = envelope(s);
        root.put("type",      type);
        root.put("cellSize",  grid.cellSize);
        root.put("maxCount",  grid.getMaxCount());
        root.put("totalCount", grid.getTotalCount());
        root.put("cellCount", grid.getCellCount());

        // All cells: [[cx, cz, count], ...]
        ArrayNode cellsArr = root.putArray("cells");
        for (int[] cell : grid.getCells()) {
            ArrayNode row = cellsArr.addArray();
            row.add(cell[0]); row.add(cell[1]); row.add(cell[2]);
        }
        ctx.json(root.toString());
    }

    private void handlePortals(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;

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
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;

            String tag    = s.label1[idx] != null ? s.label1[idx] : "";
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
            p.put("id",     String.valueOf(idx));
            p.put("x",      x);
            p.put("z",      z);
            p.put("tag",    tag);
            p.put("status", status);
            if (author != null) p.put("author", author);
            if (paired != null && paired >= 0) {
                p.put("pairedId", String.valueOf(paired));
                p.put("pairedX",  s.posX[paired]);
                p.put("pairedZ",  s.posZ[paired]);
            }
        }
        ctx.json(root.toString());
    }

    private void handleContainers(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;
        int limit = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(500);
        int offset = ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0);

        ObjectNode root = envelope(s);
        root.put("total", s.containerIndices.size());
        ArrayNode list = root.putArray("containers");

        int end = Math.min(offset + limit, s.containerIndices.size());
        for (int j = offset; j < end; j++) {
            int idx = s.containerIndices.get(j);
            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;

            ObjectNode c = list.addObject();
            c.put("id",   String.valueOf(idx));
            c.put("name", s.nameForHash(s.prefabId[idx]));
            c.put("x",    x);
            c.put("z",    z);
        }
        ctx.json(root.toString());
    }

    private void handleEconomy(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;
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
            item.put("name",  e.getKey());
            item.put("count", e.getValue());
        }
        ctx.json(root.toString());
    }

    private void handlePlayers(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;
        String sortBy = ctx.queryParamAsClass("sortBy", String.class).getOrDefault("beds");

        List<PlayerRecord> players = new ArrayList<>(s.players.values());
        switch (sortBy) {
            case "deaths":  players.sort((a, b) -> b.deathCount - a.deathCount); break;
            case "builds":  players.sort((a, b) -> b.buildCount - a.buildCount); break;
            case "portals": players.sort((a, b) -> b.portalCount - a.portalCount); break;
            default:        players.sort((a, b) -> b.bedCount - a.bedCount); break;
        }

        ObjectNode root = envelope(s);
        root.put("total", players.size());
        ArrayNode list = root.putArray("players");

        for (PlayerRecord pr : players) {
            ObjectNode p = list.addObject();
            p.put("internalId",  pr.internalId);
            p.put("displayName", pr.displayName != null ? pr.displayName : "Player #" + pr.internalId);
            p.put("nameSource",  pr.nameSource);
            p.put("confidence",  pr.confidence);
            p.put("bedCount",    pr.bedCount);
            p.put("deathCount",  pr.deathCount);
            p.put("buildCount",  pr.buildCount);
            p.put("portalCount", pr.portalCount);
            if (pr.steam64 != null) p.put("steam64", pr.steam64);
        }
        ctx.json(root.toString());
    }

    private void handleTombstones(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;
        String player = ctx.queryParam("player");

        ObjectNode root = envelope(s);
        ArrayNode list = root.putArray("tombstones");

        for (int idx : s.tombstoneIndices) {
            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;

            String ownerName = s.label1[idx];
            if (player != null && !player.isEmpty()) {
                if (ownerName == null || !ownerName.toLowerCase().contains(player.toLowerCase())) continue;
            }

            double spawnSec = s.spawnTimeMicros[idx] / 1_000_000.0;
            double worldFrac = s.netTimeSeconds > 0 ? spawnSec / s.netTimeSeconds : 0;

            ObjectNode t = list.addObject();
            t.put("id",          String.valueOf(idx));
            t.put("ownerName",   ownerName != null ? ownerName : "Unknown");
            t.put("ownerId",     s.creatorId[idx]);
            t.put("x",           x);
            t.put("z",           z);
            t.put("deathTimeSeconds", spawnSec);
            t.put("worldFraction",    worldFrac);
        }
        root.put("total", list.size());
        ctx.json(root.toString());
    }

    private void handleSigns(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;
        String search = ctx.queryParam("search");
        int limit = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(200);

        ObjectNode root = envelope(s);
        ArrayNode list = root.putArray("signs");
        int count = 0;

        for (int idx : s.signIndices) {
            if (count >= limit) break;
            String text = s.label1[idx];
            if (text == null || text.isEmpty()) continue;
            if (search != null && !search.isEmpty() &&
                !text.toLowerCase().contains(search.toLowerCase())) continue;

            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;

            ObjectNode sg = list.addObject();
            sg.put("text",   text);
            sg.put("x",      x);
            sg.put("z",      z);
            if (s.label2[idx] != null) sg.put("author", s.label2[idx]);
            count++;
        }
        root.put("total", s.signIndices.size());
        ctx.json(root.toString());
    }

    private void handleBeds(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;
        String player = ctx.queryParam("player");

        ObjectNode root = envelope(s);
        ArrayNode list = root.putArray("beds");

        for (int idx : s.bedIndices) {
            float x = s.posX[idx], z = s.posZ[idx];
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;

            String ownerName = s.label1[idx];
            if (player != null && !player.isEmpty()) {
                if (ownerName == null || !ownerName.toLowerCase().contains(player.toLowerCase())) continue;
            }

            ObjectNode b = list.addObject();
            b.put("id",        String.valueOf(idx));
            b.put("ownerName", ownerName != null ? ownerName : "");
            b.put("ownerId",   s.creatorId[idx]);
            b.put("x",         x);
            b.put("z",         z);
            b.put("prefab",    s.nameForHash(s.prefabId[idx]));
        }
        root.put("total", s.bedIndices.size());
        ctx.json(root.toString());
    }

    private void handleDropped(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;

        List<Map.Entry<Integer, Integer>> sorted = new ArrayList<>(s.droppedItemCounts.entrySet());
        sorted.sort((a, b) -> b.getValue() - a.getValue());

        ObjectNode root = envelope(s);
        root.put("totalDropped", sorted.stream().mapToInt(Map.Entry::getValue).sum());
        ArrayNode list = root.putArray("types");
        for (Map.Entry<Integer, Integer> e : sorted) {
            ObjectNode item = list.addObject();
            item.put("hash",  e.getKey());
            item.put("name",  s.nameForHash(e.getKey()));
            item.put("count", e.getValue());
        }
        ctx.json(root.toString());
    }

    private void handlePoints(Context ctx) {
        ZdoFlatStore s = requireStore(ctx); if (s == null) return;

        String catStr = ctx.queryParamAsClass("cat", String.class).getOrDefault("PORTAL");
        float minX = ctx.queryParamAsClass("minX", Float.class).getOrDefault(-100_000f);
        float maxX = ctx.queryParamAsClass("maxX", Float.class).getOrDefault( 100_000f);
        float minZ = ctx.queryParamAsClass("minZ", Float.class).getOrDefault(-100_000f);
        float maxZ = ctx.queryParamAsClass("maxZ", Float.class).getOrDefault( 100_000f);
        int limit  = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(10_000);

        byte targetCat = catToByte(catStr);
        boolean spawnAfterFilter = ctx.queryParam("spawnedAfterFraction") != null;
        boolean spawnBeforeFilter = ctx.queryParam("spawnedBeforeFraction") != null;
        double spawnAfter  = spawnAfterFilter  ? Double.parseDouble(ctx.queryParam("spawnedAfterFraction"))  : 0;
        double spawnBefore = spawnBeforeFilter ? Double.parseDouble(ctx.queryParam("spawnedBeforeFraction")) : Double.MAX_VALUE;

        ObjectNode root = envelope(s);
        root.put("category", catStr);
        ArrayNode list = root.putArray("points");
        int count = 0;

        for (int i = 0; i < s.size() && count < limit; i++) {
            if (s.category[i] != targetCat) continue;
            float x = s.posX[i], z = s.posZ[i];
            if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
            if (Math.abs(x) >= 100_000 || Math.abs(z) >= 100_000) continue;

            if (spawnAfterFilter || spawnBeforeFilter) {
                double frac = s.netTimeSeconds > 0
                    ? (s.spawnTimeMicros[i] / 1_000_000.0) / s.netTimeSeconds : 0;
                if (frac < spawnAfter || frac > spawnBefore) continue;
            }

            ObjectNode pt = list.addObject();
            pt.put("x", x);
            pt.put("z", z);
            if (s.label1[i] != null) pt.put("label", s.label1[i]);
            if (s.creatorId[i] != 0) {
                PlayerRecord pr = s.players.get(s.creatorId[i]);
                if (pr != null) pt.put("owner", pr.displayName);
            }
            count++;
        }
        root.put("returned", count);
        ctx.json(root.toString());
    }

    // ----- Contract handlers -----

    private void handleStructures(Context ctx) {
        if (contracts == null) {
            ctx.status(503).json("{\"error\":\"World data still loading\"}");
            return;
        }
        String typeFilter   = ctx.queryParam("type");
        String statusFilter = ctx.queryParam("status");
        String biomeFilter  = ctx.queryParam("biome");
        int    limit        = ctx.queryParamAsClass("limit",  Integer.class).getOrDefault(5_000);
        int    offset       = ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0);

        try {
            List<Structure> filtered = new ArrayList<>();
            for (Structure st : contracts.structures) {
                if (typeFilter   != null && !typeFilter.equals(st.type))     continue;
                if (statusFilter != null && !statusFilter.equals(st.status)) continue;
                if (biomeFilter  != null && !biomeFilter.equals(st.biome))   continue;
                filtered.add(st);
            }

            int total = filtered.size();
            int end   = Math.min(offset + limit, total);
            List<Structure> page = (offset < total) ? filtered.subList(offset, end)
                                                     : Collections.emptyList();

            ObjectNode envelope = mapper.createObjectNode();
            envelope.put("schema_version", "1");
            envelope.put("generated_at",   Instant.now().toString());
            envelope.put("total",          total);
            envelope.put("offset",         offset);
            envelope.put("limit",          limit);
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
        float  minX  = ctx.queryParamAsClass("minX",  Float.class).getOrDefault(-Float.MAX_VALUE);
        float  maxX  = ctx.queryParamAsClass("maxX",  Float.class).getOrDefault( Float.MAX_VALUE);
        float  minZ  = ctx.queryParamAsClass("minZ",  Float.class).getOrDefault(-Float.MAX_VALUE);
        float  maxZ  = ctx.queryParamAsClass("maxZ",  Float.class).getOrDefault( Float.MAX_VALUE);
        int    limit  = ctx.queryParamAsClass("limit",  Integer.class).getOrDefault(10_000);
        int    offset = ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0);

        boolean spatialFilter = ctx.queryParam("minX") != null || ctx.queryParam("maxX") != null
                             || ctx.queryParam("minZ") != null || ctx.queryParam("maxZ") != null;

        try {
            List<Sector> filtered = new ArrayList<>();
            for (Sector s : sectorResult.sectors) {
                if (densityFilter != null && !densityFilter.equals(s.density)) continue;
                if (spatialFilter) {
                    if (s.world_x < minX || s.world_x > maxX) continue;
                    if (s.world_z < minZ || s.world_z > maxZ) continue;
                }
                filtered.add(s);
            }

            int total = filtered.size();
            int end   = Math.min(offset + limit, total);
            List<Sector> page = (offset < total) ? filtered.subList(offset, end) : Collections.emptyList();

            ObjectNode envelope = mapper.createObjectNode();
            envelope.put("schema_version",  "1");
            envelope.put("generated_at",    Instant.now().toString());
            envelope.put("total",           total);
            envelope.put("offset",          offset);
            envelope.put("limit",           limit);
            envelope.put("total_occupied",  sectorResult.total_occupied);
            envelope.put("high_density",    sectorResult.high_density);
            envelope.put("hotspot_count",   sectorResult.hotspot_count);
            envelope.put("cell_size_m",     sectorResult.cell_size_m);
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
        String typeFilter     = ctx.queryParam("type");
        int    limit          = ctx.queryParamAsClass("limit",  Integer.class).getOrDefault(1_000);
        int    offset         = ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0);

        try {
            List<Alert> filtered = new ArrayList<>();
            for (Alert a : alerts.alerts) {
                if (severityFilter != null && !severityFilter.equals(a.severity)) continue;
                if (typeFilter     != null && !typeFilter.equals(a.type))         continue;
                filtered.add(a);
            }

            int total = filtered.size();
            int end   = Math.min(offset + limit, total);
            List<Alert> page = (offset < total) ? filtered.subList(offset, end) : Collections.emptyList();

            ObjectNode envelope = mapper.createObjectNode();
            envelope.put("schema_version", "1");
            envelope.put("generated_at", Instant.now().toString());
            envelope.put("total",    total);
            envelope.put("offset",   offset);
            envelope.put("limit",    limit);
            envelope.put("critical", alerts.critical_count);
            envelope.put("high",     alerts.high_count);
            envelope.put("medium",   alerts.medium_count);
            envelope.put("low",      alerts.low_count);
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
        String typeFilter      = ctx.queryParam("type");
        String hostilityFilter = ctx.queryParam("hostility");
        String biomeFilter     = ctx.queryParam("biome");
        String sourceFilter    = ctx.queryParam("source");
        int    limit           = ctx.queryParamAsClass("limit",  Integer.class).getOrDefault(10_000);
        int    offset          = ctx.queryParamAsClass("offset", Integer.class).getOrDefault(0);

        try {
            List<com.valheim.viewer.contract.ContractEntity> all = contracts.entities;
            List<com.valheim.viewer.contract.ContractEntity> filtered = new ArrayList<>();

            for (com.valheim.viewer.contract.ContractEntity e : all) {
                if (typeFilter      != null && !typeFilter.equals(e.entity_type))    continue;
                if (hostilityFilter != null && !hostilityFilter.equals(e.hostility)) continue;
                if (biomeFilter     != null && !biomeFilter.equals(e.biome_affinity)) continue;
                if (sourceFilter    != null && !sourceFilter.equals(e.source))       continue;
                filtered.add(e);
            }

            int total = filtered.size();
            int end   = Math.min(offset + limit, total);
            List<com.valheim.viewer.contract.ContractEntity> page =
                (offset < total) ? filtered.subList(offset, end) : Collections.emptyList();

            ObjectNode envelope = mapper.createObjectNode();
            envelope.put("schema_version", "1");
            envelope.put("generated_at", Instant.now().toString());
            envelope.put("total",  total);
            envelope.put("offset", offset);
            envelope.put("limit",  limit);
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

    private ObjectNode envelope(ZdoFlatStore s) {
        ObjectNode node = mapper.createObjectNode();
        node.put("apiVersion",       API_VERSION);
        node.put("schemaVersion",    SCHEMA_VERSION);
        node.put("snapshotNetTime",  s.netTimeSeconds);
        return node;
    }

    private static byte catToByte(String name) {
        switch (name.toUpperCase()) {
            case "BUILDING":     return Categories.BUILDING;
            case "DROPPED_ITEM": return Categories.DROPPED_ITEM;
            case "ITEM_STAND":   return Categories.ITEM_STAND;
            case "CONTAINER":    return Categories.CONTAINER;
            case "CREATURE":     return Categories.CREATURE;
            case "PORTAL":       return Categories.PORTAL;
            case "BED":          return Categories.BED;
            case "TOMBSTONE":    return Categories.TOMBSTONE;
            case "SIGN":         return Categories.SIGN;
            case "BALLISTA":     return Categories.BALLISTA;
            case "NATURE":       return Categories.NATURE;
            default:             return Categories.UNKNOWN;
        }
    }
}
