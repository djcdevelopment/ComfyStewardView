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
  majorityOwner, buildKinshipTree, mergeKinshipTags, kinshipTagRecord, StewardParticipation,
  KINSHIP_TAG_IDS,
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

// `residents` is optional and defaults to absent, exactly as gallery.py leaves it on an
// album with none -- so every test above this line keeps asserting against the shape a
// pre-residency projection produces.
function album(buildKey, contributors, residents) {
  const record = {buildKey, era: 7, slug: 'era7', label: 'Build ' + buildKey, pieces: 100, contributors, photos: []};
  if (residents) record.residents = residents;
  return record;
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

// ---------------------------------------------------------------------------
// Kinship: the branching tree, who owns a build, and the local participation store.
// ---------------------------------------------------------------------------

const ANCHOR = 'a'.repeat(32);
const CO_X = 'b'.repeat(32);
const CO_Y = 'c'.repeat(32);
const CO_Z = 'd'.repeat(32);
const CO_W = 'e'.repeat(32);
const BUILD_LEGACY = '1'.repeat(64);
const BUILD_E9 = '2'.repeat(64);
const BUILD_E7_CROWD = '3'.repeat(64);
const BUILD_E7_PAIR = '4'.repeat(64);

// Era blocks arrive newest-first, exactly as gallery.py writes a thread file. A legacy
// import carries `pieces: null` and no `share` key at all.
function kinshipThread() {
  return {
    builderKey: ANCHOR,
    displayName: 'Skald',
    eras: [
      {era: 16, albums: [
        {buildKey: BUILD_LEGACY, era: 16, label: 'Gallery import', pieces: 0, photos: [{id: 'p1'}],
         worldUrl: null,
         contributors: [
           {builderKey: ANCHOR, pieces: null, evidence: 'legacy-leading-contributor'},
           {builderKey: CO_Y, pieces: null, evidence: 'legacy-leading-contributor'},
         ]},
      ]},
      {era: 9, albums: [
        {buildKey: BUILD_E9, era: 9, label: 'Great Hall', pieces: 500, photos: [], worldUrl: 'https://w/?b=9',
         contributors: [
           {builderKey: ANCHOR, pieces: 300, share: 0.6},
           {builderKey: CO_X, pieces: 200, share: 0.4},
         ]},
      ]},
      {era: 7, albums: [
        {buildKey: BUILD_E7_CROWD, era: 7, label: 'Harbour', pieces: 1000, photos: [], worldUrl: 'https://w/?b=7a',
         contributors: [
           {builderKey: ANCHOR, pieces: 200, share: 0.2},
           {builderKey: CO_X, pieces: 300, share: 0.3},
           {builderKey: CO_Z, pieces: 250, share: 0.25},
           {builderKey: CO_W, pieces: 250, share: 0.25},
         ]},
        {buildKey: BUILD_E7_PAIR, era: 7, label: 'Smithy', pieces: 100, photos: [], worldUrl: 'https://w/?b=7b',
         contributors: [
           {builderKey: ANCHOR, pieces: 60, share: 0.6},
           {builderKey: CO_X, pieces: 40, share: 0.4},
         ]},
      ]},
    ],
  };
}

const branchFor = (tree, key) => tree.branches.find((b) => b.builderKey === key);

test('majorityOwner reads ownership off the saved shares and nothing else', () => {
  const half = {contributors: [{builderKey: ANCHOR, share: 0.5}, {builderKey: CO_X, share: 0.5}]};
  assert.equal(majorityOwner(half, ANCHOR), 'majority', 'half is enough');
  const strictlyLargest = {contributors: [
    {builderKey: ANCHOR, share: 0.3}, {builderKey: CO_X, share: 0.25}, {builderKey: CO_Z, share: 0.25},
  ]};
  assert.equal(majorityOwner(strictlyLargest, ANCHOR), 'largest');
  const tie = {contributors: [
    {builderKey: ANCHOR, share: 0.3}, {builderKey: CO_X, share: 0.3}, {builderKey: CO_Z, share: 0.2},
  ]};
  assert.equal(majorityOwner(tie, ANCHOR), null, 'a tie has no owner');
  const tooSmall = {contributors: [{builderKey: ANCHOR, share: 0.2}, {builderKey: CO_X, share: 0.15}]};
  assert.equal(majorityOwner(tooSmall, ANCHOR), null, 'largest still needs a quarter of the build');
  const legacy = {contributors: [{builderKey: ANCHOR, pieces: null, evidence: 'legacy-leading-contributor'}]};
  assert.equal(majorityOwner(legacy, ANCHOR), null, 'a legacy import states no share, so it owns nothing');
  assert.equal(majorityOwner({contributors: [{builderKey: CO_X, share: 1}]}, ANCHOR), null, 'absent');
  assert.equal(majorityOwner(null, ANCHOR), null);
});

test('buildKinshipTree spans a co-builder across every era they appear in', () => {
  const tree = buildKinshipTree(kinshipThread());
  assert.equal(tree.anchor.builderKey, ANCHOR);
  assert.equal(tree.anchor.displayName, 'Skald');
  assert.deepEqual(tree.anchor.eras, [7, 9, 16], 'the anchor states its own eras ascending');
  assert.deepEqual(tree.eras, [7, 9, 16], 'every era block on the thread, ascending');
  assert.equal(tree.coBuilderCount, 4);

  const x = branchFor(tree, CO_X);
  assert.deepEqual(x.spans.map((s) => s.era), [7, 9], 'spans run ascending, one per era');
  assert.equal(x.firstEra, 7);
  assert.equal(x.lastEra, 9);
  // era 7: min(200,300) on the crowded build + min(60,40) on the pair; era 9: min(300,200).
  assert.deepEqual(x.spans[0], {
    era: 7, sharedAlbums: 2, sharedPieces: 240, legacy: false, anchorMajority: true,
    builds: [BUILD_E7_CROWD, BUILD_E7_PAIR],
  });
  assert.deepEqual(x.spans[1], {
    era: 9, sharedAlbums: 1, sharedPieces: 200, legacy: false, anchorMajority: true,
    builds: [BUILD_E9],
  });
  assert.equal(x.totalSharedAlbums, 3);
  assert.equal(x.totalSharedPieces, 440);
  assert.equal(x.legacyOnly, false);
});

test('buildKinshipTree keeps a legacy-only branch, worth an album and no pieces', () => {
  const tree = buildKinshipTree(kinshipThread());
  const y = branchFor(tree, CO_Y);
  assert.equal(y.legacyOnly, true);
  assert.equal(y.totalSharedAlbums, 1);
  assert.equal(y.totalSharedPieces, 0, 'a legacy contributor adds no pieces to the overlap');
  assert.equal(y.spans.length, 1);
  assert.equal(y.spans[0].legacy, true);
  assert.equal(y.spans[0].anchorMajority, false, 'nobody owns a build with no shares on it');
  assert.deepEqual(y.spans[0].builds, [BUILD_LEGACY]);
});

test('buildKinshipTree ranks on shared pieces, then albums, then the key', () => {
  const tree = buildKinshipTree(kinshipThread());
  assert.deepEqual(tree.branches.map((b) => b.builderKey), [CO_X, CO_Z, CO_W, CO_Y]);
  // CO_Z and CO_W tie exactly -- one album, min(200, 250) pieces each -- so the full
  // 32-hex key decides, and the order is fixed between renders instead of reshuffling.
  assert.equal(branchFor(tree, CO_Z).totalSharedPieces, branchFor(tree, CO_W).totalSharedPieces);
  assert.equal(branchFor(tree, CO_Z).totalSharedAlbums, branchFor(tree, CO_W).totalSharedAlbums);
});

test('majorityBuilds is only what the anchor can speak for, largest first', () => {
  const tree = buildKinshipTree(kinshipThread());
  assert.deepEqual(tree.majorityBuilds.map((b) => b.buildKey), [BUILD_E9, BUILD_E7_PAIR]);
  assert.deepEqual(tree.majorityBuilds.map((b) => b.ownership), ['majority', 'majority']);
  assert.deepEqual(tree.majorityBuilds.map((b) => b.pieces), [500, 100]);
  assert.equal(tree.majorityBuilds[0].label, 'Great Hall');
  assert.equal(tree.majorityBuilds[0].era, 9);
  assert.equal(tree.majorityBuilds[0].worldUrl, 'https://w/?b=9');
  assert.equal(tree.majorityBuilds[0].contributors.length, 2);
  // A fifth of a four-way build is not standing to tag anybody on it.
  assert.equal(tree.majorityBuilds.some((b) => b.buildKey === BUILD_E7_CROWD), false);
  assert.equal(tree.majorityBuilds.some((b) => b.buildKey === BUILD_LEGACY), false);
});

test('buildKinshipTree folds confirmed and pending tags onto the branch they belong to', () => {
  const confirmedTags = [
    {builderKey: ANCHOR, contributorKey: CO_X, buildKey: BUILD_E9, tags: ['mason', 'basemate']},
    {builderKey: CO_X, contributorKey: CO_Y, buildKey: BUILD_E9, tags: ['visitor']},
  ];
  const localTags = {
    [`${BUILD_E9}:${CO_X}`]: {builderKey: ANCHOR, contributorKey: CO_X, buildKey: BUILD_E9, tags: ['basemate', 'roof']},
    [`${BUILD_E9}:${CO_Y}`]: {builderKey: CO_X, contributorKey: CO_Y, buildKey: BUILD_E9, tags: ['portal']},
  };
  const tree = buildKinshipTree(kinshipThread(), {confirmedTags, localTags});
  const x = branchFor(tree, CO_X);
  assert.deepEqual(x.tags.confirmed, ['basemate', 'mason']);
  assert.deepEqual(x.tags.pending, ['roof'], 'a pending tag that has been confirmed is not pending any more');
  // Both stray records name a different anchor and belong on that builder's own tree.
  assert.deepEqual(branchFor(tree, CO_Y).tags, {confirmed: [], pending: []});
});

test('buildKinshipTree returns an empty tree rather than throwing on a missing thread', () => {
  assert.deepEqual(buildKinshipTree(null),
    {anchor: null, eras: [], branches: [], majorityBuilds: [], coBuilderCount: 0});
  assert.deepEqual(buildKinshipTree(undefined).branches, []);
});

// --- Bed residency is not credit -------------------------------------------------
// A resident is somebody whose bed stands inside a build's footprint. That is evidence of
// sleeping there and nothing else -- so it must not reach anything that ranks a
// co-builder, draws a branch, or decides who may speak for a build. These assert the
// negative, because the failure mode is silent: a resident folded into contributors would
// simply look like a co-builder nobody could explain.

// A sleeper with one bed in the pair build and three in the crowd build, who never placed
// a piece anywhere and appears in no contributors list.
const SLEEPER = 'f'.repeat(32);

function threadWithResidents() {
  const thread = kinshipThread();
  const bed = (n) => [{builderKey: SLEEPER, beds: n, evidence: 'bed-owner-in-footprint'}];
  for (const block of thread.eras) {
    for (const album of block.albums) {
      if (album.buildKey === BUILD_E7_PAIR) album.residents = bed(1);
      if (album.buildKey === BUILD_E7_CROWD) album.residents = bed(3);
    }
  }
  return thread;
}

test('a resident who placed no pieces is never a Top 8 co-builder', () => {
  const thread = threadWithResidents();
  const top = computeTopEight(thread);
  assert.ok(!top.some((t) => t.builderKey === SLEEPER), 'sleeping beside someone is not building beside them');
  // And the panel is otherwise byte-for-byte the one the same thread produced without beds.
  assert.deepEqual(top, computeTopEight(kinshipThread()));
});

test('a resident draws no kinship branch and does not raise the co-builder count', () => {
  const tree = buildKinshipTree(threadWithResidents());
  assert.equal(branchFor(tree, SLEEPER), undefined, 'no branch for a bed');
  assert.equal(tree.coBuilderCount, buildKinshipTree(kinshipThread()).coBuilderCount);
  assert.deepEqual(tree.branches.map((b) => b.builderKey),
    buildKinshipTree(kinshipThread()).branches.map((b) => b.builderKey));
});

test('residents never move ownership: beds are not a share', () => {
  const withBeds = threadWithResidents();
  const pair = withBeds.eras.flatMap((e) => e.albums).find((a) => a.buildKey === BUILD_E7_PAIR);
  const crowd = withBeds.eras.flatMap((e) => e.albums).find((a) => a.buildKey === BUILD_E7_CROWD);
  // The anchor owns the pair build at 0.6 and owns nothing on the four-way crowd build.
  assert.equal(majorityOwner(pair, ANCHOR), 'majority');
  assert.equal(majorityOwner(crowd, ANCHOR), null);
  // Three beds in the crowd build buys the sleeper no standing over it either.
  assert.equal(majorityOwner(crowd, SLEEPER), null);
  assert.equal(majorityOwner(pair, SLEEPER), null);
});

test('an album with residents but no contributors array still computes to nothing', () => {
  const thread = {builderKey: ANCHOR, eras: [{era: 7, albums: [
    {buildKey: BUILD_E9, label: 'x', pieces: 1, photos: [],
     residents: [{builderKey: SLEEPER, beds: 2, evidence: 'bed-owner-in-footprint'}]},
  ]}]};
  assert.deepEqual(computeTopEight(thread), []);
  assert.deepEqual(buildKinshipTree(thread).branches, []);
});

test('mergeKinshipTags answers for one co-builder on one build', () => {
  const confirmed = [
    {buildKey: BUILD_E9, contributorKey: CO_X, tags: ['mason']},
    {buildKey: BUILD_E7_PAIR, contributorKey: CO_X, tags: ['roof']},
  ];
  const local = {
    a: {buildKey: BUILD_E9, contributorKey: CO_X, tags: ['mason', 'basemate']},
    b: {buildKey: BUILD_E9, contributorKey: CO_Y, tags: ['visitor']},
  };
  assert.deepEqual(mergeKinshipTags(confirmed, local, BUILD_E9, CO_X),
    {confirmed: ['mason'], pending: ['basemate']});
  assert.deepEqual(mergeKinshipTags(confirmed, local, BUILD_E9, CO_Y),
    {confirmed: [], pending: ['visitor']});
  assert.deepEqual(mergeKinshipTags([], {}, BUILD_E9, CO_X), {confirmed: [], pending: []});
});

test('kinshipTagRecord writes down the closed vocabulary and nothing else', () => {
  const record = kinshipTagRecord({
    buildKey: BUILD_E9, era: 9, builderKey: ANCHOR, contributorKey: CO_X,
    tags: ['roof', 'roof', 'basemate', 'nonsense', ''],
    note: 'x'.repeat(500), participant: '  Skald  ', claimId: 'claim-1',
  }, {id: 'kintag-fixed', now: '2026-09-10T00:00:00.000Z'});
  assert.deepEqual(record.tags, ['basemate', 'roof'], 'unknown ids dropped, duplicates folded, sorted');
  assert.equal(record.note.length, 200);
  assert.equal(record.participant, 'Skald');
  assert.equal(record.claimId, 'claim-1');
  assert.equal(record.tagId, 'kintag-fixed');
  assert.equal(record.createdAt, '2026-09-10T00:00:00.000Z');
  assert.equal(record.deliveryStatus, 'queued', 'nothing has left the browser yet');
  assert.equal(record.era, 9);
  assert.equal(kinshipTagRecord({tags: ['visitor'], participant: ''}).participant, 'Anonymous volunteer');
  assert.throws(
    () => kinshipTagRecord({buildKey: BUILD_E9, contributorKey: CO_X, tags: ['nonsense']}),
    /kinship tag needs at least one tag/,
  );
  assert.throws(() => kinshipTagRecord({buildKey: BUILD_E9, contributorKey: CO_X, tags: []}), /at least one tag/);
  for (const id of ['basemate', 'collab', 'helping-hand', 'visitor',
                    'mason', 'roof', 'fields', 'portal', 'defense', 'interior']) {
    assert.equal(KINSHIP_TAG_IDS.has(id), true, `${id} is part of the vocabulary`);
  }
  assert.equal(KINSHIP_TAG_IDS.size, 10);
});

// A storage object is all the store ever needs, so Node can drive the whole ledger.
function fakeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    raw: map,
  };
}

test('StewardParticipation.load refuses a ledger it does not recognise', () => {
  const KEY = StewardParticipation.STORAGE_KEY;
  const foreign = fakeStorage({[KEY]: JSON.stringify({schema: 'something-else/v9', claims: {x: 1}})});
  const state = StewardParticipation.load(foreign);
  assert.equal(state.schema, StewardParticipation.SCHEMA);
  assert.deepEqual(state.claims, {});
  assert.deepEqual(state.kinshipTags, {});
  assert.deepEqual(StewardParticipation.load(fakeStorage({[KEY]: 'not json'})).claims, {});
  assert.deepEqual(StewardParticipation.load(fakeStorage()).requests, {});
  // No storage at all is a private window, not an error.
  assert.deepEqual(StewardParticipation.load(undefined).kinshipTags, {});
});

test('StewardParticipation.load treats a pre-kinship ledger as a ledger with no tags', () => {
  const KEY = StewardParticipation.STORAGE_KEY;
  const old = {
    schema: StewardParticipation.SCHEMA,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    participant: 'Skald',
    claims: {[BUILD_E9]: {claimId: 'claim-1', buildKey: BUILD_E9, deliveryStatus: 'submitted'}},
    requests: {},
  };
  const state = StewardParticipation.load(fakeStorage({[KEY]: JSON.stringify(old)}));
  assert.equal(state.participant, 'Skald');
  assert.equal(state.createdAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(state.kinshipTags, {}, 'an older ledger is not a broken ledger');
  assert.equal(StewardParticipation.claimForBuild(state, BUILD_E9).claimId, 'claim-1');
});

test('StewardParticipation.save reports a storage that will not hold anything', () => {
  const storage = fakeStorage();
  const state = StewardParticipation.defaultState();
  state.participant = '  Skald ';
  assert.equal(StewardParticipation.save(state, storage), true);
  assert.equal(state.participant, 'Skald');
  assert.equal(JSON.parse(storage.raw.get(StewardParticipation.STORAGE_KEY)).participant, 'Skald');
  const refusing = {getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {}};
  assert.equal(StewardParticipation.save(StewardParticipation.defaultState(), refusing), false);
});

test('StewardParticipation.putKinshipTag never downgrades a delivered tag', () => {
  const state = StewardParticipation.defaultState();
  const first = kinshipTagRecord(
    {buildKey: BUILD_E9, era: 9, builderKey: ANCHOR, contributorKey: CO_X, tags: ['mason'], participant: 'Skald'},
    {id: 'kintag-first'});
  first.deliveryStatus = 'submitted';
  StewardParticipation.putKinshipTag(state, first);
  assert.deepEqual(Object.keys(state.kinshipTags), [`${BUILD_E9}:${CO_X}`], 'one tag per build per co-builder');

  const second = kinshipTagRecord(
    {buildKey: BUILD_E9, era: 9, builderKey: ANCHOR, contributorKey: CO_X, tags: ['roof'], participant: 'Skald'},
    {id: 'kintag-second'});
  StewardParticipation.putKinshipTag(state, second);
  const stored = StewardParticipation.tagFor(state, BUILD_E9, CO_X);
  assert.equal(stored.tagId, 'kintag-second');
  assert.deepEqual(stored.tags, ['roof']);
  assert.equal(stored.deliveryStatus, 'submitted', 'a re-tag must not forget that one was delivered');
  assert.equal(stored.resubmittedFrom, 'kintag-first');
  assert.equal(StewardParticipation.tagFor(state, BUILD_E9, CO_Y), null);
  assert.deepEqual(StewardParticipation.tagsForBuild(state, BUILD_E9).map((t) => t.tagId), ['kintag-second']);
  assert.deepEqual(StewardParticipation.tagsForBuild(state, BUILD_E7_PAIR), []);
});

test('the kinship export carries the tags for a build and the claim that gives them standing', () => {
  const state = StewardParticipation.defaultState();
  state.participant = 'Skald';
  StewardParticipation.putClaim(state, {claimId: 'claim-9', buildKey: BUILD_E9, builderKey: ANCHOR, deliveryStatus: 'queued'});
  StewardParticipation.putClaim(state, {claimId: 'claim-7', buildKey: BUILD_E7_PAIR, builderKey: ANCHOR, deliveryStatus: 'queued'});
  state.requests.r1 = {requestId: 'r1', buildKey: BUILD_E9};
  StewardParticipation.putKinshipTag(state, kinshipTagRecord(
    {buildKey: BUILD_E9, era: 9, builderKey: ANCHOR, contributorKey: CO_X, tags: ['mason']}, {id: 'kintag-9'}));
  StewardParticipation.putKinshipTag(state, kinshipTagRecord(
    {buildKey: BUILD_E7_PAIR, era: 7, builderKey: ANCHOR, contributorKey: CO_X, tags: ['roof']}, {id: 'kintag-7'}));

  const scoped = StewardParticipation.exportPayload(state, {kindFilter: 'kinship', buildKey: BUILD_E9});
  assert.equal(scoped.schema, 'steward-creator-participation-export/v1');
  assert.deepEqual(scoped.kinshipTags.map((t) => t.tagId), ['kintag-9']);
  assert.deepEqual(scoped.claims.map((c) => c.claimId), ['claim-9']);
  assert.equal(scoped.participant, 'Skald');

  const everything = StewardParticipation.exportPayload(state);
  assert.equal(everything.kinshipTags.length, 2);
  assert.equal(everything.claims.length, 2);
  assert.equal(everything.requests.length, 1);

  const claimOnly = StewardParticipation.exportPayload(state, {kindFilter: 'claim', buildKey: BUILD_E7_PAIR});
  assert.deepEqual(claimOnly.claims.map((c) => c.claimId), ['claim-7']);

  const perBuild = StewardParticipation.buildPayload(state, {builderKey: ANCHOR, buildKey: BUILD_E9, buildLabel: 'Great Hall'});
  assert.equal(perBuild.schema, 'steward-creator-build-participation/v1');
  assert.equal(perBuild.claim.claimId, 'claim-9');
  assert.deepEqual(perBuild.requests.map((r) => r.requestId), ['r1']);
  assert.deepEqual(perBuild.kinshipTags.map((t) => t.tagId), ['kintag-9']);
});

test('StewardParticipation.forget hands back a fresh ledger even when storage throws', () => {
  const storage = fakeStorage();
  const state = StewardParticipation.defaultState();
  StewardParticipation.putKinshipTag(state, kinshipTagRecord(
    {buildKey: BUILD_E9, era: 9, builderKey: ANCHOR, contributorKey: CO_X, tags: ['mason']}, {id: 'kintag-9'}));
  StewardParticipation.save(state, storage);
  assert.equal(storage.raw.has(StewardParticipation.STORAGE_KEY), true);
  const cleared = StewardParticipation.forget(storage);
  assert.equal(storage.raw.has(StewardParticipation.STORAGE_KEY), false);
  assert.deepEqual(cleared.kinshipTags, {});
  assert.deepEqual(cleared.claims, {});
  assert.equal(cleared.participant, '');

  const hostile = {getItem: () => null, setItem: () => {}, removeItem: () => { throw new Error('blocked'); }};
  assert.deepEqual(StewardParticipation.forget(hostile).kinshipTags, {});
  assert.deepEqual(StewardParticipation.forget(undefined).requests, {});
});

// ---------------------------------------------------------------------------
// "Not my build". A photographed build with the wrong name on it had no way to say so:
// credit comes from the creator saved on each construction piece and a visitor cannot
// edit those. A disavowal is the correction on offer -- and it is a marker like every
// other claim, so it records, counts and exports without ever moving a credit.
// ---------------------------------------------------------------------------

test('standingForBuild answers for a built claim, and for nothing else', () => {
  const state = StewardParticipation.defaultState();
  StewardParticipation.putClaim(state, {claimId: 'claim-built', buildKey: BUILD_E9, builderKey: ANCHOR, kind: 'built'});
  StewardParticipation.putClaim(state, {claimId: 'claim-not-mine', buildKey: BUILD_E7_PAIR, builderKey: ANCHOR, kind: 'disavow'});

  assert.equal(StewardParticipation.standingForBuild(state, BUILD_E9).claimId, 'claim-built');
  assert.equal(StewardParticipation.standingForBuild(state, BUILD_E7_PAIR), null,
    'saying a build is not yours cannot be what unlocks acting on it');
  assert.equal(StewardParticipation.standingForBuild(state, BUILD_E7_CROWD), null);

  // claimForBuild still answers for both: the card has to be able to say which it was.
  assert.equal(StewardParticipation.claimForBuild(state, BUILD_E9).kind, 'built');
  assert.equal(StewardParticipation.claimForBuild(state, BUILD_E7_PAIR).kind, 'disavow');
  assert.equal(StewardParticipation.claimForBuild(state, BUILD_E7_CROWD), null);
});

test('a claim with no kind at all is a built claim, both on the way in and off the disk', () => {
  const state = StewardParticipation.defaultState();
  const stored = StewardParticipation.putClaim(state, {claimId: 'claim-old', buildKey: BUILD_E9, builderKey: ANCHOR});
  assert.equal(stored.kind, 'built');
  assert.equal(StewardParticipation.standingForBuild(state, BUILD_E9).claimId, 'claim-old');

  const KEY = StewardParticipation.STORAGE_KEY;
  const ledger = {
    schema: StewardParticipation.SCHEMA,
    participant: 'Skald',
    claims: {
      [BUILD_E9]: {claimId: 'claim-1', buildKey: BUILD_E9, deliveryStatus: 'submitted'},
      [BUILD_E7_PAIR]: {claimId: 'claim-2', buildKey: BUILD_E7_PAIR, kind: 'disavow'},
      [BUILD_E7_CROWD]: {claimId: 'claim-3', buildKey: BUILD_E7_CROWD, kind: 'nonsense'},
    },
    requests: {},
  };
  const loaded = StewardParticipation.load(fakeStorage({[KEY]: JSON.stringify(ledger)}));
  assert.equal(loaded.claims[BUILD_E9].kind, 'built', 'a pre-disavowal ledger is not a broken ledger');
  assert.equal(loaded.claims[BUILD_E7_PAIR].kind, 'disavow');
  assert.equal(loaded.claims[BUILD_E7_CROWD].kind, 'built', 'anything that is not a disavowal is a claim');
  assert.equal(loaded.claims[BUILD_E9].deliveryStatus, 'submitted', 'and nothing else about it moves');
});

test('one record per build: a disavowal replaces a claim, and a claim replaces a disavowal', () => {
  const state = StewardParticipation.defaultState();
  StewardParticipation.putClaim(state, {claimId: 'claim-1', buildKey: BUILD_E9, builderKey: ANCHOR, kind: 'built', deliveryStatus: 'submitted'});
  StewardParticipation.putClaim(state, {claimId: 'claim-2', buildKey: BUILD_E9, builderKey: ANCHOR, kind: 'disavow', deliveryStatus: 'queued'});

  assert.deepEqual(Object.keys(state.claims), [BUILD_E9], 'one browser cannot hold both answers at once');
  const disavowal = StewardParticipation.claimForBuild(state, BUILD_E9);
  assert.equal(disavowal.claimId, 'claim-2');
  assert.equal(disavowal.kind, 'disavow');
  assert.equal(disavowal.deliveryStatus, 'submitted', 'a change of mind must not forget that one was delivered');
  assert.equal(disavowal.resubmittedFrom, 'claim-1');
  assert.equal(StewardParticipation.standingForBuild(state, BUILD_E9), null);

  StewardParticipation.putClaim(state, {claimId: 'claim-3', buildKey: BUILD_E9, builderKey: ANCHOR, kind: 'built'});
  assert.deepEqual(Object.keys(state.claims), [BUILD_E9]);
  assert.equal(StewardParticipation.standingForBuild(state, BUILD_E9).claimId, 'claim-3',
    'and the way back is the same door');
});

test('a kinship export rides a built claim and never a disavowal', () => {
  const state = StewardParticipation.defaultState();
  state.participant = 'Skald';
  StewardParticipation.putClaim(state, {claimId: 'claim-9', buildKey: BUILD_E9, builderKey: ANCHOR, kind: 'built'});
  StewardParticipation.putClaim(state, {claimId: 'claim-7', buildKey: BUILD_E7_PAIR, builderKey: ANCHOR, kind: 'disavow'});
  StewardParticipation.putKinshipTag(state, kinshipTagRecord(
    {buildKey: BUILD_E9, era: 9, builderKey: ANCHOR, contributorKey: CO_X, tags: ['mason']}, {id: 'kintag-9'}));
  StewardParticipation.putKinshipTag(state, kinshipTagRecord(
    {buildKey: BUILD_E7_PAIR, era: 7, builderKey: ANCHOR, contributorKey: CO_X, tags: ['roof']}, {id: 'kintag-7'}));

  const standing = StewardParticipation.exportPayload(state, {kindFilter: 'kinship', buildKey: BUILD_E9});
  assert.deepEqual(standing.claims.map((c) => c.claimId), ['claim-9']);
  assert.deepEqual(standing.kinshipTags.map((t) => t.tagId), ['kintag-9']);

  // A payload carrying somebody's tags for a build they have just said is not theirs
  // would be a payload arguing with itself. The tags still travel; the standing does not.
  const disowned = StewardParticipation.exportPayload(state, {kindFilter: 'kinship', buildKey: BUILD_E7_PAIR});
  assert.deepEqual(disowned.claims, []);
  assert.deepEqual(disowned.kinshipTags.map((t) => t.tagId), ['kintag-7']);

  // The unfiltered ledger export is the whole ledger, disavowals included -- that is the
  // payload the volunteer sends on, and a correction is exactly what the coordinator wants.
  const everything = StewardParticipation.exportPayload(state);
  assert.deepEqual(everything.claims.map((c) => c.kind).sort(), ['built', 'disavow']);
});
