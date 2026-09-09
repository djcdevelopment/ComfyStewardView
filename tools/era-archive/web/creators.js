'use strict';

(async () => {
  const PAGE_SIZE_DIRECTORY = 80;
  const PAGE_SIZE_ALBUMS = 40;
  const SUGGESTION_LIMIT = 8;
  const FILTER_DEBOUNCE_MS = 140;
  // Long enough that a typed name lands as one access-log line rather than eight.
  const BEACON_DEBOUNCE_MS = 900;
  const STORAGE_KEY = 'creators-participation-v1';
  const DEFAULT_STATE = () => ({
    schema: 'steward-creator-participation-local/v1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    participant: '',
    claims: {},   // buildKey -> claim
    requests: {}, // requestId -> request
  });

  const SHOT_STYLES = [
    ['wide-overview', 'Wide overview + contextual orbit'],
    ['entry-detail', 'Entry-level detail pass'],
    ['signature-interior', 'Interior signature shot'],
    ['height-variation', 'Height-variation pass (high/low)'],
    ['night-tone', 'Evening tone study'],
  ];

  // "Builder 8014fa60" is what community.py writes when no single recorded name won.
  // Those are real threads and stay searchable, they are just nobody's own name.
  const PLACEHOLDER_NAME = /^Builder [0-9a-f]{8}$/;

  const $ = (id) => document.getElementById(id);
  const node = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const link = (text, url) => {
    const a = node('a', text);
    a.href = url;
    return a;
  };
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many || one + 's'}`;

  const segments = location.pathname.split('/').filter(Boolean);
  const builderKey = segments.find((s) => /^[a-f0-9]{32}$/.test(s));
  const isThread = Boolean(builderKey);
  const base = new URL(isThread ? '../' : './', location.href);
  const endpoint = document.querySelector('meta[name="creator-participation-endpoint"]')?.content?.trim() || '';
  const state = loadState();
  let directory = null;
  let thread = null;
  let buildersByKey = new Map();
  let externalParticipation = null;
  let filteredBuilders = [];
  let directoryOffset = 0;
  let suggestions = [];
  let activeSuggestion = -1;
  let lastBeaconTerm = '';
  let filterTimer = 0;
  let beaconTimer = 0;

  const claimModal = $('claim-modal');
  const requestModal = $('request-modal');
  const activityModal = $('activity-modal');
  let selectedAlbum = null;

  const read = async (name) => {
    const response = await fetch(new URL(name, base));
    if (!response.ok) throw new Error('The archive could not be opened.');
    return response.json();
  };

  const readOptional = async (name) => {
    try {
      const response = await fetch(new URL(name, base));
      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    }
  };

  function nowISOString() {
    return new Date().toISOString();
  }

  function randomId(prefix) {
    const token = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2);
    return `${prefix}-${token}`;
  }

  function normalizeHandle(value) {
    const text = String(value || '').trim();
    return text || 'Anonymous volunteer';
  }

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

  const sentenceCase = (text) => (text ? text[0].toLocaleUpperCase() + text.slice(1) : text);

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_STATE();
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.schema !== 'steward-creator-participation-local/v1') return DEFAULT_STATE();
      const next = DEFAULT_STATE();
      next.participant = String(parsed.participant || '').trim();
      next.claims = parsed.claims && typeof parsed.claims === 'object' ? parsed.claims : {};
      next.requests = parsed.requests && typeof parsed.requests === 'object' ? parsed.requests : {};
      next.createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : next.createdAt;
      next.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowISOString();
      return next;
    } catch {
      return DEFAULT_STATE();
    }
  }

  function saveState() {
    state.updatedAt = nowISOString();
    state.participant = normalizeHandle(state.participant);
    // setItem throws in a private window with site data blocked, and on quota
    // exhaustion. loadState() already tolerates that; without the same here the throw
    // escapes the click handler, so the modal never closes and the claim is lost with
    // no explanation. Persistence is a convenience -- the payload is the real handoff.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      showToast('This browser will not remember your participation. Copy the payload before leaving.');
    }
    updateParticipantSnapshot();
  }

  function toPartsByBuilder() {
    const claims = Object.values(state.claims);
    const requests = Object.values(state.requests);
    const byBuilder = new Map();

    for (const item of [...claims, ...requests]) {
      const key = item.builderKey;
      const record = byBuilder.get(key) || {claims: 0, requests: 0, handles: new Set()};
      if (item.claimId) record.claims += 1;
      if (item.requestId) record.requests += 1;
      if (item.participant) record.handles.add(item.participant);
      byBuilder.set(key, record);
    }
    return byBuilder;
  }

  function countByBuilder(builderKeyValue) {
    const aggregate = toPartsByBuilder();
    return aggregate.get(builderKeyValue) || {claims: 0, requests: 0, handles: new Set()};
  }

  function claimForBuild(buildKey) {
    return state.claims[buildKey] || null;
  }

  function requestsForBuild(buildKey) {
    return Object.values(state.requests).filter((r) => r.buildKey === buildKey);
  }

  function showToast(message, timeoutMs = 2400) {
    const t = $('toast');
    t.textContent = message;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), timeoutMs);
  }

  function openModal(modal) {
    if (!modal) return;
    modal.hidden = false;
    modal.classList.add('open');
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.classList.remove('open');
    modal.hidden = true;
  }

  function closeAllModals() {
    closeModal(claimModal);
    closeModal(requestModal);
    closeModal(activityModal);
  }

  async function submitPayload(payload) {
    // Throw rather than return: the callers wrap this in try/catch and treat a normal
    // completion as proof of delivery. Returning false here made every claim record
    // deliveryStatus 'submitted' and report "sent" without a request being made.
    if (!endpoint) throw new Error('no participation endpoint configured');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(payload),
      // Without this a hung endpoint awaits forever with the modal stuck open.
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    if (!response.ok) throw new Error(response.statusText || 'submission failed');
    return true;
  }

  function exportPayload(kindFilter) {
    const payload = {
      schema: 'steward-creator-participation-export/v1',
      createdAt: nowISOString(),
      participant: state.participant,
      claims: Object.values(state.claims),
      requests: Object.values(state.requests),
    };
    if (kindFilter === 'claim') payload.claims = payload.claims.filter((c) => c.buildKey === selectedAlbum?.buildKey);
    if (kindFilter === 'request' && selectedAlbum) payload.requests = payload.requests.filter((r) => r.buildKey === selectedAlbum.buildKey);
    return payload;
  }

  function showPayloadFallback(text, message) {
    const area = $('activity-payload');
    area.value = text;
    openModal(activityModal);
    showToast(message);
  }

  async function copyActivityPayload(payload) {
    const text = JSON.stringify(payload, null, 2);
    // The likelier failure is not that the clipboard API is missing but that it
    // rejects -- permission denied, or the document not focused. Falling back only on
    // absence leaves those users with neither a copy nor anywhere to read the payload.
    if (!navigator.clipboard?.writeText) {
      return showPayloadFallback(text, 'Copy the payload from this box.');
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast('Payload copied — send it over to finish.');
    } catch {
      showPayloadFallback(text, 'Clipboard unavailable. Copy the payload from this box.');
    }
  }

  function updateParticipantSnapshot() {
    if (!$('participant-handle')) return;
    $('participant-handle').value = state.participant;
    const counts = {
      claims: Object.keys(state.claims).length,
      requests: Object.keys(state.requests).length,
      submitted: [...Object.values(state.claims), ...Object.values(state.requests)]
        .filter((x) => x.deliveryStatus === 'submitted').length,
    };
    const participants = new Set();
    for (const c of Object.values(state.claims)) participants.add(c.participant);
    for (const r of Object.values(state.requests)) participants.add(r.participant);

    const parts = [
      `${counts.claims} claimed builds`,
      `${counts.requests} photo requests`,
      `${counts.submitted} already submitted`,
      `${participants.size} local participants`,
    ];
    $('participation-summary').textContent = parts.join(' · ');

    // The panel is a fold on the landing page -- nobody arriving for the first time
    // needs four zeroes above the search box. Open it once there is something in it.
    const details = $('participation-details');
    if (details && (counts.claims || counts.requests || state.participant || isThread)) details.open = true;

    const total = externalParticipation && typeof externalParticipation === 'object'
      ? Number(externalParticipation.participants || externalParticipation.totalParticipants || 0)
      : 0;
    if (total > 0) {
      $('global-participation').hidden = false;
      $('global-participation').textContent = `Publicly visible participant estimate: about ${total.toLocaleString()} volunteers.`;
    } else {
      $('global-participation').hidden = true;
    }
  }

  function addBuilderParticipationLine(builderKeyValue) {
    const agg = countByBuilder(builderKeyValue);
    const chips = [];
    if (agg.claims) chips.push(`${agg.claims} claimed build${agg.claims === 1 ? '' : 's'}`);
    if (agg.requests) chips.push(`${agg.requests} request${agg.requests === 1 ? '' : 's'}`);
    return chips;
  }

  function appendBuilderCards() {
    const container = $('content');
    for (const b of filteredBuilders.slice(directoryOffset, directoryOffset + PAGE_SIZE_DIRECTORY)) {
      const card = node('article', null, 'builder');
      card.append(
        link(b.displayName, new URL(`${b.builderKey}/`, base)),
        node('p', sentenceCase(eraRange(b.eras))),
        node('p', [
          plural(b.albums, 'album'),
          b.pieces != null ? `${b.pieces.toLocaleString()} pieces` : null,
          b.tier || null,
          `${b.photos.toLocaleString()} photos`
        ].filter(Boolean).join(' · ')),
      );

      const chips = addBuilderParticipationLine(b.builderKey);
      if (chips.length || b.aliases?.length) {
        const tagWrap = node('div', null, 'chips');
        if (b.aliases?.length) {
          tagWrap.appendChild(node('span', plural(b.aliases.length, 'alias', 'aliases'), 'chip'));
        }
        if (chips.length) {
          for (const chipText of chips) tagWrap.appendChild(node('span', chipText, 'chip'));
        }
        card.append(tagWrap);
      }

      if (b.nameStatus === 'ambiguous') {
        card.append(node('p', 'Several recorded names remain under review', 'muted'));
      }

      container.append(card);
    }
    directoryOffset += PAGE_SIZE_DIRECTORY;
    $('more').hidden = directoryOffset >= filteredBuilders.length;
  }

  // What the archive can honestly say tonight: which eras carry photographs, and which
  // are still being shot. 1,963 of 2,747 threads read "0 photos" for a reason.
  function captureNoteForDirectory() {
    // `directory.eras` covers only analysed world saves -- eras 16 and 17 exist solely
    // as legacy gallery imports and carry photographs, so they are absent from it.
    // `photography` is counted from the albums themselves and covers every era.
    const eras = Array.isArray(directory.photography?.eras) ? directory.photography.eras : [];
    const photographed = eras.filter((e) => e.photos > 0).map((e) => e.era);
    const pending = eras.filter((e) => !e.photos).map((e) => e.era);
    const photos = directory.photography?.photos ?? directory.builders.reduce((n, b) => n + b.photos, 0);
    const withPhotos = directory.photography?.buildersWithPhotos ?? directory.builders.filter((b) => b.photos > 0).length;
    if (!photos) return 'Photography has not started yet — every thread lists the builds recorded in the saved worlds.';
    const first = photographed.length
      ? `${plural(photos, 'photograph')} published so far across ${eraRange(photographed)}, covering ${plural(withPhotos, 'builder')}.`
      : `${plural(photos, 'photograph')} published so far, covering ${plural(withPhotos, 'builder')}.`;
    if (!pending.length) return first;
    return `${first} ${sentenceCase(eraRange(pending))} ${pending.length === 1 ? 'is' : 'are'} still being photographed — those threads fill in as captures land.`;
  }

  function captureNoteForThread() {
    const albums = thread.eras.flatMap((e) => e.albums);
    if (!albums.length) return '';
    const shot = albums.filter((a) => a.photos?.length);
    if (!shot.length) {
      return `None of these ${plural(albums.length, 'album')} has been photographed yet. Photography is running era by era; this thread fills in as captures land.`;
    }
    const pending = thread.eras.filter((e) => !e.albums.some((a) => a.photos?.length)).map((e) => e.era);
    const withheld = albums.filter((a) => a.photoStatus === 'rejected').length;
    let line = `${shot.length.toLocaleString()} of ${plural(albums.length, 'album')} photographed so far.`;
    if (withheld) line += ` ${plural(withheld, 'album')} had every frame withheld and will be shot again.`;
    if (!pending.length) return line;
    return `${line} ${sentenceCase(eraRange(pending))} ${pending.length === 1 ? 'is' : 'are'} still being photographed.`;
  }

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

  function builderSummary(b) {
    const parts = [plural(b.albums, 'build')];
    if (b.pieces != null) parts.push(`${b.pieces.toLocaleString()} pieces`);
    if (b.tier) parts.push(b.tier);
    parts.push(`${b.photos.toLocaleString()} photos`);
    const range = eraRange(b.eras);
    if (range) parts.push(range);
    return parts.join(' · ');
  }

  function closeSuggestions() {
    suggestions = [];
    activeSuggestion = -1;
    $('suggestions').hidden = true;
    $('suggestions').replaceChildren();
    $('search').setAttribute('aria-expanded', 'false');
    $('search').removeAttribute('aria-activedescendant');
  }

  function renderSuggestions(q) {
    const list = $('suggestions');
    if (!q || q.length < 2 || !directory) return closeSuggestions();
    suggestions = filteredBuilders.slice(0, SUGGESTION_LIMIT);
    activeSuggestion = -1;
    if (!suggestions.length) return closeSuggestions();

    list.replaceChildren();
    suggestions.forEach((b, index) => {
      const item = node('li', null, 'suggestion');
      item.id = `suggestion-${index}`;
      item.setAttribute('role', 'option');
      const anchor = link('', new URL(`${b.builderKey}/`, base));
      anchor.append(node('span', b.displayName, 'suggestion-name'));
      const alias = searchTerms(b).find((t) => t !== b.displayName && t.toLocaleLowerCase().includes(q));
      if (alias) anchor.append(node('span', `also “${alias}”`, 'suggestion-alias'));
      anchor.append(node('span', builderSummary(b), 'suggestion-counts'));
      item.append(anchor);
      list.append(item);
    });
    list.hidden = false;
    $('search').setAttribute('aria-expanded', 'true');
  }

  function highlightSuggestion(delta) {
    if (!suggestions.length) return false;
    // One extra slot past the end returns focus to the raw typed text.
    activeSuggestion = (activeSuggestion + delta + suggestions.length + 2) % (suggestions.length + 1) - 1;
    const list = $('suggestions');
    [...list.children].forEach((li, i) => li.classList.toggle('active', i === activeSuggestion));
    if (activeSuggestion < 0) $('search').removeAttribute('aria-activedescendant');
    else $('search').setAttribute('aria-activedescendant', `suggestion-${activeSuggestion}`);
    return true;
  }

  // Caddy already writes every request to the access log as JSON with its query string,
  // so a request for a four-byte file is a complete search log with no service to run,
  // no public write path to abuse, and no personal data beyond what a web server already
  // keeps. The footer says this is happening.
  function beaconSearch(q, matches) {
    if (q.length < 2 || q === lastBeaconTerm) return;
    lastBeaconTerm = q;
    const url = new URL('search-beacon.txt', base);
    url.searchParams.set('q', q.slice(0, 80));
    url.searchParams.set('n', String(matches));
    fetch(url, {cache: 'no-store', keepalive: true}).catch(() => {});
  }

  function reflectQuery(q) {
    const url = new URL(location.href);
    if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
    if (url.href !== location.href) history.replaceState(null, '', url);
  }

  function applyFilter({suggest = true} = {}) {
    const typed = $('search').value.trim();
    const q = typed.toLocaleLowerCase();
    const era = Number($('era').value);
    filteredBuilders = directory.builders
      .filter((b) => (!era || b.eras.includes(era)))
      .filter((b) => !q || searchTerms(b).some((x) => x.toLocaleLowerCase().includes(q)));
    filteredBuilders.sort((a, b) => compareBuilders(a, b, q));

    directoryOffset = 0;
    $('content').replaceChildren();
    $('status').textContent = `${filteredBuilders.length.toLocaleString()} builders · ${directory.unattributedAlbums.toLocaleString()} additional albums have no saved creator`;

    const empty = $('empty-state');
    if (!filteredBuilders.length) {
      empty.hidden = false;
      empty.textContent = q
        ? `No builder matches “${typed}”. Names come from the creator recorded on each saved construction piece, so anyone who never placed a piece in these worlds has no thread. Try a shorter fragment, or a name you built under earlier.`
        : 'No builder is recorded for this era yet.';
    } else {
      empty.hidden = true;
    }

    $('more').hidden = true;
    appendBuilderCards();
    if (suggest) renderSuggestions(q);
    reflectQuery(typed);
    clearTimeout(beaconTimer);
    if (q) beaconTimer = setTimeout(() => beaconSearch(q, filteredBuilders.length), BEACON_DEBOUNCE_MS);
  }

  function renderDirectory() {
    const buildersByEra = [...new Set(directory.builders.flatMap((b) => b.eras))]
      .sort((a, b) => b - a);
    if (!$('era').children.length) {
      for (const era of buildersByEra) $('era').add(new Option(`Era ${era}`, era));
    }

    const unresolved = directory.legacyImports.reduce((n, e) => n + e.unresolvedImages, 0);
    const unresolvedLine = `${unresolved.toLocaleString()} historical photographs remain in their original galleries while creator attribution is unresolved.`;
    if (unresolved > 0) {
      // renderDirectory() runs once per load now, but a footer that grows by a sentence
      // every time it is called is a trap waiting for the next caller.
      const footer = document.querySelector('footer');
      if (!footer.dataset.unresolvedNoted) {
        footer.textContent = `${footer.textContent} ${unresolvedLine}`;
        footer.dataset.unresolvedNoted = '1';
      }
    }

    $('capture-note').textContent = captureNoteForDirectory();
    $('content').className = 'directory';

    $('search').oninput = () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => applyFilter(), FILTER_DEBOUNCE_MS);
    };
    $('era').onchange = () => applyFilter();
    $('search').onkeydown = (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (highlightSuggestion(event.key === 'ArrowDown' ? 1 : -1)) event.preventDefault();
      } else if (event.key === 'Enter' && activeSuggestion >= 0) {
        event.preventDefault();
        beaconSearch($('search').value.trim().toLocaleLowerCase(), filteredBuilders.length);
        location.href = new URL(`${suggestions[activeSuggestion].builderKey}/`, base);
      } else if (event.key === 'Escape') {
        closeSuggestions();
      }
    };
    // A click on a suggestion is a mousedown-then-blur, so closing on blur has to wait
    // for the anchor's own navigation.
    $('search').onblur = () => setTimeout(closeSuggestions, 180);
    $('more').onclick = appendBuilderCards;

    // A shared or bookmarked ?q= must reproduce the search, and the page request that
    // carries it is itself the first log line for that term.
    const initial = new URLSearchParams(location.search).get('q');
    if (initial) {
      $('search').value = initial;
      lastBeaconTerm = initial.trim().toLocaleLowerCase();
    }
    applyFilter({suggest: false});
    if (!initial) $('search').focus({preventScroll: true});
  }

  function buildCreditLine(album) {
    const credits = node('p', null, 'credits');
    credits.append('Contributors: ');
    album.contributors.forEach((c, i) => {
      if (i) credits.append(' · ');
      // The directory may not have arrived yet -- the thread renders without waiting for
      // 818 KB of it. Tag the link so hydrateCredits() can fill the name in later.
      const anchor = link(buildersByKey.get(c.builderKey)?.displayName || 'Recorded builder',
        new URL(`${c.builderKey}/`, base));
      anchor.className = 'credit';
      anchor.dataset.builderKey = c.builderKey;
      credits.append(anchor);
      if (c.share != null) credits.append(` (${(100 * c.share).toFixed(1)}%)`);
    });
    return credits;
  }

  function hydrateCredits() {
    for (const anchor of document.querySelectorAll('a.credit[data-builder-key]')) {
      const name = buildersByKey.get(anchor.dataset.builderKey)?.displayName;
      if (name) anchor.textContent = name;
    }
  }

  function renderAlbumPhotos(album) {
    // The old per-album "photography planned" line rendered up to forty times on one
    // page. The single note under the title says it once, with the real numbers. The one
    // exception is a build that WAS photographed and had every frame withheld -- that is
    // a different fact from "not shot yet" and only this album can state it.
    if (!album.photos?.length) {
      return album.photoStatus === 'rejected'
        ? node('p', 'Photographed, but none of the frames were worth showing — fog, a blocked camera, or a near-identical shot of a neighbouring build. This one is queued for another attempt.', 'muted')
        : null;
    }
    const photos = node('div', null, 'photos');
    for (const p of album.photos) {
      const a = link('', p.href);
      const img = document.createElement('img');
      img.src = p.thumb;
      img.alt = p.label;
      img.loading = 'lazy';
      a.append(img);
      photos.append(a);
    }
    return photos;
  }

  function renderAlbumActions(album, targetBuilderKey) {
    const row = node('div', null, 'actions-row');
    const current = claimForBuild(album.buildKey);
    if (current) {
      // Was a <button> with no handler, which looks pressable and does nothing.
      row.append(node('span', `Claimed by ${normalizeHandle(current.participant)}`, 'chip claimed'));
    } else {
      const claim = node('button', 'I built this', 'primary');
      claim.onclick = () => {
        selectedAlbum = album;
        openClaimDialog(album, targetBuilderKey);
      };
      row.append(claim);
    }

    const requests = requestsForBuild(album.buildKey);
    const label = requests.length
      ? `Photo requests (${requests.length})`
      : (album.photos?.length ? 'Request additional photographs' : 'Request photographs');
    const reqBtn = node('button', label);
    if (!current) {
      // `disabled` swallows the tap, so the explanation lived only in a title tooltip --
      // invisible on a phone, which is where the Discord links land.
      reqBtn.classList.add('inert');
      reqBtn.setAttribute('aria-disabled', 'true');
      reqBtn.title = 'Claim this build before requesting photographs';
    }
    reqBtn.onclick = () => {
      if (!current) return showToast('Claim this build before requesting photographs.');
      selectedAlbum = album;
      openRequestDialog(album, targetBuilderKey, current.claimId);
    };
    row.append(reqBtn);

    const exportBtn = node('button', 'Copy this build payload');
    exportBtn.onclick = async () => {
      const requestList = requestsForBuild(album.buildKey);
      await copyActivityPayload({
        schema: 'steward-creator-build-participation/v1',
        exportAt: nowISOString(),
        builderKey: targetBuilderKey,
        buildKey: album.buildKey,
        buildLabel: album.label,
        claim: current,
        requests: requestList,
      });
    };
    row.append(exportBtn);
    return row;
  }

  function buildAlbumCard(album, targetBuilderKey) {
    const card = node('article', null, 'album');
    card.dataset.buildKey = album.buildKey;
    card.append(
      node('h3', album.label),
      node('p', `${album.pieces.toLocaleString()} construction pieces`),
      node('p', album.attribution, 'muted'),
    );
    card.append(buildCreditLine(album));

    const links = node('div', null, 'links');
    if (album.galleryUrl) links.append(link('Open original gallery', album.galleryUrl));
    if (album.worldUrl) links.append(link('World view', album.worldUrl));
    card.append(links);

    const requestHistory = requestsForBuild(album.buildKey);
    if (requestHistory.length) {
      const requestCount = requestHistory.length;
      const submitted = requestHistory.filter((r) => r.deliveryStatus === 'submitted').length;
      const queueLine = node('p', `${requestCount} request${requestCount === 1 ? '' : 's'} for this build ( ${submitted} submitted )`, 'muted');
      card.append(queueLine);
    }

    const photos = renderAlbumPhotos(album);
    if (photos) card.append(photos);
    card.append(renderAlbumActions(album, targetBuilderKey));
    return card;
  }

  // A claim changes one card. Re-rendering the whole page threw away every "show more"
  // the visitor had clicked and jumped them back to the top of a 340-album thread.
  function refreshAlbumCard(album, targetBuilderKey) {
    const existing = document.querySelector('article.album[data-build-key="' + album.buildKey + '"]');
    if (existing) existing.replaceWith(buildAlbumCard(album, targetBuilderKey));
  }

  function renderThread() {
    $('filters').hidden = true;
    if ($('search-hero')) $('search-hero').hidden = true;
    const eraCount = thread.eras.reduce((sum, e) => sum + e.albums.length, 0);
    $('title').textContent = thread.displayName;
    const introParts = [plural(eraCount, 'build album')];
    if (thread.pieces != null) introParts.push(`${thread.pieces.toLocaleString()} construction pieces`);
    if (thread.tier) introParts.push(thread.tier);
    introParts.push(`${thread.photos.toLocaleString()} photographs`);
    $('intro').textContent = introParts.join(' · ');
    $('status').textContent = thread.nameStatus === 'ambiguous'
      ? 'Several recorded names need review. Searchable aliases are retained.'
      : 'No unresolved name conflicts for this builder.';

    const h = node('p', null, 'muted');
    h.id = 'thread-participation-line';
    $('content').className = '';
    $('content').replaceChildren(h);
    refreshThreadParticipationLine();

    const note = captureNoteForThread();
    if (note) $('content').append(node('p', note, 'muted'));

    const allEraBlocks = thread.eras.slice().sort((a, b) => b.era - a.era);
    for (const era of allEraBlocks) {
      const section = node('details');
      section.open = true;
      const photographed = era.albums.filter((a) => a.photos?.length).length;
      section.append(node('summary',
        `Era ${era.era} · ${era.albums.length.toLocaleString()} albums · ${photographed.toLocaleString()} photographed`));

      let shown = 0;
      const more = node('button', 'Show more albums');
      const appendAlbums = () => {
        for (const album of era.albums.slice(shown, shown + PAGE_SIZE_ALBUMS)) {
          section.insertBefore(buildAlbumCard(album, thread.builderKey), more);
        }
        shown += PAGE_SIZE_ALBUMS;
        more.hidden = shown >= era.albums.length;
      };
      section.append(more);
      more.onclick = appendAlbums;
      appendAlbums();
      $('content').append(section);
    }
  }

  function refreshThreadParticipationLine() {
    const line = $('thread-participation-line');
    if (!line || !thread) return;
    const mine = countByBuilder(thread.builderKey);
    line.textContent = `You have ${mine.claims} claimed build${mine.claims === 1 ? '' : 's'} and ${mine.requests} request${mine.requests === 1 ? '' : 's'} on this page.`;
  }

  function openClaimDialog(album, targetBuilderKey) {
    selectedAlbum = album;
    $('claim-build-label').textContent = `${album.label} · era ${album.era}`;
    $('claim-handle').value = state.participant || '';
    $('claim-note').value = '';
    $('claim-confirm').onclick = async () => {
      // normalizeHandle substitutes a placeholder, so validate the raw field:
      // the previous check could never fire and the `required` attribute is inert
      // outside a <form>.
      const typed = $('claim-handle').value.trim();
      if (!typed) return showToast('Add a volunteer handle so the claim can be matched to you.');
      const participant = normalizeHandle(typed);
      const claim = {
        claimId: randomId('claim'),
        buildKey: album.buildKey,
        builderKey: targetBuilderKey,
        participant,
        buildLabel: album.label,
        era: album.era,
        createdAt: nowISOString(),
        note: $('claim-note').value.trim(),
      };
      let deliveryStatus = 'queued';
      try {
        await submitPayload({
          schema: 'steward-creator-participation-event/v1',
          eventType: 'claim',
          claim,
        });
        deliveryStatus = 'submitted';
      } catch {
        // keep local state regardless of endpoint availability
      }

      state.participant = participant;
      claim.deliveryStatus = deliveryStatus;
      // A re-claim must not discard the record that an earlier one was delivered.
      const prior = state.claims[album.buildKey];
      if (prior && prior.deliveryStatus === 'submitted' && deliveryStatus !== 'submitted') {
        claim.deliveryStatus = 'submitted';
        claim.resubmittedFrom = prior.claimId;
      }
      state.claims[album.buildKey] = claim;
      saveState();
      closeModal(claimModal);
      // Without an ingestion endpoint a claim reaches nobody on its own, so the claim
      // is not finished until the volunteer sends the payload. Say that, and hand them
      // the payload the same way the photo-request path already does.
      if (deliveryStatus === 'submitted') {
        showToast('Build claim sent.');
      } else {
        await copyActivityPayload(exportPayload('claim'));
      }
      refreshAlbumCard(album, targetBuilderKey);
      refreshThreadParticipationLine();
    };
    $('claim-cancel').onclick = () => closeModal(claimModal);
    openModal(claimModal);
  }

  function openRequestDialog(album, targetBuilderKey, claimId) {
    selectedAlbum = album;
    $('request-build-label').textContent = `${album.label} · era ${album.era}`;
    $('request-note').value = '';
    $('request-contact').value = '';
    $('request-priority').checked = false;
    $('request-note-inline').textContent = `Current build was claimed as ${state.claims[album.buildKey]?.participant || 'unknown volunteer'}.`;
    $('request-modal').querySelectorAll('input[name="shot-style"]').forEach((box) => {
      box.checked = false;
    });

    $('request-confirm').onclick = async () => {
      const styles = [...$('request-modal').querySelectorAll('input[name="shot-style"]:checked')].map((x) => x.value);
      const note = $('request-note').value.trim();
      if (!styles.length && !note) {
        $('request-note-inline').textContent = 'Choose at least one preset, or add a custom direction.';
        return;
      }
      const payload = {
        requestId: randomId('request'),
        buildKey: album.buildKey,
        builderKey: targetBuilderKey,
        claimId,
        buildLabel: album.label,
        era: album.era,
        participant: normalizeHandle(state.participant),
        styles,
        note,
        contact: $('request-contact').value.trim(),
        urgency: $('request-priority').checked ? 'urgent' : 'normal',
        createdAt: nowISOString(),
      };
      let deliveryStatus = 'queued';
      try {
        await submitPayload({
          schema: 'steward-creator-participation-event/v1',
          eventType: 'photoRequest',
          request: payload,
        });
        deliveryStatus = 'submitted';
      } catch {
        // keep local state regardless of endpoint availability
      }
      payload.deliveryStatus = deliveryStatus;
      state.requests[payload.requestId] = payload;
      state.participant = normalizeHandle(state.participant);
      saveState();
      closeModal(requestModal);
      // Same lie the claim path carried: with no endpoint nothing left the browser, so
      // the payload is the handoff and the wording has to say so.
      if (deliveryStatus === 'submitted') {
        showToast('Photo request sent.');
      } else {
        await copyActivityPayload({
          schema: 'steward-creator-photo-request-export/v1',
          request: payload,
          shotStyles: styles.map((s) => ({id: s, label: SHOT_STYLES.find((x) => x[0] === s)?.[1]})),
        });
      }
      refreshAlbumCard(album, targetBuilderKey);
      refreshThreadParticipationLine();
    };
    $('request-cancel').onclick = () => closeModal(requestModal);
    openModal(requestModal);
  }

  function wireCommonEvents() {
    $('copy-activity').onclick = () => copyActivityPayload(exportPayload());
    $('participant-handle').onchange = (e) => {
      state.participant = normalizeHandle(e.target.value);
      saveState();
      refreshThreadParticipationLine();
    };
    $('activity-copy').onclick = async () => {
      const payloadText = $('activity-payload').value;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payloadText);
        showToast('Payload copied.');
      }
    };
    $('activity-close').onclick = () => closeModal(activityModal);
    // The contact field invites a Discord handle or e-mail and persists indefinitely.
    // Offer a way out that does not require clearing site data by hand.
    if ($('forget-participation')) {
      $('forget-participation').onclick = () => {
        if (!confirm('Forget every claim, request and handle stored in this browser?')) return;
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // Nothing was persisted in the first place; clearing memory is enough.
        }
        const fresh = DEFAULT_STATE();
        state.participant = fresh.participant;
        state.claims = fresh.claims;
        state.requests = fresh.requests;
        updateParticipantSnapshot();
        showToast('Local participation cleared.');
        if (isThread && thread) renderThread();
      };
    }
    for (const modal of [claimModal, requestModal, activityModal]) {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) closeModal(modal);
      });
    }
    addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAllModals();
    });
  }

  function bootstrap() {
    wireCommonEvents();
    updateParticipantSnapshot();
    if (isThread) {
      // The thread is what the visitor clicked. Fetching 818 KB of directory first, and
      // awaiting the usually-404 participation.json on top of it, put seconds of
      // "Opening the community archive..." in front of that on mobile data. The
      // directory is needed here for one thing -- co-contributor names -- and that has
      // a fallback string, so it hydrates afterwards.
      read(`threads/${builderKey}.json`)
        .then((entry) => {
          thread = entry;
          renderThread();
        })
        .catch((error) => {
          $('status').textContent = error.message;
        });
      readOptional('directory.json').then((doc) => {
        if (!doc) return;
        directory = doc;
        buildersByKey = new Map(directory.builders.map((b) => [b.builderKey, b]));
        hydrateCredits();
      });
      readOptional('participation.json').then((doc) => {
        externalParticipation = doc;
        updateParticipantSnapshot();
      });
      return;
    }
    read('directory.json')
      .then(async (doc) => {
        directory = doc;
        buildersByKey = new Map(directory.builders.map((b) => [b.builderKey, b]));
        // Render inside the promise chain so a throw here reaches the same .catch as a
        // failed fetch, instead of leaving a half-drawn page with no status line.
        renderDirectory();
        externalParticipation = await readOptional('participation.json');
        updateParticipantSnapshot();
      })
      .catch((error) => {
        $('status').textContent = error.message;
      });
  }

  bootstrap();
})();
