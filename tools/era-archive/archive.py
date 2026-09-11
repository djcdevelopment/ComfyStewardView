#!/usr/bin/env python3
"""Immutable save intake, resumable extraction, and a reconstructible DuckDB read model.

All operational paths are explicit. Source worlds are opened read-only; only a fully verified
candidate is added to the catalog. The archive owns Parquet, while world-cache.duckdb is rebuilt
as predicate-pushdown views over that archive. No production database is overwritten.
"""
from __future__ import annotations
import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import uuid
import duckdb

REPO = Path(__file__).resolve().parents[2]
TABLES = ("world_snapshot", "zdo", "zdo_field", "container_item")


def digest(path):
    path = Path(path)
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(block)
    return {"bytes": path.stat().st_size, "sha256": h.hexdigest()}


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def save(path, document):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    candidate = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    candidate.write_text(json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(candidate, path)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sql_path(path):
    return "'" + str(Path(path).resolve()).replace("\\", "/").replace("'", "''") + "'"


def checked_file(root, artifact):
    path = (Path(root) / artifact["path"]).resolve()
    if not path.is_relative_to(Path(root).resolve()):
        raise ValueError("Artifact path escapes its package")
    if digest(path) != {k: artifact[k] for k in ("bytes", "sha256")}:
        raise ValueError(f"Artifact integrity mismatch: {path}")
    return path


@contextlib.contextmanager
def writer_lock(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    stream = (root / ".writer.lock").open("a+b")
    try:
        if stream.tell() == 0:
            stream.write(b"0"); stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        stream.close()


def read_string(data, offset):
    length, shift = 0, 0
    while True:
        if offset >= len(data) or shift > 28:
            raise ValueError("Invalid FWL string")
        value = data[offset]; offset += 1
        length |= (value & 127) << shift
        if not value & 128:
            break
        shift += 7
    if offset + length > len(data):
        raise ValueError("Truncated FWL string")
    return data[offset:offset+length].decode("utf-8"), offset+length


def source_entry(db):
    db = Path(db).resolve()
    fwl = db.with_suffix(".fwl")
    data = fwl.read_bytes()
    if len(data) < 16:
        raise ValueError(f"Truncated FWL: {fwl}")
    package_length, fwl_version = struct.unpack_from("<ii", data)
    if package_length != len(data) - 4:
        raise ValueError(f"FWL package length mismatch: {fwl}")
    name, offset = read_string(data, 8)
    _seed, offset = read_string(data, offset)
    _seed_hash, world_uid = struct.unpack_from("<iq", data, offset)
    if name != db.stem:
        raise ValueError(f"World filename and FWL name disagree: {db.name}, {name}")
    match = re.fullmatch(r"ComfyEra(\d+)", name)
    if not match:
        raise ValueError(f"Expected an explicit Comfy era identity: {name}")
    with db.open("rb") as stream:
        version, net_time, _user, _next, count = struct.unpack("<idqii", stream.read(28))
    if count <= 0 or not 29 <= version <= 37:
        raise ValueError(f"Unsupported world header: {db}")
    db_receipt, fwl_receipt = digest(db), digest(fwl)
    key = hashlib.sha256((db_receipt["sha256"] + fwl_receipt["sha256"]).encode()).hexdigest()
    return {"sourceKey": key, "era": int(match[1]), "slug": "era" + match[1],
            "worldId": name, "worldName": "Comfy Era " + match[1], "worldUid": str(world_uid),
            "archiveLabel": db.parent.name, "archiveDateStatus": "UNVERIFIED", "saveTimestamp": None,
            "worldVersion": version, "fwlVersion": fwl_version, "declaredZdos": count,
            "netTimeSeconds": net_time,
            "db": {"path": str(db), **db_receipt}, "fwl": {"path": str(fwl), **fwl_receipt},
            "ingestion": {"status": "pending"}, "runtime": {"status": "unidentified", "standard": "era-matched"}}


def inventory(input_root, output_root):
    source = Path(input_root).resolve(); root = Path(output_root).resolve()
    if root == source or root.is_relative_to(source) or source.is_relative_to(root):
        raise ValueError("Source archive and processing output must be separate directory trees")
    path = root / "catalog.json"
    previous = load(path) if path.exists() else {"eras": []}
    existing = {e["sourceKey"]: e for e in previous["eras"]}
    entries = [source_entry(p) for p in source.rglob("*.db")]
    if not entries:
        raise ValueError("No DB/FWL pairs found")
    # Filenames alone never make two different saves the same release.
    by_slug = {}
    for entry in entries:
        old = by_slug.get(entry["slug"])
        if old and old["sourceKey"] != entry["sourceKey"]:
            raise ValueError(f"Multiple release candidates for {entry['slug']}; use separate intake roots")
        by_slug[entry["slug"]] = entry
    next_id = max([1000] + [e["snapshotId"] for e in existing.values()]) + 1
    merged = []
    for entry in sorted(by_slug.values(), key=lambda e: e["era"]):
        if entry["sourceKey"] in existing:
            old = existing[entry["sourceKey"]]
            entry.update({k: v for k, v in old.items() if k not in {"db", "fwl"}})
        else:
            entry["snapshotId"] = next_id; next_id += 1
        merged.append(entry)
    catalog = {"schema": "steward-era-archive/v1", "createdAt": previous.get("createdAt", now()),
               "updatedAt": now(), "inputRoot": str(source), "eras": merged,
               "policy": {"eraMissingConstructionFraction": .05, "buildMissingConstructionFraction": .10,
                          "gameSessions": "manual", "historicalModRecordsRequired": False}}
    save(path, catalog)
    print(f"Inventoried {len(merged)} eras; {sum(e['declaredZdos'] for e in merged):,} declared objects", flush=True)
    return catalog


def verify_sources(entry):
    for key in ("db", "fwl"):
        source = entry[key]
        if digest(source["path"]) != {k: source[k] for k in ("bytes", "sha256")}:
            raise ValueError(f"Original source changed: {source['path']}")


def artifact(root, path):
    return {"path": Path(path).resolve().relative_to(Path(root).resolve()).as_posix(), **digest(path)}


def verify_package(root, entry):
    receipt = entry["ingestion"]
    if receipt.get("status") != "verified":
        raise ValueError("Ingestion has not passed verification")
    return {name: checked_file(root, ref) for name, ref in receipt["artifacts"].items()}


def ingest_one(root, entry, java, jar):
    root = Path(root)
    verify_sources(entry)
    jar_digest = digest(jar)
    if entry["ingestion"].get("status") == "verified":
        verify_package(root, entry)
        if entry["ingestion"]["parserArtifact"]["sha256"] != jar_digest["sha256"]:
            raise ValueError(f"Parser changed for {entry['slug']}; retain this release and create a new processing catalog")
        print(entry["slug"] + ": verified cache hit", flush=True)
        return
    candidate = root / "packages" / entry["slug"] / (entry["sourceKey"][:16] + "-" + uuid.uuid4().hex[:8])
    candidate.mkdir(parents=True)
    cache = candidate / "snapshot.duckdb"
    geometry = candidate / "building-geometry.parquet"
    log = candidate / "ingest.log"
    command = [str(java), "-Xmx8g", "-Djava.awt.headless=true", "-jar", str(jar), entry["db"]["path"],
               "--rebuild-cache", "--cache", str(cache), "--cache-fields", "--defer-indexes",
               "--world-id", entry["worldId"], "--world-name", entry["worldName"], "--source", "release",
               "--backup-id", entry["archiveLabel"], "--export-building-geometry", str(geometry),
               "--batch-only", "--no-browser"]
    save(candidate / "request.json", {"sourceKey": entry["sourceKey"], "command": command,
                                     "parserArtifact": jar_digest, "startedAt": now()})
    print(entry["slug"] + ": ingesting; log " + str(log), flush=True)
    with log.open("w", encoding="utf-8") as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        entry["ingestion"] = {"status": "failed", "log": str(log), "exitCode": result.returncode}
        raise RuntimeError(f"{entry['slug']}: parser exited {result.returncode}; see {log}")
    verify_sources(entry)
    counts = {}
    with duckdb.connect(str(cache)) as con:
        con.execute("SET threads=4")
        rows = con.execute("SELECT snapshot_id,world_id,file_hash FROM world_snapshot").fetchall()
        if rows != [(1, entry["worldId"], entry["db"]["sha256"])]:
            raise ValueError(f"Unexpected snapshot provenance: {rows}")
        total, unique = con.execute("SELECT count(*),count(DISTINCT zdo_index) FROM zdo").fetchone()
        if total != entry["declaredZdos"] or total != unique:
            raise ValueError(f"Unreconciled record counts: header={entry['declaredZdos']}, rows={total}, unique={unique}")
        for table in TABLES:
            con.execute(f"UPDATE {table} SET snapshot_id=?", [entry["snapshotId"]])
            counts[table] = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        con.execute("UPDATE world_snapshot SET save_timestamp=NULL")
        for table in TABLES:
            con.execute(f"COPY {table} TO {sql_path(candidate / (table + '.parquet'))} (FORMAT PARQUET, COMPRESSION ZSTD)")
        expected = con.execute("SELECT count(*) FROM zdo WHERE category IN ('BUILDING','ITEM_STAND','CONTAINER','PORTAL','BED','SIGN','BALLISTA')").fetchone()[0]
        actual = con.execute(f"SELECT count(*) FROM read_parquet({sql_path(geometry)})").fetchone()[0]
        if expected != actual:
            raise ValueError(f"Geometry membership mismatch: {expected} expected, {actual} exported")
        counts["geometry"] = actual
    entry["ingestion"] = {"status": "verified", "completedAt": now(), "parserArtifact": jar_digest,
                           "counts": counts, "log": artifact(root, log),
                           "artifacts": {table: artifact(root, candidate / (table + ".parquet")) for table in TABLES}}
    entry["ingestion"]["artifacts"]["geometry"] = artifact(root, geometry)
    entry["ingestion"]["artifacts"]["cache"] = artifact(root, cache)
    save(candidate / "receipt.json", {"source": entry, "schema": "steward-era-ingest/v1"})
    print(f"{entry['slug']}: VERIFIED {total:,} objects; {counts['zdo_field']:,} fields; {actual:,} geometry rows", flush=True)


def rebuild_read_model(root, catalog):
    root = Path(root)
    packages = [verify_package(root, e) for e in catalog["eras"] if e["ingestion"].get("status") == "verified"]
    if not packages:
        return
    candidate = root / ("world-cache-" + uuid.uuid4().hex + ".duckdb")
    with duckdb.connect(str(candidate)) as con:
        for table in TABLES:
            paths = ",".join(sql_path(p[table]) for p in packages)
            con.execute(f"CREATE VIEW {table} AS SELECT * FROM read_parquet([{paths}], union_by_name=true)")
        duplicates = con.execute("SELECT snapshot_id FROM world_snapshot GROUP BY snapshot_id HAVING count(*)<>1").fetchall()
        if duplicates:
            raise ValueError(f"Snapshot ID collision: {duplicates}")
        payload_catalog=root/'payloads/catalog.json'
        if payload_catalog.exists():
            payloads=load(payload_catalog)['eras']
            if {p['sourceKey'] for p in payloads}!={e['sourceKey'] for e in catalog['eras']}:
                raise ValueError('Payload catalog does not cover exactly the selected source pairs')
            paths=','.join(sql_path(checked_file(root,p['artifact'])) for p in payloads)
            con.execute(f'CREATE VIEW zdo_payload AS SELECT * FROM read_parquet([{paths}])')
            con.execute('CREATE VIEW zdo_field_full AS SELECT f.* EXCLUDE(string_value),coalesce(p.string_value,f.string_value) AS string_value,p.blob_value FROM zdo_field f LEFT JOIN zdo_payload p USING(snapshot_id,zdo_index,field_type,field_hash)')
        community_catalog=root/'analysis/read-model.json'
        if community_catalog.exists():
            community=load(community_catalog)
            if set(community['sourceKeys'])!={e['sourceKey'] for e in catalog['eras']}:
                raise ValueError('Community catalog source set mismatch')
            for table,ref in community['tables'].items():
                if table not in {'builder','builder_character','name_observation','build','build_contributor','build_resident','build_photo'}:
                    raise ValueError('Unexpected community table')
                con.execute(f'CREATE VIEW {table} AS SELECT * FROM read_parquet({sql_path(checked_file(root,ref))})')
            memberships=load(root/'analysis/catalog.json')['eras']
            paths=','.join(sql_path(checked_file(root,e['membership'])) for e in memberships)
            con.execute(f'CREATE VIEW build_member AS SELECT * FROM read_parquet([{paths}])')
    os.replace(candidate, root / "world-cache.duckdb")
    catalog["readModel"] = artifact(root, root / "world-cache.duckdb")
    catalog["updatedAt"] = now()
    save(root / "catalog.json", catalog)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["inventory", "ingest", "verify", "rebuild"])
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--input-root", type=Path)
    parser.add_argument("--java", default="java")
    parser.add_argument("--jar", type=Path, help="Explicit parser artifact; reruns default to the catalog's frozen parser")
    parser.add_argument("--era", help="Process one era slug; default processes all pending eras")
    args = parser.parse_args()
    root = args.output_root.resolve()
    with writer_lock(root):
        if args.command == "inventory":
            if not args.input_root:
                parser.error("inventory requires --input-root")
            inventory(args.input_root, root)
            return
        catalog = load(root / "catalog.json")
        if args.command == "ingest":
            known={e['ingestion']['parserArtifact']['sha256'] for e in catalog['eras'] if e['ingestion'].get('status')=='verified'}
            if args.jar:
                jar=args.jar.resolve()
            elif len(known)==1:
                jar=root/'parser'/next(iter(known))/'world-viewer-1.0.0.jar'
            else:
                jar=REPO/'viewer/target/world-viewer-1.0.0.jar'
            stamp = digest(jar)
            pinned = root / "parser" / stamp["sha256"] / jar.name
            if not pinned.exists():
                pinned.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(jar, pinned)
            if digest(pinned) != stamp:
                raise ValueError("Pinned parser integrity failure")
            failures = []
            for entry in catalog["eras"]:
                if args.era and entry["slug"] != args.era:
                    continue
                try:
                    ingest_one(root, entry, args.java, pinned)
                except Exception as error:
                    failures.append(f"{entry['slug']}: {error}")
                    print(failures[-1], file=sys.stderr, flush=True)
                finally:
                    save(root / "catalog.json", catalog)
            rebuild_read_model(root, catalog)
            if failures:
                raise RuntimeError("; ".join(failures))
        elif args.command == "rebuild":
            rebuild_read_model(root, catalog)
        else:
            for entry in catalog["eras"]:
                verify_sources(entry)
                verify_package(root, entry)
            print(f"VERIFIED {len(catalog['eras'])} immutable sources and extraction packages", flush=True)


if __name__ == "__main__":
    main()
