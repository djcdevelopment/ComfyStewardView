'use strict';
// The profile page's pure pieces (web/profile.js): the Discord fragment parser, the receipt
// id, the relay message, and the opt-out record in the store. Run with:
//   node --test tools/era-archive/tests/profile.logic.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const profile = require(path.join(__dirname, '..', 'web', 'profile.js'));
const {StewardParticipation} = require(path.join(__dirname, '..', 'web', 'creators.js'));

const KEY = '5897d38e2a065e36a6895e70a2194738';

test('the fragment parser keeps a token only for its own round trip and returns the builder', () => {
  const hash = `#access_token=tok123&token_type=Bearer&expires_in=604800&scope=identify&state=n0nce.${KEY}`;
  const grant = profile.parseDiscordFragment(hash, 'n0nce');
  assert.equal(grant.token, 'tok123');
  assert.equal(grant.tokenType, 'Bearer');
  assert.equal(grant.builderKey, KEY);
  assert.equal(grant.expiresIn, 604800);
  assert.equal(profile.parseDiscordFragment(hash, 'other'), null, 'a nonce that is not ours');
  assert.equal(profile.parseDiscordFragment(hash, null), null, 'no nonce remembered');
  assert.equal(profile.parseDiscordFragment('#state=n0nce.' + KEY, 'n0nce'), null, 'no token');
  assert.equal(profile.parseDiscordFragment('#access_token=t&state=n0nce.notakey', 'n0nce'), null, 'a key that is not one');
  assert.equal(profile.parseDiscordFragment('#access_token=t&state=n0nce', 'n0nce').builderKey, null);
  assert.equal(profile.parseDiscordFragment('', 'n0nce'), null);
});

test('the receipt id is the day plus eight hex digits, stable for the same who/when/what', () => {
  const a = profile.receiptId(KEY, '2026-09-12T11:30:00.000Z', 'optout');
  assert.match(a, /^r-20260912-[0-9a-f]{8}$/);
  assert.equal(a, profile.receiptId(KEY, '2026-09-12T11:30:00.000Z', 'optout'));
  assert.notEqual(a, profile.receiptId(KEY, '2026-09-12T11:30:00.000Z', 'portrait'));
  assert.notEqual(a, profile.receiptId('a'.repeat(32), '2026-09-12T11:30:00.000Z', 'optout'));
  assert.equal(profile.fnv1a64('a'), profile.fnv1a64('a'));
  assert.notEqual(profile.fnv1a64('a'), profile.fnv1a64('b'));
});

test('the relay message is one embed, no mentions, the builder, the request, who sent it and the receipt', () => {
  const builder = {builderKey: KEY, displayName: 'Tugcow'};
  const optout = profile.relayMessage({kind: 'optout', builder, level: 'name', note: 'please', discord: {id: '42', username: 'tug'},
    receipt: 'r-20260912-deadbeef', pageUrl: 'https://example.invalid/profile/?builder=' + KEY});
  assert.deepEqual(optout.allowed_mentions, {parse: []});
  assert.equal(optout.embeds.length, 1);
  const fields = Object.fromEntries(optout.embeds[0].fields.map((f) => [f.name, f.value]));
  assert.match(fields.Builder, /Tugcow/);
  assert.match(fields.Builder, new RegExp(KEY));
  assert.equal(fields.Request, 'Keep the pictures, drop my name');
  assert.match(fields.Discord, /tug \(`42`\)/);
  assert.equal(fields.Receipt, '`r-20260912-deadbeef`');
  assert.equal(fields.Note, 'please');
  const unsigned = profile.relayMessage({kind: 'portrait', builder: {builderKey: KEY}, discord: null, receipt: 'r', portrait: {tile: 'viking96/jarl_m_chieftain', take: 's7'}});
  const f2 = Object.fromEntries(unsigned.embeds[0].fields.map((f) => [f.name, f.value]));
  assert.equal(f2.Discord, 'unsigned');
  assert.match(f2.Builder, /^Builder 5897d38e/);
  assert.equal(f2.Request, 'Portrait: viking96/jarl_m_chieftain · s7');
  assert.equal(f2.Note, undefined);
  const revert = profile.relayMessage({kind: 'portrait', builder, discord: null, receipt: 'r', portrait: {tile: null}});
  assert.match(Object.fromEntries(revert.embeds[0].fields.map((f) => [f.name, f.value])).Request, /archive's pick/);
  // The words the archive never uses are not in anything the relay says.
  for (const doc of [optout, unsigned, revert]) assert.doesNotMatch(JSON.stringify(doc), /character|archetype|seed|gender|submitted/i);
});

test('setOptOut keeps one request per profile, refuses unknown levels, clears on none, and rides the export', () => {
  const state = StewardParticipation.defaultState('2026-09-12T00:00:00Z');
  assert.equal(StewardParticipation.setOptOut(state, {builderKey: KEY, level: 'maybe'}), null);
  assert.equal(StewardParticipation.setOptOut(state, {builderKey: 'nope', level: 'name'}), null);
  const rec = StewardParticipation.setOptOut(state, {builderKey: KEY, level: 'name', note: '  which name  ', participant: ' Skald ', discord: {id: 42, username: 'tug'}});
  assert.equal(rec.level, 'name');
  assert.equal(rec.note, 'which name');
  assert.equal(rec.participant, 'Skald');
  assert.deepEqual(rec.discord, {id: '42', username: 'tug'});
  assert.equal(rec.sentAt, null);
  const again = StewardParticipation.setOptOut(state, {builderKey: KEY, level: 'erase', discord: null});
  assert.equal(again.optOutId, rec.optOutId, 'the same profile keeps one record');
  assert.equal(again.level, 'erase');
  assert.equal(again.discord, null);
  assert.equal(StewardParticipation.optOutForBuilder(state, KEY).level, 'erase');
  assert.deepEqual(StewardParticipation.exportPayload(state).optOuts.map((o) => o.level), ['erase']);
  assert.equal(StewardParticipation.setOptOut(state, {builderKey: KEY, level: 'none'}), null);
  assert.equal(StewardParticipation.optOutForBuilder(state, KEY), null);
  // A ledger saved before the map existed loads with an empty one.
  const storage = {getItem: () => JSON.stringify({...state, optOuts: undefined}), setItem() {}, removeItem() {}};
  assert.deepEqual(StewardParticipation.load(storage).optOuts, {});
});
