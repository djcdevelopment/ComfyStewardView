#!/usr/bin/env python3
"""The coordinator's participation file: ingest what volunteers send, confirm, forget.

There is no endpoint. A claim, a photo request or a kinship tag reaches Derek as a payload
a volunteer copied out of their own browser and sent on through Discord, and until now the
receiving end of that was a text editor. This is that step made mechanical: the two
preconditions `docs/era-archive/creator-participation-design.md` names as unanswered --
**a retention answer** and **a reconciliation policy** -- as commands you can run.

It owns exactly one file, `<output-root>/analysis/participation.json`, schema
`steward-creator-participation/v1`. That file holds the four counts and the confirmed
kinship tags `gallery.py` projects, **and, beside them, the full records as received** --
`claimRecords`, `requestRecords`, `tagRecords`, carrying the volunteer's handle, their
free-text note and any contact address they offered. That is personal data and it lives on
Derek's disk and nowhere else: `gallery.export_participation()` reads only the counts and
`confirmedTags`, and `gallery.sanitize_confirmed_tags()` whitelists five keys out of each
of those, so a handle, a note, a contact or a claim id has no path to a public page.

The retention answer is `forget <handle>`: every record that volunteer sent, and every
confirmed tag that came in on one of them, removed in one command. The reconciliation
answer is that claims stay markers -- a claim carries `kind` (`built` or `disavow`), two
people may both claim one build, and nothing here ever rewrites attribution, which comes
from the creator saved on each construction piece and from nothing else.

  python tools/era-archive/coordinate.py --output-root <root> seed
  python tools/era-archive/coordinate.py --output-root <root> ingest <payload.json | ->
  python tools/era-archive/coordinate.py --output-root <root> confirm-tag <buildKey>:<contributorKey>
  python tools/era-archive/coordinate.py --output-root <root> revoke-tag <buildKey>:<contributorKey>
  python tools/era-archive/coordinate.py --output-root <root> forget "<handle>"
  python tools/era-archive/coordinate.py --output-root <root> status

Every mutating command takes --dry-run, and every write goes through `archive.save`, which
writes a temporary file and renames it into place.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys

from archive import load, now, save
import gallery

SCHEMA = "steward-creator-participation/v1"
EXPORT_SCHEMA = "steward-creator-participation-export/v1"
BUILD_SCHEMA = "steward-creator-build-participation/v1"
EVENT_SCHEMA = "steward-creator-participation-event/v1"
# A claim says "mine" or "not mine". Both are the same record on the same build -- one
# replaces the other -- because a disavowal is a claim about oneself too, and keeping them
# in separate stores would let a build be claimed and disavowed by one person at once.
CLAIM_KINDS = ("built", "disavow")
RECORD_LISTS = ("claimRecords", "requestRecords", "tagRecords")
# What a confirmed tag may carry beyond the five public keys. `tagId` is the receipt: it
# says which ingested record this confirmation came from, so `forget` can find it again.
# gallery.sanitize_confirmed_tags() drops it on the way out.
PUBLIC_TAG_KEYS = ("buildKey", "contributorKey", "builderKey", "tags", "confirmedAt")


def participation_path(output_root):
    return Path(output_root) / "analysis" / "participation.json"


def normalize_handle(value):
    """The rule creators.js uses, so a handle matches the one the volunteer's page wrote."""
    return str(value or "").strip() or "Anonymous volunteer"


def handle_key(value):
    """Handles are typed by hand into a free-text field; matching is case-insensitive."""
    return normalize_handle(value).casefold()


def _hex(pattern, value):
    return isinstance(value, str) and bool(pattern.match(value))


def _identifier(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def clean_claim(raw, fallback_participant=None):
    """A claim as received, minus nothing -- but only if its keys point at a real build.

    Everything the volunteer typed is kept: this file is where a human answers them.
    What is checked is the join, because a record whose buildKey is not a buildKey names
    no build, and counting it would make the published totals lie."""
    if not isinstance(raw, dict):
        return None
    claim_id = _identifier(raw.get("claimId"))
    if not claim_id:
        return None
    if not _hex(gallery.HEX64, raw.get("buildKey")) or not _hex(gallery.HEX32, raw.get("builderKey")):
        return None
    record = dict(raw)
    record["claimId"] = claim_id
    record["kind"] = raw.get("kind") if raw.get("kind") in CLAIM_KINDS else "built"
    record["participant"] = normalize_handle(raw.get("participant") or fallback_participant)
    return record


def clean_request(raw, fallback_participant=None):
    if not isinstance(raw, dict):
        return None
    request_id = _identifier(raw.get("requestId"))
    if not request_id:
        return None
    if not _hex(gallery.HEX64, raw.get("buildKey")) or not _hex(gallery.HEX32, raw.get("builderKey")):
        return None
    record = dict(raw)
    record["requestId"] = request_id
    record["participant"] = normalize_handle(raw.get("participant") or fallback_participant)
    return record


def clean_tag(raw, fallback_participant=None):
    """A kinship tag, with any id outside the closed vocabulary dropped.

    An unknown id is a stale page or a hand-edited ledger, and it is not worth losing the
    rest of the tag over -- but a record left with no known tag is not a tag at all."""
    if not isinstance(raw, dict):
        return None
    tag_id = _identifier(raw.get("tagId"))
    if not tag_id:
        return None
    if not _hex(gallery.HEX64, raw.get("buildKey")):
        return None
    if not _hex(gallery.HEX32, raw.get("contributorKey")) or not _hex(gallery.HEX32, raw.get("builderKey")):
        return None
    tags = sorted({t for t in (raw.get("tags") or []) if isinstance(t, str) and t in gallery.KINSHIP_TAGS})
    if not tags:
        return None
    record = dict(raw)
    record["tagId"] = tag_id
    record["tags"] = tags
    record["participant"] = normalize_handle(raw.get("participant") or fallback_participant)
    return record


def records_from_payload(payload):
    """The three shapes a volunteer's browser can hand over, as (claims, requests, tags).

    The export is the whole ledger, the build payload is one card's worth, and the event is
    what an endpoint would have received had one ever been configured. All three are things
    a volunteer can paste into Discord today, so all three are things this has to read."""
    if not isinstance(payload, dict):
        raise ValueError("payload is not a JSON object")
    schema = payload.get("schema")
    fallback = payload.get("participant")
    if schema == EXPORT_SCHEMA:
        return (payload.get("claims") or [], payload.get("requests") or [],
                payload.get("kinshipTags") or [], fallback)
    if schema == BUILD_SCHEMA:
        claim = payload.get("claim")
        return ([claim] if claim else [], payload.get("requests") or [],
                payload.get("kinshipTags") or [], fallback)
    if schema == EVENT_SCHEMA:
        event = payload.get("eventType")
        if event == "claim":
            return ([payload.get("claim")] if payload.get("claim") else [], [], [], fallback)
        if event == "photoRequest":
            one = payload.get("request") or payload.get("photoRequest")
            return [], ([one] if one else []), [], fallback
        if event == "kinshipTag":
            one = payload.get("kinshipTag") or payload.get("tag")
            return [], [], ([one] if one else []), fallback
        raise ValueError(f"unsupported eventType {event!r}")
    raise ValueError(f"unsupported payload schema {schema!r}")


def upsert(records, incoming, id_key, cleaner, stamp, fallback_participant=None):
    """Replace by id, keeping the record's original position so the file stays readable.

    A volunteer who re-sends after adding a note has sent the same claim again, not a
    second one -- the ids are generated once, in their browser, and they are the identity."""
    by_id = {}
    for existing in records:
        key = existing.get(id_key)
        if isinstance(key, str):
            by_id[key] = existing
    added = replaced = dropped = 0
    for raw in incoming:
        record = cleaner(raw, fallback_participant)
        if record is None:
            dropped += 1
            continue
        record["receivedAt"] = stamp
        if record[id_key] in by_id:
            replaced += 1
        else:
            added += 1
        by_id[record[id_key]] = record
    return list(by_id.values()), {"added": added, "replaced": replaced, "dropped": dropped}


def recount(document):
    """Counts are derived, never edited: they are a view of the records and nothing else."""
    claims = document["claimRecords"]
    requests = document["requestRecords"]
    tags = document["tagRecords"]
    handles = {handle_key(r.get("participant")) for r in (*claims, *requests, *tags)}
    document["participants"] = len(handles)
    document["claims"] = sum(1 for c in claims if c.get("kind", "built") == "built")
    document["disavowals"] = sum(1 for c in claims if c.get("kind") == "disavow")
    document["requests"] = len(requests)
    document["openRequests"] = sum(1 for r in requests if not r.get("closedAt"))
    return document


def pending_tags(document):
    """Ingested tags with no confirmation yet -- the coordinator's actual to-do list."""
    confirmed = {(t.get("buildKey"), t.get("contributorKey")) for t in document["confirmedTags"]}
    return [t for t in document["tagRecords"] if (t.get("buildKey"), t.get("contributorKey")) not in confirmed]


def new_document(stamp):
    return {
        "schema": SCHEMA,
        "generatedAt": stamp,
        "updatedAt": stamp,
        "participants": 0,
        "claims": 0,
        "disavowals": 0,
        "requests": 0,
        "openRequests": 0,
        "confirmedTags": [],
        "claimRecords": [],
        "requestRecords": [],
        "tagRecords": [],
    }


def read_document(output_root):
    path = participation_path(output_root)
    if not path.exists():
        raise SystemExit(f"{path} does not exist -- run `coordinate.py seed` first")
    document = load(path)
    if not isinstance(document, dict) or document.get("schema") != SCHEMA:
        raise SystemExit(f"{path} is not a {SCHEMA} document")
    document.setdefault("confirmedTags", [])
    if not isinstance(document["confirmedTags"], list):
        document["confirmedTags"] = []
    for key in RECORD_LISTS:
        if not isinstance(document.get(key), list):
            document[key] = []
    return path, document


def write_document(path, document, dry_run, note=""):
    document["updatedAt"] = now()
    recount(document)
    summary = {k: document[k] for k in ("participants", "claims", "disavowals", "requests", "openRequests")}
    summary["confirmedTags"] = len(document["confirmedTags"])
    if dry_run:
        print(f"DRY RUN -- {path} left untouched")
    else:
        save(path, document)
        print(f"WROTE {path}")
    if note:
        print(note)
    print(json.dumps(summary))
    return document


def split_pair(value):
    build_key, _, contributor_key = str(value).partition(":")
    if not _hex(gallery.HEX64, build_key) or not _hex(gallery.HEX32, contributor_key):
        raise SystemExit("expected <buildKey (64 hex)>:<contributorKey (32 hex)>")
    return build_key, contributor_key


def cmd_seed(args):
    path = participation_path(args.output_root)
    if path.exists():
        raise SystemExit(f"{path} already exists -- seeding would discard every record in it")
    write_document(path, new_document(now()), args.dry_run, "seeded an empty coordinator file")


def cmd_ingest(args):
    # The file first, the payload second. Reading stdin before checking the root means a
    # mistyped --output-root sits there with the terminal blocked, waiting for a payload it
    # was never going to be able to file.
    path, document = read_document(args.output_root)
    text = sys.stdin.read() if args.payload == "-" else Path(args.payload).read_text(encoding="utf-8-sig")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        raise SystemExit(f"payload is not JSON: {error}")
    try:
        claims, requests, tags, fallback = records_from_payload(payload)
    except ValueError as error:
        raise SystemExit(str(error))
    stamp = now()
    document["claimRecords"], claim_counts = upsert(
        document["claimRecords"], claims, "claimId", clean_claim, stamp, fallback)
    document["requestRecords"], request_counts = upsert(
        document["requestRecords"], requests, "requestId", clean_request, stamp, fallback)
    document["tagRecords"], tag_counts = upsert(
        document["tagRecords"], tags, "tagId", clean_tag, stamp, fallback)
    note = (f"claims {claim_counts} · requests {request_counts} · kinship tags {tag_counts}")
    write_document(path, document, args.dry_run, note)


def cmd_confirm_tag(args):
    build_key, contributor_key = split_pair(args.pair)
    path, document = read_document(args.output_root)
    matches = [t for t in document["tagRecords"]
               if t.get("buildKey") == build_key and t.get("contributorKey") == contributor_key]
    if not matches:
        raise SystemExit(f"no ingested kinship tag for {build_key}:{contributor_key}")
    # The latest copy: a re-sent tag replaces the earlier one in place, so the last match
    # is the volunteer's most recent word on this co-builder.
    tag = matches[-1]
    entry = {
        "buildKey": build_key,
        "contributorKey": contributor_key,
        "builderKey": tag.get("builderKey"),
        "tags": list(tag.get("tags") or []),
        "confirmedAt": now(),
        "tagId": tag.get("tagId"),
    }
    kept = [e for e in document["confirmedTags"]
            if (e.get("buildKey"), e.get("contributorKey")) != (build_key, contributor_key)]
    kept.append(entry)
    kept.sort(key=lambda e: (str(e.get("buildKey")), str(e.get("contributorKey"))))
    document["confirmedTags"] = kept
    write_document(path, document, args.dry_run, f"confirmed {', '.join(entry['tags'])} on {build_key[:8]}…")


def cmd_revoke_tag(args):
    build_key, contributor_key = split_pair(args.pair)
    path, document = read_document(args.output_root)
    before = len(document["confirmedTags"])
    document["confirmedTags"] = [e for e in document["confirmedTags"]
                                 if (e.get("buildKey"), e.get("contributorKey")) != (build_key, contributor_key)]
    removed = before - len(document["confirmedTags"])
    if not removed:
        raise SystemExit(f"no confirmed kinship tag for {build_key}:{contributor_key}")
    write_document(path, document, args.dry_run, f"revoked {removed} confirmed tag(s)")


def cmd_forget(args):
    """The withdrawal answer. One handle, every record it sent, and the tags they carried."""
    target = handle_key(args.handle)
    path, document = read_document(args.output_root)
    theirs = {t.get("tagId") for t in document["tagRecords"]
              if handle_key(t.get("participant")) == target and isinstance(t.get("tagId"), str)}
    removed = {}
    for key in RECORD_LISTS:
        kept = [r for r in document[key] if handle_key(r.get("participant")) != target]
        removed[key] = len(document[key]) - len(kept)
        document[key] = kept
    before = len(document["confirmedTags"])
    document["confirmedTags"] = [e for e in document["confirmedTags"] if e.get("tagId") not in theirs]
    removed["confirmedTags"] = before - len(document["confirmedTags"])
    note = f"forgot {normalize_handle(args.handle)!r}: " + " · ".join(f"{k} {v}" for k, v in removed.items())
    write_document(path, document, args.dry_run, note)


def cmd_status(args):
    path, document = read_document(args.output_root)
    recount(document)
    root = Path(args.output_root)
    open_requests = [r for r in document["requestRecords"] if not r.get("closedAt")]
    waiting = pending_tags(document)
    print(f"{path}")
    print(f"  updated        {document.get('updatedAt')}")
    print(f"  participants   {document['participants']}")
    print(f"  claims         {document['claims']} built · {document['disavowals']} disavowed")
    print(f"  requests       {document['requests']} ({len(open_requests)} open)")
    print(f"  kinship tags   {len(document['confirmedTags'])} confirmed · {len(waiting)} pending")
    for request in open_requests[:20]:
        print(f"    open request {request.get('requestId')} · {request.get('buildLabel') or request.get('buildKey')}"
              f" · {request.get('participant')}")
    for tag in waiting[:20]:
        print(f"    pending tag  {tag.get('buildKey')}:{tag.get('contributorKey')}"
              f" · {', '.join(tag.get('tags') or [])} · {tag.get('participant')}")
    print("")
    print("  Publish what is confirmed:")
    print(f"    python tools/era-archive/gallery.py --output-root {root} "
          f"--destination {root / 'projections' / 'creators-<revision>'} --world-url https://<world-host>/world")
    print(f"    python tools/era-archive/gate_creators.py --projection {root / 'projections' / 'creators-<revision>'}")
    print(f"    python tools/era-archive/deploy_gallery.py --projection {root / 'projections' / 'creators-<revision>'} "
          f"--revision <revision> --receipt {root / 'receipts' / 'deploy-creators-<revision>.json'}")


def main():
    # A Windows console still defaults to a legacy code page, and everything this prints
    # is either a separator or a handle somebody typed -- printing one must not be able to
    # kill the command that has already written the file. Reconfigure rather than strip:
    # the output stays readable wherever UTF-8 works, and degrades instead of raising.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output-root", type=Path, required=True,
                        help="the archive output root; the file lives at <output-root>/analysis/participation.json")
    sub = parser.add_subparsers(dest="command", required=True)

    def mutating(name, help_text):
        node = sub.add_parser(name, help=help_text)
        node.add_argument("--dry-run", action="store_true",
                          help="report what would change and write nothing")
        return node

    mutating("seed", "create an empty coordinator file").set_defaults(handler=cmd_seed)
    ingest = mutating("ingest", "take in a payload a volunteer sent")
    ingest.add_argument("payload", help="path to the payload JSON, or - for stdin")
    ingest.set_defaults(handler=cmd_ingest)
    confirm = mutating("confirm-tag", "publish one ingested kinship tag")
    confirm.add_argument("pair", metavar="<buildKey>:<contributorKey>")
    confirm.set_defaults(handler=cmd_confirm_tag)
    revoke = mutating("revoke-tag", "withdraw one published kinship tag")
    revoke.add_argument("pair", metavar="<buildKey>:<contributorKey>")
    revoke.set_defaults(handler=cmd_revoke_tag)
    forget = mutating("forget", "remove everything one handle ever sent")
    forget.add_argument("handle")
    forget.set_defaults(handler=cmd_forget)
    status = sub.add_parser("status", help="counts, open requests, pending tags, next commands")
    status.set_defaults(handler=cmd_status)

    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
