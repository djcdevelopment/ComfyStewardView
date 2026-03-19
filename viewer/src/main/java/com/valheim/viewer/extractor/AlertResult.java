package com.valheim.viewer.extractor;

import com.valheim.viewer.contract.Alert;

import java.util.List;

/**
 * Output of AlertBuilder.build().
 * Plain serializable POJO — no ZdoFlatStore or WorldContracts references.
 *
 * Served via GET /api/v1/alerts and used to back-fill WorldSummary.stats.alerts.
 */
public class AlertResult {

    public List<Alert> alerts;

    public int critical_count;
    public int high_count;
    public int medium_count;
    public int low_count;

    /** Total alert count across all severities. */
    public int total_count() {
        return critical_count + high_count + medium_count + low_count;
    }
}
