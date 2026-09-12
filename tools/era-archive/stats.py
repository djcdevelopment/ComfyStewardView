#!/usr/bin/env python3
"""Archive statistics, computed from the community document at projection time.

The page under /valheim/creators/stats/ began as prose with the numbers typed in: a
one-off DuckDB census over the 2026-09-08 community tables, pasted into HTML. Nothing
regenerated it, so it could not say when it was true, four of its cells were never
computed by any query, and the population it described was not the one the directory
beside it publishes. This module recomputes every figure from the same document
gallery.py projects, and gallery.py renders web/stats.html from the result -- so the
page carries its own date and cannot drift from the directory.

Bins and rules are the census's own (recovered from its scratch queries). Percentiles
are R type 7 -- the linear interpolation numpy and pandas use -- so the figures reproduce
the original page cell for cell wherever that page was right. Legacy gallery albums
(eras 16-17, one credit each with no piece count) are counted as clusters and credits
but sit outside every piece and share calculation; the page says so.
"""
import argparse
import html
import json
import math
import re
from collections import defaultdict
from pathlib import Path

# Tugcow: the thread the census used as its worked example. The column header reads the
# builder's display name from the document; the key is only how the row is found.
EXEMPLAR_BUILDER_KEY = "5897d38e2a065e36a6895e70a2194738"
TOKEN = re.compile(r"\{\{([a-z0-9_]+)\}\}")

# Build size, as the census bucketed it: exactly one piece, then <= each edge, then the rest.
BUILD_SIZE_EDGES = (5, 20, 50, 100, 500, 2000)
BUILD_SIZE_LABELS = ("1 piece", "2–5 pieces", "6–20 pieces", "21–50 pieces", "51–100 pieces",
                     "101–500 pieces", "501–2,000 pieces", "&gt;2,000 pieces")
# Contributor share of a build: < each edge, then a full share.
SHARE_EDGES = (0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 1.00)
# Pieces the contributor placed: one, then <= each edge, then the rest.
CONTRIB_EDGES = (5, 20, 50, 100, 500)
# Shared builds: no one-piece bin (two contributors need two pieces), <= each edge, then the rest.
SHARED_EDGES = (5, 20, 50, 100, 500, 2000)
SHARED_LABELS = ("2–5 pieces", "6–20 pieces", "21–50 pieces", "51–100 pieces",
                 "101–500 pieces", "501–2,000 pieces", "&gt;2,000 pieces")

TABLE_3_PERCENTILES = (0.10, 0.25, 0.50, 0.75, 0.90, 0.95)
TABLE_4_PERCENTILES = (0.10, 0.25, 0.50, 0.75, 0.90)
TOP_N = (1, 3, 5, 10, 20)
ACTIVE_BUILDER_PIECES = 500

TOKENS = (
    "albums_with_beds", "albums_with_photos", "beds", "builders", "builders_with_bed", "builders_with_photos",
    "clusters", "directory_albums", "era_count", "era_list", "era_runs", "exemplar_name", "generated_date",
    "legacy_era_runs", "legacy_rows", "measured_rows", "n_active", "n_with_pieces", "photos", "pieces_millions",
    "pieces_total", "r3_builders_pct", "r3_noise_cut", "r3_pieces_cut", "r3_pieces_kept", "rows", "rule_label",
    "schema", "shared_builds", "shipped_builders", "shipped_builds", "shipped_records", "t1_solo_1piece",
    "t1_tourism", "t4_top1_p50", "t4_top10_p50", "t4_top3_p50", "t5_top_coop", "t5_top_dominated",
    "table_1_body", "table_1_foot", "table_2_body", "table_2_foot", "table_3_body", "table_4_body",
    "table_5_body", "table_6_body", "table_7_body", "table_7_foot",
)


# ---------------------------------------------------------------- arithmetic

def percentile(sorted_values, p):
    """R type 7 -- numpy's default and what pandas .describe() reports."""
    if not sorted_values:
        raise ValueError("percentile of an empty population")
    n = len(sorted_values)
    h = (n - 1) * p
    lo = math.floor(h)
    hi = min(lo + 1, n - 1)
    return sorted_values[lo] + (h - lo) * (sorted_values[hi] - sorted_values[lo])


def describe(values, percentiles):
    """min / max / mean plus the requested percentiles; every cell None when there is nothing to describe."""
    keys = ["n", "min", "max", "mean"] + [f"p{int(round(p * 100))}" for p in percentiles]
    if not values:
        return {k: (0 if k == "n" else None) for k in keys}
    s = sorted(values)
    out = {"n": len(s), "min": s[0], "max": s[-1], "mean": sum(s) / len(s)}
    for p in percentiles:
        out[f"p{int(round(p * 100))}"] = percentile(s, p)
    return out


def round1(v):
    """numpy's round(x, 1): half-even on the scaled value, which is what the census tables show."""
    return None if v is None else round(v * 10) / 10


def round1_half_up(v):
    """SQL ROUND(x, 1), used per builder before the percentile so the census reproduces."""
    return math.floor(v * 10 + 0.5) / 10


def bin_index(value, edges):
    for i, edge in enumerate(edges):
        if value <= edge:
            return i
    return len(edges)


def build_size_bin(pieces):
    return 0 if pieces == 1 else 1 + bin_index(pieces, BUILD_SIZE_EDGES)


def share_bin(share):
    for i, edge in enumerate(SHARE_EDGES):
        if share < edge:
            return i
    return len(SHARE_EDGES)


def contrib_bin(pieces):
    return 0 if pieces == 1 else 1 + bin_index(pieces, CONTRIB_EDGES)


# ---------------------------------------------------------------- formatting

def fmt_int(v):
    return "—" if v is None else f"{int(round(v)):,}"


def fmt_1dp(v):
    return "—" if v is None else f"{v:,.1f}"


def fmt_pct(v):
    return "—" if v is None else f"{v:,.1f}%"


def fmt_x(v):
    return "—" if v is None else f"{v:,.1f}x"


def era_list(eras):
    eras = [str(e) for e in eras]
    if len(eras) <= 1:
        return "".join(eras)
    if len(eras) == 2:
        return f"{eras[0]} and {eras[1]}"
    return ", ".join(eras[:-1]) + f", and {eras[-1]}"


def era_runs(eras):
    """`eras 7–12, 14`: consecutive numbers collapse to a range."""
    eras = sorted(set(int(e) for e in eras))
    if not eras:
        return "no eras"
    runs, start, prev = [], eras[0], eras[0]
    for e in eras[1:] + [None]:
        if e is not None and e == prev + 1:
            prev = e
            continue
        runs.append(f"{start}–{prev}" if prev > start else f"{start}")
        if e is not None:
            start = prev = e
    return ("era " if len(eras) == 1 else "eras ") + ", ".join(runs)


def cells(values, strong=()):
    """One <tr> in the census tables' own layout: a text-left label, then the cells."""
    label, rest = values[0], values[1:]
    out = [f'                <td class="text-left"><strong>{label}</strong></td>']
    for i, v in enumerate(rest):
        bold = strong == "all" or i in strong
        out.append(f"                <td><strong>{v}</strong></td>" if bold else f"                <td>{v}</td>")
    return "              <tr>\n" + "\n".join(out) + "\n              </tr>"


# ---------------------------------------------------------------- census

def compute(document, qualifies, thresholds=(20, 10, 0.05), exemplar_builder_key=EXEMPLAR_BUILDER_KEY):
    """Every figure on the page, unformatted. Reads the document; never writes to it."""
    builds = document.get("builds", [])
    builders = document.get("builders", [])
    eras = sorted({(e["era"] if isinstance(e, dict) else int(e)) for e in document.get("eras", [])})

    # The row relation: one row per credit. A row is measured when it carries both a piece
    # count and a share; a legacy gallery credit carries neither.
    rows = []
    for b in builds:
        for c in b.get("contributors", []) or []:
            q, s = c.get("pieces"), c.get("share")
            rows.append((c.get("builderKey"), q, s, b.get("pieces", 0) or 0, b["buildKey"], b.get("era")))
    measured = [r for r in rows if r[1] is not None and r[2] is not None]
    legacy = [r for r in rows if r[1] is None or r[2] is None]
    pieces_total = sum(r[1] for r in measured)
    builder_keys = {r[0] for r in rows}

    # Tables 1 and 2: cross-tabs over measured rows.
    table_1 = [[0] * (len(SHARE_EDGES) + 1) for _ in BUILD_SIZE_LABELS]
    table_2 = [[0] * (len(CONTRIB_EDGES) + 2) for _ in BUILD_SIZE_LABELS]
    for _, q, s, total, _, _ in measured:
        row = build_size_bin(total)
        table_1[row][share_bin(s)] += 1
        table_2[row][contrib_bin(q)] += 1
    tourism = sum(table_1[r][c] for r in (5, 6, 7) for c in (0, 1))

    # Table 3: the builder's portfolio. Albums count every credit, legacy included; pieces
    # only the measured ones, and a builder with no measured credit has no piece count at all.
    per_builder = defaultdict(lambda: {"albums": 0, "pieces": [], "ge50": 0, "le5": 0})
    for key, q, s, _, _, _ in rows:
        p = per_builder[key]
        p["albums"] += 1
        if q is not None and s is not None:
            p["pieces"].append(q)
            p["ge50"] += q >= 50
            p["le5"] += q <= 5
    portfolios = []
    for key, p in per_builder.items():
        pieces = sum(p["pieces"]) if p["pieces"] else None
        portfolios.append({"key": key, "albums": p["albums"], "pieces": pieces, "ge50": p["ge50"], "le5": p["le5"],
                           "pct_le5": round1_half_up(100 * p["le5"] / p["albums"]),
                           "sorted": sorted(p["pieces"], reverse=True)})
    with_pieces = [p for p in portfolios if p["pieces"] is not None]
    active = [p for p in with_pieces if p["pieces"] >= ACTIVE_BUILDER_PIECES]
    table_3 = {
        "albums": describe([p["albums"] for p in portfolios], TABLE_3_PERCENTILES),
        "pieces": describe([p["pieces"] for p in with_pieces], TABLE_3_PERCENTILES),
        "ge50": describe([p["ge50"] for p in portfolios], TABLE_3_PERCENTILES),
        "le5": describe([p["le5"] for p in portfolios], TABLE_3_PERCENTILES),
        "pct_le5": describe([p["pct_le5"] for p in portfolios], TABLE_3_PERCENTILES),
        "inflation": describe([p["albums"] / max(p["ge50"], 1) for p in active], TABLE_3_PERCENTILES),
        "n": len(portfolios), "n_with_pieces": len(with_pieces), "n_active": len(active),
    }

    # Table 4: how much of an active builder's lifetime sits in their biggest builds.
    table_4 = {}
    for n in TOP_N:
        table_4[n] = describe([100 * sum(p["sorted"][:n]) / p["pieces"] for p in active], TABLE_4_PERCENTILES)

    # Table 5: builds with two or more credits, by size, and who led them.
    shared = []
    for b in builds:
        contributors = b.get("contributors", []) or []
        if len(contributors) < 2:
            continue
        lead = max((c.get("share") for c in contributors if c.get("share") is not None), default=None)
        shared.append((bin_index(b.get("pieces", 0) or 0, SHARED_EDGES), len(contributors), lead))
    table_5 = []
    for i, label in enumerate(SHARED_LABELS):
        group = [g for g in shared if g[0] == i]
        leads = [g[2] for g in group if g[2] is not None]
        n = len(group)
        table_5.append({
            "label": label, "builds": n,
            "avg_builders": (sum(g[1] for g in group) / n) if n else None,
            "max_builders": max((g[1] for g in group), default=None),
            "avg_lead": round1(100 * sum(leads) / len(leads)) if leads else None,
            "dominated": round1(100 * sum(1 for l in leads if l >= 0.80) / n) if n else None,
            "moderate": round1(100 * sum(1 for l in leads if 0.50 <= l < 0.80) / n) if n else None,
            "coop": round1(100 * sum(1 for l in leads if l < 0.50) / n) if n else None,
        })

    # Table 6: the census's candidate rules, then the rule the directory actually ships.
    def rule(label, keep):
        kept = [r for r in rows if keep(r[1] or 0, r[2] or 0.0, r[3])]
        return {"label": label, "records": len(kept), "pieces": sum(r[1] or 0 for r in kept),
                "builders": len({r[0] for r in kept}),
                "exemplar": sum(1 for r in kept if r[0] == exemplar_builder_key)}
    table_6 = [
        rule("Current baseline (All &ge; 1 piece)", lambda q, s, t: True),
        rule("Placed &ge; 5 pieces", lambda q, s, t: q >= 5),
        rule("Placed &ge; 10 pieces", lambda q, s, t: q >= 10),
        rule("Placed &ge; 20 pieces", lambda q, s, t: q >= 20),
        rule("Placed &ge; 50 pieces", lambda q, s, t: q >= 50),
        rule("Substantial: (Placed &ge; 10 and Share &ge; 5%) or Placed &ge; 50",
             lambda q, s, t: (q >= 10 and s >= 0.05) or q >= 50),
        rule("Structure: Build &ge; 20 total and (Share &ge; 10% or Placed &ge; 50)",
             lambda q, s, t: t >= 20 and (s >= 0.10 or q >= 50)),
    ]

    # The shipped rule, walked exactly the way project() walks it: builder by builder, each
    # of their builds, the credit found or synthesised, then the predicate.
    by_key = {b["buildKey"]: b for b in builds}
    shipped = {"label": "As shipped in the directory (Recommended)", "records": 0, "pieces": 0, "exemplar": 0}
    shipped_builders, shipped_builds, builders_with_photos = set(), set(), set()
    for builder in builders:
        key = builder.get("builderKey")
        for build_key in builder.get("builds", []) or []:
            b = by_key[build_key]
            c = next((c for c in b.get("contributors", []) or [] if c.get("builderKey") == key), None)
            if c is None:
                c = {"pieces": b.get("pieces", 0), "share": 1.0}
            if not qualifies(b, c):
                continue
            shipped["records"] += 1
            shipped["pieces"] += c.get("pieces") or 0
            shipped["exemplar"] += key == exemplar_builder_key
            shipped_builders.add(key)
            shipped_builds.add(build_key)
            if b.get("photos"):
                builders_with_photos.add(key)
    shipped["builders"] = len(shipped_builders)
    shipped["albums"] = len(shipped_builds)
    table_6.append(shipped)

    # Table 7: what the directory's albums carry beyond a credit.
    era_albums, era_shot, era_photos = defaultdict(int), defaultdict(int), defaultdict(int)
    for build_key in shipped_builds:
        b = by_key[build_key]
        era_albums[b["era"]] += 1
        if b.get("photos"):
            era_shot[b["era"]] += 1
            era_photos[b["era"]] += len(b["photos"])
    residents = [(b["buildKey"], r) for b in builds for r in (b.get("residents") or [])]
    table_7 = {
        "eras": [{"era": e, "albums": era_albums[e], "photographed": era_shot[e], "photos": era_photos[e]}
                 for e in sorted(era_albums)],
        "albums": len(shipped_builds), "photographed": sum(era_shot.values()), "photos": sum(era_photos.values()),
        "builders_with_photos": len(builders_with_photos),
        "builders_with_bed": len({r["builderKey"] for _, r in residents}),
        "beds": sum(r.get("beds", 0) or 0 for _, r in residents),
        "albums_with_beds": len({k for k, _ in residents}),
    }

    exemplar = next((b.get("displayName") for b in builders if b.get("builderKey") == exemplar_builder_key), None)
    generated = str(document.get("generatedAt", ""))
    return {
        "schema": document.get("schema", "steward-community/v1"),
        "generated_date": generated[:10] if re.match(r"\d{4}-\d{2}-\d{2}", generated) else generated,
        "eras": eras, "legacy_eras": sorted({r[5] for r in legacy if r[5] is not None}),
        "thresholds": tuple(thresholds),
        "pieces_total": pieces_total, "clusters": len(builds), "builders": len(builder_keys),
        "rows": len(rows), "measured_rows": len(measured), "legacy_rows": len(legacy),
        "table_1": table_1, "tourism": tourism, "table_2": table_2, "table_3": table_3, "table_4": table_4,
        "table_5": table_5, "shared_builds": len(shared), "table_6": table_6, "table_7": table_7,
        "exemplar_name": exemplar,
    }


# ---------------------------------------------------------------- rendering

def tokens(figures):
    f = figures
    t = {}
    t["schema"] = html.escape(str(f["schema"]))
    t["generated_date"] = html.escape(str(f["generated_date"]))
    t["era_count"] = str(len(f["eras"]))
    t["era_list"] = era_list(f["eras"])
    t["era_runs"] = era_runs(f["eras"])
    t["legacy_era_runs"] = era_runs(f["legacy_eras"]) if f["legacy_eras"] else "no eras"
    t["pieces_total"] = fmt_int(f["pieces_total"])
    t["pieces_millions"] = f"{f['pieces_total'] / 1e6:.1f}"
    t["clusters"] = fmt_int(f["clusters"])
    t["builders"] = fmt_int(f["builders"])
    t["rows"] = fmt_int(f["rows"])
    t["measured_rows"] = fmt_int(f["measured_rows"])
    t["legacy_rows"] = fmt_int(f["legacy_rows"])
    mb, mp, _ = f["thresholds"]
    t["rule_label"] = (f"photographed albums always; otherwise a build of at least {mb} pieces where the builder placed "
                       f"at least {mp} pieces, or at least 5 pieces with a 25% share, or holds a 50% share")

    # Table 1: the solo and total columns in bold.
    body, col_totals = [], [0] * (len(SHARE_EDGES) + 1)
    for label, counts in zip(BUILD_SIZE_LABELS, f["table_1"]):
        for i, v in enumerate(counts):
            col_totals[i] += v
        body.append(cells([label] + [fmt_int(v) for v in counts] + [fmt_int(sum(counts))],
                          strong=(len(counts) - 1, len(counts))))
    t["table_1_body"] = "\n".join(body)
    t["table_1_foot"] = cells(["Total Contributions"] + [fmt_int(v) for v in col_totals] + [fmt_int(sum(col_totals))],
                              strong="all")
    t["t1_solo_1piece"] = fmt_int(f["table_1"][0][-1])
    t["t1_tourism"] = fmt_int(f["tourism"])

    # Table 2: the total column in bold.
    body, col_totals = [], [0] * (len(CONTRIB_EDGES) + 2)
    for label, counts in zip(BUILD_SIZE_LABELS, f["table_2"]):
        for i, v in enumerate(counts):
            col_totals[i] += v
        body.append(cells([label] + [fmt_int(v) for v in counts] + [fmt_int(sum(counts))], strong=(len(counts),)))
    t["table_2_body"] = "\n".join(body)
    t["table_2_foot"] = cells(["Total Contributions"] + [fmt_int(v) for v in col_totals] + [fmt_int(sum(col_totals))],
                              strong="all")

    # Table 3: min, p10, p25, p50, p75, p90, p95, max, mean -- the median in bold.
    t3 = f["table_3"]

    def t3_row(label, d, fmt, mean_fmt):
        keys = ("min", "p10", "p25", "p50", "p75", "p90", "p95", "max")
        return cells([label] + [fmt(d[k]) for k in keys] + [mean_fmt(d["mean"])], strong=(3,))
    t["table_3_body"] = "\n".join([
        t3_row("Credited Albums (all recorded pieces)", t3["albums"], fmt_int, fmt_1dp),
        t3_row("Lifetime Construction Pieces", t3["pieces"], fmt_int, fmt_1dp),
        t3_row("Real Builds (&ge;50 pieces placed)", t3["ge50"], fmt_int, fmt_1dp),
        t3_row("Wilderness &amp; Trail Drops (&le;5 pieces)", t3["le5"], fmt_int, fmt_1dp),
        t3_row("% of Portfolio that is Trail Drops (&le;5 pieces)", t3["pct_le5"], fmt_pct, fmt_pct),
        t3_row("Album Inflation Factor (Albums / Real Builds, active builders)", t3["inflation"], fmt_x, fmt_x),
    ])
    t["n_with_pieces"] = fmt_int(t3["n_with_pieces"])
    t["n_active"] = fmt_int(t3["n_active"])

    # Table 4: p10, p25, p50, p75, p90, mean -- the median in bold.
    t4 = f["table_4"]
    t["table_4_body"] = "\n".join(
        cells([f"Pieces in Top {n} Build{'s' if n > 1 else ''}"]
              + [fmt_pct(t4[n][k]) for k in ("p10", "p25", "p50", "p75", "p90", "mean")], strong=(2,))
        for n in TOP_N)
    t["t4_top1_p50"] = fmt_pct(t4[1]["p50"])
    t["t4_top3_p50"] = fmt_pct(t4[3]["p50"])
    t["t4_top10_p50"] = fmt_pct(t4[10]["p50"])

    # Table 5: the co-op column in bold.
    t["table_5_body"] = "\n".join(
        cells([r["label"], fmt_int(r["builds"]), fmt_1dp(r["avg_builders"]), fmt_int(r["max_builders"]),
               fmt_pct(r["avg_lead"]), fmt_pct(r["dominated"]), fmt_pct(r["moderate"]), fmt_pct(r["coop"])],
              strong=(6,))
        for r in f["table_5"])
    t["shared_builds"] = fmt_int(f["shared_builds"])
    biggest = f["table_5"][-1]
    t["t5_top_dominated"] = fmt_pct(biggest["dominated"])
    t["t5_top_coop"] = fmt_pct(biggest["coop"])

    # Table 6: pieces kept and the exemplar's albums in bold.
    base = f["table_6"][0]

    def share_of(part, whole):
        return 100 * part / whole if whole else None

    def t6_row(r):
        noise = round1(100 - share_of(r["records"], base["records"])) if base["records"] else None
        return cells([r["label"], fmt_int(r["records"]), fmt_pct(noise), fmt_pct(share_of(r["pieces"], base["pieces"])),
                      f"{fmt_int(r['builders'])} ({fmt_pct(share_of(r['builders'], base['builders']))})",
                      fmt_int(r["exemplar"])], strong=(2, 4))
    t["table_6_body"] = "\n".join(t6_row(r) for r in f["table_6"])
    r3 = f["table_6"][3]
    t["r3_noise_cut"] = fmt_pct(round1(100 - share_of(r3["records"], base["records"])) if base["records"] else None)
    t["r3_pieces_kept"] = fmt_pct(share_of(r3["pieces"], base["pieces"]))
    t["r3_pieces_cut"] = fmt_pct(100 - share_of(r3["pieces"], base["pieces"]) if base["pieces"] else None)
    t["r3_builders_pct"] = fmt_pct(share_of(r3["builders"], base["builders"]))
    shipped = f["table_6"][-1]
    t["shipped_records"] = fmt_int(shipped["records"])
    t["shipped_builds"] = fmt_int(shipped["albums"])
    t["shipped_builders"] = fmt_int(shipped["builders"])
    t["exemplar_name"] = html.escape(f["exemplar_name"]) if f["exemplar_name"] else "—"

    # Table 7: the photographed share in bold.
    t7 = f["table_7"]
    t["table_7_body"] = "\n".join(
        cells([f"Era {e['era']}", fmt_int(e["albums"]), fmt_int(e["photographed"]),
               fmt_pct(share_of(e["photographed"], e["albums"])), fmt_int(e["photos"])], strong=(2,))
        for e in t7["eras"])
    t["table_7_foot"] = cells(["All eras", fmt_int(t7["albums"]), fmt_int(t7["photographed"]),
                               fmt_pct(share_of(t7["photographed"], t7["albums"])), fmt_int(t7["photos"])], strong="all")
    t["directory_albums"] = fmt_int(t7["albums"])
    t["photos"] = fmt_int(t7["photos"])
    t["albums_with_photos"] = fmt_int(t7["photographed"])
    t["builders_with_photos"] = fmt_int(t7["builders_with_photos"])
    t["builders_with_bed"] = fmt_int(t7["builders_with_bed"])
    t["beds"] = fmt_int(t7["beds"])
    t["albums_with_beds"] = fmt_int(t7["albums_with_beds"])

    missing = set(TOKENS) - set(t)
    extra = set(t) - set(TOKENS)
    if missing or extra:
        raise RuntimeError(f"token set drifted: missing {sorted(missing)}, extra {sorted(extra)}")
    return t


def render(figures, template_text):
    """Fill every {{token}} in the template; an unknown token is an error, not a blank."""
    values = tokens(figures)

    def fill(match):
        name = match.group(1)
        if name not in values:
            raise KeyError(f"stats.html asks for {{{{{name}}}}}, which stats.py does not produce")
        return values[name]
    page = TOKEN.sub(fill, template_text)
    if "{{" in page:
        raise RuntimeError("a token survived rendering")
    return page


def main():
    parser = argparse.ArgumentParser(description="Render the statistics page from a community document, for review.")
    parser.add_argument("--output-root", type=Path, required=True,
                        help="the archive root holding analysis/community-private.json")
    parser.add_argument("--out", type=Path, required=True, help="where to write the rendered page")
    parser.add_argument("--json", type=Path, default=None, help="also write the unformatted figures")
    parser.add_argument("--min-build-pieces", type=int, default=20)
    parser.add_argument("--min-builder-pieces", type=int, default=10)
    parser.add_argument("--min-builder-share", type=float, default=0.05)
    args = parser.parse_args()
    from archive import REPO, load
    from gallery import is_qualifying_album
    document = load(args.output_root / "analysis/community-private.json")
    thresholds = (args.min_build_pieces, args.min_builder_pieces, args.min_builder_share)
    figures = compute(document, lambda b, c: is_qualifying_album(b, c, *thresholds), thresholds=thresholds)
    template = (REPO / "tools/era-archive/web/stats.html").read_text(encoding="utf-8")
    args.out.write_text(render(figures, template), encoding="utf-8")
    if args.json:
        args.json.write_text(json.dumps(figures, indent=2, default=str), encoding="utf-8")
    shipped = figures["table_6"][-1]
    print(f"rendered {args.out}: {figures['clusters']:,} clusters, {figures['rows']:,} credits, "
          f"{figures['builders']:,} builders; directory {shipped['albums']:,} albums / {shipped['builders']:,} builders")


if __name__ == "__main__":
    main()
