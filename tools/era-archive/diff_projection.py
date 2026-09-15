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
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("live", type=Path)
parser.add_argument("new", type=Path)
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--allow-era-intake", type=int, metavar="ERA",
                  help="admit a new analysis source for exactly this era; photographs may not change")
mode.add_argument("--capture-transition", action="append", nargs=2, type=Path,
                  metavar=("OLD_MANIFEST", "NEW_MANIFEST"),
                  help="admit exactly the photo changes proved by a judged manifest; repeat per era")
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


def public_photo(photo):
    return {key: photo.get(key) for key in ("id", "thumb", "large", "href", "label", "shot")}


def unique_album_map(threads):
    result = {}
    for thread in threads.values():
        for build_key, value in album_map(thread).items():
            if build_key in result and result[build_key] != value:
                raise ValueError(f"album {build_key} differs between contributor threads")
            result[build_key] = value
    return result


def validate_capture_transitions(old_root, new_root, manifest_pairs):
    """Admit only projection changes described by complete judged capture manifests."""
    errors, transitions = [], {}
    for old_path, new_path in manifest_pairs:
        before, after = load(old_path), load(new_path)
        if before.get("schema") != "steward-capture-gallery/v1" or after.get("schema") != before.get("schema"):
            errors.append(("capture schema", str(old_path), str(new_path)))
            continue
        if before.get("era") != after.get("era") or before.get("sourceKey") != after.get("sourceKey"):
            errors.append(("capture identity changed", str(old_path), str(new_path)))
            continue
        if after.get("judged") is not True:
            errors.append(("new capture manifest is not judged", str(new_path)))
        malformed = False
        for label, document in (("old", before), ("new", after)):
            builds = document.get("builds")
            rejected = document.get("rejectedBuilds", [])
            if not isinstance(builds, dict) or not isinstance(rejected, list):
                errors.append(("malformed capture membership", label, str(old_path), str(new_path)))
                malformed = True
                continue
            if len(rejected) != len(set(rejected)):
                errors.append(("duplicate rejected build", label, str(old_path), str(new_path)))
            if set(builds) & set(rejected):
                errors.append(("build is both published and rejected", label,
                               sorted(set(builds) & set(rejected))[:3]))
            if document.get("albums") != len(builds):
                errors.append(("capture album count", label, document.get("albums"), len(builds)))
            actual_photos = sum(len(photos) for photos in builds.values())
            if document.get("photographs") != actual_photos:
                errors.append(("capture photograph count", label,
                               document.get("photographs"), actual_photos))
        if malformed:
            continue
        judgement = after.get("judgement")
        if not isinstance(judgement, dict):
            errors.append(("judged manifest lacks judgement provenance", str(new_path)))
            continue
        judged = judgement.get("judgedBuilds")
        unjudged = judgement.get("unjudgedBuilds")
        if (not isinstance(judged, list) or not isinstance(unjudged, list)
                or not all(isinstance(key, str) for key in judged + unjudged)
                or len(judged) != len(set(judged)) or len(unjudged) != len(set(unjudged))
                or set(judged) & set(unjudged)):
            errors.append(("malformed judgement membership", str(new_path)))
            continue
        if unjudged or judgement.get("complete") is not True:
            errors.append(("capture judgement is incomplete", str(new_path), len(unjudged)))
        receipt = judgement.get("receipt")
        receipt_path = Path(receipt.get("path", "")) if isinstance(receipt, dict) else Path()
        receipt_valid = (isinstance(receipt, dict) and receipt_path.is_file()
                         and receipt_path.stat().st_size == receipt.get("bytes")
                         and hashlib.sha256(receipt_path.read_bytes()).hexdigest() == receipt.get("sha256"))
        receipt_document = load(receipt_path) if receipt_valid else {}
        receipt_rows = receipt_document.get("verdicts", [])
        receipt_builds = ([row.get("buildKey") for row in receipt_rows]
                          if isinstance(receipt_rows, list)
                          and all(isinstance(row, dict) for row in receipt_rows) else [])
        if (not receipt_valid or receipt_document.get("schema") != "steward-pair-verdicts/v2"
                or receipt_document.get("era") != after.get("era")
                or receipt_document.get("sourceKey") not in (None, after.get("sourceKey"))
                or len(receipt_builds) != len(set(receipt_builds))
                or set(receipt_builds) != set(judged)):
            errors.append(("verdict receipt provenance failed", str(new_path)))
        old_scope = set(before.get("builds", {})) | set(before.get("rejectedBuilds", []))
        resolved = set(judged) | set(after.get("rejectedBuilds", []))
        if old_scope != resolved:
            errors.append(("judged manifest does not resolve the old campaign", str(new_path),
                           sorted(old_scope - resolved)[:3], sorted(resolved - old_scope)[:3]))
        try:
            era = int(str(after["era"]).removeprefix("era"))
        except (KeyError, TypeError, ValueError):
            errors.append(("invalid capture era", after.get("era")))
            continue
        old_builds, new_builds = before.get("builds", {}), after.get("builds", {})
        old_rejected, new_rejected = set(before.get("rejectedBuilds", [])), set(after.get("rejectedBuilds", []))
        for build_key in sorted(set(old_builds) | set(new_builds) | old_rejected | new_rejected):
            old_photos = {photo["id"]: public_photo(photo) for photo in old_builds.get(build_key, [])}
            new_photos = {photo["id"]: public_photo(photo) for photo in new_builds.get(build_key, [])}
            if len(old_photos) != len(old_builds.get(build_key, [])) or len(new_photos) != len(new_builds.get(build_key, [])):
                errors.append(("duplicate photo id in capture manifest", build_key))
            if old_photos == new_photos and (build_key in old_rejected) == (build_key in new_rejected):
                continue
            if build_key in transitions:
                errors.append(("build appears in two capture transitions", build_key))
                continue
            transitions[build_key] = {"era": era, "before": old_photos, "after": new_photos,
                                      "rejectedBefore": build_key in old_rejected,
                                      "rejectedAfter": build_key in new_rejected}

    old_threads = {p.stem: load(p) for p in (old_root / "threads").glob("*.json")}
    new_threads = {p.stem: load(p) for p in (new_root / "threads").glob("*.json")}
    if set(old_threads) != set(new_threads):
        errors.append(("thread set changed", sorted(set(old_threads) - set(new_threads))[:5],
                       sorted(set(new_threads) - set(old_threads))[:5]))
    changed_builds, changed_threads = set(), set()
    for key in sorted(set(old_threads) & set(new_threads)):
        before, after = old_threads[key], new_threads[key]
        am, bm = album_map(before), album_map(after)
        if set(am) != set(bm):
            errors.append(("album set changed", key, sorted(set(am) - set(bm))[:3],
                           sorted(set(bm) - set(am))[:3]))
        photo_delta = 0
        for build_key in sorted(set(am) & set(bm)):
            old_era, old_album = am[build_key]
            new_era, new_album = bm[build_key]
            transition = transitions.get(build_key)
            if transition is None:
                if old_album != new_album:
                    errors.append(("album changed without a capture transition", key, build_key))
                continue
            changed_builds.add(build_key)
            if old_era != transition["era"] or new_era != transition["era"]:
                errors.append(("transition era mismatch", build_key, old_era, new_era, transition["era"]))
            for field in set(old_album) | set(new_album):
                if field in ("photos", "photoStatus"):
                    continue
                if old_album.get(field) != new_album.get(field):
                    errors.append(("non-photo album field changed", key, build_key, field))
            old_photos = {photo["id"]: photo for photo in old_album.get("photos", [])}
            new_photos = {photo["id"]: photo for photo in new_album.get("photos", [])}
            removed = set(old_photos) - set(new_photos)
            added = set(new_photos) - set(old_photos)
            expected_removed = set(transition["before"]) - set(transition["after"])
            expected_added = set(transition["after"]) - set(transition["before"])
            if removed != expected_removed or added != expected_added:
                errors.append(("projected photo delta differs from manifests", build_key,
                               sorted(removed), sorted(added), sorted(expected_removed), sorted(expected_added)))
            for photo_id in set(old_photos) & set(new_photos):
                if old_photos[photo_id] != new_photos[photo_id]:
                    errors.append(("retained public photo changed", build_key, photo_id))
            for photo_id in added:
                if new_photos[photo_id] != transition["after"].get(photo_id):
                    errors.append(("new public photo differs from manifest", build_key, photo_id))
            old_status, new_status = old_album.get("photoStatus"), new_album.get("photoStatus")
            if old_status != new_status:
                if new_status not in (None, "rejected"):
                    errors.append(("unexpected photoStatus", build_key, old_status, new_status))
                if new_status == "rejected" and not transition["rejectedAfter"]:
                    errors.append(("rejected status absent from judged manifest", build_key))
            photo_delta += len(new_photos) - len(old_photos)

        for field in set(before) | set(after):
            if field in ("eras", "generatedAt"):
                continue
            if field == "photos":
                if after.get(field) != before.get(field) + photo_delta:
                    errors.append(("thread photo count", key, before.get(field), after.get(field), photo_delta))
            elif before.get(field) != after.get(field):
                errors.append(("non-photo thread field changed", key, field))
        if [e["era"] for e in before["eras"]] != [e["era"] for e in after["eras"]]:
            errors.append(("thread era list changed", key))
        if before != after:
            changed_threads.add(key)

    old_unique, new_unique = unique_album_map(old_threads), unique_album_map(new_threads)
    for build_key in transitions:
        if build_key not in old_unique:
            errors.append(("transition build is not in the live projection", build_key))
    if changed_builds != set(transitions):
        errors.append(("manifest/projected changed-build mismatch", sorted(set(transitions) - changed_builds),
                       sorted(changed_builds - set(transitions))))

    old_directory, new_directory = load(old_root / "directory.json"), load(new_root / "directory.json")
    old_rows = {row["builderKey"]: row for row in old_directory["builders"]}
    new_rows = {row["builderKey"]: row for row in new_directory["builders"]}
    if set(old_rows) != set(new_rows):
        errors.append(("directory builder set changed",))
    for key in sorted(set(new_rows)):
        if new_rows[key] != thread_summary(new_threads[key]):
            errors.append(("directory/thread row mismatch", key))
        if key not in changed_threads and old_rows[key] != new_rows[key]:
            errors.append(("unaffected directory row changed", key))

    old_photo, new_photo = old_directory["photography"], new_directory["photography"]
    expected_photo_delta = sum(len(v["after"]) - len(v["before"]) for v in transitions.values())
    old_with = sum(1 for _era, album in old_unique.values() if album.get("photos"))
    new_with = sum(1 for _era, album in new_unique.values() if album.get("photos"))
    old_builders_with = sum(1 for thread in old_threads.values() if thread.get("photos"))
    new_builders_with = sum(1 for thread in new_threads.values() if thread.get("photos"))
    expected_totals = {"photos": old_photo["photos"] + expected_photo_delta,
                       "albumsWithPhotos": old_photo["albumsWithPhotos"] + new_with - old_with,
                       "buildersWithPhotos": old_photo["buildersWithPhotos"] + new_builders_with - old_builders_with}
    for field, expected in expected_totals.items():
        if new_photo.get(field) != expected:
            errors.append(("photography total", field, new_photo.get(field), expected))
    old_photo_eras = {row["era"]: row for row in old_photo["eras"]}
    new_photo_eras = {row["era"]: row for row in new_photo["eras"]}
    if set(old_photo_eras) != set(new_photo_eras):
        errors.append(("photography era set changed",))
    transition_eras = {value["era"] for value in transitions.values()}
    for era in sorted(set(old_photo_eras) & set(new_photo_eras)):
        if era not in transition_eras and old_photo_eras[era] != new_photo_eras[era]:
            errors.append(("photography changed outside transitioned eras", era))
        elif era in transition_eras:
            before, after = old_photo_eras[era], new_photo_eras[era]
            delta = sum(len(v["after"]) - len(v["before"]) for v in transitions.values() if v["era"] == era)
            for field in set(before) | set(after):
                if field == "photos":
                    if after.get(field) != before.get(field) + delta:
                        errors.append(("era photo count", era, before.get(field), after.get(field), delta))
                elif field == "albumsWithPhotos":
                    old_count = sum(1 for album_era, album in old_unique.values() if album_era == era and album.get("photos"))
                    new_count = sum(1 for album_era, album in new_unique.values() if album_era == era and album.get("photos"))
                    if after.get(field) != before.get(field) + new_count - old_count:
                        errors.append(("era photographed-album count", era))
                elif before.get(field) != after.get(field):
                    errors.append(("era photography field changed", era, field))

    for field in set(old_directory) | set(new_directory):
        if field in ("generatedAt", "builders", "photography"):
            continue
        if old_directory.get(field) != new_directory.get(field):
            errors.append(("directory field changed", field))

    print(f"judged capture transition: {len(manifest_pairs)} manifest(s), {len(transitions)} changed build(s), "
          f"{expected_photo_delta:+d} photograph(s)")
    if errors:
        print("UNEXPECTED differences:", len(errors))
        for error in errors[:20]:
            print("  " + ascii(error))
        return 1
    print("VERIFIED: every projection change is exactly described by the judged capture manifests")
    return 0


if args.allow_era_intake is not None:
    sys.exit(validate_era_intake(live, new, args.allow_era_intake))
if args.capture_transition:
    sys.exit(validate_capture_transitions(live, new, args.capture_transition))


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
