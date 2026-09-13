#!/usr/bin/env python3
"""Prune a build's shot poses to the few worth a person's look -- on the host that shot them.

Shutter time is not the bind; 4K volume, network and storage are. So the refine worker shoots
every planned pose (refine.json, steward-refine/v3) and this keeps 1-3 per build before a
single master leaves AM4: only the keepers get derivatives, only their thumbnails travel, and
only the frames a verdict finally keeps are moved as masters.

This is a PRUNER, not a picker. Nothing here can say which of two passing frames is the
better photograph -- the eye kept the planned pose 25:18 against the judge's score on the
43 decided pairs of 2026-09-12, and every automatic ranker tried has failed qualification.
What it does is defensible on the evidence:

  1. drop what the veto condemns (the veto is the judge's job it is good at);
  2. drop near-duplicates (two poses placed within DUPLICATE_M are one photograph);
  3. order the survivors by the planner's pre-shutter forecast (geometry, no image), then
     by the two image statistics the eye favoured (skyFraction 58 %, lumaMean 58 %) -- a
     v0 order to be replaced by a fitted critic once ~150 decided pairs exist;
  4. keep the top --keep; a build with no survivor goes on the reshoot list.

    python rank_frames.py --root <campaign root> [--keep 3] [--out rank-<era>.json]

Writes rank-<era>.json (steward-frame-rank/v1) and derivatives-<era>-keepers.json, the
worklist make_derivatives.py takes, so the next step is exactly:
    make_derivatives.py --root <campaign root> --worklist derivatives-<era>-keepers.json
"""
import argparse
import json
import math
from pathlib import Path
import sys

DUPLICATE_M = 1.0
SKY_CEILING = 0.5       # sky helps up to a point; past it the veto already spoke


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def dist(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


def pose_records(build):
    """Every pose record of a build: v3 lists them under `poses`; v2 has one at top level."""
    poses = build.get("poses")
    return list(poses.values()) if poses else [build]


def candidate_frames(build):
    """Every frame the worker judged for this build, planned pose and any forced re-aim alike."""
    frames = []
    for pose in pose_records(build):
        files = pose.get("files") or {}
        placed = pose.get("placed") or {}
        for name, metrics in (pose.get("metrics") or {}).items():
            file = files.get(name) if files else (pose.get("winnerFile") if name == pose.get("winner") else None)
            frames.append({"name": name, "pose": pose.get("shot"), "file": file,
                           "shotKey": pose.get("winnerShotKey") if name == pose.get("winner") else None,
                           "metrics": metrics, "vetoes": list(metrics.get("vetoes") or []),
                           "forecast": pose.get("forecast"), "placed": placed.get(name)})
    return frames


def forecast_rank(forecast):
    """The planner's own opinion, formed before the shutter from geometry alone."""
    if not forecast:
        return 0.0
    if "rank" in forecast:
        return float(forecast["rank"])
    return float(forecast.get("bboxFill") or 0) * float(forecast.get("inFrameFraction") or 1)


def order_key(frame):
    m = frame["metrics"]
    sky = min(float(m.get("skyFraction") or 0.0), SKY_CEILING)
    return (-forecast_rank(frame.get("forecast")), -sky, -float(m.get("lumaMean") or 0.0), frame["name"])


def rank_build(build, keep):
    frames = candidate_frames(build)
    survivors, dropped = [], []
    for frame in frames:
        if frame["vetoes"]:
            dropped.append({"name": frame["name"], "reason": "vetoed:" + ",".join(frame["vetoes"])})
        elif not frame["file"]:
            dropped.append({"name": frame["name"], "reason": "no master on disk"})
        else:
            survivors.append(frame)
    survivors.sort(key=order_key)
    kept, seen = [], []
    for frame in survivors:
        twin = next((k["name"] for k, where in seen if frame["placed"] and where and dist(frame["placed"], where) < DUPLICATE_M), None)
        if twin:
            dropped.append({"name": frame["name"], "reason": f"duplicate of {twin}"})
            continue
        seen.append((frame, frame["placed"]))
        if len(kept) < keep:
            kept.append(frame)
        else:
            dropped.append({"name": frame["name"], "reason": f"beyond the top {keep}"})
    return {"kept": [{k: f[k] for k in ("name", "pose", "file", "shotKey", "metrics", "forecast")} | {"order": i + 1}
                     for i, f in enumerate(kept)],
            "dropped": dropped, "candidates": len(frames), "reshoot": not kept}


def rank(refine, keep):
    builds = {key: rank_build(build, keep) for key, build in refine["builds"].items()}
    kept = sum(len(b["kept"]) for b in builds.values())
    candidates = sum(b["candidates"] for b in builds.values())
    return {"schema": "steward-frame-rank/v1", "era": refine.get("era"), "sourceKey": refine.get("sourceKey"),
            "keep": keep, "builds": builds,
            "summary": {"builds": len(builds), "candidates": candidates, "kept": kept,
                        "reshoot": sorted(key for key, b in builds.items() if b["reshoot"]),
                        "pairs": sum(1 for b in builds.values() if len(b["kept"]) >= 2)}}


def keepers_worklist(ranking, state, root):
    """The make_derivatives.py worklist for the keepers only, from the campaign's own journal."""
    by_file = {entry["file"]: entry for entry in (state.get("completed") or {}).values()}
    items = []
    for key, build in ranking["builds"].items():
        for frame in build["kept"]:
            entry = by_file.get(frame["file"])
            if not entry:
                continue
            items.append({"id": f"{ranking['era']}-{key[:12]}-{frame['name'].replace('~', '-')}",
                          "source": frame["file"], "sha256": entry["sha256"],
                          "dimensions": entry["metadata"]["dimensions"]})
    return {"schema": "steward-derivative-worklist/v1", "era": ranking["era"], "base": "", "items": items}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, required=True, help="campaign root holding refine.json and state.json")
    parser.add_argument("--keep", type=int, default=3, help="frames kept per build (1-3 is the point)")
    parser.add_argument("--out", type=Path, default=None, help="default <root>/rank-<era>.json")
    args = parser.parse_args()
    root = args.root.resolve()
    refine = read(root / "refine.json")
    if refine.get("schema") not in ("steward-refine/v2", "steward-refine/v3"):
        raise SystemExit(f"unsupported refine schema: {refine.get('schema')}")
    ranking = rank(refine, args.keep)
    out = args.out or root / f"rank-{ranking['era']}.json"
    write(out, ranking)
    state_path = root / "state.json"
    if state_path.exists():
        worklist = keepers_worklist(ranking, read(state_path), root)
        write(root / f"derivatives-{ranking['era']}-keepers.json", worklist)
        print(f"{len(worklist['items'])} keeper masters listed for derivatives", flush=True)
    s = ranking["summary"]
    print(f"{s['builds']} builds, {s['candidates']} frames judged, {s['kept']} kept, "
          f"{s['pairs']} builds reach the light table as pairs, {len(s['reshoot'])} to reshoot -> {out}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
