package dev.steward.lab;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.awt.image.Raster;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/** Samples the release biome mask using the same north-up world transform as Leaflet. */
public final class BiomeClassifier {
    private final TerrainContext.Bounds bounds;
    private final int width;
    private final int height;
    private final Raster mask;
    private final Map<Integer, String> ids;

    public BiomeClassifier(TerrainContext context) throws IOException {
        this.bounds = context.bounds();
        TerrainContext.Variant variant = context.biomeMask();
        BufferedImage image = ImageIO.read(variant.path().toFile());
        if (image == null || image.getWidth() != variant.width() || image.getHeight() != variant.height()) {
            throw new IllegalArgumentException("Could not decode the terrain biome mask");
        }
        this.width = image.getWidth();
        this.height = image.getHeight();
        this.mask = image.getRaster();
        this.ids = new HashMap<>();
        for (TerrainContext.Biome biome : context.biomes().catalog()) ids.put(biome.index(), biome.id());

        for (int row = 0; row < height; row++) {
            for (int column = 0; column < width; column++) {
                int index = mask.getSample(column, row, 0);
                if (!ids.containsKey(index)) {
                    throw new IllegalArgumentException("Biome mask contains unknown palette index " + index);
                }
            }
        }
    }

    public String classify(double x, double z) {
        if (!Double.isFinite(x) || !Double.isFinite(z) || x < bounds.minX() || x > bounds.maxX() ||
                z < bounds.minZ() || z > bounds.maxZ()) {
            return "space";
        }
        int column = Math.min(width - 1, Math.max(0,
            (int) Math.floor((x - bounds.minX()) / (bounds.maxX() - bounds.minX()) * width)));
        int row = Math.min(height - 1, Math.max(0,
            (int) Math.floor((bounds.maxZ() - z) / (bounds.maxZ() - bounds.minZ()) * height)));
        return ids.get(mask.getSample(column, row, 0));
    }
}
