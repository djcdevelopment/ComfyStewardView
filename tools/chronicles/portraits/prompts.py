"""The portrait matrix: 48 distinct, stylistically uniform Viking bust portraits.

12 roles x 2 ages x 2 presentations = 48. Hair/expression rotates over eight
variants and the sitter alternates facing left/right, so no two prompts read the
same while every tile shares one palette phrase and one composition. Seeds are
fixed per slot so a tile is reproducible from this file alone; `--reseed` in
generate.py adds a million to the slot seed and records the attempt.

Public tags are role / age / presentation only. Nothing here names a builder.
"""
from __future__ import annotations

ROLES = [
    ("stonemason", "a stonemason with a wooden mallet resting on one shoulder"),
    ("shipwright", "a shipwright with a coil of tarred rope over the shoulder"),
    ("joiner", "a timber joiner holding a chisel"),
    ("thatcher", "a thatcher with wisps of straw caught on the collar"),
    ("blacksmith", "a blacksmith with soot on the cheek and a leather apron"),
    ("fisher", "a fisher with a net folded over one shoulder"),
    ("farmer", "a farmer wearing a wreath of barley"),
    ("hunter", "a hunter with a bow stave against the shoulder"),
    ("beekeeper", "a beekeeper with a loose veil pushed back"),
    ("brewer", "a brewer holding a stave tankard"),
    ("surveyor", "a surveyor with a rolled chart under one arm"),
    ("hearthkeeper", "a hearth keeper lit from below by a lantern's glow"),
]
AGES = [("young", "young adult"), ("elder", "grey-haired elder")]
PRESENTATIONS = [("woman", "woman"), ("man", "man")]
LOOKS = [
    "braided hair, calm expression",
    "cropped hair, faint smile",
    "long loose hair, steady gaze",
    "shaved sides, weathered face",
    "hair tied back, amused expression",
    "hooded, thoughtful expression",
    "wind-blown hair, proud bearing",
    "beaded braids, kind expression",
]
TAIL = (
    "painted bust portrait, head and shoulders, centred, square composition, "
    "plain flat dark slate grey background, soft even light, muted slate blue and "
    "charcoal palette with one warm ember amber accent, visible brushwork, Nordic "
    "iron-age wool and leather clothing, one person, no lettering, no border"
)
SEED_BASE = 7_000_000
SEED_STEP = 97


def tiles() -> list[dict]:
    out = []
    n = 0
    for role_tag, role_phrase in ROLES:
        for age_tag, age_phrase in AGES:
            for pres_tag, pres_phrase in PRESENTATIONS:
                n += 1
                look = LOOKS[n % len(LOOKS)]
                side = "left" if n % 2 else "right"
                prompt = (f"{age_phrase} {pres_phrase}, {role_phrase}, {look}, "
                          f"facing slightly {side}, {TAIL}")
                out.append({
                    "id": f"p{n:02d}",
                    "seed": SEED_BASE + n * SEED_STEP,
                    "prompt": prompt,
                    "tags": [role_tag, age_tag, pres_tag],
                })
    assert len(out) == 48 and len({t["prompt"] for t in out}) == 48
    return out


if __name__ == "__main__":
    for t in tiles():
        print(t["id"], t["seed"], t["prompt"])
