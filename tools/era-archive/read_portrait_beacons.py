#!/usr/bin/env python3
"""Read the portrait choices and opt-out requests builders noted, out of the web server's
own access log -- and turn the choices into a payload coordinate.py can ingest.

The profile page notes every choice by requesting a four-byte `portrait-beacon.txt` with the
request on the query string (`action=choose|revert|optout`, `builder`, `tile`, `take`,
`level`, `receipt`). Caddy records every request as a JSON line with its URI and the
caller's address, so there is no service to run, no public write path, and nothing kept
beyond what a web server keeps anyway. The same log is where obvious abuse shows: one
address dressing many builders, or one builder dressed from many addresses.

    ssh fx99 'python3 -' < read_portrait_beacons.py                 # the picture
    ssh fx99 'python3 - --payload' < read_portrait_beacons.py > choices.json
    python tools/era-archive/coordinate.py --output-root E:\\omen\\steward-multi-era ingest choices.json --portraits <live portraits.json>
    python tools/era-archive/coordinate.py --output-root E:\\omen\\steward-multi-era confirm-portrait <builderKey>

The payload is the latest choice per builder (a revert included, as tile: null), in the
export shape the browser itself copies, with the address left out.
"""
import argparse
import collections
import json
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DEFAULT_LOG = Path("/var/log/caddy/access.log")
HEX32 = re.compile(r"^[a-f0-9]{32}$")
TILE = re.compile(r"^[a-z0-9]+/[a-z0-9_]+$")
TAKE = re.compile(r"^s[0-9]{1,3}$")
RECEIPT = re.compile(r"^r-[0-9]{8}-[0-9a-f]{8}$")
ACTIONS = ("choose", "revert", "optout")
LEVELS = ("name", "erase")


def first(query, name):
    return (query.get(name) or [""])[0].strip()


def notes(paths):
    """Yield one dict per well-formed beacon line, in log order."""
    for path in paths:
        for line in path.read_text(errors="replace").splitlines():
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            request = entry.get("request", {})
            uri = request.get("uri", "")
            if "portrait-beacon" not in uri:
                continue
            query = parse_qs(urlparse(uri).query)
            action = first(query, "action")
            builder = first(query, "builder")
            if action not in ACTIONS or not HEX32.match(builder):
                continue
            note = {
                "ts": entry.get("ts"),
                "addr": (request.get("remote_ip") or request.get("remote_addr") or "").split(":")[0],
                "action": action,
                "builderKey": builder,
                "receipt": first(query, "receipt") if RECEIPT.match(first(query, "receipt")) else None,
            }
            if action == "choose":
                tile, take = first(query, "tile"), first(query, "take")
                if not TILE.match(tile):
                    continue
                note["tile"] = tile
                note["take"] = take if TAKE.match(take) else None
            elif action == "optout":
                level = first(query, "level")
                if level not in LEVELS:
                    continue
                note["level"] = level
            yield note


def latest_choices(found):
    """The last word per builder among choose/revert lines."""
    latest = {}
    for note in found:
        if note["action"] in ("choose", "revert"):
            latest[note["builderKey"]] = note
    return latest


def payload(found):
    lines = []
    for key, note in sorted(latest_choices(found).items()):
        lines.append({
            "portraitId": f"beacon-{note['receipt'] or key[:8]}",
            "builderKey": key,
            "tile": note.get("tile") if note["action"] == "choose" else None,
            "take": note.get("take") if note["action"] == "choose" else None,
            "sha": None,
            "participant": "",
            "chosenAt": note.get("ts"),
            "receipt": note.get("receipt"),
            "source": "portrait-beacon",
        })
    return {"schema": "steward-creator-participation-export/v1", "createdAt": None, "participant": "",
            "claims": [], "requests": [], "kinshipTags": [], "priorities": [], "portraits": lines}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("logs", nargs="*", type=Path, default=None,
                        help="access logs to read (default: /var/log/caddy/access.log and its rotations)")
    parser.add_argument("--payload", action="store_true", help="print the latest choice per builder as an ingestable payload")
    parser.add_argument("--recent", type=int, default=25, help="how many recent notes to list")
    args = parser.parse_args()

    paths = list(args.logs or [])
    if not paths and DEFAULT_LOG.parent.is_dir():
        paths = sorted(DEFAULT_LOG.parent.glob(DEFAULT_LOG.name + "*"))
    paths = [p for p in paths if p.is_file() and not p.name.endswith(".gz")]
    if not paths:
        raise SystemExit(f"No access log found at {DEFAULT_LOG}")

    found = list(notes(paths))
    if args.payload:
        print(json.dumps(payload(found), indent=2))
        return
    if not found:
        print("No portrait notes recorded yet.")
        return
    by_action = collections.Counter(n["action"] for n in found)
    print(f"{len(found):,} notes: " + " · ".join(f"{by_action[a]} {a}" for a in ACTIONS))
    latest = latest_choices(found)
    print(f"{len(latest):,} builders with a latest choice ({sum(1 for n in latest.values() if n['action'] == 'revert')} reverted)")
    optouts = [n for n in found if n["action"] == "optout"]
    if optouts:
        print(f"{len(optouts)} opt-out notes on {len({n['builderKey'] for n in optouts})} builders -- match them to messages on Discord")
    # Abuse, in the two shapes it takes.
    per_addr = collections.Counter(n["addr"] for n in found if n["action"] == "choose")
    builders_per_addr = collections.defaultdict(set)
    addrs_per_builder = collections.defaultdict(set)
    for n in found:
        if n["action"] == "choose":
            builders_per_addr[n["addr"]].add(n["builderKey"])
            addrs_per_builder[n["builderKey"]].add(n["addr"])
    busy = [(a, len(b)) for a, b in builders_per_addr.items() if len(b) >= 3]
    if busy:
        print("\naddresses dressing three or more builders (look here first)")
        for addr, count in sorted(busy, key=lambda x: -x[1])[:20]:
            print(f"  {addr:>15}  {count} builders, {per_addr[addr]} choices")
    contested = [(k, len(a)) for k, a in addrs_per_builder.items() if len(a) >= 2]
    if contested:
        print("\nbuilders dressed from two or more addresses")
        for key, count in sorted(contested, key=lambda x: -x[1])[:20]:
            print(f"  {key}  {count} addresses")
    print(f"\nlast {min(args.recent, len(found))}")
    for n in found[-args.recent:]:
        what = n.get("tile") and f"{n['tile']}#{n.get('take') or '-'}" or n.get("level") or "archive's pick"
        print(f"  {n['ts']}  {n['addr']:>15}  {n['action']:<6} {n['builderKey'][:8]}…  {what}  {n['receipt'] or ''}")


if __name__ == "__main__":
    sys.exit(main())
