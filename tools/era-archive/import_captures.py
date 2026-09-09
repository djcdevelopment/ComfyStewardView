#!/usr/bin/env python3
"""Turn a finished capture campaign into photographs the gallery can attach to builds.

Until now nothing could. `community.py` writes `"photos": []` on every modern build and
the only code that ever appends a photo is `import_legacy`, which serves the era16/17
galleries. So the creators site went live with 2,430 of its 2,747 builder threads reading
"0 photos", and every 4K frame AM4 has taken sits on a disk with no route to anyone.

That gap also blinds the planner: `community.py` decides who is already covered by
reading `build["photos"]`, so without this the next projection re-queues every build it
has already photographed.

This reads a campaign's own durable journal -- `campaign.json` for the build identities
and `state.json` for what was actually captured and verified -- and emits a manifest
keyed by real `buildKey`. That is strictly better than the legacy path, which invents a
synthetic album from a photograph's `cluster_id` and credits one "leading contributor";
here the album already exists, with exact membership and every contributor.

Each photograph carries the receipt fields that describe how the shot had to be taken.
`clearance` is the one worth keeping: a camera that had to climb 60 m to find a clear ray
scores 4.821 against 5.470 for a planned pose -- the largest per-frame penalty measured on
this corpus, and the same magnitude as shooting in fog.

Usage:
  python import_captures.py --root <campaign root> --base https://host/valheim/era14/
                            [--out captures-<era>.json] [--worklist derivatives.json]
"""
import argparse
import collections
import json
from pathlib import Path
import re

SAFE_ID = re.compile(r"[A-Za-z0-9_-]+")
RECEIPT_FIELDS = ("clearance", "occluded", "pieces_near_aim", "environment", "time_of_day")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--root", type=Path, required=True, help="campaign root")
    p.add_argument("--base", required=True,
                   help="public URL prefix the derivatives will be published under, "
                        "e.g. https://host/valheim/era14/ -- must be an explicit origin, "
                        "matching import_legacy's rule")
    p.add_argument("--out", type=Path, default=None)
    p.add_argument("--worklist", type=Path, default=None,
                   help="also write the source PNG -> derivative id list for the "
                        "thumbnail step, which runs on the capture host")
    return p.parse_args()


def photo_id(slug, build_key, shot):
    """Stable, and inside import_legacy's [A-Za-z0-9_-]+ guard."""
    return f"{slug}-{build_key[:12]}-{shot}"


def collect(root, slug, base):
    plan = read(root / "campaign.json")
    state = read(root / "state.json")
    if state["sourceKey"] != plan["sourceKey"]:
        raise SystemExit("state.json belongs to another campaign")
    completed = state["completed"]

    builds, worklist = {}, []
    counts = collections.Counter()
    for build in plan["builds"]:
        photos = []
        for shot in build["shots"]:
            entry = completed.get(shot["shotKey"])
            if not entry:
                counts["pending"] += 1
                continue
            name = shot["shot"]
            identifier = photo_id(slug, build["buildKey"], name)
            if not SAFE_ID.fullmatch(identifier):
                raise SystemExit(f"unsafe photo identifier: {identifier}")
            receipt = entry.get("receipt", {})
            photos.append({
                "id": identifier,
                "thumb": base + "thumb/" + identifier + ".webp",
                "large": base + "large/" + identifier + ".webp",
                "href": base + "#build=" + build["buildKey"][:12],
                "label": receipt.get("label") or f"Build {build['buildKey'][:8]}",
                "shot": name,
                # Recorded per photograph, not just per manifest: a host that can only
                # deliver 1080p today gets superseded build by build as better hardware
                # re-shoots, and the projection needs to know which frame is which.
                "width": entry["metadata"]["dimensions"][0],
                "height": entry["metadata"]["dimensions"][1],
                "sha256": entry["sha256"],
                "capture": {k: receipt.get(k) for k in RECEIPT_FIELDS if k in receipt},
            })
            worklist.append({"id": identifier, "source": entry["file"],
                             "sha256": entry["sha256"],
                             "dimensions": entry["metadata"]["dimensions"]})
            counts["photographs"] += 1
            if receipt.get("clearance") not in (None, "planned"):
                counts["recovered_pose"] += 1
            if receipt.get("occluded"):
                counts["receipt_occluded"] += 1
        if photos:
            builds[build["buildKey"]] = photos
            counts["albums"] += 1

    # Builds retired mid-campaign keep their journal rows but lose their shots, so their
    # photographs would otherwise be dropped here. Recover them from the retirement record.
    retired_path = root / "retired.json"
    if retired_path.exists():
        for record in read(retired_path).get("builds", []):
            kept = [s for s in record["shots"] if s["shotKey"] in completed]
            if not kept:
                continue
            counts["retired_albums"] += 1
    return plan, builds, worklist, counts


def main():
    args = parse_args()
    root = args.root.resolve()
    base = args.base if args.base.endswith("/") else args.base + "/"
    if not base.startswith(("http://", "https://")):
        raise SystemExit("Gallery needs an explicit HTTP origin")
    plan = read(root / "campaign.json")
    slug = plan["era"]
    plan, builds, worklist, counts = collect(root, slug, base)

    out = args.out or root / f"captures-{slug}.json"
    write(out, {
        "schema": "steward-capture-gallery/v1",
        "era": slug,
        "sourceKey": plan["sourceKey"],
        "snapshotId": plan["snapshotId"],
        "world": plan["world"],
        "base": base,
        "resolution": [plan["width"], plan["height"]],
        "provisional": [plan["width"], plan["height"]] != [3840, 2160],
        "albums": len(builds),
        "photographs": counts["photographs"],
        "builds": builds,
    })
    print(f"{counts['albums']:,} albums, {counts['photographs']:,} photographs, "
          f"{counts['pending']:,} shots never taken")
    if counts["recovered_pose"]:
        print(f"  {counts['recovered_pose']:,} frames needed a recovered camera pose "
              f"(clearance != planned) -- the largest measured per-frame penalty")
    if counts["receipt_occluded"]:
        print(f"  {counts['receipt_occluded']:,} frames the runner's own ray test called "
              f"occluded (it cannot see player builds, so treat as a floor)")
    if counts["retired_albums"]:
        print(f"  {counts['retired_albums']:,} retired build(s) still hold journalled "
              f"photographs; they are excluded from this manifest by design")
    print(out)

    if args.worklist:
        write(args.worklist, {"schema": "steward-derivative-worklist/v1", "era": slug,
                              "base": base, "items": worklist})
        print(args.worklist)


if __name__ == "__main__":
    main()
