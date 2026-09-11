#!/usr/bin/env python3
"""Prune the disposable world-save copies inside finished campaigns' attempt directories.

Every capture attempt gets its own `xdg/` tree with a fresh copy of the era's world, so a
campaign that needed several attempts is carrying the same gigabyte save several times
over. The supervisor already removes those copies for successful runs ("only their
disposable save copies are removed", QUIET-CAPTURE.md); attempts that stopped before that
cleanup keep theirs. This prunes exactly those files -- never an attempt directory, never a
log or receipt, never `source/`, never a master -- and only in campaigns named on the
command line that are idle. QUIET-CAPTURE.md's rule stands: an attempt directory is never
deleted, because `state.json` may name it as `activeAttempt` and recovery reads its
`dispatch.json`; every attempt copies fresh worlds from `runtime.sources`, so no old copy
is ever read again.

Two modes in one file. From OMEN (`--ssh-target`) it ships its own source to the capture
host over `bash -s` and runs itself there with `--local`; the remote side is standard
library only, because the campaign host has no duckdb and the campaign roots carry no
copy of this tool. Nothing but `bash -s` is ever in argv, so Git-Bash cannot rewrite a
path (the shuttle_masters.py rule).

Order of writes, as in retire_builds.py: the inventory (bytes, mtime and sha256 per file,
and whether it is byte-identical to a world in `source/`) is written on the host BEFORE
the first unlink, the receipt after; both are copied to --receipt-dir.

Usage (from OMEN):
  MSYS_NO_PATHCONV=1 python prune_run_worlds.py --ssh-target am4 \
      --campaign era9-quiet-20260909 --campaign era14-smoke-20260909T0336Z \
      --extra-root era14-smoke-20260909T0336Z/saves \
      --receipt-dir E:/omen/steward-multi-era/am4-space-20260911 --reason "..." [--dry-run]
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import time
import uuid

# retire_builds.IDLE, copied verbatim: the remote side cannot import it.
IDLE = ("stopped", "failed", "complete", "smoke-passed", "prepared")
# Campaign names that are never pruned by this tool, whatever the allowlist says.
DENY_PREFIXES = ("era11-detail",)
# The only basenames that are world-save copies: <world>.db, <world>.db.old, and the
# game's own <world>_backup_<stamp>.db. Never .fwl (tiny, and the world's identity), never
# the texture caches, never a character.
SAVE_NAME = re.compile(r"^[A-Za-z0-9]+(\.db|\.db\.old|_backup_[A-Za-z0-9_-]+\.db)$")
# Directories an --extra-root may never point into.
NEVER_UNDER = ("source", "images", "staged-worlds", "derivatives")
INVENTORY_SCHEMA = "steward-run-world-inventory/v1"
RECEIPT_SCHEMA = "steward-run-world-prune/v1"
RUN_SCHEMA = "steward-run-world-prune-run/v1"
RESULT_MARKER = "STEWARD_PRUNE_RESULT "
HEREDOC = "STEWARD_PY"


# archive.digest and archive.save, copied verbatim: the remote side runs from stdin with
# nothing beside it.
def digest(path):
    path = Path(path)
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(block)
    return {"bytes": path.stat().st_size, "sha256": h.hexdigest()}


def save(path, document):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    candidate = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    candidate.write_text(json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
                         encoding="utf-8")
    os.replace(candidate, path)


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def campaign_name_ok(name):
    """A bare directory name, and not one of the lanes this tool refuses to touch."""
    return bool(name) and "/" not in name and "\\" not in name and name not in (".", "..") \
        and not name.startswith(DENY_PREFIXES)


def split_extra_root(item, campaigns):
    """'<campaign>/<rel>' -> (campaign, rel); the campaign must be on the allowlist and the
    relative part must stay inside it and outside the directories that hold originals."""
    parts = Path(item.replace("\\", "/")).parts
    if len(parts) < 2 or parts[0] not in campaigns:
        raise SystemExit("extra root must be <allowed campaign>/<relative dir>: " + item)
    rel = parts[1:]
    if any(p in ("..", ".") for p in rel) or rel[0] in NEVER_UNDER:
        raise SystemExit("extra root may not leave the campaign or enter its originals: " + item)
    return parts[0], "/".join(rel)


def world_stem(name):
    return name.split("_backup_")[0].split(".")[0]


def worlds_local_files(base, root):
    """Regular files under any `worlds_local/` directory beneath base, still inside root."""
    found = []
    for dirpath, _dirnames, filenames in os.walk(base, followlinks=False):
        directory = Path(dirpath)
        if directory.name != "worlds_local":
            continue
        for filename in filenames:
            path = directory / filename
            if path.is_symlink() or not path.is_file():
                continue
            try:
                path.resolve().relative_to(root)
            except ValueError:
                continue
            found.append(path)
    return found


def select_world_files(root, extra_roots=()):
    """The world-save copies under runs/<attempt>/xdg/ and under any explicit extra root.

    Pure: no ssh, no deletion. Only files whose parent is `worlds_local`, whose basename is
    a save copy, and (when campaign.json names the world) whose stem is that world.
    """
    root = Path(root).resolve()
    world = None
    plan = root / "campaign.json"
    if plan.exists():
        world = read(plan).get("world")
    candidates = []
    runs = root / "runs"
    if runs.is_dir():
        for attempt in sorted(p for p in runs.iterdir() if p.is_dir() and not p.is_symlink()):
            xdg = attempt / "xdg"
            if xdg.is_dir():
                candidates.extend(worlds_local_files(xdg, root))
    for rel in extra_roots:
        base = root / rel
        if base.is_dir():
            candidates.extend(worlds_local_files(base, root))
    selected = set()
    for path in candidates:
        if not SAVE_NAME.match(path.name):
            continue
        if world and world_stem(path.name) != world:
            continue
        selected.add(path)
    return sorted(selected)


def require_idle(root, name, campaigns):
    """retire_builds.require_idle, plus the allowlist and the state journal's own status."""
    if name not in campaigns or not campaign_name_ok(name):
        raise SystemExit("refusing " + name + ": not an allowed campaign")
    snapshot = {"statusState": None, "gamePid": None, "stateStatus": None, "activeAttempt": None}
    status_path = root / "status.json"
    if status_path.exists():
        status = read(status_path)
        snapshot["statusState"] = status.get("state")
        snapshot["gamePid"] = status.get("gamePid")
        if status.get("state") not in IDLE:
            raise SystemExit("Campaign " + name + " is " + str(status.get("state")) + "; stop it first")
        if status.get("gamePid"):
            raise SystemExit("Valheim is still running for " + name + " as pid " + str(status["gamePid"]))
    state_path = root / "state.json"
    if state_path.exists():
        state = read(state_path)
        snapshot["stateStatus"] = state.get("status")
        snapshot["activeAttempt"] = state.get("activeAttempt")
        if state.get("status") not in IDLE:
            raise SystemExit("Campaign " + name + " journal says " + str(state.get("status")))
    return snapshot


def acquire_lock(root):
    """The single-writer guard capture_worker.run holds (worker.lock, flock). fcntl is
    imported here because the campaign host is Linux and the planning side is not."""
    import fcntl
    lock = (root / "worker.lock").open("a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        lock.close()
        raise SystemExit("The capture supervisor still holds worker.lock under " + str(root))
    return lock


def live_processes(root):
    """Processes that belong to this campaign root: anything whose command line names the
    root, plus a Valheim client whose XDG_CONFIG_HOME sits under it. Root-scoped on purpose:
    another campaign's capture must neither block this one nor be touched by it."""
    found = []
    me = str(os.getpid())
    try:
        out = subprocess.run(["pgrep", "-af", "--", str(root)], capture_output=True, text=True).stdout
    except OSError:
        return found
    for line in out.splitlines():
        line = line.strip()
        if line and line.split()[0] != me:
            found.append(line[:200])
    try:
        pids = subprocess.run(["pgrep", "-x", "valheim.x86_64"], capture_output=True, text=True).stdout.split()
    except OSError:
        pids = []
    for pid in pids:
        try:
            environment = Path("/proc", pid, "environ").read_bytes().split(b"\0")
        except OSError:
            continue
        for item in environment:
            if item.startswith(b"XDG_CONFIG_HOME=") and \
                    item[len(b"XDG_CONFIG_HOME="):].decode(errors="replace").startswith(str(root)):
                found.append(pid + " valheim.x86_64 (XDG_CONFIG_HOME under this campaign)")
    return found


def free_bytes(root):
    return shutil.disk_usage(root).free


def count_attempt_dirs(root):
    runs = Path(root) / "runs"
    return sum(1 for p in runs.iterdir() if p.is_dir()) if runs.is_dir() else 0


def build_inventory(root, name, files, hashed, snapshot, reason):
    root = Path(root)
    sources = []
    source_dir = root / "source"
    if source_dir.is_dir():
        for path in sorted(source_dir.glob("*.db")):
            entry = {"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size}
            if hashed:
                entry["sha256"] = digest(path)["sha256"]
            sources.append(entry)
    known = {s["sha256"] for s in sources if "sha256" in s}
    rows = []
    for path in files:
        stat = path.stat()
        rel = path.relative_to(root)
        row = {"path": rel.as_posix(),
               "attempt": rel.parts[1] if rel.parts[0] == "runs" and len(rel.parts) > 1 else None,
               "bytes": stat.st_size,
               "mtime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime)),
               "mtimeNs": stat.st_mtime_ns}
        if hashed:
            row["sha256"] = digest(path)["sha256"]
            row["identicalToSource"] = row["sha256"] in known
        rows.append(row)
    return {"schema": INVENTORY_SCHEMA, "campaign": name, "root": str(root), "createdAt": now(),
            "reason": reason, "hashed": hashed, "idle": snapshot, "sourceWorlds": sources,
            "files": rows, "fileCount": len(rows), "totalBytes": sum(r["bytes"] for r in rows),
            "freeBytesBefore": free_bytes(root)}


def prune(root, inventory, dry_run, inventory_path=None):
    """Unlink each inventoried file after re-checking it is the file that was inventoried.
    Never removes a directory."""
    root = Path(root)
    before = count_attempt_dirs(root)
    unlinked, freed, skipped = 0, 0, []
    if not dry_run:
        for row in inventory["files"]:
            path = root / row["path"]
            try:
                stat = path.stat()
            except FileNotFoundError:
                skipped.append({"path": row["path"], "why": "missing"})
                continue
            if stat.st_size != row["bytes"] or stat.st_mtime_ns != row["mtimeNs"]:
                skipped.append({"path": row["path"], "why": "changed since inventory"})
                continue
            path.unlink()
            unlinked += 1
            freed += row["bytes"]
    after_free = free_bytes(root)
    return {"schema": RECEIPT_SCHEMA, "campaign": inventory["campaign"], "root": str(root),
            "prunedAt": now(), "reason": inventory["reason"], "dryRun": dry_run,
            "inventory": inventory_path, "filesUnlinked": unlinked, "bytesFreed": freed,
            "skipped": skipped, "attemptDirsBefore": before, "attemptDirsAfter": count_attempt_dirs(root),
            "freeBytesBefore": inventory["freeBytesBefore"], "freeBytesAfter": after_free,
            "freedByDf": after_free - inventory["freeBytesBefore"]}


def run_local(args):
    base = Path(args.base).resolve()
    for name in args.campaign:
        if not campaign_name_ok(name):
            raise SystemExit("refusing " + name + ": not a bare, allowed campaign name")
        if not (base / name).is_dir():
            raise SystemExit("no such campaign under " + str(base) + ": " + name)
    extras = {}
    for item in args.extra_root:
        name, rel = split_extra_root(item, args.campaign)
        extras.setdefault(name, []).append(rel)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    result = {"schema": RUN_SCHEMA, "base": str(base), "dryRun": args.dry_run, "campaigns": {}}
    for name in args.campaign:
        root = base / name
        snapshot = require_idle(root, name, args.campaign)
        lock = acquire_lock(root) if (root / "state.json").exists() else None
        processes = live_processes(root)
        if processes:
            raise SystemExit("processes still belong to " + name + ": " + "; ".join(processes))
        snapshot["liveProcesses"] = processes
        files = select_world_files(root, extras.get(name, ()))
        inventory = build_inventory(root, name, files, not args.no_hash, snapshot, args.reason)
        inventory_path = receipt_path = None
        if not args.dry_run:
            inventory_path = root / ("world-prune-inventory-" + stamp + ".json")
            save(inventory_path, inventory)
        receipt = prune(root, inventory, args.dry_run, str(inventory_path) if inventory_path else None)
        if not args.dry_run:
            receipt_path = root / ("world-prune-receipt-" + stamp + ".json")
            save(receipt_path, receipt)
        if lock:
            lock.close()
        result["campaigns"][name] = {"inventory": inventory, "receipt": receipt,
                                     "inventoryPath": str(inventory_path) if inventory_path else None,
                                     "receiptPath": str(receipt_path) if receipt_path else None}
        line = f"{name}: {inventory['fileCount']} file(s), {inventory['totalBytes'] / 1e9:.2f} GB"
        if args.dry_run:
            line += " (dry run: nothing written)"
        else:
            line += (f"; unlinked {receipt['filesUnlinked']}, freed {receipt['bytesFreed'] / 1e9:.2f} GB,"
                     f" df says {receipt['freedByDf'] / 1e9:.2f} GB; attempt dirs {receipt['attemptDirsBefore']}"
                     f" -> {receipt['attemptDirsAfter']}")
        print(line, file=sys.stderr, flush=True)
    print(RESULT_MARKER + json.dumps(result), flush=True)
    return result


def run_driver(args):
    """Ship this file to the capture host and run it there with --local."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from shuttle_masters import remote_script
    source = Path(__file__).read_text(encoding="utf-8")
    remote_args = ["--local", "--base", args.base, "--reason", args.reason]
    for name in args.campaign:
        remote_args += ["--campaign", name]
    for item in args.extra_root:
        remote_args += ["--extra-root", item]
    if args.dry_run:
        remote_args.append("--dry-run")
    if args.no_hash:
        remote_args.append("--no-hash")
    script = ("set -e\npython3 - " + " ".join(shlex.quote(a) for a in remote_args)
              + " <<'" + HEREDOC + "'\n" + source + "\n" + HEREDOC + "\n")
    code, out, errors = remote_script(args.ssh_target, script)
    sys.stderr.write(errors)
    text = out.decode(errors="replace")
    lines = [l for l in text.splitlines() if l.startswith(RESULT_MARKER)]
    if code or not lines:
        raise SystemExit(f"remote prune failed (exit {code}); nothing was recorded on this side")
    result = json.loads(lines[-1][len(RESULT_MARKER):])
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    suffix = "-dryrun" if args.dry_run else ""
    receipt_dir = Path(args.receipt_dir)
    for name, doc in result["campaigns"].items():
        save(receipt_dir / name / ("world-prune-inventory-" + stamp + suffix + ".json"), doc["inventory"])
        save(receipt_dir / name / ("world-prune-receipt-" + stamp + suffix + ".json"), doc["receipt"])
    summary_path = receipt_dir / ("04-run-worlds" + suffix + "-" + stamp + ".json")
    save(summary_path, result)
    total_files = sum(d["inventory"]["fileCount"] for d in result["campaigns"].values())
    total_bytes = sum(d["inventory"]["totalBytes"] for d in result["campaigns"].values())
    freed = sum(d["receipt"]["bytesFreed"] for d in result["campaigns"].values())
    print(f"{len(result['campaigns'])} campaign(s): {total_files} file(s), {total_bytes / 1e9:.2f} GB"
          + (" would be freed (dry run)" if args.dry_run else f"; freed {freed / 1e9:.2f} GB"))
    print(summary_path)
    return result


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", default="/home/derek/valheim-capture")
    p.add_argument("--campaign", action="append", default=[], help="campaign directory name; repeatable")
    p.add_argument("--extra-root", action="append", default=[],
                   help="<campaign>/<relative dir> to search beside runs/ (e.g. a smoke run's saves/)")
    p.add_argument("--reason", default="duplicate disposable save copies")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--no-hash", action="store_true", help="skip sha256 in the inventory")
    p.add_argument("--ssh-target", help="run on this host (driver mode); omit with --local")
    p.add_argument("--receipt-dir", help="where the driver keeps copies of the receipts")
    p.add_argument("--local", action="store_true", help="run against this machine's filesystem")
    args = p.parse_args(argv)
    if not args.campaign:
        p.error("at least one --campaign is required")
    if args.local == bool(args.ssh_target):
        p.error("use exactly one of --local or --ssh-target")
    if args.ssh_target and not args.receipt_dir:
        p.error("--receipt-dir is required with --ssh-target")
    return args


def main(argv=None):
    args = parse_args(argv)
    return run_local(args) if args.local else run_driver(args)


if __name__ == "__main__":
    main()
