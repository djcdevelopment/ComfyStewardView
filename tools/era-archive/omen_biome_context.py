#!/usr/bin/env python3
"""Build raw and smoothed historical biome contexts from frozen OMEN terrain caches.

The AM4 sibling waits on a photography handoff because the campaign owns the game
there. The OMEN caches are already complete and that session was restored, so this
command starts from the receipts omen_terrain_cache.py left behind and never touches
Valheim.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


CACHE_SOURCES = (("mapTexCache", "mapCache"), ("heightTexCache", "heightCache"),
                 ("forestMaskTexCache", "forestMaskCache"))


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def runtime_versions(player_log: Path) -> dict[str, object]:
    text = player_log.read_text(encoding="utf-8-sig", errors="replace")
    game = re.search(r"Valheim version:\s*([^\s]+)", text)
    unity = re.search(r"Running under Unity v([^\s]+)", text)
    # The generator that made the caches is the one set up for the world: the last "setup:"
    # line before "Load world:" (the menu logs its own first; a client that refused the
    # world and bounced back to the menu logs another afterwards -- era 4, 2026-09-13).
    loaded = text.find("Load world:")
    generators = re.findall(r"Worldgenerator version setup:(\d+)", text[:loaded] if loaded >= 0 else text)
    if not game or not unity or not generators:
        raise ValueError(f"Runtime versions missing from {player_log}")
    return {"gameVersion": game.group(1), "unityVersion": unity.group(1),
            "worldGeneratorVersion": int(generators[-1])}


def require_variant(manifest: dict, identifier: str, root: Path) -> dict:
    matches = [item for item in manifest["variants"] if item["id"] == identifier]
    if len(matches) != 1:
        raise ValueError(f"Expected one {identifier} variant")
    item = matches[0]
    path = root / item["file"]
    if not path.is_file() or path.stat().st_size != item["bytes"] or sha256(path) != item["sha256"]:
        raise ValueError(f"Variant verification failed: {identifier}")
    return item


def require_heightfield(manifest: dict, root: Path) -> dict:
    if manifest.get("schemaVersion") != 3:
        raise ValueError("Existing terrain context is not schema 3; use a fresh output directory")
    item = manifest.get("heightfield") or {}
    path = root / str(item.get("file", ""))
    if (item.get("encoding") != "uint16-le" or
            item.get("bytes") != item.get("width", 0) * item.get("height", 0) * 2 or
            not path.is_file() or path.stat().st_size != item.get("bytes") or
            sha256(path) != item.get("sha256")):
        raise ValueError("Existing terrain context has an invalid heightfield")
    return item


def verify_source(spec: dict, label: str) -> Path:
    """Confirm a recorded absolute input is still exactly the file that was measured."""
    path = Path(spec["path"])
    if not path.is_file() or path.stat().st_size != spec["bytes"] or sha256(path) != spec["sha256"]:
        raise ValueError(f"Source verification failed for {label}: {path}")
    return path


def cache_receipt(terrain_root: Path, era: dict) -> dict:
    """Load one completed OMEN cache run and bind it to the archive catalog."""
    slug = era["slug"]
    receipt = read(terrain_root / slug / "receipt.json")
    if receipt.get("schema") != "steward-current-client-terrain-cache/v1":
        raise ValueError(f"Unsupported terrain cache receipt for {slug}")
    if receipt.get("status") != "verified" or receipt.get("era") != slug:
        raise ValueError(f"Terrain cache for {slug} is not a verified run")
    for key in ("sourceKey", "snapshotId", "worldId"):
        if receipt.get(key) != era[key]:
            raise ValueError(f"Catalog/cache {key} mismatch for {slug}")
    for kind in ("db", "fwl"):
        recorded = receipt["source"][kind]
        catalogued = era[kind]
        if {key: recorded.get(key) for key in ("bytes", "sha256")} != {
                key: catalogued[key] for key in ("bytes", "sha256")}:
            raise ValueError(f"Catalog/cache {kind} mismatch for {slug}")
    for suffix, spec in receipt["outputs"].items():
        if (spec.get("width"), spec.get("height")) != (2048, 2048):
            raise ValueError(f"Unexpected cache dimensions for {slug} {suffix}")
        verify_source(spec, f"{slug} {suffix}")
    return receipt


def artifact_manifest(output_root: Path, era: dict) -> Path:
    """One verified raster revision per era, the rule prepare_public.py already applies."""
    slug = era["slug"]
    revisions = sorted(path for path in (output_root / "rasters" / slug).glob("*") if path.is_dir())
    if len(revisions) != 1:
        raise ValueError(f"Choose one verified raster revision for {slug}, found {len(revisions)}")
    manifest_path = revisions[0] / str(era["snapshotId"]) / "manifest.json"
    manifest = read(manifest_path)
    if manifest["snapshotId"] != era["snapshotId"] or manifest["snapshot"]["fileHash"] != era["db"]["sha256"]:
        raise ValueError(f"Raster manifest identity mismatch for {slug}")
    return manifest_path


def bind_sources(manifest: dict, receipt: dict, era: dict, slug: str) -> None:
    """The context must name the exact caches and world file this run measured."""
    if manifest["sources"]["worldFile"]["sha256"] != era["fwl"]["sha256"]:
        raise ValueError(f"Context world file is not the archived FWL for {slug}")
    for suffix, name in CACHE_SOURCES:
        if manifest["sources"][name]["sha256"] != receipt["outputs"][suffix]["sha256"]:
            raise ValueError(f"Context {name} is not the generated cache for {slug}")


def build(args: argparse.Namespace) -> None:
    catalog = read(args.catalog)
    eras = {item["slug"]: item for item in catalog["eras"]}
    args.output.mkdir(parents=True, exist_ok=True)
    write(args.output / "status.json", {"state": "building", "updatedAt": now(), "host": args.host})
    completed = []
    for slug in args.eras:
        era = eras[slug]
        context = args.output / slug
        manifest_path = context / "manifest.json"
        if manifest_path.exists():
            manifest = read(manifest_path)
            if manifest["snapshot"]["sha256"] != era["db"]["sha256"]:
                raise ValueError(f"Existing context source mismatch: {slug}")
            require_heightfield(manifest, context)
            for identifier in ("biome-mask", "biome-display-mask"):
                require_variant(manifest, identifier, context)
            completed.append(slug)
            continue
        receipt = cache_receipt(args.terrain_root, era)
        caches = receipt["outputs"]
        world_db = verify_source(receipt["source"]["db"], f"{slug} DB")
        world_file = verify_source(receipt["source"]["fwl"], f"{slug} FWL")
        command = [str(args.python), str(args.build_script),
                   "--world-db", str(world_db),
                   "--world-file", str(world_file),
                   "--map-cache", caches["mapTexCache"]["path"],
                   "--height-cache", caches["heightTexCache"]["path"],
                   "--forest-cache", caches["forestMaskTexCache"]["path"],
                   "--artifact-manifest", str(artifact_manifest(args.output_root, era)),
                   "--output-dir", str(context),
                   "--save-world-name", era["worldId"]]
        context.mkdir(parents=True)
        with (context / "build.log").open("wb") as log:
            subprocess.run(command, check=True, stdout=log, stderr=subprocess.STDOUT)
        manifest = read(manifest_path)
        raw = require_variant(manifest, "biome-mask", context)
        display = require_variant(manifest, "biome-display-mask", context)
        if raw["sha256"] == display["sha256"]:
            raise ValueError(f"Smoothed display mask was not produced for {slug}")
        bind_sources(manifest, receipt, era, slug)
        versions = runtime_versions(Path(receipt["logs"]["player"]["path"]))
        generation = {
            "schema": "steward-terrain-generation/v1", "mode": "current-client",
            **versions, "sourceDbSha256": era["db"]["sha256"],
            "sources": {name: spec["sha256"] for name, spec in manifest["sources"].items()},
            "cacheReceiptSha256": sha256(args.terrain_root / slug / "receipt.json"),
            "generatedAt": now(), "host": args.host,
        }
        receipt_path = context / "generation.json"
        write(receipt_path, generation)
        subprocess.run([str(args.python), str(args.provenance_script),
                        "--context", str(manifest_path), "--receipt", str(receipt_path)], check=True)
        completed.append(slug)
        write(args.output / "status.json", {"state": "building", "updatedAt": now(),
                                            "host": args.host, "completed": completed, "era": slug})
    write(args.output / "status.json", {"state": "complete", "updatedAt": now(),
                                        "host": args.host, "completed": completed})


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--catalog", type=Path, required=True)
    result.add_argument("--output-root", type=Path, required=True,
                        help="Archive processing root holding rasters/")
    result.add_argument("--terrain-root", type=Path, required=True,
                        help="omen_terrain_cache.py session output")
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--python", type=Path, required=True)
    result.add_argument("--build-script", type=Path, required=True)
    result.add_argument("--provenance-script", type=Path, required=True)
    result.add_argument("--eras", nargs="+", required=True)
    result.add_argument("--host", default="OMEN")
    return result


if __name__ == "__main__":
    arguments = parser().parse_args()
    try:
        build(arguments)
    except Exception as error:
        write(arguments.output / "status.json", {"state": "failed", "updatedAt": now(),
                                                 "host": arguments.host, "reason": str(error)[:400]})
        raise
