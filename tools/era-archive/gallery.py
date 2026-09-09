#!/usr/bin/env python3
"""Publish an allowlisted creator directory and per-era album threads as static files."""
import argparse
from collections import defaultdict
import hashlib
import html
from pathlib import Path
import shutil
from archive import REPO, artifact, load, now, save

# Every one of the 2,747 thread pages shipped the same <title> and no description, so a
# link pasted into Discord -- the channel this archive is actually shared through --
# unfurled identically and imagelessly for every builder. The template carries a default
# block between these markers; each thread gets its own written in.
HEAD_START = "<!-- per-thread head: replaced by gallery.py -->"
HEAD_END = "<!-- /per-thread head -->"


def era_phrase(eras):
    """Collapse era numbers to runs: a nine-era list otherwise renders as nine words."""
    order = sorted(set(eras))
    if not order:
        return ""
    runs = [[order[0], order[0]]]
    for era in order[1:]:
        if era == runs[-1][1] + 1:
            runs[-1][1] = era
        else:
            runs.append([era, era])
    label = "era" if len(order) == 1 else "eras"
    return label + " " + ", ".join(str(a) if a == b else f"{a}–{b}" for a, b in runs)


def first_photograph(eras):
    """The builder's own most-photographed album leads the thread, so lead the unfurl."""
    for era in sorted(eras, reverse=True):
        for build in sorted(eras[era], key=lambda b: (-len(b["photos"]), b["buildKey"])):
            if build["photos"]:
                return build["photos"][0]
    return None


def thread_head(builder, eras, albums, photos):
    name = builder["displayName"]
    title = f"{name} · Comfy builders"
    scope = era_phrase(list(eras))
    description = (
        f"{albums:,} recorded build albums across {scope} · {photos:,} photographs. "
        "Credit follows the creator saved on each construction piece."
        if scope else
        f"{albums:,} recorded build albums · {photos:,} photographs."
    )
    photo = first_photograph(eras)
    tags = [
        f"<title>{html.escape(title)}</title>",
        f'<meta name="description" content="{html.escape(description, quote=True)}">',
        '<meta property="og:type" content="profile">',
        '<meta property="og:site_name" content="Comfy builders">',
        f'<meta property="og:title" content="{html.escape(title, quote=True)}">',
        f'<meta property="og:description" content="{html.escape(description, quote=True)}">',
    ]
    if photo:
        tags += [
            f'<meta property="og:image" content="{html.escape(photo["large"], quote=True)}">',
            f'<meta property="og:image:alt" content="{html.escape(photo["label"], quote=True)}">',
            '<meta name="twitter:card" content="summary_large_image">',
        ]
    else:
        tags.append('<meta name="twitter:card" content="summary">')
    return "\n    ".join(tags)


def with_head(template, block):
    start = template.index(HEAD_START)
    end = template.index(HEAD_END) + len(HEAD_END)
    return template[:start] + block + template[end:]


def project(document, destination, world_url, analysis_root=None):
    destination=Path(destination)
    if not world_url.startswith("https://"):
        raise ValueError("World URL must use HTTPS")
    destination.mkdir(parents=True,exist_ok=True)

    def normalize_int(value):
        if value is None:
            return 0
        if isinstance(value, bool):
            return int(value)
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    def export_participation(path):
        if not path.exists():
            return None
        source = load(path)
        if not isinstance(source, dict):
            return None
        return {
            "schema": "steward-creator-participation-public/v1",
            "generatedAt": source.get("generatedAt", now()),
            "source": source.get("schema", "steward-creator-participation/v1"),
            "participants": normalize_int(source.get("participants", source.get("totalParticipants", source.get("total")))),
            "claims": normalize_int(source.get("claims")),
            "requests": normalize_int(source.get("requests")),
            "openRequests": normalize_int(source.get("openRequests", source.get("pendingRequests"))),
            "sourcePath": "analysis/participation.json",
            "lastUpdatedAt": source.get("updatedAt", source.get("generatedAt")),
        }

    def write_participation_snapshot():
        if analysis_root is None:
            return
        participation = export_participation(analysis_root / "analysis" / "participation.json")
        if participation is None:
            return
        save(destination / "participation.json", participation)

    builds={b["buildKey"]:b for b in document["builds"]}
    directory=[]
    template=(REPO/"tools/era-archive/web/index.html").read_text(encoding="utf-8")
    if HEAD_START not in template or HEAD_END not in template:
        raise ValueError("Template lost its per-thread head markers")
    for builder in document["builders"]:
        if not builder["builds"]: continue
        eras=defaultdict(list)
        for key in builder["builds"]:
            b=builds[key]
            public={k:b[k] for k in ("buildKey","era","slug","label","pieces","contributors","photos")}
            public["attribution"]=b.get("attribution","Every saved construction contributor is credited; nearby ownership is not inferred.")
            public["worldUrl"]=None if b.get("legacyClusterId") is not None else world_url.rstrip("/")+"/?era="+b["slug"]+"&build="+key
            public["terrainStatus"]="historical-gallery" if public["worldUrl"] is None else "awaiting-runtime"
            public["galleryUrl"]=b.get("galleryUrl")
            eras[b["era"]].append(public)
        record={k:builder[k] for k in ("builderKey","displayName","aliases","nameStatus")}
        record.update(eras=sorted(eras,reverse=True),albums=len(builder["builds"]),photos=sum(len(b["photos"]) for bs in eras.values() for b in bs))
        directory.append(record)
        save(destination/"threads"/(builder["builderKey"]+".json"),{**record,"eras":[{"era":e,"albums":sorted(bs,key=lambda b:(-len(b["photos"]),-b["pieces"],b["buildKey"]))} for e,bs in sorted(eras.items(),reverse=True)]})
        page=destination/builder["builderKey"]/"index.html";page.parent.mkdir(parents=True,exist_ok=True)
        head=thread_head(builder,eras,record["albums"],record["photos"])
        page.write_text(with_head(template,head).replace('"./creators.', '"../creators.'),encoding="utf-8")
    # `eras` only covers analysed world saves, so eras 16-17 -- which exist solely as
    # legacy gallery imports and carry photographs -- are absent from it. The page has to
    # say which eras are photographed and which are still being shot, so count from the
    # albums themselves, across every era that produced one.
    era_albums=defaultdict(int);era_shot=defaultdict(int);era_photos=defaultdict(int)
    for b in builds.values():
        era_albums[b["era"]]+=1
        if b["photos"]:
            era_shot[b["era"]]+=1;era_photos[b["era"]]+=len(b["photos"])
    photography={"eras":[{"era":e,"albums":era_albums[e],"albumsWithPhotos":era_shot[e],"photos":era_photos[e]}
            for e in sorted(era_albums)],
        "photos":sum(era_photos.values()),"albumsWithPhotos":sum(era_shot.values()),
        "buildersWithPhotos":sum(1 for r in directory if r["photos"])}
    save(destination/"directory.json",{"schema":"steward-creator-directory/v1","generatedAt":document["generatedAt"],
        "builders":sorted(directory,key=lambda b:(b["displayName"].casefold(),b["builderKey"])),
        "eras":document["eras"],"photography":photography,"unattributedAlbums":sum(not b["contributors"] for b in builds.values()),
        "legacyImports":[{k:r[k] for k in ("slug","images","albums","unresolvedImages")} for r in document["legacyImports"]]})
    (destination/"index.html").write_text(template,encoding="utf-8")
    for name in ("creators.js","creators.css"):
        shutil.copyfile(REPO/"tools/era-archive/web"/name,destination/name)
    # A four-byte file whose query string is the search log: Caddy already records every
    # request as JSON with its URI, so this needs no service, no write path and no store.
    (destination/"search-beacon.txt").write_text("ok\n",encoding="utf-8")
    write_participation_snapshot()
    # Whitelist above deliberately excludes raw character IDs, names from signs, coordinates,
    # source paths, inventories, world seed, snapshot hashes and private identity-review evidence.
    receipt={"schema":"steward-gallery-projection/v1","createdAt":now(),"builders":len(directory),
        "albums":len(builds),"files":[artifact(destination,p) for p in sorted(destination.rglob("*")) if p.is_file() and p.name!="receipt.json"]}
    save(destination/"receipt.json",receipt)
    return receipt


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root",type=Path,required=True)
    parser.add_argument("--destination",type=Path,required=True)
    parser.add_argument("--world-url",required=True)
    args=parser.parse_args()
    if args.destination.exists(): raise ValueError("Use a new immutable projection directory")
    receipt=project(load(args.output_root/"analysis/community-private.json"),args.destination,args.world_url,args.output_root)
    print(f"VERIFIED projection: {receipt['builders']:,} creator threads; {receipt['albums']:,} albums")

if __name__=="__main__":main()
