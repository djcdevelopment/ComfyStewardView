#!/usr/bin/env python3
"""Measure a bounds-only compound against exact-pose private gallery views.

This is a local R&D tool. It reads the external selfie-stick gallery, exact camera
receipts, Depth Anything arrays, and the private BUILDING parquet in place. It
does not copy the source photographs or source ZDO rows into this repository.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import duckdb
import numpy as np
from PIL import Image

FIXTURES = {
    713: {
        "role": "tuning",
        "bounds": (-1937.1, -1849.3, 2950.8, 3050.9),
        "expectedPieces": 864,
        "expectedPrefabPieces": 1,
    },
    1364: {
        "role": "holdout",
        "bounds": (-1679.7, -1607.9, -7255.9, -7183.6),
        "expectedPieces": 705,
        "expectedPrefabPieces": 2,
    },
}
BOX_CORNERS = np.array(
    [[x, y, z] for x in (-0.5, 0.5) for y in (-0.5, 0.5) for z in (-0.5, 0.5)],
    dtype=np.float64,
)
BOX_FACES = np.array(
    [
        [0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5],
        [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6],
        [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3],
    ],
    dtype=np.int64,
)
CROP_FRAC = (0.0, 40 / 900, 1550 / 1600, 1.0)
FOV_V_DEG = 65.0
NEAR = 0.1


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_receipts(path: Path) -> dict[str, dict]:
    result = {}
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            key = f"{row['run']}_{int(row['cluster_id']):04d}_{row['shot']}"
            result[key] = row
    return result


def axis_rotation(axis: str, value: float) -> np.ndarray:
    c, s = math.cos(value), math.sin(value)
    if axis == "x":
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float64)
    if axis == "y":
        return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)


def rotation(axis: str, degrees: float) -> np.ndarray:
    return axis_rotation(axis, math.radians(degrees))


def piece_rotation(row: tuple, hypothesis: str) -> np.ndarray:
    if not row[5]:
        return np.eye(3, dtype=np.float64)
    x, y, z = map(float, row[6:9])
    definitions = {
        "deg_unity": (math.radians(1.0), (("y", y), ("x", x), ("z", z))),
        "deg_unity_neg": (math.radians(-1.0), (("y", y), ("x", x), ("z", z))),
        "deg_xyz": (math.radians(1.0), (("x", x), ("y", y), ("z", z))),
        "deg_zxy": (math.radians(1.0), (("z", z), ("x", x), ("y", y))),
        "rad_unity": (1.0, (("y", y), ("x", x), ("z", z))),
    }
    if hypothesis not in definitions:
        raise ValueError(f"unsupported rotation hypothesis: {hypothesis}")
    factor, terms = definitions[hypothesis]
    result = np.eye(3, dtype=np.float64)
    for axis, value in terms:
        result = result @ axis_rotation(axis, value * factor)
    return result


def baseline_box(row: tuple, geometry: dict, hypothesis: str) -> np.ndarray:
    rot = piece_rotation(row, hypothesis)
    pivot = np.array(row[2:5], dtype=np.float64)
    center = pivot + rot @ np.asarray(geometry["center_offset"], dtype=np.float64)
    return (BOX_CORNERS * np.asarray(geometry["extents"], dtype=np.float64)) @ rot.T + center


def candidate_boxes(row: tuple, candidate: dict, hypothesis: str) -> list[np.ndarray]:
    piece_rot = piece_rotation(row, hypothesis)
    pivot = np.asarray(row[2:5], dtype=np.float64)
    animation_axis = candidate.get("animationAxis", "z")
    animation_pivot = np.asarray(candidate.get("animationPivot", [0, 0, 0]), dtype=np.float64)
    # Mirrors ScenePackage: a deterministic 24-step phase derived from zdo_index.
    spin = rotation(animation_axis, (int(row[0]) % 24) * 15.0)
    result = []
    for primitive in candidate["boxes"]:
        matrix = np.asarray(primitive["matrix"], dtype=np.float64)
        local_linear = np.array(
            [[matrix[column * 4 + row_index] for column in range(3)] for row_index in range(3)],
            dtype=np.float64,
        )
        local_center = matrix[12:15].copy()
        if primitive.get("animated"):
            local_linear = spin @ local_linear
            local_center = animation_pivot + spin @ (local_center - animation_pivot)
        linear = piece_rot @ local_linear
        center = pivot + piece_rot @ local_center
        result.append(BOX_CORNERS @ linear.T + center)
    return result


def camera_basis(yaw_degrees: float, pitch_degrees: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    yaw, pitch = math.radians(yaw_degrees), math.radians(pitch_degrees)
    forward = np.array(
        [math.cos(pitch) * math.sin(yaw), -math.sin(pitch), math.cos(pitch) * math.cos(yaw)]
    )
    right = np.array([math.cos(yaw), 0.0, -math.sin(yaw)])
    up = np.array(
        [math.sin(yaw) * math.sin(pitch), math.cos(pitch), math.cos(yaw) * math.sin(pitch)]
    )
    return forward, right, up


def render_depth(
        boxes: list[np.ndarray], camera: np.ndarray, yaw: float, pitch: float,
        width: int, height: int) -> np.ndarray:
    """Rasterize oriented boxes in native Valheim coordinates (inf means empty)."""
    forward, right, up = camera_basis(yaw, pitch)
    tan_vertical = math.tan(math.radians(FOV_V_DEG / 2.0))
    tan_horizontal = tan_vertical * (width / height)
    depth_buffer = np.full((height, width), np.inf, dtype=np.float32)

    for corners in boxes:
        relative = corners - camera
        depth = relative @ forward
        if depth.max() < NEAR:
            continue
        x_ndc = (relative @ right) / (np.maximum(depth, NEAR) * tan_horizontal)
        y_ndc = (relative @ up) / (np.maximum(depth, NEAR) * tan_vertical)
        pixel_x = (1.0 + x_ndc) * 0.5 * width
        pixel_y = (1.0 - y_ndc) * 0.5 * height
        if (pixel_x.max() < 0 or pixel_x.min() >= width or
                pixel_y.max() < 0 or pixel_y.min() >= height):
            continue
        for triangle in BOX_FACES:
            triangle_depth = depth[triangle]
            if triangle_depth.min() < NEAR:
                continue
            triangle_x, triangle_y = pixel_x[triangle], pixel_y[triangle]
            x0 = max(int(np.floor(triangle_x.min())), 0)
            x1 = min(int(np.ceil(triangle_x.max())) + 1, width)
            y0 = max(int(np.floor(triangle_y.min())), 0)
            y1 = min(int(np.ceil(triangle_y.max())) + 1, height)
            if x0 >= x1 or y0 >= y1:
                continue
            grid_x, grid_y = np.meshgrid(
                np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
            edge0 = ((triangle_x[1] - triangle_x[0]) * (grid_y - triangle_y[0]) -
                     (triangle_y[1] - triangle_y[0]) * (grid_x - triangle_x[0]))
            edge1 = ((triangle_x[2] - triangle_x[1]) * (grid_y - triangle_y[1]) -
                     (triangle_y[2] - triangle_y[1]) * (grid_x - triangle_x[1]))
            edge2 = ((triangle_x[0] - triangle_x[2]) * (grid_y - triangle_y[2]) -
                     (triangle_y[0] - triangle_y[2]) * (grid_x - triangle_x[2]))
            inside = ((edge0 >= 0) & (edge1 >= 0) & (edge2 >= 0)) | \
                     ((edge0 <= 0) & (edge1 <= 0) & (edge2 <= 0))
            if not inside.any():
                continue
            area = ((triangle_x[1] - triangle_x[0]) * (triangle_y[2] - triangle_y[0]) -
                    (triangle_x[2] - triangle_x[0]) * (triangle_y[1] - triangle_y[0]))
            if abs(area) < 1e-9:
                continue
            lambda0, lambda1, lambda2 = edge1 / area, edge2 / area, edge0 / area
            inverse_depth = (lambda0 / triangle_depth[0] + lambda1 / triangle_depth[1] +
                             lambda2 / triangle_depth[2])
            with np.errstate(divide="ignore"):
                pixel_depth = np.where(inverse_depth > 0, 1.0 / inverse_depth, np.inf)
            pixel_depth = np.where(inside, pixel_depth, np.inf).astype(np.float32)
            region = depth_buffer[y0:y1, x0:x1]
            np.minimum(region, pixel_depth, out=region)
    return depth_buffer


def crop(array: np.ndarray) -> np.ndarray:
    height, width = array.shape[:2]
    left, top, right, bottom = CROP_FRAC
    return array[int(top * height):int(bottom * height), int(left * width):int(right * width)]


def evaluation_window(baseline: np.ndarray, candidate: np.ndarray) -> np.ndarray:
    union = baseline | candidate
    ys, xs = np.nonzero(union)
    result = np.zeros_like(union)
    if not len(ys):
        return result
    span = max(int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1))
    pad = max(4, int(round(span * 0.08)))
    y0, y1 = max(0, int(ys.min()) - pad), min(union.shape[0], int(ys.max()) + pad + 1)
    x0, x1 = max(0, int(xs.min()) - pad), min(union.shape[1], int(xs.max()) + pad + 1)
    result[y0:y1, x0:x1] = True
    return result


def silhouette_iou(mask: np.ndarray, foreground: np.ndarray, window: np.ndarray) -> float:
    predicted = mask & window
    observed = foreground & window
    union = predicted | observed
    return float((predicted & observed).sum() / union.sum()) if union.any() else 0.0


def depth_ordering(render: np.ndarray, photo: np.ndarray, rng: np.random.Generator) -> tuple[float | None, int]:
    ys, xs = np.nonzero(np.isfinite(render))
    if len(ys) < 200:
        return None, 0
    first = rng.integers(0, len(ys), 50000)
    second = rng.integers(0, len(ys), 50000)
    near = render[ys[first], xs[first]]
    far = render[ys[second], xs[second]]
    keep = np.abs(near - far) > 1.0
    pairs = int(keep.sum())
    if not pairs:
        return None, 0
    photo_a = photo[ys[first][keep], xs[first][keep]]
    photo_b = photo[ys[second][keep], xs[second][keep]]
    agree = ((near[keep] < far[keep]) == (photo_a > photo_b))
    return float(agree.mean()), pairs


def overlay(image_path: Path, baseline: np.ndarray, candidate: np.ndarray, window: np.ndarray, out: Path) -> None:
    source = Image.open(image_path).convert("RGB")
    working_height = int(round(source.height * (baseline.shape[1] / (source.width * CROP_FRAC[2]))))
    working = np.asarray(source.resize((int(round(baseline.shape[1] / CROP_FRAC[2])), working_height)))
    pixels = crop(working).copy()
    # Candidate-only green; baseline-only red; agreement gold. The blue rectangle is the scored window.
    pixels[candidate & ~baseline] = pixels[candidate & ~baseline] * 0.35 + np.array([25, 230, 130]) * 0.65
    pixels[baseline & ~candidate] = pixels[baseline & ~candidate] * 0.35 + np.array([240, 65, 65]) * 0.65
    pixels[baseline & candidate] = pixels[baseline & candidate] * 0.35 + np.array([245, 195, 65]) * 0.65
    ys, xs = np.nonzero(window)
    if len(ys):
        y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
        pixels[[y0, y1], x0:x1 + 1] = [55, 150, 255]
        pixels[y0:y1 + 1, [x0, x1]] = [55, 150, 255]
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8)).save(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selfie-stick", type=Path, required=True)
    parser.add_argument("--parquet", type=Path, required=True)
    parser.add_argument("--probe", type=Path, required=True)
    parser.add_argument("--receipts", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--prefab", default="windmill")
    args = parser.parse_args()

    era = args.selfie_stick / "out" / "era17"
    gallery = era / "gallery"
    geometry_path = era / "arch" / "piece-geometry.json"
    verify_path = era / "arch" / "rotation-verify.json"
    depth_path = era / "arch" / "depth-npy"
    verify = read_json(verify_path)
    if verify.get("verdict") != "PASS":
        raise SystemExit("rotation verification is not PASS")
    hypothesis = verify.get("winner")
    try:
        # Validate the receipt-selected convention before doing the expensive work.
        piece_rotation((0, "", 0, 0, 0, True, 0, 0, 0), hypothesis)
    except (TypeError, ValueError) as error:
        raise SystemExit(str(error)) from error
    geometry_root = read_json(geometry_path)
    geometry = next(row for row in geometry_root["pieces"] if row["name"] == args.prefab)
    probe = read_json(args.probe)
    if probe.get("schema") != "steward-prefab-renderers/v1" or not probe.get("gameVersion"):
        raise SystemExit("renderer probe schema or game version is invalid")
    candidate = next(row for row in probe["prefabs"] if row["name"] == args.prefab)
    if (candidate.get("status") != "candidate" or not candidate.get("boxes") or
            int(candidate.get("hash", 0)) != int(geometry["hash"])):
        raise SystemExit("probe candidate is not renderable")
    gallery_index = read_json(gallery / "index.json")
    receipts = load_receipts(args.receipts)

    connection = duckdb.connect()
    rows_by_fixture = {}
    for fixture, definition in FIXTURES.items():
        min_x, max_x, min_z, max_z = definition["bounds"]
        population = connection.execute(
            """SELECT count(*) FROM read_parquet(?)
               WHERE category = 'BUILDING'
                 AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?""",
            [str(args.parquet), min_x, max_x, min_z, max_z],
        ).fetchone()[0]
        if population != definition["expectedPieces"]:
            raise SystemExit(
                f"fixture {fixture} has {population} pieces; expected {definition['expectedPieces']}"
            )
        rows = connection.execute(
            """SELECT zdo_index, prefab_name, x, y, z, has_rot, rot_x, rot_y, rot_z
               FROM read_parquet(?)
               WHERE category = 'BUILDING' AND prefab_name = ?
                 AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?
               ORDER BY zdo_index""",
            [str(args.parquet), args.prefab, min_x, max_x, min_z, max_z],
        ).fetchall()
        if len(rows) != definition["expectedPrefabPieces"]:
            raise SystemExit(f"fixture {fixture} has {len(rows)} {args.prefab} rows; expected {definition['expectedPrefabPieces']}")
        rows_by_fixture[fixture] = rows

    args.out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(17)
    metrics = {
        "schema": "steward-prefab-fidelity-metrics/v1",
        "prefab": args.prefab,
        "method": {
            "camera": "exact receipt lens/yaw/pitch; vertical FOV from receipt (65 degrees)",
            "silhouette": "IoU inside an 8%-padded projected prefab window against Depth Anything foreground >= 0.30 after 1st/99th percentile normalization",
            "depthOrdering": "50,000 deterministic candidate-silhouette pixel pairs; pairs with rendered depth gap > 1 m",
            "animation": "same deterministic 24-step zdo_index phase as the public scene package",
        },
        "inputs": {
            "probeSha256": sha256(args.probe),
            "geometrySha256": sha256(geometry_path),
            "rotationVerifySha256": sha256(verify_path),
            "galleryIndexSha256": sha256(gallery / "index.json"),
            "receiptSha256": sha256(args.receipts),
            "sourceImagesCopied": False,
        },
        "fixtures": [],
        "views": [],
    }
    for fixture, definition in FIXTURES.items():
        metrics["fixtures"].append({"clusterId": fixture, **definition})
    for image in gallery_index["images"]:
        fixture = int(image.get("cluster_id", -1))
        if fixture not in FIXTURES or image.get("source") != "orbit":
            continue
        view_id = image["id"]
        receipt = receipts.get(view_id)
        depth_file = depth_path / f"{view_id}.npy"
        image_file = gallery / "large" / f"{view_id}.webp"
        if (not receipt or abs(float(receipt.get("fov", 65)) - 65.0) > 1e-6 or
                not depth_file.is_file() or not image_file.is_file()):
            metrics["views"].append({"viewId": view_id, "prefab": args.prefab,
                                      "role": FIXTURES[fixture]["role"], "usable": False,
                                      "reason": "exact 65-degree receipt, image, or depth array missing"})
            continue
        depth = np.load(depth_file).astype(np.float32)
        height, width = depth.shape
        camera = np.array([receipt["lens"][axis] for axis in "xyz"], dtype=np.float64)
        baseline_corners = [baseline_box(row, geometry, hypothesis) for row in rows_by_fixture[fixture]]
        candidate_corners = [box for row in rows_by_fixture[fixture]
                             for box in candidate_boxes(row, candidate, hypothesis)]
        baseline_depth = render_depth(
            baseline_corners, camera, receipt["yaw"], receipt["pitch"], width, height)
        candidate_depth = render_depth(
            candidate_corners, camera, receipt["yaw"], receipt["pitch"], width, height)
        baseline_depth, candidate_depth, photo = map(crop, (baseline_depth, candidate_depth, depth))
        baseline_mask, candidate_mask = np.isfinite(baseline_depth), np.isfinite(candidate_depth)
        window = evaluation_window(baseline_mask, candidate_mask)
        low, high = np.percentile(photo, (1, 99))
        normalized = np.clip((photo - low) / max(high - low, 1e-6), 0, 1)
        foreground = normalized >= 0.30
        baseline_iou = silhouette_iou(baseline_mask, foreground, window)
        candidate_iou = silhouette_iou(candidate_mask, foreground, window)
        ordering, pairs = depth_ordering(candidate_depth, photo, rng)
        row = {
            "viewId": view_id,
            "clusterId": fixture,
            "prefab": args.prefab,
            "role": FIXTURES[fixture]["role"],
            "usable": bool(candidate_mask.any() and window.any()),
            "baselineSilhouetteIou": round(baseline_iou, 4),
            "candidateSilhouetteIou": round(candidate_iou, 4),
            "candidateDepthOrdering": round(ordering, 4) if ordering is not None else None,
            "depthPairs": pairs,
            "candidatePixels": int(candidate_mask.sum()),
            "windowPixels": int(window.sum()),
            "camera": {"lens": receipt["lens"], "yaw": receipt["yaw"],
                       "pitch": receipt["pitch"], "verticalFov": receipt.get("fov", 65)},
        }
        metrics["views"].append(row)
        overlay(image_file, baseline_mask, candidate_mask, window, args.out / f"{view_id}-overlay.png")
        print(f"{view_id}: baseline={baseline_iou:.4f} candidate={candidate_iou:.4f} "
              f"depth={ordering if ordering is not None else 'n/a'} pairs={pairs}")

    output = args.out / f"{args.prefab}-metrics.json"
    output.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {output}")


if __name__ == "__main__":
    main()
