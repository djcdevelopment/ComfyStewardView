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

if (typeof module !== 'undefined') {
  module.exports = {
    PAIR_SCHEMA, kinshipAffinity, rankTier, sharedBuildsBetween, shareSplit,
    pairStanding, pairTagsForBuild, buildKinshipPair, pairRecordIsUnnamed,
  };
}

/**
 * The view half, `globalThis.StewardPair`, lands in the next commit against exactly
 * these four signatures:
 *
 *   mount(host, ctx)  Fill `section#pair-view` and show it. Unmounts any prior instance
 *                     first. Opens on `ctx.initial.kin` when that key is a co-builder,
 *                     otherwise on rank 1; leaves the host hidden and returns when the
 *                     anchor has no co-builder at all. Writes kin/build/view into the URL
 *                     with history.replaceState, keeping every other param and the hash.
 *   select(key)       Same key as the open pair collapses it (host hidden, params gone);
 *                     another co-builder switches the pair and resets the active build to
 *                     that pair's largest; anything else is ignored. Returns the newly
 *                     active key, or null for a collapse and for an ignored key. Fires a
 *                     bubbling `pair:change` CustomEvent on the host with
 *                     `{detail: {ally, build, view}}`; the Top 8 ribbon listens for that
 *                     and sets its own aria-pressed.
 *   update(patch)     `{confirmedTags}` repaints the laurels, the standing badge, the
 *                     ledger status column and the sidebar tag count; `{names: true}`
 *                     rewrites every `[data-pair-name-key]`; `{portraits}` swaps every
 *                     `[data-pair-portrait-key]` tile. Patches regions, never rebuilds
 *                     the section, so focus and scroll survive. A no-op before mount.
 *   unmount()         Drops the listeners and empties the host.
 */
