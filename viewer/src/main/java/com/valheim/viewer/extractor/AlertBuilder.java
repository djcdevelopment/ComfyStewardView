package com.valheim.viewer.extractor;

import com.valheim.viewer.config.StConfig;
import com.valheim.viewer.contract.Alert;
import com.valheim.viewer.contract.Portal;
import com.valheim.viewer.contract.WorldContracts;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;

/**
 * Generates typed, severity-ranked alerts from WorldContracts + MetricsResult.
 *
 * Contract boundary rule: no ZdoFlatStore references.
 * All input comes from WorldContracts (portals + summary) and MetricsResult.
 *
 * Alert types:
 *   portal_orphaned        medium  -- one alert per orphaned portal
 *   portal_blank_tag       low     -- one aggregate alert (count)
 *   portal_duplicate_tag   high    -- one alert per duplicate-tag group
 *   portal_cluster         medium  -- one alert per large spatial cluster
 *   zone_budget            varies  -- per region (medium >=75%, high >=90%, critical over)
 *   build_hotspot          medium  -- top N density hotspots
 *   dropped_hotspot        low     -- top N dropped-item hotspots
 *   economy_unknown_surge  medium  -- if unknown item ratio >= threshold
 */
public class AlertBuilder {

    private static final Logger log = LoggerFactory.getLogger(AlertBuilder.class);

    // Zone budget severity thresholds
    private static final double ZONE_WARN_PCT = 0.75;
    private static final double ZONE_HIGH_PCT = 0.90;

    // How many hotspot alerts to generate (top-N most intense cells)
    private static final int MAX_BUILD_HOTSPOT_ALERTS   = 20;
    private static final int MAX_DROPPED_HOTSPOT_ALERTS = 10;

    public AlertResult build(WorldContracts contracts, MetricsResult metrics) {
        long t0 = System.currentTimeMillis();
        StConfig cfg = StConfig.get();

        List<Alert> alerts = new ArrayList<>();

        buildPortalAlerts(contracts, metrics, cfg, alerts);
        buildZoneBudgetAlerts(metrics, alerts);
        buildHotspotAlerts(metrics, alerts);
        buildEconomySurgeAlert(contracts, cfg, alerts);

        AlertResult result = new AlertResult();
        result.alerts = alerts;
        for (Alert a : alerts) {
            switch (a.severity) {
                case "critical": result.critical_count++; break;
                case "high":     result.high_count++;     break;
                case "medium":   result.medium_count++;   break;
                case "low":      result.low_count++;      break;
            }
        }

        log.info("AlertBuilder: {} alerts (critical={} high={} medium={} low={}) in {}ms",
            alerts.size(), result.critical_count, result.high_count,
            result.medium_count, result.low_count, System.currentTimeMillis() - t0);

        return result;
    }

    // ---- Portal alerts ----

    private void buildPortalAlerts(WorldContracts contracts, MetricsResult metrics,
                                   StConfig cfg, List<Alert> out) {
        List<Portal> portals = contracts.portals;

        // orphaned: one alert per orphaned portal (has a tag, no pair)
        for (Portal p : portals) {
            if (!p.issues.contains("orphaned")) continue;
            String tag = p.tag != null ? p.tag : "(no tag)";
            out.add(new Alert(
                "portal-orphaned-" + p.id,
                "portal_orphaned", "medium",
                "Orphaned portal \"" + tag + "\"",
                "Portal \"" + tag + "\" has no partner. Players cannot use this portal."
            ).at(p.position.x, p.position.z)
             .meta("portal_id", p.id)
             .meta("tag", tag));
        }

        // blank tag: one aggregate alert
        long blankCount = portals.stream().filter(p -> p.issues.contains("blank_tag")).count();
        if (blankCount > 0) {
            out.add(new Alert(
                "portal-blank-aggregate",
                "portal_blank_tag", "low",
                blankCount + " portal" + (blankCount == 1 ? "" : "s") + " with no tag",
                "Untagged portals cannot be paired. Assign unique tags to all portals."
            ).meta("count", (int) blankCount));
        }

        // duplicate tag: one alert per duplicate group (3+ portals share a tag)
        Map<String, List<Portal>> byTag = new LinkedHashMap<>();
        for (Portal p : portals) {
            if (p.tag == null || p.tag.isEmpty()) continue;
            byTag.computeIfAbsent(p.tag, _k -> new ArrayList<>()).add(p);
        }
        for (Map.Entry<String, List<Portal>> e : byTag.entrySet()) {
            if (e.getValue().size() < 3) continue;
            List<Portal> group = e.getValue();
            double cx = group.stream().mapToDouble(p -> p.position.x).average().orElse(0);
            double cz = group.stream().mapToDouble(p -> p.position.z).average().orElse(0);
            String tag = e.getKey();
            List<String> ids = new ArrayList<>();
            for (Portal p : group) ids.add(p.id);
            out.add(new Alert(
                "portal-duplicate-" + sanitizeId(tag),
                "portal_duplicate_tag", "high",
                "Tag \"" + tag + "\" shared by " + group.size() + " portals",
                "Tag \"" + tag + "\" is used by " + group.size() +
                    " portals. Only 2 portals may share a tag; extras create routing ambiguity."
            ).at(cx, cz)
             .meta("tag", tag)
             .meta("count", group.size())
             .meta("portal_ids", ids));
        }

        // portal cluster: one alert per cluster above the minimum size threshold
        for (int i = 0; i < metrics.portalClusters.size(); i++) {
            MetricsResult.Cluster c = metrics.portalClusters.get(i);
            if (c.count < cfg.portalClusterMinSize) continue;
            out.add(new Alert(
                "portal-cluster-" + i,
                "portal_cluster", "medium",
                "Portal cluster: " + c.count + " portals within " + (int) c.radius_m + "m",
                c.count + " portals are grouped within " + (int) c.radius_m +
                    "m of each other. Consider spreading portals to reduce clutter."
            ).at(c.center.x, c.center.z)
             .meta("count", c.count)
             .meta("radius_m", (int) c.radius_m)
             .meta("member_ids", c.member_ids.subList(0, Math.min(10, c.member_ids.size()))));
        }
    }

    // ---- Zone budget alerts ----

    private void buildZoneBudgetAlerts(MetricsResult metrics, List<Alert> out) {
        for (MetricsResult.ZoneBudget zb : metrics.zoneBudgets) {
            double pct = zb.pct_used;
            if (pct < ZONE_WARN_PCT) continue;

            String severity, titleVerb;
            if (zb.over_budget) {
                severity  = "critical";
                titleVerb = "over budget";
            } else if (pct >= ZONE_HIGH_PCT) {
                severity  = "high";
                titleVerb = "near budget limit";
            } else {
                severity  = "medium";
                titleVerb = "approaching budget";
            }

            int pctInt = (int) Math.round(pct * 100);
            out.add(new Alert(
                "zone-budget-" + sanitizeId(zb.region_name),
                "zone_budget", severity,
                "Region \"" + zb.region_name + "\" " + titleVerb + " (" + pctInt + "%)",
                "Region \"" + zb.region_name + "\" has " + zb.zdo_count + " of " + zb.limit +
                    " allowed ZDOs (" + pctInt + "%). High ZDO counts can cause server lag."
            ).at(zb.center.x, zb.center.z)
             .meta("region", zb.region_name)
             .meta("zdo_count", zb.zdo_count)
             .meta("limit", zb.limit)
             .meta("pct_used", pctInt)
             .meta("over_budget", zb.over_budget));
        }
    }

    // ---- Density hotspot alerts ----

    private void buildHotspotAlerts(MetricsResult metrics, List<Alert> out) {
        // General ZDO density hotspots (buildings + entities + containers)
        int cellM = metrics.densityStats.cell_size_m;
        List<MetricsResult.DensityCell> buildHots = metrics.hotspots;
        int bLimit = Math.min(MAX_BUILD_HOTSPOT_ALERTS, buildHots.size());
        for (int i = 0; i < bLimit; i++) {
            MetricsResult.DensityCell cell = buildHots.get(i);
            out.add(new Alert(
                "build-hotspot-" + i,
                "build_hotspot", "medium",
                "Build density hotspot: " + cell.count + " ZDOs in " + cellM + "m cell",
                cell.count + " ZDOs in a " + cellM + "m cell (" +
                    String.format("%.1f", cell.sigmas) + " sigma above mean). " +
                    "Dense areas increase server tick time."
            ).at(cell.world_x, cell.world_z)
             .meta("count", cell.count)
             .meta("sigmas", Math.round(cell.sigmas * 10) / 10.0)
             .meta("cell_size_m", cellM)
             .meta("cx", cell.cx)
             .meta("cz", cell.cz));
        }

        // Dropped item density hotspots
        int dCellM = metrics.droppedDensityStats.cell_size_m;
        List<MetricsResult.DensityCell> dropHots = metrics.droppedHotspots;
        int dLimit = Math.min(MAX_DROPPED_HOTSPOT_ALERTS, dropHots.size());
        for (int i = 0; i < dLimit; i++) {
            MetricsResult.DensityCell cell = dropHots.get(i);
            out.add(new Alert(
                "dropped-hotspot-" + i,
                "dropped_hotspot", "low",
                "Dropped item cluster: " + cell.count + " items in " + dCellM + "m cell",
                cell.count + " dropped items in a " + dCellM +
                    "m area. May indicate player death sites or loot piles affecting performance."
            ).at(cell.world_x, cell.world_z)
             .meta("count", cell.count)
             .meta("sigmas", Math.round(cell.sigmas * 10) / 10.0)
             .meta("cell_size_m", dCellM)
             .meta("cx", cell.cx)
             .meta("cz", cell.cz));
        }
    }

    // ---- Economy unknown surge alert ----

    private void buildEconomySurgeAlert(WorldContracts contracts, StConfig cfg, List<Alert> out) {
        int unique  = contracts.summary.stats.economy.unique_items;
        int unknown = contracts.summary.stats.economy.unknown_types;
        if (unique == 0) return;

        int unknownPct = (int) Math.round(unknown * 100.0 / unique);
        if (unknownPct < cfg.unknownSurgeThresholdPct) return;

        out.add(new Alert(
            "economy-surge",
            "economy_unknown_surge", "medium",
            unknownPct + "% of chest item types are unrecognised (" + unknown + "/" + unique + ")",
            unknown + " of " + unique + " distinct item types in chests are not in the vanilla " +
                "registry. This may indicate mod-added items or a taxonomy update is needed."
        ).meta("unknown_types", unknown)
         .meta("unique_types", unique)
         .meta("unknown_pct", unknownPct)
         .meta("threshold_pct", cfg.unknownSurgeThresholdPct));
    }

    // ---- Helpers ----

    /** Make a tag/name safe for use in an alert ID (no spaces or special chars). */
    private static String sanitizeId(String s) {
        if (s == null) return "null";
        return s.replaceAll("[^A-Za-z0-9_\\-]", "_").toLowerCase();
    }
}
