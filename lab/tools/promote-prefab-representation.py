#!/usr/bin/env python3
"""Promote a bounds-only prefab candidate only after gallery metrics clear every gate."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import statistics
from datetime import datetime, timezone
from pathlib import Path

POLICY = {
    "minimumMatchedViewsPerFixture": 3,
    "silhouetteIouMinimum": 0.50,
    "depthOrderingMinimum": 0.80,
    "depthPairMinimum": 500,
    "medianIouImprovementMinimum": 0.15,
    "maximumHoldoutRegression": 0.05,
    "maximumPrimitiveBoxes": 32,
}


def load(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def median(values: list[float]) -> float:
    if not values:
        raise ValueError("metric set is empty")
    return float(statistics.median(values))


def assess(metrics: dict, prefab: str) -> tuple[bool, list[str], dict]:
    if metrics.get("schema") != "steward-prefab-fidelity-metrics/v1":
        raise ValueError("unsupported fidelity metrics schema")
    views = [row for row in metrics.get("views", []) if row.get("prefab") == prefab and row.get("usable") is True]
    for row in views:
        for field in ("baselineSilhouetteIou", "candidateSilhouetteIou"):
            value = float(row.get(field, float("nan")))
            if not math.isfinite(value) or value < 0 or value > 1:
                raise ValueError(f"{row.get('viewId')} has an invalid {field}")
        pairs = int(row.get("depthPairs", 0))
        if pairs < 0:
            raise ValueError(f"{row.get('viewId')} has a negative depth pair count")
        if pairs >= POLICY["depthPairMinimum"]:
            value = float(row.get("candidateDepthOrdering", float("nan")))
            if not math.isfinite(value) or value < 0 or value > 1:
                raise ValueError(f"{row.get('viewId')} has an invalid candidateDepthOrdering")
    failures: list[str] = []
    by_role = {role: [row for row in views if row.get("role") == role] for role in ("tuning", "holdout")}
    for role, rows in by_role.items():
        if len(rows) < POLICY["minimumMatchedViewsPerFixture"]:
            failures.append(f"{role} has {len(rows)} usable views; needs {POLICY['minimumMatchedViewsPerFixture']}")
        if rows and median([float(row["candidateSilhouetteIou"]) for row in rows]) < POLICY["silhouetteIouMinimum"]:
            failures.append(f"{role} median silhouette IoU is below {POLICY['silhouetteIouMinimum']:.2f}")
    depth_rows = [row for row in views if int(row.get("depthPairs", 0)) >= POLICY["depthPairMinimum"]]
    for role, rows in by_role.items():
        qualified = [row for row in rows if int(row.get("depthPairs", 0)) >= POLICY["depthPairMinimum"]]
        if len(qualified) < POLICY["minimumMatchedViewsPerFixture"]:
            failures.append(
                f"{role} has {len(qualified)} depth-qualified views; needs {POLICY['minimumMatchedViewsPerFixture']}"
            )
    for row in depth_rows:
        if float(row.get("candidateDepthOrdering", 0)) < POLICY["depthOrderingMinimum"]:
            failures.append(f"{row.get('viewId')} depth ordering is below {POLICY['depthOrderingMinimum']:.2f}")
    improvements = [float(row["candidateSilhouetteIou"]) - float(row["baselineSilhouetteIou"]) for row in views]
    if improvements and median(improvements) < POLICY["medianIouImprovementMinimum"]:
        failures.append(f"median silhouette improvement is below {POLICY['medianIouImprovementMinimum']:.2f}")
    for row in by_role["holdout"]:
        regression = float(row["baselineSilhouetteIou"]) - float(row["candidateSilhouetteIou"])
        if regression > POLICY["maximumHoldoutRegression"]:
            failures.append(f"{row.get('viewId')} regresses by {regression:.3f}")
    summary = {
        "usableViews": len(views),
        "tuningViews": len(by_role["tuning"]),
        "holdoutViews": len(by_role["holdout"]),
        "depthQualifiedViews": len(depth_rows),
        "medianCandidateSilhouetteIou": round(median([float(row["candidateSilhouetteIou"]) for row in views]), 4) if views else None,
        "medianSilhouetteIouImprovement": round(median(improvements), 4) if improvements else None,
        "minimumQualifiedDepthOrdering": round(min(float(row["candidateDepthOrdering"]) for row in depth_rows), 4) if depth_rows else None,
    }
    return not failures, failures, summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", type=Path, required=True)
    parser.add_argument("--metrics", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--prefab", default="windmill")
    parser.add_argument("--out-catalog", type=Path, required=True)
    parser.add_argument("--out-receipt", type=Path, required=True)
    args = parser.parse_args()

    probe, metrics, catalog = load(args.probe), load(args.metrics), load(args.catalog)
    if probe.get("schema") != "steward-prefab-renderers/v1":
        raise ValueError("unsupported renderer probe schema")
    candidate = next((row for row in probe.get("prefabs", []) if row.get("name") == args.prefab), None)
    if candidate is None:
        raise ValueError(f"prefab absent from probe: {args.prefab}")
    boxes = candidate.get("boxes", [])
    if candidate.get("status") != "candidate" or not boxes or len(boxes) > POLICY["maximumPrimitiveBoxes"]:
        raise ValueError(f"probe candidate is not promotable: status={candidate.get('status')} boxes={len(boxes)}")

    passed, failures, summary = assess(metrics, args.prefab)
    generated = datetime.now(timezone.utc).isoformat()
    probe_sha = hashlib.sha256(args.probe.read_bytes()).hexdigest()
    metrics_sha = hashlib.sha256(args.metrics.read_bytes()).hexdigest()
    receipt = {
        "schema": "steward-prefab-promotion/v1",
        "generatedAt": generated,
        "policy": POLICY,
        "results": [{
            "prefab": args.prefab,
            "hash": int(candidate["hash"]),
            "status": "promoted" if passed else "rejected",
            "reason": "all metric gates passed" if passed else "; ".join(failures),
            "probeSha256": probe_sha,
            "metricsSha256": metrics_sha,
            "metrics": summary,
        }],
    }
    output = copy.deepcopy(catalog)
    if output.get("schema") != "steward-prefab-representations/v1":
        raise ValueError("unsupported representation catalog schema")
    if passed:
        promoted = {
            "name": candidate["name"], "hash": int(candidate["hash"]),
            "semanticClass": "structure", "strategy": "runtime-compound",
            "authority": "valheim-lod0-renderer-bounds+gallery-metrics",
            "defaultVisible": True, "markerAxis": 0.35,
            "animationAxis": candidate.get("animationAxis", "z"),
            "animationPivot": candidate.get("animationPivot", [0, 0, 0]),
            "primitives": [{"path": box.get("path", ""), "animated": bool(box.get("animated")),
                            "matrix": box["matrix"]} for box in boxes],
        }
        output["representations"] = [row for row in output["representations"] if row.get("hash") != promoted["hash"]]
        output["representations"].insert(0, promoted)

    for path in (args.out_catalog, args.out_receipt):
        path.parent.mkdir(parents=True, exist_ok=True)
    args.out_catalog.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    args.out_receipt.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt["results"][0], indent=2))
    if not passed:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
