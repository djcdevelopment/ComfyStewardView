#!/usr/bin/env python3
"""Read what visitors searched for out of the web server's own access log.

The creators page logs searches by requesting a four-byte `search-beacon.txt` with the
term and the match count on the query string, and by carrying `?q=` on the page URL
itself. Caddy already records every request as a JSON line with its URI, so there is no
service to run, no public write path, and nothing kept beyond what a web server keeps
anyway.

    ssh fx99 'python3 -' < read_searches.py            # the whole log
    ssh fx99 'python3 - --misses' < read_searches.py   # only searches that found nobody
"""
import argparse
import collections
import json
from pathlib import Path
import sys
from urllib.parse import parse_qs, urlparse

DEFAULT_LOG = Path("/var/log/caddy/access.log")


def searches(paths):
    """Yield (timestamp, term, matches) for every recorded search."""
    for path in paths:
        for line in path.read_text(errors="replace").splitlines():
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            uri = entry.get("request", {}).get("uri", "")
            if "search-beacon" not in uri and "creators/?q=" not in uri:
                continue
            query = parse_qs(urlparse(uri).query)
            term = (query.get("q") or [""])[0].strip()
            if not term:
                continue
            matches = (query.get("n") or [None])[0]
            yield entry.get("ts"), term, None if matches is None else int(matches)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("logs", nargs="*", type=Path, default=None,
        help="access logs to read (default: /var/log/caddy/access.log and its rotations)")
    parser.add_argument("--misses", action="store_true",
        help="only terms that matched no builder -- names the archive cannot find")
    parser.add_argument("--recent", type=int, default=25, help="how many recent searches to list")
    args = parser.parse_args()

    paths = list(args.logs or [])
    if not paths and DEFAULT_LOG.parent.is_dir():
        # Caddy rotates to access.log.1, .2.gz and so on; read whatever is still plain.
        paths = sorted(DEFAULT_LOG.parent.glob(DEFAULT_LOG.name + "*"))
    paths = [p for p in paths if p.is_file() and not p.name.endswith(".gz")]
    if not paths:
        raise SystemExit(f"No access log found at {DEFAULT_LOG}")

    found = list(searches(paths))
    if args.misses:
        found = [s for s in found if s[2] == 0]
    if not found:
        print("No searches recorded yet.")
        return

    counts = collections.Counter(term.casefold() for _, term, _ in found)
    misses = {term.casefold() for _, term, matches in found if matches == 0}
    print(f"{len(found):,} searches, {len(counts):,} distinct terms, {len(misses):,} matched nobody\n")
    print("most searched")
    for term, n in counts.most_common(20):
        print(f"  {n:>5}  {term}{'   (no match)' if term in misses else ''}")
    print(f"\nlast {min(args.recent, len(found))}")
    for ts, term, matches in found[-args.recent:]:
        print(f"  {ts}  {term!r} -> {'?' if matches is None else matches} builders")


if __name__ == "__main__":
    sys.exit(main())
