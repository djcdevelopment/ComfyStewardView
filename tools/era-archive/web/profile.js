'use strict';

// The builder's own page (/valheim/creators/profile/?builder=<key>): the portrait their
// profile wears, a Discord sign-in so a request carries a real identity, and the opt-out
// levels. Nothing here is an account. Choices live in this browser (the participation
// ledger creators.js owns) and travel as requests: to the relay -- a Caddy route on the
// front door that forwards to a Discord webhook, so the Discord message is the receipt --
// or, when the relay is not there, as the copied payload every claim already rides. The
// coordinator confirms every request on Discord before a public page changes.
//
// creators.js is loaded for its store (StewardParticipation) and stands down on this page
// (the route guard); portraits.js resolves faces; portrait-picker.js is the drawer. The
// helpers those pages keep private -- toast, modal, clipboard, fetch -- are re-implemented
// here the way kinship.js does it. The pure pieces (the fragment parser, the receipt id,
// the relay message) are exported for the Node test.

const PROFILE_KEY_PATTERN = /^[a-f0-9]{32}$/;
const PROFILE_RELAY_PATH = 'relay?wait=true';
const DISCORD_IDENTITY_KEY = 'creators-discord-identity';
const DISCORD_NONCE_KEY = 'creators-discord-nonce';
const OPT_OUT_WORDS = {
  name: 'Keep the pictures, drop my name',
  erase: "Erase every reference to me and don't use my builds in any process",
};

// The implicit-grant round trip lands back here with the token in the fragment. The
// `state` we sent carries our nonce and the builder key (the registered redirect URI
// cannot carry a query), so the page can prove the round trip is its own and come back to
// the right builder. Anything that does not match is ignored: null, no token kept.
function parseDiscordFragment(hash, expectedNonce) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const token = params.get('access_token');
  const state = params.get('state') || '';
  const [nonce, builderKey] = state.split('.');
  if (!token || !nonce || !expectedNonce || nonce !== expectedNonce) return null;
  if (builderKey && !PROFILE_KEY_PATTERN.test(builderKey)) return null;
  return {token, tokenType: params.get('token_type') || 'Bearer', builderKey: builderKey || null,
    expiresIn: Number(params.get('expires_in')) || null};
}

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

// What the relay hands to Discord: one embed, no mentions, and the payload as a file. The
// coordinator reads the embed; `ingest` reads the file.
function relayMessage({kind, builder, level, note, discord, receipt, pageUrl, portrait}) {
  const fields = [
    {name: 'Builder', value: `${builder.displayName || 'Builder ' + String(builder.builderKey).slice(0, 8)}\n\`${builder.builderKey}\``},
    {name: 'Request', value: kind === 'optout' ? (OPT_OUT_WORDS[level] || level || '—') : `Portrait: ${portrait && portrait.tile ? `${portrait.tile} · ${portrait.take || 'first take'}` : "the archive's pick"}`},
    {name: 'Discord', value: discord && discord.id ? `${discord.username || '?'} (\`${discord.id}\`)` : 'unsigned'},
    {name: 'Receipt', value: `\`${receipt}\``},
  ];
  if (note) fields.push({name: 'Note', value: String(note).slice(0, 1000)});
  return {
    content: kind === 'optout' ? 'Opt-out request from a builder page' : 'Portrait choice from a builder page',
    allowed_mentions: {parse: []},
    embeds: [{
      title: kind === 'optout' ? 'Opt-out request' : 'Portrait choice',
      url: pageUrl || undefined,
      fields,
      footer: {text: 'payload.json attached · confirm on the coordinator side before anything changes'},
    }],
  };
}

const profileApi = {parseDiscordFragment, receiptId, relayMessage, fnv1a64, OPT_OUT_WORDS};
if (typeof module !== 'undefined') module.exports = profileApi;

function initProfilePage() {
  const $ = (id) => document.getElementById(id);
  const base = new URL('../', location.href);
  const query = new URLSearchParams(location.search);
  let builderKey = PROFILE_KEY_PATTERN.test(query.get('builder') || '') ? query.get('builder') : null;
  const state = StewardParticipation.load();
  let thread = null;
  let manifest = null;
  let identity = readIdentity();
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

  function openModal(modal) { if (modal) { modal.hidden = false; modal.classList.add('open'); } }
  function closeModal(modal) { if (modal) { modal.classList.remove('open'); modal.hidden = true; } }

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

  function payload() {
    return StewardParticipation.exportPayload(state);
  }

  function showPayloadBox(text, message) {
    $('activity-payload').value = text;
    openModal($('activity-modal'));
    if (message) toast(message);
  }

  async function copyPayload(doc, message) {
    const text = JSON.stringify(doc, null, 2);
    if (!navigator.clipboard?.writeText) return showPayloadBox(text, 'Copy the payload from this box.');
    try {
      await navigator.clipboard.writeText(text);
      toast(message || 'Payload copied — send it to the coordinator on Discord.');
    } catch {
      showPayloadBox(text, 'Clipboard unavailable. Copy the payload from this box.');
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

  /* ---- Discord ---- */

  function readIdentity() {
    try {
      const raw = sessionStorage.getItem(DISCORD_IDENTITY_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && parsed.id ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeIdentity(value) {
    try {
      if (value) sessionStorage.setItem(DISCORD_IDENTITY_KEY, JSON.stringify(value));
      else sessionStorage.removeItem(DISCORD_IDENTITY_KEY);
    } catch {
      // A private window with storage blocked: the identity lives for this page load only.
    }
    identity = value || null;
  }

  function clientId() {
    return (document.querySelector('meta[name="discord-client-id"]')?.content || '').trim();
  }

  function startSignIn() {
    const id = clientId();
    if (!id || !builderKey) return;
    const nonce = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    try { sessionStorage.setItem(DISCORD_NONCE_KEY, nonce); } catch { return toast('This browser blocks session storage; sign-in cannot complete here.'); }
    const redirect = `${location.origin}${location.pathname}`;
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('response_type', 'token');
    url.searchParams.set('client_id', id);
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.set('state', `${nonce}.${builderKey}`);
    url.searchParams.set('prompt', 'none');
    location.assign(url.href);
  }

  // Back from Discord: the token is used once, for who this is, and dropped.
  async function finishSignIn() {
    if (!location.hash.includes('access_token=')) return;
    let nonce = null;
    try { nonce = sessionStorage.getItem(DISCORD_NONCE_KEY); sessionStorage.removeItem(DISCORD_NONCE_KEY); } catch { nonce = null; }
    const grant = parseDiscordFragment(location.hash, nonce);
    const restored = grant && grant.builderKey ? `?builder=${grant.builderKey}` : location.search;
    history.replaceState(null, '', `${location.pathname}${restored}`);
    if (grant && grant.builderKey) builderKey = grant.builderKey;
    if (!grant) {
      toast('That sign-in did not come from this page; ignored.');
      return;
    }
    try {
      const response = await fetch('https://discord.com/api/users/@me', {headers: {Authorization: `${grant.tokenType} ${grant.token}`}});
      if (!response.ok) throw new Error(`Discord answered ${response.status}`);
      const me = await response.json();
      writeIdentity({id: String(me.id), username: me.username || '', globalName: me.global_name || '', avatar: me.avatar || null});
      toast(`Signed in as ${me.global_name || me.username}.`);
    } catch {
      toast('Discord did not say who you are; try signing in again.');
    }
  }

  function renderDiscord() {
    const on = !!clientId();
    $('discord-off').hidden = on;
    $('discord-on').hidden = !on;
    const signed = !!identity;
    $('discord-signin').hidden = signed;
    $('discord-identity').hidden = !signed;
    if (signed) {
      $('discord-name').textContent = identity.globalName ? `${identity.globalName} (@${identity.username})` : `@${identity.username}`;
      const avatar = $('discord-avatar');
      if (identity.avatar) {
        avatar.src = `https://cdn.discordapp.com/avatars/${identity.id}/${identity.avatar}.webp?size=64`;
        avatar.hidden = false;
      } else {
        avatar.hidden = true;
      }
    }
    renderPortraitGate();
    renderOptOut();
  }

  /* ---- the relay ---- */

  async function relay(kind, extra = {}) {
    const sentAt = new Date().toISOString();
    const receipt = receiptId(builderKey, sentAt, kind);
    const message = relayMessage({kind, builder: thread, discord: identity, receipt, pageUrl: location.href, ...extra});
    const body = new FormData();
    body.append('payload_json', JSON.stringify(message));
    body.append('files[0]', new Blob([JSON.stringify(payload(), null, 2)], {type: 'application/json'}), 'payload.json');
    try {
      const response = await fetch(new URL(PROFILE_RELAY_PATH, base), {method: 'POST', body, credentials: 'omit'});
      if (!response.ok) throw new Error(`relay answered ${response.status}`);
      return {ok: true, receipt, sentAt};
    } catch (error) {
      return {ok: false, receipt, sentAt, error: String(error && error.message || error)};
    }
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

  function hasStanding() {
    return !!identity || !!StewardParticipation.standingForBuilder(state, thread);
  }

  function renderPortraitGate() {
    const gate = $('portrait-gate');
    const pick = $('portrait-pick');
    const libraries = !!(manifest && manifest.libraries);
    const standing = hasStanding();
    pick.disabled = !(libraries && standing && pickerMounted);
    $('portrait-archive-pick').disabled = !(standing && StewardParticipation.portraitForBuilder(state, builderKey)?.tile);
    if (!libraries) gate.textContent = 'The portrait library has not reached this page yet.';
    else if (!standing) gate.textContent = clientId()
      ? 'Sign in with Discord above, or claim one of your builds on your builder page, to choose a portrait.'
      : 'Claim one of your builds on your builder page ("I built this") to choose a portrait here.';
    else gate.textContent = '';
  }

  function renderPortrait() {
    paintFace($('portrait-current'), currentFace());
    const archive = archiveFace();
    paintFace($('portrait-archive'), archive);
    $('portrait-archive').parentElement.hidden = !archive;
    const choice = StewardParticipation.portraitForBuilder(state, builderKey);
    const note = $('portrait-note');
    const send = $('portrait-send');
    if (choice) {
      note.textContent = choice.sentAt
        ? `Recorded on this device and sent · receipt ${choice.receipt}`
        : (choice.tile ? 'Portrait recorded on this device. Send it so the coordinator can confirm it.' : "Back to the archive's pick, recorded on this device.");
      note.hidden = false;
      send.hidden = !!choice.sentAt;
      $('portrait-current-caption').textContent = choice.tile ? 'Worn now · your choice on this device' : 'Worn now';
    } else {
      note.hidden = true;
      send.hidden = true;
      $('portrait-current-caption').textContent = thread && thread.portrait && thread.portrait.by === 'builder' ? 'Worn now · your confirmed choice' : 'Worn now';
    }
    renderPortraitGate();
  }

  function onChoose(choice) {
    StewardParticipation.setPortrait(state, {
      builderKey,
      tile: choice ? choice.tile : null,
      take: choice ? choice.take : null,
      sha: choice ? choice.sha : null,
      participant: state.participant,
    });
    save();
    if (typeof StewardPortraitPicker === 'object') StewardPortraitPicker.update({choice: StewardParticipation.portraitForBuilder(state, builderKey)});
    renderPortrait();
    toast(choice ? 'Portrait recorded on this device.' : "Back to the archive's pick.");
  }

  async function sendPortrait() {
    const choice = StewardParticipation.portraitForBuilder(state, builderKey);
    if (!choice) return;
    $('portrait-send').disabled = true;
    const result = await relay('portrait', {portrait: choice});
    $('portrait-send').disabled = false;
    if (result.ok) {
      Object.assign(choice, {sentAt: result.sentAt, receipt: result.receipt, deliveryStatus: 'sent'});
      save();
      renderPortrait();
      toast(`Sent · receipt ${result.receipt}`);
    } else {
      showPayloadBox(JSON.stringify(payload(), null, 2),
        `The relay is not answering (${result.error}). Send this payload by hand and quote ${result.receipt}.`);
    }
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

  /* ---- the opt-out ---- */

  function chosenLevel() {
    const checked = document.querySelector('input[name="optout-level"]:checked');
    return checked ? checked.value : 'none';
  }

  function renderOptOut() {
    const existing = StewardParticipation.optOutForBuilder(state, builderKey);
    if (existing) {
      const radio = document.querySelector(`input[name="optout-level"][value="${existing.level}"]`);
      if (radio && !radio.checked && !document.querySelector('input[name="optout-level"]:focus')) radio.checked = true;
      if (existing.note && !$('optout-note').value) $('optout-note').value = existing.note;
    }
    const level = chosenLevel();
    const send = $('optout-send');
    send.disabled = level === 'none';
    send.textContent = existing && existing.sentAt && existing.level === level ? 'Send again' : 'Send request';
    const receipt = $('optout-receipt');
    if (existing && existing.sentAt) {
      receipt.textContent = `Request sent · receipt ${existing.receipt} · the coordinator confirms on Discord.`;
      receipt.hidden = false;
    } else if (existing) {
      receipt.textContent = 'Recorded on this device, not sent yet.';
      receipt.hidden = false;
    } else {
      receipt.hidden = true;
    }
  }

  async function sendOptOut() {
    const level = chosenLevel();
    if (level === 'none') return;
    const record = StewardParticipation.setOptOut(state, {
      builderKey, level, note: $('optout-note').value, participant: state.participant, discord: identity,
    });
    if (!record) return;
    save();
    $('optout-send').disabled = true;
    const result = await relay('optout', {level, note: record.note});
    if (result.ok) {
      record.sentAt = result.sentAt;
      record.receipt = result.receipt;
      save();
      renderOptOut();
      toast(`Request sent · receipt ${result.receipt}`);
    } else {
      renderOptOut();
      showPayloadBox(JSON.stringify(payload(), null, 2),
        `The relay is not answering (${result.error}). Send this payload by hand and quote ${result.receipt}.`);
    }
    $('optout-send').disabled = chosenLevel() === 'none';
  }

  /* ---- boot ---- */

  function wire() {
    $('discord-signin').onclick = startSignIn;
    $('discord-signout').onclick = () => { writeIdentity(null); renderDiscord(); toast('Signed out.'); };
    $('portrait-pick').onclick = () => { if (pickerMounted) StewardPortraitPicker.open(); };
    $('portrait-archive-pick').onclick = () => onChoose(null);
    $('portrait-send').onclick = sendPortrait;
    $('optout-send').onclick = sendOptOut;
    $('optout-copy').onclick = () => copyPayload(payload());
    for (const radio of document.querySelectorAll('input[name="optout-level"]')) radio.addEventListener('change', renderOptOut);
    $('activity-copy').onclick = () => copyPayload(JSON.parse($('activity-payload').value || '{}'), 'Payload copied.');
    $('activity-close').onclick = () => closeModal($('activity-modal'));
    $('activity-modal').addEventListener('click', (event) => { if (event.target === $('activity-modal')) closeModal($('activity-modal')); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal($('activity-modal')); });
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
    await finishSignIn();
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
    if (face && face.library !== 'slate48' && face.url('wide768')) {
      wide.src = face.url('wide768');
      wide.hidden = false;
    }
    $('status').textContent = '';
    for (const id of ['profile-head', 'profile-who', 'profile-portrait', 'profile-optout', 'profile-about']) $(id).hidden = false;
    mountPicker();
    renderDiscord();
    renderPortrait();
    renderOptOut();
  }

  boot();
}

if (typeof document !== 'undefined' && document.documentElement.dataset.stewardPage === 'profile') initProfilePage();
