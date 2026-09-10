// Pure-logic regression coverage for the Chronicler Archive redesign additions
// (sort modes, filter composition, hero-stat aggregation, signature-album picking).
// Uses Node's built-in test runner -- no new dependency. Run with:
//   node --test tools/era-archive/tests/creators.logic.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  SORT_MODES, filterBuilders, computeHeroStats, pickSignatureAlbums, compareBuilders, matchScore,
  computeTopEight, portraitIndex, eraBounds, heroAliases,
} = require(path.join(__dirname, '..', 'web', 'creators.js'));

function builder(overrides) {
  return {
    builderKey: '0'.repeat(32),
    displayName: 'Test Builder',
    aliases: [],
    nameStatus: 'recorded',
    eras: [7],
    albums: 1,
    photos: 0,
    pieces: 0,
    tier: 'Explorer',
    ...overrides,
  };
}

test('SORT_MODES.photos orders by photo count, descending, tie-broken by builderKey', () => {
  const a = builder({builderKey: 'b'.repeat(32), photos: 5});
  const b = builder({builderKey: 'a'.repeat(32), photos: 5});
  const c = builder({builderKey: 'c'.repeat(32), photos: 9});
  const sorted = [a, b, c].sort((x, y) => SORT_MODES.photos.compare(x, y, ''));
  assert.deepEqual(sorted.map((x) => x.builderKey), [c.builderKey, b.builderKey, a.builderKey]);
});

test('SORT_MODES.az orders case-insensitively, tie-broken by builderKey', () => {
  const a = builder({builderKey: 'b'.repeat(32), displayName: 'apple'});
  const b = builder({builderKey: 'a'.repeat(32), displayName: 'Apple'});
  const sorted = [a, b].sort((x, y) => SORT_MODES.az.compare(x, y, ''));
  assert.deepEqual(sorted.map((x) => x.builderKey), [b.builderKey, a.builderKey]);
});

test('SORT_MODES.albums orders by album count, descending', () => {
  const a = builder({builderKey: 'a'.repeat(32), albums: 3});
  const b = builder({builderKey: 'b'.repeat(32), albums: 30});
  const sorted = [a, b].sort((x, y) => SORT_MODES.albums.compare(x, y, ''));
  assert.equal(sorted[0].builderKey, b.builderKey);
});

test('every new sort mode still lets an active search query win first', () => {
  const exact = builder({builderKey: 'a'.repeat(32), displayName: 'Astrid', photos: 0, albums: 0});
  const other = builder({builderKey: 'b'.repeat(32), displayName: 'Zorg', photos: 999, albums: 999});
  for (const mode of ['photos', 'az', 'albums']) {
    const sorted = [other, exact].sort((x, y) => SORT_MODES[mode].compare(x, y, 'astrid'));
    assert.equal(sorted[0].builderKey, exact.builderKey, `mode=${mode} should rank the exact name match first`);
  }
});

test('filterBuilders composes era, With Albums, and search independently', () => {
  const builders = [
    builder({builderKey: 'a'.repeat(32), displayName: 'Astrid', eras: [7], albums: 2}),
    builder({builderKey: 'b'.repeat(32), displayName: 'Bjorn', eras: [8], albums: 0}),
    builder({builderKey: 'c'.repeat(32), displayName: 'Charlie', eras: [7], albums: 0}),
  ];
  assert.deepEqual(filterBuilders(builders, {}).map((b) => b.builderKey), ['a', 'b', 'c'].map((c) => c.repeat(32)));
  assert.deepEqual(filterBuilders(builders, {era: '7'}).map((b) => b.builderKey), ['a', 'c'].map((c) => c.repeat(32)));
  assert.deepEqual(filterBuilders(builders, {withAlbums: true}).map((b) => b.builderKey), ['a'.repeat(32)]);
  assert.deepEqual(filterBuilders(builders, {era: '7', query: 'char'}).map((b) => b.builderKey), ['c'.repeat(32)]);
});

test('computeHeroStats uses photography.photos, not a sum over builders (avoids double-counting shared albums)', () => {
  const directory = {
    builders: [
      builder({builderKey: 'a'.repeat(32), eras: [7, 8], photos: 5}),
      builder({builderKey: 'b'.repeat(32), eras: [8, 16], photos: 5}),
    ],
    photography: {photos: 6, buildersWithPhotos: 2},
  };
  const hero = computeHeroStats(directory);
  assert.equal(hero.captures, 6, 'must read the authoritative photography.photos total, not sum(builder.photos)=10');
  assert.equal(hero.builders, 2);
  assert.equal(hero.populatedEras, 3, 'union of every builder eras[]: {7,8,16}');
});

test('pickSignatureAlbums skips gallery.py auto-generated labels and favors larger builds', () => {
  const thread = {
    eras: [
      {era: 7, albums: [
        {buildKey: 'z', label: 'Build 0a1b2c3d', pieces: 9999},
        {buildKey: 'y', label: 'Fortress of Dawn', pieces: 10},
        {buildKey: 'x', label: 'Longhouse of Embers', pieces: 500},
      ]},
    ],
  };
  const picks = pickSignatureAlbums(thread, 2);
  assert.deepEqual(picks.map((a) => a.label), ['Longhouse of Embers', 'Fortress of Dawn']);
});

test('pickSignatureAlbums returns nothing for a builder with no titled albums (truthful empty state)', () => {
  const thread = {eras: [{era: 7, albums: [{buildKey: 'z', label: 'Build deadbeef', pieces: 500}]}]};
  assert.deepEqual(pickSignatureAlbums(thread), []);
});

test('existing default comparator (compareBuilders) is untouched: photographed named builders lead unphotographed placeholders', () => {
  const photographed = builder({builderKey: 'a'.repeat(32), displayName: 'Astrid', photos: 1});
  const placeholder = builder({builderKey: 'b'.repeat(32), displayName: 'Builder 8014fa60', photos: 0, albums: 99999});
  const sorted = [placeholder, photographed].sort((x, y) => compareBuilders(x, y, ''));
  assert.equal(sorted[0].builderKey, photographed.builderKey);
});

test('existing matchScore ranks exact match above prefix above substring', () => {
  const q = 'ast';
  assert.equal(matchScore(builder({displayName: 'ast'}), q), 0);
  assert.equal(matchScore(builder({displayName: 'astrid'}), q), 1);
  assert.equal(matchScore(builder({displayName: 'vaast'}), q), 2);
});

// --- Top 8 -----------------------------------------------------------------------
// The MySpace panel on a builder page: who this builder actually built beside.

function album(buildKey, contributors) {
  return {buildKey, era: 7, slug: 'era7', label: 'Build ' + buildKey, pieces: 100, contributors, photos: []};
}

const SELF = 'a'.repeat(32);
const BIG = 'b'.repeat(32);
const MID = 'c'.repeat(32);
const SMALL = 'd'.repeat(32);

test('computeTopEight ranks co-builders by shared pieces, then shared albums', () => {
  const thread = {
    builderKey: SELF,
    eras: [
      {era: 7, albums: [
        album('1', [{builderKey: SELF, pieces: 500}, {builderKey: BIG, pieces: 9000}, {builderKey: MID, pieces: 40}]),
        album('2', [{builderKey: SELF, pieces: 300}, {builderKey: MID, pieces: 30}]),
      ]},
      {era: 8, albums: [
        album('3', [{builderKey: SELF, pieces: 20}, {builderKey: SMALL, pieces: 20}]),
      ]},
    ],
  };
  const top = computeTopEight(thread);
  // BIG: min(500, 9000) = 500 over one album. MID: min(500,40) + min(300,30) = 70 over two.
  // SMALL: min(20, 20) = 20 over one.
  assert.deepEqual(top, [
    {builderKey: BIG, sharedAlbums: 1, sharedPieces: 500},
    {builderKey: MID, sharedAlbums: 2, sharedPieces: 70},
    {builderKey: SMALL, sharedAlbums: 1, sharedPieces: 20},
  ]);
});

test('computeTopEight caps the panel at eight and never lists the builder themselves', () => {
  const others = Array.from({length: 12}, (_, i) => String(i).padStart(32, 'e'));
  const thread = {
    builderKey: SELF,
    eras: [{era: 7, albums: others.map((key, i) => album('k' + i, [
      {builderKey: SELF, pieces: 1000},
      {builderKey: key, pieces: (i + 1) * 10},
    ]))}],
  };
  const top = computeTopEight(thread);
  assert.equal(top.length, 8);
  assert.equal(top[0].sharedPieces, 120, 'highest co-contribution leads');
  assert.ok(!top.some((t) => t.builderKey === SELF), 'the builder is never their own co-builder');
});

test('computeTopEight counts a legacy contributor (pieces: null) as a shared album worth zero pieces', () => {
  const thread = {
    builderKey: SELF,
    eras: [{era: 16, albums: [
      {buildKey: 'legacy', era: 16, label: 'Import', pieces: null, photos: [], contributors: [
        {builderKey: SELF, pieces: null, evidence: 'legacy-leading-contributor'},
        {builderKey: BIG, pieces: null, evidence: 'legacy-leading-contributor'},
      ]},
    ]}],
  };
  assert.deepEqual(computeTopEight(thread), [{builderKey: BIG, sharedAlbums: 1, sharedPieces: 0}]);
});

test('computeTopEight breaks a full tie on builderKey so the panel does not reshuffle', () => {
  const thread = {
    builderKey: SELF,
    eras: [{era: 7, albums: [
      album('1', [{builderKey: SELF, pieces: 50}, {builderKey: MID, pieces: 50}, {builderKey: BIG, pieces: 50}]),
    ]}],
  };
  assert.deepEqual(computeTopEight(thread).map((t) => t.builderKey), [BIG, MID]);
});

test('computeTopEight returns nothing for a solo builder, so the panel can hide itself', () => {
  const solo = {builderKey: SELF, eras: [{era: 7, albums: [album('1', [{builderKey: SELF, pieces: 724}])]}]};
  assert.deepEqual(computeTopEight(solo), []);
  assert.deepEqual(computeTopEight(null), []);
  assert.deepEqual(computeTopEight({builderKey: SELF, eras: []}), []);
});

test('computeTopEight survives an album with no contributors array', () => {
  const thread = {builderKey: SELF, eras: [{era: 7, albums: [{buildKey: 'x', label: 'x', pieces: 1, photos: []}]}]};
  assert.deepEqual(computeTopEight(thread), []);
});

// --- Hero card -------------------------------------------------------------------
// The profile card at the top of a builder page: which portrait tile, which era span,
// which other names, which builds are worth naming.

test('portraitIndex is the first 32 bits of the builder key modulo the tile count', () => {
  // Tugcow: 0x5897d38e = 1,486,345,102; 1486345102 % 48 = 46.
  assert.equal(portraitIndex('5897d38e2a065e36a6895e70a2194738'), 46);
  assert.equal(portraitIndex('0'.repeat(32)), 0);
  // The count comes from the manifest, so a resized tile set reassigns deterministically.
  assert.equal(portraitIndex('5897d38e2a065e36a6895e70a2194738', 12), 1486345102 % 12);
  // Same key, same face, every render -- that is the whole point of a hash assignment.
  assert.equal(
    portraitIndex('17a1605b1fdb58c68c6334e49e2b0b74'),
    portraitIndex('17a1605b1fdb58c68c6334e49e2b0b74'),
  );
  // A manifest that names no tiles must not produce NaN as an array index.
  assert.equal(portraitIndex('5897d38e2a065e36a6895e70a2194738', 0), 0);
  assert.equal(portraitIndex(undefined), 0);
});

test('eraBounds spans the thread eras regardless of the order they are stored in', () => {
  const thread = {eras: [{era: 12, albums: []}, {era: 7, albums: []}, {era: 9, albums: []}]};
  assert.deepEqual(eraBounds(thread), {first: 7, latest: 12});
  // A single era is both ends of its own span.
  assert.deepEqual(eraBounds({eras: [{era: 16, albums: []}]}), {first: 16, latest: 16});
  // Nothing to bound: the hero card omits both rows rather than printing "Era null".
  assert.deepEqual(eraBounds({eras: []}), {first: null, latest: null});
  assert.deepEqual(eraBounds(null), {first: null, latest: null});
});

test('heroAliases drops the display name, dedupes case-insensitively, and counts the overflow', () => {
  const thread = {
    displayName: 'Tugcow',
    aliases: ['tugcow', 'TugCow', 'Tug', 'Cowherd', 'Bessie', 'Moo', 'Daisy'],
  };
  const {shown, more} = heroAliases(thread);
  assert.deepEqual(shown, ['Tug', 'Cowherd', 'Bessie', 'Moo'], 'every casing of the display name is the display name');
  assert.equal(more, 1, 'Daisy is the seventh alias and the only one past the first four');
});

test('heroAliases returns an empty panel for a builder with no other names', () => {
  assert.deepEqual(heroAliases({displayName: 'Solo', aliases: []}), {shown: [], more: 0});
  assert.deepEqual(heroAliases({displayName: 'Solo', aliases: ['SOLO', '  ', null]}), {shown: [], more: 0});
  assert.deepEqual(heroAliases(null), {shown: [], more: 0});
});

test('the hero reuses pickSignatureAlbums, asked for three instead of the directory card two', () => {
  const thread = {
    eras: [
      {era: 7, albums: [
        {buildKey: 'z', label: 'Build 0a1b2c3d', pieces: 90000},
        {buildKey: 'y', label: 'Fortress of Dawn', pieces: 10},
        {buildKey: 'x', label: 'Longhouse of Embers', pieces: 500},
      ]},
      {era: 12, albums: [
        {buildKey: 'w', label: 'Harbour Gate', pieces: 1204},
      ]},
    ],
  };
  // Same rule, one more slot: auto-labels out, largest first, across every era block.
  assert.deepEqual(
    pickSignatureAlbums(thread, 3).map((a) => a.label),
    ['Harbour Gate', 'Longhouse of Embers', 'Fortress of Dawn'],
  );
  assert.deepEqual(pickSignatureAlbums(thread, 2).map((a) => a.label), ['Harbour Gate', 'Longhouse of Embers']);
  assert.deepEqual(pickSignatureAlbums({eras: []}, 3), []);
});
