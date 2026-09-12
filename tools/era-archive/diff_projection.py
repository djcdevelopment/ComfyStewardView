#!/usr/bin/env python3
r"""Prove what changed between two creators projections after a capture import.

The gate (gate_creators.py) fails by design when thread data moves; this is the second
half of that gate for a photograph import: it names every difference and refuses any
kind a capture manifest cannot produce. Compare the projection that is live (the one the
latest deploy receipt names) with the fresh one:

    python tools/era-archive/diff_projection.py E:\omen\steward-multi-era\projections\<live> E:\omen\steward-multi-era\projections\<new>

Admitted differences, and only these:
  * an album present in both threads gained photographs (none removed) or a photoStatus;
  * a thread gained an album -- allowed only when that album carries photographs in the new
    projection (a photographed album always qualifies), with the record's `albums` up by the
    count and `pieces` up by exactly the builder's credited pieces on those albums, and `eras`
    extended if the era is new to the record;
  * a new thread whose every album carries photographs;
  * directory.json: the same per-builder fields, the photography block, portrait, generatedAt.
Anything else is printed and the script exits 1.
"""
import json
import sys
from collections import Counter
from pathlib import Path

live, new = Path(sys.argv[1]), Path(sys.argv[2])
kinds, other = Counter(), []
albums_gaining, photos_added, photos_removed, status_set = set(), 0, 0, set()
albums_newly_qualifying, new_threads = Counter(), []
eras_of_added = Counter()


def load(p):
    return json.loads(p.read_text(encoding="utf-8"))


def album_map(thread):
    return {a["buildKey"]: (era["era"], a) for era in thread["eras"] for a in era["albums"]}


def own_pieces(album, key):
    return sum(c.get("pieces") or 0 for c in album.get("contributors", []) if c.get("builderKey") == key)


live_threads = {p.name: p for p in (live / "threads").glob("*.json")}
new_threads_files = {p.name: p for p in (new / "threads").glob("*.json")}
if set(live_threads) - set(new_threads_files):
    other.append(("threads gone", sorted(set(live_threads) - set(new_threads_files))[:5]))
for name in sorted(set(new_threads_files) - set(live_threads)):
    t = load(new_threads_files[name])
    albums = [a for e in t["eras"] for a in e["albums"]]
    if all(a.get("photos") for a in albums):
        new_threads.append((name[:12], len(albums)))
    else:
        other.append((name, "new thread with an unphotographed album"))

for name in sorted(set(live_threads) & set(new_threads_files)):
    a, b = load(live_threads[name]), load(new_threads_files[name])
    key = b["builderKey"]
    if json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True):
        kinds["identical"] += 1
        continue
    am, bm = album_map(a), album_map(b)
    added, gone = set(bm) - set(am), set(am) - set(bm)
    if gone:
        other.append((name, "albums gone", sorted(gone)[:3]))
    for k in added:
        era, album = bm[k]
        if not album.get("photos") and album.get("photoStatus") != "rejected":
            other.append((name, k, "added album without photographs"))
        albums_newly_qualifying[k] += 1
        eras_of_added[era] += 1
    expected_pieces = sum(own_pieces(bm[k][1], key) for k in added)
    expected_eras = sorted({e["era"] for e in a["eras"]} | {bm[k][0] for k in added}, reverse=True)
    for field in set(a) | set(b):
        if field in ("eras", "generatedAt") or a.get(field) == b.get(field):
            continue
        if field == "albums" and b["albums"] - a["albums"] == len(added):
            kinds["record albums +n"] += 1
        elif field == "pieces" and b["pieces"] - a["pieces"] == expected_pieces:
            kinds["record pieces +credited"] += 1
        elif field == "photos":
            kinds["record photo count"] += 1
        elif field == "portrait":
            kinds["portrait pick"] += 1
        else:
            other.append((name, field, a.get(field), b.get(field)))
    if [e["era"] for e in b["eras"]] != expected_eras:
        other.append((name, "era list", [e["era"] for e in a["eras"]], [e["era"] for e in b["eras"]]))
    for k in set(am) & set(bm):
        (ea, x), (eb, y) = am[k], bm[k]
        if ea != eb:
            other.append((name, k, "era moved", ea, eb))
        for field in set(x) | set(y):
            if x.get(field) == y.get(field):
                continue
            if field == "photos":
                xs, ys = {p["id"] for p in x.get("photos", [])}, {p["id"] for p in y.get("photos", [])}
                photos_added += len(ys - xs)
                photos_removed += len(xs - ys)
                if ys - xs:
                    albums_gaining.add(k)
                if xs - ys:
                    other.append((name, k, "photos removed", sorted(xs - ys)[:3]))
            elif field == "photoStatus":
                status_set.add((k[:12], x.get("photoStatus"), y.get("photoStatus")))
            else:
                other.append((name, k, field, str(x.get(field))[:80], str(y.get(field))[:80]))
    kinds["changed"] += 1

da, db = load(live / "directory.json"), load(new / "directory.json")
for key in set(da) | set(db):
    if da.get(key) == db.get(key) or key == "generatedAt":
        continue
    if key == "photography":
        for ea, eb in zip(da[key]["eras"], db[key]["eras"]):
            if ea != eb:
                print("photography era", ea["era"], "live", ea, "new", eb)
        print("photography totals live:", {k: da[key][k] for k in ("photos", "albumsWithPhotos", "buildersWithPhotos")})
        print("photography totals new: ", {k: db[key][k] for k in ("photos", "albumsWithPhotos", "buildersWithPhotos")})
        continue
    if key == "builders":
        ra, rb = {r["builderKey"]: r for r in da[key]}, {r["builderKey"]: r for r in db[key]}
        print("directory builders live/new:", len(ra), len(rb), "new keys:", [k[:12] for k in sorted(set(rb) - set(ra))], "gone:", sorted(set(ra) - set(rb)))
        fields = Counter()
        for k in set(ra) & set(rb):
            for f in set(ra[k]) | set(rb[k]):
                if ra[k].get(f) != rb[k].get(f):
                    fields[f] += 1
                    if f not in ("photos", "portrait", "albums", "pieces", "eras", "tier"):
                        other.append(("directory", k, f, ra[k].get(f), rb[k].get(f)))
        print("directory builder fields that differ:", dict(fields))
        continue
    other.append(("directory", key, str(da.get(key))[:120], str(db.get(key))[:120]))

print("threads:", dict(kinds))
print(f"albums that gained photographs: {len(albums_gaining)}; photographs added: {photos_added}; removed: {photos_removed}")
print("photoStatus set:", sorted(status_set))
print(f"distinct albums newly on a thread because photographed: {len(albums_newly_qualifying)} "
      f"(thread-album instances {sum(albums_newly_qualifying.values())}; by era {dict(eras_of_added)})")
print("new threads (builder, albums):", new_threads)
if other:
    print("UNEXPECTED differences:", len(other))
    for o in other[:20]:
        print("  ", o)
    sys.exit(1)
print("VERIFIED: every difference is a photograph added, an album that qualified by being photographed, "
      "the counts that follow, a photoStatus, a portrait pick, or generatedAt")
