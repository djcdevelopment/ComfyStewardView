"""Gate: a fresh creator projection must carry the same DATA as the live release.

Compares every threads/*.json and directory.json (ignoring generatedAt) in a new
gallery.py projection against the sha256 entries in the live release's receipt.json
on FX99. Only presentation files (index.html copies, creators.*, stats/) may differ.
Exit 0 = safe to deploy; exit 1 = projection inputs drifted, stop and ask.

    python tools/era-archive/gate_creators.py --projection E:\\omen\\steward-multi-era\\projections\\<dir>
"""
import argparse, hashlib, json, sys, urllib.request
from pathlib import Path

LIVE = "https://fx99.tail8e749c.ts.net/valheim/creators/"

def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--projection", type=Path, required=True)
    a = ap.parse_args()
    root = a.projection.resolve()
    live = json.loads(urllib.request.urlopen(LIVE + "receipt.json", timeout=60).read())
    live_sha = {f["path"]: f["sha256"] for f in live["files"]}
    local = json.loads((root / "receipt.json").read_text(encoding="utf-8"))
    local_sha = {f["path"]: f["sha256"] for f in local["files"]}

    data_paths = sorted(p for p in local_sha if p.startswith("threads/") and p.endswith(".json"))
    missing = [p for p in data_paths if p not in live_sha]
    changed = [p for p in data_paths if p in live_sha and live_sha[p] != local_sha[p]]
    gone = sorted(p for p in live_sha if p.startswith("threads/") and p not in local_sha)

    # directory.json: identical apart from generatedAt
    d_local = json.loads((root / "directory.json").read_text(encoding="utf-8"))
    d_live = json.loads(urllib.request.urlopen(LIVE + "directory.json", timeout=60).read())
    d_local.pop("generatedAt", None); d_live.pop("generatedAt", None)
    dir_same = d_local == d_live

    pres = sorted(p for p in local_sha if not p.startswith("threads/") and p != "directory.json"
                  and (p not in live_sha or live_sha[p] != local_sha[p]))
    print(f"threads: {len(data_paths)} local, {len(live_sha) - 1 - sum(1 for p in live_sha if not p.startswith('threads/'))} live")
    print(f"  identical: {len(data_paths) - len(missing) - len(changed)}  changed: {len(changed)}  new: {len(missing)}  gone: {len(gone)}")
    print(f"directory.json data identical (ignoring generatedAt): {dir_same}")
    print(f"presentation files that differ from live: {len(pres)} (expected: index.html copies, creators.css/js, stats/*)")
    for p in pres[:8]: print("   ", p)
    ok = not changed and not missing and not gone and dir_same
    print("GATE:", "PASS" if ok else "FAIL")
    if changed[:5]: print("changed threads:", changed[:5])
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
