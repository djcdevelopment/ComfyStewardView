#!/usr/bin/env python3
"""Bake the Valheim Chronicles front door: gateway, field manual, and the counts.

The archive's own pages are client-rendered; this one is not. Every number a visitor
reads here is fetched at build time from the same two JSON files the live pages read,
baked into the HTML, and recorded with its source hash in build.json. Nothing third-party
is ever fetched -- no fonts, no CDN, no analytics. The one request either page makes of
its own is the gateway prefetching this archive's directory.json so the name box can
answer without a page load; the portrait manifest it draws from is inlined at build time.

    python build.py --source-base https://fx99.tail8e749c.ts.net --out DIR
    python build.py --offline tests/fixtures --out DIR          # no network

Caddy caches /chronicles/img/** immutably for a week, so every asset except the fonts
carries a content hash in its name. The fonts keep stable names because the other
archive pages reference them by the exact paths written into fonts.css.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

# The five illustrated paths, in the order the guide reads them. Their figures are still
# built and still named in portraits.json; the front page no longer shows a row of them.
PATH_IDS = ("find", "study", "walk", "request", "data")

SOURCES = {
    "directory": "/valheim/creators/directory.json",
    "eras": "/valheim/eras.json",
}

CUTOUT_SIZES = (512, 256)
SHOT_SIZE = (720, 450)
PORTRAIT_THUMB = 128
WEBP_QUALITY = 82
PORTRAIT_THUMB_QUALITY = 80
SHOT_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")

PORTRAITS_SCHEMA = "chronicles-portraits/v1"
DEFAULT_PORTRAITS = HERE / "assets" / "portraits"

WORLD_VIEWER = "https://am4.tail8e749c.ts.net/world"


# --------------------------------------------------------------------------- helpers

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stamp(data: bytes) -> str:
    """Eight hex characters is the whole cache-busting contract; the full digest lives
    in receipt.json where something can actually be verified against it."""
    return sha256(data)[:8]


def esc(value: object) -> str:
    """For attribute values."""
    return html.escape(str(value), quote=True)


def text(value: object) -> str:
    """For element content. Quotes are left alone so the copy reaches the page source
    exactly as it is written in copy.json -- an apostrophe rendered as &#x27; is correct
    and invisible, but it makes "is this string verbatim?" unanswerable by reading."""
    return html.escape(str(value), quote=False)


def thousands(n: int) -> str:
    return f"{n:,}"


def head_sha() -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(REPO), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


# ----------------------------------------------------------------------------- input

def fetch(url: str, timeout: int = 120) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        if response.status != 200:
            raise OSError(f"{url} answered {response.status}")
        return response.read()


def read_sources(source_base: str, offline: Path | None) -> tuple[dict, dict, list[dict]]:
    """Both files or nothing. A half-fetched build would bake a stale count beside a
    fresh one and look completely healthy, so a failed fetch stops the build unless the
    caller has explicitly asked for fixtures instead."""
    docs, receipts = {}, []
    for name, route in SOURCES.items():
        if offline:
            path = offline / f"{name}.json"
            if not path.is_file():
                raise SystemExit(f"Offline fixture missing: {path}")
            raw, url = path.read_bytes(), path.as_uri()
        else:
            url = source_base.rstrip("/") + route
            try:
                raw = fetch(url)
            except (urllib.error.URLError, OSError, TimeoutError) as error:
                raise SystemExit(
                    f"Could not read {url}: {error}. "
                    "Refusing to bake counts from an incomplete read; pass --offline to build from fixtures."
                ) from error
        docs[name] = json.loads(raw)
        receipts.append({"url": url, "sha256": sha256(raw), "bytes": len(raw)})
    return docs["directory"], docs["eras"], receipts


def compute_counts(directory: dict) -> dict:
    """The hero totals, by the rule the live builders index uses (creators.js
    computeHeroStats). Three things in it are load-bearing and easy to get wrong:

      * builders is len(builders) with no filter at all -- placeholder "Builder 8014fa60"
        threads and unphotographed builders are counted.
      * photos is photography.photos, NOT the sum of each builder's own photos: a shared
        album's photographs would otherwise be counted once per credited contributor.
      * eras is the union of every builder's own eras list, because the top-level eras[]
        covers only terrain-analysed eras and omits the photo-only legacy eras 16 and 17.
        That union is what the live page labels "Populated eras": it counts era 11, which
        has builders but no photographs yet.
    """
    builders = len(directory["builders"])
    photos = (directory.get("photography") or {}).get("photos", 0)
    eras = len({era for b in directory["builders"] for era in b["eras"]})
    return {"builders": builders, "photos": photos, "erasWithPhotos": eras}


def era_rows(directory: dict, eras_doc: dict) -> list[dict]:
    """One row per photographed-or-not era: counts from the directory, links from
    eras.json. An era can have counts and no gallery (nothing published yet) or a
    gallery and no counts, so neither file may drive the join on its own."""
    by_slug = {e["slug"]: e for e in eras_doc.get("eras", [])}
    current = eras_doc.get("current")
    rows = []
    for row in (directory.get("photography") or {}).get("eras", []):
        slug = f"era{row['era']}"
        link = by_slug.get(slug)
        rows.append({
            "era": row["era"],
            "slug": slug,
            "label": link["label"] if link else f"Era {row['era']}",
            "href": link["href"] if link else None,
            "albums": row.get("albums", 0),
            "albumsWithPhotos": row.get("albumsWithPhotos", 0),
            "photos": row.get("photos", 0),
            "current": slug == current,
        })
    return rows


# ---------------------------------------------------------------------------- assets

class Out:
    """Writes into the output directory and keeps the receipt as it goes."""

    def __init__(self, root: Path):
        self.root = root
        self.files: list[dict] = []

    def write(self, rel: str, data: bytes) -> str:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self.files.append({"path": rel.replace("\\", "/"), "bytes": len(data), "sha256": sha256(data)})
        return rel.replace("\\", "/")

    def write_hashed(self, pattern: str, data: bytes) -> str:
        """pattern carries one {} where the content stamp goes."""
        return self.write(pattern.format(stamp(data)), data)


def to_webp(image: Image.Image, size: tuple[int, int] | None = None,
            quality: int = WEBP_QUALITY) -> bytes:
    import io

    work = image
    if size and work.size != size:
        work = work.resize(size, Image.LANCZOS)
    buffer = io.BytesIO()
    # RGBA in, RGBA out: the cutouts are die-cut stickers and a white box behind one
    # would be the single most visible defect on the page.
    work.save(buffer, "WEBP", quality=quality, method=6)
    return buffer.getvalue()


def cover(image: Image.Image, width: int, height: int) -> Image.Image:
    want = width / height
    have = image.width / image.height
    if have > want:
        new = int(round(image.height * want))
        box = ((image.width - new) // 2, 0, (image.width - new) // 2 + new, image.height)
    else:
        new = int(round(image.width / want))
        box = (0, (image.height - new) // 2, image.width, (image.height - new) // 2 + new)
    return image.crop(box).resize((width, height), Image.LANCZOS)


def build_cutouts(out: Out) -> dict:
    """Each PNG figure becomes a 512 and a 256 webp; the drawn guide figure ships as the
    svg it already is.

    Each webp is written twice, byte for byte: once under its content hash for the pages
    that link it and once under a stable name for anything that has to name a figure
    without reading this build's manifest first. The stable copies carry a `v` in
    portraits.json instead, which is what a consumer appends to bust the immutable cache.
    """
    assets: dict[str, dict] = {}
    for name in PATH_IDS:
        source = HERE / "assets" / "cutouts" / f"{name}.png"
        with Image.open(source) as image:
            image.load()
            figure = image.convert("RGBA")
        entry = {}
        for size in CUTOUT_SIZES:
            data = to_webp(figure, (size, size))
            suffix = "" if size == max(CUTOUT_SIZES) else f".{size}"
            entry[str(size)] = out.write_hashed(f"img/cutouts/{name}{suffix}.{{}}.webp", data)
            key = "file" if size == max(CUTOUT_SIZES) else "thumb"
            entry[key] = out.write(f"img/cutouts/{name}{suffix}.webp", data)
            if key == "file":
                entry["v"] = stamp(data)
        assets[name] = entry
    svg = (HERE / "assets" / "cutouts" / "guide.svg").read_bytes()
    assets["guide"] = {"svg": out.write_hashed("img/cutouts/guide.{}.svg", svg)}
    return assets


def build_portraits(out: Out, portraits_dir: Path | None) -> dict:
    """The drawn tiles a builder wears beside their name in the search suggestions.

    Another lane generates them. This one only ships what it finds: the full tile is
    copied byte for byte (it is already the artist's webp, and re-encoding it here would
    quietly degrade it every build), and only the 128 thumbnail is derived. A tree with no
    tiles in it yet is not an error -- the front door has to be a finished page on the day
    before the first portrait exists, and count 0 is what tells the gateway to draw the
    emblem instead.
    """
    empty = {"count": 0, "tiles": []}
    directory = Path(portraits_dir) if portraits_dir is not None else DEFAULT_PORTRAITS
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        print(f"  portraits       none at {directory} -- building without tiles")
        return empty
    source = json.loads(manifest_path.read_text(encoding="utf-8"))
    if source.get("schema") != PORTRAITS_SCHEMA:
        raise SystemExit(
            f"{manifest_path} declares schema {source.get('schema')!r}, expected {PORTRAITS_SCHEMA!r}"
        )
    tiles = []
    for tile in source.get("tiles", []):
        tile_id = tile["id"]
        full = directory / f"{tile_id}.webp"
        if not full.is_file():
            raise SystemExit(f"{manifest_path} lists {tile_id} but {full} is not there")
        data = full.read_bytes()
        out.write(f"img/portraits/{tile_id}.webp", data)
        with Image.open(full) as image:
            image.load()
            tile_image = image.convert("RGBA")
        thumb = to_webp(tile_image, (PORTRAIT_THUMB, PORTRAIT_THUMB), PORTRAIT_THUMB_QUALITY)
        out.write(f"img/portraits/{tile_id}.{PORTRAIT_THUMB}.webp", thumb)
        tiles.append({
            "id": tile_id,
            "file": f"{tile_id}.webp",
            "thumb": f"{tile_id}.{PORTRAIT_THUMB}.webp",
            # The stamp of the tile itself, so a redrawn tile changes the query string on
            # both its sizes at once and neither can be served stale against the other.
            "v": stamp(data),
            "seed": tile.get("seed"),
            "tags": tile.get("tags", []),
        })
    declared = source.get("count")
    if declared is not None and declared != len(tiles):
        raise SystemExit(f"{manifest_path} says count {declared} but lists {len(tiles)} tiles")
    return {"count": len(tiles), "tiles": tiles}


def build_shots(out: Out, shots: Path | None) -> dict:
    """Tutorial crops are optional and usually absent: the manual has to read as a
    finished page on the day before anybody has taken a screenshot for it."""
    if not shots or not shots.is_dir():
        return {}
    found = {}
    for source in sorted(shots.iterdir()):
        if source.suffix.lower() not in SHOT_SUFFIXES or not source.is_file():
            continue
        with Image.open(source) as image:
            image.load()
            crop = cover(image.convert("RGB"), *SHOT_SIZE)
        found[source.stem] = out.write_hashed(f"img/shots/{source.stem}.{{}}.webp", to_webp(crop))
    return found


def build_fonts(out: Out) -> list[str]:
    written = []
    for source in sorted((HERE / "assets" / "fonts").glob("*.woff2")):
        written.append(out.write(f"img/fonts/{source.name}", source.read_bytes()))
    return written


def inline_emblem(css_class: str, px: int) -> str:
    svg = (HERE / "assets" / "emblem.svg").read_text(encoding="utf-8").strip()
    svg = svg.replace('width="64" height="64"', f'width="{px}" height="{px}"', 1)
    return svg.replace(
        "<svg ", f'<svg class="{css_class}" aria-hidden="true" focusable="false" ', 1
    )


# --------------------------------------------------------------------------- markup

def render(template: str, values: dict) -> str:
    out = template
    for key, value in values.items():
        out = out.replace("{{" + key + "}}", str(value))
    left = re.search(r"\{\{(\w+)\}\}", out)
    if left:
        raise SystemExit(f"Template placeholder never filled: {left.group(1)}")
    return out


def shell_parts(values: dict) -> tuple[str, str]:
    source = (HERE / "templates" / "shell.html").read_text(encoding="utf-8")

    def block(name: str) -> str:
        found = re.search(rf"<!-- {name} -->(.*?)<!-- /{name} -->", source, re.S)
        if not found:
            raise SystemExit(f"shell.html has no {name} block")
        return render(found.group(1).strip(), values)

    return block("HEADER"), block("FOOTER")


def era_chips(rows: list[dict], eras_doc: dict) -> str:
    """Chips follow eras.json, which is the list of galleries that actually exist."""
    chips = []
    for era in eras_doc.get("eras", []):
        current = ' aria-current="page"' if era["slug"] == eras_doc.get("current") else ""
        mark = " is-current" if current else ""
        chips.append(
            f'      <a class="chip{mark}" href="{esc(era["href"])}"{current}>{text(era["label"])}</a>'
        )
    return "\n".join(chips)


def stat_slab(label: str, value: str) -> str:
    return (
        '      <div class="slab stat">\n'
        f'        <span class="stat-value">{text(value)}</span>\n'
        f'        <span class="eyebrow stat-label">{text(label)}</span>\n'
        "      </div>"
    )


def portraits_doc(portraits: dict, cutouts: dict, copy: dict, head: str, generated: str) -> dict:
    """One file naming every drawn thing the archive can put beside a builder or a path,
    and the query string that busts each one.

    It lives at the output root beside build.json, so deploy.py links it the same way, and
    the same object is inlined into the gateway page so the search suggestions draw a
    portrait without a second request. `index` is written out as the rule rather than as a
    table: the mapping is a pure function of the builderKey, so a consumer that never saw
    this build can still work out which tile a builder wears.
    """
    return {
        "schema": PORTRAITS_SCHEMA,
        "count": portraits["count"],
        "base": "/chronicles/img/portraits/",
        "index": "parseInt(builderKey.slice(0,8),16) % count",
        "tiles": portraits["tiles"],
        "cutouts": {
            name: {
                "file": "/chronicles/" + cutouts[name]["file"],
                "thumb": "/chronicles/" + cutouts[name]["thumb"],
                "v": cutouts[name]["v"],
            }
            for name in PATH_IDS
        },
        "paths": {
            name: {
                "aria_label": copy["paths"][name]["aria_label"],
                "line": copy["paths"][name]["card_h3"],
                "href": copy["paths"][name]["href"],
            }
            for name in PATH_IDS
        },
        "head": head,
        "generatedAt": generated,
    }


def inline_json(doc: dict) -> str:
    """Into a <script type="application/json"> block: the only sequence that could end the
    block early is the one that is escaped here."""
    return json.dumps(doc, separators=(",", ":")).replace("</", "<\\/")


def guide_toc(copy: dict) -> str:
    items = [(card_id, copy["paths"][card_id]["guide"]["h2"]) for card_id in PATH_IDS]
    items += [
        ("claims", copy["guide"]["claims"]["h2"]),
        ("data-files", copy["guide"]["data"]["h2"]),
        ("eras", copy["guide"]["eras"]["h2"]),
    ]
    return "\n".join(
        f'        <li><a href="#{anchor}">{text(title)}</a></li>' for anchor, title in items
    )


def guide_sections(copy: dict, cutouts: dict, shots: dict, prefix: str) -> str:
    blocks = []
    for card_id in PATH_IDS:
        entry = copy["paths"][card_id]
        guide = entry["guide"]
        art = cutouts[card_id]
        walk = "\n".join(f"            <li>{text(step)}</li>" for step in guide["walkthrough"])
        crops = [shots[key] for key in (card_id, f"{card_id}-2") if key in shots][:2]
        gallery = ""
        if crops:
            frames = "\n".join(
                f'            <img class="shot" alt="" src="{prefix}{crop}" width="720" height="450" '
                'decoding="async" loading="lazy">'
                for crop in crops
            )
            gallery = f'          <div class="crops">\n{frames}\n          </div>\n'
        blocks.append(
            f'      <section id="{card_id}" class="chapter">\n'
            '        <div class="chapter-figure">\n'
            f'          <img alt="" src="{prefix}{art["512"]}" '
            f'srcset="{prefix}{art["256"]} 256w, {prefix}{art["512"]} 512w" '
            'sizes="160px" width="512" height="512" decoding="async" loading="lazy">\n'
            "        </div>\n"
            '        <div class="chapter-body">\n'
            f'          <h2>{text(guide["h2"])}</h2>\n'
            f'          <p class="lede">{text(guide["lede"])}</p>\n'
            '          <ol class="steps">\n'
            f"{walk}\n"
            "          </ol>\n"
            f"{gallery}"
            f'          <p><a class="button" href="{esc(entry["href"])}">{text(guide["open_label"])}</a></p>\n'
            "        </div>\n"
            "      </section>"
        )
    return "\n".join(blocks)


def data_files(copy: dict) -> str:
    rows = []
    for item in copy["guide"]["data"]["files"]:
        rows.append(
            f'          <dt><code>{text(item["path"])}</code></dt>\n'
            f'          <dd>{text(item["what"])}</dd>'
        )
    return "\n".join(rows)


def eras_table(rows: list[dict]) -> str:
    """No dashes in an empty cell: a table of counts full of em dashes reads as broken
    data rather than as work still to do, which is what an unphotographed era is.

    An era with no photographs gets the words even when eras.json lists a gallery for it
    -- era 11 has a published page and nothing on it, and sending someone to an empty
    grid is worse than telling them there is nothing there yet."""
    body = []
    for row in rows:
        if row["photos"] == 0:
            cell = '<span class="quiet-cell">not yet photographed</span>'
        elif row["href"]:
            cell = f'<a href="{esc(row["href"])}">Open the gallery</a>'
        else:
            cell = '<span class="quiet-cell">no gallery page yet</span>'
        mark = ' <span class="chip-now">current</span>' if row["current"] else ""
        body.append(
            "          <tr>\n"
            f'            <th scope="row">Era {row["era"]}{mark}</th>\n'
            f'            <td class="num">{thousands(row["albums"])}</td>\n'
            f'            <td class="num">{thousands(row["albumsWithPhotos"])}</td>\n'
            f'            <td class="num">{thousands(row["photos"])}</td>\n'
            f"            <td>{cell}</td>\n"
            "          </tr>"
        )
    return "\n".join(body)


# ----------------------------------------------------------------------------- build

def build(source_base: str, out_dir: Path, offline: Path | None = None,
          shots_dir: Path | None = None, portraits_dir: Path | None = None) -> dict:
    out_dir = Path(out_dir)
    if out_dir.exists():
        raise SystemExit(f"{out_dir} already exists. Use a new output directory.")

    copy = json.loads((HERE / "content" / "copy.json").read_text(encoding="utf-8"))
    directory, eras_doc, sources = read_sources(source_base, offline)
    counts = compute_counts(directory)
    rows = era_rows(directory, eras_doc)

    out_dir.mkdir(parents=True)
    out = Out(out_dir)
    try:
        cutouts = build_cutouts(out)
        portraits = build_portraits(out, portraits_dir)
        shots = build_shots(out, shots_dir)
        fonts = build_fonts(out)
        emblem = out.write_hashed(
            "img/emblem.{}.svg", (HERE / "assets" / "emblem.svg").read_bytes()
        )
        css = out.write_hashed(
            "chronicles.{}.css", (HERE / "src" / "chronicles.css").read_bytes()
        )
        js = out.write_hashed("gateway.{}.js", (HERE / "src" / "gateway.js").read_bytes())

        generated = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        head = head_sha()
        stamp_text = f"built {generated.strftime('%Y-%m-%dT%H:%MZ')} · {head[:7]}"
        generated_at = generated.isoformat().replace("+00:00", "Z")
        portrait_manifest = portraits_doc(portraits, cutouts, copy, head, generated_at)

        for page, prefix in (("index", ""), ("guide", "../")):
            header, footer = shell_parts({
                "emblem_header": inline_emblem("brand-mark", 28),
                "emblem_footer": inline_emblem("footer-mark", 20),
                "brand_current": ' aria-current="page"' if page == "index" else "",
                "guide_current": ' aria-current="page"' if page == "guide" else "",
                "footer_tagline": text(copy["footer"]["tagline"]),
                "footer_preserved": text(copy["footer"]["preserved"]),
                "world_viewer": WORLD_VIEWER,
                "build_stamp": text(stamp_text),
            })
            common = {
                "header": header,
                "footer": footer,
                "css_href": f"{prefix}{css}",
                "icon_href": f"{prefix}{emblem}",
            }
            if page == "index":
                body = render((HERE / "templates" / "index.html").read_text(encoding="utf-8"), {
                    **common,
                    "js_href": js,
                    "meta_description": esc(copy["gateway"]["lede"]),
                    "h1": text(copy["gateway"]["h1"]),
                    "search_label": text(copy["gateway"]["search_label"]),
                    "search_placeholder": esc(copy["gateway"]["search_placeholder"]),
                    "search_hint": text(copy["gateway"]["search_hint"]),
                    "claim_hint": text(copy["gateway"]["claim_hint"]),
                    "cta": text(copy["gateway"]["cta"]),
                    "loading": esc(copy["gateway"]["loading"]),
                    "load_failed": esc(copy["gateway"]["load_failed"]),
                    "no_match": esc(copy["gateway"]["no_match"]),
                    "portraits_json": inline_json(portrait_manifest),
                })
                out.write("index.html", body.encode("utf-8"))
            else:
                claims = "\n".join(
                    f"        <p>{text(paragraph)}</p>"
                    for paragraph in copy["guide"]["claims"]["paragraphs"]
                )
                body = render((HERE / "templates" / "guide.html").read_text(encoding="utf-8"), {
                    **common,
                    "meta_description": esc(copy["guide"]["lede"]),
                    "h1": text(copy["guide"]["h1"]),
                    "lede": text(copy["guide"]["lede"]),
                    "glance_h2": text(copy["guide"]["glance_h2"]),
                    "stat_builders": stat_slab("Builders", thousands(counts["builders"])),
                    "stat_photos": stat_slab("Photographs", thousands(counts["photos"])),
                    "stat_eras": stat_slab("Populated eras", thousands(counts["erasWithPhotos"])),
                    "era_chips": era_chips(rows, eras_doc),
                    "toc_label": text(copy["guide"]["toc_label"]),
                    "toc": guide_toc(copy),
                    "path_sections": guide_sections(copy, cutouts, shots, prefix),
                    "claims_h2": text(copy["guide"]["claims"]["h2"]),
                    "claims_paragraphs": claims,
                    "data_h2": text(copy["guide"]["data"]["h2"]),
                    "data_lede": text(copy["guide"]["data"]["lede"]),
                    "data_files": data_files(copy),
                    "world_viewer": WORLD_VIEWER,
                    "world_viewer_text": text(copy["guide"]["data"]["world_viewer"]),
                    "eras_h2": text(copy["guide"]["eras"]["h2"]),
                    "eras_lede": text(copy["guide"]["eras"]["lede"]),
                    "eras_table": eras_table(rows),
                })
                out.write("guide/index.html", body.encode("utf-8"))

        out.write("portraits.json",
                  (json.dumps(portrait_manifest, indent=2) + "\n").encode("utf-8"))

        manifest = {
            "generatedAt": generated_at,
            "sourceBase": source_base.rstrip("/"),
            "counts": counts,
            "_countsNote": (
                "By creators.js computeHeroStats: builders = len(builders); photos = "
                "photography.photos; erasWithPhotos = the union of every builder's own eras, "
                "which the live builders index labels \"Populated eras\" and which includes an "
                "era with builders but no photographs yet."
            ),
            "eras": rows,
            "sources": sources,
            "head": head,
            "assets": {
                "css": css, "js": js, "emblem": emblem,
                "cutouts": cutouts, "portraits": portraits, "shots": shots, "fonts": fonts,
            },
        }
        out.write("build.json", (json.dumps(manifest, indent=2) + "\n").encode("utf-8"))
        receipt = {"files": sorted(out.files, key=lambda f: f["path"])}
        (out_dir / "receipt.json").write_bytes(
            (json.dumps(receipt, indent=2) + "\n").encode("utf-8")
        )
    except BaseException:
        # A half-written tree passes "the directory exists" and fails everything after
        # it; leave nothing for the next run to refuse.
        shutil.rmtree(out_dir, ignore_errors=True)
        raise
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source-base", default="https://fx99.tail8e749c.ts.net",
                        help="origin serving /valheim/creators/directory.json and /valheim/eras.json")
    parser.add_argument("--out", type=Path, required=True, help="output directory; must not exist")
    parser.add_argument("--offline", type=Path, default=None,
                        help="read directory.json and eras.json from this fixture directory instead")
    parser.add_argument("--shots", type=Path, default=None,
                        help="directory of tutorial crops, named <path-id>[-2].<png|jpg|webp>")
    parser.add_argument("--portraits", type=Path, default=DEFAULT_PORTRAITS,
                        help="directory of drawn portrait tiles with a manifest.json; "
                             "a tree that is not there yet builds a page with no tiles")
    args = parser.parse_args(argv)

    manifest = build(args.source_base, args.out, args.offline, args.shots, args.portraits)
    counts = manifest["counts"]
    print(f"built {args.out}")
    print(f"  builders        {thousands(counts['builders'])}")
    print(f"  photographs     {thousands(counts['photos'])}")
    print(f"  populated eras  {thousands(counts['erasWithPhotos'])}")
    print(f"  portraits       {thousands(manifest['assets']['portraits']['count'])}")
    print(f"  head            {manifest['head'][:7]}")
    for source in manifest["sources"]:
        print(f"  source          {source['url']} ({thousands(source['bytes'])} bytes, {source['sha256'][:12]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
