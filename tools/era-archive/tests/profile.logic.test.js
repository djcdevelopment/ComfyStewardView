'use strict';
// The profile page's pure pieces (web/profile.js): the receipt id, the beacon URL the front
// door logs, the message a builder pastes to the coordinator, and the opt-out record in the
// store. Run with: node --test tools/era-archive/tests/profile.logic.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const profile = require(path.join(__dirname, '..', 'web', 'profile.js'));
const {StewardParticipation} = require(path.join(__dirname, '..', 'web', 'creators.js'));

const KEY = '5897d38e2a065e36a6895e70a2194738';
const BASE = new URL('https://example.invalid/valheim/creators/');

test('the receipt id is the day plus eight hex digits, stable for the same who/when/what', () => {
  const a = profile.receiptId(KEY, '2026-09-12T11:30:00.000Z', 'optout');
  assert.match(a, /^r-20260912-[0-9a-f]{8}$/);
  assert.equal(a, profile.receiptId(KEY, '2026-09-12T11:30:00.000Z', 'optout'));
  assert.notEqual(a, profile.receiptId(KEY, '2026-09-12T11:30:00.000Z', 'portrait'));
  assert.notEqual(a, profile.receiptId('a'.repeat(32), '2026-09-12T11:30:00.000Z', 'optout'));
});

test('the beacon carries only the archive tokens on its query string, under the creators root', () => {
  const choose = profile.beaconUrl(BASE, {action: 'choose', builderKey: KEY, tile: 'viking96/jarl_m_chieftain', take: 's7', receipt: 'r-20260912-deadbeef'});
  assert.equal(choose.pathname, '/valheim/creators/portrait-beacon.txt');
  assert.equal(choose.searchParams.get('action'), 'choose');
  assert.equal(choose.searchParams.get('builder'), KEY);
  assert.equal(choose.searchParams.get('tile'), 'viking96/jarl_m_chieftain');
  assert.equal(choose.searchParams.get('take'), 's7');
  assert.equal(choose.searchParams.get('receipt'), 'r-20260912-deadbeef');
  assert.equal([...choose.searchParams.keys()].length, 5);
  const revert = profile.beaconUrl(BASE, {action: 'revert', builderKey: KEY, tile: null, take: null, receipt: 'r-1'});
  assert.deepEqual([...revert.searchParams.keys()], ['action', 'builder', 'receipt']);
  const optout = profile.beaconUrl(BASE, {action: 'optout', builderKey: KEY, level: 'erase', receipt: 'r-2'});
  assert.deepEqual([...optout.searchParams.keys()], ['action', 'builder', 'level', 'receipt']);
  // The note never rides the beacon: there is no key for it.
  assert.equal(optout.searchParams.get('note'), null);
});

test('the message names the coordinator, the receipt, the builder, the request and the note, in that order', () => {
  const builder = {builderKey: KEY, displayName: 'Tugcow'};
  const text = profile.requestMessage({kind: 'optout', builder, level: 'name', note: '  please  ', receipt: 'r-20260912-deadbeef',
    pageUrl: 'https://example.invalid/valheim/creators/profile/?builder=' + KEY});
  const lines = text.split('\n');
  assert.equal(lines[0], '@Tugcow — a request from the Valheim Chronicles archive');
  assert.equal(lines[1], 'Receipt: r-20260912-deadbeef');
  assert.equal(lines[2], `Builder: Tugcow (${KEY})`);
  assert.equal(lines[3], 'Request: Keep the pictures, drop my name');
  assert.equal(lines[4], 'Note: please');
  assert.match(lines[5], /^Page: https:\/\/example\.invalid\/valheim\/creators\/profile\/\?builder=/);
  assert.equal(lines.length, 6);
  const erase = profile.requestMessage({kind: 'optout', builder: {builderKey: KEY}, level: 'erase', receipt: 'r'});
  assert.match(erase, /Builder: Builder 5897d38e \(/);
  assert.match(erase, /Request: Erase every reference to me and don't use my builds in any process/);
  assert.doesNotMatch(erase, /Note:/);
  const portrait = profile.requestMessage({kind: 'portrait', builder, receipt: 'r', portrait: {tile: 'viking96/jarl_m_chieftain', take: 's7'}});
  assert.match(portrait, /Request: portrait viking96\/jarl_m_chieftain · s7/);
  for (const doc of [text, erase, portrait]) assert.doesNotMatch(doc, /character|archetype|seed|gender|submitted/i);
  assert.equal(profile.COORDINATOR_HANDLE, 'Tugcow');
});

test('setOptOut keeps one request per profile, refuses unknown levels, clears on none, and rides the export', () => {
  const state = StewardParticipation.defaultState('2026-09-12T00:00:00Z');
  assert.equal(StewardParticipation.setOptOut(state, {builderKey: KEY, level: 'maybe'}), null);
  assert.equal(StewardParticipation.setOptOut(state, {builderKey: 'nope', level: 'name'}), null);
  const rec = StewardParticipation.setOptOut(state, {builderKey: KEY, level: 'name', note: '  which name  ', participant: ' Skald '});
  assert.equal(rec.level, 'name');
  assert.equal(rec.note, 'which name');
  assert.equal(rec.participant, 'Skald');
  const again = StewardParticipation.setOptOut(state, {builderKey: KEY, level: 'erase'});
  assert.equal(again.optOutId, rec.optOutId, 'the same profile keeps one record');
  assert.equal(again.level, 'erase');
  assert.equal(StewardParticipation.optOutForBuilder(state, KEY).level, 'erase');
  assert.deepEqual(StewardParticipation.exportPayload(state).optOuts.map((o) => o.level), ['erase']);
  assert.equal(StewardParticipation.setOptOut(state, {builderKey: KEY, level: 'none'}), null);
  assert.equal(StewardParticipation.optOutForBuilder(state, KEY), null);
  // A ledger saved before the map existed loads with an empty one.
  const storage = {getItem: () => JSON.stringify({...state, optOuts: undefined}), setItem() {}, removeItem() {}};
  assert.deepEqual(StewardParticipation.load(storage).optOuts, {});
});
