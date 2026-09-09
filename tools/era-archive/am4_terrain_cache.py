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

    def wait_for_caches(self, worlds: Path, world: str, log) -> dict[str, dict]:
        deadline = time.monotonic() + self.args.timeout_minutes * 60
        previous = None
        stable = 0
        candidates = [worlds / f"{world}_{suffix}" for suffix in CACHE_SUFFIXES]
        while time.monotonic() < deadline:
            if all(path.is_file() for path in candidates):
                sizes = tuple(path.stat().st_size for path in candidates)
                stable = stable + 1 if sizes == previous else 0
                previous = sizes
                if self.process.poll() is not None and stable >= 1:
                    break
            elif self.process.poll() is not None:
                raise RuntimeError(f"Valheim exited {self.process.returncode} before all caches for {world}")
            if self.stopping:
                raise RuntimeError("Terrain worker stopped during an owned game run")
            time.sleep(5)
        else:
            raise TimeoutError(f"Timed out waiting for terrain caches for {world}")
        outputs = {}
        for suffix, path in zip(CACHE_SUFFIXES, candidates):
            dimensions = png_size(path)
            if dimensions != (2048, 2048):
                raise ValueError(f"Unexpected cache dimensions for {suffix}: {dimensions}")
            outputs[suffix] = {"path": str(path), **stamp(path), "width": 2048, "height": 2048}
        return outputs

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
        command = ["./start_game_bepinex.sh", "-batchmode", "-console", "-screen-fullscreen", "0",
                   "-screen-width", "1280", "-screen-height", "720", "-monitor", "1"]
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
        destination.mkdir(parents=True)
        frozen = {}
        for suffix, spec in outputs.items():
            source_path = Path(spec["path"])
            target = destination / source_path.name
            shutil.copy2(source_path, target)
            verify(target, spec, f"frozen {era['slug']} {suffix}")
            frozen[suffix] = {"path": str(target), **stamp(target), "width": 2048, "height": 2048}
        logs = {}
        for label, path in (("player", saves / "Player.log"),
                            ("bepinex", self.game / "BepInEx/LogOutput.log")):
            if path.is_file():
                target = self.root / era["slug"] / f"{label}.log"
                shutil.copy2(path, target)
                logs[label] = {"path": str(target), **stamp(target)}
        receipt = {
            "schema": "steward-current-client-terrain-cache/v1", "status": "verified",
            "host": "AM4", "era": era["slug"], "worldId": world,
            "sourceKey": era["sourceKey"], "snapshotId": era["snapshotId"],
            "startedAt": started, "completedAt": now(), "stagedReceipt": stamp(source / "receipt.json"),
            "source": {kind: staged["files"][kind] for kind in ("db", "fwl")},
            "outputs": frozen, "logs": logs,
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
            handoff = self.wait_for_handoff()
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
    result.add_argument("--capture-status", type=Path, required=True)
    result.add_argument("--capture-service", default="steward-era14-capture.service")
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--game-root", type=Path, required=True)
    result.add_argument("--character", type=Path, required=True)
    result.add_argument("--eras", nargs="+", required=True)
    result.add_argument("--capture-plugin-sha256", required=True)
    result.add_argument("--portal-plugin-sha256", required=True)
    result.add_argument("--poll-seconds", type=int, default=60)
    result.add_argument("--timeout-minutes", type=int, default=45)
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
