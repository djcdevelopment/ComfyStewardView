#!/usr/bin/env python3
"""Place cameras inside each structure: the hall, the top room, a chair, the
gate, the courtyard — then rotate the light through sunrise, sunset, a clear
starry night, and a thunderstorm.

The orbit planner frames a building from its bounding box; this one composes
from what scan_features.py found inside that box. Five vantages, each derived
from real furniture and geometry, each skipped loudly when a build lacks the
ingredients (a tower with no chairs gets no seat shot — better a gap that says
why than a camera in a wall).

Two conventions carried over from plan_shots.py, one deliberately different:
  - yaw is clockwise from +Z, pitch is -asin(dy/n) (Unity: positive looks DOWN);
  - the TSV camera position is the PLAYER's feet, and the lens sits ~1.5 m
    above them. At orbit distances that offset is noise; across a 5 m room it
    is most of the composition, so all aim angles here are computed from the
    LENS position, not the feet.

Light: the exterior planner's 0.33-0.77 time-of-day band was measured on
facades in open air and does not bind here. Sunrise/sunset sit deliberately
past the exterior falloff (low sun through a window IS the shot), and night is
the whole point — interiors carry their own hearth light. Storm stays at the
proven mid-day value so rooms keep some ambient.

Every row carries mode=interior in a 14th TSV column. Old mod builds ignore it
(they read 13 fields); the current build relaxes the ground clamp to +0.2 m and
skips occlusion-recovery repositioning, which exists to escape foliage and
would otherwise "rescue" an indoor camera through the roof.

Usage:
  python plan_interiors.py [--features out/features.json] [--top 25]
                           [--cluster-ids 439,71,407] [--out out/interiorplan.json]
"""
import argparse
import json
import math
import os
import sys

# Measured on the pilot run, not assumed: the first-person lens sits ~1.8 m
# above the player's origin at level pitch (receipts showed 1.78-1.86 standing,
# drifting to ~2.0 as pitch leaves level).
LENS_OFFSET = 1.8        # metres from player origin to the first-person lens
EYE_STAND = 1.7          # lens height above a floor when standing
EYE_SEAT = 1.4           # lens height above a chair's pivot when seated
SEAT_NUDGE = 0.35        # metres from the seat toward the aim: clear of the
                         # backrest. The pilot placed the lens inside throne
                         # colliders and the game's camera-collision shoved it
                         # 10-17 m into the air; 0.7 then overshot into the
                         # table edge, so just enough to clear the chair.
CONDITIONS = [           # condition-major per cluster, storm last:
    ("sunrise", "Clear", 0.29),         # one weather crossfade per cluster
    ("sunset", "Clear", 0.71),
    ("night", "Clear", 0.90),
    ("storm", "ThunderStorm", 0.58),
]
# Sunrise/sunset sit just past the exterior golden band on purpose (low light
# through openings is the shot) but the pilot's 0.27/0.73 were dark across the
# board and 0.97 was black even outdoors; 0.29/0.71/0.90 keep the mood with a
# fighting chance of reading. Bracket further only from real frames.


def parse_args():
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--features", default=os.path.join(here, "out", "features.json"))
    p.add_argument("--clusters", default=os.path.join(here, "out", "clusters.json"))
    p.add_argument("--names", default=os.path.join(here, "out", "cluster-names.json"))
    p.add_argument("--out", default=os.path.join(here, "out", "interiorplan.json"))
    p.add_argument("--top", type=int, default=25, help="top N clusters by score")
    p.add_argument("--cluster-ids", default="",
                   help="comma-separated cluster ids (overrides --top)")
    p.add_argument("--vantages", default="",
                   help="comma-separated subset (hall,toproom,seat,gate,court) "
                        "for surgical retakes; the index keeps the newest frame "
                        "per (cluster, variant) so retunes supersede cleanly")
    p.add_argument("--region", default="in-world", choices=["all", "in-world", "outland"])
    p.add_argument("--fires", action="store_true",
                   help="hold the builders' fires lit for every frame. This lane "
                        "exists because interiors carry their own hearth light -- "
                        "but a capture world copy loads with every hearth burned to "
                        "zero, so until now that light was never actually in frame")
    p.add_argument("--max-los", type=int, default=10,
                   help="drop a vantage whose sight line clips walls this many "
                        "times or more (0 disables). Measured over 312 first-person "
                        "frames: los 0 medians 5.222 aesthetic, los 10+ medians "
                        "4.502. Not a ranker -- the middle of the range is noise -- "
                        "but the tail is real, and the tail is a wall")
    return p.parse_args()


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def look(lens, aim):
    """Yaw/pitch from the lens to the aim point, plan_shots.py conventions."""
    dx, dy, dz = aim[0] - lens[0], aim[1] - lens[1], aim[2] - lens[2]
    n = math.sqrt(dx * dx + dy * dy + dz * dz) or 1.0
    yaw = math.degrees(math.atan2(dx, dz)) % 360.0
    pitch = math.degrees(-math.asin(clamp(dy / n, -1.0, 1.0)))
    return round(yaw, 2), round(pitch, 2), n


def rect_corners(b):
    return [(b["min_x"], b["min_z"]), (b["min_x"], b["max_z"]),
            (b["max_x"], b["min_z"]), (b["max_x"], b["max_z"])]


def in_rect(x, z, b, pad=0.0):
    return (b["min_x"] - pad <= x <= b["max_x"] + pad
            and b["min_z"] - pad <= z <= b["max_z"] + pad)


def in_band(pt, b, y_lo=-2.0, y_hi=2.0, pad=2.0):
    return in_rect(pt["x"], pt["z"], b, pad) and y_lo <= pt["y"] - b["y"] <= y_hi


def centroid(pts):
    return (sum(p["x"] for p in pts) / len(pts), sum(p["z"] for p in pts) / len(pts))


def los_penalty(lens, aim, walls):
    """How many 0.5 m steps of the sight line pass within a metre of a wall.

    Advisory only — walls are thinned to a 1 m grid, and the in-game receipt is
    the real verdict — but a penalty of ten means the planner is probably
    looking through a wall, and a different corner should win.
    """
    dx, dy, dz = aim[0] - lens[0], aim[1] - lens[1], aim[2] - lens[2]
    dist = math.sqrt(dx * dx + dy * dy + dz * dz)
    if dist < 0.5 or not walls:
        return 0
    steps = int(dist / 0.5)
    hits = 0
    for i in range(1, steps):        # skip the endpoints: camera and subject
        t = i / steps
        sx, sy, sz = lens[0] + dx * t, lens[1] + dy * t, lens[2] + dz * t
        for wx, wy, wz in walls:
            if abs(wy - sy) <= 2.0 and (wx - sx) ** 2 + (wz - sz) ** 2 <= 1.0:
                hits += 1
                break
    return hits


# ---------------------------------------------------------------------------
# Vantage derivations. Each returns {"camera": (x, player_y, z), "aim": (x,y,z),
# "note": str, "los": int} or (None, "reason it was skipped").
# ---------------------------------------------------------------------------

def vantage_hall(f):
    """The main room: the floor band with the most floor under it, sweetened by
    a burning fire. Camera stands off toward a corner and looks back across."""
    bands = f["floor_bands"]
    if not bands:
        return None, "no floor bands"

    def band_score(b):
        has_fire = any(in_band(fire, b) for fire in f["fires"])
        area = max(b["max_x"] - b["min_x"], 1) * max(b["max_z"] - b["min_z"], 1)
        return (b["count"] * (1.5 if has_fire else 1.0), area)

    b = max(bands, key=band_score)
    fires = [p for p in f["fires"] if in_band(p, b)]
    tables = [p for p in f["tables"] if in_band(p, b)]
    if fires:
        ax, az = centroid(fires)
        note = f"aim at {len(fires)} fire(s)"
    elif tables:
        ax, az = centroid(tables)
        note = f"aim at {len(tables)} table(s)"
    else:
        ax, az = b["cx"], b["cz"]
        note = "aim at band centroid"
    aim = (ax, b["y"] + 1.0, az)

    diag = math.hypot(b["max_x"] - b["min_x"], b["max_z"] - b["min_z"])
    d = clamp(0.35 * diag, 4.0, 14.0)
    player_y = b["y"] + (EYE_STAND - LENS_OFFSET)
    best = None
    for cx, cz in rect_corners(b):
        vx, vz = cx - ax, cz - az
        n = math.hypot(vx, vz) or 1.0
        px = clamp(ax + vx / n * d, b["min_x"] + 1, b["max_x"] - 1)
        pz = clamp(az + vz / n * d, b["min_z"] + 1, b["max_z"] - 1)
        lens = (px, player_y + LENS_OFFSET, pz)
        pen = los_penalty(lens, aim, f["walls"])
        span = math.hypot(px - ax, pz - az)
        if best is None or (pen, -span) < (best[0], -best[3]):
            best = (pen, (px, player_y, pz), lens, span)
    pen, cam, _lens, _span = best
    return {"camera": cam, "aim": aim, "note": note + f", band y={b['y']}", "los": pen,
            "band": b}, None


def vantage_toproom(f, hall_band, cluster):
    """The highest room with the biggest window; camera across the room looking
    into the light. Falls back to an outward view when the build has no window
    prefabs at all (holes-for-windows builds)."""
    floor0 = hall_band["y"] if hall_band else (
        f["floor_bands"][0]["y"] if f["floor_bands"] else None)
    if floor0 is None:
        return None, "no floor bands"
    cands = [b for b in f["floor_bands"] if b["y"] >= floor0 + 4.0 and b["count"] >= 8]
    if not cands:
        return None, "single-storey (no band 4 m above the hall)"

    windowed = []
    for b in cands:
        ws = [w for w in f["windows"] if in_band(w, b, y_lo=0.5, y_hi=3.5)]
        if ws:
            windowed.append((b, ws))
    if windowed:
        b, ws = max(windowed, key=lambda bw: bw[0]["y"])
        w = max(ws, key=lambda w: (w["w"], math.hypot(w["x"] - b["cx"], w["z"] - b["cz"])))
        vx, vz = b["cx"] - w["x"], b["cz"] - w["z"]
        n = math.hypot(vx, vz) or 1.0
        d = clamp(0.45 * n, 2.5, 8.0)
        cam = (w["x"] + vx / n * d, b["y"] + (EYE_STAND - LENS_OFFSET), w["z"] + vz / n * d)
        aim = (w["x"], w["y"] + 0.5, w["z"])
        lens = (cam[0], cam[1] + LENS_OFFSET, cam[2])
        return {"camera": cam, "aim": aim,
                "note": f"window {w['name']} at y={w['y']}, band y={b['y']}",
                "los": los_penalty(lens, aim, f["walls"]), "band": b}, None

    # No window prefabs anywhere upstairs: compose the highest room as a small
    # hall instead — camera at its best corner, looking across. The pilot tried
    # aiming outward through whatever opening the builder left, and both takes
    # were a camera staring into rafters or crystal it could not see through.
    b = max(cands, key=lambda b: b["y"])
    aim = (b["cx"], b["y"] + 1.2, b["cz"])
    diag = math.hypot(b["max_x"] - b["min_x"], b["max_z"] - b["min_z"])
    d = clamp(0.35 * diag, 3.0, 10.0)
    player_y = b["y"] + (EYE_STAND - LENS_OFFSET)
    best = None
    for cx, cz in rect_corners(b):
        vx, vz = cx - b["cx"], cz - b["cz"]
        n = math.hypot(vx, vz) or 1.0
        px = clamp(b["cx"] + vx / n * d, b["min_x"] + 1, b["max_x"] - 1)
        pz = clamp(b["cz"] + vz / n * d, b["min_z"] + 1, b["max_z"] - 1)
        lens = (px, player_y + LENS_OFFSET, pz)
        pen = los_penalty(lens, aim, f["walls"])
        if best is None or pen < best[0]:
            best = (pen, (px, player_y, pz))
    pen, cam = best
    return {"camera": cam, "aim": aim,
            "note": f"no-window fallback, room view, band y={b['y']}",
            "los": pen, "band": b}, None


def vantage_seat(f, hall_band):
    """Sitting where the builder sat: a chair with a table in reach, near the
    fire if there is one. The camera IS the seat; the aim is what a diner would
    look at. Chair orientation is unknowable (no rotation in the cache), and
    aiming at the table is the better photograph anyway."""
    if not f["seats"]:
        return None, "no seats"

    def pair(s):
        best_t, best_d = None, 3.0
        for t in f["tables"]:
            if abs(s["y"] - t["y"]) > 1.5:
                continue
            d = math.hypot(s["x"] - t["x"], s["z"] - t["z"])
            if d <= best_d:
                best_t, best_d = t, d
        return best_t

    def near_fire(s):
        return any(abs(s["y"] - p["y"]) <= 3
                   and math.hypot(s["x"] - p["x"], s["z"] - p["z"]) <= 8
                   for p in f["fires"])

    def crowding(s):
        """Built mass within arm's reach of the lens. A throne jammed against a
        crystal slab or a chair walled into an alcove photographs as a macro
        shot of that surface, whatever the aim does."""
        return sum(1 for wx, wy, wz in f["walls"]
                   if abs(wy - s["y"]) <= 2.5
                   and (wx - s["x"]) ** 2 + (wz - s["z"]) ** 2 <= 1.6 ** 2) \
            + sum(1 for w in f["windows"]
                  if abs(w["y"] - s["y"]) <= 2.5
                  and (w["x"] - s["x"]) ** 2 + (w["z"] - s["z"]) ** 2 <= 1.6 ** 2)

    def score(s):
        t = pair(s)
        in_hall = hall_band and abs(s["y"] - hall_band["y"]) <= 2.5
        return ((2 if t else 0) + s["w"] + (1 if near_fire(s) else 0)
                + (2 if in_hall else 0) - min(crowding(s), 4) * 2)

    s = max(f["seats"], key=score)
    t = pair(s)
    if t:
        # Look ACROSS the table into the room, at the height of whoever would
        # sit opposite -- not down at the tabletop. Aiming at the surface from
        # a chair's length away framed a macro shot of the table edge.
        vx, vz = t["x"] - s["x"], t["z"] - s["z"]
        n = math.hypot(vx, vz) or 1.0
        aim = (t["x"] + vx / n * 2.5, s["y"] + 1.2, t["z"] + vz / n * 2.5)
        note = f"{s['name']} at {t['name']}, looking across"
    else:
        fires = [p for p in f["fires"]
                 if abs(s["y"] - p["y"]) <= 3
                 and math.hypot(s["x"] - p["x"], s["z"] - p["z"]) <= 10]
        if fires:
            p = min(fires, key=lambda p: math.hypot(s["x"] - p["x"], s["z"] - p["z"]))
            aim = (p["x"], p["y"] + 0.8, p["z"])
            note = f"{s['name']} facing {p['name']}"
        elif hall_band:
            aim = (hall_band["cx"], hall_band["y"] + 1.2, hall_band["cz"])
            note = f"{s['name']} facing the hall"
        else:
            return None, "a seat but nothing to look at"
    # Slightly in front of the seat, toward what it faces -- exactly at the
    # pivot the lens spawns inside the chair's own collider (thrones
    # especially) and the game's camera-collision hurls it skyward.
    vx, vz = aim[0] - s["x"], aim[2] - s["z"]
    n = math.hypot(vx, vz) or 1.0
    cam = (s["x"] + vx / n * SEAT_NUDGE,
           s["y"] + (EYE_SEAT - LENS_OFFSET),
           s["z"] + vz / n * SEAT_NUDGE)
    lens = (cam[0], cam[1] + LENS_OFFSET, cam[2])
    return {"camera": cam, "aim": aim, "note": note,
            "los": los_penalty(lens, aim, f["walls"])}, None


def vantage_gate(f, cluster, hall_band):
    """Posted up at the main gate, looking through it at the build. The gate
    nearest the box perimeter at ground level is 'main'; its axis is unknowable
    without rotation, so the line from gate to the ground floor's centre stands
    in for it."""
    if not f["gates"]:
        return None, "no gates"
    ground_y = hall_band["y"] if hall_band else cluster["min_y"]
    cands = [g for g in f["gates"] if abs(g["y"] - ground_y) <= 3.0] or f["gates"]

    def perim_dist(g):
        return min(g["x"] - cluster["min_x"], cluster["max_x"] - g["x"],
                   g["z"] - cluster["min_z"], cluster["max_z"] - g["z"])

    def lit(g):
        return any(abs(g["y"] - p["y"]) <= 4
                   and math.hypot(g["x"] - p["x"], g["z"] - p["z"]) <= 8
                   for p in f["fires"])

    # Nearest the perimeter wins, but a torch-lit gate is worth walking 6 m
    # further for: the pilot's one unlit pick was a black frame at every hour.
    g = min(cands, key=lambda g: perim_dist(g) - (6.0 if lit(g) else 0.0))
    if hall_band:
        ix, iz = hall_band["cx"], hall_band["cz"]
    else:
        ix, iz = cluster["center_x"], cluster["center_z"]
    vx, vz = ix - g["x"], iz - g["z"]
    n = math.hypot(vx, vz) or 1.0
    aim = (g["x"], g["y"] + 2.5, g["z"])
    player_y = g["y"] + (EYE_STAND - LENS_OFFSET)
    for d in (8.0, 6.0, 10.0):       # outside the gate, nudging if a wall bites
        cam = (g["x"] - vx / n * d, player_y, g["z"] - vz / n * d)
        blocked = any(abs(wy - (player_y + LENS_OFFSET)) <= 2.0
                      and (wx - cam[0]) ** 2 + (wz - cam[2]) ** 2 <= 0.8 ** 2
                      for wx, wy, wz in f["walls"])
        if not blocked:
            break
    lens = (cam[0], cam[1] + LENS_OFFSET, cam[2])
    return {"camera": cam, "aim": aim,
            "note": f"{g['name']} {perim_dist(g):.0f} m from the box edge",
            "los": los_penalty(lens, aim, f["walls"])}, None


def vantage_court(f, cluster, gate_v):
    """A courtyard: open to the sky, held by walls. Find the largest connected
    patch of unroofed cells that walls enclose on at least three sides, stand
    at its edge, and look across at the far facade."""
    grid = f["roof_grid"]
    cell = grid["cell"]
    ox, oz = grid["origin"]
    covered = {tuple(c) for c in grid["covered"]}
    ground_y = f["floor_bands"][0]["y"] if f["floor_bands"] else cluster["min_y"]

    def enclosed(cx_, cz_):
        dirs = 0
        for (fx, fz) in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            for wx, wy, wz in f["walls"]:
                if abs(wy - ground_y) > 8:
                    continue
                along = (wx - cx_) * fx + (wz - cz_) * fz
                across = abs((wx - cx_) * fz) + abs((wz - cz_) * fx)
                if 0 < along <= 20 and across <= 6:
                    dirs += 1
                    break
        return dirs >= 3

    court = []
    for ix in range(grid["nx"]):
        for iz in range(grid["nz"]):
            if (ix, iz) in covered:
                continue
            cx_ = ox + (ix + 0.5) * cell
            cz_ = oz + (iz + 0.5) * cell
            if (cx_ - cluster["min_x"] < 4 or cluster["max_x"] - cx_ < 4
                    or cz_ - cluster["min_z"] < 4 or cluster["max_z"] - cz_ < 4):
                continue
            if enclosed(cx_, cz_):
                court.append((ix, iz))
    if not court:
        return None, "no enclosed open-sky cells"

    court_set = set(court)
    seen, components = set(), []
    for start in court:
        if start in seen:
            continue
        comp, stack = [], [start]
        seen.add(start)
        while stack:
            c = stack.pop()
            comp.append(c)
            for nb in ((c[0] + 1, c[1]), (c[0] - 1, c[1]),
                       (c[0], c[1] + 1), (c[0], c[1] - 1)):
                if nb in court_set and nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        components.append(comp)
    comp = max(components, key=len)
    if len(comp) * cell * cell < 16.0:
        return None, f"largest court is only {len(comp) * cell * cell:.0f} m^2"

    def cell_center(c):
        return (ox + (c[0] + 0.5) * cell, oz + (c[1] + 0.5) * cell)

    ccx = sum(cell_center(c)[0] for c in comp) / len(comp)
    ccz = sum(cell_center(c)[1] for c in comp) / len(comp)
    inside = [p[1] for p in f["floors_thin"]
              if any(abs(p[0] - cell_center(c)[0]) <= cell
                     and abs(p[2] - cell_center(c)[1]) <= cell for c in comp)]
    inside.sort()
    court_y = inside[len(inside) // 2] if len(inside) >= 4 else ground_y

    if gate_v:
        gx, gz = gate_v["aim"][0], gate_v["aim"][2]
        cam_cell = min(comp, key=lambda c: math.hypot(cell_center(c)[0] - gx,
                                                      cell_center(c)[1] - gz))
    else:
        cam_cell = max(comp, key=lambda c: math.hypot(cell_center(c)[0] - ccx,
                                                      cell_center(c)[1] - ccz))
    px, pz = cell_center(cam_cell)
    d_xz = math.hypot(ccx - px, ccz - pz)
    if d_xz < 3.0:                    # tiny court: look at the far edge instead
        far = max(comp, key=lambda c: math.hypot(cell_center(c)[0] - px,
                                                 cell_center(c)[1] - pz))
        ccx, ccz = cell_center(far)
        d_xz = max(math.hypot(ccx - px, ccz - pz), 2.0)
    aim = (ccx, court_y + clamp(0.5 * d_xz + 2.0, 3.0, 10.0), ccz)
    cam = (px, court_y + (EYE_STAND - LENS_OFFSET), pz)
    lens = (cam[0], cam[1] + LENS_OFFSET, cam[2])
    return {"camera": cam, "aim": aim,
            "note": f"{len(comp) * cell * cell:.0f} m^2 court, floor y={court_y}",
            "los": los_penalty(lens, aim, f["walls"])}, None


# ---------------------------------------------------------------------------

def validate_tsv(path, mode="interior"):
    """Re-read the TSV the way the mod's LoadShotPlan does: split on tabs, drop
    short lines, parse floats. A row this check drops is a row the mod drops.

    plan_nightsky.py writes the same contract with mode=rooftop, so the mode is
    a parameter rather than a second copy of this function."""
    ok, bad = 0, 0
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            fields = line.split("\t")
            if len(fields) < 14:
                bad += 1
                continue
            try:
                int(fields[0])
                for i in (2, 3, 4, 5, 6, 8, 9, 10, 11):
                    float(fields[i])
                assert fields[13] == mode
                # fires and flash are read positionally at 14 and 15. A column
                # inserted anywhere earlier does not error in the mod, it shifts
                # every later field and shoots the wrong thing in silence.
                if len(fields) > 14:
                    assert fields[14] in ("0", "1")
                if len(fields) > 15 and fields[15]:
                    float(fields[15])
                ok += 1
            except (ValueError, AssertionError):
                bad += 1
    return ok, bad


def main():
    args = parse_args()
    for path, hint in ((args.features, "run scan_features.py first"),
                       (args.clusters, "run scan_clusters.py first")):
        if not os.path.exists(path):
            sys.exit(f"missing {path} — {hint}")
    with open(args.features, encoding="utf-8") as fh:
        fdoc = json.load(fh)
    with open(args.clusters, encoding="utf-8") as fh:
        cdoc = json.load(fh)
    names = {}
    if os.path.exists(args.names):
        with open(args.names, encoding="utf-8") as fh:
            names = json.load(fh)

    by_id = {c["cluster_id"]: c for c in cdoc["clusters"]}
    if args.cluster_ids:
        ids = [int(s) for s in args.cluster_ids.split(",") if s.strip()]
    else:
        ranked = [c for c in cdoc["clusters"]
                  if (args.region == "all" or c["region"] == args.region)
                  and str(c["cluster_id"]) in fdoc["clusters"]]
        ranked.sort(key=lambda c: -c["score"])
        ids = [c["cluster_id"] for c in ranked[: args.top]]

    missing = [i for i in ids if str(i) not in fdoc["clusters"]]
    if missing:
        sys.exit(f"clusters {missing} not in {args.features} — rerun "
                 f"scan_features.py --cluster-ids {','.join(map(str, missing))}")

    shots, notes = [], {}
    for cid in ids:
        f = fdoc["clusters"][str(cid)]
        c = by_id[cid]
        label = names.get(str(cid)) or f"cluster {cid}"

        hall, why_hall = vantage_hall(f)
        hall_band = hall.get("band") if hall else None
        top, why_top = vantage_toproom(f, hall_band, c)
        seat, why_seat = vantage_seat(f, hall_band)
        gate, why_gate = vantage_gate(f, c, hall_band)
        court, why_court = vantage_court(f, c, gate)

        derived = [(n, v) for n, v in (("hall", hall), ("toproom", top),
                                       ("seat", seat), ("gate", gate),
                                       ("court", court)) if v]
        if args.vantages:
            keep = {v.strip() for v in args.vantages.split(",") if v.strip()}
            derived = [(n, v) for n, v in derived if n in keep]
        skipped = {n: why for n, why in (("hall", why_hall), ("toproom", why_top),
                                         ("seat", why_seat), ("gate", why_gate),
                                         ("court", why_court)) if why}
        # vantage_hall already picks its corner by this penalty; the other four
        # only recorded it, so a sight line straight into masonry shipped as four
        # photographs of a wall. A gap that says why beats a camera in a wall.
        if args.max_los:
            blind = [(n, v) for n, v in derived if v["los"] >= args.max_los]
            derived = [(n, v) for n, v in derived if v["los"] < args.max_los]
            for n, v in blind:
                skipped[n] = f"sight line clips walls {v['los']}x (>= {args.max_los})"
        notes[str(cid)] = {
            "label": label,
            "vantages": {n: {"note": v["note"], "los": v["los"]} for n, v in derived},
            "skipped": skipped,
        }

        print(f"  {cid:>5} {label[:34]:<34} "
              + " ".join(f"{n}(los={v['los']})" for n, v in derived)
              + ("  skipped: " + ", ".join(f"{n}: {w}" for n, w in skipped.items())
                 if skipped else ""))

        for cond, env, tod in CONDITIONS:
            for vname, v in derived:
                cx_, py, cz_ = v["camera"]
                lens = (cx_, py + LENS_OFFSET, cz_)
                yaw, pitch, dist = look(lens, v["aim"])
                shots.append({
                    "cluster_id": cid, "label": label, "shot": f"{vname}_{cond}",
                    "camera": {"x": round(cx_, 1), "y": round(py, 2), "z": round(cz_, 1)},
                    "aim": {"x": round(v["aim"][0], 1), "y": round(v["aim"][1], 2),
                            "z": round(v["aim"][2], 1)},
                    "yaw_deg": yaw, "pitch_deg": pitch,
                    "distance_m": round(dist, 1),
                    "environment": env, "time_of_day": tod,
                    "mode": "interior",
                    "fires": args.fires,
                })

    out = {
        "generated_from": "plan_interiors.py",
        "world": fdoc.get("world"),
        "structures": len(ids),
        "shots": len(shots),
        "settings": {"lens_offset_m": LENS_OFFSET, "eye_stand_m": EYE_STAND,
                     "eye_seat_m": EYE_SEAT,
                     "conditions": [list(c) for c in CONDITIONS],
                     "fires": args.fires},
        "vantages": notes,
        "plan": shots,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
    os.replace(tmp, args.out)

    # Same contract as plan_shots.py, plus the mode column the current mod
    # reads and older builds ignore.
    tsv = os.path.splitext(args.out)[0] + ".tsv"
    with open(tsv + ".tmp", "w", encoding="utf-8", newline="\n") as fh:
        fh.write("# cluster_id\tshot\tcam_x\tcam_y\tcam_z\tyaw\tpitch\tenv\ttime\t"
                 "aim_x\taim_y\taim_z\tlabel\tmode\tfires\tflash\n")
        for s in shots:
            c_, a = s["camera"], s["aim"]
            fh.write(f"{s['cluster_id']}\t{s['shot']}\t{c_['x']}\t{c_['y']}\t{c_['z']}\t"
                     f"{s['yaw_deg']}\t{s['pitch_deg']}\t{s['environment']}\t"
                     f"{s['time_of_day']}\t{a['x']}\t{a['y']}\t{a['z']}\t"
                     f"{s['label'].replace(chr(9), ' ')}\t{s['mode']}\t"
                     f"{1 if s.get('fires') else 0}\t\n")
    os.replace(tsv + ".tmp", tsv)

    ok, bad = validate_tsv(tsv)
    print()
    print(f"  {len(ids)} structure(s) -> {len(shots)} shots "
          f"({len(shots) // max(len(CONDITIONS), 1)} vantages x {len(CONDITIONS)} conditions)")
    print(f"  {args.out}")
    print(f"  {tsv}  (this is the one the mod reads)")
    print(f"  TSV validation: {ok} row(s) parse the way LoadShotPlan parses, {bad} would drop")
    if bad:
        sys.exit("some rows would be dropped by the mod's parser — fix before arming")


if __name__ == "__main__":
    main()
