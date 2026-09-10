'use strict';
// Pure layout logic for the kinship page. Run with: node --test tools/era-archive/tests/kinship.logic.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const kinship = require(path.join(__dirname, '..', 'web', 'kinship.js'));

// The tree is built by hand rather than by calling into creators.js: this file is about
// the geometry, and it has to keep failing for geometry reasons alone even while the
// model that feeds it is still being written next door.
const ANCHOR = 'a'.repeat(32);
const co = (n) => String(n).padStart(2, '0').repeat(16);

function span(era, {sharedPieces = 100, sharedAlbums = 1, legacy = false} = {}) {
  return {era, sharedAlbums, sharedPieces, legacy, anchorMajority: false, builds: []};
}

function branch(index, spans) {
  const eras = spans.map((s) => s.era);
  return {
    builderKey: co(index),
    firstEra: Math.min(...eras),
    lastEra: Math.max(...eras),
    spans,
    totalSharedAlbums: spans.length,
    totalSharedPieces: spans.reduce((sum, s) => sum + s.sharedPieces, 0),
    legacyOnly: spans.every((s) => s.legacy),
    tags: {confirmed: [], pending: []},
  };
}

function tree(branches, eras = [7, 8, 9, 10]) {
  return {anchor: ANCHOR, eras, branches, majorityBuilds: [], coBuilderCount: branches.length};
}

const SIMPLE = tree([branch(1, [span(7), span(8)]), branch(2, [span(8)])]);

test('kinship.js exports its layout helpers', () => {
  assert.equal(typeof kinship.layoutKinshipTree, 'function');
  assert.equal(typeof kinship.strokeWidthFor, 'function');
});

test('strokeWidthFor clamps between 2 and 8 on a log10 scale', () => {
  assert.equal(kinship.strokeWidthFor(0), 2);
  assert.equal(kinship.strokeWidthFor(99), 4);
  assert.equal(kinship.strokeWidthFor(9999), 8);
});

test('height is the padding plus a band per era plus half a band of headroom', () => {
  const laid = kinship.layoutKinshipTree(SIMPLE);
  const {padTop, padBottom, bandHeight} = kinship.KIN_LAYOUT;
  assert.equal(laid.height, padTop + 3 * bandHeight + bandHeight / 2 + padBottom);
  assert.equal(laid.height, 356);
  assert.equal(laid.width, 960);
});

test('bands run oldest era at the bottom, newest at the top', () => {
  const laid = kinship.layoutKinshipTree(SIMPLE);
  assert.deepEqual(laid.bands.map((b) => b.era), [7, 8, 9, 10]);
  assert.deepEqual(laid.bands.map((b) => b.label), ['Era 7', 'Era 8', 'Era 9', 'Era 10']);
  assert.deepEqual(laid.bands.map((b) => b.y), [316, 244, 172, 100]);
  // The earliest era is the largest y, i.e. furthest down the canvas.
  for (let i = 1; i < laid.bands.length; i += 1) assert.ok(laid.bands[i].y < laid.bands[i - 1].y);
});

test('the trunk stands at the middle and spans first band to last', () => {
  const laid = kinship.layoutKinshipTree(SIMPLE);
  assert.deepEqual(laid.trunk, {x: 480, y0: 316, y1: 100});
  assert.deepEqual(laid.anchorNode, {x: 480, y: 70});
});

test('branches alternate right then left, one lane further out every pair', () => {
  const laid = kinship.layoutKinshipTree(tree([
    branch(1, [span(7)]), branch(2, [span(7)]), branch(3, [span(7)]), branch(4, [span(7)]),
  ]));
  assert.deepEqual(laid.branches.map((b) => b.side), ['right', 'left', 'right', 'left']);
  assert.deepEqual(laid.branches.map((b) => b.rank), [0, 1, 2, 3]);
  const {laneGap} = kinship.KIN_LAYOUT;
  assert.deepEqual(laid.branches.map((b) => b.laneX), [
    480 + laneGap * 1,
    480 - laneGap * 1,
    480 + laneGap * 2,
    480 - laneGap * 2,
  ]);
});

test('the curve leaves the trunk half a band below the era the branch begins in', () => {
  const laid = kinship.layoutKinshipTree(SIMPLE);
  assert.equal(laid.branches[0].curve.d, 'M 480,352 C 480,316 544,352 544,316');
  assert.equal(laid.branches[0].curve.kind, 'shared');
  assert.equal(laid.branches[0].curve.width, kinship.strokeWidthFor(100));
  // Branch 1 starts an era later, so it leaves the trunk one band higher up and left.
  assert.equal(laid.branches[1].curve.d, 'M 480,280 C 480,244 416,280 416,244');
});

test('a gap era becomes a hairline and a legacy era a dashed tail', () => {
  const gapped = tree([branch(1, [span(7, {sharedPieces: 9}), span(8, {sharedPieces: 1204}), span(10, {sharedPieces: 0, legacy: true})])]);
  const laid = kinship.layoutKinshipTree(gapped);
  const [only] = laid.branches;
  assert.deepEqual(only.segments.map((s) => s.era), [8, 9, 10]);
  assert.deepEqual(only.segments.map((s) => s.kind), ['shared', 'memory', 'legacy']);
  assert.deepEqual(only.segments.map((s) => s.width), [
    kinship.strokeWidthFor(1204),
    1,
    kinship.strokeWidthFor(0),
  ]);
  // Every segment hands off exactly where the one below it stopped, so the hairline
  // rejoins the same lane instead of starting a second branch.
  assert.deepEqual(only.segments.map((s) => [s.y0, s.y1]), [[316, 244], [244, 172], [172, 100]]);
  assert.deepEqual(only.node, {x: 544, y: 78});
});

test('a branch that ends early stops at its own last era', () => {
  const laid = kinship.layoutKinshipTree(tree([branch(1, [span(7), span(8)])]));
  const [only] = laid.branches;
  assert.deepEqual(only.segments.map((s) => s.era), [8]);
  assert.deepEqual(only.node, {x: 544, y: 222});
});

test('only the first maxBranches are laid out; the rest are counted as overflow', () => {
  const many = tree(Array.from({length: 14}, (_, i) => branch(i, [span(7)])));
  const laid = kinship.layoutKinshipTree(many);
  assert.equal(laid.branches.length, 12);
  assert.equal(laid.overflow, 2);
  assert.equal(kinship.layoutKinshipTree(many, {maxBranches: 14}).overflow, 0);
});

test('the layout is deterministic', () => {
  const gapped = tree([branch(1, [span(7), span(10, {legacy: true})]), branch(2, [span(8, {sharedPieces: 40})])]);
  assert.deepEqual(kinship.layoutKinshipTree(gapped), kinship.layoutKinshipTree(gapped));
});

test('a thread with no eras lays out to an empty canvas rather than throwing', () => {
  const laid = kinship.layoutKinshipTree(tree([branch(1, [span(7)])], []));
  assert.equal(laid.bands.length, 0);
  assert.equal(laid.branches.length, 0);
  assert.equal(laid.trunk, null);
  assert.equal(laid.anchorNode, null);
  assert.equal(laid.height, kinship.KIN_LAYOUT.padTop + kinship.KIN_LAYOUT.padBottom);
});
