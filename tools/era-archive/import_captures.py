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

# Everything the runner already wrote about how the photograph was taken. The first five
# were the original set; the rest were being captured into state.json and discarded here,
# which is why the era galleries had no run, time, lens, fire or flash facets to build a
# chip row from. Nothing new is measured -- this only stops throwing it away.
RECEIPT_FIELDS = ("clearance", "occluded", "pieces_near_aim", "environment", "time_of_day",
                  "run", "at", "lens_offset_m", "fires", "flash", "flash_bearing_deg")


def shot_distance(receipt):
    """How far the camera stood from what it was aiming at.

    The runner records `lens` (where the camera ended up, after any occlusion recovery)
    and `aim` separately, so the honest distance is between those two rather than the
    planned pose. Returns None when either is missing rather than guessing a default.
    """
    lens = receipt.get("lens") or receipt.get("placed")
    aim = receipt.get("aim")
    if not isinstance(lens, dict) or not isinstance(aim, dict):
        return None
    try:
        return round(sum((float(lens[k]) - float(aim[k])) ** 2 for k in "xyz") ** 0.5, 3)
    except (KeyError, TypeError, ValueError):
        return None


def receipt_reject(receipt):
    """Frames the capture itself already knew were bad.

    No judgement about whether a picture is *good* -- only whether it is a picture of the
    thing at all. `build_valheim_index.py:357` has carried the first three of these for
    months while this importer collected the same fields and ignored them, so era 14 was
    published with 86 frames the runner's own ray test had already called occluded.

    Measured over era 14's 2,089 photographs, the receipt predicts an unusable frame 3-6x
    better than chance: 2.9% of `planned` poses are visually flat against 15.5% of
    `still_blocked`, 12.8% of `occluded`, and 19.1% of cameras that had to climb 45 m or
    more to find a ray. This costs nothing and needs no pixels, so it runs before the
    derivative worklist is written and a rejected frame is never even encoded.
    """
    if receipt.get("skipped"):
        return "skipped by the runner"
    if receipt.get("pieces_near_aim") == 0:
        return "world never loaded"
    if receipt.get("occluded"):
        return "view obstructed"
    if receipt.get("clearance") == "still_blocked":
        return "camera never found a clear ray"
    return None


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
    p.add_argument("--quality", type=Path, default=None,
                   help="quality-<era>.json from score_frames.py. Frames it rejects are "
                        "left out of the manifest; albums it empties say so rather than "
                        "leading with a frame the gate just called unusable.")
    p.add_argument("--keep-rejects", action="store_true",
                   help="measure and journal, but publish everything anyway")
    p.add_argument("--rejects", type=Path, default=None,
                   help="write the per-frame rejection journal and the re-shoot worklist")
    p.add_argument("--worklist", type=Path, default=None,
                   help="also write the source PNG -> derivative id list for the "
                        "thumbnail step, which runs on the capture host")
    return p.parse_args()


def photo_id(slug, build_key, shot):
    """Stable, and inside import_legacy's [A-Za-z0-9_-]+ guard."""
    return f"{slug}-{build_key[:12]}-{shot}"


def collect(root, slug, base, quality=None, gate=True):
    plan = read(root / "campaign.json")
    state = read(root / "state.json")
    if state["sourceKey"] != plan["sourceKey"]:
        raise SystemExit("state.json belongs to another campaign")
    completed = state["completed"]

    verdicts = (quality or {}).get("frames", {})
    builds, worklist, rejects = {}, [], []
    counts = collections.Counter()
    for build in plan["builds"]:
        photos = []
        dropped = []
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
            distance = shot_distance(receipt)
            frame = verdicts.get(identifier, {})
            reason = receipt_reject(receipt) or (
                frame.get("reason") if frame.get("verdict", "keep") != "keep" else None)
            stage = "receipt" if receipt_reject(receipt) else "frame"
            if reason:
                counts["rejected"] += 1
                counts["rejected_" + stage] += 1
                dropped.append({"id": identifier, "stage": stage, "reason": reason,
                                "verdict": frame.get("verdict", stage)})
                if gate:
                    continue
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
                "capture": {k: receipt.get(k) for k in RECEIPT_FIELDS if k in receipt}
                           | ({"shot_distance_m": distance} if distance is not None else {}),
                **({"aesthetic": frame["aesthetic"]} if "aesthetic" in frame else {}),
            })
            worklist.append({"id": identifier, "source": entry["file"],
                             "sha256": entry["sha256"],
                             "dimensions": entry["metadata"]["dimensions"]})
            counts["photographs"] += 1
            if receipt.get("clearance") not in (None, "planned"):
                counts["recovered_pose"] += 1
            if receipt.get("occluded"):
                counts["receipt_occluded"] += 1
        # The weakest bearing led every album: over 522 four-shot era-14 albums, orbit1 is
        # the best frame 10% of the time and the worst 39%. Lead with the best one when
        # the aesthetic head has an opinion, and keep shot order when it does not.
        if any("aesthetic" in p for p in photos):
            photos.sort(key=lambda p: (-p.get("aesthetic", 0.0), p["shot"]))
            counts["ordered_albums"] += 1
        if photos:
            builds[build["buildKey"]] = photos
            counts["albums"] += 1
        elif dropped:
            # Say why rather than leading with a frame the gate just called unusable.
            counts["emptied_albums"] += 1
        if dropped:
            rejects.append({"buildKey": build["buildKey"], "kept": len(photos),
                            "frames": dropped})

    # Builds retired mid-campaign keep their journal rows but lose their shots, so their
    # photographs would otherwise be dropped here. Recover them from the retirement record.
    retired_path = root / "retired.json"
    if retired_path.exists():
        for record in read(retired_path).get("builds", []):
            kept = [s for s in record["shots"] if s["shotKey"] in completed]
            if not kept:
                continue
            counts["retired_albums"] += 1
    return plan, builds, worklist, counts, rejects


def main():
    args = parse_args()
    root = args.root.resolve()
    base = args.base if args.base.endswith("/") else args.base + "/"
    if not base.startswith(("http://", "https://")):
        raise SystemExit("Gallery needs an explicit HTTP origin")
    plan = read(root / "campaign.json")
    slug = plan["era"]
    quality = read(args.quality) if args.quality else None
    if quality and quality.get("era") not in (None, slug):
        raise SystemExit(f"quality file is for {quality['era']}, not {slug}")
    plan, builds, worklist, counts, rejects = collect(root, slug, base, quality,
                                                     gate=not args.keep_rejects)

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
        "rejected": counts["rejected"],
        "emptiedAlbums": counts["emptied_albums"],
        # Albums that had photographs taken and kept none. They are not in `builds`, so
        # without this the projection cannot tell them apart from a build nobody has
        # visited yet -- which is the whole point of saying why an album is empty.
        "rejectedBuilds": sorted(r["buildKey"] for r in rejects if r["kept"] == 0),
        "gate": {"applied": not args.keep_rejects,
                 "quality": str(args.quality) if args.quality else None},
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
    if counts["rejected"]:
        print(f"  {counts['rejected']:,} frames rejected "
              f"({counts['rejected_receipt']:,} by their own capture receipt, "
              f"{counts['rejected_frame']:,} by measurement)"
              + ("  -- NOT applied, --keep-rejects" if args.keep_rejects else ""))
    if counts["emptied_albums"]:
        print(f"  {counts['emptied_albums']:,} album(s) lost every frame and will say so")
    if counts["ordered_albums"]:
        print(f"  {counts['ordered_albums']:,} album(s) ordered best-first")
    if counts["retired_albums"]:
        print(f"  {counts['retired_albums']:,} retired build(s) still hold journalled "
              f"photographs; they are excluded from this manifest by design")
    print(out)

    if args.rejects:
        write(args.rejects, {"schema": "steward-frame-rejects/v1", "era": slug,
                             "gated": not args.keep_rejects,
                             "rejected": counts["rejected"],
                             "emptiedAlbums": counts["emptied_albums"],
                             # Subjects that produced nothing usable. This is a worklist to
                             # read later, not a queue: nothing here re-enters a campaign
                             # that is being captured against right now.
                             "reshoot": sorted(r["buildKey"] for r in rejects
                                               if r["kept"] == 0),
                             "builds": rejects})
        print(args.rejects)

    if args.worklist:
        write(args.worklist, {"schema": "steward-derivative-worklist/v1", "era": slug,
                              "base": base, "items": worklist})
        print(args.worklist)


if __name__ == "__main__":
    main()
