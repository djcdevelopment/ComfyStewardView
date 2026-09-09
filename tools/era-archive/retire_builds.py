#!/usr/bin/env python3
"""Retire subjects from an installed capture campaign. Standard library only; no network.

A build is retired by emptying its shots array, never by removing its entry. The
supervisor chunks batches by index over plan['builds'] (capture_worker.py:265) and
creates runs/<batch>-attempt-NN with exist_ok=False, so dropping entries would slide a
batch name onto a different build set while state['attempts'] and the existing attempt
directories still describe the old one, and the next launch would collide on mkdir.
unfinished() keeps a build only when it still has an unfinished shot, so an empty shots
array removes it from every future batch and lets targetShots fall honestly.

Already-captured photographs are deleted only for builds named in
deleteCapturedBuildKeys. Their journal rows move to retired.json with receipt and
sha256 intact first, so what was photographed stays provable after the file is gone.
Deletion runs last: a crash before it leaves an orphan PNG, while a crash after a
half-written journal would leave a completed row pointing at nothing, and
Worker.__init__ re-verifies every completed photograph before it will start.

Usage:
  python3 retire_builds.py --root <campaign root> --retire-file retire-<era>.json
                           --reason "..." [--delete-captured] [--dry-run]
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

IDLE = ("stopped", "failed", "complete", "smoke-passed", "prepared")


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


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--retire-file", type=Path, required=True)
    p.add_argument("--reason", required=True)
    p.add_argument("--delete-captured", action="store_true",
                   help="also delete photographs already taken of the builds listed in "
                        "deleteCapturedBuildKeys")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def require_idle(root):
    status_path = root / "status.json"
    if status_path.exists():
        status = read(status_path)
        if status.get("state") not in IDLE:
            raise SystemExit("Campaign is " + str(status.get("state")) + "; stop it first "
                             "(touch " + str(root) + "/STOP) and wait for state: stopped")
        if status.get("gamePid"):
            raise SystemExit("Valheim is still running as pid " + str(status["gamePid"]))


def acquire_lock(root):
    """The single-writer guard capture_worker.run holds (capture_worker.py:250).

    fcntl is imported here rather than at module scope for the same reason the
    supervisor does it: the campaign host is Linux, but the planning side is not.
    """
    import fcntl
    lock = (root / "worker.lock").open("a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise SystemExit("The capture supervisor still holds worker.lock")
    return lock


def main():
    args = parse_args()
    root = args.root.resolve()
    retire = read(args.retire_file)
    if retire.get("schema") != "steward-template-retirement/v1":
        raise SystemExit("Not a template retirement list")

    plan = read(root / "campaign.json")
    runtime = read(root / "runtime.json")
    if stamp(root / "campaign.json") != {k: runtime["campaign"][k] for k in ("bytes", "sha256")}:
        raise SystemExit("campaign.json does not match runtime.json; refusing to edit")
    for field in ("sourceKey", "snapshotId", "era"):
        if retire.get(field) != plan.get(field):
            raise SystemExit("Retirement list is for a different " + field)

    require_idle(root)
    lock = acquire_lock(root)

    state = read(root / "state.json")
    completed = state["completed"]
    by_key = {b["buildKey"]: b for b in plan["builds"]}
    wanted = [k for k in retire["retireBuildKeys"] if k in by_key]
    unknown = len(retire["retireBuildKeys"]) - len(wanted)
    deletable = set(retire.get("deleteCapturedBuildKeys", [])) & set(wanted)

    retired_builds, freed, files, pending, captured_kept = [], 0, [], 0, 0
    for key in wanted:
        build = by_key[key]
        shot_keys = [s["shotKey"] for s in build["shots"]]
        done = {s: completed[s] for s in shot_keys if s in completed}
        pending += len(shot_keys) - len(done)
        record = {"buildKey": key, "localClusterId": build["localClusterId"],
                  "pieces": build["pieces"], "membershipSha256": build["membershipSha256"],
                  "shots": build["shots"], "capturedShots": len(done)}
        if args.delete_captured and key in deletable:
            photographs = []
            for shot_key, value in done.items():
                path = (root / value["file"]).resolve()
                if not path.is_relative_to(root):
                    raise SystemExit("Journalled path escapes the campaign: " + value["file"])
                photographs.append(dict(value, shotKey=shot_key))
                if path.exists():
                    freed += path.stat().st_size
                    files.append(path)
            record["deletedPhotographs"] = photographs
        else:
            captured_kept += len(done)
        retired_builds.append(record)

    dropped = {p["shotKey"] for b in retired_builds for p in b.get("deletedPhotographs", [])}
    planned = sum(len(b["shots"]) for b in retired_builds)
    target_before = sum(len(b["shots"]) for b in plan["builds"])
    before = dict(runtime["campaign"])
    summary = {
        "retiredBuilds": len(retired_builds), "notInCampaign": unknown,
        "plannedShotsRemoved": planned, "pendingShotsRemoved": pending,
        "photographsDeleted": len(dropped), "capturedPhotographsKept": captured_kept,
        "bytesFreed": freed,
        "targetShotsBefore": target_before,
        "targetShotsAfter": target_before - planned,
        "completedShotsBefore": len(completed),
        "completedShotsAfter": len(completed) - len(dropped),
    }
    print(json.dumps(summary, indent=2))
    if args.dry_run:
        print("dry run: nothing written")
        return

    # Journal first, then plan, then runtime, then state, then the files themselves.
    prior = read(root / "retired.json") if (root / "retired.json").exists() else None
    write(root / "retired.json", {
        "schema": "steward-retired-subjects/v1",
        "retiredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sourceKey": plan["sourceKey"], "snapshotId": plan["snapshotId"],
        "reason": args.reason, "method": retire.get("method"),
        "families": retire.get("families", []),
        "previous": prior, "builds": retired_builds,
    })
    for build in retired_builds:
        by_key[build["buildKey"]]["shots"] = []
    plan["retiredBuildKeys"] = sorted(set(plan.get("retiredBuildKeys", []))
                                      | {b["buildKey"] for b in retired_builds})
    write(root / "campaign.json", plan)
    runtime["campaign"] = stamp(root / "campaign.json")
    write(root / "runtime.json", runtime)
    if dropped:
        state["completed"] = {k: v for k, v in completed.items() if k not in dropped}
        write(root / "state.json", state)
    removed = 0
    for path in files:
        try:
            path.unlink()
            removed += 1
        except FileNotFoundError:
            pass
    write(root / "prune-receipt.json", {
        "schema": "steward-campaign-prune/v1",
        "prunedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "reason": args.reason, "retirementList": str(args.retire_file),
        "method": retire.get("method"), "params": retire.get("params"),
        "families": [{k: f[k] for k in ("templateKey", "copies", "pieces", "shotsIfKept")}
                     for f in retire.get("families", [])],
        "campaignBefore": before, "campaignAfter": runtime["campaign"],
        "filesUnlinked": removed, **summary,
    })
    print("retired " + str(len(retired_builds)) + " subjects, unlinked " + str(removed)
          + " photographs, freed " + format(freed, ",") + " bytes")


if __name__ == "__main__":
    main()
