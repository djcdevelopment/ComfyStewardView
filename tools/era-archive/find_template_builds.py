#!/usr/bin/env python3
"""Find campaign subjects that are the same stamped building repeated, not distinct builds.

Era 14's queue contained 239 copies of one 46 x 29 m lot: 238 of them exactly 1,629
pieces, every one 20.6 m tall, all beyond the 10.5 km world edge where no terrain
generates, so each reads as a platform floating in open sky. Four orbit angles apiece
is 956 photographs of one building.

They arrive at the top of the queue because community.py ranks photography by greedy
builder-era coverage: every player earns their first photograph before anyone earns a
second, and each stamped lot has a different owner. Footprint alone cannot separate them
from real work -- Era 14's 88 x 88 cohort shares a lot size and holds 25 different
buildings -- so identity here is the multiset of prefabs a build is made of. Two builds
with the same prefab histogram are the same building.

Reads the frozen campaign plus the archive's verified Parquet. Writes a retire list;
changes nothing. tools/era-archive/retire_builds.py applies it on the capture host.

Usage:
  python find_template_builds.py --campaign <campaign.json> --archive-root <root>
                                 [--min-family 6] [--dominance 0.9]
                                 [--delete-captured-largest] [--out retire-<era>.json]
"""
import argparse
import collections
import hashlib
from pathlib import Path

import duckdb

from archive import checked_file, load, now, save, sql_path


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--campaign", type=Path, required=True, help="campaign.json to inspect")
    p.add_argument("--archive-root", type=Path, required=True, help="era-archive output root")
    p.add_argument("--min-family", type=int, default=6,
                   help="a template needs at least this many copies (default 6). Two "
                        "identical builds is a coincidence worth photographing twice; "
                        "a hundred is a stamp")
    p.add_argument("--dominance", type=float, default=0.9,
                   help="unused for grouping -- reported per footprint so the receipt "
                        "shows how much of a same-size cohort one building accounts for")
    p.add_argument("--delete-captured-largest", action="store_true",
                   help="also nominate the largest family's already-captured "
                        "photographs for deletion, not just its unshot angles")
    p.add_argument("--out", type=Path, default=None)
    return p.parse_args()


def resolve_artifacts(root, era_slug):
    """Same path resolution campaign.py uses, with the same integrity checks."""
    era = next(e for e in load(root / "catalog.json")["eras"] if e["slug"] == era_slug)
    analysis = next(e for e in load(root / "analysis/catalog.json")["eras"]
                    if e["slug"] == era_slug)
    if analysis["sourceKey"] != era["sourceKey"]:
        raise ValueError("Membership source mismatch")
    return era, checked_file(root, era["ingestion"]["artifacts"]["zdo"]), \
        checked_file(root, analysis["membership"])


def fingerprints(zdo, membership, snapshot_id, build_keys):
    """SHA-256 over each build's sorted (prefab_hash, count) histogram.

    Keyed on the hash rather than the resolved name: an era with a dictionary gap
    reports several distinct prefabs as one null name, and grouping on that would
    merge genuinely different buildings into a single identity.
    """
    con = duckdb.connect(":memory:")
    con.execute("SET threads=4; SET memory_limit='2GB'")
    con.execute("CREATE TABLE wanted(build_key VARCHAR PRIMARY KEY)")
    con.executemany("INSERT INTO wanted VALUES (?)", [(k,) for k in build_keys])
    rows = con.execute(f"""
        SELECT m.build_key, z.prefab_hash, count(*) AS n
        FROM read_parquet({sql_path(membership)}) m
        JOIN wanted USING(build_key)
        JOIN read_parquet({sql_path(zdo)}) z USING(snapshot_id, zdo_index)
        WHERE m.snapshot_id = ?
        GROUP BY 1, 2
        """, [snapshot_id]).fetchall()
    con.close()
    histogram = collections.defaultdict(list)
    for key, prefab, n in rows:
        histogram[key].append((str(prefab), n))
    return {key: hashlib.sha256(repr(sorted(items)).encode()).hexdigest()
            for key, items in histogram.items()}


def main():
    args = parse_args()
    root = args.archive_root.resolve()
    plan = load(args.campaign)
    if plan.get("schema") != "steward-local-campaign/v1":
        raise ValueError("Not a local capture campaign")
    era, zdo, membership = resolve_artifacts(root, plan["era"])
    if era["sourceKey"] != plan["sourceKey"] or era["snapshotId"] != plan["snapshotId"]:
        raise ValueError("Campaign and archive describe different snapshots")

    builds = {b["buildKey"]: b for b in plan["builds"]}
    print(f"{plan['era']}: {len(builds)} campaign subjects", flush=True)
    keys = fingerprints(zdo, membership, plan["snapshotId"], list(builds))
    missing = sorted(set(builds) - set(keys))
    if missing:
        raise ValueError(f"{len(missing)} campaign builds have no membership rows")

    groups = collections.defaultdict(list)
    for key, template in keys.items():
        groups[template].append(key)

    families = []
    for template, members in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        if len(members) < args.min_family:
            continue
        members.sort(key=lambda k: builds[k]["localClusterId"])
        sample = builds[members[0]]
        families.append({
            "templateKey": template,
            "copies": len(members),
            "pieces": sample["pieces"],
            "shotsIfKept": sum(len(builds[k]["shots"]) for k in members),
            "firstLocalClusterId": sample["localClusterId"],
            "localClusterIds": [builds[k]["localClusterId"] for k in members],
            "buildKeys": members,
        })

    retire = [k for f in families for k in f["buildKeys"]]
    delete = families[0]["buildKeys"] if (args.delete_captured_largest and families) else []

    out = args.out or args.campaign.parent / f"retire-{plan['era']}.json"
    save(out, {
        "schema": "steward-template-retirement/v1",
        "generatedAt": now(),
        "era": plan["era"],
        "sourceKey": plan["sourceKey"],
        "snapshotId": plan["snapshotId"],
        "campaign": str(args.campaign.resolve()),
        "method": ("identity is the SHA-256 of a build's sorted (prefab_name, count) "
                   "histogram; a family is every subject sharing one identity"),
        "params": {"minFamily": args.min_family, "dominance": args.dominance},
        "subjects": len(builds),
        "families": families,
        "retireBuildKeys": retire,
        "deleteCapturedBuildKeys": delete,
    })

    print(f"\n{'copies':>7} {'pieces':>7} {'shots':>6}  first #  templateKey")
    for f in families:
        print(f"{f['copies']:>7} {f['pieces']:>7} {f['shotsIfKept']:>6}  "
              f"{f['firstLocalClusterId']:>7}  {f['templateKey'][:16]}")
    print(f"\n{len(families)} template famil(ies), {len(retire)} subjects, "
          f"{sum(f['shotsIfKept'] for f in families)} planned photographs")
    if delete:
        print(f"nominated for deletion of already-captured frames: {len(delete)} subjects "
              f"(the {families[0]['copies']}-copy family)")
    print(out)


if __name__ == "__main__":
    main()
