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
    differing = [p for p in data_paths if p in live_sha and live_sha[p] != local_sha[p]]
    gone = sorted(p for p in live_sha if p.startswith("threads/") and p not in local_sha)

    # The two admitted differences: generatedAt, and a builder's confirmed portrait choice
    # (`portrait` on the record), which the coordinator publishes through this same lane.
    # A thread whose bytes differ is fetched and compared with both stripped; anything
    # else that moved is a data change and fails the gate as before.
    def admitted(doc):
        doc = dict(doc)
        doc.pop("generatedAt", None)
        doc.pop("portrait", None)
        if isinstance(doc.get("builders"), list):
            doc["builders"] = [{k: v for k, v in b.items() if k != "portrait"} for b in doc["builders"]]
        return doc

    changed = []
    portrait_only = []
    for p in differing:
        t_local = json.loads((root / p).read_text(encoding="utf-8"))
        t_live = json.loads(urllib.request.urlopen(LIVE + p, timeout=60).read())
        (portrait_only if admitted(t_local) == admitted(t_live) else changed).append(p)

    # directory.json: identical apart from generatedAt and the portrait choices
    d_local = json.loads((root / "directory.json").read_text(encoding="utf-8"))
    d_live = json.loads(urllib.request.urlopen(LIVE + "directory.json", timeout=60).read())
    dir_same = admitted(d_local) == admitted(d_live)

    pres = sorted(p for p in local_sha if not p.startswith("threads/") and p != "directory.json"
                  and (p not in live_sha or live_sha[p] != local_sha[p]))
    print(f"threads: {len(data_paths)} local, {len(live_sha) - 1 - sum(1 for p in live_sha if not p.startswith('threads/'))} live")
    print(f"  identical: {len(data_paths) - len(missing) - len(changed) - len(portrait_only)}  changed: {len(changed)}  "
          f"portrait only: {len(portrait_only)}  new: {len(missing)}  gone: {len(gone)}")
    print(f"directory.json data identical (ignoring generatedAt and portrait): {dir_same}")
    print(f"presentation files that differ from live: {len(pres)} (expected: index.html copies, creators.css/js, stats/*)")
    for p in pres[:8]: print("   ", p)
    ok = not changed and not missing and not gone and dir_same
    print("GATE:", "PASS" if ok else "FAIL")
    if changed[:5]: print("changed threads:", changed[:5])
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
