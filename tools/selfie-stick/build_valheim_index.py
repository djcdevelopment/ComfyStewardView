#!/usr/bin/env python3
"""Build a gallery index from camera captures, joined to the structures they show.

Walks the capture folders written by the camera mod, reads each run's capture.json
for the position it was shot from, and joins that position back to the nearest
structure in clusters.json. The result is one row per image carrying not just
"a screenshot" but "a screenshot of a 19,720-piece hub with 66 portals, built by
creator 8829..., 113 m tall".

Modelled on the AM4 gallery's build_index.py (tools/am4-gallery/build_index.py):
same atomic .tmp + os.replace write, same top-level facet lists, same tolerance for
malformed rows — except that skips are reported loudly rather than silently, because
a contributor's whole drop can otherwise vanish without a message.

Usage:
  python build_valheim_index.py [--captures DIR] [--clusters PATH] [--dest DIR]
                                [--thumbs] [--max-join-m 250]
"""
import argparse
import json
import math
import os
import shutil
import sys
from collections import Counter

DEFAULT_CAPTURES = (r"C:\Program Files (x86)\Steam\steamapps\common\Valheim"
                    r"\BepInEx\config\comfy-manual-captures")
THUMB_PX = 512
# Big enough to actually look at, small enough to serve. The 4K originals are
# 6.6 MB each; at 1600 px they are a couple of hundred KB and lose nothing that
# matters on a screen.
LARGE_PX = 1600


def parse_args():
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--captures", default=DEFAULT_CAPTURES,
                   help="directory of <timestamp>/ capture run folders")
    p.add_argument("--clusters", default=os.path.join(here, "out", "clusters.json"),
                   help="clusters.json from scan_clusters.py (optional but recommended)")
    p.add_argument("--dest", default=os.path.join(here, "out", "gallery"),
                   help="where index.json and thumb/ are written")
    p.add_argument("--thumbs", action="store_true",
                   help="also generate webp thumbnails (needs Pillow)")
    p.add_argument("--large", action="store_true",
                   help="also generate 1600px webp for the lightbox")
    p.add_argument("--keep-rejects", action="store_true",
                   help="include frames the capture itself flagged as bad")
    p.add_argument("--copy-full", action="store_true",
                   help="copy full-size images into dest/img (large; off by default)")
    p.add_argument("--orbit-captures", default=(r"C:\Program Files (x86)\Steam\steamapps"
                                                r"\common\Valheim\BepInEx\config\comfy-orbit-captures"),
                   help="directory of automated orbit capture runs")
    p.add_argument("--receipts", default=(r"C:\Program Files (x86)\Steam\steamapps\common"
                                          r"\Valheim\BepInEx\config\shotplan-receipts.jsonl"),
                   help="orbit run receipts, one JSON object per line")
    p.add_argument("--depth", default=os.path.join(here, "out", "depth.json"),
                   help="depth/luma metrics from depth_layers.py; powers the fog flag")
    p.add_argument("--aesthetic", default=os.path.join(here, "out", "aesthetic.json"),
                   help="per-image scores from score_images.py")
    p.add_argument("--names", default=os.path.join(here, "out", "cluster-names.json"),
                   help="optional JSON map of cluster_id -> human name")
    p.add_argument("--max-join-m", type=float, default=250.0,
                   help="how far a shot may be from a cluster centre and still count "
                        "as a picture of it (default 250)")
    p.add_argument("--run", action="append", default=[],
                   help="include only this capture run id; repeat for multiple runs")
    p.add_argument("--world", default=None,
                   help="public world label stored in the gallery index")
    p.add_argument("--crop-right-ui-px", type=int, default=0,
                   help="remove this many pixels from the source's right edge before web rendering")
    p.add_argument("--crop-top-from-run", default="",
                   help="only apply --crop-top-ui-px to runs at or after this run id. "
                        "The quest bar appears in captures from 2026-08-24 and in none "
                        "of the 33 runs before it, so cropping every frame would shave "
                        "6%% off 2,081 images to remove something that is not in them")
    p.add_argument("--crop-top-ui-px", type=int, default=0,
                   help="strip this many pixels off the top of derived web images. "
                        "ComfyQuest's overhead creator bar has no hide switch and "
                        "burns into every frame captured after 2026-08-24; 128 "
                        "clears it on a 3840x2160 capture. Originals are untouched")
    p.add_argument("--derived", default=None,
                   help="optional JSON list of explicit detail frames derived from accepted orbit captures")
    return p.parse_args()


def load_clusters(path):
    """Return clusters as a list, or [] if unavailable — the index still builds."""
    if not path or not os.path.exists(path):
        print(f"  ! no clusters.json at {path} — images will have no structure metadata")
        return []
    with open(path, encoding="utf-8") as fh:
        return json.load(fh).get("clusters", [])


# Neighbourhoods, on a fixed 2 km grid. Proximity clustering was tried first and
# chains: single-linkage at 800 m swallowed 953 of Era 17's 1,025 in-world builds
# into one "area", and at 300 m almost every build was its own. A grid does not
# chain, stays put as coverage deepens, and at 2 km leaves only 23 of 269
# photographed builds without a photographed neighbour.
AREA_CELL_M = 2000.0


def assign_areas(clusters, names):
    """cluster_id -> (area_id, area_label).

    The id is a SEQUENCE NUMBER, deliberately. The obvious id is the grid cell,
    and a grid cell is a coordinate at 2 km resolution — precisely what
    scrub_index.py exists to keep off a public host. Ordering the sequence by
    piece mass makes it stable and reveals nothing about where anything is.

    The label names the area after its largest build, so a chip reads "near
    Black Tower" rather than "area 7". That is an adjacency fact, which this
    feature is inherently about; it is not a position.
    """
    cells = {}
    for c in clusters:
        key = (int(c["center_x"] // AREA_CELL_M), int(c["center_z"] // AREA_CELL_M))
        cells.setdefault(key, []).append(c)

    ranked = sorted(cells.values(),
                    key=lambda members: (-sum(m["pieces"] for m in members),
                                         min(m["cluster_id"] for m in members)))
    out = {}
    for area_id, members in enumerate(ranked, start=1):
        # The biggest build in a cell is usually one nobody has photographed, and
        # only photographed builds get names -- so rank by "has a name" first.
        # Naming an area after a build the visitor cannot click through to is
        # worse than a number.
        landmark = max(members,
                       key=lambda m: (1 if (names or {}).get(str(m["cluster_id"])) else 0,
                                      m["pieces"], -m["cluster_id"]))
        named = (names or {}).get(str(landmark["cluster_id"]))
        label = f"near {named}" if named else f"area {area_id}"
        for m in members:
            out[m["cluster_id"]] = (area_id, label)
    return out


def area_fields(areas, cluster):
    """The two shippable area fields for a joined row, or nothing if unknown."""
    found = areas.get(cluster["cluster_id"])
    if not found:
        return {}
    return {"area_id": found[0], "area_label": found[1]}


def load_cluster_world(path):
    if not path or not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh).get("world")


def nearest_cluster(clusters, x, z, max_m):
    """Nearest cluster centre in x/z. Ignores y: a shot from above is still of it."""
    best, best_d2 = None, None
    limit2 = max_m * max_m
    for c in clusters:
        dx = c["center_x"] - x
        dz = c["center_z"] - z
        d2 = dx * dx + dz * dz
        if best_d2 is None or d2 < best_d2:
            best, best_d2 = c, d2
    if best is None or best_d2 > limit2:
        return None, None
    return best, math.sqrt(best_d2)


def read_orbit_receipts(path):
    """Orbit runs record their own provenance, one JSON object per line.

    Manual captures have to be joined to a structure by nearest centroid, because
    all the mod knew was where the player stood. An orbit shot was *planned* for a
    specific cluster, so its cluster_id is exact and carries the framing intent
    with it — planned vs actual lens position, occlusion, and how much of the build
    had streamed in when the shutter fired.
    """
    rows = []
    if not os.path.exists(path):
        return rows
    # utf-8-sig, not utf-8: the mod appends with .NET's Encoding.UTF8, which emits a
    # BOM on the first write, so line 1 of every receipts file starts with one.
    with open(path, encoding="utf-8-sig") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                print(f"  ! receipts line {n} unreadable: {exc}")
    return rows


def read_capture(run_dir):
    """Parse one run's capture.json. Returns (position, items) or raises."""
    path = os.path.join(run_dir, "capture.json")
    with open(path, encoding="utf-8-sig") as fh:      # the mod writes a BOM
        doc = json.load(fh)
    return doc["position"], doc.get("items", [])


def describe(c):
    """A readable name for a structure, since Valheim gives builds no names.

    Rank and piece count identify a cluster but say nothing about what it is, so
    lead with its most distinctive trait. Ordered by how strongly each trait
    characterises a place: a 66-portal hub reads as a hub first and a big build
    second, while sheer height is the defining fact about a tower.
    """
    portals, beds = c.get("portals", 0), c.get("beds", 0)
    signs, stands = c.get("signs", 0), c.get("item_stands", 0)
    h, foot = c.get("size_y", 0), c.get("footprint_m2", 0)
    builders = c.get("distinct_creators", 0)

    if portals >= 30:
        kind = "major hub"
    elif h >= 90:
        kind = "tower"
    elif stands >= 200:
        kind = "museum"
    elif signs >= 800:
        kind = "sign-covered"
    elif portals >= 10:
        kind = "hub"
    elif beds >= 10:
        kind = "settlement"
    elif foot >= 50000:
        kind = "sprawl"
    elif h >= 60:
        kind = "tall hall"
    elif builders >= 8:
        kind = "shared build"
    else:
        kind = "build"

    if c.get("sky"):
        kind = "sky " + kind
    return kind


def label_for(c, named):
    """Prefer a human name. `named` comes from the notes column of clusters.csv —
    fill it in while flying and the gallery picks it up on the next rebuild."""
    hand = (named or {}).get(str(c["cluster_id"]))
    if hand:
        return hand
    return f"{describe(c)} · {c['pieces']:,}"


def load_names(path):
    """Optional cluster_id -> name map, so structures can be named by hand."""
    if not path or not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8-sig") as fh:
        return {str(k): str(v).strip() for k, v in json.load(fh).items() if str(v).strip()}


def make_thumb(src, dest_path, px=THUMB_PX, quality=82, crop_right_ui_px=0,
               crop_top_ui_px=0, detail_crop_fraction=0.0):
    from PIL import Image
    with Image.open(src) as im:
        im = im.convert("RGB")
        if crop_right_ui_px:
            right = im.width - crop_right_ui_px
            if right <= 0:
                raise ValueError("right-edge UI crop is wider than the source image")
            im = im.crop((0, 0, right, im.height))
        if crop_top_ui_px:
            # ComfyQuest draws an overhead creator bar that has no hide switch,
            # so from 2026-08-24 it is burned into the top of every capture:
            # measured at y 92-127, x 1200-2639 on a 3840x2160 frame. Nothing
            # here can stop it being rendered, only decline to publish it.
            if crop_top_ui_px >= im.height:
                raise ValueError("top UI crop is taller than the source image")
            im = im.crop((0, crop_top_ui_px, im.width, im.height))
        if detail_crop_fraction:
            if not 0.0 < detail_crop_fraction < 0.45:
                raise ValueError("detail crop fraction must be between 0 and 0.45")
            x = round(im.width * detail_crop_fraction)
            y = round(im.height * detail_crop_fraction)
            im = im.crop((x, y, im.width - x, im.height - y))
        im.thumbnail((px, px))
        im.save(dest_path, "WEBP", quality=quality, method=4)


def supersede_key(row):
    """What makes an orbit frame the same photograph as another.

    The light belongs in here. Slot names orbit1..4 mean "the four bearings",
    not "the four bearings at one time of day", and every re-shoot reuses them,
    so a key of (cluster, variant) alone treats any later frame as a newer
    version of an earlier one. On 2026-08-24 a deliberate re-shoot of 30 builds
    at time 0.71 silently retired their 0.64 originals that way -- 150 frames,
    the best-photographing thirty in the gallery, replaced rather than joined.

    Whether the builders' fires were held lit belongs in here for the same
    reason, and more sharply: re-shooting a plan with --fires reuses every
    variant name at the same environment and the same time, so without it the
    lit frames would retire the unlit ones and delete the comparison they were
    taken to make. The control is not an older version of the photograph. It is
    the other half of it.
    """
    return (row.get("cluster_id"), row.get("variant"),
            row.get("environment"), row.get("time_of_day"),
            bool(row.get("fires")), row.get("flash_bearing_deg"))


def perspective_of(variant):
    """Where the lens stood. seat_* rides a chair; the other interior vantages
    stand at eye height; moon* stands on the build's own roof looking out at the
    sky; everything else is the drone doing orbits and sweeps.

    The bucket is not cosmetic. The gallery ranks each frame WITHIN its
    perspective and sorts on that percentile, because the aesthetic head reads
    global tone -- it prefers a landscape to a room by 0.45 on this set and marks
    anything dark down on principle. Without a bucket of their own, every night
    frame would lose a raw-score fight with a golden-hour aerial by construction
    and sink to the bottom of the page.
    """
    v = variant or ""
    if v.startswith("seat_"):
        return "seated"
    if v.startswith(("hall_", "toproom_", "gate_", "court_")):
        return "eye level"
    if v.startswith("moon"):
        return "rooftop"
    return "drone"


# Whiteout fog: bright and flat. Calibrated on the visible offenders in the
# gallery (misty frames reading as near-uniform white) against bright-but-real
# controls (snow builds, clear skies) — see the calibration table in the run
# that set these. Flagged frames stay in the index; the gallery hides them
# behind a toggle rather than deleting anyone's capture.
FOG_LUMA_MEAN = 186.0
FOG_LUMA_SPREAD = 60.0
FOG_DEPTH_SPAN = 0.35
FOG_FAR_MASS = 0.10


def is_fog(image_id, depth):
    d = depth.get(image_id)
    if not d or "luma_mean" not in d:
        return False
    whiteout = d["luma_mean"] > FOG_LUMA_MEAN and d["luma_spread"] < FOG_LUMA_SPREAD
    flat = (d["luma_mean"] > FOG_LUMA_MEAN - 20
            and d.get("depth_span", 1.0) < FOG_DEPTH_SPAN
            and d.get("far_mass", 1.0) < FOG_FAR_MASS)
    return bool(whiteout or flat)


def is_reject(rec):
    """Frames the capture itself already knew were bad.

    Two failure modes, both recorded at the moment of the shot: the world had not
    loaded (a photograph of the loading screen), and the view was obstructed (a
    photograph of a tree). No judgement about whether a picture is *good* -- only
    whether it is a picture of the thing at all.
    """
    if rec.get("skipped"):
        return "skipped by the runner"
    if rec.get("pieces_near_aim") == 0:
        return "world never loaded"
    if rec.get("occluded"):
        return "view obstructed"
    return None


def main():
    args = parse_args()
    if not os.path.isdir(args.captures):
        sys.exit(f"captures directory not found: {args.captures}")

    clusters = load_clusters(args.clusters)
    by_id = {c["cluster_id"]: c for c in clusters}
    names = load_names(args.names)
    areas = assign_areas(clusters, names)
    # Per-image aesthetic scores, if they have been computed. These say something
    # about the photograph; the cluster score only says something about the
    # building, and is identical across all six frames of it.
    aesthetic = {}
    if os.path.exists(args.aesthetic):
        with open(args.aesthetic, encoding="utf-8") as fh:
            aesthetic = {k: v.get("aesthetic") for k, v in json.load(fh).items()}
        print(f"  {len(aesthetic)} image(s) carry an aesthetic score")
    depth = {}
    if os.path.exists(args.depth):
        with open(args.depth, encoding="utf-8") as fh:
            depth = json.load(fh)
        print(f"  {len(depth)} image(s) carry depth/luma metrics")
    if names:
        print(f"  {len(names)} structure(s) named by hand")
    os.makedirs(args.dest, exist_ok=True)
    thumb_dir = os.path.join(args.dest, "thumb")
    img_dir = os.path.join(args.dest, "img")
    if args.thumbs:
        os.makedirs(thumb_dir, exist_ok=True)
    if args.copy_full:
        os.makedirs(img_dir, exist_ok=True)

    rows = []
    skipped = []
    rejected = []
    unjoined = 0
    large_dir = os.path.join(args.dest, "large")
    if args.large:
        os.makedirs(large_dir, exist_ok=True)

    for run in sorted(os.listdir(args.captures)):
        if args.run and run not in args.run:
            continue
        run_dir = os.path.join(args.captures, run)
        if not os.path.isdir(run_dir):
            continue
        try:
            pos, items = read_capture(run_dir)
        except FileNotFoundError:
            skipped.append((run, "no capture.json (run interrupted?)"))
            continue
        except (json.JSONDecodeError, KeyError) as exc:
            skipped.append((run, f"unreadable capture.json: {exc}"))
            continue

        cluster, dist = nearest_cluster(clusters, pos["x"], pos["z"], args.max_join_m) \
            if clusters else (None, None)
        if clusters and cluster is None:
            unjoined += 1

        for item in items:
            still = item.get("still")
            if not still:
                skipped.append((run, "item with no filename"))
                continue
            src = os.path.join(run_dir, still)
            if not os.path.exists(src):
                skipped.append((run, f"{still} listed in manifest but missing on disk"))
                continue

            image_id = f"{run}_{os.path.splitext(still)[0]}"
            row = {
                "id": image_id,
                "run": run,                       # the "cell": all moods of one setup
                "variant": item.get("variant"),
                "environment": item.get("environment"),
                "time_of_day": item.get("timeOfDay"),
                "x": round(pos["x"], 1),
                "y": round(pos["y"], 1),
                "z": round(pos["z"], 1),
                "ts": int(os.path.getmtime(src)),
                "published": False,               # ingest is automatic, exposure is not
                "aesthetic": aesthetic.get(image_id),
                "perspective": perspective_of(item.get("variant")),
                "fog": is_fog(image_id, depth),
            }
            if cluster:
                row.update({
                    "cluster_id": cluster["cluster_id"],
                    "cluster_rank": cluster.get("rank"),
                    "score": cluster.get("score"),
                    "label": label_for(cluster, names),
                    "kind": describe(cluster),
                    "footprint_m2": cluster.get("footprint_m2"),
                    "item_stands": cluster.get("item_stands", 0),
                    "shot_distance_m": round(dist, 1),
                    "pieces": cluster["pieces"],
                    "height_m": cluster["size_y"],
                    "region": cluster["region"],
                    "sky": cluster.get("sky", False),
                    "portals": cluster["portals"],
                    "beds": cluster["beds"],
                    "signs": cluster["signs"],
                    "builders": cluster["distinct_creators"],
                    "top_creator_id": cluster.get("top_creator_id"),
                })
                row.update(area_fields(areas, cluster))
            rows.append(row)

            if args.thumbs:
                try:
                    make_thumb(src, os.path.join(thumb_dir, image_id + ".webp"))
                except ImportError:
                    sys.exit("--thumbs needs Pillow: pip install pillow")
                except Exception as exc:
                    skipped.append((run, f"thumbnail failed for {still}: {exc}"))
            if args.large:
                try:
                    make_thumb(src, os.path.join(large_dir, image_id + ".webp"),
                               px=LARGE_PX, quality=80)
                except Exception as exc:
                    skipped.append((run, f"large render failed for {still}: {exc}"))
            if args.copy_full:
                shutil.copy2(src, os.path.join(img_dir, image_id + ".png"))

    # ---- automated orbit runs -------------------------------------------------
    orbit_n = 0
    def top_crop_for(run):
        """The bar is a per-run fact, so the crop has to be one too."""
        if not args.crop_top_ui_px:
            return 0
        if args.crop_top_from_run and (run or "") < args.crop_top_from_run:
            return 0
        return args.crop_top_ui_px

    for rec in read_orbit_receipts(args.receipts):
        run, fname = rec.get("run"), rec.get("file")
        if args.run and run not in args.run:
            continue
        if rec.get("skipped") and not args.keep_rejects:
            rejected.append((run, "-", rec["skipped"]))
            continue
        if not run or not fname:
            skipped.append((str(run), "receipt missing run or file"))
            continue
        src = os.path.join(args.orbit_captures, run, fname)
        if not os.path.exists(src):
            skipped.append((run, f"{fname} in receipts but not on disk"))
            continue
        why = is_reject(rec)
        if why and not args.keep_rejects:
            rejected.append((run, fname, why))
            continue
        cluster = by_id.get(rec.get("cluster_id"))
        image_id = f"{run}_{os.path.splitext(fname)[0]}"
        lens = rec.get("lens") or rec.get("placed") or {}
        row = {
            "id": image_id,
            "run": run,
            "variant": rec.get("shot"),
            "environment": rec.get("environment"),
            "time_of_day": rec.get("time_of_day"),
            "x": round(lens.get("x", 0.0), 1),
            "y": round(lens.get("y", 0.0), 1),
            "z": round(lens.get("z", 0.0), 1),
            "ts": int(os.path.getmtime(src)),
            "published": False,
            "aesthetic": aesthetic.get(image_id),
            "perspective": perspective_of(rec.get("shot")),
            "fog": is_fog(image_id, depth),
            "source": "orbit",
            # orbit-only provenance: enough to tell a bad frame from a bad plan
            "occluded": bool(rec.get("occluded")),
            "pieces_near_aim": rec.get("pieces_near_aim"),
            "lens_offset_m": rec.get("lens_offset_m"),
            # What was lit, and what was there to light. fires_found is the first
            # per-build light count this project has ever had: the scan cannot
            # produce one because scan_features.py's fire vocabulary was written
            # from the craftable build menu, but the camera was standing in the
            # room and counted the components. Kept on every row, held or not,
            # because "this build has 31 fires and we shot it dark" is exactly
            # the row worth finding later.
            "fires": bool(rec.get("fires")),
            "fires_found": rec.get("fires_found"),
            "fires_burning": rec.get("fires_burning"),
            "fires_wet": rec.get("fires_wet"),
            "fires_lit": rec.get("fires_lit"),
            "flash": rec.get("flash"),
            "flash_bearing_deg": rec.get("flash_bearing_deg"),
        }
        if cluster:
            # Exact, not nearest: this shot was planned for this structure.
            row.update({
                "cluster_id": cluster["cluster_id"],
                "cluster_rank": cluster.get("rank"),
                "score": cluster.get("score"),
                "label": label_for(cluster, names),
                "kind": describe(cluster),
                "footprint_m2": cluster.get("footprint_m2"),
                "item_stands": cluster.get("item_stands", 0),
                "pieces": cluster["pieces"],
                "height_m": cluster["size_y"],
                "region": cluster["region"],
                "sky": cluster.get("sky", False),
                "portals": cluster["portals"],
                "beds": cluster["beds"],
                "signs": cluster["signs"],
                "builders": cluster["distinct_creators"],
                "top_creator_id": cluster.get("top_creator_id"),
                "shot_distance_m": 0.0,
            })
            row.update(area_fields(areas, cluster))
        rows.append(row)
        orbit_n += 1

        if args.thumbs:
            try:
                make_thumb(src, os.path.join(thumb_dir, image_id + ".webp"),
                           crop_right_ui_px=args.crop_right_ui_px,
                           crop_top_ui_px=top_crop_for(run))
            except Exception as exc:
                skipped.append((run, f"thumbnail failed for {fname}: {exc}"))
        if args.large:
            try:
                make_thumb(src, os.path.join(large_dir, image_id + ".webp"),
                           px=LARGE_PX, quality=80,
                           crop_right_ui_px=args.crop_right_ui_px,
                           crop_top_ui_px=top_crop_for(run))
            except Exception as exc:
                skipped.append((run, f"large render failed for {fname}: {exc}"))
        if args.copy_full:
            shutil.copy2(src, os.path.join(img_dir, image_id + ".png"))

    # Iterating on the camera meant shooting the same three structures six times,
    # so they carry 36 frames each while everything else has 6 -- and sorting by
    # rank then fills the first page with one building. Most of those extras are
    # from superseded builds anyway: 200 m of haze, the wrong golden hour, the
    # occlusion check that only flagged. Keep the newest capture of each angle.
    #
    # The light is part of the angle. Superseding on (cluster, variant) alone
    # says a frame is a newer version of any earlier frame that happens to share
    # a slot name, and slot names are reused: orbit1..4 mean "the four bearings",
    # not "the four bearings at one time of day". On 2026-08-24 a deliberate
    # re-shoot of 30 builds at time 0.71 silently retired their 0.64 originals --
    # 150 frames, the best-photographing thirty in the gallery, replaced rather
    # than joined. Two photographs taken in different light are not versions of
    # each other, so environment and time belong in the identity.
    best = {}
    for r in rows:
        if r.get("source") != "orbit":
            continue
        key = supersede_key(r)
        if key not in best or r["ts"] > best[key]["ts"]:
            best[key] = r
    superseded = sum(1 for r in rows
                     if r.get("source") == "orbit"
                     and best.get(supersede_key(r)) is not r)
    rows = [r for r in rows
            if r.get("source") != "orbit"
            or best.get(supersede_key(r)) is r]
    if superseded:
        print(f"  {superseded} orbit frame(s) superseded by a later capture "
              f"of the same angle in the same light")

    derived_n = 0
    if args.derived and os.path.exists(args.derived):
        with open(args.derived, encoding="utf-8-sig") as fh:
            derived_specs = json.load(fh)
        if not isinstance(derived_specs, list):
            sys.exit("derived frame manifest must contain a JSON list")
        by_image_id = {row["id"]: row for row in rows}
        for spec in derived_specs:
            source_id = str(spec.get("source_id", ""))
            source = by_image_id.get(source_id)
            if source is None or source.get("source") != "orbit":
                sys.exit(f"derived frame source is not an accepted orbit capture: {source_id}")
            derived_id = str(spec.get("id") or f"{source_id}_detail")
            if derived_id in by_image_id:
                sys.exit(f"duplicate derived frame id: {derived_id}")
            source_path = os.path.join(
                args.orbit_captures,
                source["run"],
                f"{int(source['cluster_id']):04d}_{source['variant']}.png")
            if not os.path.exists(source_path):
                sys.exit(f"derived frame source image is missing: {source_path}")
            row = source.copy()
            row.update({
                "id": derived_id,
                "variant": str(spec.get("variant") or "detail"),
                "source": "derived",
                "derived_from": source_id,
                "perspective": "detail",
            })
            crop = float(spec.get("crop_fraction", 0.18))
            if args.thumbs:
                make_thumb(source_path, os.path.join(thumb_dir, derived_id + ".webp"),
                           crop_right_ui_px=args.crop_right_ui_px,
                           detail_crop_fraction=crop)
            if args.large:
                make_thumb(source_path, os.path.join(large_dir, derived_id + ".webp"),
                           px=LARGE_PX, quality=80,
                           crop_right_ui_px=args.crop_right_ui_px,
                           detail_crop_fraction=crop)
            rows.append(row)
            by_image_id[derived_id] = row
            derived_n += 1
        if derived_n:
            print(f"  {derived_n} explicit detail frame(s) derived from accepted orbit captures")

    rows.sort(key=lambda r: -r["ts"])
    orbit_n = sum(1 for row in rows if row.get("source") == "orbit")

    # A later orbit run can supersede an earlier angle. Keep the generated asset
    # directories aligned with the index so an archived era does not retain
    # unreferenced pilot or retry frames.
    retained_ids = {row["id"] for row in rows}
    pruned = 0
    for directory in (thumb_dir, large_dir, img_dir):
        if not os.path.isdir(directory):
            continue
        for filename in os.listdir(directory):
            path = os.path.join(directory, filename)
            if os.path.isfile(path) and os.path.splitext(filename)[0] not in retained_ids:
                os.remove(path)
                pruned += 1
    if pruned:
        print(f"  {pruned} superseded generated asset(s) pruned")

    def facet(key):
        return sorted({r[key] for r in rows if r.get(key) is not None})

    doc = {
        "generated": int(__import__("time").time()),
        "world": args.world or load_cluster_world(args.clusters),
        "n": len(rows),
        "runs": len({r["run"] for r in rows}),
        "joined": sum(1 for r in rows if "cluster_id" in r),
        "environments": facet("environment"),
        "flashes": facet("flash"),
        "regions": facet("region"),
        "variants": facet("variant"),
        "kinds": facet("kind"),
        "perspectives": facet("perspective"),
        "areas": facet("area_label"),
        "images": rows,
    }

    tmp = os.path.join(args.dest, "index.json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False)
    os.replace(tmp, os.path.join(args.dest, "index.json"))

    # The gallery side-loads the instrument files when they exist. Both are
    # metric/reason-only — no coordinates, no creator ids — safe to serve.
    for side in (args.depth, os.path.join(os.path.dirname(args.depth), "judge.json")):
        destination = os.path.join(args.dest, os.path.basename(side))
        if os.path.exists(side):
            shutil.copy2(side, destination)
        elif os.path.exists(destination):
            os.remove(destination)

    print(f"  {len(rows):,} images across {doc['runs']} runs -> {args.dest}")
    fog_n = sum(1 for r in rows if r.get("fog"))
    if fog_n:
        print(f"  {fog_n} frame(s) flagged as fog whiteouts (hidden by default in the gallery)")
    if orbit_n:
        occ = sum(1 for r in rows if r.get("source") == "orbit" and r.get("occluded"))
        print(f"  {orbit_n:,} from automated orbit runs ({occ} flagged occluded)")
    if derived_n:
        print(f"  {derived_n:,} explicit derived detail frame(s)")
    print(f"  {doc['joined']:,} joined to a structure "
          f"({len(rows) - doc['joined']:,} without metadata)")
    if unjoined:
        print(f"  {unjoined} run(s) had no cluster within {args.max_join_m:g} m")
    if rejected:
        from collections import Counter
        why = Counter(w for _, _, w in rejected)
        print(f"  {len(rejected)} frame(s) excluded as failed captures:")
        for w, c in why.most_common():
            print(f"      {c:>4}  {w}")
    if skipped:
        # Loud on purpose: build_index.py swallows these, and a contributor's whole
        # drop can disappear without a word.
        print(f"  ! skipped {len(skipped)} item(s):")
        for run, why in skipped[:12]:
            print(f"      {run}: {why}")
        if len(skipped) > 12:
            print(f"      ... and {len(skipped) - 12} more")


if __name__ == "__main__":
    main()
