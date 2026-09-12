'use strict';

// The builder's own page (/valheim/creators/profile/?builder=<key>): the portrait their
// profile wears, and the opt-out levels. Nothing here is an account and nothing here is a
// server: a choice is recorded in this browser (the participation ledger creators.js owns)
// and noted to the archive by a four-byte beacon whose query string the front door's own
// access log keeps -- who was dressed in what, when -- which is also where obvious abuse
// shows. An opt-out becomes a message the builder copies and pastes to the coordinator on
// Discord; the coordinator confirms every request there before a public page changes.
//
// creators.js is loaded for its store (StewardParticipation) and stands down on this page
// (the route guard); portraits.js resolves faces; portrait-picker.js is the drawer. The
// helpers those pages keep private -- toast, clipboard, fetch -- are re-implemented here
// the way kinship.js does it. The pure pieces (the receipt id, the beacon URL, the
// message) are exported for the Node test.

const PROFILE_KEY_PATTERN = /^[a-f0-9]{32}$/;
const PROFILE_BEACON = 'portrait-beacon.txt';
const COORDINATOR_HANDLE = 'Tugcow';
const OPT_OUT_WORDS = {
  name: 'Keep the pictures, drop my name',
  erase: "Erase every reference to me and don't use my builds in any process",
};

// A short, stable receipt for a request: the day, and eight hex digits of a 64-bit FNV-1a
// over who, when and what. Same everywhere JavaScript runs, no async digest needed.
function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function receiptId(builderKey, sentAt, kind) {
  const day = String(sentAt || '').slice(0, 10).replace(/-/g, '');
  return `r-${day}-${fnv1a64(`${builderKey}|${sentAt}|${kind}`).slice(0, 8)}`;
}

// The beacon's query string is the record the access log keeps. Keys and values are the
// archive's own tokens (a builder key, a tile address, a take id, a level, a receipt) --
// never free text, never a name -- so the log stays a log of requests, not of people.
function beaconUrl(base, {action, builderKey, tile, take, level, receipt}) {
  const url = new URL(PROFILE_BEACON, base);
  url.searchParams.set('action', action);
  url.searchParams.set('builder', builderKey);
  if (tile) url.searchParams.set('tile', tile);
  if (take) url.searchParams.set('take', take);
  if (level) url.searchParams.set('level', level);
  if (receipt) url.searchParams.set('receipt', receipt);
  return url;
}

// The message a builder pastes to the coordinator on Discord. Plain lines, in the order
// the coordinator reads them; the note is the only free text and comes last.
function requestMessage({kind, builder, level, note, receipt, pageUrl, portrait}) {
  const name = builder.displayName || `Builder ${String(builder.builderKey).slice(0, 8)}`;
  const lines = [
    `@${COORDINATOR_HANDLE} — a request from the Valheim Chronicles archive`,
    `Receipt: ${receipt}`,
    `Builder: ${name} (${builder.builderKey})`,
  ];
  if (kind === 'optout') lines.push(`Request: ${OPT_OUT_WORDS[level] || level || '—'}`);
  else lines.push(`Request: portrait ${portrait && portrait.tile ? `${portrait.tile} · ${portrait.take || 'first take'}` : "— the archive's pick"}`);
  if (note) lines.push(`Note: ${String(note).trim().slice(0, 500)}`);
  if (pageUrl) lines.push(`Page: ${pageUrl}`);
  return lines.join('\n');
}

const profileApi = {receiptId, beaconUrl, requestMessage, fnv1a64, OPT_OUT_WORDS, COORDINATOR_HANDLE, PROFILE_BEACON};
if (typeof module !== 'undefined') module.exports = profileApi;

function initProfilePage() {
  const $ = (id) => document.getElementById(id);
  const base = new URL('../', location.href);
  const query = new URLSearchParams(location.search);
  const builderKey = PROFILE_KEY_PATTERN.test(query.get('builder') || '') ? query.get('builder') : null;
  const state = StewardParticipation.load();
  let thread = null;
  let manifest = null;
  let pickerMounted = false;

  /* ---- the helpers the other pages keep private ---- */

  function node(tag, text, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function toast(message, timeoutMs = 2600) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), timeoutMs);
  }

  async function readOptional(name) {
    try {
      const response = await fetch(new URL(name, base));
      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    }
  }

  function save() {
    StewardParticipation.save(state);
    if (typeof StewardPortraits === 'object') StewardPortraits.setChoices(state.portraits || {});
  }

  async function copyText(text, message) {
    if (!navigator.clipboard?.writeText) return toast('Select the message and copy it by hand.');
    try {
      await navigator.clipboard.writeText(text);
      toast(message || 'Copied.');
    } catch {
      toast('Select the message and copy it by hand.');
    }
  }

  function emblem(cls) {
    const holder = node('span', null, cls);
    holder.setAttribute('aria-hidden', 'true');
    const mark = document.querySelector('.brand-emblem');
    if (mark) {
      const clone = mark.cloneNode(true);
      clone.removeAttribute('class');
      clone.removeAttribute('width');
      clone.removeAttribute('height');
      holder.append(clone);
    }
    return holder;
  }

  // A face into a holder: the bust at the size the holder shows, the emblem when there is
  // none or the file fails to arrive.
  function paintFace(holder, face, role = 'bust256') {
    if (!holder) return;
    const src = face ? face.url(role) : null;
    if (!src) {
      holder.replaceChildren(emblem('profile-avatar-fallback'));
      return;
    }
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.onload = () => holder.replaceChildren(img);
    img.onerror = () => holder.replaceChildren(emblem('profile-avatar-fallback'));
    img.src = src;
  }

  // The note to the archive: a GET the front door logs. Fire-and-forget, like the search
  // beacon; the page never waits on it and never learns whether it was written.
  function beacon(fields) {
    const url = beaconUrl(base, {builderKey, ...fields});
    fetch(url, {cache: 'no-store', keepalive: true}).catch(() => {});
    return url;
  }

  // The address bar says what the page shows, so a reload -- or a pasted link -- lands on
  // the same face. Not a log line; the beacon is.
  function reflectChoice(choice) {
    const url = new URL(location.href);
    if (choice && choice.tile) {
      url.searchParams.set('portrait', choice.tile);
      if (choice.take) url.searchParams.set('take', choice.take); else url.searchParams.delete('take');
    } else {
      url.searchParams.delete('portrait');
      url.searchParams.delete('take');
    }
    if (url.href !== location.href) history.replaceState(null, '', url);
  }

  /* ---- the portrait ---- */

  function currentFace() {
    return manifest ? StewardPortraits.portraitFor(thread, manifest) : null;
  }

  // The archive's pick for this builder (the record's `by: archive` portrait), resolved as
  // if nothing were chosen on this device. A confirmed choice has no archive pick to show.
  function archiveFace() {
    if (!manifest || !thread || !thread.portrait || !thread.portrait.tile || thread.portrait.by === 'builder') return null;
    StewardPortraits.setChoices({});
    const face = StewardPortraits.portraitFor({builderKey, portrait: thread.portrait}, manifest);
    StewardPortraits.setChoices(state.portraits || {});
    return face;
  }

  function renderPortrait() {
    paintFace($('portrait-current'), currentFace());
    const archive = archiveFace();
    paintFace($('portrait-archive'), archive);
    $('portrait-archive').parentElement.hidden = !archive;
    const choice = StewardParticipation.portraitForBuilder(state, builderKey);
    const note = $('portrait-note');
    const libraries = !!(manifest && manifest.libraries);
    $('portrait-pick').disabled = !(libraries && pickerMounted);
    $('portrait-archive-pick').disabled = !(choice && choice.tile);
    $('portrait-gate').textContent = libraries ? '' : 'The portrait library has not reached this page yet.';
    if (choice) {
      note.textContent = choice.tile
        ? `Recorded on this device and noted to the archive · receipt ${choice.receipt || '—'}. Everyone else sees it once the coordinator publishes.`
        : `Back to the archive's pick, recorded on this device · receipt ${choice.receipt || '—'}.`;
      note.hidden = false;
      $('portrait-current-caption').textContent = choice.tile ? 'Worn now · your choice on this device' : 'Worn now';
    } else {
      note.hidden = true;
      $('portrait-current-caption').textContent = thread && thread.portrait && thread.portrait.by === 'builder' ? 'Worn now · your confirmed choice' : 'Worn now';
    }
  }

  function onChoose(choice) {
    const record = StewardParticipation.setPortrait(state, {
      builderKey,
      tile: choice ? choice.tile : null,
      take: choice ? choice.take : null,
      sha: choice ? choice.sha : null,
      participant: state.participant,
    });
    if (!record) return;
    const notedAt = new Date().toISOString();
    record.receipt = receiptId(builderKey, notedAt, choice ? 'portrait' : 'revert');
    record.notedAt = notedAt;
    save();
    beacon({action: choice ? 'choose' : 'revert', tile: record.tile, take: record.take, receipt: record.receipt});
    reflectChoice(record);
    if (typeof StewardPortraitPicker === 'object') StewardPortraitPicker.update({choice: StewardParticipation.portraitForBuilder(state, builderKey)});
    renderPortrait();
    toast(choice ? `Portrait recorded · receipt ${record.receipt}` : "Back to the archive's pick.");
  }

  function mountPicker() {
    if (pickerMounted || !manifest || !manifest.libraries || typeof StewardPortraitPicker !== 'object') return;
    const host = node('div');
    host.id = 'portrait-picker-host';
    document.body.append(host);
    pickerMounted = StewardPortraitPicker.mount(host, {
      manifest,
      builderKey,
      choice: StewardParticipation.portraitForBuilder(state, builderKey),
      onChoose,
      returnFocus: () => $('portrait-pick'),
    });
  }

  /* ---- the opt-out: a message to paste ---- */

  function chosenLevel() {
    const checked = document.querySelector('input[name="optout-level"]:checked');
    return checked ? checked.value : 'none';
  }

  function renderOptOut() {
    const level = chosenLevel();
    const wrap = $('optout-message-wrap');
    const receiptLine = $('optout-receipt');
    const existing = StewardParticipation.optOutForBuilder(state, builderKey);
    if (level === 'none') {
      wrap.hidden = true;
      receiptLine.hidden = !existing;
      if (existing) receiptLine.textContent = `A request is recorded on this device (${OPT_OUT_WORDS[existing.level]} · receipt ${existing.receipt || '—'}). Pick the level again to see the message.`;
      return;
    }
    // One record per profile: the level and the note may change, the receipt stays; the
    // beacon notes the level once, and again when it changes.
    const before = existing ? {receipt: existing.receipt, notedLevel: existing.notedLevel} : {};
    const record = StewardParticipation.setOptOut(state, {builderKey, level, note: $('optout-note').value, participant: state.participant});
    if (!record) return;
    record.receipt = before.receipt || receiptId(builderKey, new Date().toISOString(), 'optout');
    record.notedLevel = before.notedLevel || null;
    if (record.notedLevel !== level) {
      beacon({action: 'optout', level, receipt: record.receipt});
      record.notedLevel = level;
    }
    save();
    $('optout-message').value = requestMessage({kind: 'optout', builder: thread, level, note: $('optout-note').value,
      receipt: record.receipt, pageUrl: `${location.origin}${location.pathname}?builder=${builderKey}`});
    wrap.hidden = false;
    receiptLine.hidden = false;
    receiptLine.textContent = `Recorded on this device · receipt ${record.receipt}. Paste the message to @${COORDINATOR_HANDLE} on Discord; nothing changes until it is confirmed there.`;
  }

  /* ---- boot ---- */

  function wire() {
    $('portrait-pick').onclick = () => { if (pickerMounted) StewardPortraitPicker.open(); };
    $('portrait-archive-pick').onclick = () => onChoose(null);
    $('optout-copy').onclick = () => copyText($('optout-message').value, `Copied — paste it to @${COORDINATOR_HANDLE} on Discord.`);
    $('optout-message').onfocus = () => $('optout-message').select();
    for (const radio of document.querySelectorAll('input[name="optout-level"]')) radio.addEventListener('change', renderOptOut);
    $('optout-note').addEventListener('input', () => { if (chosenLevel() !== 'none') renderOptOut(); });
  }

  function facts(record) {
    // The thread's eras are {era, albums} groups; the directory's are numbers.
    const eras = (record.eras || []).map((e) => (typeof e === 'number' ? e : e && e.era)).filter(Number.isFinite).sort((a, b) => a - b);
    const span = eras.length ? (eras.length === 1 ? `era ${eras[0]}` : `eras ${eras[0]}–${eras[eras.length - 1]}`) : '';
    return [record.tier, span, `${(record.albums || 0).toLocaleString()} build albums`,
      `${(record.pieces || 0).toLocaleString()} construction pieces`, `${(record.photos || 0).toLocaleString()} photographs`]
      .filter(Boolean).join(' · ');
  }

  async function boot() {
    wire();
    if (!builderKey) {
      $('status').textContent = 'Open a builder’s page and click the portrait to reach their profile settings.';
      return;
    }
    $('profile-back-link').href = new URL(`${builderKey}/`, base).href;
    const [record, portraits] = await Promise.all([readOptional(`threads/${builderKey}.json`), readOptional('/chronicles/portraits.json')]);
    if (!record) {
      $('status').textContent = 'That builder has no page in the archive.';
      return;
    }
    thread = record;
    manifest = portraits;
    if (typeof StewardPortraits === 'object') {
      StewardPortraits.setChoices(state.portraits || {});
      if (record.portrait && record.portrait.tile) StewardPortraits.setPublished({[builderKey]: record.portrait}, {merge: true});
    }
    document.title = `${record.displayName} · Your profile · Comfy builders`;
    $('title').textContent = record.displayName;
    $('profile-facts').textContent = facts(record);
    paintFace($('profile-avatar'), currentFace());
    const wide = $('profile-wide');
    const face = currentFace();
    if (face && face.url('wide768')) {
      wide.src = face.url('wide768');
      wide.hidden = false;
    }
    $('status').textContent = '';
    for (const id of ['profile-head', 'profile-portrait', 'profile-optout', 'profile-about']) $(id).hidden = false;
    mountPicker();
    renderPortrait();
    const existing = StewardParticipation.optOutForBuilder(state, builderKey);
    if (existing) {
      const radio = document.querySelector(`input[name="optout-level"][value="${existing.level}"]`);
      if (radio) radio.checked = true;
      if (existing.note) $('optout-note').value = existing.note;
    }
    renderOptOut();
  }

  boot();
}

if (typeof document !== 'undefined' && document.documentElement.dataset.stewardPage === 'profile') initProfilePage();
