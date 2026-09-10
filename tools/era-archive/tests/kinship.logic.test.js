'use strict';
// Pure layout logic for the kinship page. Run with: node --test tools/era-archive/tests/kinship.logic.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const kinship = require(path.join(__dirname, '..', 'web', 'kinship.js'));

test('kinship.js exports its layout helpers', () => {
  assert.equal(typeof kinship.layoutKinshipTree, 'function');
  assert.equal(typeof kinship.strokeWidthFor, 'function');
});

test('strokeWidthFor clamps between 2 and 8 on a log10 scale', () => {
  assert.equal(kinship.strokeWidthFor(0), 2);
  assert.equal(kinship.strokeWidthFor(99), 4);
  assert.equal(kinship.strokeWidthFor(9999), 8);
});
