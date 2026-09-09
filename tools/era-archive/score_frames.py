#!/usr/bin/env python3
"""Measure every captured frame and say which ones are not worth showing anyone.

The archive went public with 7,265 photographs, and a measurable share of them are frames
nobody would choose: fog whiteouts, near-black rectangles, the camera pressed against a
wall, and the same structure published many times under different build keys.

Measured across all 2,089 published era-14 photographs, three things are true and this
tool acts on all three:

  * One cheap statistic finds the unusable frames. Mean gradient magnitude below the 5th
    percentile (0.008) picks out, in order: two solid dark rectangles, a speck in grey
    haze, a near-black frame, four pink fog whiteouts, and two frames inside a wall.
  * Duplicates are *between* builds, not within them. 227 near-duplicate pairs at hamming
    <= 18/144, of which 226 join two different buildKeys -- the stamped-lot problem that
    `community.py`'s templateKey dedupe is meant to catch and currently cannot. The four
    orbit shots of one build are genuinely different corners (median hamming 68, min 34);
    exactly one within-build pair in the whole era is a near-duplicate.
  * A frame's own capture receipt already predicts junk, so `import_captures.py` throws
    those out before they are ever encoded. This tool only sees what survived that.

Thresholds are calibrated on the 512 px thumbnail, not the 1600 px derivative, because
gradient magnitude is scale-dependent and that is the size they were measured at.

The night guard is load-bearing. Dark, low-contrast frames that contain small very bright
regions are lantern-lit night photography -- a deliberate act by the builder that daylight
hides completely -- and are never vetoed on brightness. Era 14 cannot trip it (every frame
is Clear at time 0.64), but the same thresholds veto 22.9% of the era 16/17 legacy set and
much of that is exactly this work.

Nothing here deletes anything. It writes verdicts; `import_captures.py` applies them, and
a re-run with different thresholds undoes them.

Usage:
  python score_frames.py --images <derivatives>/thumb --era era14 --out quality-era14.json
"""
import argparse
import collections
import json
from pathlib import Path
import time

import numpy as np
from PIL import Image

# Every threshold below is a measurement, not a taste. See the module docstring.
EDGE_FLOOR = 0.008        # 5th percentile of era 14
NIGHT_MEAN = 0.12         # below this a frame is "dark"
NIGHT_SPAN = 0.35         # p99.9 - median; a dark frame with this much span has lamps lit
BLOWN_MEAN = 0.72         # bright ...
BLOWN_STD = 0.13          # ... and flat: the washed-out white-out cluster
DUPE_BITS = 18            # of 144; within-build pairs sit at median 68, minimum 34
HASH_SIDE = 12            # 12x13 luma comparisons -> 144 bits
CENTER_BLOCK = 0.45       # depth_layers.py's threshold, validated on a DIFFERENT corpus


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def measure(path):
    """Six numbers per frame, from one decode. No model, no network."""
    image = Image.open(path)
    grey = np.asarray(image.convert("L"), dtype=np.float32) / 255.0
    saturation = np.asarray(image.convert("HSV"), dtype=np.float32)[..., 1] / 255.0
    gy, gx = np.gradient(grey)
    median = float(np.median(grey))
    small = np.asarray(image.convert("L").resize((HASH_SIDE + 1, HASH_SIDE), Image.LANCZOS),
                       dtype=np.int16)
    bits = (small[:, 1:] > small[:, :-1]).ravel()
    return {
        "lumaMean": round(float(grey.mean()), 4),
        "lumaStd": round(float(grey.std()), 4),
        "edgeEnergy": round(float(np.sqrt(gx * gx + gy * gy).mean()), 5),
        "saturation": round(float(saturation.mean()), 4),
        # p99.9 minus the median. A fog whiteout has almost none of this; a night frame
        # with braziers lit has a lot, which is what keeps it out of the "empty" bucket.
        "highlightSpan": round(float(np.percentile(grey, 99.9)) - median, 4),
        "dhash": "".join(f"{b:02x}" for b in np.packbits(bits).tobytes()),
    }


def read_optional(path):
    if not path:
        return {}
    return json.loads(Path(path).read_text(encoding="utf-8"))


def verdict(frame, wall_veto=False):
    dark = frame["lumaMean"] < NIGHT_MEAN
    lit = frame["highlightSpan"] >= NIGHT_SPAN
    if dark and lit:
        # Dim but deliberate: the only light that shows a builder's own lighting design.
        return "keep", "night lighting"
    if frame["edgeEnergy"] < EDGE_FLOOR:
        return "empty", "nothing in frame: fog, sky, darkness or a wall"
    if frame["lumaMean"] > BLOWN_MEAN and frame["lumaStd"] < BLOWN_STD:
        return "blown", "washed out"
    # Off by default, and this is why. `center_block > 0.45` was validated on twelve
    # hand-labelled selfie-stick frames, where it fired on exactly the two camera-in-a-wall
    # duds and zero keepers. On era 14's orbit captures it picks 14 frames of 2,089, and
    # looking at them they are mostly *legitimate* builds that simply fill the middle of
    # the frame -- a stone tower in a forest, a longhouse, a sky platform. The statistics
    # transfer (p95 0.249 here against 0.286 there); the meaning does not, because an
    # orbit shot is supposed to have its subject centred and close.
    #
    # So centerBlock is measured and recorded on every frame, and acted on by nobody until
    # somebody labels a set of these captures. Tuning the number by eye would be guessing.
    if wall_veto and frame.get("centerBlock") is not None and frame["centerBlock"] > CENTER_BLOCK:
        return "wall", "a near surface across the eye-line"
    return "keep", ""


def unpack(hex_digest):
    raw = bytes.fromhex(hex_digest)
    return np.unpackbits(np.frombuffer(raw, dtype=np.uint8))[:HASH_SIDE * (HASH_SIDE + 1) - HASH_SIDE]


def cluster_duplicates(frames, keys):
    """Connected components over the near-duplicate graph, best-lit member survives."""
    if not keys:
        return []
    table = np.stack([unpack(frames[k]["dhash"]) for k in keys]).astype(np.uint8)
    neighbours = collections.defaultdict(set)
    for start in range(0, len(keys), 256):
        block = table[start:start + 256]
        distance = (block[:, None, :] != table[None, :, :]).sum(2)
        for row, column in np.argwhere(distance <= DUPE_BITS):
            a, b = start + int(row), int(column)
            if a != b:
                neighbours[a].add(b)
                neighbours[b].add(a)

    seen, clusters = set(), []
    for node in neighbours:
        if node in seen:
            continue
        stack, component = [node], []
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            component.append(current)
            stack.extend(neighbours[current] - seen)
        if len(component) > 1:
            clusters.append(sorted(component))

    out = []
    for component in sorted(clusters, key=len, reverse=True):
        members = [keys[i] for i in component]
        keep = max(members, key=lambda k: (frames[k].get("aesthetic", 0.0),
                                           frames[k]["edgeEnergy"]))
        out.append({"keep": keep, "drop": sorted(m for m in members if m != keep)})
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--images", type=Path, required=True,
                        help="directory of 512 px thumbnails, i.e. <derivatives>/thumb")
    parser.add_argument("--era", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--aesthetic", type=Path, default=None,
                        help="aesthetic.json from score_images.py. Used to pick which "
                             "member of a duplicate cluster survives, and to order each "
                             "album best-first -- never to veto, because the head reads "
                             "global tone only and marks dark frames down on principle")
    parser.add_argument("--depth", type=Path, default=None,
                        help="depth.json from depth_layers.py; supplies the center_block "
                             "wall veto")
    parser.add_argument("--wall-veto", action="store_true",
                        help="also veto frames with center_block above 0.45. Measured to "
                             "misfire on orbit captures -- see verdict() -- so it is off "
                             "until someone labels a set of them.")
    parser.add_argument("--no-duplicates", action="store_true",
                        help="measure and veto only; leave near-duplicates alone")
    args = parser.parse_args()

    started = time.time()
    paths = sorted(p for p in args.images.iterdir() if p.suffix.lower() == ".webp")
    if not paths:
        raise SystemExit(f"no .webp thumbnails under {args.images}")

    aesthetic = read_optional(args.aesthetic)
    depth = read_optional(args.depth)

    frames, counts = {}, collections.Counter()
    for path in paths:
        frame = measure(path)
        if path.stem in aesthetic:
            frame["aesthetic"] = aesthetic[path.stem]["aesthetic"]
        if path.stem in depth:
            frame["centerBlock"] = depth[path.stem]["center_block"]
        frame["verdict"], frame["reason"] = verdict(frame, args.wall_veto)
        counts[frame["verdict"]] += 1
        if frame["reason"] == "night lighting":
            counts["night_protected"] += 1
        frames[path.stem] = frame

    duplicates = []
    if not args.no_duplicates:
        survivors = [k for k, f in frames.items() if f["verdict"] == "keep"]
        duplicates = cluster_duplicates(frames, survivors)
        for cluster in duplicates:
            for dropped in cluster["drop"]:
                frames[dropped]["verdict"] = "duplicate"
                frames[dropped]["reason"] = f"near-identical to {cluster['keep']}"
                counts["duplicate"] += 1
                counts["keep"] -= 1

    elapsed = time.time() - started
    write(args.out, {
        "schema": "steward-frame-quality/v1",
        "era": args.era,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "measuredOn": "thumb",
        "thresholds": {"edgeFloor": EDGE_FLOOR, "nightMean": NIGHT_MEAN,
                       "nightSpan": NIGHT_SPAN, "blownMean": BLOWN_MEAN,
                       "blownStd": BLOWN_STD, "duplicateBits": DUPE_BITS},
        "counts": dict(sorted(counts.items())),
        "scored": {"aesthetic": bool(aesthetic), "depth": bool(depth)},
        "duplicateClusters": duplicates,
        "frames": frames,
    })
    rejected = len(paths) - counts["keep"]
    print(f"{len(paths):,} frames in {elapsed:.1f}s ({len(paths) / max(elapsed, 1e-9):.0f}/s)")
    print(f"  keep {counts['keep']:,} | empty {counts['empty']:,} | blown {counts['blown']:,} "
          f"| wall {counts['wall']:,} | duplicate {counts['duplicate']:,}  ->  "
          f"{rejected:,} rejected ({100 * rejected / len(paths):.1f}%)")
    if not aesthetic:
        print("  NOTE no --aesthetic: duplicate survivors chosen by edge energy, and "
              "albums cannot be ordered best-first")
    if depth and not args.wall_veto:
        print("  NOTE center_block measured on every frame but not vetoed on; it misfires "
              "on orbit captures. Pass --wall-veto to act on it.")
    if counts["night_protected"]:
        print(f"  {counts['night_protected']:,} dark frames kept for their own lighting")
    if duplicates:
        largest = duplicates[0]
        print(f"  {len(duplicates):,} duplicate clusters; largest holds "
              f"{len(largest['drop']) + 1} frames")
    print(args.out)


if __name__ == "__main__":
    main()
