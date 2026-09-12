'use strict';

// ---------------------------------------------------------------------------
// The pair view: one builder's profile page, one co-builder, and what the saved
// world already says about the two of them together. Nothing here is a new fact
// and nothing here is fetched: every number is derived in the browser from the
// anchor's own thread JSON, the directory record the page already holds, and the
// public participation file. No endpoint, no data file, no second request.
//
// The rule the whole model obeys: a shared build is a build both of them placed a
// saved piece on. That is the only claim the archive can make about two people
// without asking either of them, and it is the claim this view draws.
// ---------------------------------------------------------------------------

const PAIR_SCHEMA = 'steward-kinship-pair/v1';

// creators.js owns the shared model helpers. In the browser both files are classic
// scripts sharing one global lexical scope, so `computeTopEight` and its siblings are
// already bare names here -- they are `const` declarations, which never become
// properties of globalThis, so reaching for `globalThis.computeTopEight` would find
// nothing. In Node the same bare names have to resolve too, and hanging the exports
// on globalThis is what makes that work without inventing a second set of names.
//
// A creators.js too old to export them leaves StewardPair undefined rather than
// throwing at load: the profile page then renders without a pair view, which is the
// honest failure. A page that dies on a stale script is not.
const PAIR_READY = (() => {
  if (typeof module !== 'undefined' && typeof require === 'function') {
    try {
      const shared = require('./creators.js');
      for (const name of ['computeTopEight', 'majorityOwner', 'mergeKinshipTags',
        'portraitIndex', 'PLACEHOLDER_NAME', 'KINSHIP_TAGS', 'StewardParticipation']) {
        if (shared[name] !== undefined && globalThis[name] === undefined) globalThis[name] = shared[name];
      }
    } catch {
      return false;
    }
  }
  return typeof computeTopEight === 'function'
    && typeof majorityOwner === 'function'
    && typeof mergeKinshipTags === 'function'
    && typeof portraitIndex === 'function'
    && typeof KINSHIP_TAGS === 'object'
    && typeof StewardParticipation === 'object'
    && typeof PLACEHOLDER_NAME === 'object';
})();

/* ---- reading a thread ---- */

// Every album on the thread, in the order the eras publish them. The era block is the
// fallback for an album that carries no era of its own, the same way buildKinshipTree
// resolves it.
function pairAlbums(thread) {
  const out = [];
  for (const block of (thread && thread.eras) || []) {
    for (const album of block.albums || []) {
      if (album && album.buildKey) out.push({album, era: album.era ?? block.era ?? null});
    }
  }
  return out;
}

function pairContributor(album, builderKey) {
  return ((album && album.contributors) || []).find((c) => c && c.builderKey === builderKey) || null;
}

// A legacy import credits one leading contributor and carries no piece count for anyone
// (evidence: legacy-leading-contributor). That is a different thing from a zero share,
// and every place a percentage would otherwise be drawn has to say so instead.
function pairIsLegacy(album) {
  return ((album && album.contributors) || []).some((c) => c && c.pieces == null);
}

/* ---- the pure model ---- */

/**
 * How strongly two builders are bound, from the saved pieces alone.
 *
 * Sum over their shared builds of `min(shareA, shareB) * max(0, log10(pieces))`. The
 * min, because the overlap two people can claim on one structure is bounded by the
 * smaller of the two contributions -- the same rule the Top 8 uses. The log, because a
 * 40,000-piece keep is a bigger shared work than a 400-piece hut but not a hundred
 * times bigger, and without the damping one megabuild would decide every ranking.
 * A one-piece build scores zero (log10(1) is 0) and so does a legacy import, where a
 * missing share means the archive never knew the split.
 *
 * @param {object} thread anchor thread document
 * @param {string} allyKey co-builder's 32-hex builder key
 * @returns {number} unrounded affinity; 0 when they share nothing
 */
function kinshipAffinity(thread, allyKey) {
  const self = thread && thread.builderKey;
  if (!self || !allyKey || self === allyKey) return 0;
  let total = 0;
  for (const {album} of pairAlbums(thread)) {
    const mine = pairContributor(album, self);
    const theirs = pairContributor(album, allyKey);
    if (!mine || !theirs) continue;
    if (mine.share == null || theirs.share == null) continue;
    // log10(0) is -Infinity for an album with no recorded pieces; the floor at 0 keeps
    // that out of the sum instead of poisoning it.
    const weight = Math.max(0, Math.log10(Number(album.pieces) || 0));
    total += Math.min(mine.share, theirs.share) * weight;
  }
  return total;
}

/**
 * The tier a Top 8 rank wears. Three bands over eight places, so a tier is a band of
 * closeness rather than a leaderboard position read out loud.
 *
 * @param {number|null} rank 1-based position in the anchor's co-builder ranking
 * @returns {'I'|'II'|'III'|null} null outside the first eight
 */
function rankTier(rank) {
  if (!Number.isFinite(rank)) return null;
  if (rank >= 1 && rank <= 2) return 'I';
  if (rank >= 3 && rank <= 5) return 'II';
  if (rank >= 6 && rank <= 8) return 'III';
  return null;
}

/**
 * The albums both of them are credited on, biggest first.
 *
 * @param {object} thread anchor thread document
 * @param {string} allyKey co-builder's builder key
 * @returns {object[]} the album records themselves, pieces desc then buildKey asc
 */
function sharedBuildsBetween(thread, allyKey) {
  const self = thread && thread.builderKey;
  if (!self || !allyKey || self === allyKey) return [];
  return pairAlbums(thread)
    .filter(({album}) => pairContributor(album, self) && pairContributor(album, allyKey))
    .map(({album}) => album)
    .sort((a, b) => (b.pieces || 0) - (a.pieces || 0) || String(a.buildKey).localeCompare(String(b.buildKey)));
}

/**
 * How one build's pieces divide. Every credited contributor gets a segment, the pair
 * first so the bar reads left to right as "us, then everyone else", and whatever the
 * credited pieces do not account for becomes the unattributed remainder rather than
 * being quietly stretched across the people who are named.
 *
 * @param {object} album album record
 * @param {string[]} pairKeys [anchorKey, allyKey]
 * @returns {{segments: object[], unattributed: {pieces: number, share: number}, legacy: boolean}}
 */
function shareSplit(album, pairKeys = []) {
  const total = Number(album && album.pieces) || 0;
  const inPair = new Set(pairKeys.filter(Boolean));
  const contributors = ((album && album.contributors) || []).filter(Boolean);
  const segments = contributors.map((c) => {
    const pieces = c.pieces == null ? 0 : Number(c.pieces) || 0;
    const share = c.share != null ? Number(c.share) : (total ? pieces / total : 0);
    return {builderKey: c.builderKey, pieces, share, pair: inPair.has(c.builderKey)};
  });
  // Pair first and in the order they were named (anchor, then ally), then everyone else
  // largest first. A stable last key so two equal contributors never swap between renders.
  const rank = (segment) => (segment.pair ? pairKeys.indexOf(segment.builderKey) : Number.MAX_SAFE_INTEGER);
  segments.sort((a, b) => rank(a) - rank(b)
    || b.pieces - a.pieces
    || String(a.builderKey).localeCompare(String(b.builderKey)));
  const credited = segments.reduce((sum, segment) => sum + segment.pieces, 0);
  const gap = Math.max(0, total - credited);
  return {
    segments,
    unattributed: {pieces: gap, share: total ? gap / total : 0},
    legacy: pairIsLegacy(album),
  };
}

/**
 * What the archive is willing to say about the pair.
 *
 * `confirmed` once a coordinator has confirmed a kinship tag that names both of them on
 * a build they share -- in either direction, because one of them tagging the other is
 * the same fact told from the other end. Everything else is `recorded`: the saved world
 * shows them building together, which is a real thing to say and is not a claim anybody
 * made about anybody.
 *
 * @param {object[]} confirmedTags public confirmedTags records
 * @param {string} anchorKey
 * @param {string} allyKey
 * @param {string[]|Set<string>} sharedBuildKeys build keys the two of them share
 * @returns {'confirmed'|'recorded'}
 */
function pairStanding(confirmedTags, anchorKey, allyKey, sharedBuildKeys) {
  const shared = sharedBuildKeys instanceof Set ? sharedBuildKeys : new Set(sharedBuildKeys || []);
  for (const record of confirmedTags || []) {
    if (!record || !shared.has(record.buildKey)) continue;
    if (!(record.tags || []).length) continue;
    const forward = record.builderKey === anchorKey && record.contributorKey === allyKey;
    const backward = record.builderKey === allyKey && record.contributorKey === anchorKey;
    if (forward || backward) return 'confirmed';
  }
  return 'recorded';
}

/**
 * The tags each half of the pair wears on one build: confirmed by a coordinator, or
 * still sitting in this browser waiting to be sent on.
 *
 * @param {object[]} confirmedTags public confirmedTags records
 * @param {object} localTags StewardParticipation state.kinshipTags
 * @param {string} buildKey
 * @param {string} anchorKey
 * @param {string} allyKey
 * @returns {{allyWears: {confirmed: string[], pending: string[]}, anchorWears: {confirmed: string[], pending: string[]}}}
 */
function pairTagsForBuild(confirmedTags, localTags, buildKey, anchorKey, allyKey) {
  return {
    allyWears: mergeKinshipTags(confirmedTags, localTags, buildKey, allyKey),
    anchorWears: mergeKinshipTags(confirmedTags, localTags, buildKey, anchorKey),
  };
}

// One row of the shared-build ledger. Everything a row shows is already published on the
// album; nothing is computed that the thread does not already state.
function pairBuildRow(album, era, anchorKey, allyKey, confirmedTags, localTags) {
  const mine = pairContributor(album, anchorKey);
  const theirs = pairContributor(album, allyKey);
  const photos = Array.isArray(album.photos) ? album.photos : [];
  return {
    buildKey: album.buildKey,
    era: album.era ?? era ?? null,
    label: album.label || 'Untitled build',
    pieces: Number(album.pieces) || 0,
    photoCount: photos.length,
    photographed: photos.length > 0,
    photoStatus: album.photoStatus || null,
    anchorPieces: mine && mine.pieces != null ? Number(mine.pieces) : null,
    allyPieces: theirs && theirs.pieces != null ? Number(theirs.pieces) : null,
    anchorShare: mine && mine.share != null ? Number(mine.share) : null,
    allyShare: theirs && theirs.share != null ? Number(theirs.share) : null,
    legacy: pairIsLegacy(album),
    anchorOwnership: majorityOwner(album, anchorKey),
    allyOwnership: majorityOwner(album, allyKey),
    contributorCount: ((album.contributors || []).filter(Boolean)).length,
    terrainStatus: album.terrainStatus || null,
    worldUrl: album.worldUrl || null,
    galleryUrl: album.galleryUrl || null,
    tags: pairTagsForBuild(confirmedTags, localTags, album.buildKey, anchorKey, allyKey),
    // A later branch publishes bed residency on some albums. Until it does the key is
    // absent, and an absent key has to stay null rather than becoming an empty list that
    // would render an empty hearth panel on every build in the archive.
    residents: Array.isArray(album.residents) ? album.residents : null,
  };
}

/**
 * The whole pair model, and the JSON the sidebar offers for download.
 *
 * @param {object} thread anchor thread document
 * @param {string} allyKey co-builder's builder key
 * @param {object} options
 * @param {(key: string) => (object|null)} [options.builderFor] live directory accessor
 * @param {object[]} [options.confirmedTags]
 * @param {object} [options.localTags] StewardParticipation state.kinshipTags
 * @param {string|null} [options.activeBuildKey] falls back to the largest shared build
 * @returns {object|null} null when the two of them share nothing
 */
function buildKinshipPair(thread, allyKey, options = {}) {
  const {builderFor = null, confirmedTags = [], localTags = {}, activeBuildKey = null} = options;
  const anchorKey = (thread && thread.builderKey) || null;
  if (!anchorKey || !allyKey) return null;
  const shared = sharedBuildsBetween(thread, allyKey);
  if (!shared.length) return null;

  const eraByBuild = new Map(pairAlbums(thread).map(({album, era}) => [album.buildKey, era]));
  const rows = shared.map((album) => pairBuildRow(album, eraByBuild.get(album.buildKey),
    anchorKey, allyKey, confirmedTags, localTags));

  // An unknown activeBuildKey is a stale link or a hand-typed one; falling back to the
  // largest shared build is what the view would have opened on anyway.
  const active = rows.find((row) => row.buildKey === activeBuildKey) || rows[0];
  const activeAlbum = shared.find((album) => album.buildKey === active.buildKey);

  // The ally may be any co-builder, not only one of the first eight, so the ranking is
  // read in full and the rank is simply where they fall in it.
  const ranked = computeTopEight(thread, Infinity);
  const position = ranked.findIndex((entry) => entry.builderKey === allyKey);
  const rank = position >= 0 ? position + 1 : null;

  const record = typeof builderFor === 'function' ? builderFor(allyKey) : null;
  const anchorRecord = typeof builderFor === 'function' ? builderFor(anchorKey) : null;
  const eras = [...new Set(rows.map((row) => row.era).filter((era) => Number.isFinite(era)))].sort((a, b) => a - b);

  return {
    schema: PAIR_SCHEMA,
    anchor: {
      builderKey: anchorKey,
      displayName: thread.displayName || (anchorRecord && anchorRecord.displayName) || null,
      tier: thread.tier ?? (anchorRecord && anchorRecord.tier) ?? null,
    },
    ally: {
      builderKey: allyKey,
      displayName: (record && record.displayName) || null,
      tier: (record && record.tier) ?? null,
      named: !pairRecordIsUnnamed(record),
    },
    rank,
    tier: rankTier(rank),
    affinity: kinshipAffinity(thread, allyKey),
    standing: pairStanding(confirmedTags, anchorKey, allyKey, rows.map((row) => row.buildKey)),
    // The Top 8 rule: the overlap is bounded by the smaller contribution, and a legacy
    // import with no counts adds nothing rather than adding a guess.
    sharedPieces: rows.reduce((sum, row) => sum + Math.min(row.anchorPieces ?? 0, row.allyPieces ?? 0), 0),
    sharedBuildCount: rows.length,
    eras,
    photographedCount: rows.filter((row) => row.photographed).length,
    confirmedTagCount: rows.reduce((sum, row) =>
      sum + row.tags.allyWears.confirmed.length + row.tags.anchorWears.confirmed.length, 0),
    sharedBuilds: rows,
    activeBuild: {
      ...active,
      photos: Array.isArray(activeAlbum && activeAlbum.photos) ? activeAlbum.photos : [],
      allotment: shareSplit(activeAlbum, [anchorKey, allyKey]),
    },
  };
}

// Mirrors kinship.js's isUnnamed, including its deliberate `false` for a missing record:
// before directory.json lands every builder on the page is nameless in the same way, and
// marking them all unnamed for that half-second would be the page reporting its own load
// state as a fact about a person.
function pairRecordIsUnnamed(record) {
  if (!record) return false;
  if (record.nameStatus === 'unresolved' || record.nameStatus === 'ambiguous') return true;
  return PLACEHOLDER_NAME.test(String(record.displayName || ''));
}

/* ---- the view ---- */

// gallery.py writes one of two terrain states per build, and neither is a word a reader
// should have to look up: "awaiting-runtime" means the saved world is there and the
// terrain pass has not run over it yet.
const PAIR_TERRAIN_WORDS = {
  'historical-gallery': 'This one is a historical gallery import, with no saved world behind it',
  'awaiting-runtime': 'Its saved world is recorded and the terrain pass is still to run',
};

const pairState = {
  host: null, ctx: null, coBuilders: [], allyKey: null, buildKey: null,
  open: false, model: null, onClick: null,
};

/* ---- small makers ---- */

function pairNode(tag, text, cls) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function pairButton(text, cls, action) {
  const el = pairNode('button', text, cls);
  el.type = 'button';
  if (action) el.dataset.pairAction = action;
  return el;
}

function pairPlural(n, one, many) {
  const value = Number(n) || 0;
  return `${value.toLocaleString()} ${value === 1 ? one : many || `${one}s`}`;
}

// Runs of consecutive eras collapse, the same way the directory cards state theirs:
// "eras 7-8, 12" rather than four lines of tablets on a phone.
function pairEraRange(eras) {
  const sorted = [...new Set((eras || []).filter((e) => Number.isFinite(e)))].sort((a, b) => a - b);
  if (!sorted.length) return '';
  const runs = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const era of sorted.slice(1)) {
    if (era === previous + 1) { previous = era; continue; }
    runs.push([start, previous]);
    start = previous = era;
  }
  runs.push([start, previous]);
  return `${sorted.length === 1 ? 'era' : 'eras'} ${runs.map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(', ')}`;
}

// Whole percent once a share is big enough to read as one; a tenth below that, because
// "0 %" for a real contribution is a worse answer than a decimal point.
function pairPercent(share) {
  const pct = 100 * (Number(share) || 0);
  return `${pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)} %`;
}

// Two places at every magnitude. Affinity is a share times a log, so a whole-number
// rounding would report most real pairs as "0" and the rest as "1".
function pairAffinityText(affinity) {
  return (Number(affinity) || 0).toFixed(2);
}

// Floored, never rounded: ten segments each rounded up to two places sum to 100.01 %,
// and a stacked bar whose parts add up to more than the whole is wrong however small the
// overflow is. The lost hundredths land in the unattributed gap, where they belong.
function pairSegWidth(share) {
  return `${Math.max(0, Math.floor(10000 * (Number(share) || 0)) / 100)}%`;
}

function pairTerrainWords(status) {
  return PAIR_TERRAIN_WORDS[status] || 'Its terrain is not recorded';
}

function pairTagLabel(id) {
  for (const group of Object.values(KINSHIP_TAGS)) {
    const hit = (group || []).find((entry) => entry && entry[0] === id);
    if (hit) return hit[1];
  }
  return id;
}

// The directory accessor is live: creators.js hands over a function, not the Map behind
// it, because the Map is replaced wholesale when directory.json lands. Caching it here
// would freeze every name on the page at "Builder edb04052" forever.
function pairRecord(key) {
  const ctx = pairState.ctx;
  return ctx && typeof ctx.builderFor === 'function' ? ctx.builderFor(key) : null;
}

function pairName(key) {
  const record = pairRecord(key);
  return (record && record.displayName) || `Builder ${String(key || '').slice(0, 8)}`;
}

function pairNameEl(key, tag = 'span') {
  const el = pairNode(tag, pairName(key));
  el.dataset.pairNameKey = key;
  return el;
}

function pairBuilderHref(key) {
  const base = pairState.ctx && pairState.ctx.base;
  try {
    return new URL(`${key}/`, base).href;
  } catch {
    return `${key}/`;
  }
}

function pairQuery(selector) {
  return pairState.host ? pairState.host.querySelector(selector) : null;
}

// Replace one region in place. Focus is restored when the element that had it can be
// found again by id or by the build key it carries -- a repaint triggered by data
// arriving must never take the keyboard away from whoever is using the page.
function pairSwap(id, next) {
  const current = pairQuery(`#${id}`);
  if (!current) return;
  const focused = current.contains(document.activeElement) ? document.activeElement : null;
  const selector = focused && focused.id ? `#${focused.id}`
    : focused && focused.dataset.buildKey ? `[data-build-key="${focused.dataset.buildKey}"]`
      : null;
  current.replaceWith(next);
  if (!selector) return;
  const again = next.matches(selector) ? next : next.querySelector(selector);
  if (again && typeof again.focus === 'function') again.focus();
}

/* ---- portraits ---- */

// The archive's own mark, standing in for a face. Used before the manifest answers, when
// it names no tile for this builder, and when a named tile fails to load: an empty square
// and a broken-image glyph are both worse than the emblem.
function pairEmblem(key, cls) {
  const holder = pairNode('span', null, cls);
  holder.dataset.pairPortraitKey = key;
  holder.setAttribute('aria-hidden', 'true');
  const emblem = document.querySelector('.brand-emblem');
  if (emblem) {
    const clone = emblem.cloneNode(true);
    clone.removeAttribute('class');
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    holder.append(clone);
  }
  return holder;
}

// The face comes from the one resolver every surface uses (web/portraits.js), so the
// pair card, the ribbon and the tree never disagree about a builder -- including a
// portrait chosen on this device.
function pairPortrait(key, cls = 'pair-portrait') {
  const manifest = pairState.ctx && pairState.ctx.portraits;
  const face = typeof StewardPortraits === 'object' && manifest ? StewardPortraits.portraitFor(key, manifest) : null;
  const src = face ? face.url('bust128') : null;
  if (!src) return pairEmblem(key, cls);
  const img = document.createElement('img');
  img.className = cls;
  img.alt = '';
  img.width = 36;
  img.height = 36;
  img.decoding = 'async';
  img.loading = 'lazy';
  img.dataset.pairPortraitKey = key;
  img.onerror = () => img.replaceWith(pairEmblem(key, cls));
  img.src = src;
  return img;
}

/* ---- model plumbing ---- */

function pairRebuildModel(preferredBuildKey) {
  const ctx = pairState.ctx;
  const model = buildKinshipPair(ctx.thread, pairState.allyKey, {
    builderFor: ctx.builderFor,
    confirmedTags: Array.isArray(ctx.confirmedTags) ? ctx.confirmedTags : [],
    localTags: (ctx.participation && ctx.participation.kinshipTags) || {},
    activeBuildKey: preferredBuildKey || null,
  });
  pairState.model = model;
  pairState.buildKey = model ? model.activeBuild.buildKey : null;
  return model;
}

/* ---- header, the who row, pills ---- */

function pairTitleEl() {
  const h = pairNode('h3', 'Kinship with ', 'pair-title');
  h.id = 'pair-title';
  h.append(pairNameEl(pairState.allyKey));
  return h;
}

function pairStatusText() {
  const model = pairState.model;
  const parts = [
    pairPlural(model.sharedBuildCount, 'shared build'),
    pairPlural(model.sharedPieces, 'shared piece'),
  ];
  const eras = pairEraRange(model.eras);
  if (eras) parts.push(eras);
  return parts.join(' · ');
}

function pairStatusEl() {
  const p = pairNode('p', pairStatusText(), 'pair-status');
  p.id = 'pair-status';
  return p;
}

function pairPaintStanding(chip) {
  const confirmed = pairState.model.standing === 'confirmed';
  chip.dataset.standing = confirmed ? 'confirmed' : 'recorded';
  chip.textContent = confirmed ? 'Confirmed kin' : 'Recorded kin';
  chip.title = confirmed
    ? 'A coordinator confirmed a kinship tag naming you both, and the archive publishes it.'
    : 'The saved world shows you built together: your pieces stand on the same builds. No tag between you has been confirmed.';
}

function pairStandingEl() {
  const chip = pairNode('span', null, 'chip pair-standing');
  chip.id = 'pair-standing';
  pairPaintStanding(chip);
  return chip;
}

// The status line and the standing chip on one row. Until pass 3 this row was a
// PHOTOGRAPHS / WORLD VIEWER tab strip over a second photograph of the build; the page's
// carousel shows the photographs now and every build on the page carries its own world
// viewer link, so the pair view keeps to the pairing. The row is the one live region in
// the whole view: the sentence that says what this pair is, and the word for its
// standing. Every other repaint is silent on purpose -- a screen reader that announced
// each chip and each table cell as the data landed would bury that sentence.
function pairHeadEl() {
  const head = pairNode('div', null, 'pair-head');
  head.id = 'pair-head';
  head.setAttribute('aria-live', 'polite');
  head.append(pairStatusEl(), pairStandingEl());
  return head;
}

// Who the other half is, and the way to see the pair from their side, on one row.
function pairWhoEl() {
  const who = pairNode('div', null, 'pair-who');
  who.id = 'pair-who';
  const reverse = pairNode('a', 'See this pair from their side', 'kin-open pair-reverse');
  reverse.id = 'pair-reverse';
  reverse.href = `${pairBuilderHref(pairState.model.ally.builderKey)}?kin=${pairState.model.anchor.builderKey}`;
  who.append(pairAllyCardEl(), reverse);
  return who;
}

// Three at most: the pills are a shortcut to the biggest shared works, and the full list
// is the ledger above. A pair with forty shared builds would otherwise open Details on
// four lines of tablets.
function pairPillsEl() {
  const wrap = pairNode('div', null, 'pair-pills');
  wrap.id = 'pair-pills';
  for (const row of pairState.model.sharedBuilds.slice(0, 3)) {
    const pill = pairButton(row.era == null ? row.label : `${row.label} · Era ${row.era}`, 'pair-pill', 'build');
    pill.dataset.buildKey = row.buildKey;
    pill.setAttribute('aria-pressed', String(row.buildKey === pairState.buildKey));
    wrap.append(pill);
  }
  return wrap;
}

/* ---- the Details fold: laurels, hearth, affinity, facts ---- */

function pairChipRowEl(labelNodes, worn) {
  const row = pairNode('div', null, 'pair-chip-row');
  const label = pairNode('span', null, 'pair-chip-label');
  for (const part of labelNodes) label.append(part);
  row.append(label);
  for (const id of worn.confirmed) row.append(pairNode('span', pairTagLabel(id), 'chip kin-chip confirmed'));
  for (const id of worn.pending) row.append(pairNode('span', pairTagLabel(id), 'chip kin-chip pending'));
  return row;
}

function pairLaurelsEl() {
  const model = pairState.model;
  const build = model.activeBuild;
  const wrap = pairNode('div', null, 'pair-laurels');
  wrap.id = 'pair-laurels';
  wrap.append(pairNode('h4', 'Laurels', 'pair-h'));
  const ally = build.tags.allyWears;
  const anchor = build.tags.anchorWears;
  const anyAlly = ally.confirmed.length + ally.pending.length;
  const anyAnchor = anchor.confirmed.length + anchor.pending.length;
  if (!anyAlly && !anyAnchor) {
    wrap.append(pairNode('p', 'No tags confirmed yet.', 'muted'));
    const open = pairNode('a', 'Tag co-builders on the kinship page', 'kin-open');
    open.href = pairKinshipHref();
    wrap.append(open);
    return wrap;
  }
  if (anyAlly) wrap.append(pairChipRowEl([pairNameEl(model.ally.builderKey), ' wears:'], ally));
  if (anyAnchor) wrap.append(pairChipRowEl(['They tagged you:'], anchor));
  return wrap;
}

// Bed residency is a later branch's field. Until it publishes, the album carries no
// `residents` at all, and an absent key has to stay absent rather than rendering an
// empty hearth on every build in the archive.
function pairHearthEl() {
  const model = pairState.model;
  const build = model.activeBuild;
  const wrap = pairNode('div', null, 'pair-hearth');
  wrap.id = 'pair-hearth';
  const lines = [];
  for (const key of [model.ally.builderKey, model.anchor.builderKey]) {
    const entry = (build.residents || []).find((r) => r && r.builderKey === key);
    if (entry) lines.push(entry);
  }
  if (!build.residents || !lines.length) {
    wrap.hidden = true;
    return wrap;
  }
  wrap.append(pairNode('h4', 'Shared hearth', 'pair-h'));
  for (const entry of lines) {
    const line = pairNode('p', null, 'pair-hearth-line');
    line.append(pairNameEl(entry.builderKey));
    line.append(` slept here (${pairPlural(entry.beds, 'bed')})`);
    wrap.append(line);
  }
  return wrap;
}

function pairAffinityEl() {
  const model = pairState.model;
  const wrap = pairNode('div', null, 'pair-affinity');
  wrap.id = 'pair-affinity';
  wrap.append(pairNode('span', pairAffinityText(model.affinity), 'counter'));
  wrap.append(pairNode('span', 'Kinship affinity', 'pair-affinity-label'));
  if (model.tier) {
    wrap.append(pairNode('span', `Tier ${model.tier} (rank ${model.rank} of this builder's Top 8)`, 'pair-tier'));
  }
  return wrap;
}

function pairFact(dl, term, value) {
  dl.append(pairNode('dt', term));
  const dd = pairNode('dd');
  if (value instanceof Node) dd.append(value); else dd.textContent = String(value);
  dl.append(dd);
}

// Who may speak for this build, in the words majorityOwner actually means: half or more
// of the pieces is a majority, the single biggest known share from a quarter up is the
// largest share, and anything else is shared between everyone credited.
function pairLeadEl(build) {
  const model = pairState.model;
  const pairs = [[model.anchor.builderKey, build.anchorOwnership], [model.ally.builderKey, build.allyOwnership]];
  for (const [key, ownership] of pairs) {
    if (!ownership) continue;
    const dd = pairNode('span');
    dd.append(pairNameEl(key));
    dd.append(ownership === 'majority' ? ' (majority)' : ' (largest share)');
    return dd;
  }
  return pairNode('span', 'Shared');
}

function pairFactsEl() {
  const build = pairState.model.activeBuild;
  const dl = pairNode('dl', null, 'pair-facts');
  dl.id = 'pair-facts';
  pairFact(dl, 'Pieces', build.pieces.toLocaleString());
  pairFact(dl, 'Era', build.era == null ? 'Not recorded' : String(build.era));
  pairFact(dl, 'Contributors', build.contributorCount.toLocaleString());
  pairFact(dl, 'Photographs', build.photoCount.toLocaleString());
  // Where the page shows this build: the carousel when it has been photographed, the
  // rest table otherwise. The button takes the visitor there.
  pairFact(dl, 'On this page', pairButton(build.photoCount ? 'Show on the carousel' : 'Show in the rest', 'pair-find', 'reveal'));
  pairFact(dl, 'Terrain', `${pairTerrainWords(build.terrainStatus)}.`);
  pairFact(dl, 'Leading contributor', pairLeadEl(build));
  if (build.galleryUrl) {
    const a = pairNode('a', 'Open the original gallery');
    a.href = build.galleryUrl;
    pairFact(dl, 'Gallery', a);
  }
  if (build.worldUrl) {
    const a = pairNode('a', 'Open in the world viewer');
    a.href = build.worldUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    pairFact(dl, 'World viewer', a);
  }
  return dl;
}

/* ---- piece allotment ---- */

function pairSegEl(segment) {
  const model = pairState.model;
  const classes = ['pair-seg', segment.pair ? 'is-pair' : 'is-other'];
  if (segment.pair) classes.push(segment.builderKey === model.anchor.builderKey ? 'is-anchor' : 'is-ally');
  const el = pairNode('span', null, classes.join(' '));
  el.style.width = pairSegWidth(segment.share);
  el.dataset.pairNameKey = segment.builderKey;
  el.dataset.pairNameSlot = 'title';
  el.dataset.pairNameRest = `${segment.pieces.toLocaleString()} pieces · ${pairPercent(segment.share)}`;
  el.title = `${pairName(segment.builderKey)} · ${el.dataset.pairNameRest}`;
  return el;
}

function pairLegendRowEl(name, pieces, share, cls) {
  const row = pairNode('li', null, `pair-legend-row${cls ? ` ${cls}` : ''}`);
  row.append(name);
  row.append(pairNode('span', pieces.toLocaleString(), 'pair-legend-pieces'));
  row.append(pairNode('span', pairPercent(share), 'pair-legend-share'));
  return row;
}

function pairAllotmentEl() {
  const model = pairState.model;
  const {segments, unattributed, legacy} = model.activeBuild.allotment;
  const wrap = pairNode('div', null, 'pair-allotment');
  wrap.id = 'pair-allotment';
  wrap.append(pairNode('h4', 'Piece allotment', 'pair-h'));
  if (legacy) {
    wrap.append(pairNode('p', 'Shares unknown — this build is a historical import that credits one leading contributor.', 'muted'));
    return wrap;
  }
  const bar = pairNode('div', null, 'pair-bar');
  for (const segment of segments) bar.append(pairSegEl(segment));
  if (unattributed.pieces > 0) {
    const rest = pairNode('span', null, 'pair-seg is-unattributed');
    rest.style.width = pairSegWidth(unattributed.share);
    rest.title = `Unattributed · ${unattributed.pieces.toLocaleString()} pieces · ${pairPercent(unattributed.share)}`;
    bar.append(rest);
  }
  wrap.append(bar);

  const legend = pairNode('ul', null, 'pair-legend');
  for (const segment of segments) {
    legend.append(pairLegendRowEl(pairNameEl(segment.builderKey), segment.pieces, segment.share,
      segment.pair ? 'is-pair' : 'is-other'));
  }
  if (unattributed.pieces > 0) {
    legend.append(pairLegendRowEl(pairNode('span', 'Unattributed'), unattributed.pieces, unattributed.share, 'is-unattributed'));
  }
  wrap.append(legend);
  return wrap;
}

/* ---- the ally, Details, the ledger ---- */

function pairMetricEl(label, value, note, id) {
  const cell = pairNode('div', null, 'pair-metric');
  cell.append(pairNode('span', label, 'pair-metric-label'));
  const figure = pairNode('span', value, 'pair-metric-value counter');
  if (id) figure.id = id;
  cell.append(figure);
  if (note) cell.append(pairNode('span', note, 'pair-metric-note'));
  return cell;
}

function pairAllyCardEl() {
  const model = pairState.model;
  const card = pairNode('div', null, 'pair-ally');
  card.id = 'pair-ally';

  const head = pairNode('div', null, 'pair-ally-head');
  head.append(pairPortrait(model.ally.builderKey, 'pair-portrait'));
  const who = pairNode('div', null, 'pair-ally-who');
  const name = pairNameEl(model.ally.builderKey, 'a');
  name.id = 'pair-ally-name';
  name.className = 'pair-ally-name';
  name.href = pairBuilderHref(model.ally.builderKey);
  who.append(name);
  const marks = pairNode('div', null, 'pair-ally-marks');
  const tier = pairNode('span', model.ally.tier ? `Tier ${model.ally.tier}` : '', 'chip pair-ally-tier');
  tier.id = 'pair-ally-tier';
  tier.hidden = !model.ally.tier;
  marks.append(tier);
  const unnamed = pairNode('span', 'unnamed', 'chip pair-unnamed');
  unnamed.id = 'pair-ally-unnamed';
  unnamed.title = 'No single recorded name won for this builder, so the archive shows the key.';
  unnamed.hidden = model.ally.named;
  marks.append(unnamed);
  who.append(marks);
  head.append(who);
  card.append(head);
  return card;
}

// The five tiles the ally card used to carry. They live under Details now: the status
// line at the top already says shared builds and shared pieces in words.
function pairMetricsEl() {
  const model = pairState.model;
  const metrics = pairNode('div', null, 'pair-metrics');
  metrics.id = 'pair-metrics';
  metrics.append(pairMetricEl('Shared pieces', model.sharedPieces.toLocaleString()));
  metrics.append(pairMetricEl('Shared builds', model.sharedBuildCount.toLocaleString(), pairEraRange(model.eras)));
  metrics.append(pairMetricEl('Photographed', model.photographedCount.toLocaleString()));
  metrics.append(pairMetricEl('Confirmed tags', model.confirmedTagCount.toLocaleString(), null, 'pair-metric-tags'));
  metrics.append(pairMetricEl('Kinship affinity', pairAffinityText(model.affinity)));
  return metrics;
}

// Everything about the pair that a visitor reads once, folded under one native
// disclosure: the build pills, the laurels, the shared hearth, the affinity, the facts
// table, the metric tiles and the piece allotment. Native <details>, so no script owns
// the open state -- but a repaint reads it back so a data arrival never snaps it shut.
function pairMoreEl({open = false} = {}) {
  const more = pairNode('details', null, 'pair-more');
  more.id = 'pair-more';
  more.open = open;
  more.append(pairNode('summary', 'Details'));
  const body = pairNode('div', null, 'pair-more-body');
  body.append(pairPillsEl(), pairLaurelsEl(), pairHearthEl(), pairAffinityEl(), pairFactsEl(), pairMetricsEl(), pairAllotmentEl());
  more.append(body);
  return more;
}

function pairMoreOpen() {
  const current = pairQuery('#pair-more');
  return current ? current.open : false;
}

// The row Details describe is the tinted one (aria-selected); the word says only
// whether the build has been photographed.
function pairLedgerStatus(row) {
  return row.photographed ? 'Photographed' : 'Recorded';
}

function pairSplitCellEl(row) {
  const cell = pairNode('td', null, 'text-left pair-ledger-split');
  if (row.legacy || row.anchorShare == null || row.allyShare == null) {
    cell.textContent = 'shares unknown';
    return cell;
  }
  cell.append(`You ${pairPercent(row.anchorShare)} · `);
  cell.append(pairNameEl(pairState.model.ally.builderKey));
  cell.append(` ${pairPercent(row.allyShare)}`);
  return cell;
}

function pairLedgerEl() {
  const model = pairState.model;
  const wrap = pairNode('div', null, 'stats-table-wrap pair-ledger-wrap');
  wrap.id = 'pair-ledger-wrap';
  const table = pairNode('table', null, 'stats-table');
  table.id = 'pair-ledger';
  const caption = pairNode('caption', 'Shared builds', 'pair-ledger-caption');
  table.append(caption);
  const head = pairNode('thead');
  const headRow = pairNode('tr');
  for (const [label, left] of [['Build', true], ['Era', false], ['Pieces', false], ['Split', true], ['Status', true]]) {
    headRow.append(pairNode('th', label, left ? 'text-left' : null));
  }
  head.append(headRow);
  table.append(head);

  const body = pairNode('tbody');
  for (const row of model.sharedBuilds) {
    const tr = pairNode('tr');
    tr.dataset.buildKey = row.buildKey;
    tr.setAttribute('aria-selected', String(row.buildKey === pairState.buildKey));
    const build = pairNode('td', null, 'text-left');
    const pick = pairButton(row.label, 'pair-ledger-pick', 'build');
    pick.dataset.buildKey = row.buildKey;
    build.append(pick);
    tr.append(build);
    tr.append(pairNode('td', row.era == null ? '—' : String(row.era)));
    tr.append(pairNode('td', row.pieces.toLocaleString()));
    tr.append(pairSplitCellEl(row));
    tr.append(pairNode('td', pairLedgerStatus(row), 'text-left pair-ledger-status'));
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

function pairPaintLedgerRows() {
  for (const tr of pairState.host.querySelectorAll('#pair-ledger tbody tr')) {
    const row = pairState.model.sharedBuilds.find((r) => r.buildKey === tr.dataset.buildKey);
    if (!row) continue;
    tr.setAttribute('aria-selected', String(row.buildKey === pairState.buildKey));
    const status = tr.querySelector('.pair-ledger-status');
    if (status) status.textContent = pairLedgerStatus(row);
  }
}

function pairPaintDownload(anchor) {
  const model = pairState.model;
  anchor.setAttribute('download',
    `kinship-${model.anchor.builderKey.slice(0, 8)}-${model.ally.builderKey.slice(0, 8)}.json`);
  anchor.href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(model, null, 2))}`;
}

// The same shape the builder manifest link takes: a data: href built from what is already
// on the page, so the ledger downloads with no request and no file published anywhere.
function pairDownloadEl() {
  const anchor = pairNode('a', 'Download pair ledger (JSON)', 'kin-open pair-download');
  anchor.id = 'pair-download';
  pairPaintDownload(anchor);
  return anchor;
}

function pairKinshipHref() {
  const ctx = pairState.ctx;
  const anchorKey = ctx.thread.builderKey;
  if (typeof ctx.kinshipHref === 'function') return ctx.kinshipHref(anchorKey);
  try {
    return new URL(`kinship/?builder=${anchorKey}`, ctx.base).href;
  } catch {
    return `kinship/?builder=${anchorKey}`;
  }
}

/* ---- assembly ---- */

// Top to bottom: the title, the status line with the standing chip, the ally with the
// reverse link, the shared-builds ledger, its download, and Details folded.
function pairRenderAll() {
  const host = pairState.host;
  host.replaceChildren(pairTitleEl(), pairHeadEl(), pairWhoEl(), pairLedgerEl(), pairDownloadEl(), pairMoreEl({open: pairMoreOpen()}));
  host.hidden = false;
}

// Only what the active build decides. The ally row, the ledger table and the title
// belong to the pair, not to the build, so picking another build leaves them alone --
// and leaves the scroll position and the focused ledger button where they were.
function pairRenderActiveBuild() {
  pairSwap('pair-more', pairMoreEl({open: pairMoreOpen()}));
  pairPaintLedgerRows();
  const download = pairQuery('#pair-download');
  if (download) pairPaintDownload(download);
}

function pairEmit() {
  if (!pairState.host) return;
  pairState.host.dispatchEvent(new CustomEvent('pair:change', {
    bubbles: true,
    detail: {
      ally: pairState.open ? pairState.allyKey : null,
      build: pairState.open ? pairState.buildKey : null,
    },
  }));
}

// Keeps kin/build in the address bar without adding a history entry per click, and keeps
// every other param and the hash: #request and ?q= are other people's state. A `view=`
// from a link shared before pass 3 is dropped: there is one view now.
// A build that is simply the pair's largest is not written at all -- it is what the view
// opens on anyway, and an invalid one falls back to it and so leaves no trace.
function pairSyncUrl() {
  if (typeof history === 'undefined' || !history.replaceState) return;
  const params = new URLSearchParams(location.search);
  const model = pairState.model;
  const fallback = model && model.sharedBuilds.length ? model.sharedBuilds[0].buildKey : null;
  if (pairState.open && pairState.allyKey) params.set('kin', pairState.allyKey);
  else params.delete('kin');
  if (pairState.open && pairState.buildKey && pairState.buildKey !== fallback) params.set('build', pairState.buildKey);
  else params.delete('build');
  params.delete('view');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash || ''}`);
}

function pairSetBuild(buildKey) {
  if (!buildKey || buildKey === pairState.buildKey) return;
  if (!pairState.model.sharedBuilds.some((row) => row.buildKey === buildKey)) return;
  pairRebuildModel(buildKey);
  pairRenderActiveBuild();
  pairSyncUrl();
  pairEmit();
  // The page owns the pictures now: a photographed build picked here turns the carousel
  // above to it without moving the visitor -- the photograph is there when they scroll
  // back up. A build that was never photographed has nothing to turn to.
  if (pairState.model.activeBuild.photoCount && typeof pairState.ctx.revealAlbum === 'function') {
    pairState.ctx.revealAlbum(buildKey, {scroll: false});
  }
}

function pairOnClick(event) {
  const target = event.target && event.target.closest ? event.target.closest('[data-pair-action]') : null;
  if (!target || !pairState.host || !pairState.host.contains(target)) return;
  const action = target.dataset.pairAction;
  if (action === 'build') return pairSetBuild(target.dataset.buildKey);
  if (action === 'reveal' && typeof pairState.ctx.revealAlbum === 'function') {
    pairState.ctx.revealAlbum(pairState.buildKey);
  }
  return undefined;
}

/* ---- names and portraits, repainted in place ---- */

function pairPaintNames() {
  for (const el of pairState.host.querySelectorAll('[data-pair-name-key]')) {
    const name = pairName(el.dataset.pairNameKey);
    if (el.dataset.pairNameSlot === 'title') el.title = `${name} · ${el.dataset.pairNameRest || ''}`;
    else el.textContent = name;
  }
  const model = pairState.model;
  const tier = pairQuery('#pair-ally-tier');
  if (tier) {
    tier.textContent = model.ally.tier ? `Tier ${model.ally.tier}` : '';
    tier.hidden = !model.ally.tier;
  }
  const unnamed = pairQuery('#pair-ally-unnamed');
  if (unnamed) unnamed.hidden = model.ally.named;
}

function pairPaintPortraits() {
  for (const el of [...pairState.host.querySelectorAll('[data-pair-portrait-key]')]) {
    const next = pairPortrait(el.dataset.pairPortraitKey, el.getAttribute('class') || 'pair-portrait');
    if (el.id) next.id = el.id;
    el.replaceWith(next);
  }
}

/* ---- the four entry points ---- */

/**
 * Fill `section#pair-view` and show it.
 *
 * Unmounts any prior instance first. Opens on `ctx.initial.kin` when that key is a
 * co-builder and on rank 1 otherwise; leaves the host hidden and returns when the anchor
 * has no co-builder at all -- a solo builder has no pair to draw and gets no empty panel
 * saying so. Writes kin/build into the URL with replaceState, keeping every other param
 * and the hash.
 *
 * @param {HTMLElement} host the section creators.js appended after the Top 8 ribbon
 * @param {object} ctx thread, builderFor, participation, confirmedTags, portraits,
 *   initial {kin, build}, revealAlbum(buildKey, {scroll}), base, kinshipHref
 */
function pairMount(host, ctx) {
  pairUnmount();
  if (!host || !ctx || !ctx.thread) return;
  pairState.host = host;
  pairState.ctx = ctx;
  host.classList.add('pair-view');
  if (!host.id) host.id = 'pair-view';
  host.setAttribute('role', 'region');
  host.setAttribute('aria-labelledby', 'pair-title');

  pairState.coBuilders = computeTopEight(ctx.thread, Infinity).map((entry) => entry.builderKey);
  const initial = ctx.initial || {};
  const wanted = initial.kin && pairState.coBuilders.includes(initial.kin) ? initial.kin : pairState.coBuilders[0];
  if (!wanted) {
    host.hidden = true;
    return;
  }
  pairState.allyKey = wanted;
  if (!pairRebuildModel(initial.build || null)) {
    host.hidden = true;
    pairState.allyKey = null;
    return;
  }
  pairState.open = true;
  pairState.onClick = pairOnClick;
  host.addEventListener('click', pairState.onClick);
  pairRenderAll();
  pairSyncUrl();
  // The ribbon cannot know which chip mount settled on -- an invalid ?kin= falls back to
  // rank 1 -- so it hears the opening pair the same way it hears every later one.
  pairEmit();
}

/**
 * Open, switch or collapse the pair from the Top 8 ribbon.
 *
 * The same key as the open pair collapses it; another co-builder switches the pair and
 * resets the active build to that pair's largest; a key that never built beside this
 * builder is ignored. Always fires a bubbling `pair:change` on the host -- the ribbon
 * owns its own aria-pressed and reads that event for it.
 *
 * @param {string} key a co-builder's builder key
 * @returns {string|null} the newly active key; null for a collapse and for an ignored key
 */
function pairSelect(key) {
  if (!pairState.host || !pairState.ctx) return null;
  if (!key || !pairState.coBuilders.includes(key)) return null;
  if (pairState.open && key === pairState.allyKey) {
    pairState.open = false;
    pairState.host.hidden = true;
    pairSyncUrl();
    pairEmit();
    return null;
  }
  pairState.allyKey = key;
  if (!pairRebuildModel(null)) {
    pairState.open = false;
    pairState.host.hidden = true;
    pairSyncUrl();
    pairEmit();
    return null;
  }
  pairState.open = true;
  pairRenderAll();
  pairSyncUrl();
  pairEmit();
  return key;
}

/**
 * Repaint the regions one late arrival changed, and nothing else.
 *
 * `{confirmedTags}` repaints the laurels, the standing badge, the ledger status column
 * and the sidebar tag count; `{names: true}` rewrites every `[data-pair-name-key]` when
 * directory.json lands; `{portraits}` swaps every `[data-pair-portrait-key]` tile. The
 * section is never rebuilt, so a scroll position and a focused control both survive.
 * A no-op before mount.
 *
 * @param {{confirmedTags?: object[], names?: boolean, portraits?: object}} patch
 */
function pairUpdate(patch) {
  if (!pairState.host || !pairState.model || !patch) return;
  if (Array.isArray(patch.confirmedTags)) {
    pairState.ctx.confirmedTags = patch.confirmedTags;
    if (!pairRebuildModel(pairState.buildKey)) return;
    // The chip is inside the live head row, so a tag arriving after mount is heard.
    const standing = pairQuery('#pair-standing');
    if (standing) pairPaintStanding(standing);
    pairSwap('pair-laurels', pairLaurelsEl());
    pairPaintLedgerRows();
    const tags = pairQuery('#pair-metric-tags');
    if (tags) tags.textContent = pairState.model.confirmedTagCount.toLocaleString();
  }
  if (patch.names) {
    if (!pairRebuildModel(pairState.buildKey)) return;
    pairPaintNames();
  }
  if (patch.portraits) {
    pairState.ctx.portraits = patch.portraits;
    pairPaintPortraits();
  }
  const download = pairQuery('#pair-download');
  if (download) pairPaintDownload(download);
}

/** Drop the listeners and empty the host. Safe to call when nothing is mounted. */
function pairUnmount() {
  const host = pairState.host;
  if (host) {
    if (pairState.onClick) host.removeEventListener('click', pairState.onClick);
    host.replaceChildren();
    host.hidden = true;
  }
  pairState.host = null;
  pairState.ctx = null;
  pairState.coBuilders = [];
  pairState.allyKey = null;
  pairState.buildKey = null;
  pairState.open = false;
  pairState.model = null;
  pairState.onClick = null;
}

// Only when creators.js handed over everything the model reads. A profile page whose
// creators.js is older than this file renders without a pair view rather than throwing
// on the first click.
if (PAIR_READY) {
  globalThis.StewardPair = {mount: pairMount, update: pairUpdate, select: pairSelect, unmount: pairUnmount};
}

if (typeof module !== 'undefined') {
  module.exports = {
    PAIR_SCHEMA, kinshipAffinity, rankTier, sharedBuildsBetween, shareSplit,
    pairStanding, pairTagsForBuild, buildKinshipPair, pairRecordIsUnnamed,
  };
}
