#!/usr/bin/env python3
"""Build raw and smoothed historical biome contexts after AM4 cache generation."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time


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


def wait_for_caches(status_path: Path, poll_seconds: int) -> dict:
    while True:
        status = read(status_path)
        if status.get("state") == "complete":
            return status
        if status.get("state") == "failed":
            raise RuntimeError(f"Terrain cache worker failed: {status.get('reason', 'unknown')}")
        time.sleep(poll_seconds)


def runtime_versions(player_log: Path) -> dict[str, object]:
    text = player_log.read_text(encoding="utf-8-sig", errors="replace")
    game = re.search(r"Valheim version:\s*([^\s]+)", text)
    unity = re.search(r"Running under Unity v([^\s]+)", text)
    generators = re.findall(r"Worldgenerator version setup:(\d+)", text)
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


def build(args: argparse.Namespace) -> None:
    handoff = wait_for_caches(args.terrain_root / "status.json", args.poll_seconds)
    catalog = read(args.catalog)
    eras = {item["slug"]: item for item in catalog["eras"]}
    args.output.mkdir(parents=True, exist_ok=True)
    write(args.output / "status.json", {"state": "building", "updatedAt": now(), "handoff": handoff})
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
        staged = args.staged_root / f"{slug}-{era['sourceKey']}"
        cache_receipt = read(args.terrain_root / slug / "receipt.json")
        caches = cache_receipt["outputs"]
        command = [str(args.python), str(args.build_script),
                   "--world-db", str(staged / f"{era['worldId']}.db"),
                   "--world-file", str(staged / f"{era['worldId']}.fwl"),
                   "--map-cache", caches["mapTexCache"]["path"],
                   "--height-cache", caches["heightTexCache"]["path"],
                   "--forest-cache", caches["forestMaskTexCache"]["path"],
                   "--artifact-manifest", str(args.manifests / f"{slug}.json"),
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
        versions = runtime_versions(Path(cache_receipt["logs"]["player"]["path"]))
        receipt = {
            "schema": "steward-terrain-generation/v1", "mode": "current-client",
            **versions, "sourceDbSha256": era["db"]["sha256"],
            "sources": {name: spec["sha256"] for name, spec in manifest["sources"].items()},
            "cacheReceiptSha256": sha256(args.terrain_root / slug / "receipt.json"),
            "generatedAt": now(), "host": "AM4",
        }
        generation = context / "generation.json"
        write(generation, receipt)
        subprocess.run([str(args.python), str(args.provenance_script),
                        "--context", str(manifest_path), "--receipt", str(generation)], check=True)
        completed.append(slug)
        write(args.output / "status.json", {"state": "building", "updatedAt": now(),
                                             "completed": completed, "era": slug})
    write(args.output / "status.json", {"state": "complete", "updatedAt": now(),
                                         "completed": completed})


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--catalog", type=Path, required=True)
    result.add_argument("--staged-root", type=Path, required=True)
    result.add_argument("--terrain-root", type=Path, required=True)
    result.add_argument("--manifests", type=Path, required=True)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--python", type=Path, required=True)
    result.add_argument("--build-script", type=Path, required=True)
    result.add_argument("--provenance-script", type=Path, required=True)
    result.add_argument("--eras", nargs="+", required=True)
    result.add_argument("--poll-seconds", type=int, default=60)
    return result


if __name__ == "__main__":
    arguments = parser().parse_args()
    try:
        build(arguments)
    except Exception as error:
        write(arguments.output / "status.json", {"state": "failed", "updatedAt": now(),
                                                  "reason": str(error)[:400]})
        raise
