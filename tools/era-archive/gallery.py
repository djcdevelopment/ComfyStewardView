#!/usr/bin/env python3
"""Publish an allowlisted creator directory and per-era album threads as static files."""
import argparse
from collections import defaultdict
import hashlib
from pathlib import Path
import shutil
from archive import REPO, artifact, load, now, save


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
        page.write_text(template.replace('"./creators.', '"../creators.'),encoding="utf-8")
    save(destination/"directory.json",{"schema":"steward-creator-directory/v1","generatedAt":document["generatedAt"],
        "builders":sorted(directory,key=lambda b:(b["displayName"].casefold(),b["builderKey"])),
        "eras":document["eras"],"unattributedAlbums":sum(not b["contributors"] for b in builds.values()),
        "legacyImports":[{k:r[k] for k in ("slug","images","albums","unresolvedImages")} for r in document["legacyImports"]]})
    (destination/"index.html").write_text(template,encoding="utf-8")
    for name in ("creators.js","creators.css"):
        shutil.copyfile(REPO/"tools/era-archive/web"/name,destination/name)
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
