'use strict';

(async () => {
  const PAGE_SIZE_DIRECTORY = 80;
  const PAGE_SIZE_ALBUMS = 40;
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
    if (!endpoint) return false;
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
        node('p', b.eras.map((e) => `Era ${e}`).join(' · ')),
        node('p', `${b.albums.toLocaleString()} albums · ${b.photos.toLocaleString()} photos`),
      );

      const chips = addBuilderParticipationLine(b.builderKey);
      if (chips.length || b.aliases?.length) {
        const tagWrap = node('div', null, 'chips');
        if (b.aliases?.length) {
          tagWrap.appendChild(node('span', `${b.aliases.length} aliases`, 'chip'));
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

  function renderDirectory() {
    const buildersByEra = [...new Set(directory.builders.flatMap((b) => b.eras))]
      .sort((a, b) => b - a);
    if (!$('era').children.length) {
      for (const era of buildersByEra) $('era').add(new Option(`Era ${era}`, era));
    }

    const unresolved = directory.legacyImports.reduce((n, e) => n + e.unresolvedImages, 0);
    const unresolvedLine = `${unresolved.toLocaleString()} historical photographs remain in their original galleries while creator attribution is unresolved.`;
    if (unresolved > 0) {
      const footer = document.querySelector('footer');
      footer.textContent = `${footer.textContent} ${unresolvedLine}`;
    }

    $('content').className = 'directory';
    const filter = () => {
      const q = $('search').value.trim().toLocaleLowerCase();
      const era = Number($('era').value);
      filteredBuilders = directory.builders
        .filter((b) => (!era || b.eras.includes(era)))
        .filter((b) => [b.displayName, ...b.aliases].some((x) => x.toLocaleLowerCase().includes(q)));
      filteredBuilders.sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, {sensitivity: 'base'}));

      directoryOffset = 0;
      $('content').replaceChildren();
      $('status').textContent = `${filteredBuilders.length.toLocaleString()} builders · ${directory.unattributedAlbums.toLocaleString()} additional albums have no saved creator`;
      appendBuilderCards();
    };
    $('search').oninput = filter;
    $('era').onchange = filter;
    $('copy-activity').onclick = () => copyActivityPayload(exportPayload());
    $('participant-handle').onchange = (e) => {
      state.participant = normalizeHandle(e.target.value);
      saveState();
    };
    $('more').onclick = appendBuilderCards;
    filter();
  }

  function buildCreditLine(album) {
    const credits = node('p', null, 'credits');
    credits.append('Contributors: ');
    album.contributors.forEach((c, i) => {
      if (i) credits.append(' · ');
      const name = buildersByKey.get(c.builderKey)?.displayName || 'Recorded builder';
      credits.append(link(name, new URL(`${c.builderKey}/`, base)));
      if (c.share != null) credits.append(` (${(100 * c.share).toFixed(1)}%)`);
    });
    return credits;
  }

  function renderAlbumPhotos(album) {
    const photos = node('div', null, 'photos');
    if (!album.photos?.length) return node('p', 'Photography planned for a future capture session.', 'muted');

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
      const owner = normalizeHandle(current.participant);
      row.append(node('button', `Claimed by ${owner}`));
    } else {
      const claim = node('button', 'I built this', 'primary');
      claim.onclick = () => {
        selectedAlbum = album;
        openClaimDialog(album, targetBuilderKey);
      };
      row.append(claim);
    }

    const reqBtn = node('button', 'Request additional photographs');
    const requests = requestsForBuild(album.buildKey);
    if (requests.length) {
      reqBtn.textContent = `Photo requests (${requests.length})`;
    }
    reqBtn.disabled = !current;
    if (!current) reqBtn.title = 'Claim build before requesting more photos';
    reqBtn.onclick = () => {
      if (!current) return showToast('Claim this build before requesting additional photos.');
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
    card.append(photos);
    card.append(renderAlbumActions(album, targetBuilderKey));
    return card;
  }

  function renderThread() {
    $('filters').hidden = true;
    const eraCount = thread.eras.reduce((sum, e) => sum + e.albums.length, 0);
    $('title').textContent = thread.displayName;
    $('intro').textContent = `${eraCount.toLocaleString()} build albums · ${thread.photos.toLocaleString()} photographs`;
    $('status').textContent = thread.nameStatus === 'ambiguous'
      ? 'Several recorded names need review. Searchable aliases are retained.'
      : 'No unresolved name conflicts for this builder.';

    const mine = countByBuilder(thread.builderKey);
    const top = `You have ${mine.claims} claimed build${mine.claims === 1 ? '' : 's'} and ${mine.requests} request${mine.requests === 1 ? '' : 's'} on this page.`;
    const h = node('p', top, 'muted');
    $('content').className = '';
    $('content').replaceChildren(h);

    const allEraBlocks = thread.eras.slice().sort((a, b) => b.era - a.era);
    for (const era of allEraBlocks) {
      const section = node('details');
      section.open = true;
      section.append(node('summary', `Era ${era.era} · ${era.albums.length.toLocaleString()} albums`));

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

    $('copy-activity').onclick = () => copyActivityPayload(exportPayload());
    $('participant-handle').onchange = (e) => {
      state.participant = normalizeHandle(e.target.value);
      saveState();
      renderThread();
    };
  }

  function openClaimDialog(album, targetBuilderKey) {
    selectedAlbum = album;
    $('claim-build-label').textContent = `${album.label} · ${album.era} era`;
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
      if (isThread) renderThread(); else renderDirectory();
    };
    $('claim-cancel').onclick = () => closeModal(claimModal);
    openModal(claimModal);
  }

  function openRequestDialog(album, targetBuilderKey, claimId) {
    selectedAlbum = album;
    $('request-build-label').textContent = `${album.label} · ${album.era} era`;
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
      }
      payload.deliveryStatus = deliveryStatus;
      state.requests[payload.requestId] = payload;
      state.participant = normalizeHandle(state.participant);
      saveState();
      closeModal(requestModal);
      showToast('Photo request saved.');
      if (styles.length) {
        await copyActivityPayload({
          schema: 'steward-creator-photo-request-export/v1',
          request: payload,
          shotStyles: styles.map((s) => ({id: s, label: SHOT_STYLES.find((x) => x[0] === s)?.[1]})),
        });
      }
      if (isThread) renderThread(); else renderDirectory();
    };
    $('request-cancel').onclick = () => closeModal(requestModal);
    openModal(requestModal);
  }

  function wireCommonEvents() {
    $('copy-activity').onclick = () => copyActivityPayload(exportPayload());
    $('participant-handle').onchange = (e) => {
      state.participant = normalizeHandle(e.target.value);
      saveState();
      if (isThread) renderThread(); else renderDirectory();
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
        if (isThread) renderThread(); else renderDirectory();
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
    read('directory.json')
      .then(async (doc) => {
        directory = doc;
        buildersByKey = new Map(directory.builders.map((b) => [b.builderKey, b]));
        externalParticipation = await readOptional('participation.json');
        updateParticipantSnapshot();
        // Render inside the promise chain so a throw here reaches the same .catch as a
        // failed fetch, instead of leaving a half-drawn page with no status line.
        if (isThread) {
          read(`threads/${builderKey}.json`)
            .then((entry) => {
              thread = entry;
              renderThread();
              updateParticipantSnapshot();
            })
            .catch((error) => {
              $('status').textContent = error.message;
            });
        } else {
          renderDirectory();
          updateParticipantSnapshot();
        }
      })
      .catch((error) => {
        $('status').textContent = error.message;
      });
  }

  bootstrap();
})();
