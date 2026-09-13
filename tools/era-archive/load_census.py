#!/usr/bin/env python3
"""What the game itself counted when it loaded a world -- read from Player.log, never inferred.

Every terrain run launches the frozen client on an isolated copy of the save and the client
narrates the load: how many ZDOs the header declared, which data version, how many prefabs
it could not name, every legacy conversion pass and what it touched, and how many objects it
wrote back on quit. That narration is the only independent witness to the parser's own
counts, so it is captured verbatim into the terrain receipt as `loadCensus`.

Both client generations are read: 0.221.12 ("Loading N zdos ... data version: V") and
1.0.x ("ZDOMan.Load - Starting to load N zdos ... WorldVersion: V").
"""
import argparse
import json
from pathlib import Path
import re
import sys

_INT = r"([\d,]+)"


def _int(text):
    return int(text.replace(",", ""))


PATTERNS = {
    "gameVersion": (re.compile(r"Valheim version: (\S+) \(network version (\d+)\)"), lambda m: {"gameVersion": m[1], "networkVersion": int(m[2])}),
    "loadWorld": (re.compile(r"Load world: (\S+) \((\S+)\)"), lambda m: {"worldLoaded": m[1], "worldFile": m[2]}),
    "legacyLoad": (re.compile(rf"Loading {_INT} zdos, my sessionID: -?\d+, data version: (\d+)"),
                   lambda m: {"declaredZdos": _int(m[1]), "dataVersion": int(m[2])}),
    "modernLoad": (re.compile(rf"ZDOMan\.Load - Starting to load {_INT} zdos\. SessionID: -?\d+, WorldVersion: (\d+)"),
                   lambda m: {"declaredZdos": _int(m[1]), "dataVersion": int(m[2])}),
    "unknownPrefabs": (re.compile(rf"Found {_INT} ZDOs with unknown prefabs"), lambda m: {"unknownPrefabZdos": _int(m[1])}),
    "saved": (re.compile(rf"Saved {_INT} ZDOs"), lambda m: {"savedZdos": _int(m[1])}),
}

CONVERSIONS = {
    "creationTimes": re.compile(rf"Converted {_INT} Creation Times"),
    "portalsChecked": re.compile(rf"ConvertPortals => Make sure all {_INT} portals"),
    "portalsFixed": re.compile(rf"ConvertPortals => fixed {_INT} portals"),
    "spawnersTried": re.compile(rf"ConvertSpawners => Will try and convert {_INT} spawners"),
    "spawnersConverted": re.compile(rf"ConvertSpawners => Converted {_INT} spawners"),
    "spawnersDone": re.compile(rf"ConvertSpawners => Converted [\d,]+ spawners, and {_INT} 'done' spawners"),
    "syncTransforms": re.compile(rf"ConvertSyncTransforms => Will try and convert {_INT} SyncTransforms"),
    "itemSeeds": re.compile(rf"ConvertSeed => Converted {_INT} ZDOs"),
    "inventories": re.compile(rf"ConvertInventories => Converted {_INT} ZDOs"),
    "containers": re.compile(rf"ConvertContainers => Converted {_INT} ZDOs"),
    "prefabStrings": re.compile(rf"ConvertPrefabStrings => Converted {_INT} strings"),
}

MISSING_LOCATION = re.compile(r"Missing location:(-?\d+)")
LOAD_FAILED = re.compile(r"World load failed, exiting without save")
LOAD_EXCEPTION = re.compile(r"Exception while loading world .*?:(\S+)")
DUNGEON_CONVERSION = re.compile(r"Converting Dungeons")


def load_census(text):
    """Distil one client session's Player.log into the counts the archive can be checked against."""
    census, conversions, missing = {}, {}, []
    for line in text.splitlines():
        for pattern, extract in PATTERNS.values():
            match = pattern.search(line)
            if match:
                census.update(extract(match))
        for name, pattern in CONVERSIONS.items():
            match = pattern.search(line)
            if match:
                conversions[name] = _int(match[1])
        match = MISSING_LOCATION.search(line)
        if match:
            missing.append(int(match[1]))
        if DUNGEON_CONVERSION.search(line):
            conversions["dungeons"] = True
        if LOAD_FAILED.search(line):
            census["worldLoadFailed"] = True
        match = LOAD_EXCEPTION.search(line)
        if match and "loadException" not in census:
            census["loadException"] = match[1]
    # The client refusing the world after converting it is a fact about the save, not a
    # crash: era 4 (v28) on l-1.0.7 hit EndOfStreamException in Inventory.LoadOld, the
    # minimap caches were still written from the seed, and the receipt must say both.
    census["conversions"] = conversions
    census["missingLocations"] = sorted(set(missing))
    if "declaredZdos" in census and "savedZdos" in census:
        census["savedDelta"] = census["savedZdos"] - census["declaredZdos"]
    return census


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("player_log", type=Path, nargs="+")
    parser.add_argument("--expect", type=int, help="declared ZDO count the catalog holds; a mismatch exits non-zero")
    args = parser.parse_args()
    status = 0
    for path in args.player_log:
        census = load_census(path.read_text(encoding="utf-8", errors="replace"))
        print(json.dumps({"log": str(path), **census}, indent=2))
        if args.expect is not None and census.get("declaredZdos") != args.expect:
            print(f"MISMATCH {path}: client declared {census.get('declaredZdos')}, catalog expects {args.expect}", file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
