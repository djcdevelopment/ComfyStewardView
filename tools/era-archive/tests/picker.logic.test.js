'use strict';
// The picker's narrowing (web/portrait-picker.js countsFor), over the real libraries: the
// slate48 manifest committed under tools/chronicles/assets/portraits and the viking96 tags
// as cut on 2026-09-12 (fixtures/viking96-tags.json). The numbers are FR-3's acceptance
// criteria. Run with: node --test tools/era-archive/tests/picker.logic.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require(path.join(__dirname, '..', 'web', 'portraits.js'));
const Picker = require(path.join(__dirname, '..', 'web', 'portrait-picker.js'));

const slateSource = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'chronicles', 'assets', 'portraits', 'manifest.json'), 'utf8'));
const viking = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'viking96-tags.json'), 'utf8'));

// The document build.py writes, minus the cuts nobody counts.
function manifest() {
  const slate = slateSource.tiles.map((t) => ({
    id: t.id, library: 'slate48', file: `${t.id}.webp`, thumb: `${t.id}.128.webp`, v: 'x', tags: t.tags,
    tagMap: {role: t.tags[0], age: t.tags[1], presentation: t.tags[2]},
  }));
  const painted = viking.tiles.map((t) => ({id: t.id, library: 'viking96', tags: t.tags, chips: t.chips,
    cuts: {bust128: `viking96/${t.id}.{take}.128.webp`}, takes: t.takes.map((id) => ({id, v: 'y'}))}));
  return {
    schema: 'chronicles-portraits/v2', count: slate.length, base: '/chronicles/img/portraits/',
    tiles: [...slate, ...painted],
    libraries: {slate48: {default: true}, viking96: {default: false}},
    facets: viking.facets, labels: viking.labels, aliases: viking.aliases,
  };
}

test('nothing selected: every portrait of both libraries', () => {
  const {visible, options} = Picker.countsFor(manifest(), {});
  assert.equal(visible, 144);
  // Every trade of both libraries is offered, the alias folded.
  assert.equal(options.role.carpenter, 8);
  assert.equal(options.role.joiner, undefined);
  assert.equal(options.role.stonemason, 8, 'four painted + four slate stonemasons');
  // 24 painted trades + 12 slate trades - 5 shared - the joiner alias = 30. (The FR record
  // says 31; the data says 30, and the data is what the menu shows.)
  assert.equal(Object.keys(options.role).length, 30);
});

test('Trade=Carpenter reads 8: four painted carpenters and the four slate joiners via the alias', () => {
  const {visible, options} = Picker.countsFor(manifest(), {role: ['carpenter']});
  assert.equal(visible, 8);
  // Hair is a painted-only facet: the slate joiners match any value of it, so red reads
  // one painted carpenter plus four slate.
  assert.equal(options.hair.red, 5);
  assert.equal(options.hair.blonde, 5);
  assert.equal(options.presentation.woman, 2 + 2);
});

test('adding Hair=red reads 5, then Presentation=woman reads 3', () => {
  const m = manifest();
  const red = Picker.countsFor(m, {role: ['carpenter'], hair: ['red']});
  assert.equal(red.visible, 5);
  const women = Picker.countsFor(m, {role: ['carpenter'], hair: ['red'], presentation: ['woman']});
  assert.equal(women.visible, 3);
  // The other value of a segmented facet still says what it would leave.
  assert.equal(women.options.presentation.man, 2);
  // Options nothing satisfies are counted zero, never dropped: the menu keeps all 30 trades.
  assert.equal(Object.keys(women.options.role).length, 30);
  assert.ok(Object.values(women.options.role).includes(0));
});

test('a v1 manifest counts its tiles on the three facets it has', () => {
  const v1 = {count: 48, tiles: slateSource.tiles.map((t) => ({id: t.id, file: `${t.id}.webp`, v: 'x', tags: t.tags}))};
  const {visible, options} = Picker.countsFor(v1, {});
  assert.equal(visible, 48);
  assert.equal(options.role.joiner, 4);
  assert.equal(options.presentation.woman, 24);
});

test('no picker string names a seed, a gender, a character or an archetype', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'portrait-picker.js'), 'utf8');
  const strings = source.match(/'[^'\n]*'|`[^`\n]*`/g) || [];
  for (const s of strings) assert.doesNotMatch(s, /character|archetype|seed|gender/i, s);
});
