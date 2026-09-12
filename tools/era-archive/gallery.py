#!/usr/bin/env python3
"""Publish an allowlisted creator directory and per-era album threads as static files."""
import argparse
from collections import defaultdict
import hashlib
import html
from pathlib import Path
import re
import shutil
from archive import REPO, artifact, load, now, save

# The closed kinship tag vocabulary, identical to KINSHIP_TAGS in
# tools/era-archive/web/creators.js and to the checkbox values in web/kinship.html. A tag
# outside this list is not a tag this archive publishes -- the coordinator's file may hold
# anything, the public projection holds only these.
KINSHIP_TAGS = (
    "basemate", "collab", "helping-hand", "visitor",
    "mason", "roof", "fields", "portal", "defense", "interior",
)
HEX32 = re.compile(r"^[0-9a-f]{32}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def sanitize_confirmed_tags(items):
    """Coordinator-confirmed kinship tags, stripped to what a public page may carry.

    Everything a volunteer typed -- their handle, their note, a contact address, the claim
    the tag rode in on -- stays in the coordinator's own file. What ships is the join
    (build, contributor, builder), the closed tag vocabulary, and the confirmation stamp.
    Anything malformed is dropped rather than repaired: a tag whose keys do not parse is a
    tag nobody can attach to a build, and publishing it would only leak the fields around it."""
    kept = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        build_key = item.get("buildKey")
        contributor_key = item.get("contributorKey")
        builder_key = item.get("builderKey")
        if not isinstance(build_key, str) or not HEX64.match(build_key):
            continue
        if not isinstance(contributor_key, str) or not HEX32.match(contributor_key):
            continue
        if not isinstance(builder_key, str) or not HEX32.match(builder_key):
            continue
        raw = item.get("tags")
        if not isinstance(raw, list):
            continue
        tags = sorted({t for t in raw if isinstance(t, str) and t in KINSHIP_TAGS})
        if not tags:
            continue
        confirmed_at = item.get("confirmedAt")
        kept.append({
            "buildKey": build_key,
            "contributorKey": contributor_key,
            "builderKey": builder_key,
            "tags": tags,
            "confirmedAt": confirmed_at if isinstance(confirmed_at, str) else None,
        })
    kept.sort(key=lambda tag: (tag["buildKey"], tag["contributorKey"]))
    return kept

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


def classify_volume_tier(pieces):
    """Categorize builder volume across the 5 community scale tiers."""
    if pieces >= 10000:
        return "Megabuilder"
    if pieces >= 2500:
        return "Major Architect"
    if pieces >= 500:
        return "Established Builder"
    if pieces >= 50:
        return "Homesteader"
    return "Explorer"


def is_qualifying_album(build, contributor, min_build_pieces=20, min_builder_pieces=10, min_builder_share=0.05):
    """Retain substantial construction and all photographed frames; prune trail markers."""
    if min_build_pieces <= 0 and min_builder_pieces <= 0:
        return True
    if build.get("photos") or build.get("photoStatus") == "rejected":
        return True
    if build.get("pieces", 0) < min_build_pieces:
        return False
    pieces = contributor.get("pieces") or 0
    share = contributor.get("share") or 0.0
    if pieces >= min_builder_pieces:
        return True
    if pieces >= min_builder_pieces and share >= min_builder_share:
        return True
    if pieces >= 5 and share >= 0.25:
        return True
    if share >= 0.50:
        return True
    return False


def project(document, destination, world_url, analysis_root=None, min_build_pieces=20, min_builder_pieces=10, min_builder_share=0.05):
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
            # A build someone said is not theirs is participation too, and the page counts
            # it separately. Additive: an older coordinator file carries no `disavowals`
            # and reads as zero, and the public schema string does not move for a new count.
            "disavowals": normalize_int(source.get("disavowals")),
            "requests": normalize_int(source.get("requests")),
            "openRequests": normalize_int(source.get("openRequests", source.get("pendingRequests"))),
            "confirmedTags": sanitize_confirmed_tags(source.get("confirmedTags")),
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
    published_build_keys=set()
    for builder in document["builders"]:
        if not builder["builds"]: continue
        eras=defaultdict(list)
        for key in builder["builds"]:
            b=builds[key]
            contributor = next((c for c in b.get("contributors", []) if c.get("builderKey") == builder["builderKey"]), None)
            if contributor is None:
                contributor = {"pieces": b.get("pieces", 0), "share": 1.0}
            if not is_qualifying_album(b, contributor, min_build_pieces, min_builder_pieces, min_builder_share):
                continue
            public={k:b[k] for k in ("buildKey","era","slug","label","pieces","contributors","photos")}
            # "rejected" means photographed and withheld, which the thread must not show as
            # though nobody had visited yet.
            if b.get("photoStatus"):public["photoStatus"]=b["photoStatus"]
            # Bed residency travels as its own key, whitelisted field by field the way
            # sanitize_confirmed_tags() whitelists a tag: the private receipt's residents
            # carry a raw character ID, and a dict copied wholesale is how that reaches a
            # page. Never appended to `contributors` -- a bed is not a credit, and the album
            # above says so in the very next line.
            if b.get("residents"):
                public["residents"]=[{k:r[k] for k in ("builderKey","beds","evidence")} for r in b["residents"]]
            public["attribution"]=b.get("attribution","Every saved construction contributor is credited; nearby ownership is not inferred.")
            public["worldUrl"]=None if b.get("legacyClusterId") is not None else world_url.rstrip("/")+"/?era="+b["slug"]+"&build="+key
            public["terrainStatus"]="historical-gallery" if public["worldUrl"] is None else "awaiting-runtime"
            public["galleryUrl"]=b.get("galleryUrl")
            eras[b["era"]].append(public)
            published_build_keys.add(key)
        if not eras:
            continue
        builder_pieces = sum(
            c["pieces"] for bs in eras.values() for b in bs
            for c in b.get("contributors", []) if c.get("builderKey") == builder["builderKey"] and c.get("pieces")
        )
        album_count = sum(len(bs) for bs in eras.values())
        photo_count = sum(len(b["photos"]) for bs in eras.values() for b in bs)
        record={k:builder[k] for k in ("builderKey","displayName","aliases","nameStatus")}
        record.update(
            eras=sorted(eras,reverse=True),
            albums=album_count,
            photos=photo_count,
            pieces=builder_pieces,
            tier=classify_volume_tier(builder_pieces),
        )
        directory.append(record)
        save(destination/"threads"/(builder["builderKey"]+".json"),{**record,"eras":[{"era":e,"albums":sorted(bs,key=lambda b:(-len(b["photos"]),-b["pieces"],b["buildKey"]))} for e,bs in sorted(eras.items(),reverse=True)]})
        page=destination/builder["builderKey"]/"index.html";page.parent.mkdir(parents=True,exist_ok=True)
        head=thread_head(builder,eras,record["albums"],record["photos"])
        page.write_text(with_head(template,head).replace('"./creators.', '"../creators.').replace('"./kin-tree.js', '"../kin-tree.js').replace('"./pair.js', '"../pair.js').replace('"./portraits.js', '"../portraits.js').replace('"./portrait-picker.js', '"../portrait-picker.js'),encoding="utf-8")
    # `eras` only covers analysed world saves, so eras 16-17 -- which exist solely as
    # legacy gallery imports and carry photographs -- are absent from it. The page has to
    # say which eras are photographed and which are still being shot, so count from the
    # albums themselves, across every era that produced one.
    era_albums=defaultdict(int);era_shot=defaultdict(int);era_photos=defaultdict(int)
    for b in builds.values():
        if b["buildKey"] not in published_build_keys:
            continue
        era_albums[b["era"]]+=1
        if b["photos"]:
            era_shot[b["era"]]+=1;era_photos[b["era"]]+=len(b["photos"])
    photography={"eras":[{"era":e,"albums":era_albums[e],"albumsWithPhotos":era_shot[e],"photos":era_photos[e]}
            for e in sorted(era_albums)],
        "photos":sum(era_photos.values()),"albumsWithPhotos":sum(era_shot.values()),
        "buildersWithPhotos":sum(1 for r in directory if r["photos"])}
    save(destination/"directory.json",{"schema":"steward-creator-directory/v1","generatedAt":document["generatedAt"],
        "builders":sorted(directory,key=lambda b:(b["displayName"].casefold(),b["builderKey"])),
        "eras":document["eras"],"photography":photography,
        # published_build_keys only ever collects builds reached through a builder, and an
        # unattributed build belongs to no builder -- so gating this on it made the count
        # structurally zero and the landing page read "0 additional albums have no saved
        # creator". Count the unattributed builds that clear the same size bar instead.
        "unattributedAlbums":sum(1 for b in builds.values()
            if not b["contributors"] and b.get("pieces",0)>=min_build_pieces),
        "legacyImports":[{k:r[k] for k in ("slug","images","albums","unresolvedImages")} for r in document["legacyImports"]]})
    (destination/"index.html").write_text(template,encoding="utf-8")
    # pair.js is the builder profile's pair view, kin-tree.js draws the kinship tree on
    # both the profile and the kinship page, portraits.js resolves every face on both, and
    # portrait-picker.js is the profile's picker drawer. They are copied unconditionally
    # rather than skipped when absent: a projection that quietly shipped the page without
    # a script would serve a profile whose ribbon selects nothing or whose tree never
    # draws, and the failure would surface as a dead control on the live site instead of here.
    for name in ("creators.js","creators.css","kinship.js","pair.js","kin-tree.js","portraits.js","portrait-picker.js"):
        shutil.copyfile(REPO/"tools/era-archive/web"/name,destination/name)
    # The two other shells. Each is served from its own directory, so every relative asset
    # link climbs one level -- the same rewrite the thread pages get, plus kinship.html's
    # own page script. stats.html also keeps a copy at the root because that URL is already
    # published; kinship has no such history and gets the directory form only.
    for source_name, folder, keep_at_root in (("stats.html", "stats", True), ("kinship.html", "kinship", False)):
        source = REPO / "tools/era-archive/web" / source_name
        if not source.exists():
            continue
        content = source.read_text(encoding="utf-8")
        folder_dir = destination / folder
        folder_dir.mkdir(parents=True, exist_ok=True)
        (folder_dir / "index.html").write_text(
            content.replace('"./creators.', '"../creators.').replace('"./kin-tree.js', '"../kin-tree.js').replace('"./kinship.js', '"../kinship.js').replace('"./portraits.js', '"../portraits.js'),
            encoding="utf-8")
        if keep_at_root:
            (destination / source_name).write_text(content, encoding="utf-8")
    # A four-byte file whose query string is the search log: Caddy already records every
    # request as JSON with its URI, so this needs no service, no write path and no store.
    (destination/"search-beacon.txt").write_text("ok\n",encoding="utf-8")
    write_participation_snapshot()
    # Whitelist above deliberately excludes raw character IDs, names from signs, coordinates,
    # source paths, inventories, world seed, snapshot hashes and private identity-review evidence.
    # An album's `residents` is whitelisted the same way and to the same end: an opaque builder
    # key, a bed count and the evidence type, never the owning character or where the bed stood.
    # creators.js, creators.css, kinship.js, pair.js and the kinship shell are presentation only: they
    # carry no archive data, they read the same public JSON any visitor can fetch, and the
    # only participation they ever see is what that visitor typed into their own browser.
    # participation.json is the one exception and it is sanitised on the way out --
    # sanitize_confirmed_tags() drops handles, notes, contacts and claim ids.
    receipt={"schema":"steward-gallery-projection/v1","createdAt":now(),"builders":len(directory),
        "albums":len(published_build_keys),"files":[artifact(destination,p) for p in sorted(destination.rglob("*")) if p.is_file() and p.name!="receipt.json"]}
    save(destination/"receipt.json",receipt)
    return receipt


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root",type=Path,required=True)
    parser.add_argument("--destination",type=Path,required=True)
    parser.add_argument("--world-url",required=True)
    parser.add_argument("--min-build-pieces",type=int,default=20)
    parser.add_argument("--min-builder-pieces",type=int,default=10)
    parser.add_argument("--min-builder-share",type=float,default=0.05)
    args=parser.parse_args()
    if args.destination.exists(): raise ValueError("Use a new immutable projection directory")
    receipt=project(
        load(args.output_root/"analysis/community-private.json"),
        args.destination,
        args.world_url,
        args.output_root,
        min_build_pieces=args.min_build_pieces,
        min_builder_pieces=args.min_builder_pieces,
        min_builder_share=args.min_builder_share,
    )
    print(f"VERIFIED projection: {receipt['builders']:,} creator threads; {receipt['albums']:,} albums")

if __name__=="__main__":main()
