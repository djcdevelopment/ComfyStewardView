#!/usr/bin/env python3
"""Choose the fewest subjects that put every builder in the gallery.

The photography queue holds one job per build -- 234,920 of them, about 2,480 hours of
capture. But the objective those jobs encode is builder coverage, and coverage saturates
long before the queue does: all 5,228 builder-era pairs across the seven eras are
reachable in roughly 2,300 subjects. Era 14 needed 289 of its 36,817.

Selection is deliberately crude, because the measurements say nothing finer works. Across
268 builds with three or more scored frames every structural attribute is r ~ 0 against
photograph quality -- height -0.189, the ranking score -0.136, prefab variety -0.128,
pieces -0.034 -- and within-build spread is 85% of between-build spread. Ranking buildings
by how well they photograph is selling a correlation that is not there. Two coarse things
do carry signal, and they are the only two rules here beyond coverage:

  templates   one stamped lot repeated under many owners is one subject, not many
  region      subjects past the ~10.5 km world edge have no terrain under them and
              photograph as blowouts against empty sky: Era 17's fourteen sky platforms
              median 4.774 against a gallery median of 5.472

Reads the Parquet read model rather than the 367 MB private document, so a full seven-era
plan costs seconds. Writes a plan; captures nothing.

Usage:
  python plan_coverage.py --archive-root <root> [--era era7 ...] [--out plan.json]
                          [--captured FILE] [--min-family 6] [--shots-per-subject 4]
"""
import argparse
import collections
import json
import math
from pathlib import Path

import duckdb

from archive import checked_file, load, now, save, sql_path

WORLD_RADIUS_M = 10500.0


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--archive-root", type=Path, required=True)
    p.add_argument("--era", nargs="*", default=None,
                   help="era slugs to plan (default: every era in the catalog)")
    p.add_argument("--out", type=Path, default=None)
    p.add_argument("--captured", type=Path, action="append", default=[],
                   help="JSON file holding {\"keys\": [buildKey, ...]} already photographed. "
                        "Repeatable. Builders these already cover are not re-queued")
    p.add_argument("--min-family", type=int, default=6,
                   help="a template is a repeated build with at least this many copies "
                        "(default 6): two identical builds is a coincidence, a hundred is a stamp")
    p.add_argument("--shots-per-subject", type=int, default=4,
                   help="four orbit angles, for reporting cost only (default 4)")
    p.add_argument("--seconds-per-shot", type=float, default=10.2,
                   help="measured cross-build cadence on AM4 (default 10.2)")
    return p.parse_args()


def load_tables(root):
    """Read model first; it is 31 MB of Parquet against 367 MB of JSON."""
    model = load(root / "analysis/read-model.json")
    build = checked_file(root, model["tables"]["build"])
    contributor = checked_file(root, model["tables"]["build_contributor"])
    photo = checked_file(root, model["tables"]["build_photo"])
    con = duckdb.connect(":memory:")
    con.execute("SET threads=4; SET memory_limit='2GB'")
    con.execute(f"CREATE VIEW build AS SELECT * FROM read_parquet({sql_path(build)})")
    con.execute(f"CREATE VIEW contributor AS SELECT * FROM read_parquet({sql_path(contributor)})")
    con.execute(f"CREATE VIEW photo AS SELECT * FROM read_parquet({sql_path(photo)})")
    return con, model


def era_subjects(con, era):
    """One row per build with a named creator, with the geometry selection needs."""
    return con.execute("""
        SELECT b.build_key, b.pieces,
               bounds.maxX - bounds.minX AS sx,
               bounds.maxZ - bounds.minZ AS sz,
               (bounds.minX + bounds.maxX) / 2 AS cx,
               (bounds.minZ + bounds.maxZ) / 2 AS cz
        FROM build b
        WHERE b.era = ? AND b.bounds IS NOT NULL
          AND b.build_key IN (SELECT build_key FROM contributor)
        """, [era]).fetchall()


def plan_era(con, era, captured, min_family):
    rows = era_subjects(con, era)
    if not rows:
        return None
    contributors = collections.defaultdict(list)
    for build_key, builder_key in con.execute(
            "SELECT c.build_key, c.builder_key FROM contributor c JOIN build b USING(build_key) "
            "WHERE b.era = ?", [era]).fetchall():
        contributors[build_key].append(builder_key)

    # A template is an exactly repeated build. Prefer the fingerprint community.py now
    # records; until it has been re-run, an identical piece count on an identical
    # footprint is the same claim made with the columns the read model already has.
    signature = collections.Counter((r[1], round(r[2]), round(r[3])) for r in rows)
    stamped = {k for k, n in signature.items() if n >= min_family}

    index, order = {}, []
    for key in (b for r in rows for b in contributors[r[0]]):
        if key not in index:
            index[key] = len(index)
            order.append(key)

    already = set()
    for r in rows:
        if r[0] in captured:
            already.update(contributors[r[0]])
    for build_key, in con.execute(
            "SELECT DISTINCT p.build_key FROM photo p JOIN build b USING(build_key) "
            "WHERE b.era = ?", [era]).fetchall():
        already.update(contributors.get(build_key, []))

    covered = 0
    for key in already:
        if key in index:
            covered |= 1 << index[key]

    pool = []
    dropped_template = 0
    for build_key, pieces, sx, sz, cx, cz in rows:
        if (pieces, round(sx), round(sz)) in stamped:
            dropped_template += 1
            continue
        if build_key in captured:
            continue
        mask = 0
        for key in contributors[build_key]:
            mask |= 1 << index[key]
        in_world = math.hypot(cx, cz) <= WORLD_RADIUS_M
        pool.append([mask, build_key, pieces, in_world])

    reachable = 0
    for entry in pool:
        reachable |= entry[0]
    target = reachable | covered

    chosen = []
    while True:
        best, best_gain = None, 0
        for entry in pool:
            gain = bin(entry[0] & ~covered).count("1")
            if gain > best_gain or (gain == best_gain and gain > 0 and best is not None
                                    and (entry[3], entry[2]) > (best[3], best[2])):
                best, best_gain = entry, gain
        if not best_gain:
            break
        covered |= best[0]
        chosen.append({"buildKey": best[1], "pieces": best[2],
                       "region": "in-world" if best[3] else "outland", "newBuilders": best_gain})
        pool.remove(best)

    return {"era": era, "buildersInEra": len(index),
            "buildersAlreadyPhotographed": len(already & set(index)),
            "buildersCovered": bin(covered).count("1"),
            "buildersUnreachable": bin(target & ~covered).count("1"),
            "templateSubjectsDropped": dropped_template,
            "subjects": chosen}


def main():
    args = parse_args()
    root = args.archive_root.resolve()
    captured = set()
    for path in args.captured:
        payload = load(path)
        captured.update(payload["keys"] if isinstance(payload, dict) else payload)
    con, model = load_tables(root)
    catalog = load(root / "catalog.json")
    wanted = args.era or [e["slug"] for e in catalog["eras"]]
    numbers = {e["slug"]: e["era"] for e in catalog["eras"]}

    plans, total = [], collections.Counter()
    print(f"{'era':>7} {'builders':>9} {'have':>6} {'subjects':>9} {'shots':>7} {'hours':>6} "
          f"{'in-world':>9} {'templates':>10}")
    for slug in wanted:
        plan = plan_era(con, numbers[slug], captured, args.min_family)
        if not plan:
            continue
        plan["slug"] = slug
        n = len(plan["subjects"])
        shots = n * args.shots_per_subject
        in_world = sum(1 for s in plan["subjects"] if s["region"] == "in-world")
        plans.append(plan)
        total["subjects"] += n
        total["builders"] += plan["buildersInEra"]
        print(f"{slug:>7} {plan['buildersInEra']:>9,} {plan['buildersAlreadyPhotographed']:>6,} "
              f"{n:>9,} {shots:>7,} {shots*args.seconds_per_shot/3600:>6.1f} "
              f"{in_world/max(n,1):>8.0%} {plan['templateSubjectsDropped']:>10,}")

    shots = total["subjects"] * args.shots_per_subject
    print(f"\n{total['subjects']:,} subjects, {shots:,} shots, "
          f"{shots*args.seconds_per_shot/3600:.1f} h of capture")

    out = args.out or root / "analysis/coverage-plan.json"
    save(out, {
        "schema": "steward-coverage-plan/v1",
        "generatedAt": now(),
        "objective": "nominal builder coverage: one photographed build per attributed builder",
        "readModel": model["source"],
        "params": {"minFamily": args.min_family, "shotsPerSubject": args.shots_per_subject,
                   "worldRadiusM": WORLD_RADIUS_M,
                   "capturedInputs": [str(p) for p in args.captured]},
        "rules": ["exclude repeated stamped builds", "prefer in-world over outland",
                  "no ranking by build attributes: measured r ~ 0 against frame quality"],
        "totals": {"subjects": total["subjects"], "shots": shots},
        "eras": plans,
    })
    print(out)


if __name__ == "__main__":
    main()
