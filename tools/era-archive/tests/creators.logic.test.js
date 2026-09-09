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
