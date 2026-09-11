'use strict';
// Pure model logic for the pair view. Run with: node --test tools/era-archive/tests/pair.logic.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const pair = require(path.join(__dirname, '..', 'web', 'pair.js'));

const ANCHOR = 'a'.repeat(32);
const ALLY = 'b'.repeat(32);
const OTHER = 'c'.repeat(32);

// Build keys are 64 hex in the real archive; the leading digit is what the tie-break
// sorts on, so they are spelled out rather than generated.
const BIG = '1'.repeat(64);
const TIE_A = '2'.repeat(64);
const TIE_B = '3'.repeat(64);
const TINY = '4'.repeat(64);
const ELSEWHERE = '5'.repeat(64);

const contributor = (builderKey, pieces, share) => ({builderKey, pieces, share, evidence: 'saved-pieces'});
// A historical import credits a leading contributor and knows no counts at all.
const legacyContributor = (builderKey) => ({builderKey, pieces: null, evidence: 'legacy-leading-contributor'});

function album(overrides) {
  return {
    slug: 'a-build',
    label: 'A build',
    pieces: 0,
    contributors: [],
    photos: [],
    attribution: 'Recorded from the saved world',
    worldUrl: '/world/?era=era7',
    terrainStatus: 'awaiting-runtime',
    galleryUrl: null,
    ...overrides,
  };
}

// One anchor, one ally, four shared builds: a big one with a third contributor and an
// unattributed remainder, two that tie on pieces, one of them a legacy import, and a
// single-piece build whose log10 weight is exactly zero.
function thread() {
  return {
    builderKey: ANCHOR,
    displayName: 'Helina',
    aliases: [],
    nameStatus: 'recorded',
    tier: 'gold',
    eras: [
      {
        era: 7,
        albums: [album({
          buildKey: BIG,
          era: 7,
          label: 'Great Hall',
          pieces: 1000,
          contributors: [contributor(ANCHOR, 500, 0.5), contributor(ALLY, 250, 0.25), contributor(OTHER, 200, 0.2)],
          photos: [
            {id: 'p1', thumb: '/chronicles/img/hall-t.jpg', large: '/chronicles/img/hall.jpg', href: '/gallery/hall', label: 'Great Hall from the water'},
            {id: 'p2', thumb: '/chronicles/img/hall2-t.jpg', large: '/chronicles/img/hall2.jpg', href: '/gallery/hall2', label: 'Great Hall roof line'},
          ],
          galleryUrl: '/gallery/hall',
        })],
      },
      {
        era: 8,
        albums: [
          album({
            buildKey: TIE_A,
            era: 8,
            label: 'Boat shed',
            pieces: 100,
            contributors: [contributor(ANCHOR, 50, 0.5), contributor(ALLY, 10, 0.1)],
          }),
          album({
            buildKey: TIE_B,
            era: 8,
            label: 'Old quarry',
            pieces: 100,
            contributors: [legacyContributor(ANCHOR), legacyContributor(ALLY)],
            worldUrl: null,
            terrainStatus: 'historical-gallery',
          }),
          // Not shared: the ally never placed a piece on it.
          album({
            buildKey: ELSEWHERE,
            era: 8,
            label: 'Lone tower',
            pieces: 400,
            contributors: [contributor(ANCHOR, 400, 1)],
          }),
        ],
      },
      {
        era: 12,
        albums: [album({
          buildKey: TINY,
          era: 12,
          label: 'Marker post',
          pieces: 1,
          contributors: [contributor(ANCHOR, 1, 1), contributor(ALLY, 1, 1)],
          photoStatus: 'rejected',
        })],
      },
    ],
  };
}

const DIRECTORY = {
  [ALLY]: {builderKey: ALLY, displayName: 'Tugcow', nameStatus: 'recorded', tier: 'silver'},
  [OTHER]: {builderKey: OTHER, displayName: 'Builder cccccccc', nameStatus: 'ambiguous'},
};
const builderFor = (key) => DIRECTORY[key] || null;

const tag = (buildKey, builderKey, contributorKey, tags) => ({buildKey, builderKey, contributorKey, tags, confirmedAt: '2026-09-01T00:00:00Z'});

test('pair.js exports the model the profile page is coded against', () => {
  for (const name of ['kinshipAffinity', 'rankTier', 'sharedBuildsBetween', 'shareSplit',
    'pairStanding', 'pairTagsForBuild', 'buildKinshipPair']) {
    assert.equal(typeof pair[name], 'function', `${name} is exported`);
  }
  assert.equal(pair.PAIR_SCHEMA, 'steward-kinship-pair/v1');
});

/* ---- affinity ---- */

test('affinity weights the smaller share by log10 of the build', () => {
  // 0.25 * log10(1000) + 0.1 * log10(100) + legacy 0 + single-piece 0
  assert.equal(pair.kinshipAffinity(thread(), ALLY), 0.95);
});

test('a legacy album contributes nothing to affinity rather than a guess', () => {
  const only = {
    builderKey: ANCHOR,
    eras: [{era: 8, albums: [album({
      buildKey: TIE_B, era: 8, pieces: 100,
      contributors: [legacyContributor(ANCHOR), legacyContributor(ALLY)],
    })]}],
  };
  assert.equal(pair.kinshipAffinity(only, ALLY), 0);
});

test('a one-piece build scores zero because log10(1) is zero', () => {
  const only = {
    builderKey: ANCHOR,
    eras: [{era: 12, albums: [album({
      buildKey: TINY, era: 12, pieces: 1,
      contributors: [contributor(ANCHOR, 1, 1), contributor(ALLY, 1, 1)],
    })]}],
  };
  assert.equal(pair.kinshipAffinity(only, ALLY), 0);
});

test('affinity is zero for a builder who never built beside this one, and for the anchor itself', () => {
  assert.equal(pair.kinshipAffinity(thread(), 'f'.repeat(32)), 0);
  assert.equal(pair.kinshipAffinity(thread(), ANCHOR), 0);
});

/* ---- ranking ---- */

test('rankTier bands the first eight places and nothing outside them', () => {
  assert.equal(pair.rankTier(0), null);
  assert.equal(pair.rankTier(1), 'I');
  assert.equal(pair.rankTier(2), 'I');
  assert.equal(pair.rankTier(3), 'II');
  assert.equal(pair.rankTier(5), 'II');
  assert.equal(pair.rankTier(6), 'III');
  assert.equal(pair.rankTier(8), 'III');
  assert.equal(pair.rankTier(9), null);
  assert.equal(pair.rankTier(null), null);
});

/* ---- shared builds ---- */

test('sharedBuildsBetween is biggest first, then the build key', () => {
  const keys = pair.sharedBuildsBetween(thread(), ALLY).map((a) => a.buildKey);
  assert.deepEqual(keys, [BIG, TIE_A, TIE_B, TINY]);
});

test('sharedBuildsBetween skips a build only one of them touched', () => {
  const keys = pair.sharedBuildsBetween(thread(), ALLY).map((a) => a.buildKey);
  assert.equal(keys.includes(ELSEWHERE), false);
});

/* ---- the allotment ---- */

test('shareSplit accounts for every piece, pair first, with the remainder unattributed', () => {
  const big = pair.sharedBuildsBetween(thread(), ALLY)[0];
  const split = pair.shareSplit(big, [ANCHOR, ALLY]);
  assert.deepEqual(split.segments.map((s) => s.builderKey), [ANCHOR, ALLY, OTHER]);
  assert.deepEqual(split.segments.map((s) => s.pair), [true, true, false]);
  const credited = split.segments.reduce((sum, s) => sum + s.pieces, 0);
  assert.equal(credited + split.unattributed.pieces, big.pieces);
  assert.equal(split.unattributed.pieces, 50);
  assert.equal(split.unattributed.share, 0.05);
  assert.equal(split.legacy, false);
});

test('shareSplit flags a legacy import instead of inventing shares for it', () => {
  const legacy = pair.sharedBuildsBetween(thread(), ALLY).find((a) => a.buildKey === TIE_B);
  const split = pair.shareSplit(legacy, [ANCHOR, ALLY]);
  assert.equal(split.legacy, true);
  assert.deepEqual(split.segments.map((s) => s.pieces), [0, 0]);
  // Nothing is credited, so the whole build is the unattributed remainder.
  assert.equal(split.unattributed.pieces, 100);
});

/* ---- standing ---- */

test('pairStanding reads a confirmed tag in either direction', () => {
  const shared = [BIG, TIE_A];
  assert.equal(pair.pairStanding([tag(BIG, ANCHOR, ALLY, ['basemate'])], ANCHOR, ALLY, shared), 'confirmed');
  assert.equal(pair.pairStanding([tag(BIG, ALLY, ANCHOR, ['basemate'])], ANCHOR, ALLY, shared), 'confirmed');
});

test('a confirmed tag on a build they do not share leaves them recorded', () => {
  const shared = [BIG, TIE_A];
  assert.equal(pair.pairStanding([tag(ELSEWHERE, ANCHOR, ALLY, ['basemate'])], ANCHOR, ALLY, shared), 'recorded');
  assert.equal(pair.pairStanding([], ANCHOR, ALLY, shared), 'recorded');
  // A tag between the anchor and a third builder says nothing about this pair.
  assert.equal(pair.pairStanding([tag(BIG, ANCHOR, OTHER, ['mason'])], ANCHOR, ALLY, shared), 'recorded');
});

test('pairTagsForBuild separates what each of them wears, confirmed from pending', () => {
  const local = {[`${BIG}:${ALLY}`]: {buildKey: BIG, contributorKey: ALLY, tags: ['roof', 'basemate']}};
  const worn = pair.pairTagsForBuild([tag(BIG, ANCHOR, ALLY, ['basemate'])], local, BIG, ANCHOR, ALLY);
  assert.deepEqual(worn.allyWears.confirmed, ['basemate']);
  // 'basemate' has arrived, so it is no longer pending.
  assert.deepEqual(worn.allyWears.pending, ['roof']);
  assert.deepEqual(worn.anchorWears, {confirmed: [], pending: []});
});

/* ---- the whole model ---- */

const model = (options = {}) => pair.buildKinshipPair(thread(), ALLY, {builderFor, ...options});

test('buildKinshipPair opens on the largest shared build', () => {
  const built = model();
  assert.equal(built.schema, 'steward-kinship-pair/v1');
  assert.equal(built.activeBuild.buildKey, BIG);
  assert.equal(built.activeBuild.photos.length, 2);
  assert.equal(built.activeBuild.allotment.unattributed.pieces, 50);
  assert.equal(built.sharedBuildCount, 4);
  // min(500,250) + min(50,10) + legacy 0 + min(1,1)
  assert.equal(built.sharedPieces, 261);
  assert.deepEqual(built.eras, [7, 8, 12]);
  assert.equal(built.photographedCount, 1);
  assert.equal(built.affinity, 0.95);
  assert.equal(built.standing, 'recorded');
  assert.equal(built.ally.displayName, 'Tugcow');
  assert.equal(built.ally.named, true);
  assert.equal(built.anchor.displayName, 'Helina');
});

test('buildKinshipPair honours an activeBuildKey and falls back from an unknown one', () => {
  assert.equal(model({activeBuildKey: TINY}).activeBuild.buildKey, TINY);
  assert.equal(model({activeBuildKey: ELSEWHERE}).activeBuild.buildKey, BIG);
  assert.equal(model({activeBuildKey: 'not-a-build'}).activeBuild.buildKey, BIG);
});

test('buildKinshipPair returns null when the two of them share nothing', () => {
  assert.equal(pair.buildKinshipPair(thread(), 'f'.repeat(32), {builderFor}), null);
  assert.equal(pair.buildKinshipPair(thread(), null, {builderFor}), null);
  assert.equal(pair.buildKinshipPair(null, ALLY, {builderFor}), null);
});

test('buildKinshipPair ranks the ally and tiers only the first eight', () => {
  assert.equal(model().rank, 1);
  assert.equal(model().tier, 'I');
});

test('buildKinshipPair gives a co-builder outside the Top 8 a rank and no tier', () => {
  // Nine co-builders above the ally on shared pieces, so the ally lands at rank 10.
  const crowd = thread();
  const filler = [];
  for (let i = 0; i < 9; i += 1) {
    const key = String.fromCharCode(97 + i).repeat(32).slice(0, 31) + '9';
    filler.push(contributor(key, 400, 0.4));
  }
  crowd.eras[0].albums[0].contributors.push(...filler);
  const built = pair.buildKinshipPair(crowd, ALLY, {builderFor});
  assert.equal(built.rank, 10);
  assert.equal(built.tier, null);
  // rank is only ever null for a key the ranking does not name at all, and a key with no
  // shared build never reaches this far -- the model is null before it can be ranked.
  assert.equal(pair.rankTier(built.rank), null);
});

test('buildKinshipPair counts a confirmed tag and raises the pair to confirmed kin', () => {
  const built = model({confirmedTags: [tag(BIG, ANCHOR, ALLY, ['basemate', 'mason'])]});
  assert.equal(built.standing, 'confirmed');
  assert.equal(built.confirmedTagCount, 2);
  assert.deepEqual(built.activeBuild.tags.allyWears.confirmed, ['basemate', 'mason']);
});

test('buildKinshipPair reads ownership and the legacy flag onto every row', () => {
  const rows = model().sharedBuilds;
  const big = rows.find((r) => r.buildKey === BIG);
  assert.equal(big.anchorOwnership, 'majority');
  assert.equal(big.allyOwnership, null);
  assert.equal(big.contributorCount, 3);
  assert.equal(big.legacy, false);
  assert.equal(big.photographed, true);
  assert.equal(big.photoCount, 2);
  const legacy = rows.find((r) => r.buildKey === TIE_B);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.anchorShare, null);
  assert.equal(legacy.anchorOwnership, null);
  assert.equal(legacy.terrainStatus, 'historical-gallery');
  assert.equal(legacy.worldUrl, null);
  const tiny = rows.find((r) => r.buildKey === TINY);
  assert.equal(tiny.photographed, false);
  assert.equal(tiny.photoStatus, 'rejected');
});

test('buildKinshipPair passes residents through only when the album publishes them', () => {
  assert.equal(model().activeBuild.residents, null);
  const withBeds = thread();
  withBeds.eras[0].albums[0].residents = [{builderKey: ALLY, beds: 2, evidence: 'bed-residency'}];
  const built = pair.buildKinshipPair(withBeds, ALLY, {builderFor});
  assert.deepEqual(built.activeBuild.residents, [{builderKey: ALLY, beds: 2, evidence: 'bed-residency'}]);
  assert.equal(built.sharedBuilds.find((r) => r.buildKey === TINY).residents, null);
});

test('buildKinshipPair marks an unresolved directory record as unnamed', () => {
  const built = pair.buildKinshipPair(thread(), OTHER, {builderFor});
  assert.equal(built.ally.named, false);
  // No record at all is a page still loading, not a fact about a person.
  assert.equal(pair.buildKinshipPair(thread(), ALLY, {builderFor: () => null}).ally.named, true);
});

test('buildKinshipPair publishes nothing the thread does not already state', () => {
  const built = model({confirmedTags: [tag(BIG, ANCHOR, ALLY, ['basemate'])]});
  const serialised = JSON.stringify(built);
  assert.equal(/character|coordinate|seed|\bx\b|\bz\b/i.test(serialised), false);
});
