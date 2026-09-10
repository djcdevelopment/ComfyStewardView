# Valheim Chronicles

The public front of the archive: what people built, who built it, and how to ask for a
photograph of your own. It ships as static files behind Caddy on FX99 and is served at
`https://fx99.tail8e749c.ts.net/chronicles/`.

The static front door of the Comfy Community's Valheim archive: a gateway at
`/chronicles/` and a field manual at `/chronicles/guide/`.

Everything a visitor reads is decided at build time, and nothing third-party is ever
fetched -- no fonts, no CDN, no analytics. The only absolute URLs on either page are the
world viewer link and the SVG namespace.

The one request either page makes of its own is on the gateway: `gateway.js` prefetches
this archive's `/valheim/creators/directory.json` so the name box can answer a typed name
without a page load. That is a same-origin file the builders index already reads, it is
requested on idle rather than on load, and if it never arrives the box is still a plain GET
form pointing at the builders index. The portrait manifest the suggestions draw from is not
fetched at all -- it is inlined into the page at build time.

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
| `--portraits DIR` | drawn portrait tiles with a `manifest.json`; defaults to `assets/portraits`, and a tree that is not there yet builds a page with no tiles |

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
img/cutouts/<id>.webp           stable name, same bytes as the hashed copy
img/cutouts/<id>.256.webp
img/cutouts/guide.<hash>.svg    the drawn sixth figure
img/portraits/pNN.webp          the drawn tiles, copied unchanged from --portraits
img/portraits/pNN.128.webp      derived thumbnail, the size the suggestions draw
img/emblem.<hash>.svg
img/fonts/<name>.woff2          stable names, no hash
img/shots/<name>.<hash>.webp    720x450, only if --shots supplied
build.json                      counts, era rows, source hashes, HEAD, asset map
portraits.json                  tiles, cutouts and path lines with their cache busters
receipt.json                    every built file with its size and sha256
```

Caddy serves `/chronicles/img/**` with a 7-day immutable cache header, so every asset
carries a content hash in its name -- except the fonts, which keep stable names because
the other archive pages reference them by the exact paths written into
`assets/fonts/fonts.css`, and except the portraits and the stable cutout copies, which
carry a `v` in `portraits.json` instead. A consumer appends `?v=<stamp>` to those, which
busts the same cache without needing to have read this build's manifest to name the file
in the first place. `portraits.json` sits at the output root beside `build.json`, and the
same object is inlined into the gateway page so the search suggestions can draw a portrait
without a second request.

The tutorial crops are optional and normally absent, and so are the portrait tiles: both
arrive from another lane. The guide renders complete walkthroughs without a crop, and the
gateway draws the archive emblem in place of a tile whenever `portraits.json` says
`count: 0`. When either appears the next build picks it up.

### Sources of the page itself

| | |
| --- | --- |
| `content/copy.json` | every visible string, used verbatim |
| `templates/shell.html` | the header and footer both pages share |
| `templates/index.html`, `templates/guide.html` | page skeletons with `{{tokens}}` |
| `src/chronicles.css` | the whole stylesheet, hand-written, starting with the `@font-face` block |
| `src/gateway.js` | the gateway's only script: the name box, its suggestions, and the empty-submit guard |
| `assets/` | cutouts, emblem, fonts, and the portrait tiles once that lane lands them |

### Tests

```
python -m unittest discover -s tools/chronicles/tests -v
```

Offline, fixture-driven, and green with the archive host unreachable -- the portrait tiles
are synthesized the way the tutorial crops are, so the suite says the same thing before and
after the portrait lane lands its first file. Besides the counts parity they hold the lines
the design depends on: neither page, nor the shipped script, nor `portraits.json` may
contain the words this archive does not use about people; every `<a href>` is on an
allowlist; every `src`, `srcset`, `<link href>` and CSS `url()` resolves to a file in the
output; `receipt.json` lists every built file; the front page is a line, a combobox and one
forged button with nothing else on it; every tile named in the inlined manifest is on disk
under the `v` it claims; and an era with no photographs says so in words rather than with a
dash.

Two suites run beside them:

* `tests/test_matcher_parity.py` lifts each declaration of the matcher out of
  `src/gateway.js` and out of `tools/era-archive/web/creators.js` by its own declaration
  line and compares them. The gateway's ranking is a copy, not a reimplementation, and this
  is what keeps it one.
* `tests/gateway.logic.test.js` runs the ranking itself under `node --test`, asserting that
  `rankBuilders` returns exactly what `filterBuilders` + `compareBuilders` + the eight-row
  cap return on the live side, for six different typings of the fixture. The Python gate
  shells out to it, so a broken ranking cannot pass a green `unittest` run.

## The lane

Four things move, and they move separately on purpose.

| What | Tool | Lands at |
| --- | --- | --- |
| The Chronicles site | `tools/chronicles/deploy.py` | `/srv/sites/chronicles/` |
| The era photo viewer | `tools/selfie-stick/push_viewer.py` | `/srv/sites/valheim/` and each `era*/` |
| An era's photographs | `tools/era-archive/publish_captures.py` | `/srv/sites/valheim/<era>/{thumb,large}/` |
| A whole era | `tools/selfie-stick/Publish-Gallery.ps1` (baseline) | `/srv/sites/valheim/<era>/` |

Caddy serves `/srv/sites/<slug>/` at `/<slug>/` with no configuration change, so nothing
in this lane edits a Caddyfile. It also gives `/chronicles/img/**` an immutable seven-day
cache header and serves `*.json` with no-cache, which is why the fonts and the hashed
assets live under `img/` and why `build.json` can be re-read to tell what is live.

### One-time bootstrap

`/srv/sites` is root-owned and `derek` has NOPASSWD sudo, so a human runs this once per
site and never again:

```
ssh fx99 sudo install -d -o derek -g derek -m 775 /srv/sites/chronicles
```

Everything afterwards writes as `derek` inside that directory. `deploy.py` refuses any
remote root outside `/srv/sites/`, and says so plainly if the directory is not there yet.

## Deploying the Chronicles site

```
python tools/chronicles/deploy.py --out <built dir> --dry-run
python tools/chronicles/deploy.py --out <built dir> --receipt deploy-receipt.json
```

The built directory is what the build lane produced: `index.html`, `guide/index.html`,
`chronicles.<hash>.css`, `gateway.<hash>.js`, `img/**`, `build.json` and `receipt.json`.
`receipt.json` is the contract -- `{"files":[{"path","bytes","sha256"}]}` -- and it is
checked twice: once locally before anything is sent, once on the box after extraction and
before anything points at the new files.

Nothing in `/srv/sites/chronicles/` is a real file. Each release is extracted whole into
`.releases/<utcYYYYmmddTHHMMSSZ>-<sha12 of receipt.json>/`, and publishing is re-pointing
the top-level symlinks (`index.html`, `guide`, `img`, the hashed css and js, `build.json`,
`receipt.json`) at it. Each link is created under a temporary name and renamed into place,
so a reader gets one release or the other and never a mixture. If a top-level entry is a
real file rather than a link, the deploy refuses it rather than clobbering something this
lane does not own.

Links left over from earlier releases are cleared, with one exception: the **previous**
release's hashed `chronicles.<hash>.css` and `gateway.<hash>.js` links are kept for one
generation. A browser that fetched the old HTML a second before the swap still names those
files, and this is what stops that reader getting a page with no stylesheet.

The last five releases are kept on disk; older ones are pruned, and a release something
still points at is never pruned.

```
python tools/chronicles/deploy.py --list                     # releases, and what the links point at
python tools/chronicles/deploy.py --rollback 20260910T041500Z-0123456789ab
```

`--rollback` is the same swap run against a directory that is still on disk. It does not
rebuild and does not transfer anything, so it is as fast as the deploy was slow, and the
release it moves away from is retained in turn.

## Deploying the era viewer

`tools/selfie-stick/gallery/index.html` is copied verbatim into eight directories -- the
gallery root plus each published `era*/` -- which is why every URL inside it is
root-absolute. When only the page changes, `Publish-Gallery.ps1` is the wrong tool: it
ships an era's whole dataset to deliver 40 kB of markup.

```
python tools/selfie-stick/push_viewer.py --dry-run          # targets and their current shas
python tools/selfie-stick/push_viewer.py --receipt push-receipt.json
python tools/selfie-stick/push_viewer.py --verify           # non-zero if any copy has drifted
python tools/selfie-stick/push_viewer.py --dirs era16,era7  # a subset; '.' means the root
```

Targets are discovered, not configured: the remote root itself plus every immediate
`era*/` holding an `index.json`. For each, the page being replaced is retained at
`<remote-root>/.viewer-releases/<sha12>.html`, the new page is written beside the old one
as `.index.html.<release>` and renamed onto it, and the result is re-read and compared. A
directory whose page did not take makes the command exit non-zero.

That retention directory name matters. `Publish-Gallery.ps1` clears a gallery with

```
rm -rf ./thumb ./large ./img && rm -f ./index.html ./index.json ./depth.json ./judge.json ./eras.json
```

so `.viewer-releases/` is outside everything it deletes and survives a full era publish --
the rollback target is still there after someone re-publishes the era underneath it.

```
python tools/selfie-stick/push_viewer.py --rollback 824d662bcce1
```

`--dry-run` and `--verify` are read-only: they run one ssh session that hashes files and
lists the retention directory, and write nothing.

## Screenshots for the pages

`tools/chronicles/shoot.mjs` photographs the live archive so the Chronicles pages can show
what they are describing, driving headless Chrome over CDP.

```
node tools/chronicles/shoot.mjs --base https://fx99.tail8e749c.ts.net --out shots/ --crop
```

It captures `find-search`, `find-thread`, `study-filters`, `study-lightbox`, `walk-eras`,
`request-dialog` and `data-stats` as full-page PNGs, and with `--crop` also writes a
720x450 `<name>.crop.webp` window onto the part of the page each step was about, cut by
`tools/chronicles/crop.py` (Pillow). Every step is allowed to fail: a page that has not
shipped, a search that finds nobody, a dialog that moved -- each logs a skip and the run
continues, and `shoot.json` records what was captured and what was not.

## Receipts

Every one of these writes a JSON receipt on request, and the receipt is the answer to
"what is live". `deploy.py --receipt` records the release and the one it replaced;
`push_viewer.py --receipt` records the sha pushed and, per directory, the sha it replaced
-- which is exactly what `--rollback` takes as its argument.
