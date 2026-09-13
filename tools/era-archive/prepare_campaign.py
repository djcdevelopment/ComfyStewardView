#!/usr/bin/env python3
"""Prepare one era's compare-and-reshoot campaign, end to end, without dispatching it.

    coverage plan  ->  orbit campaign (the build list)  ->  subject gate  ->
    forecast-ranked detail poses (K per build)          ->  refine root for AM4

Every step is an existing tool; this runs them in order with the right paths, under
<output-root>/campaigns/<slug>/, and writes prepare-receipt.json so the dispatch step can
prove what it is about to shoot. Nothing here touches a game.

    python prepare_campaign.py --output-root E:/omen/steward-multi-era --era era1 \\
        --thresholds C:/work/baseline/docs/evidence/2026-09-13-subject-gate-calibration/thresholds.json
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
from archive import REPO, load, now, save

SELFIE = REPO.parent / "baseline" / "tools" / "selfie-stick"
HERE = Path(__file__).resolve().parent


def run(step, command, receipt, cwd=None):
    print(f"== {step}: {' '.join(str(c) for c in command)}", flush=True)
    result = subprocess.run([str(c) for c in command], cwd=cwd, capture_output=True, text=True)
    receipt["steps"].append({"step": step, "exitCode": result.returncode, "command": [str(c) for c in command],
                             "stdout": result.stdout[-4000:], "stderr": result.stderr[-4000:]})
    if result.returncode:
        print(result.stdout[-2000:]); print(result.stderr[-2000:], file=sys.stderr)
        raise RuntimeError(f"{step} exited {result.returncode}")
    tail = (result.stderr or result.stdout).strip().splitlines()
    if tail:
        print("   " + tail[-1], flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--era", required=True, help="era slug, e.g. era1")
    parser.add_argument("--thresholds", type=Path, required=True, help="subject-gate thresholds (steward-subject-gate-thresholds/v1)")
    parser.add_argument("--limit", type=int, default=1000, help="builds queued by the coverage plan")
    parser.add_argument("--frames-per-build", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=250)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--selfie-stick", type=Path, default=SELFIE)
    args = parser.parse_args()
    root = args.output_root.resolve()
    catalog = load(root / "catalog.json")
    era = next((e for e in catalog["eras"] if e["slug"] == args.era), None)
    if era is None or era["ingestion"].get("status") != "verified":
        raise SystemExit(f"{args.era} is not a verified era")
    base = root / "campaigns" / args.era
    base.mkdir(parents=True, exist_ok=True)
    receipt = {"schema": "steward-campaign-prepare/v1", "era": args.era, "sourceKey": era["sourceKey"], "worldId": era["worldId"],
               "startedAt": now(), "framesPerBuild": args.frames_per_build, "batchSize": args.batch_size, "steps": []}
    py = args.python
    coverage = base / "coverage-plan.json"
    run("coverage-plan", [py, HERE / "plan_coverage.py", "--archive-root", root, "--era", args.era, "--out", coverage], receipt)
    orbit = base / "orbit"
    if not (orbit / "campaign.json").exists():
        run("orbit-campaign", [py, HERE / "campaign.py", "--output-root", root, "--era", args.era, "--destination", orbit,
                               "--coverage-plan", coverage, "--limit", args.limit, "--batch-size", args.batch_size], receipt)
    gated = base / "campaign-gated.json"
    run("subject-gate", [py, args.selfie_stick / "subject_gate.py", "gate", "--root", root, "--era", args.era,
                         "--campaign", orbit / "campaign.json", "--thresholds", args.thresholds, "--out", gated], receipt)
    detail = base / "detail"
    run("detail-poses", [py, args.selfie_stick / "plan_detail_shots.py", "--root", root, "--era", args.era,
                         "--campaign", gated, "--out-tsv", detail / "detail.tsv", "--out-json", detail / "detail-plan.json",
                         "--out-campaign", detail / "campaign.json", "--frames-per-build", args.frames_per_build,
                         "--batch-size", args.batch_size, "--below-px-per-m", 100000], receipt)
    refine = base / "refine"
    run("refine-root", [py, HERE / "refine_worker.py", "--prepare", "--root", refine, "--from-root", detail], receipt)
    plan = load(refine / "campaign.json")
    shots = sum(len(b["shots"]) for b in plan["builds"])
    gate = load(base / f"subject-gate-{args.era}.json")
    receipt.update({"completedAt": now(), "builds": len(plan["builds"]), "plannedPoses": shots,
                    "subjectGateRemoved": len(gate["removed"]), "refineRoot": str(refine),
                    "estimatedMasterBytes": shots * 10_600_000, "status": "prepared-not-dispatched"})
    save(base / "prepare-receipt.json", receipt)
    print(f"{args.era}: {len(plan['builds'])} builds, {shots} planned poses ({shots * 10.6 / 1024:.1f} GB of masters on AM4), "
          f"{len(gate['removed'])} builds gated out; refine root {refine} -- NOT dispatched", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
