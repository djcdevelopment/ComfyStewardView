import gzip
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

import numpy as np
from PIL import Image


SCRIPT = Path(__file__).parents[1] / "build-terrain-context.py"
SPEC = importlib.util.spec_from_file_location("terrain_context_builder", SCRIPT)
builder = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(builder)


def tcdata(height_changes=None, paint_changes=None):
    height_changes = height_changes or {}
    paint_changes = paint_changes or {}
    raw = bytearray()
    raw += struct.pack("<ii", 1, 7)
    raw += struct.pack("<fff", 0.0, 0.0, 0.0)
    raw += struct.pack("<f", 2.0)
    raw += struct.pack("<i", 65 * 65)
    for index in range(65 * 65):
        if index in height_changes:
            raw += b"\x01" + struct.pack("<ff", *height_changes[index])
        else:
            raw += b"\x00"
    raw += struct.pack("<i", 65 * 65)
    for index in range(65 * 65):
        if index in paint_changes:
            raw += b"\x01" + struct.pack("<ffff", *paint_changes[index])
        else:
            raw += b"\x00"
    return bytes(raw)


class TerrainContextBuilderTest(unittest.TestCase):
    def test_decodes_and_clamps_height_and_paint(self):
        raw = tcdata(
            {0: (7.5, 2.0), 66: (-7.0, -3.0)},
            {0: (1.0, 0.0, 0.0, 1.0), 2: (0.0, 0.0, 1.0, 1.0)},
        )
        operations, heights, paints = builder.decode_tcdata(raw)
        self.assertEqual(7, operations)
        self.assertEqual([(0, 8.0), (66, -8.0)], heights)
        self.assertEqual((0, 1.0, 0.0, 0.0), paints[0])
        self.assertEqual((2, 0.0, 0.0, 1.0), paints[1])

    def test_rejects_trailing_or_wrong_sized_payload(self):
        with self.assertRaisesRegex(ValueError, "trailing"):
            builder.decode_tcdata(tcdata() + b"x")
        raw = bytearray(tcdata())
        struct.pack_into("<i", raw, 24, 12)
        with self.assertRaisesRegex(ValueError, "height count"):
            builder.decode_tcdata(bytes(raw))

    def test_world_to_detail_pixel_is_north_up(self):
        self.assertEqual((2048, 2048), builder.output_cell(0, 0))
        north = builder.output_cell(0, 600)
        south = builder.output_cell(0, -600)
        self.assertLess(north[0], south[0])
        self.assertIsNone(builder.output_cell(13_000, 0))

    def test_public_png_is_indexed_and_keeps_alpha(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "context.png"
            image = Image.new("RGBA", (32, 32), (24, 48, 72, 255))
            image.putpixel((0, 0), (0, 0, 0, 0))
            builder.save_png_atomic(image, path)
            with Image.open(path) as encoded:
                self.assertEqual("P", encoded.mode)
                self.assertEqual(0, encoded.convert("RGBA").getpixel((0, 0))[3])
                self.assertEqual(255, encoded.convert("RGBA").getpixel((16, 16))[3])

    def test_biome_mask_uses_public_territory_semantics(self):
        raw = np.full((builder.TEXTURE_SIZE, builder.TEXTURE_SIZE, 3), (107, 116, 63), dtype=np.uint8)
        height = np.zeros((builder.TEXTURE_SIZE, builder.TEXTURE_SIZE, 3), dtype=np.uint8)
        encoded_land = round(60 * builder.HEIGHT_SCALE)
        height[..., 0] = encoded_land >> 8
        height[..., 1] = encoded_land & 0xFF

        center = builder.TEXTURE_SIZE // 2
        raw[center, center] = (146, 167, 92)
        polar_row = 275  # z ~= 8,982 m: polar territory, inside the 10.5 km world edge.
        raw[polar_row, center] = (255, 255, 255)
        raw[center, center + 10] = (255, 255, 255)
        height[center, center - 10, 0] = 0
        height[center, center - 10, 1] = 0

        mask, counts = builder.classify_biomes(
            Image.fromarray(raw, mode="RGB"), Image.fromarray(height, mode="RGB"))
        pixels = np.asarray(mask)
        self.assertEqual(builder.BIOME_INDEX["meadows"], pixels[center, center])
        self.assertEqual(builder.BIOME_INDEX["deep-north"], pixels[polar_row, center])
        self.assertEqual(builder.BIOME_INDEX["other"], pixels[center, center + 10])
        self.assertEqual(builder.BIOME_INDEX["space"], pixels[center, center - 10])
        self.assertEqual(builder.TEXTURE_SIZE ** 2, sum(counts.values()))

    def test_biome_mask_round_trip_keeps_palette_indices(self):
        values = np.array([[1, 2], [7, 8]], dtype=np.uint8)
        image = Image.fromarray(values, mode="P")
        image.putpalette([0] * (256 * 3))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "biomes.png"
            builder.save_indexed_png_atomic(image, path)
            with Image.open(path) as encoded:
                self.assertEqual("P", encoded.mode)
                self.assertEqual(values.tolist(), np.asarray(encoded).tolist())

    def test_biome_display_mask_closes_fractures_without_changing_source(self):
        other = builder.BIOME_INDEX["other"]
        meadows = builder.BIOME_INDEX["meadows"]
        values = np.full((21, 21), other, dtype=np.uint8)
        values[4:17, 4:17] = meadows
        values[4:17, 10] = other
        values[1, 1] = meadows
        image = Image.fromarray(values, mode="P")
        image.putpalette([0] * (256 * 3))

        display, stats = builder.smooth_biome_display_mask(image, radius=3)
        pixels = np.asarray(display)

        self.assertTrue(np.all(np.asarray(image)[4:17, 10] == other))
        self.assertEqual(meadows, pixels[10, 10])
        self.assertEqual(other, pixels[1, 1])
        self.assertGreater(stats["changedPixels"], 0)

    def test_dilate_mask_expands_cartographic_lines_one_pixel(self):
        source = np.zeros((5, 5), dtype=bool)
        source[2, 2] = True
        expanded = builder.dilate_mask(source, 1)
        self.assertEqual(9, int(np.count_nonzero(expanded)))
        self.assertTrue(np.all(expanded[1:4, 1:4]))


if __name__ == "__main__":
    unittest.main()
