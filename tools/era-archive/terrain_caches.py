#!/usr/bin/env python3
"""Valheim minimap terrain caches, both generations, frozen to one contract.

The 0.221.x client writes three 2048x2048 PNGs beside the world (`<world>_mapTexCache`,
`_heightTexCache`, `_forestMaskTexCache`). Valheim 1.0 writes gzip-compressed buffers under
`worlds_local/<world>/` (`cacheMinimapBiome|Height|Mask|Meta`). Every consumer downstream
(build-terrain-context.py, the biome-context wrappers) takes the PNG contract, so a 1.0 set
is decoded into it here -- deterministically, stdlib only -- and the raw inputs, seed and
format are recorded as provenance. Shared by the OMEN and AM4 terrain workers; the AM4 host
runs its worker standalone, so this file travels with it.
"""
from __future__ import annotations

import gzip
import hashlib
from pathlib import Path
import shutil
import struct
import zlib

CACHE_SUFFIXES = ("mapTexCache", "heightTexCache", "forestMaskTexCache")
CURRENT_CACHE_NAMES = {
    "mapTexCache": "cacheMinimapBiome",
    "heightTexCache": "cacheMinimapHeight",
    "forestMaskTexCache": "cacheMinimapMask",
}
TEXTURE_SIZE = 2048
HEIGHT_SCALE = 127.5
MAX_ENCODED_HEIGHT = 65025



def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def stamp(path: Path) -> dict[str, object]:
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": sha256(path)}



def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as source:
        header = source.read(24)
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError(f"Invalid PNG cache: {path}")
    return struct.unpack(">II", header[16:24])


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return (struct.pack(">I", len(payload)) + kind + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF))


def png_bytes(pixels: bytes, width: int, height: int, channels: int,
              flip_vertical: bool = False) -> bytes:
    """Encode unfiltered RGB/RGBA bytes as a deterministic PNG.

    Unity's SetPixels arrays start at the lower-left. PNG row zero is the top,
    so current-client minimap buffers are flipped while legacy PNGs are copied.
    """
    if channels not in (3, 4):
        raise ValueError(f"Unsupported PNG channel count {channels}")
    stride = width * channels
    if len(pixels) != stride * height:
        raise ValueError(f"Pixel buffer has {len(pixels)} bytes; expected {stride * height}")
    scanlines = bytearray((stride + 1) * height)
    for row in range(height):
        source_row = height - row - 1 if flip_vertical else row
        target = row * (stride + 1)
        source = source_row * stride
        scanlines[target + 1:target + 1 + stride] = pixels[source:source + stride]
    color_type = 2 if channels == 3 else 6
    header = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header)
            + png_chunk(b"IDAT", zlib.compress(scanlines, 9)) + png_chunk(b"IEND", b""))


def decompress_cache(path: Path, expected_bytes: int) -> bytes:
    try:
        data = gzip.decompress(path.read_bytes())
    except (OSError, EOFError) as error:
        raise ValueError(f"Invalid compressed minimap cache {path}: {error}") from error
    if len(data) != expected_bytes:
        raise ValueError(
            f"Unexpected decompressed size for {path}: {len(data)}; expected {expected_bytes}")
    return data


def color_cache_png(path: Path, width: int = TEXTURE_SIZE, height: int = TEXTURE_SIZE,
                    rgb: bool = False) -> bytes:
    raw = decompress_cache(path, width * height * 4)
    if rgb:
        pixels = bytearray(width * height * 3)
        pixels[0::3] = raw[0::4]
        pixels[1::3] = raw[1::4]
        pixels[2::3] = raw[2::4]
        return png_bytes(pixels, width, height, 3, flip_vertical=True)
    return png_bytes(raw, width, height, 4, flip_vertical=True)


def height_cache_png(path: Path, width: int = TEXTURE_SIZE,
                     height: int = TEXTURE_SIZE) -> bytes:
    """Translate v1.0 half-float heights to the legacy fixed-point PNG contract."""
    raw = decompress_cache(path, width * height * 2)
    pixels = bytearray(width * height * 4)
    for index, (value,) in enumerate(struct.iter_unpack("<e", raw)):
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError(f"Non-finite height in compressed minimap cache {path}")
        encoded = max(0, min(MAX_ENCODED_HEIGHT, int(value * HEIGHT_SCALE)))
        offset = index * 4
        pixels[offset] = encoded >> 8
        pixels[offset + 1] = encoded & 0xFF
        pixels[offset + 3] = 255
    return png_bytes(pixels, width, height, 4, flip_vertical=True)


def cache_candidates(worlds: Path, world: str) -> list[dict[str, object]]:
    legacy = {suffix: worlds / f"{world}_{suffix}" for suffix in CACHE_SUFFIXES}
    current_root = worlds / world
    current = {suffix: current_root / name for suffix, name in CURRENT_CACHE_NAMES.items()}
    return [
        {"format": "legacy-png", "outputs": legacy},
        {"format": "minimap-gzip-v1", "outputs": current,
         "meta": current_root / "cacheMinimapMeta"},
    ]


def complete_cache_set(worlds: Path, world: str) -> dict[str, object] | None:
    for candidate in cache_candidates(worlds, world):
        paths = list(candidate["outputs"].values())
        if candidate.get("meta") is not None:
            paths.append(candidate["meta"])
        if all(path.is_file() for path in paths):
            return candidate
    return None



def world_numeric_seed(path: Path) -> int:
    data = path.read_bytes()
    if len(data) < 12:
        raise ValueError(f"World file is truncated: {path}")
    offset = 8
    for _ in range(2):
        length = 0
        shift = 0
        while True:
            if offset >= len(data) or shift > 28:
                raise ValueError(f"Invalid world string in {path}")
            value = data[offset]
            offset += 1
            length |= (value & 0x7F) << shift
            if not value & 0x80:
                break
            shift += 7
        offset += length
    if offset + 4 > len(data):
        raise ValueError(f"World seed is truncated: {path}")
    return struct.unpack_from("<i", data, offset)[0]



def verify_current_meta(path: Path, fwl: Path) -> dict[str, int]:
    data = path.read_bytes()
    if len(data) != 8:
        raise ValueError(f"Unexpected minimap metadata length {len(data)}: {path}")
    seed, version = struct.unpack("<ii", data)
    if version != 1:
        raise ValueError(f"Unsupported cached minimap version {version}: {path}")
    expected_seed = world_numeric_seed(fwl)
    if seed != expected_seed:
        raise ValueError(f"Minimap seed {seed} does not match world seed {expected_seed}")
    return {"seed": seed, "version": version}


def freeze_cache_set(cache_set: dict[str, object], destination: Path, world: str,
                     fwl: Path) -> tuple[dict[str, object], dict[str, object]]:
    destination.mkdir(parents=True, exist_ok=True)
    cache_format = str(cache_set["format"])
    sources = cache_set["outputs"]
    raw_inputs = {suffix: stamp(path) for suffix, path in sources.items()}
    if cache_format == "minimap-gzip-v1":
        meta_path = cache_set["meta"]
        metadata = verify_current_meta(meta_path, fwl)
        raw_inputs["meta"] = {**stamp(meta_path), **metadata}
    else:
        metadata = {}

    frozen = {}
    for suffix in CACHE_SUFFIXES:
        source = sources[suffix]
        target = destination / f"{world}_{suffix}"
        if cache_format == "legacy-png":
            shutil.copy2(source, target)
        elif suffix == "heightTexCache":
            target.write_bytes(height_cache_png(source))
        else:
            target.write_bytes(color_cache_png(source, rgb=suffix == "mapTexCache"))
        dimensions = png_size(target)
        if dimensions != (TEXTURE_SIZE, TEXTURE_SIZE):
            raise ValueError(f"Unexpected {suffix} dimensions {dimensions}")
        frozen[suffix] = {**stamp(target), "width": dimensions[0], "height": dimensions[1]}
    provenance = {"cacheFormat": cache_format, "rawInputs": raw_inputs}
    if metadata:
        provenance["metadata"] = metadata
    return frozen, provenance
