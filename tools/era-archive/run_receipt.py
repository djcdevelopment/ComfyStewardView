#!/usr/bin/env python3
"""Close a driver run: gather what it produced into one receipt and assert the projection is whole.

Invoke-EraArchive.ps1 writes runs/<stamp>/stages.json as it goes; this turns that plus the
intake report, the catalog, the projection's own import records and the integrity check into
runs/<stamp>/run-receipt.json. The one assertion that matters: the projection imported exactly
as many capture manifests as the run manifest names. Fewer means photographs were dropped.
"""
import argparse
from pathlib import Path
import sys
from archive import digest, load, now, save, verified_eras


def community_counts(path):
    document = load(path)
    builds = document.get("builds", [])
    return {"builders": len(document.get("builders", [])), "builds": len(builds),
            "buildsWithPhotos": sum(1 for b in builds if b.get("photos")),
            "photographs": sum(len(b.get("photos", [])) for b in builds),
            "captureImports": [{"era": c.get("era"), "photographs": c.get("photographs"), "manifest": c.get("manifest")}
                               for c in document.get("captureImports", [])],
            "legacyImports": [{"slug": c.get("slug"), "images": c.get("images")} for c in document.get("legacyImports", [])],
            "generatedAt": document.get("generatedAt")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    root, run_dir = args.output_root.resolve(), args.run_dir.resolve()
    stages = load(run_dir / "stages.json")
    manifest = load(args.manifest)
    catalog = load(root / "catalog.json")
    verified = verified_eras(catalog)
    receipt = {"schema": "steward-run-receipt/v1", "stamp": stages["stamp"], "startedAt": stages["startedAt"],
               "completedAt": now(), "manifest": {"path": str(args.manifest), **digest(args.manifest)},
               "stages": stages["stages"], "failures": list(stages.get("failures", [])), "removed": stages.get("removed", []),
               "catalog": {"eras": len(catalog["eras"]), "verified": [e["slug"] for e in verified],
                           "pending": [e["slug"] for e in catalog["eras"] if e not in verified],
                           "readModel": catalog.get("readModel"), "parsers": sorted(catalog.get("parsers", {}))}}
    intake = root / "intake-report.json"
    if intake.exists():
        report = load(intake)
        receipt["intake"] = {"rejected": report.get("rejected", []), "missingSources": report.get("missingSources", []),
                             "accepted": len(report.get("accepted", []))}
    projection = root / "analysis" / "community-private.json"
    if projection.exists():
        counts = community_counts(projection)
        receipt["community"] = counts
        expected = len(manifest.get("captures", []))
        if len(counts["captureImports"]) != expected:
            receipt["failures"].append(f"projection imported {len(counts['captureImports'])} capture manifest(s); "
                                       f"the run manifest names {expected}")
        expected_legacy = 1 if manifest.get("legacyGalleries") else 0
        if bool(counts["legacyImports"]) != bool(expected_legacy):
            receipt["failures"].append("projection legacy imports do not match the run manifest")
    integrity = root / "validation" / "integrity.json"
    if integrity.exists():
        check = load(integrity)
        receipt["integrity"] = {"status": check.get("status"), "verifiedAt": check.get("verifiedAt"),
                                "eras": len(check.get("eras", []))}
    save(run_dir / "run-receipt.json", receipt)
    summary = receipt.get("community", {})
    print(f"RUN {stages['stamp']}: {len(receipt['catalog']['verified'])} verified era(s), "
          f"{summary.get('builders', '?')} builders, {summary.get('photographs', '?')} photographs from "
          f"{len(summary.get('captureImports', []))} capture manifest(s); {len(receipt['removed'])} stale item(s) removed", flush=True)
    for failure in receipt["failures"]:
        print("FAILURE " + failure, file=sys.stderr, flush=True)
    return 1 if receipt["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
