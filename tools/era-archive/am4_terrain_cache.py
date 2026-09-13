#!/usr/bin/env python3
"""Generate historical terrain caches on AM4 after photography releases Valheim."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import time

from load_census import load_census
from terrain_caches import CACHE_SUFFIXES as SHARED_CACHE_SUFFIXES, complete_cache_set, freeze_cache_set  # noqa: F401


CACHE_SUFFIXES = ("mapTexCache", "heightTexCache", "forestMaskTexCache")
SAFE_CAPTURE_STOPS = {"output-limit", "disk-reserve"}
CONTROL_FILES = ("orbit-request.json", "shotplan.tsv", "shotplan-receipts.jsonl")


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


def stamp(path: Path) -> dict[str, object]:
    return {"bytes": path.stat().st_size, "sha256": sha256(path)}


def verify(path: Path, expected: dict, label: str) -> None:
    if not path.is_file() or stamp(path) != {key: expected[key] for key in ("bytes", "sha256")}:
        raise ValueError(f"File verification failed for {label}: {path}")


def world_header(path: Path) -> dict[str, int]:
    """The two facts a save declares about itself before any object is read."""
    with path.open("rb") as stream:
        version, _net_time, _user, _next, count = struct.unpack("<idqii", stream.read(28))
    return {"worldVersion": version, "declaredZdos": count}


def game_build(game_root: Path) -> dict[str, object]:
    """Which client this is, from Steam's own manifest and the game assembly -- so two runs
    on different clients can never be mistaken for the same instrument."""
    result: dict[str, object] = {}
    for manifest in (game_root.parents[1] / "appmanifest_892970.acf" if len(game_root.parents) > 1 else None,
                     game_root / "steamapps/appmanifest_892970.acf"):
        if manifest and manifest.is_file():
            import re
            match = re.search(r'"buildid"\s*"(\d+)"', manifest.read_text(encoding="utf-8", errors="replace"))
            if match:
                result["steamBuildId"] = match.group(1)
                result["manifest"] = str(manifest)
            break
    assembly = game_root / "valheim_Data/Managed/assembly_valheim.dll"
    if assembly.is_file():
        result["assemblySha256"] = sha256(assembly)
    return result


def converted_world(worlds: Path, world: str, source: dict, destination: Path) -> dict[str, object]:
    """Keep what the client wrote back on quit: a save rewritten in the client's own format.

    On the 0.221.12 client that is a monolithic current-version .db beside a `<world>_backup_*`
    of the original, and it is the only game-side artefact the archive's decoders can be
    checked against. It is a derived artefact: the catalog's sourceKey still names the
    original bytes, and this receipt points at them."""
    db, fwl = worlds / f"{world}.db", worlds / f"{world}.fwl"
    chunked = worlds / world / "_main.1.db2"
    if chunked.is_file():
        # Valheim 1.0 rewrites the save as a chunk directory. It is not a format the parser
        # reads, and it is a gigabyte, so it is described here and left behind.
        return {"resaved": True, "format": "chunked-db2",
                "files": {name: stamp(worlds / world / name) for name in ("_main.1.db2", "_main.1.fwl2") if (worlds / world / name).is_file()},
                "chunks": sum(1 for _ in (worlds / world).glob("*.chunk")),
                "backups": sorted(p.name for p in worlds.glob(f"{world}_backup_*"))}
    if not db.is_file():
        return {"resaved": False, "reason": "no world file after quit"}
    written = stamp(db)
    if written["sha256"] == source["db"]["sha256"]:
        return {"resaved": False, "reason": "world file unchanged"}
    destination.mkdir(parents=True, exist_ok=True)
    files = {}
    for kind, path in (("db", db), ("fwl", fwl)):
        if path.is_file():
            target = destination / path.name
            shutil.copy2(path, target)
            verify(target, stamp(path), f"converted {world} {kind}")
            files[kind] = {"path": str(target), **stamp(target)}
    header_in = world_header(Path(source["db"]["path"])) if Path(source["db"].get("path", "")).is_file() else {}
    return {"resaved": True, "files": files, "worldVersionOut": world_header(db)["worldVersion"],
            "declaredZdosOut": world_header(db)["declaredZdos"], **{k + "In": v for k, v in header_in.items()},
            "backups": sorted(p.name for p in worlds.glob(f"{world}_backup_*")),
            "chunkSaves": sorted(p.name for p in (worlds / world).glob("*")) if (worlds / world).is_dir() else []}


def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as stream:
        header = stream.read(24)
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError(f"Invalid PNG cache: {path}")
    return struct.unpack(">II", header[16:24])


def capture_handoff(status: dict, service_active: bool, game_active: bool) -> tuple[bool, str]:
    if service_active or game_active:
        return False, "capture-or-game-active"
    state = status.get("state")
    if state == "complete":
        return True, "capture-complete"
    if state == "stopped" and status.get("reason") in SAFE_CAPTURE_STOPS:
        return True, "capture-natural-limit"
    if state == "stopped":
        return False, "operator-stop"
    if state == "failed":
        return False, "capture-failed"
    return False, "capture-not-terminal"


def process_running(name: str) -> bool:
    return subprocess.run(["pgrep", "-x", name], capture_output=True).returncode == 0


def service_active(name: str) -> bool:
    return subprocess.run(
        ["systemctl", "--user", "is-active", "--quiet", name], capture_output=True).returncode == 0


class Worker:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.root = args.output.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.game = args.game_root.resolve()
        self.config = self.game / "BepInEx/config"
        self.catalog = read(args.catalog)
        self.eras = {item["slug"]: item for item in self.catalog["eras"]}
        self.stopping = False
        self.process = None

    def status(self, state: str, **extra: object) -> None:
        write(self.root / "status.json", {"updatedAt": now(), "state": state, **extra})

    def wait_for_handoff(self) -> str:
        while not self.stopping:
            status = read(self.args.capture_status)
            ready, reason = capture_handoff(
                status,
                service_active(self.args.capture_service),
                process_running("valheim.x86_64"),
            )
            if ready:
                return reason
            if reason in ("operator-stop", "capture-failed"):
                raise RuntimeError(f"Refusing terrain handoff after {reason}")
            self.status("waiting-for-photography", capture=status)
            time.sleep(self.args.poll_seconds)
        raise RuntimeError("Terrain worker stopped while waiting for photography")

    def staged_world(self, era: dict) -> tuple[Path, dict]:
        matches = list(self.args.staged_root.glob(f"{era['slug']}-{era['sourceKey']}/receipt.json"))
        if len(matches) != 1:
            raise ValueError(f"Expected one staged world receipt for {era['slug']}, found {len(matches)}")
        receipt = read(matches[0])
        for key in ("era", "sourceKey", "worldId"):
            expected = era["slug"] if key == "era" else era[key]
            if receipt.get(key) != expected:
                raise ValueError(f"Staged {key} mismatch for {era['slug']}")
        directory = matches[0].parent
        for kind in ("db", "fwl"):
            spec = receipt["files"][kind]
            verify(directory / spec["name"], spec, f"{era['slug']} {kind}")
            catalog_spec = era[kind]
            if {key: spec[key] for key in ("bytes", "sha256")} != {
                    key: catalog_spec[key] for key in ("bytes", "sha256")}:
                raise ValueError(f"Catalog/staged {kind} mismatch for {era['slug']}")
        return directory, receipt

    def verify_runtime(self) -> None:
        expected_plugins = {
            "ComfyCameraProof.dll": self.args.capture_plugin_sha256,
            "BetterServerPortals.dll": self.args.portal_plugin_sha256,
        }
        plugin_root = self.game / "BepInEx/plugins"
        actual = {path.name for path in plugin_root.glob("*.dll")}
        if actual != set(expected_plugins):
            raise ValueError(f"Unexpected AM4 plugin set: {sorted(actual)}")
        for name, expected in expected_plugins.items():
            if sha256(plugin_root / name) != expected:
                raise ValueError(f"Plugin hash mismatch: {name}")
        if not self.args.character.is_file():
            raise ValueError(f"Character is missing: {self.args.character}")
        if process_running("valheim.x86_64") or service_active(self.args.capture_service):
            raise RuntimeError("Photography still owns Valheim")

    def wait_for_caches(self, worlds: Path, world: str, log) -> dict[str, object]:
        """Wait for a complete cache set of either generation -- the 0.221 PNG trio beside the
        world, or the 1.0 gzip set under worlds_local/<world>/ -- to stop changing and the
        client to exit. Returns the candidate (format + paths) for freeze_cache_set."""
        deadline = time.monotonic() + self.args.timeout_minutes * 60
        previous = None
        stable = 0
        while time.monotonic() < deadline:
            candidate = complete_cache_set(worlds, world)
            if candidate is not None:
                paths = list(candidate["outputs"].values()) + ([candidate["meta"]] if candidate.get("meta") else [])
                sizes = tuple(path.stat().st_size for path in paths)
                stable = stable + 1 if sizes == previous else 0
                previous = sizes
                if self.process.poll() is not None and stable >= 1:
                    return candidate
            elif self.process.poll() is not None:
                raise RuntimeError(f"Valheim exited {self.process.returncode} before all caches for {world}")
            if self.stopping:
                raise RuntimeError("Terrain worker stopped during an owned game run")
            time.sleep(5)
        raise TimeoutError(f"Timed out waiting for terrain caches for {world}")

    def stop_owned_process(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=120)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=20)

    def run_era(self, era: dict) -> dict:
        receipt_path = self.root / era["slug"] / "receipt.json"
        if receipt_path.exists():
            receipt = read(receipt_path)
            if receipt.get("sourceKey") != era["sourceKey"]:
                raise ValueError(f"Existing receipt source mismatch for {era['slug']}")
            for suffix, spec in receipt["outputs"].items():
                verify(Path(spec["path"]), spec, f"existing {era['slug']} {suffix}")
            return receipt

        source, staged = self.staged_world(era)
        attempt = self.root / "runs" / f"{era['slug']}-attempt-01"
        if attempt.exists():
            raise ValueError(f"Unresolved prior attempt exists: {attempt}")
        saves = attempt / "xdg/unity3d/IronGate/Valheim"
        worlds = saves / "worlds_local"
        characters = saves / "characters_local"
        worlds.mkdir(parents=True)
        characters.mkdir()
        world = era["worldId"]
        for kind in ("db", "fwl"):
            spec = staged["files"][kind]
            target = worlds / f"{world}.{kind}"
            shutil.copy2(source / spec["name"], target)
            verify(target, spec, f"working {era['slug']} {kind}")
            target.chmod(0o600)
        character = characters / self.args.character.name
        shutil.copy2(self.args.character, character)
        character.chmod(0o600)

        before = attempt / "control-before"
        before.mkdir()
        present = []
        for name in CONTROL_FILES:
            path = self.config / name
            if path.exists():
                shutil.copy2(path, before / name)
                present.append(name)
        write(attempt / "control-manifest.json", {"present": present})
        write(self.config / "orbit-request.json", {
            "world": world,
            "character": self.args.character.stem,
            "quit_when_done": True,
            "light_dump": True,
        })
        started = now()
        # The capture worker's launch, exactly: on this host -batchmode with a windowed 720p
        # surface segfaults under Vulkan right after asset load (2026-09-13, twice), while the
        # fullscreen launch has carried every photograph. The caches are written on world load
        # whatever is rendered, so nothing is gained by rendering less.
        command = ["./start_game_bepinex.sh", "-console", "-screen-fullscreen", "1",
                   "-screen-width", "3840", "-screen-height", "2160", "-monitor", "1"]
        environment = os.environ.copy()
        environment.update(DISPLAY=":0", SDL_VIDEODRIVER="x11", XDG_CONFIG_HOME=str(attempt / "xdg"))
        with (attempt / "stdout.log").open("wb") as log:
            self.process = subprocess.Popen(command, cwd=self.game, env=environment,
                                            stdin=subprocess.DEVNULL, stdout=log,
                                            stderr=subprocess.STDOUT, start_new_session=True)
            write(attempt / "launch.json", {"pid": self.process.pid, "command": command,
                                             "xdgConfigHome": str(attempt / "xdg")})
            try:
                outputs = self.wait_for_caches(worlds, world, log)
            finally:
                self.stop_owned_process()
                self.process = None

        destination = self.root / era["slug"] / "caches"
        destination.mkdir(parents=True, exist_ok=True)     # a failed attempt may have left it empty
        # The 1.0 client moves the original .fwl to a _backup name on quit; the staged copy is
        # the same bytes and is always there.
        frozen_specs, provenance = freeze_cache_set(outputs, destination, world, source / staged["files"]["fwl"]["name"])
        frozen = {suffix: {"path": str(destination / f"{world}_{suffix}"), **spec} for suffix, spec in frozen_specs.items()}
        logs = {}
        for label, path in (("player", saves / "Player.log"),
                            ("bepinex", self.game / "BepInEx/LogOutput.log")):
            if path.is_file():
                target = self.root / era["slug"] / f"{label}.log"
                shutil.copy2(path, target)
                logs[label] = {"path": str(target), **stamp(target)}
        # The client's own account of the load is the independent witness to the parser's
        # counts. The declared total must be the catalog's; the conversion counters are
        # recorded for the cross-check, not asserted here.
        player_log = saves / "Player.log"
        census = load_census(player_log.read_text(encoding="utf-8", errors="replace")) if player_log.is_file() else {}
        if census.get("declaredZdos") not in (None, era.get("declaredZdos")):
            raise ValueError(f"{era['slug']}: client loaded {census['declaredZdos']:,} objects, "
                             f"catalog declares {era.get('declaredZdos'):,}")
        source_files = {kind: staged["files"][kind] for kind in ("db", "fwl")}
        source_files["db"] = {**source_files["db"], "path": str(source / staged["files"]["db"]["name"])}
        converted = converted_world(worlds, world, source_files, self.root / era["slug"] / "converted")
        if converted.get("resaved") and converted.get("files") and converted.get("format") != "chunked-db2":
            write(self.root / era["slug"] / "converted" / "receipt.json", {
                "schema": "steward-converted-world/v1", "era": era["slug"], "worldId": world,
                "sourceKey": era["sourceKey"], "snapshotId": era["snapshotId"], "host": "AM4",
                "gameVersion": census.get("gameVersion"), "gameBuild": game_build(self.game),
                "writtenAt": now(), **converted})
        receipt = {
            "schema": "steward-current-client-terrain-cache/v1", "status": "verified",
            "host": "AM4", "era": era["slug"], "worldId": world,
            "sourceKey": era["sourceKey"], "snapshotId": era["snapshotId"],
            "startedAt": started, "completedAt": now(), "stagedReceipt": stamp(source / "receipt.json"),
            "source": {kind: staged["files"][kind] for kind in ("db", "fwl")},
            "outputs": frozen, "logs": logs,
            "gameBuild": game_build(self.game), "loadCensus": census, "provenance": provenance,
            "convertedWorld": converted if converted.get("resaved") else None,
        }
        write(receipt_path, receipt)
        scratch = attempt / "xdg"
        if not scratch.resolve().is_relative_to((self.root / "runs").resolve()):
            raise ValueError("Unsafe terrain scratch path")
        shutil.rmtree(scratch)
        return receipt

    def restore_controls(self) -> None:
        attempts = sorted((self.root / "runs").glob("*/control-manifest.json"))
        if not attempts:
            return
        manifest = read(attempts[0])
        before = attempts[0].parent / "control-before"
        for name in CONTROL_FILES:
            target = self.config / name
            if name in manifest["present"]:
                shutil.copy2(before / name, target)
            elif target.exists():
                target.unlink()

    def run(self) -> None:
        import fcntl
        with (self.root / "worker.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            signal.signal(signal.SIGTERM, lambda *_: setattr(self, "stopping", True))
            signal.signal(signal.SIGINT, lambda *_: setattr(self, "stopping", True))
            # A campaign hands the game over when it finishes; with no campaign there is
            # nothing to wait for, and verify_runtime() still refuses a live game or service.
            handoff = "no-campaign" if self.args.no_handoff else self.wait_for_handoff()
            self.verify_runtime()
            completed = []
            try:
                for slug in self.args.eras:
                    self.status("generating", era=slug, completed=completed, handoff=handoff)
                    self.run_era(self.eras[slug])
                    completed.append(slug)
            finally:
                self.stop_owned_process()
                self.restore_controls()
            self.status("complete", completed=completed, handoff=handoff)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--catalog", type=Path, required=True)
    result.add_argument("--staged-root", type=Path, required=True)
    result.add_argument("--capture-status", type=Path,
                        help="campaign status.json to wait on; required unless --no-handoff")
    result.add_argument("--no-handoff", action="store_true",
                        help="no photography campaign exists on this host; start once the game and capture service are idle")
    result.add_argument("--capture-service", default="steward-era14-capture.service")
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--game-root", type=Path, required=True)
    result.add_argument("--character", type=Path, required=True)
    result.add_argument("--eras", nargs="+", required=True)
    result.add_argument("--capture-plugin-sha256", required=True)
    result.add_argument("--portal-plugin-sha256", required=True)
    result.add_argument("--poll-seconds", type=int, default=60)
    result.add_argument("--timeout-minutes", type=int, default=60,
                        help="pre-Mistlands saves (v26-28) spend minutes in conversion passes before caches appear")
    return result


if __name__ == "__main__":
    arguments = parser().parse_args()
    worker = Worker(arguments)
    try:
        worker.run()
    except Exception as error:
        worker.stop_owned_process()
        worker.status("failed", reason=str(error)[:400])
        raise
