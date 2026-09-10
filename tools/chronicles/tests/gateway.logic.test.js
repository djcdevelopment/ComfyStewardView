// The front door's ranking, checked against the builders index's own.
//
// test_matcher_parity.py proves the two files hold the same matcher source. This proves
// the gateway composes it the same way the index does: same filter, same comparator, same
// cap, over the same fixture. Run with:
//   node --test tools/chronicles/tests/gateway.logic.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..', '..');
const gateway = require(path.join(__dirname, '..', 'src', 'gateway.js'));
const creators = require(path.join(REPO, 'tools', 'era-archive', 'web', 'creators.js'));

const directory = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'directory.json'), 'utf8'),
);
const builders = directory.builders;

// Two letters, one letter, a substring that only ever hits an alias, a placeholder-name
// prefix that pulls in the anonymous threads, and a leading hyphen that matches nothing.
const QUERIES = ['tu', 'bu', 'a', 'ib', 'builder 00', '-b'];

// What the builders index would show in its own suggestion list for the same typing.
function indexOrder(query) {
  const q = query.trim().toLocaleLowerCase();
  return creators
    .filterBuilders(builders, {query})
    .sort((a, b) => creators.compareBuilders(a, b, q))
    .slice(0, 8)
    .map((b) => b.builderKey);
}

test('the fixture is the live directory shape', () => {
  assert.ok(builders.length > 0);
  for (const b of builders) {
    assert.equal(typeof b.builderKey, 'string');
    assert.equal(b.builderKey.length, 32);
    assert.equal(typeof b.displayName, 'string');
  }
});

for (const query of QUERIES) {
  test(`rankBuilders(${JSON.stringify(query)}) matches the builders index order`, () => {
    const ranked = gateway.rankBuilders(builders, query).map((b) => b.builderKey);
    assert.deepEqual(ranked, indexOrder(query));
    assert.ok(ranked.length <= gateway.SUGGESTION_LIMIT);
  });
}

test('at least one query fills the eight-row cap and one returns nothing', () => {
  const sizes = QUERIES.map((q) => gateway.rankBuilders(builders, q).length);
  assert.ok(sizes.some((n) => n === gateway.SUGGESTION_LIMIT), 'no query reaches the cap');
  assert.ok(sizes.some((n) => n === 0), 'no query exercises the empty row');
});

test('ranking does not disturb the array it was given', () => {
  const before = builders.map((b) => b.builderKey);
  gateway.rankBuilders(builders, 'a');
  assert.deepEqual(builders.map((b) => b.builderKey), before);
});

test('an exact name outranks a builder with more photographs', () => {
  const exact = builders.find((b) => b.photos === 0 && !gateway.PLACEHOLDER_NAME.test(b.displayName));
  assert.ok(exact, 'fixture has no unphotographed named builder');
  const ranked = gateway.rankBuilders(builders, exact.displayName);
  assert.equal(ranked[0].builderKey, exact.builderKey);
});

test('portraitIndex is the leading four bytes of the key, modulo the tile count', () => {
  // Tugcow on the live directory, the key the headless check types for.
  assert.equal(gateway.portraitIndex('5897d38e2a065e36a6895e70a2194738', 48), 46);
  assert.equal(gateway.portraitIndex('00000000000000000000000000000000', 48), 0);
  assert.equal(gateway.portraitIndex('0000002f0000000000000000000000ff', 48), 47);
  // Stable: the same builder wears the same tile every time it is asked.
  for (const b of builders) {
    const index = gateway.portraitIndex(b.builderKey, 48);
    assert.ok(Number.isInteger(index) && index >= 0 && index < 48, b.builderKey);
    assert.equal(index, gateway.portraitIndex(b.builderKey, 48));
  }
});

test('MIN_CHARS is the same two-letter floor the index suggestions use', () => {
  assert.equal(gateway.MIN_CHARS, 2);
  assert.equal(gateway.SUGGESTION_LIMIT, 8);
});
