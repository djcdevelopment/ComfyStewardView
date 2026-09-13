#!/usr/bin/env python3
"""Bring AM4 terrain-cache receipts into the lake so omen_biome_context.py can consume them.

am4_terrain_cache.py writes host-local receipts (cache paths under /home/derek, a source
block with names but no paths). omen_biome_context.py -- the only terrain-context builder
that has ever produced a context -- verifies recorded absolute inputs on this host. So each
era's frozen caches, logs and receipt are copied over, every digest is re-checked against
what AM4 recorded, the source block is bound to the catalog's original save files, and the
receipt is rewritten in the OMEN shape with `host` kept as AM4 and the AM4 receipt retained
beside it verbatim.

    python import_am4_terrain.py --output-root R --ssh-target am4 \\
        --remote-root /home/derek/valheim-capture/terrain-20260913 --eras era13 era15 ... \\
        --dest R/am4-terrain-cache-20260913
"""
import argparse
from pathlib import Path
import subprocess
import sys
from archive import digest, load, now, save
from load_census import load_census


def pull(target, remote, local):
    local.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", f"{target}:{remote}", str(local)], check=True)
    return local


def import_era(root, catalog, target, remote_root, dest, slug):
    era = next(e for e in catalog["eras"] if e["slug"] == slug)
    local = dest / slug
    remote = f"{remote_root}/{slug}"
    am4 = load(pull(target, f"{remote}/receipt.json", local / "am4-receipt.json"))
    if am4.get("schema") != "steward-current-client-terrain-cache/v1" or am4.get("status") != "verified":
        raise ValueError(f"{slug}: AM4 receipt is not a verified terrain cache")
    for key in ("sourceKey", "snapshotId", "worldId"):
        if am4.get(key) != era[key]:
            raise ValueError(f"{slug}: AM4 receipt {key} does not match the catalog")
    for kind in ("db", "fwl"):
        recorded = {k: am4["source"][kind][k] for k in ("bytes", "sha256")}
        if recorded != {k: era[kind][k] for k in ("bytes", "sha256")}:
            raise ValueError(f"{slug}: AM4 staged {kind} is not the catalogued original")
    outputs = {}
    for suffix, spec in am4["outputs"].items():
        name = Path(spec["path"]).name
        path = pull(target, f"{remote}/caches/{name}", local / "caches" / name)
        got = digest(path)
        if got != {k: spec[k] for k in ("bytes", "sha256")}:
            raise ValueError(f"{slug}: {suffix} changed in transit")
        outputs[suffix] = {"path": str(path), **got, "width": spec["width"], "height": spec["height"]}
    logs = {}
    for label, spec in (am4.get("logs") or {}).items():
        name = Path(spec["path"]).name
        path = pull(target, f"{remote}/{name}", local / name)
        got = digest(path)
        if got != {k: spec[k] for k in ("bytes", "sha256")}:
            raise ValueError(f"{slug}: {label} log changed in transit")
        logs[label] = {"path": str(path), **got}
    # The census is re-read here from the imported Player.log: the worker on AM4 may be running
    # an older load_census, and this side is where the receipt is consumed.
    census = load_census(Path(logs["player"]["path"]).read_text(encoding="utf-8", errors="replace")) if "player" in logs else am4.get("loadCensus")
    receipt = {**am4,
               "source": {kind: {"path": era[kind]["path"], **{k: era[kind][k] for k in ("bytes", "sha256")}} for kind in ("db", "fwl")},
               "outputs": outputs, "logs": logs, "loadCensus": census,
               "imported": {"from": f"{target}:{remote}", "at": now(), "am4Receipt": "am4-receipt.json"}}
    if census and census.get("worldLoadFailed"):
        print(f"{slug}: NOTE the client refused the world after converting it ({census.get('loadException')}); "
              f"the caches are seed-derived and seed-checked, the load is not a witness to the objects", flush=True)
    save(local / "receipt.json", receipt)
    print(f"{slug}: imported {len(outputs)} caches, {len(logs)} logs; format {am4.get('provenance', {}).get('cacheFormat')}, "
          f"client {am4.get('loadCensus', {}).get('gameVersion')}", flush=True)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--ssh-target", required=True)
    parser.add_argument("--remote-root", required=True)
    parser.add_argument("--dest", type=Path, required=True)
    parser.add_argument("--eras", nargs="+", required=True)
    args = parser.parse_args()
    root = args.output_root.resolve()
    catalog = load(root / "catalog.json")
    for slug in args.eras:
        import_era(root, catalog, args.ssh_target, args.remote_root.rstrip("/"), args.dest.resolve(), slug)
    return 0


if __name__ == "__main__":
    sys.exit(main())
