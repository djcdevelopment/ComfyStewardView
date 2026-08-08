# Architecture diagrams

Hand-authored SVG — no toolchain, no export step. Edit the file directly; the text
is the source. Each carries `role="img"` and an `aria-label` stating its claim, and
each is self-contained (a painted background, no external fonts or images), so it
renders the same in a browser, an IDE preview, or embedded in Markdown.

## Current set

| File | Answers |
|---|---|
| [10-system-overview.svg](10-system-overview.svg) | Which host does what, and how artifacts get from OMEN to AM4 |
| [11-data-flow.svg](11-data-flow.svg) | How a save file becomes an API response, and where prefab names are resolved |
| [12-contracts.svg](12-contracts.svg) | What crosses every boundary — file formats, DuckDB schema, REST surface, ingest contract |
| [13-tech-stack.svg](13-tech-stack.svg) | Every runtime dependency with its pinned version, and the constraints behind two of them |
| [14-tooling-and-lanes.svg](14-tooling-and-lanes.svg) | The code lane vs the data lane, their gates, and why order matters |

Read `10` for orientation, `11` for the mechanism most of the system depends on.

## Where they are used

[WHITEPAPER.html](../WHITEPAPER.html) embeds all five. It holds `{{FIG_*}}` placeholders
rather than copies, so these files stay the single source of truth — edit a diagram and
re-run the build, and the paper follows:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\Build-Whitepaper.ps1
```

That writes `viewer/src/main/resources/static/whitepaper.html`, which ships inside the jar
and is served at [/steward/whitepaper.html](https://am4.tail8e749c.ts.net/steward/whitepaper.html)
next to the application it documents. Each SVG is inlined as a base64 data URI — rather than
inline `<svg>` — because these diagrams carry internal `<style>` blocks with generic class
names, and SVG styles are not scoped: five inlined side by side would collide with each other
and with the page.

The build also wraps the page in a doctype, `<meta charset="utf-8">` and a viewport. The
source omits those because the artifact publisher supplies its own; served directly they are
what keep the browser out of quirks mode and stop a UTF-8 file being decoded as windows-1252.

## Superseded

`01-architecture.svg` through `05-extension-map.svg` predate the prefab dictionary,
the snapshot ingest and delta engine, and the OMEN/AM4 processing split. They are
kept as a record of the earlier design and should not be trusted as current — in
particular they show prefab names resolved from a hardcoded table, which is no
longer how it works.

## Keeping them honest

These carry measured numbers (parse rate, coverage percentage, artifact sizes,
deploy timings). When a number changes, change it here too — a diagram with a stale
figure is worse than one with none, because the figure looks authoritative. The
numbers currently shown were measured on ComfyEra16 at 9,155,594 ZDOs; the
provenance for each is in [PREFAB_DICTIONARY.md](../PREFAB_DICTIONARY.md) and
[ISLET_INTEGRATION_SPEC.md](../ISLET_INTEGRATION_SPEC.md).
