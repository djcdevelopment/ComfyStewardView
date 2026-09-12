'use strict';

// Which face a builder wears, answered once for every surface that draws one: the hero
// card, the Top 8 ribbon, the kinship tree, the pair card, the picker. Before this file
// each of them read /chronicles/portraits.json its own way and spelled the URL itself;
// they agreed by luck. Classic script, shared with the Node tests through module.exports;
// nothing here is a top-level declaration because creators.js already owns the names
// `portraitIndex` and friends and a page loads both.
//
//   StewardPortraits.portraitFor(key, manifest)            -> {tile, take, library, alt, url(role)} | null
//   StewardPortraits.setChoices({builderKey: choice})      -> the choices recorded on this device
//
// Order of precedence: a choice recorded on this device (the picker's local ledger, S2)
// -> the choice the archive published for the builder (`builder.portrait`, S3 onwards)
// -> the default library's slot (parseInt(key[:8], 16) % count, unchanged since v1)
// -> null, and the caller draws the emblem. A manifest from before libraries existed
// (schema v1) resolves exactly as it always did.
(function () {
  const DEFAULT_BASE = '/chronicles/img/portraits/';
  const SLATE = 'slate48';
  // Which cut answers for which role when a tile does not carry the one asked for. A slate
  // tile has bust128 + bust512; a library take has bust128 + bust256 + wide768.
  const CUT_FALLBACKS = {
    bust128: ['bust128', 'bust256', 'bust512', 'wide768'],
    bust256: ['bust256', 'bust512', 'bust128', 'wide768'],
    bust512: ['bust512', 'wide768', 'bust256', 'bust128'],
    wide768: ['wide768', 'bust512', 'bust256', 'bust128'],
  };
  const HEX32 = /^[a-f0-9]{32}$/;

  let deviceChoices = {};
  let publishedChoices = {};

  // The slot rule, byte for byte the one creators.js and gateway.js apply: the first eight
  // hex digits of the key, modulo the count, never negative, 0 when nothing parses.
  function slotIndex(builderKey, count) {
    const parsed = parseInt(String(builderKey || '').slice(0, 8), 16);
    if (!Number.isFinite(parsed) || !count) return 0;
    return ((parsed % count) + count) % count;
  }

  function tilesOf(manifest) {
    return manifest && Array.isArray(manifest.tiles) ? manifest.tiles : [];
  }

  function libraryOf(tile) {
    return (tile && tile.library) || SLATE;
  }

  // The library unchosen builders wear. `libraries.<id>.default` when the manifest has
  // libraries (FR-10: flipping it is a manifest edit, not a migration); before that, the
  // whole tile list is the default library.
  function defaultLibrary(manifest) {
    const libraries = manifest && manifest.libraries;
    if (!libraries || typeof libraries !== 'object') return null;
    for (const [id, entry] of Object.entries(libraries)) {
      if (entry && entry.default) return id;
    }
    return SLATE;
  }

  function defaultPool(manifest) {
    const tiles = tilesOf(manifest);
    const library = defaultLibrary(manifest);
    if (!library) {
      const count = Number(manifest && manifest.count) || 0;
      return tiles.slice(0, count || tiles.length);
    }
    return tiles.filter((tile) => libraryOf(tile) === library);
  }

  function qualifiedId(tile) {
    return `${libraryOf(tile)}/${tile.id}`;
  }

  // `library/id` is the address a choice records; a bare id (a v1 `p07`) answers too, the
  // first tile that carries it.
  function tileById(manifest, id) {
    if (!id) return null;
    const wanted = String(id);
    const tiles = tilesOf(manifest);
    return tiles.find((tile) => qualifiedId(tile) === wanted) || tiles.find((tile) => tile.id === wanted) || null;
  }

  function takeOf(tile, takeId) {
    const takes = Array.isArray(tile && tile.takes) ? tile.takes : [];
    if (!takes.length) return null;
    return takes.find((take) => take.id === takeId) || takes[0];
  }

  // The cuts a tile+take can serve, as paths under `base`. A library tile spells each cut
  // once with `{take}` where the take id goes (a take may still carry its own `files`);
  // a slate row spells them under `cuts` from v2 and under file/thumb before that.
  function cutsOf(tile, take) {
    if (take && take.files && typeof take.files === 'object') return take.files;
    if (tile.cuts && typeof tile.cuts === 'object') {
      if (!take || !take.id) return tile.cuts;
      const cuts = {};
      for (const [role, pattern] of Object.entries(tile.cuts)) cuts[role] = String(pattern).split('{take}').join(take.id);
      return cuts;
    }
    const cuts = {};
    if (tile.thumb) cuts.bust128 = tile.thumb;
    if (tile.file) cuts.bust512 = tile.file;
    return cuts;
  }

  function labelFor(manifest, facet, token) {
    const table = manifest && manifest.labels && manifest.labels[facet];
    if (table && table[token]) return table[token];
    return String(token || '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }

  // "Carpenter, woman, red hair, workshop" -- from tags, never a name. Slate rows keep the
  // empty alt they have always had: the name stands beside them.
  function altFor(manifest, tile) {
    if (libraryOf(tile) === SLATE) return '';
    const tags = tile.tags && !Array.isArray(tile.tags) ? tile.tags : {};
    const parts = [];
    if (tags.role) parts.push(labelFor(manifest, 'role', tags.role));
    if (tags.presentation) parts.push(labelFor(manifest, 'presentation', tags.presentation).toLowerCase());
    if (tags.hair && tags.hair !== 'hidden') parts.push(`${labelFor(manifest, 'hair', tags.hair).toLowerCase()} hair`);
    if (tags.setting) parts.push(labelFor(manifest, 'setting', tags.setting).toLowerCase());
    return parts.join(', ');
  }

  function resolve(manifest, tile, take) {
    const base = (manifest && manifest.base) || DEFAULT_BASE;
    const cuts = cutsOf(tile, take);
    const version = (take && take.v) || tile.v || '';
    const url = (role) => {
      for (const name of CUT_FALLBACKS[role] || [role]) {
        if (cuts[name]) return `${base}${cuts[name]}${version ? `?v=${version}` : ''}`;
      }
      return null;
    };
    return {
      tile,
      take: take || null,
      library: libraryOf(tile),
      id: qualifiedId(tile),
      cuts,
      alt: altFor(manifest, tile),
      url,
    };
  }

  function fromChoice(manifest, choice) {
    if (!choice || typeof choice !== 'object' || !choice.tile) return null;
    const tile = tileById(manifest, choice.tile);
    if (!tile) return null;
    return resolve(manifest, tile, takeOf(tile, choice.take));
  }

  // `builder` is a key or a record ({builderKey, portrait}); the published choice rides on
  // the record when the coordinator has confirmed one.
  function portraitFor(builder, manifest) {
    const key = typeof builder === 'string' ? builder : builder && builder.builderKey;
    if (!key || !tilesOf(manifest).length) return null;
    const local = deviceChoices[key];
    if (local && Object.prototype.hasOwnProperty.call(local, 'tile')) {
      const chosen = fromChoice(manifest, local);
      if (chosen) return chosen;
      // A revert (tile: null) or a tile the manifest no longer carries: the default.
      if (local.tile === null) return defaultTile(manifest, key);
    }
    // The archive's published choice: on the record when the caller has one, else in the
    // table the page filled from directory.json / the thread.
    const published = (typeof builder === 'object' && builder && builder.portrait) || publishedChoices[key] || null;
    const confirmed = fromChoice(manifest, published);
    if (confirmed) return confirmed;
    return defaultTile(manifest, key);
  }

  function defaultTile(manifest, key) {
    const pool = defaultPool(manifest);
    if (!pool.length) return null;
    const tile = pool[slotIndex(key, pool.length)];
    return tile ? resolve(manifest, tile, takeOf(tile, null)) : null;
  }

  // The picker's local ledger hands its map here; every consumer repaints through
  // portraitFor afterwards. Keys that are not builder keys are ignored.
  function setChoices(map) {
    deviceChoices = {};
    for (const [key, choice] of Object.entries(map || {})) {
      if (HEX32.test(key) && choice && typeof choice === 'object') deviceChoices[key] = choice;
    }
  }

  // What the coordinator confirmed and gallery.py published on the builders' records
  // (`portrait: {tile, take}`); the page hands them over as directory.json lands. Additive:
  // a page that never calls this resolves the slot for everyone, as before.
  function setPublished(map, {merge = false} = {}) {
    const next = merge ? {...publishedChoices} : {};
    for (const [key, choice] of Object.entries(map || {})) {
      if (HEX32.test(key) && choice && typeof choice === 'object' && choice.tile) next[key] = choice;
    }
    publishedChoices = next;
  }

  const api = {portraitIndex: slotIndex, tilesOf, defaultLibrary, defaultPool, tileById, takeOf, cutsOf,
    labelFor, altFor, portraitFor, defaultTile, setChoices, setPublished, qualifiedId};
  globalThis.StewardPortraits = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
