package com.valheim.viewer.store;

import java.util.*;

/**
 * 2D heatmap grid keyed by (cellX, cellZ) = floor(worldX / cellSize), floor(worldZ / cellSize).
 *
 * Uses a flat int[] array for O(1) increment with zero allocation — no Long boxing, no lambda.
 * World bounds: X in [-26500, 26500], Z in [-20500, 27500], cellSize = 500.
 * Grid: 108 cols × 97 rows = ~10,476 cells.
 */
public class HeatmapGrid {

    public final int cellSize;

    // World-coordinate bounds for the flat array (in cell units)
    private static final int X_MIN_CELL = -54;
    private static final int Z_MIN_CELL = -42;
    private static final int COLS = 110;   // covers [-54..55] × cellSize
    private static final int ROWS = 100;   // covers [-42..57] × cellSize

    private final int[] counts = new int[COLS * ROWS];
    private int maxCount   = 0;
    private int totalCount = 0;

    // Track which cells were touched for getCells() iteration
    private final boolean[] touched = new boolean[COLS * ROWS];
    private int touchedCount = 0;

    public HeatmapGrid(int cellSize) {
        this.cellSize = cellSize;
    }

    public void increment(float worldX, float worldZ) {
        int cx  = Math.floorDiv((int) worldX, cellSize);
        int cz  = Math.floorDiv((int) worldZ, cellSize);
        int col = cx - X_MIN_CELL;
        int row = cz - Z_MIN_CELL;
        if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;
        int idx = col * ROWS + row;
        int v = ++counts[idx];
        if (v > maxCount) maxCount = v;
        totalCount++;
        if (!touched[idx]) { touched[idx] = true; touchedCount++; }
    }

    public int get(float worldX, float worldZ) {
        int cx  = Math.floorDiv((int) worldX, cellSize);
        int cz  = Math.floorDiv((int) worldZ, cellSize);
        int col = cx - X_MIN_CELL;
        int row = cz - Z_MIN_CELL;
        if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return 0;
        return counts[col * ROWS + row];
    }

    public int getMaxCount()  { return maxCount; }
    public int getTotalCount(){ return totalCount; }
    public int getCellCount() { return touchedCount; }

    /**
     * Returns all non-zero cells as a flat list of [cx, cz, count] triples.
     * Suitable for JSON serialization.
     */
    public List<int[]> getCells() {
        List<int[]> result = new ArrayList<>(touchedCount);
        for (int col = 0; col < COLS; col++) {
            for (int row = 0; row < ROWS; row++) {
                int idx = col * ROWS + row;
                if (!touched[idx]) continue;
                int cx = col + X_MIN_CELL;
                int cz = row + Z_MIN_CELL;
                result.add(new int[]{cx, cz, counts[idx]});
            }
        }
        return result;
    }

    /**
     * Returns top N cells by count, sorted descending.
     */
    public List<int[]> getTopCells(int n) {
        List<int[]> all = getCells();
        all.sort((a, b) -> Integer.compare(b[2], a[2]));
        return all.subList(0, Math.min(n, all.size()));
    }

    /**
     * Converts cell coordinates back to world coordinates (center of cell).
     */
    public float cellToWorldX(int cx) { return cx * cellSize + cellSize / 2.0f; }
    public float cellToWorldZ(int cz) { return cz * cellSize + cellSize / 2.0f; }
}
