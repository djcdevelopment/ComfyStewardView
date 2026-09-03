#!/usr/bin/env python3
"""Build a snapshot-bound Valheim terrain context for Steward's world view.

The base map comes from Valheim's own minimap caches. Player height and paint
changes come from _TerrainCompiler TCData in the exact frozen world database
used by the published Steward snapshot. The resulting files are static public
images; the save, seed, caches, and private provenance never need to leave the
build machine.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import math
import mmap
import os
from pathlib import Path
import struct
import sys
import traceback
from typing import Iterable

import numpy as np
from PIL import Image


SCHEMA_VERSION = 2
STYLE_ID = "muted-topographic-v1"
BIOME_CLASSIFICATION = "comfy-era17-territories-v1"
BIOME_DISPLAY_CLASSIFICATION = "plurality-lasso-r3-v1"
TEXTURE_SIZE = 2048
DETAIL_SIZE = 4096
SOURCE_PIXEL_METERS = 12.0
DETAIL_PIXEL_METERS = 6.0
WORLD_EDGE_METERS = 12_288.0
WORLD_WATER_EDGE_METERS = 10_500.0
WORLD_FADE_START_METERS = 10_350.0
SEA_LEVEL = 30.0
HEIGHT_SCALE = 127.5
TERRAIN_COMPILER_HASH = -367065113
TCDATA_HASH = 1_305_470_367
MUD_ROAD_HASH = 463_677_683
PAVED_ROAD_HASH = 456_394_941
ZONE_HALF_METERS = 32
ZONE_VERTICES = 65
EDIT_CLAMP_METERS = 8.0
DEFAULT_CONTEXT_OPACITY = 0.62
CLOSE_DETAIL_FACTOR = 1.0

MAP_PALETTE = {
    (123, 32, 32): (103, 58, 52),      # Ashlands
    (51, 51, 51): (63, 67, 78),        # Mistlands
    (107, 116, 63): (55, 77, 61),      # Black forest
    (231, 171, 120): (132, 108, 72),   # Plains
    (146, 167, 92): (83, 104, 72),     # Meadows
    (163, 114, 88): (73, 79, 70),      # Swamp
    (255, 255, 255): (139, 147, 149),  # Mountain / Deep North; water overrides it
}

BIOMES = (
    {"index": 1, "id": "space", "label": "Ocean", "color": "#8f8bd8"},
    {"index": 2, "id": "deep-north", "label": "Deep North", "color": "#bfe8ff"},
    {"index": 3, "id": "mistlands", "label": "Mistlands", "color": "#a28bd0"},
    {"index": 4, "id": "ashlands", "label": "Ashlands", "color": "#f06a4f"},
    {"index": 5, "id": "swamps", "label": "Swamps", "color": "#78966b"},
    {"index": 6, "id": "plains", "label": "Plains", "color": "#e2bd72"},
    {"index": 7, "id": "meadows", "label": "Meadows", "color": "#91ca70"},
    {"index": 8, "id": "other", "label": "Mountains + Forest", "color": "#b3bac5"},
)
BIOME_INDEX = {biome["id"]: biome["index"] for biome in BIOMES}
RAW_BIOMES = {
    (51, 51, 51): "mistlands",
    (123, 32, 32): "ashlands",
    (163, 114, 88): "swamps",
    (231, 171, 120): "plains",
    (146, 167, 92): "meadows",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_7bit_string(data: bytes, offset: int) -> tuple[str, int]:
    length = 0
    shift = 0
    while True:
        if offset >= len(data) or shift > 28:
            raise ValueError("invalid 7-bit string length")
        value = data[offset]
        offset += 1
        length |= (value & 0x7F) << shift
        if not value & 0x80:
            break
        shift += 7
    end = offset + length
    if end > len(data):
        raise ValueError("truncated string")
    return data[offset:end].decode("utf-8"), end


def read_world_file(path: Path) -> dict[str, object]:
    data = path.read_bytes()
    if len(data) < 12:
        raise ValueError(f"world file is truncated: {path}")
    package_length, version = struct.unpack_from("<ii", data, 0)
    if package_length != len(data) - 4:
        raise ValueError(f"world file package length does not match: {path}")
    world_name, offset = read_7bit_string(data, 8)
    seed, _ = read_7bit_string(data, offset)
    if not seed:
        raise ValueError(f"world file has an empty seed: {path}")
    return {"worldName": world_name, "worldVersion": version}


def require_image(path: Path, expected_mode: str | None = None) -> Image.Image:
    try:
        image = Image.open(path)
        image.load()
    except Exception as error:
        raise ValueError(f"could not read minimap cache {path}: {error}") from error
    if image.size != (TEXTURE_SIZE, TEXTURE_SIZE):
        raise ValueError(f"unexpected minimap cache dimensions {image.size}: {path}")
    if expected_mode and image.mode != expected_mode:
        image = image.convert(expected_mode)
    return image


def decode_height(image: Image.Image) -> np.ndarray:
    pixels = np.asarray(image.convert("RGB"), dtype=np.uint16)
    encoded = (pixels[..., 0] << 8) | pixels[..., 1]
    return encoded.astype(np.float32) / HEIGHT_SCALE


def decode_tcdata(raw: bytes) -> tuple[int, list[tuple[int, float]], list[tuple[int, float, float, float]]]:
    """Return operations, modified height vertices, and modified paint vertices."""
    if len(raw) < 32:
        raise ValueError("TCData payload is truncated")
    version, operations = struct.unpack_from("<ii", raw, 0)
    if version != 1:
        raise ValueError(f"unsupported TCData version {version}")
    height_count = struct.unpack_from("<i", raw, 24)[0]
    if height_count != ZONE_VERTICES * ZONE_VERTICES:
        raise ValueError(f"unexpected TCData height count {height_count}")
    offset = 28
    heights: list[tuple[int, float]] = []
    for index in range(height_count):
        if offset >= len(raw):
            raise ValueError("TCData height array is truncated")
        modified = raw[offset] != 0
        offset += 1
        if modified:
            if offset + 8 > len(raw):
                raise ValueError("TCData height delta is truncated")
            level, smooth = struct.unpack_from("<ff", raw, offset)
            offset += 8
            heights.append((index, max(-EDIT_CLAMP_METERS, min(EDIT_CLAMP_METERS, level + smooth))))
    if offset + 4 > len(raw):
        raise ValueError("TCData paint count is truncated")
    paint_count = struct.unpack_from("<i", raw, offset)[0]
    offset += 4
    if paint_count not in (64 * 64, ZONE_VERTICES * ZONE_VERTICES):
        raise ValueError(f"unexpected TCData paint count {paint_count}")
    paints: list[tuple[int, float, float, float]] = []
    for index in range(paint_count):
        if offset >= len(raw):
            raise ValueError("TCData paint array is truncated")
        modified = raw[offset] != 0
        offset += 1
        if modified:
            if offset + 16 > len(raw):
                raise ValueError("TCData paint value is truncated")
            red, green, blue, _alpha = struct.unpack_from("<ffff", raw, offset)
            offset += 16
            paints.append((index, red, green, blue))
    if offset != len(raw):
        raise ValueError(f"TCData payload has {len(raw) - offset} trailing bytes")
    return operations, heights, paints


def read_small_count(data: mmap.mmap, offset: int) -> tuple[int, int]:
    count = data[offset]
    offset += 1
    if count & 0x80:
        count = ((count & 0x7F) << 8) | data[offset]
        offset += 1
    return count, offset


def skip_string(data: mmap.mmap, offset: int) -> int:
    length = 0
    shift = 0
    while True:
        value = data[offset]
        offset += 1
        length |= (value & 0x7F) << shift
        if not value & 0x80:
            return offset + length
        shift += 7
        if shift > 28:
            raise ValueError("invalid ZDO string length")


def output_cell(world_x: float, world_z: float) -> tuple[int, int] | None:
    col = math.floor((world_x + WORLD_EDGE_METERS) / DETAIL_PIXEL_METERS)
    row = math.floor((WORLD_EDGE_METERS - world_z) / DETAIL_PIXEL_METERS)
    if 0 <= row < DETAIL_SIZE and 0 <= col < DETAIL_SIZE:
        return row, col
    return None


def aggregate_payload(
        center_x: float,
        center_z: float,
        heights: Iterable[tuple[int, float]],
        paints: Iterable[tuple[int, float, float, float]],
        delta_sum: np.ndarray,
        paint_sum: np.ndarray) -> tuple[int, int]:
    base_x = round(center_x) - ZONE_HALF_METERS
    base_z = round(center_z) - ZONE_HALF_METERS
    height_records = 0
    paint_records = 0
    height_rows: list[int] = []
    height_cols: list[int] = []
    height_values: list[float] = []
    for index, delta in heights:
        height_records += 1
        cell = output_cell(base_x + index % ZONE_VERTICES, base_z + index // ZONE_VERTICES)
        if cell is not None and delta:
            height_rows.append(cell[0])
            height_cols.append(cell[1])
            height_values.append(delta)
    if height_values:
        np.add.at(delta_sum, (height_rows, height_cols), height_values)

    paint_rows: list[int] = []
    paint_cols: list[int] = []
    red_values: list[float] = []
    green_values: list[float] = []
    blue_values: list[float] = []
    for index, red, green, blue in paints:
        paint_records += 1
        cell = output_cell(base_x + index % ZONE_VERTICES, base_z + index // ZONE_VERTICES)
        if cell is not None and max(red, green, blue) > 0.001:
            paint_rows.append(cell[0])
            paint_cols.append(cell[1])
            red_values.append(max(0.0, min(1.0, red)))
            green_values.append(max(0.0, min(1.0, green)))
            blue_values.append(max(0.0, min(1.0, blue)))
    if paint_rows:
        np.add.at(paint_sum[0], (paint_rows, paint_cols), red_values)
        np.add.at(paint_sum[1], (paint_rows, paint_cols), green_values)
        np.add.at(paint_sum[2], (paint_rows, paint_cols), blue_values)
    return height_records, paint_records


def parse_world_edits(db_path: Path) -> tuple[np.ndarray, np.ndarray, dict[str, int]]:
    """Stream the active ZDO section and aggregate terrain edits onto the 6 m grid."""
    delta_sum = np.zeros((DETAIL_SIZE, DETAIL_SIZE), dtype=np.float32)
    paint_sum = np.zeros((3, DETAIL_SIZE, DETAIL_SIZE), dtype=np.float32)
    stats = {
        "zdoCount": 0,
        "compilerZdoCount": 0,
        "compilerPayloadCount": 0,
        "operations": 0,
        "heightRecordCount": 0,
        "paintRecordCount": 0,
        "mudRoadCount": 0,
        "pavedRoadCount": 0,
    }
    unpack_u16 = struct.Struct("<H").unpack_from
    unpack_i32 = struct.Struct("<i").unpack_from
    legacy: list[tuple[int, float, float]] = []

    with db_path.open("rb") as handle:
        data = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            data_version = unpack_i32(data, 0)[0]
            if data_version < 33:
                raise ValueError(f"unsupported world DB version {data_version}; expected 33+")
            offset = 4 + (8 if data_version >= 4 else 0) + 8 + 4
            zdo_count = unpack_i32(data, offset)[0]
            offset += 4
            stats["zdoCount"] = zdo_count
            stats["dataVersion"] = data_version
            for _index in range(zdo_count):
                flags = unpack_u16(data, offset)[0]
                offset += 2
                position_offset = offset + 4
                offset += 4 + 12
                prefab = unpack_i32(data, offset)[0]
                offset += 4
                center_x = struct.unpack_from("<f", data, position_offset)[0]
                center_z = struct.unpack_from("<f", data, position_offset + 8)[0]
                if prefab == TERRAIN_COMPILER_HASH:
                    stats["compilerZdoCount"] += 1
                elif prefab == MUD_ROAD_HASH:
                    stats["mudRoadCount"] += 1
                    legacy.append((prefab, center_x, center_z))
                elif prefab == PAVED_ROAD_HASH:
                    stats["pavedRoadCount"] += 1
                    legacy.append((prefab, center_x, center_z))
                if flags & 0x1000:
                    offset += 12
                low_flags = flags & 0xFF
                if not low_flags:
                    continue
                if low_flags & 0x01:
                    offset += 5
                for bit, record_size in ((0x02, 8), (0x04, 16), (0x08, 20), (0x10, 8), (0x20, 12)):
                    if low_flags & bit:
                        count, offset = read_small_count(data, offset)
                        offset += count * record_size
                if low_flags & 0x40:
                    count, offset = read_small_count(data, offset)
                    for _ in range(count):
                        offset += 4
                        offset = skip_string(data, offset)
                if low_flags & 0x80:
                    count, offset = read_small_count(data, offset)
                    for _ in range(count):
                        key_hash = unpack_i32(data, offset)[0]
                        byte_length = unpack_i32(data, offset + 4)[0]
                        offset += 8
                        if byte_length < 0 or offset + byte_length > len(data):
                            raise ValueError("invalid ZDO byte-array length")
                        if prefab == TERRAIN_COMPILER_HASH and key_hash == TCDATA_HASH:
                            try:
                                raw = gzip.decompress(data[offset:offset + byte_length])
                                operations, heights, paints = decode_tcdata(raw)
                            except Exception as error:
                                raise ValueError(
                                    f"could not decode TerrainCompiler at ({center_x:g}, {center_z:g}): {error}") from error
                            height_count, paint_count = aggregate_payload(
                                center_x, center_z, heights, paints, delta_sum, paint_sum)
                            stats["compilerPayloadCount"] += 1
                            stats["operations"] += operations
                            stats["heightRecordCount"] += height_count
                            stats["paintRecordCount"] += paint_count
                        offset += byte_length
        finally:
            data.close()

    # A small number of pre-compiler road modifiers remain in Era 17. Their
    # persistent prefab footprints are paint-only; keep them visible as one
    # anti-aliased 6 m context cell without claiming extra height precision.
    for prefab, world_x, world_z in legacy:
        cell = output_cell(world_x, world_z)
        if cell is not None:
            channel = 0 if prefab == MUD_ROAD_HASH else 2
            paint_sum[channel, cell[0], cell[1]] += 9.0
    return delta_sum, paint_sum, stats


def resize_float(source: np.ndarray, size: int, resample: Image.Resampling) -> np.ndarray:
    image = Image.fromarray(source.astype(np.float32), mode="F")
    return np.array(image.resize((size, size), resample), dtype=np.float32, copy=True)


def biome_colors(map_image: Image.Image) -> np.ndarray:
    source = np.asarray(map_image.convert("RGB"), dtype=np.uint8)
    colors = np.empty_like(source)
    assigned = np.zeros(source.shape[:2], dtype=bool)
    for raw, muted in MAP_PALETTE.items():
        mask = np.all(source == raw, axis=2)
        colors[mask] = muted
        assigned |= mask
    if np.any(~assigned):
        fallback = source.astype(np.float32)
        luminance = fallback.mean(axis=2, keepdims=True)
        fallback = fallback * 0.30 + luminance * 0.35 + 24.0
        colors[~assigned] = np.clip(fallback[~assigned], 0, 255).astype(np.uint8)
    return np.asarray(
        Image.fromarray(colors, mode="RGB").resize((DETAIL_SIZE, DETAIL_SIZE), Image.Resampling.NEAREST),
        dtype=np.float32)


def classify_biomes(map_image: Image.Image, height_image: Image.Image) -> tuple[Image.Image, dict[str, int]]:
    """Build the public territory mask from the exact Valheim minimap caches.

    Valheim writes Ocean, Mountain, and Deep North as the same white map-cache
    color. Water is separated by the generated height texture. All remaining
    white land inside the official polar boundary belongs to the Deep North
    territory, including its mountain peaks; non-polar white and Black Forest
    land are grouped as Mountains + Forest.
    """
    raw = np.asarray(map_image.convert("RGB"), dtype=np.uint8)
    height = decode_height(height_image)
    result = np.full(raw.shape[:2], BIOME_INDEX["other"], dtype=np.uint8)

    # Written explicitly to make the north-up row mapping unambiguous.
    world_x = -WORLD_EDGE_METERS + SOURCE_PIXEL_METERS / 2.0 + np.arange(TEXTURE_SIZE) * SOURCE_PIXEL_METERS
    world_z = WORLD_EDGE_METERS - SOURCE_PIXEL_METERS / 2.0 - np.arange(TEXTURE_SIZE) * SOURCE_PIXEL_METERS
    x_grid = world_x[None, :]
    z_grid = world_z[:, None]
    radius = np.hypot(x_grid, z_grid)
    space = (height < SEA_LEVEL) | (radius > WORLD_WATER_EDGE_METERS)
    land = ~space

    for color, identifier in RAW_BIOMES.items():
        result[land & np.all(raw == color, axis=2)] = BIOME_INDEX[identifier]

    white = np.all(raw == (255, 255, 255), axis=2)
    world_angle = np.sin(np.arctan2(x_grid, z_grid) * 20.0) * 100.0
    deep_north = np.hypot(x_grid, z_grid + 4000.0) > 12000.0 + world_angle
    result[land & white & deep_north] = BIOME_INDEX["deep-north"]
    result[space] = BIOME_INDEX["space"]

    palette = [0] * (256 * 3)
    for biome in BIOMES:
        color = biome["color"].lstrip("#")
        rgb = tuple(int(color[offset:offset + 2], 16) for offset in (0, 2, 4))
        start = biome["index"] * 3
        palette[start:start + 3] = rgb
    image = Image.fromarray(result, mode="P")
    image.putpalette(palette)
    counts = {
        biome["id"]: int(np.count_nonzero(result == biome["index"]))
        for biome in BIOMES
    }
    return image, counts


def smooth_biome_display_mask(mask_image: Image.Image, radius: int = 3) -> tuple[Image.Image, dict[str, int]]:
    """Create a presentation-only territory mask with calm, continuous borders.

    The source mask remains authoritative for object classification. This pass is
    deliberately a local plurality filter: it closes hairline fractures, removes
    isolated single-cell noise, and rounds pixel tendrils without inventing broad
    territory changes. Ties stay with the authored center cell.
    """
    if mask_image.mode != "P":
        raise ValueError("biome display source must be an indexed image")
    if radius < 1:
        raise ValueError("biome display smoothing radius must be positive")

    source = np.array(mask_image, dtype=np.uint8, copy=True)
    best_score = np.zeros(source.shape, dtype=np.uint16)
    result = source.copy()
    window = radius * 2 + 1
    for biome in BIOMES:
        index = biome["index"]
        binary = np.pad(source == index, radius, mode="edge").astype(np.uint8)
        integral = np.pad(binary, ((1, 0), (1, 0)), mode="constant").cumsum(0, dtype=np.uint32).cumsum(1, dtype=np.uint32)
        count = (integral[window:, window:] - integral[:-window, window:]
                 - integral[window:, :-window] + integral[:-window, :-window])
        score = count * 2 + (source == index)
        better = score > best_score
        result[better] = index
        best_score[better] = score[better]

    image = Image.fromarray(result, mode="P")
    image.putpalette(mask_image.getpalette())
    stats = {
        "radiusPixels": radius,
        "radiusMeters": radius * SOURCE_PIXEL_METERS,
        "changedPixels": int(np.count_nonzero(result != source)),
    }
    return image, stats


def neighbor_edge(mask: np.ndarray) -> np.ndarray:
    edge = np.zeros(mask.shape, dtype=bool)
    edge[1:, :] |= mask[1:, :] != mask[:-1, :]
    edge[:-1, :] |= mask[:-1, :] != mask[1:, :]
    edge[:, 1:] |= mask[:, 1:] != mask[:, :-1]
    edge[:, :-1] |= mask[:, :-1] != mask[:, 1:]
    return edge


def dilate_mask(mask: np.ndarray, radius: int = 1) -> np.ndarray:
    """Expand a boolean line mask without introducing a scipy dependency."""
    if radius < 1:
        return mask.copy()
    padded = np.pad(mask, radius, mode="constant")
    result = np.zeros_like(mask, dtype=bool)
    height, width = mask.shape
    for offset_y in range(radius * 2 + 1):
        for offset_x in range(radius * 2 + 1):
            result |= padded[offset_y:offset_y + height, offset_x:offset_x + width]
    return result


def render_context(
        map_image: Image.Image,
        height_image: Image.Image,
        forest_image: Image.Image,
        delta_sum: np.ndarray,
        paint_sum: np.ndarray) -> tuple[Image.Image, Image.Image, dict[str, int]]:
    base_height = decode_height(height_image)
    final_height = resize_float(base_height, DETAIL_SIZE, Image.Resampling.BILINEAR)
    # A 6 m display cell covers 36 one-metre terrain vertices. Untouched
    # vertices contribute zero delta, producing an honest area-averaged edit.
    final_height += delta_sum / 36.0

    colors = biome_colors(map_image)
    forest = np.asarray(
        forest_image.convert("RGB").resize((DETAIL_SIZE, DETAIL_SIZE), Image.Resampling.BILINEAR),
        dtype=np.float32) / 255.0

    land = final_height >= SEA_LEVEL
    forest_strength = forest[..., 0]
    colors[land] *= (1.0 - 0.13 * forest_strength[land, None])
    mist_strength = forest[..., 1]
    colors[..., 2] += mist_strength * 5.0

    # Terrain paint values are RGB weights: dirt, cultivated, paved.
    paint_coverage = np.clip(paint_sum / 36.0, 0.0, 1.0)
    total_paint = np.clip(paint_coverage.sum(axis=0), 0.0, 1.0)
    paint_targets = np.asarray(((105, 76, 53), (62, 91, 61), (91, 92, 91)), dtype=np.float32)
    weighted = np.einsum("chw,ck->hwk", paint_coverage, paint_targets)
    denom = np.maximum(paint_coverage.sum(axis=0), 1e-6)[..., None]
    paint_color = weighted / denom
    paint_alpha = np.clip(total_paint * 0.72, 0.0, 0.68)[..., None]
    colors = colors * (1.0 - paint_alpha) + paint_color * paint_alpha

    # Muted north-west hillshade. The final elevation includes snapshot edits.
    grad_z, grad_x = np.gradient(final_height, DETAIL_PIXEL_METERS, DETAIL_PIXEL_METERS)
    slope = np.arctan(np.hypot(grad_x, grad_z))
    aspect = np.arctan2(-grad_x, grad_z)
    altitude = math.radians(42.0)
    azimuth = math.radians(315.0)
    hill = (np.sin(altitude) * np.cos(slope) +
            np.cos(altitude) * np.sin(slope) * np.cos(azimuth - aspect))
    shade = np.clip(0.78 + 0.34 * hill, 0.72, 1.10)
    colors[land] *= shade[land, None]

    water_depth = np.clip((SEA_LEVEL - final_height) / SEA_LEVEL, 0.0, 1.0)
    shallow = np.asarray((35, 73, 91), dtype=np.float32)
    deep = np.asarray((18, 39, 59), dtype=np.float32)
    water_color = shallow[None, None, :] * (1.0 - water_depth[..., None]) + deep[None, None, :] * water_depth[..., None]
    ash_gradient = forest[..., 2, None]
    water_color = water_color * (1.0 - ash_gradient * 0.10) + np.asarray((64, 45, 48)) * ash_gradient * 0.10
    colors[~land] = water_color[~land]

    # Contours remain subordinate to the heatmap and disappear over water.
    minor_band = np.floor(final_height / 20.0).astype(np.int16)
    major_band = np.floor(final_height / 100.0).astype(np.int16)
    minor = neighbor_edge(minor_band) & land
    major = neighbor_edge(major_band) & land
    colors[minor] *= 0.87
    colors[major] *= 0.76
    coastline = neighbor_edge(land)
    colors[coastline] *= 0.78

    coordinate = -WORLD_EDGE_METERS + DETAIL_PIXEL_METERS / 2.0 + np.arange(DETAIL_SIZE) * DETAIL_PIXEL_METERS
    radius = np.hypot(coordinate[None, :], coordinate[::-1, None])
    alpha = np.clip(
        (WORLD_WATER_EDGE_METERS - radius) /
        (WORLD_WATER_EDGE_METERS - WORLD_FADE_START_METERS), 0.0, 1.0)
    rgba = np.empty((DETAIL_SIZE, DETAIL_SIZE, 4), dtype=np.uint8)
    rgba[..., :3] = np.clip(colors, 0, 255).astype(np.uint8)
    rgba[..., 3] = np.rint(alpha * 255.0).astype(np.uint8)
    detail = Image.fromarray(rgba, mode="RGBA")

    # The neutral terrain canvas keeps the same terrain and edit data, but gives
    # the 20 m contours more contrast and widens the 100 m index contours and
    # coastline. The normal context remains restrained beneath the construction
    # heatmap.
    colors[minor] *= 0.80
    major_halo = dilate_mask(major, 1) & land
    colors[major_halo] *= 0.78
    colors[major] *= 0.78
    coastline_halo = dilate_mask(coastline, 1)
    colors[coastline_halo] *= 0.78
    colors[coastline] *= 0.72
    topographic_rgba = np.empty((DETAIL_SIZE, DETAIL_SIZE, 4), dtype=np.uint8)
    topographic_rgba[..., :3] = np.clip(colors, 0, 255).astype(np.uint8)
    topographic_rgba[..., 3] = rgba[..., 3]
    stats = {
        "landPixels": int(np.count_nonzero(land & (alpha > 0))),
        "waterPixels": int(np.count_nonzero((~land) & (alpha > 0))),
        "paintedPixels": int(np.count_nonzero(total_paint > 0.001)),
        "heightEditedPixels": int(np.count_nonzero(np.abs(delta_sum) > 0.0001)),
    }
    return detail, Image.fromarray(topographic_rgba, mode="RGBA"), stats


def save_png_atomic(image: Image.Image, path: Path) -> None:
    # The terrain palette is intentionally restrained. Indexed PNG preserves the
    # full 4096 px geometry and alpha fade while keeping the public detail asset
    # small enough to switch reliably through the Funnel path.
    encoded = image.quantize(
        colors=256,
        method=Image.Quantize.FASTOCTREE,
        dither=Image.Dither.NONE,
    )
    temporary = path.with_suffix(path.suffix + ".tmp")
    encoded.save(temporary, format="PNG", optimize=True, compress_level=9)
    os.replace(temporary, path)


def save_indexed_png_atomic(image: Image.Image, path: Path) -> None:
    if image.mode != "P":
        raise ValueError("biome mask must be an indexed image")
    temporary = path.with_suffix(path.suffix + ".tmp")
    image.save(temporary, format="PNG", optimize=True, compress_level=9)
    os.replace(temporary, path)


def variant_record(identifier: str, path: Path, size: int, pixel_meters: float) -> dict[str, object]:
    return {
        "id": identifier,
        "file": path.name,
        "width": size,
        "height": size,
        "displayPixelMeters": pixel_meters,
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
    }


def ensure_regular(path: Path, label: str) -> Path:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"{label} not found: {path}")
    return path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--world-db", type=Path, required=True)
    parser.add_argument("--world-file", type=Path, required=True)
    parser.add_argument("--map-cache", type=Path, required=True)
    parser.add_argument("--height-cache", type=Path, required=True)
    parser.add_argument("--forest-cache", type=Path, required=True)
    parser.add_argument("--artifact-manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        db_path = ensure_regular(args.world_db, "world database")
        world_file = ensure_regular(args.world_file, "world companion file")
        map_cache = ensure_regular(args.map_cache, "map cache")
        height_cache = ensure_regular(args.height_cache, "height cache")
        forest_cache = ensure_regular(args.forest_cache, "forest-mask cache")
        artifact_manifest_path = ensure_regular(args.artifact_manifest, "artifact manifest")
        normalized = str(db_path).replace("/", "\\").lower()
        if "\\appdata\\locallow\\irongate\\valheim\\worlds_local\\" in normalized and "backup_" not in db_path.name.lower():
            raise ValueError("refusing the active Valheim save; use the frozen release database")

        artifact = json.loads(artifact_manifest_path.read_text(encoding="utf-8"))
        snapshot = artifact.get("snapshot") or {}
        snapshot_id = int(artifact.get("snapshotId") or 0)
        expected_db_hash = str(snapshot.get("fileHash") or "").lower()
        world_id = str(snapshot.get("worldId") or "").strip()
        world_name = str(snapshot.get("worldName") or "").strip()
        if snapshot_id <= 0 or len(expected_db_hash) != 64 or not world_id:
            raise ValueError("artifact manifest lacks snapshot identity")
        db_hash = sha256_file(db_path)
        if db_hash != expected_db_hash:
            raise ValueError(f"world DB hash does not match snapshot #{snapshot_id}")
        world_info = read_world_file(world_file)
        if world_info["worldName"] != world_id:
            raise ValueError(
                f"world companion names {world_info['worldName']!r}, expected {world_id!r}")
        for cache in (map_cache, height_cache, forest_cache):
            if not cache.name.startswith(world_id + "_"):
                raise ValueError(f"cache is not named for {world_id}: {cache}")

        print(f"Snapshot #{snapshot_id} is hash-matched to {db_path}", flush=True)
        map_image = require_image(map_cache, "RGB")
        height_image = require_image(height_cache, "RGBA")
        forest_image = require_image(forest_cache, "RGBA")
        delta_sum, paint_sum, edit_stats = parse_world_edits(db_path)
        print(
            f"Decoded {edit_stats['compilerPayloadCount']:,} terrain compilers, "
            f"{edit_stats['heightRecordCount']:,} height and "
            f"{edit_stats['paintRecordCount']:,} paint records", flush=True)
        detail, topographic_detail, render_stats = render_context(
            map_image, height_image, forest_image, delta_sum, paint_sum)
        overview = detail.resize((TEXTURE_SIZE, TEXTURE_SIZE), Image.Resampling.LANCZOS)
        topographic_overview = topographic_detail.resize(
            (TEXTURE_SIZE, TEXTURE_SIZE), Image.Resampling.LANCZOS)
        biome_mask, biome_pixels = classify_biomes(map_image, height_image)
        biome_display_mask, biome_display_stats = smooth_biome_display_mask(biome_mask)

        output_dir = args.output_dir.expanduser().resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        detail_path = output_dir / "terrain-detail.png"
        overview_path = output_dir / "terrain-overview.png"
        topographic_detail_path = output_dir / "topographic-detail.png"
        topographic_overview_path = output_dir / "topographic-overview.png"
        biome_mask_path = output_dir / "biome-mask.png"
        biome_display_mask_path = output_dir / "biome-display-mask.png"
        save_png_atomic(detail, detail_path)
        save_png_atomic(overview, overview_path)
        save_png_atomic(topographic_detail, topographic_detail_path)
        save_png_atomic(topographic_overview, topographic_overview_path)
        save_indexed_png_atomic(biome_mask, biome_mask_path)
        save_indexed_png_atomic(biome_display_mask, biome_display_mask_path)

        source_hashes = {
            "worldFile": {"file": world_file.name, "sha256": sha256_file(world_file)},
            "mapCache": {"file": map_cache.name, "sha256": sha256_file(map_cache)},
            "heightCache": {"file": height_cache.name, "sha256": sha256_file(height_cache)},
            "forestMaskCache": {"file": forest_cache.name, "sha256": sha256_file(forest_cache)},
        }
        manifest = {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "steward-terrain-context",
            "style": STYLE_ID,
            "world": {"id": world_id, "name": world_name},
            "snapshot": {"id": snapshot_id, "sha256": db_hash},
            "bounds": {
                "minX": -WORLD_EDGE_METERS,
                "maxX": WORLD_EDGE_METERS,
                "minZ": -WORLD_EDGE_METERS,
                "maxZ": WORLD_EDGE_METERS,
            },
            "sourcePixelMeters": SOURCE_PIXEL_METERS,
            "editPixelMeters": 1.0,
            "seaLevel": SEA_LEVEL,
            "worldWaterEdgeMeters": WORLD_WATER_EDGE_METERS,
            "defaultOpacity": DEFAULT_CONTEXT_OPACITY,
            "detailZoom": -2.25,
            "closeDetailFactor": CLOSE_DETAIL_FACTOR,
            "variants": [
                variant_record("overview", overview_path, TEXTURE_SIZE, SOURCE_PIXEL_METERS),
                variant_record("detail", detail_path, DETAIL_SIZE, DETAIL_PIXEL_METERS),
                variant_record("topographic-overview", topographic_overview_path, TEXTURE_SIZE, SOURCE_PIXEL_METERS),
                variant_record("topographic-detail", topographic_detail_path, DETAIL_SIZE, DETAIL_PIXEL_METERS),
                variant_record("biome-mask", biome_mask_path, TEXTURE_SIZE, SOURCE_PIXEL_METERS),
                variant_record("biome-display-mask", biome_display_mask_path, TEXTURE_SIZE, SOURCE_PIXEL_METERS),
            ],
            "biomes": {
                "classification": BIOME_CLASSIFICATION,
                "maskVariant": "biome-mask",
                "displayClassification": BIOME_DISPLAY_CLASSIFICATION,
                "displayMaskVariant": "biome-display-mask",
                "displaySmoothing": biome_display_stats,
                "spaceIncludesWater": True,
                "catalog": [dict(biome, pixelCount=biome_pixels[biome["id"]]) for biome in BIOMES],
            },
            "sources": source_hashes,
            "terrainEdits": edit_stats,
            "render": render_stats,
            "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        manifest_path = output_dir / "manifest.json"
        temporary = manifest_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, manifest_path)
        print(manifest_path)
        return 0
    except Exception as error:
        print(f"terrain context build failed: {error}", file=sys.stderr)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
