#!/usr/bin/env python3
"""Build contributor-aware albums and capture queues from verified archive packages.

Identity observations are evidence of a character name, not ownership of nearby structures.
Shared albums credit every recorded piece creator. All raw IDs and source positions stay in
the private analysis artifacts; gallery projections use opaque identifiers.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import hashlib
import heapq
import json
import math
from pathlib import Path
import re
import sys
import uuid
import duckdb
from archive import REPO, artifact, digest, load, now, save, sql_path, verify_package, writer_lock

sys.path.insert(0, str(REPO / "tools/selfie-stick"))
from scan_clusters import build_clusters, cluster_stats, score

RECIPE = {"schema": "steward-build-membership/v1", "primaryCell": 16, "primaryMinCell": 4,
          "residualCell": 8, "residualMinCell": 1, "minPieces": 1, "category": "BUILDING"}
RECIPE_HASH = hashlib.sha256(json.dumps(RECIPE, sort_keys=True).encode()).hexdigest()


def clean_name(value):
    value = re.sub(r"<[^>]*>", "", str(value or ""))
    return " ".join("".join(c for c in value if c.isprintable()).split())[:100]


def read_links(path):
    if not path:
        return {}
    document = load(path)
    if document.get("schema") != "steward-builder-links/v1":
        raise ValueError("Unknown curated-link schema")
    result = {}
    for link in document.get("links", []):
        if not re.fullmatch(r"[a-f0-9]{32}", link.get("builderKey", "")):
            raise ValueError("Curated builder key must be an opaque 32-hex ID")
        if not all(link.get(k) for k in ("evidence", "reviewedBy", "reviewedAt")):
            raise ValueError("Cross-character links require review provenance")
        if not link.get("characterIds"):
            raise ValueError("Curated link has no characters")
        for character in link["characterIds"]:
            if not isinstance(character, str) or not re.fullmatch(r"-?[0-9]+", character) or int(character) == 0:
                raise ValueError("Character IDs must be nonzero decimal strings")
            character = str(int(character))
            if character in result:
                raise ValueError("A character has conflicting curated mappings")
            result[character] = link
    return result


def builder_key(namespace, character, links):
    character = str(int(character))
    if character in links:
        return links[character]["builderKey"]
    return uuid.uuid5(namespace, "character:" + character).hex


def name_observations(con, era):
    rows = con.execute("""
        SELECT z.owner_id::VARCHAR AS character, f.string_value AS name, z.category AS source,
               count(*) AS observations, min(z.zdo_index)::VARCHAR AS example
        FROM zdo z JOIN zdo_field f USING (snapshot_id,zdo_index)
        WHERE z.category IN ('BED','TOMBSTONE') AND z.owner_id IS NOT NULL AND z.owner_id<>0
          AND f.field_name='ownerName' AND f.string_value IS NOT NULL AND length(f.string_value)>0
        GROUP BY 1,2,3
        UNION ALL
        SELECT crafter_id::VARCHAR,crafter_name,'ITEM_CRAFTER',count(*),min(container_zdo_index)::VARCHAR
        FROM container_item WHERE crafter_id IS NOT NULL AND crafter_id<>0
          AND crafter_name IS NOT NULL AND length(crafter_name)>0 GROUP BY 1,2,3
        """).fetchall()
    return [{"characterId": str(character), "name": clean_name(name), "source": source,
             "observations": n, "exampleZdo": example, "era": era["era"],
             "snapshotId": era["snapshotId"], "sourceKey": era["sourceKey"]}
            for character, name, source, n, example in rows if clean_name(name)]


def analyze_era(root, entry):
    package = verify_package(root, entry)
    input_hash = hashlib.sha256(json.dumps(entry["ingestion"]["artifacts"],sort_keys=True).encode()).hexdigest()
    dest = Path(root) / "analysis" / entry["slug"] / (entry["sourceKey"][:16] + "-" + RECIPE_HASH[:12] + "-" + input_hash[:12])
    receipt_path = dest / "analysis.json"
    if receipt_path.exists():
        result = load(receipt_path)
        if digest(dest / "membership.parquet") == {k: result["membership"][k] for k in ("bytes", "sha256")}:
            return result
        raise ValueError(f"Corrupt membership artifact: {dest}")
    dest.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(":memory:") as con:
        con.execute("SET threads=4"); con.execute("SET memory_limit='8GB'")
        for table in ("world_snapshot", "zdo", "zdo_field", "container_item"):
            con.execute(f"CREATE VIEW {table} AS SELECT * FROM read_parquet({sql_path(package[table])})")
        invalid = con.execute("SELECT count(*) FROM zdo WHERE category='BUILDING' AND (NOT isfinite(x) OR NOT isfinite(y) OR NOT isfinite(z))").fetchone()[0]
        if invalid:
            con.execute(f"COPY (SELECT * FROM zdo WHERE category='BUILDING' AND (NOT isfinite(x) OR NOT isfinite(y) OR NOT isfinite(z))) TO {sql_path(dest/'spatial-quarantine.parquet')} (FORMAT PARQUET, COMPRESSION ZSTD)")
        con.execute("CREATE TEMP VIEW selected_zdo AS SELECT * FROM zdo WHERE isfinite(x) AND isfinite(y) AND isfinite(z)")
        groups = build_clusters(con, 16, 16, 4)
        cluster_stats(con, 16, 16, groups, 1)
        con.execute("CREATE TEMP TABLE members AS SELECT * FROM piece_cluster")
        last = con.execute("SELECT coalesce(max(cid),0) FROM members").fetchone()[0]
        con.execute("CREATE OR REPLACE TEMP VIEW selected_zdo AS SELECT * FROM zdo WHERE category='BUILDING' AND isfinite(x) AND isfinite(y) AND isfinite(z) AND zdo_index NOT IN (SELECT zdo_index FROM members)")
        residual = con.execute("SELECT count(*) FROM selected_zdo").fetchone()[0]
        if residual:
            groups = build_clusters(con, 8, 8, 1)
            cluster_stats(con, 8, 8, groups, 1)
            con.execute("INSERT INTO members SELECT * REPLACE(cid+? AS cid) FROM piece_cluster", [last])
        expected = con.execute("SELECT count(*) FROM zdo WHERE category='BUILDING'").fetchone()[0]
        actual, unique = con.execute("SELECT count(*),count(DISTINCT zdo_index) FROM members").fetchone()
        if expected != actual + invalid or unique != actual:
            raise ValueError(f"Incomplete or duplicated build membership: {expected}/{actual}/{unique}")
        rows = con.execute("""SELECT cid,count(*),min(x),max(x),min(y),max(y),min(z),max(z),
            count(DISTINCT prefab_hash),count(*) FILTER(WHERE prefab_name IS NULL OR starts_with(prefab_name,'hash:')),
            sha256(string_agg(zdo_index::VARCHAR,',' ORDER BY zdo_index)),
            count(*) FILTER(WHERE creator_id IS NOT NULL AND creator_id<>0)
            FROM members GROUP BY cid ORDER BY min(zdo_index)""").fetchall()
        # Identity of the building rather than of the plot. Two builds with the same
        # prefab multiset are the same building stamped twice, and a world that hands
        # every player an identical lot produces hundreds of them under different
        # owners. Keyed on prefab_hash, not the resolved name: a dictionary gap reports
        # several distinct prefabs as one null name, and grouping on that would merge
        # genuinely different buildings into a single identity.
        templates = dict(con.execute("""SELECT cid,sha256(string_agg(signature,',' ORDER BY signature))
            FROM (SELECT cid,prefab_hash::VARCHAR||':'||count(*) AS signature FROM members GROUP BY cid,prefab_hash)
            GROUP BY cid""").fetchall())
        contributors = defaultdict(list)
        for cid, creator, n in con.execute("SELECT cid,creator_id::VARCHAR,count(*) FROM members WHERE creator_id IS NOT NULL AND creator_id<>0 GROUP BY 1,2 ORDER BY 1,3 DESC,2").fetchall():
            contributors[cid].append({"characterId": creator, "pieces": n})
        builds, mapping = [], []
        for cid, count, xmin, xmax, ymin, ymax, zmin, zmax, varieties, unknown, membership_hash, attributed in rows:
            key = hashlib.sha256((entry["sourceKey"] + RECIPE_HASH + membership_hash).encode()).hexdigest()
            mapping.append((cid, key))
            footprint = max(1, (xmax-xmin)*(zmax-zmin))
            builds.append({"buildKey": key, "era": entry["era"], "slug": entry["slug"],
                           "snapshotId": entry["snapshotId"], "sourceKey": entry["sourceKey"],
                           "label": f"Build {key[:8]}", "pieces": count, "attributedPieces": attributed,
                           "bounds": {"minX": xmin,"maxX": xmax,"minY": ymin,"maxY": ymax,"minZ": zmin,"maxZ": zmax},
                           "height": ymax-ymin, "distinctPrefabs": varieties, "unknownNamePieces": unknown,
                           "unknownNameFraction": unknown/count, "contributors": contributors[cid],
                           "score": score(count,ymax-ymin,footprint,varieties,1),
                           "region": "outland" if math.hypot((xmin+xmax)/2,(zmin+zmax)/2)>10500 else "in-world",
                           "templateKey": templates[cid],
                           "membershipSha256": membership_hash, "photos": []})
        con.execute("CREATE TEMP TABLE build_keys(cid BIGINT,build_key VARCHAR)")
        if mapping:
            con.execute("INSERT INTO build_keys SELECT unnest(?::BIGINT[]),unnest(?::VARCHAR[])",
                        [list(column) for column in zip(*mapping)])
        con.execute(f"COPY (SELECT {int(entry['snapshotId'])}::BIGINT AS snapshot_id,build_key,zdo_index FROM members JOIN build_keys USING(cid) ORDER BY build_key,zdo_index) TO {sql_path(dest/'membership.parquet')} (FORMAT PARQUET, COMPRESSION ZSTD)")
        unknowns = [{"prefabHash": h, "name": name, "objects": n, "constructionPieces": built,
                     "attributedConstructionPieces": authored, "status": "unresolved-name",
                     "diagnosis": "UNVERIFIED: dictionary gap, historical rename, or mod; no mod identity inferred"}
                    for h,name,n,built,authored in con.execute("""SELECT prefab_hash,prefab_name,count(*),
                    count(*) FILTER(WHERE category='BUILDING'),count(*) FILTER(WHERE category='BUILDING' AND creator_id<>0)
                    FROM zdo WHERE prefab_name IS NULL OR starts_with(prefab_name,'hash:') GROUP BY 1,2 ORDER BY 4 DESC,3 DESC,1""").fetchall()]
        observations = name_observations(con, entry)
        census = dict(con.execute("SELECT category,count(*) FROM zdo GROUP BY category").fetchall())
        result = {"schema": "steward-era-analysis/v1", "era": entry["era"], "slug": entry["slug"],
                  "sourceKey": entry["sourceKey"], "snapshotId": entry["snapshotId"], "recipe": RECIPE,
                  "recipeSha256": RECIPE_HASH, "inputReceiptSha256": input_hash, "generatedAt": now(), "constructionPieces": expected,
                  "residualPiecesRecovered": residual, "quarantinedConstructionPieces":invalid,
                  "quarantine":artifact(root,dest/'spatial-quarantine.parquet') if invalid else None,
                  "census": census, "builds": builds,
                  "nameObservations": observations, "unknowns": unknowns,
                  "membership": artifact(root,dest/'membership.parquet'),
                  "runtime": entry.get("runtime", {"status":"unidentified"})}
        save(receipt_path,result)
        print(f"{entry['slug']}: {len(builds):,} builds; {len(observations):,} name observations; every construction piece accounted for",flush=True)
        return result


def import_legacy(config, namespace, links):
    """Preserve legacy cluster identity; never replay a different snapshot under an old ID."""
    result, receipts = [], []
    if not config:
        return result, receipts
    for entry in load(config).get("galleries",[]):
        index = load(entry["index"])
        slug = entry["slug"]
        if not re.fullmatch(r"era\d+",slug):
            raise ValueError("Invalid legacy era slug")
        era = int(slug[3:])
        base = entry["url"].rstrip("/") + "/"
        if not base.startswith(("https://","http://127.0.0.1")):
            raise ValueError("Legacy gallery needs an explicit HTTP origin")
        if index.get("world") and re.sub(r"[^a-z0-9]", "", index["world"].lower()) != "comfy"+slug:
            raise ValueError("Legacy index world disagrees with its era")
        by_cluster = {}
        unresolved = 0
        for photo in index.get("images",[]):
            image_id = photo.get("id","")
            if not re.fullmatch(r"[A-Za-z0-9_-]+",image_id):
                raise ValueError("Unsafe historical image identifier")
            cid = photo.get("cluster_id")
            creator = photo.get("top_creator_id")
            if cid is None or not creator:
                unresolved += 1; continue
            key = hashlib.sha256(("legacy:"+slug+":"+str(cid)).encode()).hexdigest()
            album = by_cluster.setdefault(key,{"buildKey":key,"era":era,"slug":slug,
                "label":clean_name(photo.get("label")) or f"Historical build {cid}","pieces":photo.get("pieces",0),
                "contributors":[],"photos":[],"attribution":"historical recorded leading contributor; full membership unresolved",
                "galleryUrl":base+"#build=c"+str(cid),"snapshotId":entry.get("snapshotId"),"sourceKey":entry.get("sourceKey"),
                "legacyClusterId":cid})
            bk = builder_key(namespace,str(creator),links)
            if bk not in [c["builderKey"] for c in album["contributors"]]:
                album["contributors"].append({"builderKey":bk,"characterId":str(creator),"pieces":None,"evidence":"legacy-leading-contributor"})
            album["photos"].append({"id":image_id,"thumb":base+"thumb/"+image_id+".webp",
                "large":base+"large/"+image_id+".webp","href":base+"#build=c"+str(cid),"label":album["label"]})
        result.extend(by_cluster.values())
        receipts.append({"slug":slug,"index":digest(entry["index"]),"images":len(index.get("images",[])),
                         "albums":len(by_cluster),"unresolvedImages":unresolved})
    return result, receipts


def attach_captures(builds, manifests):
    """Give a modern album the photographs a capture campaign actually took.

    The legacy path invents an album from a photograph's cluster_id and credits one
    leading contributor. Here the album already exists with exact membership, so a
    capture manifest only has to name its buildKey. Nothing else in the projection
    needs to know the difference -- and once photos land here, the coverage ranker
    below stops re-queueing builds that have already been photographed."""
    by_key={b["buildKey"]:b for b in builds}
    receipts,attached,unknown=[],0,0
    for path in manifests or []:
        doc=load(path)
        if doc.get("schema")!="steward-capture-gallery/v1":
            raise ValueError("Not a capture gallery manifest: "+str(path))
        if not str(doc.get("base","")).startswith(("http://","https://")):
            raise ValueError("Capture gallery needs an explicit HTTP origin")
        missing=0
        for build_key,photos in doc["builds"].items():
            build=by_key.get(build_key)
            if build is None:
                missing+=1; continue
            if build.get("sourceKey") and build["sourceKey"]!=doc["sourceKey"]:
                raise ValueError("Capture manifest crosses a source boundary")
            for photo in photos:
                if not re.fullmatch(r"[A-Za-z0-9_-]+",photo.get("id","")):
                    raise ValueError("Unsafe capture image identifier")
                build["photos"].append({k:photo[k] for k in ("id","thumb","large","href","label")})
                attached+=1
        unknown+=missing
        receipts.append({"manifest":digest(path),"era":doc["era"],"sourceKey":doc["sourceKey"],
                         "albums":len(doc["builds"]),"photographs":doc["photographs"],
                         "unresolvedBuilds":missing})
    return receipts,attached,unknown


def project(root, analyses, links_path=None, legacy_config=None, capture_manifests=None):
    root = Path(root)
    settings_path = root / "analysis" / "identity-registry.json"
    settings = load(settings_path) if settings_path.exists() else {"namespace":str(uuid.uuid4())}
    save(settings_path,settings)
    namespace=uuid.UUID(settings["namespace"]); links=read_links(links_path)
    builders={}; all_builds=[]; unknown_patterns=defaultdict(list); era_reports=[]; jobs=[]

    def ensure(character):
        key=builder_key(namespace,character,links)
        builder=builders.setdefault(key,{"builderKey":key,"characterIds":[],"observations":[],"builds":[],"aliases":[]})
        if character not in builder["characterIds"]:builder["characterIds"].append(character)
        return builder

    for analysis in analyses:
        for observation in analysis["nameObservations"]:
            ensure(observation["characterId"])["observations"].append(observation)
        for build in analysis["builds"]:
            b=dict(build); grouped={}
            for contribution in b["contributors"]:
                builder=ensure(contribution["characterId"]); key=builder["builderKey"]
                grouped[key]=grouped.get(key,0)+contribution["pieces"]
                if b["buildKey"] not in builder["builds"]:builder["builds"].append(b["buildKey"])
            b["contributors"]=[{"builderKey":key,"pieces":n,"share":n/b["pieces"],"evidence":"saved-piece-creator"} for key,n in sorted(grouped.items())]
            all_builds.append(b)
        missing=sum(u["constructionPieces"] for u in analysis["unknowns"])
        fraction=missing/max(analysis["constructionPieces"],1)
        era_reports.append({"era":analysis["era"],"slug":analysis["slug"],"constructionPieces":analysis["constructionPieces"],
            "builds":len(analysis["builds"]),"unknownNamePieces":missing,"unknownNameFraction":fraction,
            "runtimeMissingFraction":None,"runtimeStatus":analysis["runtime"]["status"],
            "priorityInvestigation":fraction>=.05,"quarantinedConstructionPieces":analysis.get("quarantinedConstructionPieces",0),"census":analysis["census"]})
        for u in analysis["unknowns"]:
            unknown_patterns[str(u["prefabHash"])].append({"era":analysis["era"],**u})
        jobs.append({"jobId":analysis["slug"]+"-terrain-runtime","kind":"terrain-cache-session","dispatch":"manual",
            "status":"blocked","missingPrerequisites":["verified era-matched game runtime","runtime prefab availability audit","isolated cache-generation adapter"],
            "sourceKey":analysis["sourceKey"],"snapshotId":analysis["snapshotId"],"era":analysis["era"]})

    # Before the legacy import and before the ranking: these photographs belong to
    # albums that already exist, and the ranker reads build["photos"] to decide who is
    # covered.
    capture_receipts,captured_photos,unresolved=attach_captures(all_builds,capture_manifests)
    if capture_receipts:
        print(f"Attached {captured_photos:,} captured photographs from "
              f"{len(capture_receipts)} manifest(s); {unresolved:,} unresolved build(s)",flush=True)

    # Omitting --legacy-galleries is not "no legacy galleries", it is "drop the ones you
    # had": the projection is rebuilt from scratch every run, so a forgotten flag silently
    # removed 535 albums and 5,176 photographs, and the only visible sign was a builder
    # count falling from 3,328 to 3,194. Refuse to do that quietly.
    if not legacy_config:
        previous=root/"analysis/community-private.json"
        if previous.exists():
            try:had=len(load(previous).get("legacyImports",[]))
            except (ValueError,OSError):had=0
            if had:
                raise ValueError(
                    f"The current projection imports {had} legacy gallery/galleries, but no "
                    f"--legacy-galleries was given. Re-running would drop those albums and "
                    f"their photographs. Pass the config, or delete "
                    f"analysis/community-private.json to say the loss is intended.")

    legacy,legacy_receipts=import_legacy(legacy_config,namespace,links)
    for build in legacy:
        all_builds.append(build)
        for c in build["contributors"]:
            builder=ensure(c.pop("characterId"))
            if build["buildKey"] not in builder["builds"]:builder["builds"].append(build["buildKey"])
    for builder in builders.values():
        observations=builder["observations"]
        builder["aliases"]=sorted({o["name"] for o in observations})
        preferred={clean_name(links[c].get("displayName")) for c in builder["characterIds"] if c in links and links[c].get("displayName")}
        latest=max([o["era"] for o in observations],default=0)
        latest_names={o["name"] for o in observations if o["era"]==latest}
        candidates=preferred or latest_names
        builder["displayName"]=next(iter(candidates)) if len(candidates)==1 else "Builder "+builder["builderKey"][:8]
        builder["nameStatus"]="recorded" if len(candidates)==1 else "ambiguous" if candidates else "unresolved"

    # A stamped lot is one subject however many owners it has. Era 14 queued 238 copies
    # of one 1,629-piece building as 238 separate jobs, because coverage ranks by owner
    # and each copy had a different one; four orbits apiece is 952 photographs of the
    # same walls. The first copy earns the photograph and the rest point at it.
    copies=Counter((b["era"],b["templateKey"]) for b in all_builds if b.get("templateKey"))
    for b in all_builds:
        if b.get("templateKey"):b["templateCopies"]=copies[(b["era"],b["templateKey"])]
    stamped={}
    # analyze_era returns a cached receipt when one exists, so an era analysed before
    # templateKey was recorded carries none and this dedupe silently does nothing --
    # which looks exactly like a world that has no stamped lots. Say which it is.
    untyped={b["era"] for b in all_builds if not b.get("legacyClusterId") and not b.get("templateKey")}
    if untyped:
        print(f"NOTE: era(s) {sorted(untyped)} were analysed before build identity was "
              f"recorded, so repeated stamped builds are NOT deduplicated in this queue. "
              f"Delete their analysis receipts to recompute, or select with "
              f"plan_coverage.py, which excludes templates itself.",flush=True)

    # Greedy coverage first, then geometry score; each builder-era receives a first opportunity.
    remaining={b["buildKey"]:b for b in all_builds if not b["photos"] and b.get("contributors")}
    covered={(c["builderKey"],b["era"]) for b in all_builds if b["photos"] for c in b["contributors"]}
    def rank(b):
        gain=sum((c["builderKey"],b["era"]) not in covered for c in b["contributors"])
        return (-gain,-b.get("score",0),b["era"],b["buildKey"])
    heap=[rank(b) for b in remaining.values()];heapq.heapify(heap)
    while heap:
        previous=heapq.heappop(heap);best=remaining[previous[-1]]
        current=rank(best)
        if current!=previous:
            heapq.heappush(heap,current);continue
        gain=-current[0]
        template=(best["era"],best.get("templateKey"))
        if best.get("templateKey") and template in stamped:
            # Deliberately before covered.add: this owner is not getting a photograph,
            # so leaving them uncovered keeps their own distinct build worth selecting.
            best["duplicateOfBuildKey"]=stamped[template];continue
        for c in best["contributors"]:covered.add((c["builderKey"],best["era"]))
        if best.get("templateKey"):stamped[template]=best["buildKey"]
        priority=best.get("unknownNameFraction",0)>=.10
        jobs.append({"jobId":"photos-"+best["buildKey"][:20],"kind":"photography","dispatch":"manual",
            "status":"blocked","missingPrerequisites":["verified era-matched capture runtime","terrain context","capture plugin compatibility"],
            "era":best["era"],"sourceKey":best["sourceKey"],"snapshotId":best["snapshotId"],"buildKey":best["buildKey"],
            "newBuilderEraCoverage":gain,"priorityInvestigation":priority,"pilotCandidate":False,
            "shots":{"exteriors":4,"interiorWhenSupported":1,"width":3840,"height":2160},
            "templateKey":best.get("templateKey"),"templateCopies":best.get("templateCopies",1),
            "membershipSha256":best.get("membershipSha256"),"bounds":best.get("bounds")})
    for era in {a["era"] for a in analyses}:
        candidates=[b for b in all_builds if b["era"]==era and not b.get("legacyClusterId") and b.get("contributors") and b.get("unknownNameFraction",0)<.10]
        selected=[]
        if candidates:
            selected.append(min(candidates,key=lambda b:(abs(b["pieces"]-100),b["buildKey"]))["buildKey"])
            shared=[b for b in candidates if len(b["contributors"])>1 and b["buildKey"] not in selected]
            if shared:selected.append(max(shared,key=lambda b:(len(b["contributors"]),b["score"]))["buildKey"])
            landmarks=[b for b in candidates if b["buildKey"] not in selected]
            if landmarks:selected.append(max(landmarks,key=lambda b:b["score"])["buildKey"])
        for job in jobs:
            if job.get("buildKey") in selected:job["pilotCandidate"]=True
    document={"schema":"steward-community/v1","generatedAt":now(),"builders":list(builders.values()),
        "builds":all_builds,"eras":era_reports,"legacyImports":legacy_receipts,
        "captureImports":capture_receipts}
    save(root/"analysis/community-private.json",document)
    save(root/"analysis/unknown-assets.json",{"schema":"steward-unknown-assets/v1","eras":era_reports,
        "patterns":[{"prefabHash":h,"eras":v,"recurring":len(v)>1} for h,v in sorted(unknown_patterns.items(),key=lambda kv:-sum(x["constructionPieces"] for x in kv[1]))]})
    save(root/"analysis/jobs.json",{"schema":"steward-era-jobs/v1","generatedAt":now(),"jobs":jobs})
    save(root/"analysis/catalog.json",{"schema":"steward-analysis-catalog/v1","recipe":RECIPE,
        "eras":[{"slug":a["slug"],"snapshotId":a["snapshotId"],"sourceKey":a["sourceKey"],"membership":a["membership"]} for a in analyses]})
    print(f"Projected {len(builders):,} builder threads, {len(all_builds):,} albums, {len(jobs):,} queued manual jobs",flush=True)
    return document


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root",type=Path,required=True)
    parser.add_argument("--links",type=Path)
    parser.add_argument("--legacy-galleries",type=Path)
    parser.add_argument("--captures",type=Path,action="append",default=[],
                        help="capture gallery manifest from import_captures.py; repeatable")
    args=parser.parse_args();root=args.output_root.resolve()
    with writer_lock(root/"analysis"):
        catalog=load(root/"catalog.json")
        analyses=[analyze_era(root,e) for e in catalog["eras"] if e["ingestion"].get("status")=="verified"]
        project(root,analyses,args.links,args.legacy_galleries,args.captures)


if __name__=="__main__":main()
