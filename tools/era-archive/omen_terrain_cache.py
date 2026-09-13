#!/usr/bin/env python3
"""Generate current-client Valheim terrain caches from frozen OMEN world copies."""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import time
import zlib

from terrain_caches import (CACHE_SUFFIXES, CURRENT_CACHE_NAMES, HEIGHT_SCALE, MAX_ENCODED_HEIGHT,  # noqa: F401
                            TEXTURE_SIZE, cache_candidates, color_cache_png, complete_cache_set,
                            decompress_cache, freeze_cache_set, height_cache_png, png_bytes, png_chunk,
                            png_size, verify_current_meta, world_numeric_seed)


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def stamp(path: Path) -> dict[str, object]:
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": sha256(path)}


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def valheim_pids() -> list[int]:
    result = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq valheim.exe", "/FO", "CSV", "/NH"],
        text=True, capture_output=True, check=True)
    pids = []
    for line in result.stdout.splitlines():
        fields = [item.strip('"') for item in line.split('","')]
        if fields and fields[0].lower() == "valheim.exe":
            pids.append(int(fields[1]))
    return pids


def verify_file(path: Path, expected: dict[str, object], label: str) -> None:
    if not path.is_file():
        raise ValueError(f"Missing {label}: {path}")
    actual = stamp(path)
    if actual["bytes"] != expected["bytes"] or actual["sha256"] != expected["sha256"]:
        raise ValueError(f"{label} does not match the archive catalog: {path}")


def copy_tree_without_state(source: Path, destination: Path) -> None:
    destination.mkdir()
    for name in ("core", "patchers"):
        candidate = source / name
        if candidate.exists():
            shutil.copytree(candidate, destination / name)
    (destination / "plugins").mkdir()
    (destination / "config").mkdir()


def wait_for_run(worlds: Path, world: str, timeout_seconds: int,
                 process: subprocess.Popen[bytes]) -> dict[str, object]:
    deadline = time.monotonic() + timeout_seconds
    stable = 0
    previous = None
    while time.monotonic() < deadline:
        exited = process.poll() is not None
        cache_set = complete_cache_set(worlds, world)
        if cache_set is not None:
            candidates = list(cache_set["outputs"].values())
            if cache_set.get("meta") is not None:
                candidates.append(cache_set["meta"])
            sizes = tuple(path.stat().st_size for path in candidates)
            stable = stable + 1 if sizes == previous else 0
            previous = sizes
            if exited and stable >= 1:
                break
        elif exited:
            raise RuntimeError(
                f"Valheim PID {process.pid} exited with {process.returncode} before all caches were written for {world}")
        time.sleep(5)
    else:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=15)
        raise TimeoutError(f"Timed out waiting for {world}; stopped only owned Valheim PID {process.pid}")
    return cache_set


def validate_selected(catalog_path: Path, era_slugs: list[str]) -> tuple[dict, list[dict]]:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    eras = {item["slug"]: item for item in catalog["eras"]}
    missing = [slug for slug in era_slugs if slug not in eras]
    if missing:
        raise ValueError(f"Eras absent from catalog: {', '.join(missing)}")
    return catalog, [eras[slug] for slug in era_slugs]


def recover(args: argparse.Namespace, selected: list[dict]) -> int:
    """Promote a fully restored run's parked v1.0 caches without relaunching Valheim."""
    source_data = args.recover_valheim_data.resolve()
    worlds = source_data / "worlds_local"
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    setup = {
        "schema": "steward-omen-terrain-session/v1", "createdAt": now(),
        "mode": "recover", "eras": args.eras, "catalog": stamp(args.catalog.resolve()),
        "recoveredValheimData": str(source_data), "runs": [], "restored": True,
    }
    for era in selected:
        slug, world = era["slug"], era["worldId"]
        verify_file(Path(era["db"]["path"]), era["db"], slug + " DB")
        fwl = Path(era["fwl"]["path"])
        verify_file(fwl, era["fwl"], slug + " FWL")
        cache_set = complete_cache_set(worlds, world)
        if cache_set is None:
            raise ValueError(f"No complete terrain cache set for {world} under {worlds}")
        destination = output / slug / "caches"
        frozen, provenance = freeze_cache_set(cache_set, destination, world, fwl)
        logs = {}
        player_log = source_data / "Player.log"
        if player_log.is_file():
            target = output / slug / "player.log"
            shutil.copy2(player_log, target)
            logs["player"] = stamp(target)
        receipt = {
            "schema": "steward-current-client-terrain-cache/v1", "status": "verified",
            "era": slug, "worldId": world, "sourceKey": era["sourceKey"],
            "snapshotId": era["snapshotId"], "startedAt": now(), "completedAt": now(),
            "source": {"db": era["db"], "fwl": era["fwl"]}, "outputs": frozen,
            "logs": logs, "provenance": provenance,
        }
        write_json(output / slug / "receipt.json", receipt)
        setup["runs"].append(receipt)
    write_json(output / "session.json", setup)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--game-root", type=Path)
    parser.add_argument("--valheim-data", type=Path)
    parser.add_argument("--character", type=Path)
    parser.add_argument("--capture-dll", type=Path)
    parser.add_argument("--portal-dll", type=Path)
    parser.add_argument("--steam", type=Path)
    parser.add_argument("--recover-valheim-data", type=Path,
                        help="Recover completed v1.0 caches from a parked Valheim data directory")
    parser.add_argument("--eras", nargs="+", required=True)
    parser.add_argument("--timeout-minutes", type=int, default=45)
    args = parser.parse_args()

    catalog, selected = validate_selected(args.catalog, args.eras)
    if args.recover_valheim_data is not None:
        return recover(args, selected)
    required = ("game_root", "valheim_data", "character", "capture_dll", "portal_dll", "steam")
    missing = ["--" + name.replace("_", "-") for name in required if getattr(args, name) is None]
    if missing:
        parser.error("normal capture mode requires " + ", ".join(missing))
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    game = args.game_root.resolve()
    live_bepinex = game / "BepInEx"
    valheim_data = args.valheim_data.resolve()
    parent = valheim_data.parent
    session = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    bepinex_backup = game / f"BepInEx.operator-{session}"
    data_backup = parent / f"Valheim.operator-{session}"
    parked_bepinex = game / f"BepInEx.terrain-{session}"
    parked_data = parent / f"Valheim.terrain-{session}"

    if valheim_pids():
        raise RuntimeError("Valheim is already running on OMEN")
    for path in (args.capture_dll, args.portal_dll, args.character, args.steam):
        if not path.is_file():
            raise ValueError(f"Required input not found: {path}")
    for era in selected:
        verify_file(Path(era["db"]["path"]), era["db"], era["slug"] + " DB")
        verify_file(Path(era["fwl"]["path"]), era["fwl"], era["slug"] + " FWL")

    staged_inputs = output / "session-inputs"
    staged_inputs.mkdir(exist_ok=True)
    staged_capture = staged_inputs / "ComfyCameraProof.dll"
    staged_portal = staged_inputs / "BetterServerPortals.dll"
    staged_character = staged_inputs / "tugcorp.fch"
    for source, target in ((args.capture_dll, staged_capture), (args.portal_dll, staged_portal),
                           (args.character, staged_character)):
        shutil.copy2(source, target)
        if sha256(source) != sha256(target):
            raise ValueError(f"Could not stage session input {source}")

    setup = {
        "schema": "steward-omen-terrain-session/v1", "createdAt": now(),
        "eras": args.eras, "catalog": stamp(args.catalog.resolve()),
        "gameRoot": str(game), "valheimData": str(valheim_data),
        "capturePlugin": stamp(args.capture_dll.resolve()),
        "portalPlugin": stamp(args.portal_dll.resolve()),
        "character": stamp(args.character.resolve()), "runs": [], "restored": False,
    }
    write_json(output / "session.json", setup)
    owned_process = None
    try:
        if bepinex_backup.exists() or data_backup.exists():
            raise ValueError("Session backup path already exists")
        live_bepinex.rename(bepinex_backup)
        valheim_data.rename(data_backup)
        copy_tree_without_state(bepinex_backup, live_bepinex)
        shutil.copy2(staged_capture, live_bepinex / "plugins" / "ComfyCameraProof.dll")
        shutil.copy2(staged_portal, live_bepinex / "plugins" / "BetterServerPortals.dll")

        for era in selected:
            slug, world = era["slug"], era["worldId"]
            receipt_path = output / slug / "receipt.json"
            if receipt_path.exists():
                receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                if receipt.get("sourceKey") == era["sourceKey"]:
                    for item in receipt["outputs"].values():
                        verify_file(Path(item["path"]), item, slug + " cached output")
                    setup["runs"].append(receipt)
                    write_json(output / "session.json", setup)
                    continue

            if valheim_data.exists():
                if not data_backup.exists() or valheim_data.resolve() != (parent / "Valheim").resolve():
                    raise RuntimeError("Refusing to remove an unowned Valheim working directory")
                shutil.rmtree(valheim_data)
            worlds = valheim_data / "worlds_local"
            characters = valheim_data / "characters_local"
            worlds.mkdir(parents=True)
            characters.mkdir()
            shutil.copy2(Path(era["db"]["path"]), worlds / f"{world}.db")
            shutil.copy2(Path(era["fwl"]["path"]), worlds / f"{world}.fwl")
            shutil.copy2(staged_character, characters / "tugcorp.fch")
            request = {"world": world, "character": "tugcorp", "quit_when_done": True, "light_dump": True}
            write_json(live_bepinex / "config" / "orbit-request.json", request)
            started_at = now()
            owned_process = subprocess.Popen([
                str(game / "valheim.exe"), "-batchmode", "-console", "-screen-fullscreen", "0",
                "-screen-width", "1280", "-screen-height", "720", "-monitor", "1"],
                cwd=game)
            cache_set = wait_for_run(worlds, world, args.timeout_minutes * 60, owned_process)
            owned_process = None
            destination = output / slug / "caches"
            frozen, provenance = freeze_cache_set(
                cache_set, destination, world, Path(era["fwl"]["path"]))
            logs = {}
            for label, source in (("player", valheim_data / "Player.log"),
                                  ("bepinex", live_bepinex / "LogOutput.log")):
                if source.is_file():
                    target = output / slug / (label + ".log")
                    shutil.copy2(source, target)
                    logs[label] = stamp(target)
            verify_file(Path(era["db"]["path"]), era["db"], slug + " original DB after run")
            verify_file(Path(era["fwl"]["path"]), era["fwl"], slug + " original FWL after run")
            receipt = {
                "schema": "steward-current-client-terrain-cache/v1", "status": "verified",
                "era": slug, "worldId": world, "sourceKey": era["sourceKey"],
                "snapshotId": era["snapshotId"], "startedAt": started_at, "completedAt": now(),
                "source": {"db": era["db"], "fwl": era["fwl"]}, "outputs": frozen,
                "logs": logs, "provenance": provenance,
            }
            write_json(receipt_path, receipt)
            setup["runs"].append(receipt)
            write_json(output / "session.json", setup)
    finally:
        if owned_process is not None and owned_process.poll() is None:
            owned_process.terminate()
            try:
                owned_process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                owned_process.kill()
                owned_process.wait(timeout=15)
        if live_bepinex.exists():
            live_bepinex.rename(parked_bepinex)
        if valheim_data.exists():
            valheim_data.rename(parked_data)
        if bepinex_backup.exists():
            bepinex_backup.rename(live_bepinex)
        if data_backup.exists():
            data_backup.rename(valheim_data)
        setup["restored"] = live_bepinex.exists() and valheim_data.exists()
        setup["restoredAt"] = now()
        setup["parkedSession"] = {"bepInEx": str(parked_bepinex), "valheimData": str(parked_data)}
        write_json(output / "session.json", setup)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
