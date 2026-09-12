'use strict';

// The portrait picker: a drawer on the builder profile where the builder narrows the
// archive's portrait library by a few facets, opens one portrait's takes, sees the cut the
// hero card and the ribbon will actually wear, and chooses -- or hands the choice back to
// the archive's slot rule. Preview mode (S2): the choice lands on this device's ledger
// through ctx.onChoose and every face on the page repaints; nothing leaves the browser.
//
// The narrowing is the era viewer's drawer mechanic (tools/selfie-stick/gallery/index.html
// `counts()` / `syncPanel()`), ported because that page keeps its script inline: the same
// contracts by name -- `.panel`, `.grp`, `.ck[aria-pressed]`, `.ck.zero` dimmed and kept,
// `Clear all` -- so the studies made against the viewer still read here. Each option says
// how many portraits a click on it would leave, given everything ELSE selected; a tile
// with no tag on a facet matches any value there, so the slate tiles are never narrowed
// into oblivion by a facet only the painted library carries.
//
// Classic script: everything lives in this closure; the page sees StewardPortraitPicker.
(function () {
  const SLATE = 'slate48';
  const LIST_ROWS = 8;
  const state = {
    host: null, ctx: null, manifest: null, facets: [], tiles: [], sel: {}, opts: [], groups: [],
    lastSig: null, selectedTile: null, selectedTake: null, open: false, onKey: null, els: {},
  };

  /* ---- small makers ---- */

  function node(tag, text, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function button(text, cls) {
    const el = node('button', text, cls);
    el.type = 'button';
    return el;
  }

  function portraits() {
    return typeof StewardPortraits === 'object' ? StewardPortraits : null;
  }

  /* ---- reading the manifest ---- */

  // A tile's facet tags as one object: library rows carry them so; a slate row carries
  // `tagMap` from v2 and a positional list before that.
  function tagsOf(tile) {
    if (tile.tags && !Array.isArray(tile.tags)) return tile.tags;
    if (tile.tagMap && typeof tile.tagMap === 'object') return tile.tagMap;
    if (Array.isArray(tile.tags)) {
      const out = {};
      ['role', 'age', 'presentation'].forEach((facet, i) => { if (tile.tags[i]) out[facet] = tile.tags[i]; });
      return out;
    }
    return {};
  }

  // The Trade menu folds the slate names onto the painted library's where they mean the
  // same trade (joiner -> carpenter), so one option counts both.
  function tagOf(tile, facet) {
    const raw = tagsOf(tile)[facet];
    if (!raw) return null;
    const aliases = state.manifest.aliases && state.manifest.aliases[facet];
    return (aliases && aliases[raw]) || raw;
  }

  function label(facet, token) {
    return portraits().labelFor(state.manifest, facet, token);
  }

  function facetsOf(manifest) {
    const facets = Array.isArray(manifest.facets) && manifest.facets.length ? manifest.facets : [
      {tag: 'role', label: 'Trade', kind: 'dropdown'},
      {tag: 'presentation', label: 'Presentation', kind: 'segmented'},
      {tag: 'age', label: 'Age', kind: 'segmented'},
    ];
    return facets.map((f) => ({tag: f.tag, label: f.label || f.tag, kind: f.kind || 'dropdown'}));
  }

  function takesOf(tile) {
    if (Array.isArray(tile.takes) && tile.takes.length) return tile.takes;
    // A slate tile is one take: the tile itself.
    return [{id: null, v: tile.v, files: null}];
  }

  function faceOf(tile, take) {
    const P = portraits();
    const takeId = take && take.id;
    const chosen = P.tileById(state.manifest, P.qualifiedId(tile));
    if (!chosen) return null;
    // No take named means the first picked take -- the grid shows each portrait by it. A
    // tile's cuts are one pattern with {take} in it, so a take is needed to spell a URL;
    // takeOf answers the first when none is named and null for a tile without takes.
    const real = P.takeOf(chosen, takeId);
    // Resolve through the same cut logic the page uses, for this specific take.
    const cuts = P.cutsOf(chosen, real);
    const base = state.manifest.base || '/chronicles/img/portraits/';
    const v = (real && real.v) || chosen.v || '';
    const url = (role) => {
      const order = {bust128: ['bust128', 'bust256', 'bust512', 'wide768'], bust256: ['bust256', 'bust512', 'bust128', 'wide768'],
        wide768: ['wide768', 'bust512', 'bust256', 'bust128']}[role] || [role];
      for (const name of order) if (cuts[name]) return `${base}${cuts[name]}${v ? `?v=${v}` : ''}`;
      return null;
    };
    return {tile: chosen, take: real, url, alt: P.altFor(state.manifest, chosen), id: P.qualifiedId(chosen)};
  }

  /* ---- counting ---- */

  // One pass, one bit per facet. `any[k]` counts the tiles that pass every other facet and
  // carry no tag on k at all: they would remain whichever value of k were picked, so they
  // are added to every option of that facet.
  function counts() {
    const n = state.facets.length;
    const all = (1 << n) - 1;
    const c = state.facets.map(() => new Map());
    const any = state.facets.map(() => 0);
    let visible = 0;
    for (const tile of state.tiles) {
      let m = 0;
      const tags = state.facets.map((f) => tagOf(tile, f.tag));
      state.facets.forEach((f, k) => {
        const set = state.sel[f.tag];
        if (!set.size || tags[k] == null || set.has(tags[k])) m |= (1 << k);
      });
      if (m === all) visible += 1;
      state.facets.forEach((f, k) => {
        if ((m | (1 << k)) !== all) return;
        if (tags[k] == null) any[k] += 1;
        else c[k].set(tags[k], (c[k].get(tags[k]) || 0) + 1);
      });
    }
    return {c, any, visible};
  }

  function visibleTiles() {
    return state.tiles.filter((tile) => state.facets.every((f) => {
      const set = state.sel[f.tag];
      const tag = tagOf(tile, f.tag);
      return !set.size || tag == null || set.has(tag);
    })).sort((a, b) => {
      const ta = label('role', tagOf(a, 'role') || ''), tb = label('role', tagOf(b, 'role') || '');
      if (ta !== tb) return ta.localeCompare(tb);
      const pa = tagOf(a, 'presentation') || '', pb = tagOf(b, 'presentation') || '';
      if (pa !== pb) return pa.localeCompare(pb);
      return String(a.id).localeCompare(String(b.id));
    });
  }

  /* ---- the drawer ---- */

  function buildDrawer() {
    const {host} = state;
    host.replaceChildren();
    const scrim = node('div', null, 'pp-scrim');
    scrim.hidden = true;
    scrim.addEventListener('click', close);
    const drawer = node('aside', null, 'drawer pp-drawer');
    drawer.id = 'portrait-picker';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-labelledby', 'pp-title');
    drawer.hidden = true;

    // Plain divs, not <header>/<footer>: the page styles those elements for its own chrome.
    const head = node('div', null, 'pp-head');
    const title = node('h2', 'Choose a portrait', 'pp-title');
    title.id = 'pp-title';
    const closeBtn = button('×', 'pp-close');
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', close);
    const chips = node('div', null, 'pp-chips');
    chips.id = 'pp-chips';
    const count = node('p', '', 'pp-count');
    count.id = 'pp-count';
    count.setAttribute('aria-live', 'polite');
    head.append(title, closeBtn, count, chips);

    const body = node('div', null, 'pp-body');
    const panel = node('section', null, 'panel pp-panel');
    panel.id = 'pp-panel';
    panel.setAttribute('aria-label', 'Narrow the portraits');
    const results = node('section', null, 'pp-results');
    results.id = 'pp-results';
    results.setAttribute('aria-label', 'Portraits');
    const detail = node('section', null, 'pp-detail');
    detail.id = 'pp-detail';
    detail.hidden = true;
    body.append(panel, results, detail);

    const foot = node('div', null, 'dfoot pp-foot');
    const clear = button('Clear all', 'clr pp-clear');
    clear.id = 'pp-clear';
    clear.addEventListener('click', () => { clearAll(); render(); });
    const surprise = button('Surprise me', 'pp-surprise');
    surprise.id = 'pp-surprise';
    surprise.addEventListener('click', surpriseMe);
    const archive = button("Use the archive's pick", 'pp-archive');
    archive.id = 'pp-archive';
    archive.addEventListener('click', () => { choose(null); });
    const chooseBtn = button('Choose', 'act pri pp-choose');
    chooseBtn.id = 'pp-choose';
    chooseBtn.disabled = true;
    chooseBtn.addEventListener('click', () => {
      if (!state.selectedTile) return;
      const face = faceOf(state.selectedTile, state.selectedTake);
      if (!face) return;
      choose({tile: face.id, take: face.take ? face.take.id : null, sha: face.take ? face.take.sha || null : null});
    });
    foot.append(clear, surprise, archive, chooseBtn);

    drawer.append(head, body, foot);
    host.append(scrim, drawer);
    state.els = {scrim, drawer, closeBtn, chips, count, panel, results, detail, chooseBtn, archive};
    buildPanel();
  }

  // Built once from every value in the library; syncPanel patches counts and pressed
  // state in place afterwards, so scroll position and focus survive a click.
  function buildPanel() {
    const {panel} = state.els;
    panel.replaceChildren();
    state.opts = [];
    state.groups = [];
    for (const facet of state.facets) {
      const values = new Map();
      for (const tile of state.tiles) {
        const tag = tagOf(tile, facet.tag);
        if (tag != null) values.set(tag, (values.get(tag) || 0) + 1);
      }
      if (!values.size) continue;
      const list = facet.kind !== 'segmented';
      const group = node('section', null, `grp${list ? ' list' : ' seg'}`);
      group.dataset.k = facet.tag;
      const h = node('h3', facet.label, 'grp-h');
      group.append(h);
      const wrap = node('div', null, 'grp-opts');
      // A list reads alphabetically; a segmented row keeps the vocabulary's own order
      // (young · adult · elder), which the manifest's label table preserves.
      const vocabOrder = Object.keys((state.manifest.labels || {})[facet.tag] || {});
      const rank = (value) => { const i = vocabOrder.indexOf(value); return i < 0 ? vocabOrder.length : i; };
      const sorted = [...values.entries()].sort((a, b) => list
        ? label(facet.tag, a[0]).localeCompare(label(facet.tag, b[0]))
        : rank(a[0]) - rank(b[0]) || label(facet.tag, a[0]).localeCompare(label(facet.tag, b[0])));
      sorted.forEach(([value], index) => {
        const ck = button(null, `ck${list ? ' row' : ''}`);
        ck.dataset.k = facet.tag;
        ck.dataset.v = value;
        ck.setAttribute('aria-pressed', 'false');
        const text = node('span', label(facet.tag, value), 'ck-label');
        const cnt = node('span', '', 'cnt');
        ck.append(text, cnt);
        if (list && index >= LIST_ROWS) ck.classList.add('overflow');
        ck.addEventListener('click', () => { toggle(facet.tag, value); render(); });
        wrap.append(ck);
        state.opts.push({k: facet.tag, v: value, el: ck, cnt});
      });
      group.append(wrap);
      if (list && sorted.length > LIST_ROWS) {
        const more = button(`Show all ${sorted.length}`, 'more');
        more.setAttribute('aria-expanded', 'false');
        more.addEventListener('click', () => {
          const expanded = group.classList.toggle('expanded');
          more.setAttribute('aria-expanded', String(expanded));
          more.textContent = expanded ? 'Show fewer' : `Show all ${sorted.length}`;
        });
        group.append(more);
      }
      panel.append(group);
      state.groups.push({facet, el: group});
    }
  }

  function toggle(facet, value) {
    const set = state.sel[facet];
    if (set.has(value)) set.delete(value); else set.add(value);
    state.selectedTile = null;
    state.selectedTake = null;
  }

  function clearAll() {
    for (const facet of state.facets) state.sel[facet.tag].clear();
    state.selectedTile = null;
    state.selectedTake = null;
  }

  function sig() {
    return state.facets.map((f) => [...state.sel[f.tag]].sort().join(',')).join('|');
  }

  function syncPanel() {
    const {c, any, visible} = counts();
    for (const o of state.opts) {
      const k = state.facets.findIndex((f) => f.tag === o.k);
      const n = (c[k].get(o.v) || 0) + any[k];
      const on = state.sel[o.k].has(o.v);
      o.cnt.textContent = String(n);
      o.el.classList.toggle('zero', !n);
      o.el.classList.toggle('on', on);
      o.el.setAttribute('aria-pressed', String(on));
    }
    state.els.count.textContent = `${visible} portrait${visible === 1 ? '' : 's'}`;
    syncChips();
    return visible;
  }

  function syncChips() {
    const {chips} = state.els;
    chips.replaceChildren();
    for (const facet of state.facets) {
      for (const value of state.sel[facet.tag]) {
        const chip = button(null, 'pp-chip');
        chip.append(node('span', `${facet.label}: ${label(facet.tag, value)}`), node('span', '×', 'pp-chip-x'));
        chip.setAttribute('aria-label', `Remove ${facet.label} ${label(facet.tag, value)}`);
        chip.addEventListener('click', () => { toggle(facet.tag, value); render(); });
        chips.append(chip);
      }
    }
    chips.hidden = !chips.children.length;
  }

  /* ---- results, takes, preview ---- */

  function tileButton(tile) {
    const face = faceOf(tile, null);
    const btn = button(null, 'pp-tile');
    btn.dataset.tile = face.id;
    btn.setAttribute('aria-pressed', String(state.selectedTile === tile));
    const img = document.createElement('img');
    img.alt = face.alt;
    img.width = 128;
    img.height = 128;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = face.url('bust128');
    const cap = node('span', label('role', tagOf(tile, 'role') || ''), 'pp-tile-label');
    btn.append(img, cap);
    const chips = Array.isArray(tile.chips) ? tile.chips : [];
    if (chips.length) {
      const row = node('span', null, 'pp-tile-chips');
      for (const chip of chips) row.append(node('span', chip.replace(/^companion:/, '').replace(/-/g, ' '), 'chip pp-mini'));
      btn.append(row);
    }
    btn.addEventListener('click', () => { selectTile(tile); });
    return btn;
  }

  function renderResults() {
    const {results, detail} = state.els;
    results.replaceChildren();
    const tiles = visibleTiles();
    if (!tiles.length) {
      results.append(node('p', 'Nothing wears every one of those. Clear a facet.', 'muted pp-empty'));
    } else {
      const grid = node('div', null, 'pp-grid');
      for (const tile of tiles) grid.append(tileButton(tile));
      results.append(grid);
    }
    results.hidden = !!state.selectedTile;
    detail.hidden = !state.selectedTile;
    if (state.selectedTile) renderDetail();
  }

  function selectTile(tile) {
    state.selectedTile = tile;
    const takes = takesOf(tile);
    state.selectedTake = takes[0] || null;
    render();
    const first = state.els.detail.querySelector('.pp-take[aria-pressed="true"]') || state.els.detail.querySelector('.pp-back');
    if (first) first.focus();
  }

  function renderDetail() {
    const {detail, chooseBtn} = state.els;
    detail.replaceChildren();
    const tile = state.selectedTile;
    const back = button('‹ All portraits', 'kin-open pp-back');
    back.addEventListener('click', () => { state.selectedTile = null; state.selectedTake = null; render(); });
    detail.append(back);
    const heading = node('h3', label('role', tagOf(tile, 'role') || ''), 'pp-detail-h');
    detail.append(heading);
    const line = [];
    for (const f of state.facets) {
      if (f.tag === 'role') continue;
      const t = tagOf(tile, f.tag);
      if (t) line.push(label(f.tag, t));
    }
    if (line.length) detail.append(node('p', line.join(' · '), 'pp-detail-line'));

    const takes = takesOf(tile);
    if (takes.length > 1 || takes[0].id) {
      const strip = node('div', null, 'pp-strip');
      strip.setAttribute('role', 'radiogroup');
      strip.setAttribute('aria-label', 'Takes');
      for (const take of takes) {
        const face = faceOf(tile, take);
        const b = button(null, 'pp-take');
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(take === state.selectedTake));
        b.setAttribute('aria-pressed', String(take === state.selectedTake));
        b.dataset.take = take.id || '';
        const img = document.createElement('img');
        img.alt = '';
        img.width = 96;
        img.height = 96;
        img.decoding = 'async';
        img.src = face.url('bust256');
        b.append(img);
        b.addEventListener('click', () => { state.selectedTake = take; render(); b.focus(); });
        strip.append(b);
      }
      detail.append(node('p', `${takes.length} take${takes.length === 1 ? '' : 's'}`, 'eyebrow pp-eyebrow'), strip);
    }

    // The preview is the two cuts the builder is actually choosing: the hero card's and
    // the 40-px row every ribbon, tree and card draws.
    const face = faceOf(tile, state.selectedTake);
    const preview = node('div', null, 'pp-preview');
    const heroWrap = node('div', null, 'pp-preview-hero');
    const wide = document.createElement('img');
    wide.alt = face.alt;
    wide.className = 'pp-preview-wide';
    wide.decoding = 'async';
    wide.src = face.url('wide768');
    const avatar = document.createElement('img');
    avatar.alt = '';
    avatar.className = 'pp-preview-avatar';
    avatar.width = 160;
    avatar.height = 160;
    avatar.decoding = 'async';
    avatar.src = face.url('bust256');
    heroWrap.append(wide, avatar);
    const row = node('div', null, 'pp-preview-row');
    const small = document.createElement('img');
    small.alt = '';
    small.width = 40;
    small.height = 40;
    small.decoding = 'async';
    small.src = face.url('bust128');
    row.append(small, node('span', 'how the ribbon, the tree and the pair card draw it', 'muted'));
    preview.append(heroWrap, row);
    detail.append(preview);
    chooseBtn.disabled = false;
  }

  function render() {
    if (!state.host) return;
    state.lastSig = sig();
    syncPanel();
    renderResults();
    state.els.chooseBtn.disabled = !state.selectedTile;
    const choice = state.ctx && state.ctx.choice;
    state.els.archive.disabled = !(choice && choice.tile);
  }

  function surpriseMe() {
    const tiles = visibleTiles();
    if (!tiles.length) return;
    const tile = tiles[Math.floor(Math.random() * tiles.length)];
    const takes = takesOf(tile);
    state.selectedTile = tile;
    state.selectedTake = takes[Math.floor(Math.random() * takes.length)];
    render();
    const btn = state.els.chooseBtn;
    if (btn) btn.focus();
  }

  function choose(choice) {
    if (state.ctx && typeof state.ctx.onChoose === 'function') state.ctx.onChoose(choice);
    close();
  }

  /* ---- open, close, keys ---- */

  function focusables() {
    return [...state.els.drawer.querySelectorAll('button:not([disabled]), [href], input, select, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.hidden && el.offsetParent !== null);
  }

  function onKey(event) {
    if (!state.open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }

  function open() {
    if (!state.host || state.open) return;
    state.open = true;
    state.els.scrim.hidden = false;
    state.els.drawer.hidden = false;
    document.documentElement.classList.add('pp-open');
    // Open on the current choice's tile when there is one, so "change it" is one step.
    const choice = state.ctx && state.ctx.choice;
    if (choice && choice.tile) {
      const tile = portraits().tileById(state.manifest, choice.tile);
      if (tile) {
        state.selectedTile = tile;
        state.selectedTake = takesOf(tile).find((t) => t.id === choice.take) || takesOf(tile)[0];
      }
    }
    render();
    state.els.closeBtn.focus();
  }

  function close() {
    if (!state.host || !state.open) return;
    state.open = false;
    state.els.scrim.hidden = true;
    state.els.drawer.hidden = true;
    document.documentElement.classList.remove('pp-open');
    const back = state.ctx && state.ctx.returnFocus;
    const target = typeof back === 'function' ? back() : back;
    if (target && typeof target.focus === 'function') target.focus();
  }

  /* ---- entry points ---- */

  // `host` is an empty element creators.js owns; `ctx` = {manifest, builderKey, choice,
  // onChoose(choice | null), returnFocus}. Mounting without libraries in the manifest is a
  // no-op that returns false: the profile then shows no picker control at all.
  function mount(host, ctx) {
    unmount();
    const P = portraits();
    if (!host || !ctx || !ctx.manifest || !P) return false;
    if (!ctx.manifest.libraries || typeof ctx.manifest.libraries !== 'object') return false;
    state.host = host;
    state.ctx = ctx;
    state.manifest = ctx.manifest;
    state.facets = facetsOf(ctx.manifest);
    state.tiles = P.tilesOf(ctx.manifest).filter((tile) => tile && tile.id);
    state.sel = {};
    for (const facet of state.facets) state.sel[facet.tag] = new Set();
    state.lastSig = null;
    state.selectedTile = null;
    state.selectedTake = null;
    host.classList.add('pp-host');
    buildDrawer();
    state.onKey = onKey;
    document.addEventListener('keydown', state.onKey);
    return true;
  }

  function update(patch) {
    if (!state.host || !patch) return;
    if (patch.choice !== undefined && state.ctx) state.ctx.choice = patch.choice;
    if (state.open) render();
  }

  function unmount() {
    if (state.onKey) document.removeEventListener('keydown', state.onKey);
    if (state.open) close();
    if (state.host) {
      state.host.replaceChildren();
      state.host.classList.remove('pp-host');
    }
    state.host = null;
    state.ctx = null;
    state.manifest = null;
    state.tiles = [];
    state.opts = [];
    state.groups = [];
    state.onKey = null;
    state.els = {};
  }

  // Pure pieces for the Node test: the count mask and the visible set, over a manifest
  // and a selection, without a document.
  function countsFor(manifest, selection) {
    const P = portraits();
    const saved = {manifest: state.manifest, facets: state.facets, tiles: state.tiles, sel: state.sel};
    state.manifest = manifest;
    state.facets = facetsOf(manifest);
    state.tiles = P.tilesOf(manifest).filter((t) => t && t.id);
    state.sel = {};
    for (const facet of state.facets) state.sel[facet.tag] = new Set((selection && selection[facet.tag]) || []);
    try {
      const {c, any, visible} = counts();
      const options = {};
      state.facets.forEach((f, k) => {
        options[f.tag] = {};
        const values = new Set();
        for (const tile of state.tiles) { const t = tagOf(tile, f.tag); if (t != null) values.add(t); }
        for (const value of values) options[f.tag][value] = (c[k].get(value) || 0) + any[k];
      });
      return {visible, options};
    } finally {
      Object.assign(state, saved);
    }
  }

  const api = {mount, open, close, update, unmount, countsFor, tagsOf};
  globalThis.StewardPortraitPicker = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
