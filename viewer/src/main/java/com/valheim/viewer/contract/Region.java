package com.valheim.viewer.contract;

import java.util.ArrayList;
import java.util.List;

/**
 * A steward-defined region for zone budget tracking.
 * Loaded from regions.json; falls back to origin-based default.
 */
public class Region {
    public String       name;
    public Vec2         center;
    public double       radiusM;
    public int          maxZdos;
    public List<String> rules = new ArrayList<>();
}
