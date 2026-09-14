#!/usr/bin/env python3
"""Give the /valheim/<era>/ photo gallery an index for an era that was photographed by the
compare-and-reshoot loop.

The per-era gallery (tools/selfie-stick/gallery/index.html, the ERA picker at /valheim/) reads
a `build_valheim_index.py` index: one row per published frame with the facets the page filters
on. That builder walks raw capture folders and needs the masters beside it; the second-pass eras
keep their masters on the capture hosts and publish only derivatives (`publish_captures.py`),
so the index is derived here from the capture manifest instead -- the same photographs, the
same ids, the same receipt facts (`import_captures.py` already carried them across).

With `--archive-root` every row also carries the legacy facets -- kind of place, region, sky,
portal/bed/sign/stand counts, builders, height, footprint, a 2 km-grid area -- computed from the
era's community analysis and package (see `build_facts`). No coordinates and no creator ids are
written, so the output is already in the shape `scrub_index.py` produces for the public copy. `aesthetic` is omitted: these frames were
chosen by rank_frames.py / the light table, and the viewer sorts on pieces when the score is
null. `eras.json` for every era directory (each names itself `current`) is emitted beside it.

    python gallery_index_from_captures.py --manifest captures/era1/captures-era1.json \\
        --campaign campaigns/era1/run/<root>/campaign.json --out captures/era1/index-era1.json
    python gallery_index_from_captures.py eras --root /valheim/ --slugs era1 era2 ... --current era17 --out eras/
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time

# The facet vocabulary (kind of place, areas, perspective) is the legacy builder's, reused so a
# second-pass era filters exactly like the hand-shot ones.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "selfie-stick"))
import build_valheim_index as legacy  # noqa: E402

LANDMARKS = {"PORTAL": "portals", "BED": "beds", "SIGN": "signs", "ITEM_STAND": "item_stands"}


def build_facts(root, entry, build_keys):
    """What build_valheim_index.py read from clusters.json, from the archive instead: piece
    count, bounds, height, footprint, builders and region from the era's community analysis;
    portals/beds/signs/item stands counted inside each build's x/z footprint from the package
    (the legacy scanner's rule -- a portal sits at floor level, not in the piece cells);
    `sky` is the legacy median-height rule. Keyed by buildKey; only the builds asked for."""
    import duckdb
    import community
    from archive import verify_package
    result = community.analyze_era(root, entry)
    zdo = verify_package(root, entry)["zdo"]
    wanted = set(build_keys)
    facts = {}
    for b in result["builds"]:
        if b["buildKey"] not in wanted:
            continue
        bounds = b["bounds"]
        facts[b["buildKey"]] = {
            "pieces": b["pieces"], "height_m": round(bounds["maxY"] - bounds["minY"], 1),
            "footprint_m2": round((bounds["maxX"] - bounds["minX"]) * (bounds["maxZ"] - bounds["minZ"]), 1),
            "builders": len(b.get("contributors") or []), "region": b.get("region") or "in-world",
            "sky": (bounds["minY"] + bounds["maxY"]) / 2 > 500, "score": b.get("score"),
            "center_x": (bounds["minX"] + bounds["maxX"]) / 2, "center_z": (bounds["minZ"] + bounds["maxZ"]) / 2,
            "portals": 0, "beds": 0, "signs": 0, "item_stands": 0, "_bounds": bounds,
        }
    if facts:
        con = duckdb.connect()
        con.execute("CREATE TEMP TABLE box (build_key VARCHAR, min_x DOUBLE, max_x DOUBLE, min_z DOUBLE, max_z DOUBLE)")
        con.executemany("INSERT INTO box VALUES (?, ?, ?, ?, ?)",
                        [(k, f["_bounds"]["minX"] - 2, f["_bounds"]["maxX"] + 2, f["_bounds"]["minZ"] - 2, f["_bounds"]["maxZ"] + 2)
                         for k, f in facts.items()])
        rows = con.execute("""SELECT b.build_key, z.category, count(*) FROM box b
                              JOIN read_parquet(?) z
                                ON z.category IN ('PORTAL','BED','SIGN','ITEM_STAND')
                               AND z.x BETWEEN b.min_x AND b.max_x AND z.z BETWEEN b.min_z AND b.max_z
                              GROUP BY 1, 2""", [Path(zdo).as_posix()]).fetchall()
        for key, category, n in rows:
            facts[key][LANDMARKS[category]] = n
    ranked = sorted(facts.items(), key=lambda kv: (-kv[1]["pieces"], kv[0]))
    for rank, (key, f) in enumerate(ranked, start=1):
        f["cluster_rank"] = rank
        f.pop("_bounds", None)
    return facts


def describe_facts(f):
    """The legacy `describe()` reads clusters.json field names; map ours onto them."""
    return legacy.describe({"portals": f["portals"], "beds": f["beds"], "signs": f["signs"], "item_stands": f["item_stands"],
                            "size_y": f["height_m"], "footprint_m2": f["footprint_m2"], "distinct_creators": f["builders"], "sky": f["sky"]})


def index_from_manifest(manifest, campaign=None, generated=None, facts=None):
    if manifest.get("schema") != "steward-capture-gallery/v1":
        raise ValueError(f"unsupported manifest schema: {manifest.get('schema')}")
    pieces = {}
    if campaign:
        if campaign.get("sourceKey") != manifest.get("sourceKey"):
            raise ValueError("campaign.json belongs to another world")
        pieces = {b["buildKey"]: b.get("pieces") for b in campaign.get("builds", [])}
    if facts:
        for f in facts.values():
            f["kind"] = describe_facts(f)
        # Areas on the legacy 2 km grid, ids by mass rank, labelled after the largest build --
        # every build here is photographed, so the landmark is always one a visitor can open.
        clusters = [{"cluster_id": f["cluster_rank"], "center_x": f["center_x"], "center_z": f["center_z"], "pieces": f["pieces"]}
                    for f in facts.values()]
        names = {str(f["cluster_rank"]): f"{f['kind']} \u00b7 {f['pieces']:,}" for f in facts.values()}
        areas = legacy.assign_areas(clusters, names)
        for f in facts.values():
            f["area_id"], f["area_label"] = areas[f["cluster_rank"]]
    images, facets = [], {k: set() for k in ("environments", "variants", "perspectives", "kinds", "regions", "areas", "flashes")}
    for build_key, photos in manifest["builds"].items():
        for photo in photos:
            capture = photo.get("capture") or {}
            fact = (facts or {}).get(build_key)
            row = {
                "id": photo["id"],
                "cluster_id": build_key[:12],
                "label": (f"{fact['kind']} \u00b7 {fact['pieces']:,}" if fact else None) or photo.get("label") or f"Build {build_key[:8]}",
                "variant": photo["shot"],
                "perspective": legacy.perspective_of(photo["shot"]),
                "source": "verdict" if photo.get("verdict") else ("rank" if photo.get("rank") else "planned"),
                "published": True,
                "environment": capture.get("environment"),
                "time_of_day": capture.get("time_of_day"),
                "occluded": bool(capture.get("occluded")),
                "pieces_near_aim": capture.get("pieces_near_aim"),
                "pieces": (fact or {}).get("pieces") or pieces.get(build_key),
            }
            if fact:
                row.update({k: fact[k] for k in ("kind", "region", "sky", "portals", "beds", "signs", "item_stands", "builders",
                                                 "height_m", "footprint_m2", "cluster_rank", "score", "area_id", "area_label") if k in fact})
            if photo.get("rank"):
                row["rank"] = photo["rank"].get("order")
            images.append(row)
            if row["environment"]:
                facets["environments"].add(row["environment"])
            facets["variants"].add(row["variant"])
            facets["perspectives"].add(row["perspective"])
            for facet, key in (("kinds", "kind"), ("regions", "region"), ("areas", "area_label")):
                if row.get(key):
                    facets[facet].add(row[key])
    images.sort(key=lambda r: (-(r["pieces"] or 0), r["cluster_id"], r.get("rank") or 0, r["variant"]))
    return {
        "generated": int(generated if generated is not None else time.time()),
        "world": manifest["world"],
        "era": manifest["era"],
        "n": len(images),
        "runs": 1,
        "joined": len(images),
        **{k: sorted(v) for k, v in facets.items()},
        "ranked": bool(manifest.get("ranked")),
        "judged": bool(manifest.get("judged")),
        "images": images,
    }


def era_entry(slug, label, route, current_slug):
    """The picker's row: hrefs are absolute under the route; the gallery that lives at the
    route's root (the current era) links to the root itself, as Publish-Gallery.ps1 does."""
    return {"slug": slug, "label": label, "href": route if slug == current_slug else f"{route}{slug}/"}


def eras_manifests(slugs, labels, route, root_slug):
    """One eras.json per directory, each naming itself current, plus the root's."""
    entries = [era_entry(s, labels.get(s, s), route, root_slug) for s in slugs]
    docs = {"": {"current": root_slug, "eras": entries}}
    for s in slugs:
        if s != root_slug:
            docs[s] = {"current": s, "eras": entries}
    return docs


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command")
    one = sub.add_parser("index", help="index.json for one era from its capture manifest")
    one.add_argument("--manifest", type=Path, required=True)
    one.add_argument("--campaign", type=Path, default=None, help="campaign.json of the run, for piece counts")
    one.add_argument("--archive-root", type=Path, default=None,
                     help="the lake; with it every row carries the legacy facets (kind of place, region, areas, landmarks)")
    one.add_argument("--out", type=Path, required=True)
    eras = sub.add_parser("eras", help="eras.json documents for every era directory")
    eras.add_argument("--route", default="/valheim/")
    eras.add_argument("--slugs", nargs="+", required=True, help="in display order")
    eras.add_argument("--labels", default=None, help="JSON map slug -> label; default ComfyEra<n>")
    eras.add_argument("--current", required=True, help="the era served at the route root")
    eras.add_argument("--out", type=Path, required=True, help="directory: <out>/eras.json (root) and <out>/<slug>/eras.json")
    args = parser.parse_args()
    if args.command == "index":
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        campaign = json.loads(args.campaign.read_text(encoding="utf-8")) if args.campaign else None
        facts = None
        if args.archive_root:
            from archive import load
            catalog = load(args.archive_root.resolve() / "catalog.json")
            entry = next(e for e in catalog["eras"] if e["slug"] == manifest["era"])
            facts = build_facts(args.archive_root.resolve(), entry, list(manifest["builds"]))
        doc = index_from_manifest(manifest, campaign, facts=facts)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
        print(f"{doc['era']}: {doc['n']} frames over {len({r['cluster_id'] for r in doc['images']})} builds, "
              f"perspectives {doc['perspectives']}, kinds {doc['kinds']}, regions {doc['regions']}, "
              f"areas {len(doc['areas'])}, environments {len(doc['environments'])} -> {args.out}")
    elif args.command == "eras":
        labels = json.loads(args.labels) if args.labels else {}
        labels = {s: labels.get(s, "ComfyEra" + s[3:] if s.startswith("era") else s) for s in args.slugs}
        for sub_dir, doc in eras_manifests(args.slugs, labels, args.route, args.current).items():
            path = args.out / sub_dir / "eras.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(doc) + "\n", encoding="utf-8")
        print(f"eras.json x {len(args.slugs)} under {args.out} (root current={args.current})")
    else:
        parser.print_help()
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
