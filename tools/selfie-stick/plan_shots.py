#!/usr/bin/env python3
"""Place cameras around each structure from its geometry, so nobody has to fly.

A human flying the camera pays most of the cost in *moving*, so the sensible trade
was 23 frames of one viewpoint varying only the light. Automated, that is backwards:
the camera can be anywhere instantly, and six photographs from six angles say far
more about a building than twenty-three of one wall.

So: six shots per structure — four orbit angles plus two light variants. When the
coordinate artifact from export_cluster_points.py is present, framing is solved
against every BUILDING ZDO in camera space: projected width, projected height, and
front-to-back depth all contribute. The old cluster bounding box remains the fallback.

No terrain data is needed. Valheim generates terrain from the world seed and the
save holds only objects, so no offline heightmap exists. But a cluster's min_y is
effectively ground at that build, because its lowest foundation piece rests on it.
Only the in-game runner needs a real ground query, to clamp a camera that would
otherwise land inside a hillside.

Usage:
  python plan_shots.py [--clusters out/clusters.json] [--out out/shotplan.json]
                       [--cluster-points cluster-zdos.parquet]
                       [--top N] [--region in-world] [--elevation 40]
                       [--max-distance 200]
"""
import argparse
import json
import math
import os
import sys

# Valheim's vertical field of view. Framing math is in vertical FOV because the
# window is 16:9 and height is the binding constraint for a tall build.
FOV_V_DEG = 65.0
ASPECT = 16.0 / 9.0
FOV_H_DEG = math.degrees(
    2.0 * math.atan(math.tan(math.radians(FOV_V_DEG / 2.0)) * ASPECT))

# Measured golden hours, taken from the 207-frame sweep rather than assumed. The
# first version of this planner used 0.70 and 0.30 because they *sound* like golden
# hour; the measurements say both sit past the good light:
#
#     time   luminance   contrast
#     0.29        74.9      105.2   <- the old dawn value, already falling off
#     0.32       121.5      157.4
#     0.64       121.6      159.8   <- peak contrast in the whole sweep
#     0.67       118.8      153.7
#     0.70        83.1      118.2   <- the old orbit value, 26% less contrast
#
# The falloff either side of midday is steep, so being 0.03 late costs a lot.
GOLDEN_PM = 0.64
GOLDEN_AM = 0.32
# The sixth slot: same hero framing, different sky. Misty was the original
# choice and remains the default so old plans reproduce, but it is a parameter
# now — measured across series one it cost 0.65 aesthetic against every Clear
# variant while scoring BETTER on every depth metric, so what belongs in this
# slot is an open question that only an A/B answers.
WEATHER_ALT = ("Misty", 0.66)

# The storm slot. ThunderStorm is the best-scoring condition this project has
# measured -- indoors, where it beats sunset, sunrise and night. Outdoors it has
# never been shot at all: every one of the 300 ThunderStorm receipts in 4,536 is
# an interior. The exterior claim "weather is worth having inside and not
# outside" came from comparing Clear against Misty, so exterior storm is
# untested here rather than tested and lost.
#
# 0.58 is not a measured optimum. It is the only storm time this project has
# ever used, which makes new exterior frames directly comparable to the 300
# interiors instead of being a second unknown.
STORM = ("ThunderStorm", 0.58)

# Off-axis, so a driven flash rakes across the build instead of backlighting it
# into a silhouette. Negative is anticlockwise from the camera-to-subject line.
STORM_FLASH_BEARING = -35.0


def validate_tsv(path):
    """Re-read the TSV the way the mod's LoadShotPlan does: split on tabs, drop
    short lines, parse floats. A row this check drops is a row the mod drops.

    Worth having from the moment this file started writing an empty mode column
    at index 13 to keep fires and flash at 14 and 15. The mod scrapes positionally
    and skips only on len < 12, so a column in the wrong place is not an error
    anywhere -- it is a run that shoots the right places in the wrong light."""
    ok, bad = 0, 0
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            fields = line.split("\t")
            if len(fields) < 12:
                bad += 1
                continue
            try:
                int(fields[0])
                for i in (2, 3, 4, 5, 6, 8, 9, 10, 11):
                    float(fields[i])
                if len(fields) > 14:
                    assert fields[14] in ("0", "1")
                if len(fields) > 15 and fields[15]:
                    float(fields[15])
                ok += 1
            except (ValueError, AssertionError):
                bad += 1
    return ok, bad


def parse_args():
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--clusters", default=os.path.join(here, "out", "clusters.json"))
    p.add_argument("--cluster-points", default="",
                   help="cluster-zdos.parquet from export_cluster_points.py. If omitted, "
                        "use that filename beside clusters.json when present; otherwise "
                        "retain bounding-box framing")
    p.add_argument("--names", default=os.path.join(here, "out", "cluster-names.json"))
    p.add_argument("--out", default=os.path.join(here, "out", "shotplan.json"))
    p.add_argument("--region", default="in-world", choices=["all", "in-world", "outland"])
    p.add_argument("--top", type=int, default=0, help="only the top N by score")
    p.add_argument("--skip", type=int, default=0,
                   help="skip the first N by score, for shooting the next band down")
    p.add_argument("--elevation", type=float, default=40.0,
                   help="camera elevation above the horizontal, degrees (default 40)")
    p.add_argument("--margin", type=float, default=1.15,
                   help="frame headroom so landscape is in shot as well as building")
    p.add_argument("--max-distance", type=float, default=120.0,
                   help="haze cap. Beyond this the frame fills with atmosphere and the "
                        "build reads as a flat silhouette; better to shoot part of a big "
                        "build up close than all of it through 400 m of fog")
    p.add_argument("--aim-height", type=float, default=0.5,
                   help="where in the build's height to aim, 0 = foundations, "
                        "1 = ridge (default 0.5, the middle of the box). Looking "
                        "down at a build, the middle of its box is inside it and "
                        "the sight line is blocked by its own roof")
    p.add_argument("--fixed-elevation", action="store_true",
                   help="use --elevation as given instead of tilting by shape. "
                        "elevation_for() levels off on tall builds because "
                        "shooting a spire from above gives you a roof -- correct "
                        "on the ground, backwards for a platform floating at "
                        "y=5000 where the alternative to aiming down is open sky")
    p.add_argument("--time-of-day", type=float, default=GOLDEN_PM,
                   help="time for the four orbit slots (default the measured golden "
                        "hour). The dawn slot keeps its own value -- it exists to be "
                        "a second light, not to follow this one")
    p.add_argument("--max-height-m", type=float, default=300.0,
                   help="drop clusters taller than this. Not a taste call: the "
                        "clustering chains a sky platform to ground builds through a "
                        "vertical column and calls the result one structure. Era 17 "
                        "has three over 1,300 m tall, one of them 2,297 m with a "
                        "5,195 m diagonal, and aiming a camera at that centroid puts "
                        "it in empty air. The tallest real build measured is 177.9 m")
    p.add_argument("--cluster-ids", default="",
                   help="comma-separated cluster ids to shoot and nothing else "
                        "(overrides --top/--skip). Same name and same meaning as "
                        "plan_interiors.py's flag; --include-ids is the additive "
                        "one, which is not what a re-shoot of a known set wants")
    p.add_argument("--include-ids", default="",
                   help="comma-separated cluster ids to shoot regardless of "
                        "--skip/--top, for structures worth a camera that the "
                        "ranking heuristic does not reach")
    p.add_argument("--exclude-sky", action="store_true",
                   help="drop clusters scan_clusters marked sky=true. A build "
                        "floating with no terrain under it blows out against the "
                        "sky from every bearing -- measured on Era 17 rank 63, "
                        "whose six frames scored 3.88-4.31 against a band median "
                        "of 5.61 and are a white mass in blue. Shoot them with a "
                        "plan that puts the ground in frame, not this one")
    p.add_argument("--alt-shots", type=int, default=1, choices=[0, 1],
                   help="0 drops the sixth (alternate-light) shot. Measured on "
                        "Era 17 ranks 81-120: whatever sky goes in that slot it "
                        "is the worst frame of the six -- sunset 0.71 medians "
                        "5.335, Misty 0.66 medians 5.021, night 0.90 medians "
                        "4.792, against 5.636 for the five golden-hour slots. "
                        "Dropping it buys 20%% more structures per hour")
    p.add_argument("--fires", action="store_true",
                   help="hold the builders' fires lit for every frame. A capture "
                        "world copy loads with every hearth burned to zero, so "
                        "without this the lighting a build was designed around is "
                        "simply not in the picture")
    p.add_argument("--storm-shots", type=int, default=0, choices=(0, 1, 2, 3),
                   help="storm frames on the hero framing: 1 = fires held, "
                        "2 = plus an unlit control, 3 = plus a flash-lit frame")
    p.add_argument("--storm-only", action="store_true",
                   help="emit the storm slots and nothing else. For a re-shoot of "
                        "builds that already have their golden and twilight frames "
                        "on disk, where another four orbits would be film spent "
                        "reproducing what is already in the gallery")
    p.add_argument("--storm-environment", default=STORM[0])
    p.add_argument("--storm-time", type=float, default=STORM[1])
    p.add_argument("--flash-bearing", type=float, default=STORM_FLASH_BEARING,
                   help="degrees off the camera-to-subject line to place the strike")
    p.add_argument("--alt-environment", default=WEATHER_ALT[0],
                   help="environment for the sixth (alternate-light) shot")
    p.add_argument("--alt-time", type=float, default=WEATHER_ALT[1],
                   help="time of day for the sixth (alternate-light) shot")
    p.add_argument("--min-clearance", type=float, default=3.0,
                   help="metres the camera must stay above the lowest foundation piece")
    return p.parse_args()


def orbit_azimuths(size_x, size_z):
    """Four compass bearings, offset 45 deg from the structure's long axis.

    Dead-on the narrow face of a long building is the least informative angle there
    is — you see a gable and nothing else. Offsetting by 45 puts every shot on a
    corner, showing a long face and a short one together.
    """
    long_axis_is_x = size_x >= size_z
    base = 0.0 if long_axis_is_x else 90.0
    return [(base + 45.0 + i * 90.0) % 360.0 for i in range(4)], long_axis_is_x


def load_cluster_points(path, clusters, cluster_doc):
    """Load exact frozen-cluster ZDO positions and reject crossed-era artifacts."""
    import duckdb

    if not clusters:
        return {}
    parquet = path.replace("'", "''").replace("\\", "/")
    con = duckdb.connect()
    con.execute(f"CREATE TEMP VIEW point_source AS SELECT * FROM read_parquet('{parquet}')")
    columns = {row[1] for row in con.execute("PRAGMA table_info('point_source')").fetchall()}
    required = {"snapshot_id", "world_id", "cluster_id", "zdo_index", "x", "y", "z"}
    missing = sorted(required - columns)
    if missing:
        con.close()
        sys.exit(f"cluster point artifact is missing: {', '.join(missing)}")

    metadata = con.execute(
        "SELECT DISTINCT snapshot_id, world_id FROM point_source ORDER BY snapshot_id, world_id"
    ).fetchall()
    expected = (cluster_doc.get("snapshot_id"), cluster_doc.get("world_id"))
    if len(metadata) != 1 or metadata[0] != expected:
        con.close()
        sys.exit(f"cluster point artifact belongs to {metadata}, but clusters.json is {expected}")

    con.execute("CREATE TEMP TABLE wanted_cluster (cluster_id BIGINT, pieces BIGINT)")
    con.executemany("INSERT INTO wanted_cluster VALUES (?, ?)",
                    [(int(c["cluster_id"]), int(c["pieces"])) for c in clusters])
    mismatches = con.execute("""
        SELECT w.cluster_id, w.pieces, count(p.zdo_index) AS actual
        FROM wanted_cluster w
        LEFT JOIN point_source p USING (cluster_id)
        GROUP BY w.cluster_id, w.pieces
        HAVING count(p.zdo_index) != w.pieces
        ORDER BY w.cluster_id
        """).fetchall()
    if mismatches:
        con.close()
        first = mismatches[0]
        sys.exit("cluster point membership does not match frozen clusters.json: "
                 f"cluster {first[0]} expected {first[1]}, found {first[2]} "
                 f"({len(mismatches)} mismatch(es))")

    rows = con.execute("""
        SELECT p.cluster_id, p.x, p.y, p.z
        FROM point_source p
        JOIN wanted_cluster w USING (cluster_id)
        ORDER BY p.cluster_id, p.zdo_index
        """).fetchall()
    con.close()
    points = {int(c["cluster_id"]): [] for c in clusters}
    for cid, x, y, z in rows:
        xyz = (float(x), float(y), float(z))
        if not all(math.isfinite(v) for v in xyz):
            sys.exit(f"cluster point artifact has a non-finite coordinate in cluster {cid}")
        points[int(cid)].append(xyz)
    return points


def framing_from_points(points, aim, azimuth_deg, elevation_deg, margin):
    """Solve camera distance against every ZDO in camera space.

    For point i, distance D must leave enough forward room for both its horizontal
    and vertical angular offsets.  ``depth_i`` is the term the old axis-aligned
    bounding-box calculation omitted: points on the camera-facing side consume
    camera distance even when width and height stay unchanged.
    """
    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)
    sin_a, cos_a = math.sin(az), math.cos(az)
    sin_e, cos_e = math.sin(el), math.cos(el)

    # Camera sits from aim along back; right/up span its image plane.
    back = (sin_a * cos_e, sin_e, cos_a * cos_e)
    right = (cos_a, 0.0, -sin_a)
    up = (-sin_a * sin_e, cos_e, -cos_a * sin_e)  # back x right
    tan_h = math.tan(math.radians(FOV_H_DEG / 2.0))
    tan_v = math.tan(math.radians(FOV_V_DEG / 2.0))

    right_values, up_values, depth_values, ys = [], [], [], []
    ideal = 0.0
    ax, ay, az0 = aim
    for x, y, z in points:
        rel = (x - ax, y - ay, z - az0)
        image_x = sum(rel[i] * right[i] for i in range(3))
        image_y = sum(rel[i] * up[i] for i in range(3))
        depth = sum(rel[i] * back[i] for i in range(3))
        right_values.append(image_x)
        up_values.append(image_y)
        depth_values.append(depth)
        ys.append(y)
        ideal = max(ideal, depth + margin * max(abs(image_x) / tan_h,
                                                abs(image_y) / tan_v))

    # Keep the prior planner's 8 m minimum subject size for tiny point sets.
    ideal = max(ideal, margin * 4.0 / tan_v)
    return {
        "ideal_distance_m": ideal,
        "world_height_m": max(ys) - min(ys),
        "projected_width_m": max(right_values) - min(right_values),
        "projected_height_m": max(up_values) - min(up_values),
        "depth_m": max(depth_values) - min(depth_values),
    }


def elevation_for(cluster, default_deg):
    """A tower and a plaza want opposite camera heights.

    Shooting a 100 m spire from 40 deg up gives you a roof. Shooting a flat sprawling
    settlement from 15 deg gives you a fence. So tilt down on flat things and level
    off on tall ones, from the height-to-width ratio.
    """
    width = max(cluster["size_x"], cluster["size_z"], 1.0)
    ratio = cluster["size_y"] / width
    return max(18.0, min(default_deg, default_deg - 60.0 * ratio))


def camera_for(cluster, azimuth_deg, elevation_deg, margin, max_distance, clearance,
               aim_height=0.5, points=None):
    """Where to stand, and where to look, to frame this structure from one bearing."""
    cx, cz = cluster["center_x"], cluster["center_z"]
    # Aim at the middle of the box vertically, not the median piece height: a tower's
    # mass sits above its median, and aiming low tips the whole build out of frame.
    #
    # aim_height moves that point through the build's height, 0 = the foundations
    # and 1 = the ridge. The default 0.5 is right for a camera coming in from the
    # side, and wrong for one looking down: the mid-height of the box is INSIDE the
    # structure, so a steep sight line hits the roof before it arrives and the
    # occlusion probe reports blocked every single time. Era 17's sky platforms
    # came back 76% occluded at 22 degrees and 100% at 65 for exactly that reason.
    cy = cluster["min_y"] + (cluster["max_y"] - cluster["min_y"]) * aim_height

    # The point path solves the field-of-view inequalities against every ZDO, including
    # each point's camera-axis depth. The fallback retains the measured compact-extent
    # heuristic; framing on the full diagonal pushed Dragon's Den 267 m into haze.
    geometry = None
    if points:
        geometry = framing_from_points(
            points, (cx, cy, cz), azimuth_deg, elevation_deg, margin)
        ideal = geometry["ideal_distance_m"]
    else:
        subject = max(cluster["size_y"],
                      min(cluster["size_x"], cluster["size_z"]),
                      8.0)
        ideal = (subject / 2.0) / math.tan(math.radians(FOV_V_DEG / 2.0)) * margin
    distance = min(ideal, max_distance)
    fits = ideal <= max_distance

    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    horiz = distance * math.cos(el)
    x = cx + horiz * math.sin(az)
    z = cz + horiz * math.cos(az)
    y = cy + distance * math.sin(el)
    y = max(y, cluster["min_y"] + clearance)

    # Look back at the aim point. Unity is Y-up, Z-forward, and its x-euler is
    # positive looking DOWN — so pitch is the negated arcsine of the unit
    # direction's y, not its arctangent. The camera is always above the aim point
    # here, so a correct pitch is always positive.
    dx, dy, dz = cx - x, cy - y, cz - z
    n = math.sqrt(dx * dx + dy * dy + dz * dz) or 1.0
    yaw = math.degrees(math.atan2(dx, dz)) % 360.0
    pitch = math.degrees(-math.asin(max(-1.0, min(1.0, dy / n))))

    result = {
        "azimuth_deg": round(azimuth_deg, 1),
        "camera": {"x": round(x, 1), "y": round(y, 1), "z": round(z, 1)},
        "aim": {"x": round(cx, 1), "y": round(cy, 1), "z": round(cz, 1)},
        "yaw_deg": round(yaw, 2),
        "pitch_deg": round(pitch, 2),       # Unity convention: positive looks down
        "distance_m": round(distance, 1),
        "elevation_deg": round(elevation_deg, 1),
        "frames_whole_build": fits,
    }
    if geometry:
        result.update({
            "geometry_source": "zdo_xyz",
            "geometry_points": len(points),
            "zdo_height_m": round(geometry["world_height_m"], 1),
            "zdo_projected_width_m": round(geometry["projected_width_m"], 1),
            "zdo_projected_height_m": round(geometry["projected_height_m"], 1),
            "zdo_depth_m": round(geometry["depth_m"], 1),
        })
    else:
        result["geometry_source"] = "cluster_bbox"
    return result


def main():
    args = parse_args()
    if not os.path.exists(args.clusters):
        sys.exit(f"no clusters at {args.clusters} — run scan_clusters.py first")
    with open(args.clusters, encoding="utf-8") as fh:
        doc = json.load(fh)
    names = {}
    if os.path.exists(args.names):
        with open(args.names, encoding="utf-8") as fh:
            names = json.load(fh)

    clusters = [c for c in doc["clusters"]
                if args.region == "all" or c["region"] == args.region]
    clusters.sort(key=lambda c: -c["score"])
    # Before --skip/--top, so excluding sky builds does not silently shift the
    # band: rank N means the same structure whether or not the flag is passed.
    dropped_sky = [c for c in clusters if args.exclude_sky and c.get("sky")]
    if args.cluster_ids:
        wanted = [int(s) for s in args.cluster_ids.split(",") if s.strip()]
        by_cid = {c["cluster_id"]: c for c in clusters}
        missing = [cid for cid in wanted if cid not in by_cid]
        if missing:
            sys.exit(f"--cluster-ids {missing} not in {args.clusters} "
                     f"(wrong era? cluster ids are not stable across eras)")
        clusters = [by_cid[cid] for cid in wanted]
    if args.skip:
        clusters = clusters[args.skip:]
    if args.top:
        clusters = clusters[: args.top]
    want = {int(i) for i in args.include_ids.split(",") if i.strip()}
    if want:
        have = {c["cluster_id"] for c in clusters}
        by_id = {c["cluster_id"]: c for c in doc["clusters"]}
        for cid in sorted(want - have):
            if cid not in by_id:
                sys.exit(f"--include-ids {cid} is not a known cluster")
            clusters.append(by_id[cid])
    if args.exclude_sky:
        skipped_here = [c["cluster_id"] for c in clusters if c.get("sky")]
        clusters = [c for c in clusters if not c.get("sky")]
        if skipped_here:
            print(f"  sky builds dropped from this band: "
                  f"{', '.join(str(i) for i in skipped_here)} "
                  f"({len(dropped_sky)} in the region overall)")

    # Last, AFTER --include-ids: a 2 km column is not a structure, and no flag
    # should be able to force a camera to aim at the centroid of one. Placed
    # before the include step this guard passed --include-ids "2,68" straight
    # through and planned fifteen shots of two vertical chains. Loud, because a
    # silent skip is how you spend an afternoon wondering where a cluster went.
    if args.max_height_m:
        broken = [c for c in clusters if c["size_y"] > args.max_height_m]
        if broken:
            clusters = [c for c in clusters if c["size_y"] <= args.max_height_m]
            print(f"  dropped {len(broken)} cluster(s) taller than "
                  f"{args.max_height_m:g} m -- union-find chained a sky platform "
                  f"to the ground through a column; these are not buildings:")
            for c in sorted(broken, key=lambda c: -c["size_y"]):
                print(f"    cluster {c['cluster_id']}: {c['size_y']:,.0f} m tall, "
                      f"{c['diagonal_m']:,.0f} m diagonal, {c['pieces']:,} pieces")

    point_path = args.cluster_points
    if not point_path:
        candidate = os.path.join(os.path.dirname(os.path.abspath(args.clusters)),
                                 "cluster-zdos.parquet")
        if os.path.isfile(candidate):
            point_path = candidate
    if args.cluster_points and not os.path.isfile(args.cluster_points):
        sys.exit(f"cluster point artifact not found: {args.cluster_points}")
    points_by_cluster = {}
    if point_path:
        print(f"  loading exact per-ZDO x/y/z from {point_path}", flush=True)
        points_by_cluster = load_cluster_points(point_path, clusters, doc)
        print(f"  {sum(len(v) for v in points_by_cluster.values()):,} points across "
              f"{len(points_by_cluster):,} selected structures", flush=True)

    shots, clipped, duplicates = [], 0, []
    for c in clusters:
        points = points_by_cluster.get(c["cluster_id"])
        azimuths, long_x = orbit_azimuths(c["size_x"], c["size_z"])
        elev = args.elevation if args.fixed_elevation else elevation_for(c, args.elevation)
        cams = [camera_for(c, a, elev, args.margin, args.max_distance,
                           args.min_clearance, args.aim_height, points) for a in azimuths]
        if not cams[0]["frames_whole_build"]:
            clipped += 1

        # With points, broadest is measured in the actual camera plane. The fallback
        # keeps the bbox rule: looking along the short axis shows the long face.
        hero = (max(range(len(cams)), key=lambda i: cams[i]["zdo_projected_width_m"])
                if points else (0 if long_x else 1))

        label = names.get(str(c["cluster_id"])) or f"cluster {c['cluster_id']}"
        base = {"cluster_id": c["cluster_id"], "label": label,
                "pieces": c["pieces"], "height_m": c["size_y"], "region": c["region"]}

        # A frame is distinct if any of these differ. The dawn and weather slots
        # re-use the hero camera and only change the light, so when a plan is
        # already being shot at that light they stop being a second light and
        # become a second request for the same photograph. On the sky re-shoot of
        # 2026-08-24 -- --time-of-day 0.32, which is the value the dawn slot
        # hardcodes -- that hit 14 of 14 structures.
        #
        # What comes back is NOT 14 identical files, and it is worth knowing why
        # before trusting this guard for more than it does. Valheim's sky moves
        # between shots: of those 14 pairs only 2 matched (mean |difference|
        # 0.008 and 0.160 luma out of 255), 2 more landed within 2.2, and the
        # remaining 10 ranged from 3.5 to 50.8. So the slot is not wasted film so
        # much as a re-roll of the cloud position wearing a lighting variant's
        # name. Drop it, and ask for the light you actually wanted.
        def distinct(shot):
            cam = shot["camera"]
            key = (cam["x"], cam["y"], cam["z"],
                   round(shot["yaw_deg"], 1), round(shot["pitch_deg"], 1),
                   shot["environment"], round(shot["time_of_day"], 3),
                   shot.get("fires", False), shot.get("flash"))
            if key in seen:
                duplicates.append((c["cluster_id"], shot["shot"], seen[key]))
                return False
            seen[key] = shot["shot"]
            return True

        seen = {}
        if not args.storm_only:
            for i, cam in enumerate(cams):
                shot = {**base, "shot": f"orbit{i + 1}", **cam,
                        "environment": "Clear", "time_of_day": args.time_of_day,
                        "fires": args.fires, "flash": None}
                if distinct(shot):
                    shots.append(shot)
            dawn = {**base, "shot": "dawn", **cams[hero],
                    "environment": "Clear", "time_of_day": GOLDEN_AM,
                    "fires": args.fires, "flash": None}
            if distinct(dawn):
                shots.append(dawn)

        # Storm as an A/B rather than a frame. "storm" is the one worth having;
        # "storm_dark" is the control that says whether holding the fires did
        # anything, and without it a good storm frame only proves storms are
        # pretty. "storm_flash" is the third question and the one that can come
        # back empty -- if the strike turns out to be a sky element carrying no
        # light, the receipt says sky_only and that is the answer.
        storm_slots = [
            ("storm", True, None),
            ("storm_dark", False, None),
            ("storm_flash", True, args.flash_bearing),
        ][:args.storm_shots]
        for name, fires, flash in storm_slots:
            shot = {**base, "shot": name, **cams[hero],
                    "environment": args.storm_environment,
                    "time_of_day": args.storm_time,
                    "fires": fires, "flash": flash}
            if distinct(shot):
                shots.append(shot)
        # Kept named "weather" whatever the sky is: the index supersedes on
        # (cluster, variant), so renaming the slot would orphan the frame it
        # is meant to replace rather than retire it.
        if args.alt_shots and not args.storm_only:
            weather = {**base, "shot": "weather", **cams[hero],
                       "environment": args.alt_environment,
                       "time_of_day": args.alt_time,
                       "fires": args.fires, "flash": None}
            if distinct(weather):
                shots.append(weather)

    if duplicates:
        by_slot = {}
        for _, slot, same_as in duplicates:
            by_slot[(slot, same_as)] = by_slot.get((slot, same_as), 0) + 1
        print(f"  dropped {len(duplicates)} duplicate frame(s) -- same camera, same light:")
        for (slot, same_as), n in sorted(by_slot.items()):
            print(f"    {slot} was identical to {same_as} on {n} structure(s)")

    out = {
        "generated_from": "plan_shots.py",
        "world": doc.get("world"),
        "structures": len(clusters),
        "shots": len(shots),
        "settings": {"elevation_deg": args.elevation, "fov_v_deg": FOV_V_DEG,
                     "margin": args.margin, "max_distance_m": args.max_distance,
                     "min_clearance_m": args.min_clearance,
                     "aim_height": args.aim_height,
                     "time_of_day": args.time_of_day,
                     "max_height_m": args.max_height_m,
                     "alt_shots": args.alt_shots,
                     "alt_environment": args.alt_environment,
                     "alt_time_of_day": args.alt_time,
                     "fires": args.fires,
                     "storm_only": args.storm_only,
                     "storm_shots": args.storm_shots,
                     "storm_environment": args.storm_environment,
                     "storm_time_of_day": args.storm_time,
                     "flash_bearing_deg": args.flash_bearing},
        "plan": shots,
    }
    out["settings"]["cluster_points"] = os.path.abspath(point_path) if point_path else None
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
    os.replace(tmp, args.out)

    # The mod reads this, not the JSON. It has no JSON parser — it scrapes with
    # regex — and one flat line per shot is far harder to misparse than nested
    # objects. Same data, ordered, comment lines start with '#'.
    tsv = os.path.splitext(args.out)[0] + ".tsv"
    with open(tsv + ".tmp", "w", encoding="utf-8", newline="\n") as fh:
        fh.write("# cluster_id\tshot\tcam_x\tcam_y\tcam_z\tyaw\tpitch\tenv\ttime\t"
                 "aim_x\taim_y\taim_z\tlabel\tmode\tfires\tflash\n")
        for s in shots:
            c, a = s["camera"], s["aim"]
            flash = "" if s.get("flash") is None else f"{s['flash']:g}"
            fh.write(f"{s['cluster_id']}\t{s['shot']}\t{c['x']}\t{c['y']}\t{c['z']}\t"
                     f"{s['yaw_deg']}\t{s['pitch_deg']}\t{s['environment']}\t"
                     f"{s['time_of_day']}\t{a['x']}\t{a['y']}\t{a['z']}\t"
                     f"{s['label'].replace(chr(9), ' ')}\t"
                     f"\t{1 if s.get('fires') else 0}\t{flash}\n")
    os.replace(tsv + ".tmp", tsv)

    print(f"  {len(clusters)} structures -> {len(shots)} shots")
    print(f"  {args.out}")
    print(f"  {tsv}  (this is the one the mod reads)")
    ok, bad = validate_tsv(tsv)
    print(f"  TSV validation: {ok} row(s) parse the way LoadShotPlan parses, "
          f"{bad} would drop")
    if args.fires or args.storm_shots:
        held = sum(1 for s in shots if s.get("fires"))
        lit = sum(1 for s in shots if s.get("flash") is not None)
        print(f"  light: {held} frame(s) hold the builders' fires, {lit} drive a flash")
    if clipped:
        print(f"  {clipped} structure(s) too big to frame whole inside the "
              f"{args.max_distance:g} m haze cap — shot closer, partial frame")


if __name__ == "__main__":
    main()
