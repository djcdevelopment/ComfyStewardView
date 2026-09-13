#!/usr/bin/env python3
"""Keep the save the game wrote back, and check the archive's decoders against it.

When the frozen 0.221.12 client loads an old world it converts it in memory and, on quit,
writes a monolithic current-format (v37) save beside a `<world>_backup_*` of the original.
That rewrite is the only game-side artefact the parser can be compared with: the same
world, read by the game itself, in the format the parser's compact path was proven on.

    converted_worlds.py harvest --output-root R --slug era7 --world-db <parked>/worlds_local/ComfyEra7.db
    converted_worlds.py check   --output-root R --slug era7 --java <java>

`harvest` copies the rewrite (and its .fwl) to R/converted-worlds/<slug>/ with a
steward-converted-world/v1 receipt binding it to the catalog's sourceKey. `check` parses
that copy with the catalog's accepted parser into scratch and compares it with the frozen
package: object counts per category, and the set of construction pieces by (prefab, x, z)
to the nearest metre. Deltas are reported, not asserted -- conversion drops a handful of
objects (era 7: 9 of 7,049,984) and that is the finding, not a failure. The catalog's
sourceKey stays the original bytes; a converted copy is never inventoried.
"""
import argparse
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import duckdb
from archive import artifact, digest, load, now, parser_command, save, sql_path, verify_package
from load_census import load_census


def world_header(path):
    with Path(path).open("rb") as stream:
        version, _net, _user, _next, count = struct.unpack("<idqii", stream.read(28))
    return {"worldVersion": version, "declaredZdos": count}


def harvest(root, catalog, slug, world_db, world_fwl=None, player_log=None, host="OMEN"):
    entry = next(e for e in catalog["eras"] if e["slug"] == slug)
    world_db = Path(world_db)
    world_fwl = Path(world_fwl) if world_fwl else world_db.with_suffix(".fwl")
    dest = root / "converted-worlds" / slug
    dest.mkdir(parents=True, exist_ok=True)
    files = {}
    for kind, source in (("db", world_db), ("fwl", world_fwl)):
        if source.is_file():
            target = dest / source.name
            shutil.copy2(source, target)
            if digest(target) != digest(source):
                raise ValueError(f"copy mismatch for {source}")
            files[kind] = artifact(root, target)
    header_out = world_header(dest / world_db.name)
    if header_out["worldVersion"] == entry["worldVersion"] and digest(dest / world_db.name)["sha256"] == entry["db"]["sha256"]:
        raise ValueError(f"{world_db} is the original, not a rewrite")
    census = load_census(Path(player_log).read_text(encoding="utf-8", errors="replace")) if player_log else {}
    receipt = {"schema": "steward-converted-world/v1", "era": slug, "worldId": entry["worldId"], "sourceKey": entry["sourceKey"],
               "snapshotId": entry["snapshotId"], "host": host, "harvestedAt": now(), "from": str(world_db),
               "worldVersionIn": entry["worldVersion"], "declaredZdosIn": entry["declaredZdos"],
               "worldVersionOut": header_out["worldVersion"], "declaredZdosOut": header_out["declaredZdos"],
               "declaredDelta": header_out["declaredZdos"] - entry["declaredZdos"],
               "gameVersion": census.get("gameVersion"), "loadCensus": census or None, "files": files}
    save(dest / "receipt.json", receipt)
    print(f"{slug}: kept v{receipt['worldVersionOut']} rewrite ({receipt['declaredZdosOut']:,} objects, "
          f"delta {receipt['declaredDelta']:+d}) at {dest}", flush=True)
    return receipt


def check(root, catalog, slug, java, jar):
    entry = next(e for e in catalog["eras"] if e["slug"] == slug)
    package = verify_package(root, entry)
    dest = root / "converted-worlds" / slug
    receipt = load(dest / "receipt.json")
    converted = root / receipt["files"]["db"]["path"]
    if digest(converted) != {k: receipt["files"]["db"][k] for k in ("bytes", "sha256")}:
        raise ValueError("converted world changed since harvest")
    scratch = root / "parser-check" / "converted" / slug
    if scratch.exists():
        shutil.rmtree(scratch)
    scratch.mkdir(parents=True)
    cache, geometry, log = scratch / "snapshot.duckdb", scratch / "building-geometry.parquet", scratch / "ingest.log"
    fake = {**entry, "db": {**entry["db"], "path": str(converted)}, "archiveLabel": entry["archiveLabel"] + "-converted"}
    command = parser_command(java, jar, fake, cache, geometry)
    print(f"{slug}: parsing the v{receipt['worldVersionOut']} rewrite; log {log}", flush=True)
    with log.open("w", encoding="utf-8") as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f"{slug}: parser exited {result.returncode} on the converted copy; see {log}")
    with duckdb.connect(str(cache)) as con:
        con.execute("SET threads=8"); con.execute("SET memory_limit='16GB'")
        con.execute(f"SET temp_directory={sql_path(scratch / 'tmp')}")
        con.execute(f"CREATE VIEW frozen AS SELECT * FROM read_parquet({sql_path(package['zdo'])})")
        categories = {}
        for category, fresh_n, frozen_n in con.execute("""
            SELECT coalesce(a.category, b.category), coalesce(a.n, 0), coalesce(b.n, 0)
            FROM (SELECT category, count(*) n FROM zdo GROUP BY 1) a
            FULL JOIN (SELECT category, count(*) n FROM frozen GROUP BY 1) b USING(category) ORDER BY 1""").fetchall():
            categories[category] = {"original": frozen_n, "converted": fresh_n, "delta": fresh_n - frozen_n}
        # Non-finite positions exist in some saves (community.py quarantines them); they cannot
        # be placed, so they cannot be matched, and they are counted apart.
        pieces = ("SELECT prefab_hash, round(x)::INTEGER AS x, round(z)::INTEGER AS z FROM {} "
                  "WHERE category='BUILDING' AND isfinite(x) AND isfinite(z)")
        nonfinite = con.execute("SELECT count(*) FROM frozen WHERE category='BUILDING' AND NOT (isfinite(x) AND isfinite(z))").fetchone()[0]
        lost = con.execute(f"SELECT count(*) FROM ({pieces.format('frozen')} EXCEPT {pieces.format('zdo')})").fetchone()[0]
        gained = con.execute(f"SELECT count(*) FROM ({pieces.format('zdo')} EXCEPT {pieces.format('frozen')})").fetchone()[0]
        total = con.execute("SELECT count(*) FROM frozen WHERE category='BUILDING'").fetchone()[0]
        unresolved = con.execute("SELECT count(*) FROM zdo WHERE prefab_name IS NULL OR starts_with(prefab_name, 'hash:')").fetchone()[0]
    outcome = {"schema": "steward-converted-world-check/v1", "era": slug, "sourceKey": entry["sourceKey"], "checkedAt": now(),
               "parser": digest(jar)["sha256"], "converted": receipt["files"]["db"],
               "categories": categories,
               "buildingPieces": {"original": total, "lostInConversion": lost, "newInConversion": gained,
                                  "nonFinitePositions": nonfinite, "lostFraction": round(lost / total, 6) if total else None},
               "unresolvedPrefabsConverted": unresolved, "log": artifact(root, log)}
    save(dest / "check.json", outcome)
    shutil.rmtree(scratch, ignore_errors=True)
    print(f"{slug}: {total:,} construction pieces; {lost:,} not found after conversion, {gained:,} new "
          f"({outcome['buildingPieces']['lostFraction']:.4%} lost); category deltas "
          f"{ {k: v['delta'] for k, v in categories.items() if v['delta']} }", flush=True)
    return outcome


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["harvest", "check"])
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--world-db", type=Path, help="harvest: the rewritten .db the client left behind")
    parser.add_argument("--world-fwl", type=Path)
    parser.add_argument("--player-log", type=Path, help="harvest: the session's Player.log, for the game version and load census")
    parser.add_argument("--host", default="OMEN")
    parser.add_argument("--java", default="java")
    parser.add_argument("--jar", type=Path, help="check: parser jar; default the catalog's newest accepted parser")
    args = parser.parse_args()
    root = args.output_root.resolve()
    catalog = load(root / "catalog.json")
    if args.command == "harvest":
        if not args.world_db:
            parser.error("harvest needs --world-db")
        harvest(root, catalog, args.slug, args.world_db, args.world_fwl, args.player_log, args.host)
    else:
        accepted = catalog.get("parsers", {})
        jar = args.jar or (root / "parser" / max(accepted, key=lambda s: accepted[s]["acceptedAt"]) / "world-viewer-1.0.0.jar")
        check(root, catalog, args.slug, args.java, jar.resolve())
    return 0


if __name__ == "__main__":
    sys.exit(main())
