#!/usr/bin/env python3
"""Run a capture campaign on OMEN, with the game window out of sight.

AM4 has capture_worker.py; this is its Windows sibling, so the two hosts can shoot
different eras at once. The campaign artifacts are identical -- same campaign.json, same
shotKeys, same state.json -- so import_captures.py, make_derivatives.py and
shuttle_masters.py all work against either host's output without knowing which produced it.

Three things differ from the Linux worker, all of them Windows.

The game is launched as an ordinary windowed process, never `-batchmode` and never
through Steam. -batchmode gives no graphics device, which is fine for computing terrain
caches and useless for photographs. Steam updates a game it is asked to launch, and both
hosts are deliberately pinned to a frozen build.

The window is then moved off-screen rather than minimised. The mod renders to an
offscreen target so what the window shows does not matter, but Unity throttles a
minimised app, and a throttled app takes photographs slowly or not at all. Moving it to
negative coordinates keeps it composited and rendering while putting it on no monitor
anyone is looking at.

The live BepInEx tree and Valheim save directory are parked and rebuilt clean for the
run, exactly as omen_terrain_cache.py does, because OMEN's plugins directory is a working
quest runtime and its save directory is a real player's. Both are restored in a finally.

Usage:
  python omen_capture.py --campaign <dir> --output <dir> --game-root <dir>
      --valheim-data <dir> --character <fch> --capture-dll <dll> --portal-dll <dll>
      --world-db <db> --world-fwl <fwl> --terrain-root <dir> [--smoke] [--batch 250]
      [--window offscreen|minimized|normal] [--timeout-minutes 90]
"""
import argparse
import ctypes
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import time

HEADER = ('# cluster_id\tshot\tcam_x\tcam_y\tcam_z\tyaw\tpitch\tenv\ttime\t'
          'aim_x\taim_y\taim_z\tlabel\tmode\tfires\tflash\n')
OFFSCREEN = (-32000, -32000)


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def stamp(path):
    path = Path(path)
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(block)
    return {"bytes": path.stat().st_size, "sha256": h.hexdigest()}


def png_metadata(path):
    """Format boundaries and dimensions only -- the same check the Linux worker makes,
    so a half-written or wrong-resolution frame is never journalled."""
    path = Path(path)
    with path.open("rb") as stream:
        header = stream.read(24)
        stream.seek(-12, 2)
        tail = stream.read(12)
    if header[:8] != b"\x89PNG\r\n\x1a\n" or tail != b"\0\0\0\0IEND\xaeB`\x82":
        raise ValueError("PNG is incomplete")
    return {"bytes": path.stat().st_size, "dimensions": list(struct.unpack(">II", header[16:24]))}


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    for name in ("campaign", "output", "game-root", "valheim-data", "character",
                 "capture-dll", "portal-dll", "world-db", "world-fwl", "terrain-root"):
        p.add_argument("--" + name, type=Path, required=True)
    p.add_argument("--batch", type=int, default=0,
                   help="builds per game launch (default: the campaign's batchSize)")
    p.add_argument("--smoke", action="store_true", help="one build, then stop")
    p.add_argument("--window", choices=("offscreen", "minimized", "normal"),
                   default="offscreen",
                   help="where to put the game window. 'minimized' is offered but Unity "
                        "throttles a minimised app; 'offscreen' keeps it rendering")
    p.add_argument("--window-size", default="",
                   help="WxH for the game window. USUALLY LEAVE THIS ALONE. The mod "
                        "captures with ScreenCapture.CaptureScreenshot(path) and no "
                        "superSize argument (Plugin.cs:2094), so the photograph is the "
                        "backbuffer and its size IS the window size -- a smaller window "
                        "yields smaller frames, which the harvest then rejects. It exists "
                        "for a host whose mod build takes a supersize multiplier, or to "
                        "deliberately shoot an era at another resolution")
    p.add_argument("--graphics", choices=("auto", "vulkan", "d3d11", "d3d12", "glcore"),
                   default="auto",
                   help="which renderer Unity should use. DX11 refuses to switch to a "
                        "resolution larger than the desktop and the game wedges there; "
                        "vulkan does not go through the same swapchain path, so it is "
                        "worth trying on a host whose display is smaller than the "
                        "capture size")
    p.add_argument("--stall-seconds", type=int, default=0,
                   help="give up on a launch after this long with no new photograph "
                        "(default: the campaign's stallSeconds). A slower host needs a "
                        "wider window -- the first shot of a launch also carries the "
                        "one-time environment write, fires sweep and god-mode setup")
    p.add_argument("--timeout-minutes", type=int, default=90)
    return p.parse_args()


def valheim_pids():
    result = subprocess.run(["tasklist", "/FI", "IMAGENAME eq valheim.exe", "/FO", "CSV", "/NH"],
                            capture_output=True, text=True)
    return [line.split('","')[1].strip('"') for line in result.stdout.splitlines()
            if line.startswith('"valheim.exe"')]


def place_window(pid, mode):
    """Move the game's window out of sight without letting Unity throttle it."""
    if mode == "normal":
        return None
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def visit(handle, _):
        owner = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(handle, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(handle):
            length = user32.GetWindowTextLengthW(handle)
            if length:
                found.append(handle)
        return True

    for _ in range(60):
        found.clear()
        user32.EnumWindows(visit, 0)
        if found:
            handle = found[0]
            if mode == "minimized":
                user32.ShowWindow(handle, 6)          # SW_MINIMIZE
            else:
                # SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
                user32.SetWindowPos(handle, None, OFFSCREEN[0], OFFSCREEN[1], 0, 0, 0x0001 | 0x0004 | 0x0010)
            return handle
        time.sleep(1)
    return None


def copy_tree_without_state(source, destination):
    """A clean BepInEx beside the operator's, carrying config and core but no plugins."""
    destination.mkdir(parents=True)
    for candidate in source.iterdir():
        if candidate.name in ("plugins", "LogOutput.log"):
            continue
        if candidate.is_dir():
            shutil.copytree(candidate, destination / candidate.name)
        else:
            shutil.copy2(candidate, destination / candidate.name)
    (destination / "plugins").mkdir()
    (destination / "config").mkdir(exist_ok=True)


def read_receipts(config_dir, capture_root, allowed, width, height):
    """Same acceptance rules as capture_worker.read_receipts: identity, a well-formed run
    id, no path component in the filename, and the exact expected resolution."""
    path = config_dir / "shotplan-receipts.jsonl"
    if not path.exists():
        return []
    import re
    found = []
    for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue                      # the writer may be midway through the last line
        key = (row.get("cluster_id"), row.get("shot"))
        if key not in allowed or row.get("skipped"):
            continue
        if not re.fullmatch(r"\d{8}-\d{6}", str(row.get("run", ""))):
            continue
        name = row.get("file", "")
        if not name or Path(name).name != name:
            continue
        image = capture_root / row["run"] / name
        try:
            metadata = png_metadata(image)
        except (OSError, ValueError, struct.error):
            continue
        if metadata["dimensions"] != [width, height]:
            continue
        found.append((allowed[key], row, image, metadata))
    return found


def main():
    args = parse_args()
    game = args.game_root.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    plan = read(args.campaign / "campaign.json")
    if plan.get("schema") != "steward-local-campaign/v1":
        raise ValueError("Not a local capture campaign")
    width, height = plan["width"], plan["height"]
    batch_size = args.batch or plan["batchSize"]

    if valheim_pids():
        raise RuntimeError("Valheim is already running on OMEN")

    # If a previous run died before its finally could execute -- an ssh session closing
    # takes its children with it on Windows -- the operator's tree is still parked under
    # an .operator-* name and the live tree is the disposable capture one. Put it back
    # before doing anything else, rather than starting a run on top of the wreckage or
    # refusing with "Session backup path already exists" and leaving it parked.
    def recover(live, prefix):
        parent, restored = live.parent, []
        for backup in sorted(parent.glob(prefix + ".operator-*")):
            if live.exists():
                shutil.rmtree(live, ignore_errors=True)
            backup.rename(live)
            restored.append(backup.name)
        return restored

    for live, prefix in ((game / "BepInEx", "BepInEx"),
                         (args.valheim_data.resolve(), args.valheim_data.name)):
        for name in recover(live, prefix):
            print(f"recovered {name} -- a previous run did not restore it", flush=True)

    # Stage every input outside the game tree BEFORE anything is parked. The character
    # lives under the save directory and the capture DLL under BepInEx, both of which are
    # about to be renamed out from under us -- copying from them afterwards reads a path
    # that no longer exists, or worse, one that briefly does.
    staged = output / "session-inputs"
    staged.mkdir(parents=True, exist_ok=True)
    inputs = {}
    for label, source in (("capture", args.capture_dll), ("portal", args.portal_dll),
                          ("character", args.character), ("db", args.world_db),
                          ("fwl", args.world_fwl)):
        source = Path(source)
        if not source.is_file():
            raise ValueError(f"Required input not found: {source}")
        if label in ("db", "fwl"):
            inputs[label] = source          # worlds are large; read them in place
            continue
        target = staged / source.name
        shutil.copy2(source, target)
        if stamp(source) != stamp(target):
            raise ValueError(f"Could not stage session input {source}")
        inputs[label] = target
    terrain = {}
    for suffix in ("mapTexCache", "heightTexCache", "forestMaskTexCache"):
        source = args.terrain_root / f"{plan['world']}_{suffix}"
        if source.is_file():
            target = staged / source.name
            shutil.copy2(source, target)
            terrain[suffix] = target

    state_path = output / "state.json"
    state = read(state_path) if state_path.exists() else {
        "sourceKey": plan["sourceKey"], "completed": {}, "attempts": {}, "status": "prepared"}
    if state["sourceKey"] != plan["sourceKey"]:
        raise ValueError("State belongs to another campaign")

    live_bepinex = game / "BepInEx"
    valheim_data = args.valheim_data.resolve()
    session = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    bepinex_backup = game / f"BepInEx.operator-{session}"
    data_backup = valheim_data.parent / f"Valheim.operator-{session}"
    config_dir = live_bepinex / "config"
    capture_root = config_dir / "comfy-orbit-captures"

    stall_seconds = args.stall_seconds or plan["stallSeconds"]
    builds = plan["builds"][:1] if args.smoke else plan["builds"]
    groups = [(f"batch-{i // batch_size:04d}", builds[i:i + batch_size])
              for i in range(0, len(builds), batch_size)]
    if args.smoke:
        groups = [("smoke", builds)]

    def status(value, **extra):
        state["status"] = value
        write(state_path, state)
        write(output / "status.json", {
            "updatedAt": now(), "state": value, "era": plan["era"], "host": "omen",
            "completedShots": len(state["completed"]),
            "targetShots": sum(len(b["shots"]) for b in plan["builds"]),
            "journalBytes": sum(v["metadata"]["bytes"] for v in state["completed"].values()),
            "freeBytes": shutil.disk_usage(output).free, **extra})

    process = None
    status("starting")
    try:
        if bepinex_backup.exists() or data_backup.exists():
            raise ValueError("Session backup path already exists")
        live_bepinex.rename(bepinex_backup)
        valheim_data.rename(data_backup)
        copy_tree_without_state(bepinex_backup, live_bepinex)
        shutil.copy2(inputs["capture"], live_bepinex / "plugins" / "ComfyCameraProof.dll")
        shutil.copy2(inputs["portal"], live_bepinex / "plugins" / "BetterServerPortals.dll")

        for name, group in groups:
            pending = [{**b, "shots": [s for s in b["shots"]
                                       if s["shotKey"] not in state["completed"]]}
                       for b in group
                       if any(s["shotKey"] not in state["completed"] for s in b["shots"])]
            if not pending:
                continue

            if valheim_data.exists():
                shutil.rmtree(valheim_data)
            worlds = valheim_data / "worlds_local"
            characters = valheim_data / "characters_local"
            worlds.mkdir(parents=True)
            characters.mkdir()
            world = plan["world"]
            shutil.copy2(inputs["db"], worlds / f"{world}.db")
            shutil.copy2(inputs["fwl"], worlds / f"{world}.fwl")
            for source in terrain.values():
                shutil.copy2(source, worlds / source.name)
            shutil.copy2(inputs["character"], characters / inputs["character"].name)

            allowed = {(b["localClusterId"], s["shot"]): s for b in pending for s in b["shots"]}
            (config_dir / "shotplan.tsv").write_text(
                HEADER + "".join(s["tsv"] + "\n" for b in pending for s in b["shots"]),
                encoding="utf-8")
            (config_dir / "shotplan-receipts.jsonl").write_text("", encoding="utf-8")
            write(config_dir / "orbit-request.json",
                  {"world": world, "character": inputs["character"].stem, "quit_when_done": True})

            attempt = output / "runs" / f"{name}-attempt-{state['attempts'].get(name, 0) + 1:02d}"
            attempt.mkdir(parents=True, exist_ok=True)
            state["attempts"][name] = state["attempts"].get(name, 0) + 1
            status("capturing", batch=name, batchTarget=len(allowed), batchShots=0)

            log = (attempt / "stdout.log").open("wb")
            if args.window_size:
                window_w, window_h = args.window_size.lower().split("x")
            else:
                window_w, window_h = width, height
            command = [str(game / "valheim.exe"), "-console", "-screen-fullscreen", "0",
                       "-screen-width", str(window_w), "-screen-height", str(window_h),
                       "-monitor", "1"]
            if args.graphics != "auto":
                command.append("-force-" + args.graphics)
            process = subprocess.Popen(
                command,
                cwd=game, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
            handle = place_window(process.pid, args.window)
            write(attempt / "launch.json", {"pid": process.pid, "window": args.window,
                                            "windowSize": f"{window_w}x{window_h}",
                                            "captureSize": f"{width}x{height}",
                                            "graphics": args.graphics,
                                            "windowFound": bool(handle), "startedAt": now()})

            deadline = time.monotonic() + args.timeout_minutes * 60
            launched = time.monotonic()
            last, stalled_at, first_shot, armed = 0, time.monotonic(), None, None
            while process.poll() is None and time.monotonic() < deadline:
                for shot, row, image, metadata in read_receipts(
                        config_dir, capture_root, allowed, width, height):
                    if shot["shotKey"] in state["completed"]:
                        continue
                    destination = output / "images" / row["run"] / image.name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(image, destination)
                    if stamp(image) != stamp(destination):
                        raise ValueError("Local capture copy mismatch")
                    state["completed"][shot["shotKey"]] = {
                        "file": destination.relative_to(output).as_posix(),
                        "metadata": metadata, "sha256": stamp(destination)["sha256"],
                        "receipt": row}
                    write(state_path, state)
                    image.unlink()
                # Loading a world is not a stall. A slow host can spend minutes on the
                # portal cache and the fires sweep before the first shutter, and timing
                # that against the shot budget declares failure on a run that is working.
                # The clock restarts when the mod actually arms its capture directory.
                if armed is None and capture_root.exists():
                    armed = round(time.monotonic() - launched, 1)
                    stalled_at = time.monotonic()
                    print(f"    world loaded and capture armed after {armed}s", flush=True)
                done = sum(s["shotKey"] in state["completed"] for s in allowed.values())
                if done > last:
                    if first_shot is None:
                        first_shot = round(time.monotonic() - launched, 1)
                        print(f"    first photograph after {first_shot}s", flush=True)
                    last, stalled_at = done, time.monotonic()
                if time.monotonic() - stalled_at > stall_seconds:
                    break
                status("capturing", batch=name, batchTarget=len(allowed), batchShots=done)
                time.sleep(10)

            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=120)
                except subprocess.TimeoutExpired:
                    process.kill()
            log.close()
            process = None
            for source, target in ((live_bepinex / "LogOutput.log", "BepInEx.log"),
                                   (valheim_data / "Player.log", "Player.log"),
                                   (config_dir / "shotplan-receipts.jsonl", "receipts.jsonl")):
                if source.exists():
                    shutil.copy2(source, attempt / target)
            done = sum(s["shotKey"] in state["completed"] for s in allowed.values())
            write(attempt / "result.json", {"completed": done, "expected": len(allowed),
                                            "success": done == len(allowed),
                                            "stallSeconds": stall_seconds,
                                            "armedSeconds": armed,
                                            "firstShotSeconds": first_shot,
                                            "secondsPerShot": round(
                                                (time.monotonic() - launched) / done, 1) if done else None})
            print(f"  {name}: {done}/{len(allowed)} shots", flush=True)
            if args.smoke:
                break
        status("smoke-passed" if args.smoke else "complete")
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
        if bepinex_backup.exists():
            if live_bepinex.exists():
                shutil.rmtree(live_bepinex, ignore_errors=True)
            bepinex_backup.rename(live_bepinex)
        if data_backup.exists():
            if valheim_data.exists():
                shutil.rmtree(valheim_data, ignore_errors=True)
            data_backup.rename(valheim_data)
        print("operator BepInEx and save directory restored", flush=True)


if __name__ == "__main__":
    main()
