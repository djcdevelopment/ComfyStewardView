package dev.steward.lab;

public record WorldBounds(double minX, double maxX, double minZ, double maxZ) {
    public static final WorldBounds VALHEIM = new WorldBounds(-26_500, 26_500, -20_500, 27_500);

    public int width(int cellSize) {
        return (int) Math.ceil((maxX - minX) / cellSize);
    }

    public int height(int cellSize) {
        return (int) Math.ceil((maxZ - minZ) / cellSize);
    }

    public double areaSquareKm() {
        return ((maxX - minX) * (maxZ - minZ)) / 1_000_000.0;
    }
}
