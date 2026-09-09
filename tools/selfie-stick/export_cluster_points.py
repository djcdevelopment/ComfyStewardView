#!/usr/bin/env python3
"""Persist the exact ZDO point membership behind a frozen clusters.json.

``scan_clusters.py`` deliberately writes compact cluster summaries.  Its temporary
``piece_cluster`` table contains the useful 3-D truth -- one BUILDING ZDO per row
with x/y/z -- but disappears when the process exits.  This companion replays the
same clustering against the snapshot named by ``clusters.json``, matches every
result back to the frozen cluster id by its full recorded geometry, and writes the
point rows to Parquet.

The geometry match is necessary because union-find ids are enumeration ids, not
content ids.  Equal-sized components can exchange ids between scans even when the
clusters themselves are byte-for-byte unchanged.  No output is written unless all
frozen clusters match exactly and every expected piece is accounted for.

Usage:
  python export_cluster_points.py --db PATH --clusters out/era17/clusters.json \
      --out E:/scratch/era17/cluster-zdos.parquet
"""
import argparse
import json
import os
import sys
from collections import defaultdict

import duckdb

from scan_clusters import build_clusters, cluster_stats, select_snapshot, table_columns


HERE = os.path.dirname(os.path.abspath(__file__))


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", required=True, help="ComfyStewardView DuckDB cache")
    p.add_argument("--clusters", default=os.path.join(HERE, "out", "clusters.json"),
                   help="frozen clusters.json whose ids must be preserved")
    p.add_argument("--out", default=None,
                   help="output Parquet (default: cluster-zdos.parquet beside clusters.json)")
    p.add_argument("--cell", type=float, default=16.0)
    p.add_argument("--y-cell", type=float, default=16.0)
    p.add_argument("--min-cell", type=int, default=4)
    p.add_argument("--min-pieces", type=int, default=400)
    p.add_argument("--replace", action="store_true",
                   help="replace an existing output file")
    return p.parse_args()


def rounded(value):
    return round(float(value), 1)


def frozen_signature(cluster):
    """Fields scan_clusters records directly from one connected component."""
    return (
        int(cluster["pieces"]),
        rounded(cluster["center_x"]), rounded(cluster["center_y"]),
        rounded(cluster["center_z"]),
        rounded(cluster["min_x"]), rounded(cluster["max_x"]),
        rounded(cluster["min_y"]), rounded(cluster["max_y"]),
        rounded(cluster["min_z"]), rounded(cluster["max_z"]),
    )


def scanned_signature(row):
    (cid, pieces, min_x, max_x, min_y, max_y, min_z, max_z,
     cen_x, _cen_y, cen_z, med_y, _distinct_prefabs, _distinct_creators) = row
    return (
        int(pieces),
        rounded(cen_x), rounded(med_y), rounded(cen_z),
        rounded(min_x), rounded(max_x), rounded(min_y), rounded(max_y),
        rounded(min_z), rounded(max_z),
    )


def unique_by_signature(rows, signature, label):
    grouped = defaultdict(list)
    for row in rows:
        grouped[signature(row)].append(row)
    duplicates = {key: values for key, values in grouped.items() if len(values) != 1}
    if duplicates:
        sample = next(iter(duplicates.values()))
        raise ValueError(f"{label} contains {len(duplicates)} ambiguous geometry signature(s); "
                         f"first has {len(sample)} rows")
    return {key: values[0] for key, values in grouped.items()}


def sql_string(value):
    if value is None:
        return "NULL::VARCHAR"
    return "'" + str(value).replace("'", "''") + "'::VARCHAR"


def main():
    args = parse_args()
    if not os.path.isfile(args.db):
        sys.exit(f"DuckDB cache not found: {args.db}")
    if not os.path.isfile(args.clusters):
        sys.exit(f"frozen clusters file not found: {args.clusters}")
    out_path = os.path.abspath(
        args.out or os.path.join(os.path.dirname(args.clusters), "cluster-zdos.parquet"))
    if os.path.exists(out_path) and not args.replace:
        sys.exit(f"output already exists: {out_path} (pass --replace to overwrite it)")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp_path = out_path + f".tmp-{os.getpid()}"
    if os.path.exists(tmp_path):
        sys.exit(f"temporary output already exists: {tmp_path}")

    with open(args.clusters, encoding="utf-8") as fh:
        doc = json.load(fh)
    frozen = doc.get("clusters") or []
    snapshot_id = doc.get("snapshot_id")
    if snapshot_id is None:
        sys.exit("clusters.json has no snapshot_id; exact source selection is impossible")

    print(f"opening {args.db} (read-only)", flush=True)
    con = duckdb.connect(args.db, read_only=True)
    snap = select_snapshot(con, snapshot_id=int(snapshot_id))
    _sid, source_path, parsed_at, world_id, world_name = snap
    if doc.get("world_id") and world_id != doc["world_id"]:
        sys.exit(f"world mismatch: clusters={doc['world_id']!r}, cache={world_id!r}")

    columns = table_columns(con, "zdo")
    required = {"snapshot_id", "zdo_index", "prefab_hash", "prefab_name", "category",
                "x", "y", "z", "creator_id"}
    missing = sorted(required - columns)
    if missing:
        sys.exit("zdo table cannot produce the coordinate artifact; missing: "
                 + ", ".join(missing))
    con.execute("CREATE TEMP VIEW selected_zdo AS SELECT * FROM zdo WHERE snapshot_id = "
                + str(int(snapshot_id)))
    print(f"  snapshot {snapshot_id}: {world_name or world_id or source_path}", flush=True)

    groups = build_clusters(con, args.cell, args.y_cell, args.min_cell)
    base, _top_prefab, _top_creator, _landmarks = cluster_stats(
        con, args.cell, args.y_cell, groups, args.min_pieces)

    try:
        frozen_by_sig = unique_by_signature(frozen, frozen_signature, "frozen clusters")
        scanned_by_sig = unique_by_signature(base, scanned_signature, "replayed clusters")
    except ValueError as exc:
        sys.exit(str(exc))

    missing_frozen = sorted(set(frozen_by_sig) - set(scanned_by_sig))
    extra_scanned = sorted(set(scanned_by_sig) - set(frozen_by_sig))
    if missing_frozen or extra_scanned:
        sys.exit("frozen-cluster reconciliation failed: "
                 f"{len(missing_frozen)} missing, {len(extra_scanned)} unexpected; "
                 "check snapshot and clustering parameters")

    mapping = []
    changed_ids = 0
    for signature, cluster in frozen_by_sig.items():
        scanned = scanned_by_sig[signature]
        current_id = int(scanned[0])
        frozen_id = int(cluster["cluster_id"])
        mapping.append((current_id, frozen_id))
        changed_ids += current_id != frozen_id
    con.execute("CREATE TEMP TABLE frozen_cluster_map "
                "(scanned_cluster_id BIGINT, cluster_id BIGINT)")
    con.executemany("INSERT INTO frozen_cluster_map VALUES (?, ?)", mapping)
    print(f"  reconciled {len(mapping):,} clusters; {changed_ids} replay id(s) remapped", flush=True)

    snapshot_sql = str(int(snapshot_id))
    world_sql = sql_string(world_id or doc.get("world_id"))
    cell_sql = repr(float(args.cell))
    y_cell_sql = repr(float(args.y_cell))
    con.execute(f"""
        CREATE TEMP VIEW cluster_zdo_export AS
        SELECT
            {snapshot_sql}::BIGINT AS snapshot_id,
            {world_sql} AS world_id,
            m.cluster_id,
            z.zdo_index,
            z.prefab_hash,
            z.prefab_name,
            z.category,
            z.x,
            z.y,
            z.z,
            z.creator_id
        FROM selected_zdo z
        JOIN cell_cluster c
          ON c.cx = CAST(floor(z.x / {cell_sql}) AS BIGINT)
         AND c.cy = CAST(floor(z.y / {y_cell_sql}) AS BIGINT)
         AND c.cz = CAST(floor(z.z / {cell_sql}) AS BIGINT)
        JOIN frozen_cluster_map m ON m.scanned_cluster_id = c.cid
        WHERE z.category = 'BUILDING'
        """)

    expected = sum(int(c["pieces"]) for c in frozen)
    actual, bad_coords, clusters_written = con.execute("""
        SELECT count(*),
               count(*) FILTER (WHERE x IS NULL OR y IS NULL OR z IS NULL
                                 OR NOT isfinite(x) OR NOT isfinite(y) OR NOT isfinite(z)),
               count(DISTINCT cluster_id)
        FROM cluster_zdo_export
        """).fetchone()
    if actual != expected or bad_coords or clusters_written != len(frozen):
        sys.exit("coordinate export gate failed: "
                 f"rows {actual:,}/{expected:,}, bad coords {bad_coords:,}, "
                 f"clusters {clusters_written:,}/{len(frozen):,}")

    target = tmp_path.replace("'", "''").replace("\\", "/")
    print(f"  writing {actual:,} exact x/y/z rows ...", flush=True)
    con.execute(f"""
        COPY (SELECT * FROM cluster_zdo_export ORDER BY cluster_id, zdo_index)
        TO '{target}' (FORMAT PARQUET, COMPRESSION ZSTD)
        """)
    con.close()

    check = duckdb.connect()
    row = check.execute("""
        SELECT count(*), count(DISTINCT cluster_id),
               count(*) FILTER (WHERE x IS NULL OR y IS NULL OR z IS NULL
                                 OR NOT isfinite(x) OR NOT isfinite(y) OR NOT isfinite(z))
        FROM read_parquet(?)
        """, [tmp_path]).fetchone()
    check.close()
    if row != (expected, len(frozen), 0):
        sys.exit(f"written Parquet failed read-back: {row}")
    os.replace(tmp_path, out_path)

    print(f"wrote {expected:,} ZDO coordinates across {len(frozen):,} frozen clusters")
    print(f"  {out_path}")
    print(f"  source snapshot {snapshot_id}, parsed {parsed_at}")


if __name__ == "__main__":
    main()
