"""Which painted portrait a builder wears until they choose one.

Every builder record gets a face from the archive's portrait library, picked for them from
what the archive actually knows -- how much they built (the tier), how long they have been
at it (the era span) -- and a seeded coin for everything it does not know. The pick is a
pure function of the builder key and the library, so two projections agree and nobody's
face changes when the neighbour's does; a re-cut of the library that drops a trade makes
the pick fall through to the whole library rather than to nothing.

    assign_portrait(record, library) -> {"tile": "viking96/jarl_m_chieftain", "take": "s7"}

`record` is the public builder record gallery.py is about to write (tier, eras, albums,
pieces). `library` is a portrait library manifest (a build_manifest.py tree's manifest.json
or a built portraits.json) -- only `tiles[].{id, library, tags, takes[].id}` are read.
"""
from __future__ import annotations

import hashlib
import random

SALT = "portrait-v1"

# The trades a tier draws from, most fitting first. Builders who put up ten thousand pieces
# wear the jarl's and the architect's faces; a one-outpost explorer wears a hunter's or a
# skald's. Names are the library's role tokens.
POOLS = {
    "Megabuilder": ("jarl", "architect", "fortifier", "harbor", "stonemason"),
    "Major Architect": ("architect", "carpenter", "stonemason", "shipwright", "fortifier", "harbor"),
    "Established Builder": ("carpenter", "blacksmith", "miner", "smelter", "jeweler", "shipwright", "stonemason"),
    "Homesteader": ("brewer", "furrier", "hunter", "carpenter", "skald", "frost", "whaler"),
    "Explorer": ("hunter", "reaver", "frost", "varangian", "skald", "shaman", "seer", "shieldmaiden", "berserker"),
}
DEFAULT_TIER = "Explorer"

# Variant names that read as a lifetime at the craft, and as a first season.
SENIOR_VARIANTS = ("master", "chieftain", "highbuilder", "dockmaster", "veteran", "matriarch", "elderlore", "chiefjudge")
JUNIOR_VARIANTS = ("apprentice", "herbalist", "crucible", "bonereader")
VETERAN_ERAS = 4          # this many eras, or a first era this early, reads as a veteran
VETERAN_FIRST_ERA = 8
NEWCOMER_FIRST_ERA = 14   # one era, and a late one, reads as a first season


def _seed(builder_key: str, salt: str) -> random.Random:
    digest = hashlib.sha256(f"{builder_key}{salt}".encode("utf-8")).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def library_tiles(library: dict) -> list[dict]:
    """The painted tiles of a manifest: those with takes, whatever library they name."""
    out = []
    lib = library.get("library") if isinstance(library.get("library"), str) else None
    for tile in library.get("tiles") or []:
        if not isinstance(tile, dict) or not isinstance(tile.get("id"), str):
            continue
        takes = [t["id"] for t in (tile.get("takes") or []) if isinstance(t, dict) and isinstance(t.get("id"), str)]
        if not takes:
            continue
        tags = tile.get("tags") if isinstance(tile.get("tags"), dict) else {}
        out.append({
            "qualified": f"{tile.get('library') or lib or 'viking96'}/{tile['id']}",
            "id": tile["id"],
            "role": tags.get("role"),
            "presentation": tags.get("presentation"),
            "age": tags.get("age"),
            "variant": tile["id"].rsplit("_", 1)[-1],
            "takes": takes,
        })
    return out


def seniority(record: dict) -> str:
    """'veteran', 'newcomer' or 'settled', from the eras a builder shows up in."""
    eras = sorted(e for e in (record.get("eras") or []) if isinstance(e, int))
    if not eras:
        return "settled"
    if len(eras) >= VETERAN_ERAS or eras[0] <= VETERAN_FIRST_ERA:
        return "veteran"
    if len(eras) == 1 and eras[0] >= NEWCOMER_FIRST_ERA:
        return "newcomer"
    return "settled"


def candidates(record: dict, tiles: list[dict]) -> list[dict]:
    """The tiles a builder may be given, narrowed as far as the library allows and never
    to nothing: tier pool -> seniority leaning -> the whole pool -> the whole library."""
    tier = record.get("tier") if record.get("tier") in POOLS else DEFAULT_TIER
    pool = [t for t in tiles if t["role"] in POOLS[tier]]
    if not pool:
        return list(tiles)
    lean = seniority(record)
    if lean == "veteran":
        leaning = [t for t in pool if t["variant"] in SENIOR_VARIANTS or t["age"] == "elder"]
    elif lean == "newcomer":
        leaning = [t for t in pool if t["variant"] in JUNIOR_VARIANTS or t["age"] == "young"]
    else:
        leaning = [t for t in pool if t["age"] == "adult"]
    return leaning or pool


def assign_portrait(record: dict, library: dict, salt: str = SALT) -> dict | None:
    """The tile and take this builder wears by the archive's pick, or None for an empty library."""
    tiles = library_tiles(library)
    if not tiles or not isinstance(record, dict) or not record.get("builderKey"):
        return None
    rng = _seed(str(record["builderKey"]), salt)
    pool = candidates(record, tiles)
    # The coin the archive cannot inform: which presentation. Flipped first so the same
    # builder lands on the same side whatever else the pool holds.
    side = rng.choice(("woman", "man"))
    sided = [t for t in pool if t["presentation"] == side] or pool
    tile = rng.choice(sorted(sided, key=lambda t: t["qualified"]))
    take = rng.choice(list(tile["takes"]))
    return {"tile": tile["qualified"], "take": take}
