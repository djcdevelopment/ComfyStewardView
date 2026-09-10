'use strict';

// The Chronicles front door has one job: get a builder to their own page.
//
// The form underneath is still a plain GET to the builders index, so the door works with
// scripting off. Everything here is an accelerant on top of that: the directory is
// prefetched while the visitor is still reading, a name typed into the box is matched
// against the same data the builders index matches against, and Enter on a good match
// goes straight to the profile instead of paying a page load to land on a filtered list.
//
// The ranking is not reimplemented here. The block below is a byte-for-byte copy of the
// live matcher out of tools/era-archive/web/creators.js, and tests/test_matcher_parity.py
// extracts each declaration from both files and compares them, so a change to one side
// that is not made to the other fails the build rather than quietly ranking the door and
// the index differently.

// ---- copied verbatim from tools/era-archive/web/creators.js: begin

// "Builder 8014fa60" is what community.py writes when no single recorded name won.
// Those are real threads and stay searchable, they are just nobody's own name.
const PLACEHOLDER_NAME = /^Builder [0-9a-f]{8}$/;

function searchTerms(builder) {
  return [builder.displayName, ...(builder.aliases || [])].filter(Boolean);
}

function matchScore(builder, q) {
  let best = 3;
  for (const term of searchTerms(builder)) {
    const lower = term.toLocaleLowerCase();
    if (lower === q) best = Math.min(best, 0);
    else if (lower.startsWith(q)) best = Math.min(best, 1);
    else if (lower.includes(q)) best = Math.min(best, 2);
  }
  return best;
}

// Alphabetical on both sides meant the first eighty cards held seventeen photographs
// and opened on "-Boewona-, 4 albums, 0 photos". Photographed and named work first.
// Sorting on photos alone is a trap: that top eight is anonymous "Builder 8014fa60"
// records with 12,770 albums.
function compareBuilders(a, b, q) {
  if (q) {
    const byMatch = matchScore(a, q) - matchScore(b, q);
    if (byMatch) return byMatch;
  }
  const shot = (a.photos > 0 ? 0 : 1) - (b.photos > 0 ? 0 : 1);
  if (shot) return shot;
  const named = (PLACEHOLDER_NAME.test(a.displayName) ? 1 : 0) - (PLACEHOLDER_NAME.test(b.displayName) ? 1 : 0);
  if (named) return named;
  if (a.photos !== b.photos) return b.photos - a.photos;
  if ((b.pieces || 0) !== (a.pieces || 0)) return (b.pieces || 0) - (a.pieces || 0);
  return a.displayName.localeCompare(b.displayName, undefined, {sensitivity: 'base'});
}

// Pure filter composition: search + era + With Albums, in the order applyFilter() uses
// them. Exported so it can be exercised without a DOM.
function filterBuilders(builders, {era, query, withAlbums} = {}) {
  const q = (query || '').trim().toLocaleLowerCase();
  return builders
    .filter((b) => (!era || b.eras.includes(Number(era))))
    .filter((b) => !withAlbums || b.albums > 0)
    .filter((b) => !q || searchTerms(b).some((x) => x.toLocaleLowerCase().includes(q)));
}

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many || one + 's'}`;

// Cards used to render "Era 17 · Era 16 · Era 14 · ...", which wraps to four lines on a
// phone and pushes the photo count out of view. Runs of consecutive eras collapse.
function eraRange(eras) {
  const sorted = [...new Set(eras)].sort((a, b) => a - b);
  if (!sorted.length) return '';
  const runs = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const era of sorted.slice(1)) {
    if (era === previous + 1) { previous = era; continue; }
    runs.push([start, previous]);
    start = previous = era;
  }
  runs.push([start, previous]);
  const label = sorted.length === 1 ? 'era' : 'eras';
  return `${label} ${runs.map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(', ')}`;
}

function builderSummary(b) {
  const parts = [plural(b.albums, 'build')];
  if (b.pieces != null) parts.push(`${b.pieces.toLocaleString()} pieces`);
  if (b.tier) parts.push(b.tier);
  parts.push(`${b.photos.toLocaleString()} photos`);
  const range = eraRange(b.eras);
  if (range) parts.push(range);
  return parts.join(' · ');
}

// ---- copied verbatim from tools/era-archive/web/creators.js: end

const SUGGESTION_LIMIT = 8;
// Two letters is where a name list stops being the whole archive. Same floor the
// builders index uses for its own suggestions.
const MIN_CHARS = 2;
// Short enough that the list feels attached to the keyboard, long enough that a fast
// typist ranks once instead of once per letter.
const DEBOUNCE_MS = 90;
// A click on a row blurs the box before the anchor activates on some engines; wait out
// the race rather than closing the list under the pointer.
const BLUR_CLOSE_MS = 150;
const DIRECTORY_URL = '/valheim/creators/directory.json';
const PROFILE = (key) => '/valheim/creators/' + key + '/';

// The one ranking definition the door has: the live filter, the live comparator, the
// live cap. tests/gateway.logic.test.js asserts this equals filterBuilders + sort + slice
// run against creators.js itself.
function rankBuilders(builders, typed) {
  const q = (typed || '').trim().toLocaleLowerCase();
  return filterBuilders(builders, {query: typed})
    .sort((a, b) => compareBuilders(a, b, q))
    .slice(0, SUGGESTION_LIMIT);
}

// Which drawn tile a builder wears. The builderKey is already a hash, so its leading
// bytes are as good a spread as anything derived from them, and the mapping is stable:
// the same builder wears the same tile on every page, every build, with no state.
function portraitIndex(key, count) {
  return parseInt(key.slice(0, 8), 16) % count;
}

if (typeof module !== 'undefined') {
  module.exports = {
    PLACEHOLDER_NAME, searchTerms, matchScore, compareBuilders, filterBuilders,
    plural, eraRange, builderSummary, rankBuilders, portraitIndex,
    SUGGESTION_LIMIT, MIN_CHARS,
  };
}

// The same mark the header and the footer wear, drawn inline so a row with no portrait
// tile still holds its 40px column instead of collapsing. Kept in step with
// assets/emblem.svg by eye; it is decorative and carries aria-hidden either way.
const EMBLEM = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="40" height="40" fill="none" aria-hidden="true" focusable="false">'
  + '<path d="M32 10L48 24V40L32 54L16 40V24L32 10Z" stroke="#F59E0B" stroke-width="2.5" stroke-linejoin="round" fill="#1A232E"/>'
  + '<path d="M32 16V48M22 28L42 36M42 28L22 36" stroke="#FBBF24" stroke-width="2" stroke-linecap="round"/>'
  + '<circle cx="32" cy="32" r="4" fill="#F59E0B"/></svg>';

function initGateway() {
  const form = document.querySelector('form.finder');
  if (!form) return;
  const input = form.querySelector('#q');
  const list = document.getElementById('suggestions');
  const status = document.getElementById('finder-status');
  if (!input || !list || !status) return;

  const strings = {
    loading: list.dataset.loading || '',
    failed: list.dataset.failed || '',
    empty: list.dataset.empty || '',
  };
  const manifest = readManifest();

  let builders = null;
  let loadFailed = false;
  let directoryRequest = null;
  let suggestions = [];
  let activeSuggestion = -1;
  let isOpen = false;
  let closeTimer = 0;
  let debounceTimer = 0;
  let blurTimer = 0;

  function readManifest() {
    const block = document.getElementById('portrait-manifest');
    if (!block) return {count: 0, tiles: [], base: ''};
    try {
      const parsed = JSON.parse(block.textContent);
      return {count: parsed.count || 0, tiles: parsed.tiles || [], base: parsed.base || ''};
    } catch (error) {
      return {count: 0, tiles: [], base: ''};
    }
  }

  function reducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // ------------------------------------------------------------------ the data

  // Idempotent on purpose: the idle callback, the first focus and the first keystroke all
  // call it, and only the first of them spends a request.
  function loadDirectory() {
    if (directoryRequest) return directoryRequest;
    directoryRequest = fetch(DIRECTORY_URL, {credentials: 'omit'})
      .then((response) => {
        if (!response.ok) throw new Error('directory answered ' + response.status);
        return response.json();
      })
      .then((doc) => {
        builders = doc.builders || [];
        // Whatever was typed while the file was in flight is now answerable.
        if (input.value.trim().length >= MIN_CHARS) query();
      })
      .catch(() => {
        // The plain GET underneath still works; say so instead of leaving a dead box.
        loadFailed = true;
        closeSuggestions();
        status.textContent = strings.failed;
      });
    return directoryRequest;
  }

  // ----------------------------------------------------------------- rendering

  function portraitFor(builder) {
    if (!manifest.count || !manifest.tiles.length) {
      const fallback = document.createElement('div');
      fallback.className = 'portrait portrait-fallback';
      fallback.setAttribute('aria-hidden', 'true');
      fallback.innerHTML = EMBLEM;
      return fallback;
    }
    const tile = manifest.tiles[portraitIndex(builder.builderKey, manifest.count)];
    const img = document.createElement('img');
    img.className = 'portrait';
    img.alt = '';
    img.width = 40;
    img.height = 40;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = manifest.base + tile.thumb + '?v=' + tile.v;
    return img;
  }

  function span(className, value) {
    const node = document.createElement('span');
    node.className = className;
    node.textContent = value;
    return node;
  }

  function renderRows(rows, q) {
    list.replaceChildren();
    list.removeAttribute('aria-busy');
    rows.forEach((builder, index) => {
      const item = document.createElement('li');
      item.id = 'suggestion-' + index;
      item.className = 'suggestion';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');

      const anchor = document.createElement('a');
      anchor.href = PROFILE(builder.builderKey);
      // The box keeps focus for the whole interaction; rows are reached with the arrows.
      anchor.tabIndex = -1;
      anchor.append(portraitFor(builder));

      const stack = document.createElement('span');
      stack.className = 'suggestion-text';
      stack.append(span('suggestion-name', builder.displayName));
      const alias = searchTerms(builder)
        .find((term) => term !== builder.displayName && term.toLocaleLowerCase().includes(q));
      if (alias) stack.append(span('suggestion-alias', 'also “' + alias + '”'));
      stack.append(span('suggestion-counts', builderSummary(builder)));

      anchor.append(stack);
      item.append(anchor);
      list.append(item);
    });
  }

  function renderLoading() {
    suggestions = [];
    activeSuggestion = -1;
    list.replaceChildren();
    list.setAttribute('aria-busy', 'true');
    const item = document.createElement('li');
    item.className = 'suggestion-loading';
    // Presentation, not an option: there is nothing here to choose yet.
    item.setAttribute('role', 'presentation');
    item.textContent = strings.loading;
    list.append(item);
    status.textContent = strings.loading;
    openList();
  }

  function renderEmpty() {
    suggestions = [];
    activeSuggestion = -1;
    list.replaceChildren();
    list.removeAttribute('aria-busy');
    const item = document.createElement('li');
    item.className = 'suggestion suggestion-empty';
    // Not arrow-reachable: an offer, not a match. Enter still submits the plain form.
    item.setAttribute('role', 'presentation');
    const anchor = document.createElement('a');
    anchor.href = '/valheim/';
    anchor.textContent = strings.empty;
    item.append(anchor);
    list.append(item);
    status.textContent = strings.empty;
    openList();
  }

  function openList() {
    window.clearTimeout(closeTimer);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (isOpen) return;
    isOpen = true;
    // Clear `hidden` first and add the class on the next frame, or the browser has
    // nothing to transition from and the panel arrives fully drawn.
    if (reducedMotion()) list.classList.add('is-open');
    else window.requestAnimationFrame(() => { if (isOpen) list.classList.add('is-open'); });
  }

  function closeSuggestions() {
    suggestions = [];
    activeSuggestion = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    list.classList.remove('is-open');
    window.clearTimeout(closeTimer);
    const finish = () => {
      if (isOpen) return;
      list.hidden = true;
      list.replaceChildren();
      list.removeAttribute('aria-busy');
    };
    isOpen = false;
    if (reducedMotion()) finish();
    else closeTimer = window.setTimeout(finish, 120);
  }

  // -------------------------------------------------------------------- query

  function query() {
    const typed = input.value.trim();
    if (typed.length < MIN_CHARS) {
      closeSuggestions();
      status.textContent = '';
      return;
    }
    if (!builders && !loadFailed) return renderLoading();
    if (!builders) {
      closeSuggestions();
      status.textContent = strings.failed;
      return;
    }
    const q = typed.toLocaleLowerCase();
    // Two passes over the same predicate on purpose: rankBuilders is the only place the
    // door defines an order, and the status line needs the count from before the cap.
    const total = filterBuilders(builders, {query: typed}).length;
    suggestions = rankBuilders(builders, typed);
    if (!suggestions.length) return renderEmpty();
    renderRows(suggestions, q);
    const matched = total === 1 ? '1 builder matches' : total.toLocaleString() + ' builders match';
    status.textContent = suggestions.length < total
      ? suggestions.length + ' of ' + matched
      : matched;
    openList();
  }

  // ----------------------------------------------------------------- movement

  function highlightSuggestion(delta) {
    if (!suggestions.length) return false;
    const n = suggestions.length;
    // One extra slot past the end returns focus to the raw typed text.
    setActive((activeSuggestion + delta + n + 2) % (n + 1) - 1, true);
    return true;
  }

  function setActive(index, scroll) {
    activeSuggestion = index;
    [...list.children].forEach((item, i) => {
      const on = i === index;
      item.classList.toggle('active', on);
      item.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && scroll) item.scrollIntoView({block: 'nearest'});
    });
    if (index < 0) input.removeAttribute('aria-activedescendant');
    else input.setAttribute('aria-activedescendant', 'suggestion-' + index);
  }

  function navigate(event, href) {
    event.preventDefault();
    location.assign(href);
  }

  // ------------------------------------------------------------------- wiring

  input.addEventListener('input', () => {
    loadDirectory();
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(query, DEBOUNCE_MS);
  });

  input.addEventListener('focus', () => {
    window.clearTimeout(blurTimer);
    loadDirectory();
  });

  input.addEventListener('blur', () => {
    window.clearTimeout(blurTimer);
    blurTimer = window.setTimeout(closeSuggestions, BLUR_CLOSE_MS);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!isOpen && suggestions.length) openList();
      if (highlightSuggestion(event.key === 'ArrowDown' ? 1 : -1)) event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      // The text stays: Escape dismisses the list, it does not undo the typing. That
      // needs preventDefault -- a bare <input type="search"> empties itself on Escape by
      // UA default, which would throw away the name the visitor just typed.
      event.preventDefault();
      closeSuggestions();
      return;
    }
    if (event.key === 'Tab') {
      closeSuggestions();
      return;
    }
    if (event.key !== 'Enter') return;
    if (activeSuggestion >= 0 && suggestions[activeSuggestion]) {
      navigate(event, PROFILE(suggestions[activeSuggestion].builderKey));
      return;
    }
    // Nothing highlighted: an exact or leading-edge match on the top row is what the
    // visitor meant. Anything looser goes to the index, where the whole list is.
    const top = suggestions[0];
    if (top && matchScore(top, input.value.trim().toLocaleLowerCase()) <= 1) {
      navigate(event, PROFILE(top.builderKey));
    }
  });

  // Taking the mousedown keeps the box focused, so the blur timer never races the click.
  // The click itself is left alone, which is what keeps a ctrl-click opening a new tab.
  list.addEventListener('mousedown', (event) => event.preventDefault());

  list.addEventListener('mousemove', (event) => {
    if (!suggestions.length) return;
    const row = event.target.closest('li.suggestion');
    if (!row) return;
    const index = [...list.children].indexOf(row);
    if (index >= 0 && index !== activeSuggestion) setActive(index, false);
  });

  // The one thing a plain form gets wrong is the empty submit: it navigates to
  // /valheim/creators/?q= , which loads the whole directory and then filters it by a
  // blank string, so the visitor pays a page load to arrive back where they started.
  // Trim, and stay put when there is nothing to search for.
  form.addEventListener('submit', (event) => {
    input.value = input.value.trim();
    if (input.value) return;
    event.preventDefault();
    input.focus();
  });

  // ---------------------------------------------------------------- first draw

  if ('requestIdleCallback' in window) window.requestIdleCallback(() => loadDirectory());
  else window.setTimeout(loadDirectory, 250);

  const deepLink = (new URLSearchParams(location.search).get('q') || '').trim();
  if (deepLink) {
    input.value = deepLink;
    loadDirectory();
    input.focus({preventScroll: true});
    query();
  } else if (!window.matchMedia('(pointer: coarse)').matches) {
    // On a touch keyboard an autofocus throws the keyboard up over the whole page.
    input.focus({preventScroll: true});
  }
}

if (typeof document !== 'undefined') initGateway();
