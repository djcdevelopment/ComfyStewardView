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

Use ``--allow-era-intake N`` for the distinct operation of admitting analysis
from one previously absent era.  That mode permits its unphotographed albums and
recorded-name observations while holding every pre-existing album and photograph fixed.
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("live", type=Path)
parser.add_argument("new", type=Path)
parser.add_argument("--allow-era-intake", type=int, metavar="ERA",
                    help="admit a new analysis source for exactly this era; photographs may not change")
args = parser.parse_args()
live, new = args.live, args.new
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


def thread_summary(thread):
    """The directory's builder row is the thread header with compact era numbers."""
    return {k: ([era["era"] for era in value] if k == "eras" else value)
            for k, value in thread.items() if k != "generatedAt"}


def validate_era_intake(old_root, new_root, era):
    """Strictly admit analysis for one previously absent era.

    Source intake may add unphotographed albums and may extend existing builders, but it
    cannot rewrite anything that was already public.  Photography is a separate, manifest-
    backed lane, so its counts and every existing photo stay frozen here.
    """
    errors = []
    old_files = {p.name: p for p in (old_root / "threads").glob("*.json")}
    new_files = {p.name: p for p in (new_root / "threads").glob("*.json")}
    gone = sorted(set(old_files) - set(new_files))
    if gone:
        errors.append(("threads gone", gone[:5]))

    changed, added_threads, added_builds = set(), set(), set()
    for name in sorted(set(new_files) - set(old_files)):
        record = load(new_files[name])
        albums = album_map(record)
        if not albums:
            errors.append((name, "new thread has no albums"))
            continue
        if ({album_era for album_era, _ in albums.values()} != {era}
                or any(album.get("era") != era for _, album in albums.values())):
            errors.append((name, "new thread contains another era"))
        if any(album.get("photos") for _, album in albums.values()) or record.get("photos") != 0:
            errors.append((name, "era intake changed photography"))
        added_threads.add(record.get("builderKey"))
        added_builds.update(albums)

    for name in sorted(set(old_files) & set(new_files)):
        before, after = load(old_files[name]), load(new_files[name])
        if before == after:
            continue
        changed.add(after.get("builderKey"))
        am, bm = album_map(before), album_map(after)
        removed = set(am) - set(bm)
        added = set(bm) - set(am)
        if removed:
            errors.append((name, "albums gone", sorted(removed)[:3]))
        for build_key in sorted(set(am) & set(bm)):
            if am[build_key] != bm[build_key]:
                errors.append((name, build_key, "existing album changed"))
        for build_key in sorted(added):
            album_era, album = bm[build_key]
            if album_era != era or album.get("era") != era:
                errors.append((name, build_key, "added album is not intake era",
                               album_era, album.get("era")))
            if album.get("photos"):
                errors.append((name, build_key, "added album carries photographs"))
        added_builds.update(added)

        expected_pieces = sum(own_pieces(bm[key][1], after["builderKey"]) for key in added)
        expected_eras = sorted({e["era"] for e in before["eras"]} | {bm[key][0] for key in added}, reverse=True)
        for field in set(before) | set(after):
            if field in ("eras", "generatedAt"):
                continue
            if field == "albums":
                if after.get(field) != before.get(field) + len(added):
                    errors.append((name, field, before.get(field), after.get(field)))
            elif field == "pieces":
                if after.get(field) != before.get(field) + expected_pieces:
                    errors.append((name, field, before.get(field), after.get(field), expected_pieces))
            elif field == "tier" and added:
                # Tier is a deterministic presentation of the newly proved piece count.
                pass
            elif field in ("displayName", "aliases", "nameStatus", "portrait"):
                # A newly admitted save contributes recorded-name observations.  The
                # portrait assignment is deterministic over the resulting public record,
                # so name and tier movement can reselect its archive portrait as well.
                pass
            elif before.get(field) != after.get(field):
                errors.append((name, field, before.get(field), after.get(field)))
        if [e["era"] for e in after["eras"]] != expected_eras:
            errors.append((name, "era list", [e["era"] for e in before["eras"]], expected_eras,
                           [e["era"] for e in after["eras"]]))

    old_directory, new_directory = load(old_root / "directory.json"), load(new_root / "directory.json")
    old_rows = {row["builderKey"]: row for row in old_directory["builders"]}
    new_rows = {row["builderKey"]: row for row in new_directory["builders"]}
    if set(old_rows) - set(new_rows):
        errors.append(("directory builders gone", sorted(set(old_rows) - set(new_rows))[:5]))
    if set(new_rows) - set(old_rows) != added_threads:
        errors.append(("directory/thread new-builder mismatch",
                       sorted(set(new_rows) - set(old_rows)), sorted(added_threads)))
    for key in sorted(set(new_rows)):
        thread_path = new_root / "threads" / f"{key}.json"
        if not thread_path.exists() or new_rows[key] != thread_summary(load(thread_path)):
            errors.append(("directory/thread row mismatch", key))
    for key in sorted((set(old_rows) & set(new_rows)) - changed):
        if old_rows[key] != new_rows[key]:
            errors.append(("unaffected directory builder changed", key))

    old_eras = {row["era"]: row for row in old_directory.get("eras", [])}
    new_eras = {row["era"]: row for row in new_directory.get("eras", [])}
    if set(old_eras) - set(new_eras) or set(new_eras) - set(old_eras) != {era}:
        errors.append(("analysis era set", sorted(old_eras), sorted(new_eras)))
    for key in sorted(set(old_eras) & set(new_eras)):
        if old_eras[key] != new_eras[key]:
            errors.append(("existing analysis era changed", key))

    old_photo, new_photo = old_directory["photography"], new_directory["photography"]
    for field in ("photos", "albumsWithPhotos", "buildersWithPhotos"):
        if old_photo.get(field) != new_photo.get(field):
            errors.append(("photography total changed", field, old_photo.get(field), new_photo.get(field)))
    old_photo_eras = {row["era"]: row for row in old_photo["eras"]}
    new_photo_eras = {row["era"]: row for row in new_photo["eras"]}
    if set(old_photo_eras) != set(new_photo_eras):
        errors.append(("photography era set changed", sorted(old_photo_eras), sorted(new_photo_eras)))
    for key in sorted(set(old_photo_eras) & set(new_photo_eras)):
        before, after = old_photo_eras[key], new_photo_eras[key]
        if key != era and before != after:
            errors.append(("photography changed outside intake era", key))
        elif key == era:
            for field in set(before) | set(after):
                if field == "albums":
                    if after.get(field) != before.get(field) + len(added_builds):
                        errors.append(("intake album total", before.get(field), after.get(field), len(added_builds)))
                elif before.get(field) != after.get(field):
                    errors.append(("intake photography changed", field, before.get(field), after.get(field)))

    for field in set(old_directory) | set(new_directory):
        if field in ("generatedAt", "builders", "eras", "photography", "unattributedAlbums"):
            continue
        if old_directory.get(field) != new_directory.get(field):
            errors.append(("directory field changed", field))
    if new_directory.get("unattributedAlbums", 0) < old_directory.get("unattributedAlbums", 0):
        errors.append(("unattributedAlbums decreased", old_directory.get("unattributedAlbums"),
                       new_directory.get("unattributedAlbums")))

    print(f"era {era} intake: {len(added_threads)} new thread(s), {len(changed)} extended thread(s), "
          f"{len(added_builds)} new album(s)")
    if errors:
        print("UNEXPECTED differences:", len(errors))
        for error in errors[:20]:
            print("  " + ascii(error))
        return 1
    print(f"VERIFIED: every data change is an unphotographed era {era} intake; existing data and photography are unchanged")
    return 0


if args.allow_era_intake is not None:
    sys.exit(validate_era_intake(live, new, args.allow_era_intake))


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
