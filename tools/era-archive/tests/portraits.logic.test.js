'use strict';
// The one portrait resolver (web/portraits.js): the slot rule, a chosen tile and take, a
// device choice, a revert, a tile the manifest no longer carries, and URL parity with the
// strings creators.js used to build itself. Run with:
//   node --test tools/era-archive/tests/portraits.logic.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const P = require(path.join(__dirname, '..', 'web', 'portraits.js'));
const {portraitIndex} = require(path.join(__dirname, '..', 'web', 'creators.js'));

const TUGCOW = '5897d38e2a065e36a6895e70a2194738';
const OTHER = 'a'.repeat(32);

function slateTiles(count = 48) {
  return Array.from({length: count}, (_, i) => {
    const id = `p${String(i + 1).padStart(2, '0')}`;
    return {id, file: `${id}.webp`, thumb: `${id}.128.webp`, v: `v${i}`, seed: 7000000 + i, tags: ['stonemason', 'young', 'woman']};
  });
}

const V1 = {schema: 'chronicles-portraits/v1', count: 48, base: '/chronicles/img/portraits/', tiles: slateTiles()};

function v2() {
  const slate = slateTiles().map((t) => ({...t, library: 'slate48', tagMap: {role: t.tags[0], age: t.tags[1], presentation: t.tags[2]},
    cuts: {bust128: t.thumb, bust512: t.file}}));
  const carpenter = {
    id: 'carpenter_f_artisan', library: 'viking96',
    tags: {role: 'carpenter', presentation: 'woman', theme: 'builders', hair: 'red', setting: 'workshop'},
    chips: [],
    cuts: {bust128: 'viking96/carpenter_f_artisan.{take}.128.webp', bust256: 'viking96/carpenter_f_artisan.{take}.256.webp', wide768: 'viking96/carpenter_f_artisan.{take}.wide.webp'},
    takes: [
      {id: 's4', v: 'aaaa1111', sha: 'sha-s4', facing: 'left'},
      {id: 's1', v: 'bbbb2222', sha: 'sha-s1', facing: 'right'},
    ],
  };
  return {
    schema: 'chronicles-portraits/v2', count: 48, base: '/chronicles/img/portraits/',
    tiles: [...slate, carpenter],
    libraries: {slate48: {label: 'Slate', framing: 'bust', default: true}, viking96: {label: 'Viking', framing: 'waist-up', default: false}},
    facets: [{tag: 'role', label: 'Trade', kind: 'dropdown'}],
    labels: {role: {carpenter: 'Carpenter', stonemason: 'Stonemason'}, presentation: {woman: 'Woman'}, hair: {red: 'Red'}, setting: {workshop: 'Workshop'}},
    aliases: {role: {joiner: 'carpenter'}},
  };
}

test.beforeEach(() => P.setChoices({}));

test('the slot rule is the one creators.js has always applied', () => {
  assert.equal(P.portraitIndex(TUGCOW, 48), portraitIndex(TUGCOW));
  assert.equal(P.portraitIndex(TUGCOW, 48), 46);
  assert.equal(P.portraitIndex('0'.repeat(32), 48), 0);
  assert.equal(P.portraitIndex('zz', 48), 0);
  assert.equal(P.portraitIndex(TUGCOW, 0), 0);
});

test('an unchosen builder wears the slot tile with the URLs creators.js used to build', () => {
  for (const manifest of [V1, v2()]) {
    const face = P.portraitFor(TUGCOW, manifest);
    assert.ok(face);
    assert.equal(face.library, 'slate48');
    assert.equal(face.tile.id, 'p47');
    assert.equal(face.url('bust512'), '/chronicles/img/portraits/p47.webp?v=v46');
    assert.equal(face.url('bust128'), '/chronicles/img/portraits/p47.128.webp?v=v46');
    // Roles a slate tile does not carry fall back to the nearest cut, never to nothing.
    assert.equal(face.url('bust256'), '/chronicles/img/portraits/p47.webp?v=v46');
    assert.equal(face.url('wide768'), '/chronicles/img/portraits/p47.webp?v=v46');
    assert.equal(face.alt, '');
    assert.equal(face.take, null);
  }
});

test('no manifest, an empty manifest, or no key resolves to null (the caller draws the emblem)', () => {
  assert.equal(P.portraitFor(TUGCOW, null), null);
  assert.equal(P.portraitFor(TUGCOW, {count: 0, tiles: []}), null);
  assert.equal(P.portraitFor('', V1), null);
  assert.equal(P.portraitFor({}, V1), null);
});

test('a choice recorded on this device wins, with its take and its own cuts', () => {
  const manifest = v2();
  P.setChoices({[TUGCOW]: {tile: 'viking96/carpenter_f_artisan', take: 's1'}});
  const face = P.portraitFor(TUGCOW, manifest);
  assert.equal(face.library, 'viking96');
  assert.equal(face.id, 'viking96/carpenter_f_artisan');
  assert.equal(face.take.id, 's1');
  assert.equal(face.url('bust128'), '/chronicles/img/portraits/viking96/carpenter_f_artisan.s1.128.webp?v=bbbb2222');
  assert.equal(face.url('wide768'), '/chronicles/img/portraits/viking96/carpenter_f_artisan.s1.wide.webp?v=bbbb2222');
  assert.equal(face.url('bust512'), '/chronicles/img/portraits/viking96/carpenter_f_artisan.s1.wide.webp?v=bbbb2222');
  assert.equal(face.alt, 'Carpenter, woman, red hair, workshop');
  // Somebody else on the same page is untouched.
  assert.equal(P.portraitFor(OTHER, manifest).library, 'slate48');
});

test('an unknown take falls back to the first picked take; a missing tile to the slot; a revert to the slot', () => {
  const manifest = v2();
  P.setChoices({[TUGCOW]: {tile: 'viking96/carpenter_f_artisan', take: 's99'}});
  assert.equal(P.portraitFor(TUGCOW, manifest).take.id, 's4');
  P.setChoices({[TUGCOW]: {tile: 'viking96/gone_m_missing', take: 's1'}});
  assert.equal(P.portraitFor(TUGCOW, manifest).tile.id, 'p47');
  P.setChoices({[TUGCOW]: {tile: null, take: null}});
  assert.equal(P.portraitFor(TUGCOW, manifest).tile.id, 'p47');
  // A choice keyed by something that is not a builder key is ignored.
  P.setChoices({nonsense: {tile: 'viking96/carpenter_f_artisan'}});
  assert.equal(P.portraitFor(TUGCOW, manifest).tile.id, 'p47');
});

test('a published choice on the record is honoured below the device, above the slot', () => {
  const manifest = v2();
  const record = {builderKey: TUGCOW, portrait: {tile: 'viking96/carpenter_f_artisan', take: 's4'}};
  assert.equal(P.portraitFor(record, manifest).take.id, 's4');
  P.setChoices({[TUGCOW]: {tile: null}});
  assert.equal(P.portraitFor(record, manifest).tile.id, 'p47', 'a revert on this device overrides the published choice');
  P.setChoices({});
  assert.equal(P.portraitFor({builderKey: TUGCOW, portrait: {tile: 'viking96/nope'}}, manifest).tile.id, 'p47');
});

test('flipping the default library changes the unchosen face and nothing for a chosen one', () => {
  const manifest = v2();
  manifest.libraries.slate48.default = false;
  manifest.libraries.viking96.default = true;
  const face = P.portraitFor(TUGCOW, manifest);
  assert.equal(face.library, 'viking96');
  assert.equal(face.take.id, 's4', 'the default take is the first picked one');
  P.setChoices({[OTHER]: {tile: 'slate48/p03', take: null}});
  assert.equal(P.portraitFor(OTHER, manifest).tile.id, 'p03');
  assert.equal(P.tileById(manifest, 'p03').id, 'p03', 'a bare v1 id still finds a slate tile');
});
