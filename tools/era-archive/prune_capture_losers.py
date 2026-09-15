#!/usr/bin/env python3
"""Receipt-first deletion of capture masters that final verdicts did not keep.

The default action writes a candidate receipt and deletes nothing.  ``--execute`` is
accepted only after every selected keeper has a matching relocation receipt and a local,
sha-verified master.  Losers are exact journal paths, never a directory scan or glob.
"""
import argparse
from pathlib import Path
import shlex
import time

from shuttle_masters import (read, write, sha256, safe_master_path, safe_remote_root, select_entries,
                             remote_script, release)


def plan_prune(state_path, worklist_path, relocation_path, masters_dest, remote_root):
    remote_root = safe_remote_root(remote_root)
    state = read(state_path)
    selected, selector = select_entries(state, worklist_path)
    if selector is None:
        raise SystemExit("loser pruning requires an explicit keeper worklist")
    relocation = read(relocation_path)
    if relocation.get("schema") != "steward-master-relocation/v1":
        raise SystemExit("unsupported relocation receipt")
    if (relocation.get("sourceKey") != state.get("sourceKey")
            or relocation.get("remoteRoot") != remote_root
            or relocation.get("selector") != selector):
        raise SystemExit("relocation receipt does not match this campaign and keeper worklist")
    selected_map = {name: entry for name, entry in selected}
    moved = {}
    for item in relocation.get("moved", []):
        name = item.get("file")
        safe_master_path(name, "relocated master")
        if name in moved:
            raise SystemExit(f"duplicate relocated master path: {name}")
        moved[name] = item
    if set(moved) != set(selected_map):
        raise SystemExit("relocation receipt does not cover exactly the final keepers")
    masters_dest = Path(masters_dest).resolve()
    for name, entry in selected:
        local = masters_dest / name
        if (not local.is_file() or local.stat().st_size != entry["metadata"]["bytes"]
                or sha256(local) != entry["sha256"]
                or moved[name].get("sha256") != entry["sha256"]
                or moved[name].get("bytes") != entry["metadata"]["bytes"]):
            raise SystemExit(f"local relocated keeper failed verification: {name}")

    all_entries = {}
    for entry in state["completed"].values():
        name = safe_master_path(entry.get("file"), "campaign master")
        if name in all_entries:
            raise SystemExit(f"campaign journal contains duplicate master path: {name}")
        all_entries[name] = entry
    losers = []
    for name in sorted(set(all_entries) - set(selected_map)):
        entry = all_entries[name]
        losers.append({"file": name, "sha256": entry["sha256"],
                       "bytes": entry["metadata"]["bytes"]})
    return {"schema": "steward-capture-loser-prune/v1", "sourceKey": state["sourceKey"],
            "remoteRoot": remote_root, "selector": selector,
            "relocation": {"path": str(Path(relocation_path).resolve()),
                           "sha256": sha256(relocation_path)},
            "keepersVerified": len(selected), "candidates": losers,
            "candidateBytes": sum(item["bytes"] for item in losers), "executed": False}


def verify_remote(target, root, candidates):
    lines = ["set -e", "cd " + shlex.quote(root), "while IFS=$'\\t' read -r expected name; do",
             "  test -f \"$name\"", "  actual=$(sha256sum -- \"$name\" | cut -d ' ' -f1)",
             "  test \"$actual\" = \"$expected\"", "done <<'STEWARD_PRUNE_EOF'"]
    lines.extend(item["sha256"] + "\t" + item["file"] for item in candidates)
    lines.append("STEWARD_PRUNE_EOF")
    code, _out, errors = remote_script(target, "\n".join(lines) + "\n")
    return None if code == 0 else errors.strip()[:300]


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--worklist", type=Path, required=True)
    parser.add_argument("--relocation", type=Path, required=True)
    parser.add_argument("--masters-dest", type=Path, required=True)
    parser.add_argument("--remote-root", required=True)
    parser.add_argument("--ssh-target", default="homebase")
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--execute", action="store_true",
                        help="verify remote hashes and delete exact candidates; default is dry run")
    return parser.parse_args()


def main():
    args = parse_args()
    receipt = plan_prune(args.state, args.worklist, args.relocation,
                         args.masters_dest, args.remote_root)
    receipt["plannedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write(args.receipt, receipt)
    print(f"{len(receipt['candidates']):,} loser master(s), {receipt['candidateBytes']/1e9:.2f} GB; "
          f"{receipt['keepersVerified']:,} relocated keeper(s) verified")
    if not args.execute:
        print(f"dry run: wrote candidates to {args.receipt}; nothing deleted")
        return 0
    if not receipt["candidates"]:
        receipt["executed"] = True
        receipt["deletedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        receipt["remoteFreeBytes"] = None
        write(args.receipt, receipt)
        print("no loser masters to delete")
        return 0
    error = verify_remote(args.ssh_target, args.remote_root, receipt["candidates"])
    if error:
        raise SystemExit("remote loser verification failed; nothing deleted: " + error)
    free, error = release(args.ssh_target, args.remote_root,
                          [item["file"] for item in receipt["candidates"]])
    if error:
        raise SystemExit("remote delete failed: " + error)
    receipt["executed"] = True
    receipt["deletedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    receipt["remoteFreeBytes"] = free
    write(args.receipt, receipt)
    print(f"deleted {len(receipt['candidates']):,} exact loser path(s); host free {free/1e9:.1f} GB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
