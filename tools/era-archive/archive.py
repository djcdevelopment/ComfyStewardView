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
from records import MAX_WORLD_VERSION, MIN_WORLD_VERSION

REPO = Path(__file__).resolve().parents[2]
TABLES = ("world_snapshot", "zdo", "zdo_field", "container_item")
ERA_NAME = re.compile(r"ComfyEra(\d+)")


def verified_eras(catalog):
    """Eras whose extraction has passed verification; every stage after ingest reads only these."""
    return [e for e in catalog["eras"] if e["ingestion"].get("status") == "verified"]


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
    # The era is the world's own name when it carries one. The first two worlds predate the
    # naming convention (Booty, comfy), so their archive folder names them instead.
    match, era_source = ERA_NAME.fullmatch(name), "fwl-name"
    if not match:
        match, era_source = ERA_NAME.match(db.parent.name), "directory"
        if not match or not re.fullmatch(r"ComfyEra\d+(?:[_-].*)?", db.parent.name):
            raise ValueError(f"Expected an explicit Comfy era identity: {name} in {db.parent.name}")
    with db.open("rb") as stream:
        version, net_time, _user, _next, count = struct.unpack("<idqii", stream.read(28))
    if count <= 0 or not MIN_WORLD_VERSION <= version <= MAX_WORLD_VERSION:
        raise ValueError(f"Unsupported world header: {db} (version {version}, {count:,} objects)")
    db_receipt, fwl_receipt = digest(db), digest(fwl)
    key = hashlib.sha256((db_receipt["sha256"] + fwl_receipt["sha256"]).encode()).hexdigest()
    # worldId is what the game knows the save as: every stage that copies <worldId>.db into a
    # save directory, or reads the caches the client names after it, keys on this.
    # archiveWorldId is the archive's canonical identity, stamped into every extracted snapshot.
    return {"sourceKey": key, "era": int(match[1]), "slug": "era" + match[1], "eraSource": era_source,
            "worldId": name, "archiveWorldId": "ComfyEra" + match[1],
            "worldName": "Comfy Era " + match[1], "worldUid": str(world_uid),
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
    # One unreadable save must not stop the others: each file is judged on its own, the
    # verdicts land in intake-report.json, and the catalog moves forward with what passed.
    entries, rejected = [], []
    for candidate in sorted(source.rglob("*.db")):
        try:
            entries.append(source_entry(candidate))
        except (ValueError, OSError, struct.error, UnicodeError) as error:
            rejected.append({"path": str(candidate), "reason": str(error)})
    if not entries and not existing:
        raise ValueError("No DB/FWL pairs found" + (f"; {len(rejected)} rejected" if rejected else ""))
    # Filenames alone never make two different saves the same release.
    by_slug, conflicts = {}, set()
    for entry in entries:
        old = by_slug.get(entry["slug"])
        if old and old["sourceKey"] != entry["sourceKey"]:
            conflicts.add(entry["slug"])
        by_slug.setdefault(entry["slug"], entry)
    for slug in sorted(conflicts):
        for entry in entries:
            if entry["slug"] == slug:
                rejected.append({"path": entry["db"]["path"],
                                 "reason": f"Multiple release candidates for {slug}; use separate intake roots"})
        del by_slug[slug]
    next_id = max([1000] + [e["snapshotId"] for e in existing.values()]) + 1
    merged, observed = [], set()
    for entry in sorted(by_slug.values(), key=lambda e: e["era"]):
        if entry["sourceKey"] in existing:
            old = existing[entry["sourceKey"]]
            entry.update({k: v for k, v in old.items() if k not in {"db", "fwl"}})
        else:
            entry["snapshotId"] = next_id; next_id += 1
        merged.append(entry); observed.add(entry["sourceKey"])
    # A catalogued era whose source did not answer this scan stays catalogued: its packages
    # and receipts are intact, and dropping it would silently shrink every cross-era rebuild.
    missing = [e for e in previous["eras"] if e["sourceKey"] not in observed]
    merged = sorted(merged + missing, key=lambda e: e["era"])
    catalog = {"schema": "steward-era-archive/v1", "createdAt": previous.get("createdAt", now()),
               "updatedAt": now(), "inputRoot": str(source), "eras": merged,
               "policy": {"eraMissingConstructionFraction": .05, "buildMissingConstructionFraction": .10,
                          "gameSessions": "manual", "historicalModRecordsRequired": False}}
    # A rescan changes what is catalogued, not what has been built from it.
    for key in ("readModel", "parsers"):
        if key in previous:
            catalog[key] = previous[key]
    save(path, catalog)
    save(root / "intake-report.json", {
        "schema": "steward-intake-report/v1", "scannedAt": now(), "inputRoot": str(source),
        "accepted": [{k: e[k] for k in ("slug", "era", "eraSource", "worldId", "archiveWorldId", "worldVersion",
                                        "declaredZdos", "snapshotId")} | {"status": e["ingestion"].get("status")}
                     for e in merged if e["sourceKey"] in observed],
        "rejected": rejected,
        "missingSources": [{"slug": e["slug"], "sourceKey": e["sourceKey"], "path": e["db"]["path"]} for e in missing]})
    for item in rejected:
        print(f"REJECTED {item['path']}: {item['reason']}", file=sys.stderr, flush=True)
    for item in missing:
        print(f"MISSING SOURCE {item['slug']}: {item['db']['path']} (catalog entry retained)", file=sys.stderr, flush=True)
    print(f"Inventoried {len(merged)} eras; {sum(e['declaredZdos'] for e in merged):,} declared objects"
          + (f"; {len(rejected)} rejected" if rejected else ""), flush=True)
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


def parser_command(java, jar, entry, cache, geometry):
    # The snapshot carries the archive's canonical identity, not the save's own name.
    world_id = entry.get("archiveWorldId", entry["worldId"])
    return [str(java), "-Xmx8g", "-Djava.awt.headless=true", "-jar", str(jar), entry["db"]["path"],
            "--rebuild-cache", "--cache", str(cache), "--cache-fields", "--defer-indexes",
            "--world-id", world_id, "--world-name", entry["worldName"], "--source", "release",
            "--backup-id", entry["archiveLabel"], "--export-building-geometry", str(geometry),
            "--batch-only", "--no-browser"]


def pin_parser(root, jar):
    """Freeze the parser under its own digest so every receipt names bytes, not a build path."""
    stamp = digest(jar)
    pinned = Path(root) / "parser" / stamp["sha256"] / Path(jar).name
    if not pinned.exists():
        pinned.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(jar, pinned)
    if digest(pinned) != stamp:
        raise ValueError("Pinned parser integrity failure")
    return pinned, stamp


def parser_lineage(catalog, jar_sha):
    """Every parser digest the given jar has been proven row-identical to, itself included.

    A verified era keeps the parser it was extracted with; a newer jar may only touch the same
    catalog once parser_check has shown it reproduces the frozen packages exactly."""
    parsers = catalog.get("parsers", {})
    chain, frontier = set(), [jar_sha]
    while frontier:
        sha = frontier.pop()
        if sha in chain:
            continue
        chain.add(sha)
        frontier.extend(parsers.get(sha, {}).get("supersedes", []))
    return chain


def parser_check(root, catalog, java, jar, slugs, keep=False):
    """Prove a rebuilt parser reproduces already-verified packages before it is allowed near them.

    Each named verified era is parsed again into a scratch cache and every content table is
    compared both ways with EXCEPT ALL against the frozen Parquet. Only parse-time metadata
    (parsed_at, file_mtime, source_path) is excluded. Zero rows either way for every table
    accepts the jar into the catalog's parser lineage."""
    root = Path(root)
    pinned, stamp = pin_parser(root, jar)
    if stamp["sha256"] in catalog.get("parsers", {}):
        print(f"parser {stamp['sha256'][:16]} already accepted", flush=True)
        return catalog["parsers"][stamp["sha256"]]
    if not slugs:
        raise ValueError("parser-check needs at least one --era to compare against")
    checked, supersedes = [], set()
    for slug in slugs:
        entry = next((e for e in catalog["eras"] if e["slug"] == slug), None)
        if entry is None:
            raise ValueError(f"Unknown era {slug}")
        package = verify_package(root, entry)
        verify_sources(entry)
        scratch = root / "parser-check" / stamp["sha256"] / slug
        if scratch.exists():
            shutil.rmtree(scratch)
        scratch.mkdir(parents=True)
        cache, geometry, log = scratch / "snapshot.duckdb", scratch / "building-geometry.parquet", scratch / "ingest.log"
        command = parser_command(java, pinned, entry, cache, geometry)
        print(f"{slug}: re-parsing with {stamp['sha256'][:16]}; log {log}", flush=True)
        with log.open("w", encoding="utf-8") as output:
            result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError(f"{slug}: candidate parser exited {result.returncode}; see {log}")
        deltas, counts = {}, {}
        with duckdb.connect(str(cache)) as con:
            con.execute("SET threads=8"); con.execute("SET memory_limit='24GB'")
            con.execute(f"SET temp_directory={sql_path(scratch / 'tmp')}")
            for table in TABLES:
                con.execute(f"UPDATE {table} SET snapshot_id=?", [entry["snapshotId"]])
            con.execute("UPDATE world_snapshot SET save_timestamp=NULL")
            comparisons = {table: (f"SELECT * FROM {table}", f"SELECT * FROM read_parquet({sql_path(package[table])})")
                           for table in TABLES}
            comparisons["world_snapshot"] = tuple(q.replace("SELECT *", "SELECT * EXCLUDE(parsed_at, file_mtime, source_path)")
                                                  for q in comparisons["world_snapshot"])
            comparisons["geometry"] = (f"SELECT * FROM read_parquet({sql_path(geometry)})",
                                       f"SELECT * FROM read_parquet({sql_path(package['geometry'])})")
            for table, (fresh, frozen) in comparisons.items():
                counts[table] = con.execute(f"SELECT count(*) FROM ({fresh})").fetchone()[0]
                deltas[table] = {"frozenOnly": con.execute(f"SELECT count(*) FROM ({frozen} EXCEPT ALL {fresh})").fetchone()[0],
                                 "freshOnly": con.execute(f"SELECT count(*) FROM ({fresh} EXCEPT ALL {frozen})").fetchone()[0]}
                print(f"{slug}: {table} {counts[table]:,} rows; frozen-only {deltas[table]['frozenOnly']}, fresh-only {deltas[table]['freshOnly']}", flush=True)
        if any(v for d in deltas.values() for v in d.values()):
            raise ValueError(f"{slug}: candidate parser output differs from the frozen package: {deltas}")
        supersedes.add(entry["ingestion"]["parserArtifact"]["sha256"])
        checked.append({"slug": slug, "sourceKey": entry["sourceKey"], "snapshotId": entry["snapshotId"],
                        "frozenParser": entry["ingestion"]["parserArtifact"]["sha256"], "rows": counts,
                        "log": artifact(root, log)})
        if not keep:
            for item in (cache, geometry):
                item.unlink(missing_ok=True)
            shutil.rmtree(scratch / "tmp", ignore_errors=True)
    supersedes.discard(stamp["sha256"])
    record = {"jar": artifact(root, pinned), "supersedes": sorted(supersedes), "checkedEras": checked, "acceptedAt": now()}
    catalog.setdefault("parsers", {})[stamp["sha256"]] = record
    save(root / "parser-check" / stamp["sha256"] / "receipt.json", {"schema": "steward-parser-lineage/v1", "parser": stamp, **record})
    save(root / "catalog.json", catalog)
    print(f"ACCEPTED parser {stamp['sha256'][:16]} as row-identical on {', '.join(slugs)}", flush=True)
    return record


def ingest_one(root, entry, java, jar, lineage=None):
    root = Path(root)
    verify_sources(entry)
    jar_digest = digest(jar)
    lineage = lineage or {jar_digest["sha256"]}
    if entry["ingestion"].get("status") == "verified":
        verify_package(root, entry)
        if entry["ingestion"]["parserArtifact"]["sha256"] not in lineage:
            raise ValueError(f"Parser changed for {entry['slug']}; run parser-check to prove the new build row-identical, "
                             "or retain this release and create a new processing catalog")
        print(entry["slug"] + ": verified cache hit", flush=True)
        return
    candidate = root / "packages" / entry["slug"] / (entry["sourceKey"][:16] + "-" + uuid.uuid4().hex[:8])
    candidate.mkdir(parents=True)
    cache = candidate / "snapshot.duckdb"
    geometry = candidate / "building-geometry.parquet"
    log = candidate / "ingest.log"
    world_id = entry.get("archiveWorldId", entry["worldId"])
    command = parser_command(java, jar, entry, cache, geometry)
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
        if rows != [(1, world_id, entry["db"]["sha256"])]:
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
    verified = verified_eras(catalog)
    packages = [verify_package(root, e) for e in verified]
    if not packages:
        return
    # Supplementary catalogs must cover exactly the verified eras: pending ones have no
    # packages yet, and a stale catalog covering fewer would silently narrow the read model.
    verified_keys = {e["sourceKey"] for e in verified}
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
            if {p['sourceKey'] for p in payloads}!=verified_keys:
                raise ValueError('Payload catalog does not cover exactly the verified source pairs')
            paths=','.join(sql_path(checked_file(root,p['artifact'])) for p in payloads)
            con.execute(f'CREATE VIEW zdo_payload AS SELECT * FROM read_parquet([{paths}])')
            con.execute('CREATE VIEW zdo_field_full AS SELECT f.* EXCLUDE(string_value),coalesce(p.string_value,f.string_value) AS string_value,p.blob_value FROM zdo_field f LEFT JOIN zdo_payload p USING(snapshot_id,zdo_index,field_type,field_hash)')
        community_catalog=root/'analysis/read-model.json'
        if community_catalog.exists():
            community=load(community_catalog)
            if set(community['sourceKeys'])!=verified_keys:
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
    parser.add_argument("command", choices=["inventory", "ingest", "verify", "rebuild", "parser-check"])
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--input-root", type=Path)
    parser.add_argument("--java", default="java")
    parser.add_argument("--jar", type=Path, help="Explicit parser artifact; reruns default to the catalog's accepted parser")
    parser.add_argument("--era", action="append", help="Era slug (repeatable); default processes all pending eras")
    parser.add_argument("--no-rebuild", action="store_true",
                        help="Skip the read-model rebuild after ingest; the batch driver rebuilds once at the end")
    parser.add_argument("--keep", action="store_true", help="parser-check: keep the scratch caches for inspection")
    args = parser.parse_args()
    root = args.output_root.resolve()
    with writer_lock(root):
        if args.command == "inventory":
            if not args.input_root:
                parser.error("inventory requires --input-root")
            inventory(args.input_root, root)
            return
        catalog = load(root / "catalog.json")
        if args.command == "parser-check":
            parser_check(root, catalog, args.java, (args.jar or REPO / "viewer/target/world-viewer-1.0.0.jar").resolve(),
                         args.era or [], keep=args.keep)
        elif args.command == "ingest":
            known={e['ingestion']['parserArtifact']['sha256'] for e in verified_eras(catalog)}
            accepted=catalog.get("parsers",{})
            if args.jar:
                jar=args.jar.resolve()
            elif accepted:
                newest=max(accepted, key=lambda sha: accepted[sha]["acceptedAt"])
                jar=root/'parser'/newest/'world-viewer-1.0.0.jar'
            elif len(known)==1:
                jar=root/'parser'/next(iter(known))/'world-viewer-1.0.0.jar'
            else:
                jar=REPO/'viewer/target/world-viewer-1.0.0.jar'
            pinned, stamp = pin_parser(root, jar)
            lineage = parser_lineage(catalog, stamp["sha256"])
            failures = []
            for entry in catalog["eras"]:
                if args.era and entry["slug"] not in args.era:
                    continue
                try:
                    ingest_one(root, entry, args.java, pinned, lineage)
                except Exception as error:
                    failures.append(f"{entry['slug']}: {error}")
                    print(failures[-1], file=sys.stderr, flush=True)
                finally:
                    save(root / "catalog.json", catalog)
            if not args.no_rebuild:
                rebuild_read_model(root, catalog)
            if failures:
                raise RuntimeError("; ".join(failures))
        elif args.command == "rebuild":
            rebuild_read_model(root, catalog)
        else:
            verified = verified_eras(catalog)
            for entry in catalog["eras"]:
                verify_sources(entry)
            for entry in verified:
                verify_package(root, entry)
            pending = len(catalog["eras"]) - len(verified)
            print(f"VERIFIED {len(catalog['eras'])} immutable sources and {len(verified)} extraction packages"
                  + (f"; {pending} pending" if pending else ""), flush=True)


if __name__ == "__main__":
    main()
