# Valheim Chronicles

The public front of the archive: what people built, who built it, and how to ask for a
photograph of your own. It ships as static files behind Caddy on FX99 and is served at
`https://fx99.tail8e749c.ts.net/chronicles/`.

## Build

<!-- Owned by the build lane; leave this heading for it. -->

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
