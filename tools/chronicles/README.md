# Valheim Chronicles

The static front door of the Comfy Community's Valheim archive: a gateway at
`/chronicles/` and a field manual at `/chronicles/guide/`.

Everything a visitor reads is decided at build time. The two pages make no network
request of their own -- no fonts, no CDN, no analytics, no runtime fetch of the archive's
JSON. The only absolute URLs on either page are the world viewer link and the SVG
namespace.

## Build

```
python tools/chronicles/build.py --source-base https://fx99.tail8e749c.ts.net --out DIR
```

| flag | |
| --- | --- |
| `--source-base` | origin serving `/valheim/creators/directory.json` and `/valheim/eras.json` |
| `--out` | output directory. **Must not exist** -- same immutable-projection rule as `tools/era-archive/gallery.py` |
| `--offline DIR` | read both JSON files from `DIR` instead of fetching. Used by the tests |
| `--shots DIR` | tutorial crops, named `<path-id>[-2].<png\|jpg\|webp>`; optional |

Requires Python 3 and Pillow, nothing else.

A fetch that fails **stops the build**. Baking one fresh count beside one stale count
would produce a page that looks completely healthy and is quietly wrong, so a source that
cannot be read is an error rather than a fallback. `--offline` is the explicit way to
build without the network. A build that fails part way removes its own output directory
so the next run is not refused by a half-written tree.

### Sources and counts

Two files are read: `/valheim/creators/directory.json` and `/valheim/eras.json`. Both are
recorded in `build.json` with their URL, byte count and sha256.

The three hero numbers must match the live builders index. They follow `computeHeroStats`
in `tools/era-archive/web/creators.js` exactly:

* **Builders** -- `len(directory["builders"])`, with no filter at all. Placeholder
  `Builder 8014fa60` threads and builders with no photographs are all counted.
* **Photographs** -- `photography.photos`, *not* the sum of each builder's own `photos`
  field. A shared album's photographs would otherwise be counted once per credited
  contributor.
* **Populated eras** -- the size of the union of every builder's own `eras` list. The
  top-level `eras[]` covers only terrain-analysed eras and omits the photo-only legacy
  eras 16 and 17, so it cannot be used. This is the number the live page labels
  "Populated eras", and it counts an era that has builders but no photographs yet, which
  is why `build.json` carries a `_countsNote` beside it.

`tests/test_build.py` reimplements that rule from the JavaScript source and asserts
parity against `tests/fixtures/directory.json` (the live file trimmed to 40 builders
spanning every era and tier, with `photography`, `eras`, `unattributedAlbums` and
`legacyImports` kept as the live aggregates). No count is ever written into a template.

### Output

```
index.html                      guide/index.html
chronicles.<hash>.css           gateway.<hash>.js
img/cutouts/<id>.<hash>.webp    512 square, alpha kept
img/cutouts/<id>.256.<hash>.webp
img/cutouts/guide.<hash>.svg    the drawn sixth figure
img/emblem.<hash>.svg
img/fonts/<name>.woff2          stable names, no hash
img/shots/<name>.<hash>.webp    720x450, only if --shots supplied
build.json                      counts, era rows, source hashes, HEAD, asset map
receipt.json                    every built file with its size and sha256
```

Caddy serves `/chronicles/img/**` with a 7-day immutable cache header, so every asset
carries a content hash in its name -- except the fonts, which keep stable names because
the other archive pages reference them by the exact paths written into
`assets/fonts/fonts.css`.

The tutorial crops are optional and normally absent. The manual and the guide render
complete pages without them; when a crop appears in `--shots` the matching card picks it
up on the next build.

### Sources of the page itself

| | |
| --- | --- |
| `content/copy.json` | every visible string, used verbatim |
| `templates/shell.html` | the header and footer both pages share |
| `templates/index.html`, `templates/guide.html` | page skeletons with `{{tokens}}` |
| `src/chronicles.css` | the whole stylesheet, hand-written, starting with the `@font-face` block |
| `src/gateway.js` | the gateway's only script: it stops an empty search submitting |
| `assets/` | cutouts, emblem, fonts |

### Tests

```
python -m unittest discover -s tools/chronicles/tests -v
```

Offline, fixture-driven, and green with the archive host unreachable. Besides the counts
parity they hold the lines the design depends on: neither page may contain the words this
archive does not use about people; every `<a href>` is on an allowlist; every `src`,
`srcset`, `<link href>` and CSS `url()` resolves to a file in the output; `receipt.json`
lists every built file; the six gateway cards carry no visible text, no `title` attribute
and an `aria-label` each; and an era with no photographs says so in words rather than
with a dash.
