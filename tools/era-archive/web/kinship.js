'use strict';

// Kinship page: the branching tree of who a builder built beside, era by era, and the
// tagging that a build's majority owner may add on top. The layout and the drawing of
// the tree live in kin-tree.js (the builder profile draws the same tree); this file is
// the page around it. It runs only when a document exists and only when a creators.js
// new enough to carry the participation store, and kin-tree.js, have loaded first.

const initKinshipPage = async () => {
  const $ = (id) => document.getElementById(id);

  // creators.js is the only place the participation store and the kinship model live.
  // A cached copy from before they landed would otherwise throw halfway through the
  // first render and leave a half-drawn tree with no explanation.
  // standingForBuild is checked by name, not just the store: a disavowed build has a claim
  // record and no standing, so a creators.js that only knows claimForBuild would hand this
  // page a tag control on a build its owner has said is not theirs.
  if (typeof StewardParticipation === 'undefined' || typeof buildKinshipTree === 'undefined'
    || typeof StewardParticipation.standingForBuild !== 'function') {
    const status = $('status');
    if (status) status.textContent = 'This page needs a newer creators.js. Reload once to pick it up.';
    return;
  }
  if (typeof drawKinshipTree !== 'function' || typeof layoutKinshipTree !== 'function') {
    const status = $('status');
    if (status) status.textContent = 'This page needs kin-tree.js. Reload once to pick it up.';
    return;
  }

  const LEDGER_PAGE = 50;
  const BUILD_PAGE = 12;
  const COHAB_LIMIT = 12;
  const COHAB_ROWS_PER_BUILD = 8;
  const OTHER_BUILD_LIMIT = 6;
  const SUGGESTION_LIMIT = 8;
  const KEY_PATTERN = /^[a-f0-9]{32}$/;

  const base = new URL('../', location.href);
  const endpoint = document.querySelector('meta[name="creator-participation-endpoint"]')?.content?.trim() || '';
  const params = new URLSearchParams(location.search);
  const anchor = params.get('builder');
  const state = StewardParticipation.load();

  const claimModal = $('claim-modal');
  const tagModal = $('kin-tag-modal');
  const activityModal = $('activity-modal');
  // Read off the shell rather than repeated here, so the default the sheet ships with is
  // the default it is put back to.
  const TAG_NOTE_PLACEHOLDER = $('kin-tag-note')?.getAttribute('placeholder') || '';

  let directory = null;
  let buildersByKey = new Map();
  let thread = null;
  let confirmedTags = [];
  let portraitManifest = null;
  let tree = null;
  let layout = null;
  let treeHandle = null;
  let activeFilter = 'all';
  let branchCap = kinBranchCap();
  let resizeTimer = 0;
  let ledgerShown = LEDGER_PAGE;
  let buildsShown = BUILD_PAGE;
  let suggestions = [];
  let activeSuggestion = -1;
  const albumIndex = new Map();
  let visibleAlbums = [];

  /* ---- small DOM and text helpers (creators.js keeps its own inside a closure) ---- */

  const kinNode = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };

  const kinLink = (text, url) => {
    const a = kinNode('a', text);
    a.href = typeof url === 'string' ? url : String(url);
    return a;
  };

  const kinPlural = (n, one, many) => `${Number(n || 0).toLocaleString()} ${n === 1 ? one : (many || `${one}s`)}`;
  const kinCount = (n) => Number(n || 0).toLocaleString();
  const kinPercent = (share) => `${Math.round(share * 100)}%`;
  const builderHref = (key) => new URL(`${key}/`, base).href;
  const kinshipHref = (key) => new URL(`kinship/?builder=${key}`, base).href;
  // The pair view lives on the anchor's own profile page, so a link into it is that page
  // plus the co-builder it should open on -- and, where the row knows one, the build the
  // two of them share. The anchor's own node never gets one: a pairing of somebody with
  // themselves is not a thing this page can draw.
  const pairHref = (key, buildKey) => new URL(
    `${anchor}/?kin=${key}${buildKey ? `&build=${buildKey}` : ''}`, base).href;

  async function kinRead(name) {
    const response = await fetch(new URL(name, base));
    if (!response.ok) throw new Error('The archive could not be opened.');
    return response.json();
  }

  async function kinReadOptional(name) {
    try {
      const response = await fetch(new URL(name, base));
      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    }
  }

  function kinToast(message, timeoutMs = 2400) {
    const toast = $('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), timeoutMs);
  }

  function kinOpenModal(modal) {
    if (!modal) return;
    modal.hidden = false;
    modal.classList.add('open');
  }

  function kinCloseModal(modal) {
    if (!modal) return;
    modal.classList.remove('open');
    modal.hidden = true;
  }

  function kinCloseAllModals() {
    kinCloseModal(claimModal);
    kinCloseModal(tagModal);
    kinCloseModal(activityModal);
  }

  function kinShowPayloadFallback(text, message) {
    $('activity-payload').value = text;
    kinOpenModal(activityModal);
    kinToast(message);
  }

  // Same shape the directory page uses: the clipboard is likelier to reject than to be
  // missing, and a rejection with no fallback leaves the volunteer with neither a copy
  // nor anywhere to read the payload they were just told to send on.
  async function kinCopyPayload(payload) {
    const text = JSON.stringify(payload, null, 2);
    if (!navigator.clipboard?.writeText) return kinShowPayloadFallback(text, 'Copy the payload from this box.');
    try {
      await navigator.clipboard.writeText(text);
      kinShowPayloadFallback(text, 'Recorded on this device — send the payload on to finish.');
    } catch {
      kinShowPayloadFallback(text, 'Clipboard unavailable. Copy the payload from this box.');
    }
  }

  /* ---- names and portraits ---- */

  const nameFor = (key) => buildersByKey.get(key)?.displayName || `Builder ${String(key || '').slice(0, 8)}`;

  // nameFor() cannot tell a directory that has not loaded from a builder the saved world
  // never named -- both come back as "Builder edb04052". This reads the status the
  // directory publishes, so the two cases stay distinguishable.
  const nameStatusFor = (key) => buildersByKey.get(key)?.nameStatus || null;

  const unnamedKey = (key) => isUnnamed(
    buildersByKey.has(key) ? {nameStatus: nameStatusFor(key), displayName: nameFor(key)} : null,
    typeof PLACEHOLDER_NAME === 'undefined' ? null : PLACEHOLDER_NAME,
  );

  // Never a promise that the name will be published: a volunteer who tells the coordinator
  // who this is has told the coordinator, and nothing more happens on its own.
  const UNNAMED_TITLE = 'No name was found on a bed, tombstone or crafted item in the saved world.';

  // Rendered up front and toggled by hydrateNames rather than created on demand: the
  // ledger and the build cards draw before directory.json has necessarily landed, and a
  // chip that could only be added on the first render would then never appear at all.
  function unnamedChip(key) {
    const chip = kinNode('span', 'unnamed', 'chip kin-unnamed');
    chip.title = UNNAMED_TITLE;
    chip.dataset.kinUnnamedFor = key;
    chip.hidden = !unnamedKey(key);
    return chip;
  }

  const hydrateNames = (root = document) => hydrateKinNames(root, nameFor, unnamedKey);

  function nameSpan(key, tag = 'span', cls) {
    const el = kinNode(tag, nameFor(key), cls);
    el.dataset.kinNameKey = key;
    return el;
  }

  function creditLink(key) {
    const a = kinLink(nameFor(key), builderHref(key));
    a.className = 'credit';
    a.dataset.builderKey = key;
    a.dataset.kinNameKey = key;
    return a;
  }

  const kinPortrait = (key, cls = 'kin-portrait') => kinPortraitEl(key, portraitManifest, cls);
  const hydratePortraits = () => repaintKinPortraits(document, portraitManifest);

  /* ---- reading the tree the model handed back ---- */

  function indexAlbums(doc) {
    albumIndex.clear();
    for (const era of doc?.eras || []) {
      for (const album of era.albums || []) albumIndex.set(album.buildKey, album);
    }
  }

  // A span's builds may arrive as keys or as records; either way the album on the thread
  // is the fuller copy (photos, gallery link, every contributor), so resolve through it.
  function resolveBuild(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') return albumIndex.get(entry) || null;
    return albumIndex.get(entry.buildKey) || entry;
  }

  const albumFor = (build) => (build ? (albumIndex.get(build.buildKey) || build) : null);
  const labelOf = (build) => build?.label || albumFor(build)?.label || 'Untitled build';
  const piecesOf = (build) => build?.pieces ?? albumFor(build)?.pieces ?? null;
  const contributorsOf = (build) => build?.contributors || albumFor(build)?.contributors || [];
  // Beds, read from its own key and never from contributorsOf(): a resident is not a
  // contributor, carries no pieces and no share, and must never reach anything that ranks,
  // branches or decides who may speak for a build. This answers one question only -- did
  // this person sleep in this build, and in how many beds.
  const bedsOf = (build, key) => {
    const residents = build?.residents || albumFor(build)?.residents;
    if (!Array.isArray(residents)) return 0;
    const hit = residents.find((r) => r && r.builderKey === key);
    return Number(hit?.beds) || 0;
  };
  const photoCountOf = (build) => {
    const photos = build?.photos ?? albumFor(build)?.photos;
    return Array.isArray(photos) ? photos.length : Number(photos || 0);
  };

  function shareOf(album, key) {
    const entry = (album?.contributors || []).find((c) => c && c.builderKey === key);
    if (!entry) return null;
    if (typeof entry.share === 'number') return entry.share;
    const total = album?.pieces;
    if (entry.pieces != null && total) return entry.pieces / total;
    return null;
  }

  // standingForBuild, not claimForBuild: a disavowal is a claim record too, and the whole
  // point of one is that it grants no standing to speak for the build's co-builders.
  const canTag = (build) => majorityOwner(albumFor(build), anchor) !== null
    && Boolean(StewardParticipation.standingForBuild(state, build.buildKey));

  const disavowalFor = (buildKey) => {
    const claim = StewardParticipation.claimForBuild(state, buildKey);
    return claim && claim.kind === 'disavow' ? claim : null;
  };

  function majorityBuilds() {
    return Array.isArray(tree?.majorityBuilds) ? tree.majorityBuilds : [];
  }

  // Reads the albums the active filter left standing, not the whole index: under
  // "majority-owned" this list would otherwise show the very builds the filter removed.
  function otherSharedBuilds() {
    const held = new Set(majorityBuilds().map((b) => b.buildKey));
    return visibleAlbums
      .filter((album) => !held.has(album.buildKey) && (album.contributors || []).length > 1)
      .sort((a, b) => (b.pieces || 0) - (a.pieces || 0) || a.buildKey.localeCompare(b.buildKey));
  }

  // Eligible means "a build you have standing to speak for", so the list is the builds
  // this browser has claimed as built -- not every build the anchor happens to lead. A
  // visitor with no claims still sees a Tag control; it is inert, and says why.
  function eligibleBuildsFor(contributorKey) {
    return majorityBuilds()
      .filter((build) => contributorsOf(build).some((c) => c && c.builderKey === contributorKey))
      .filter((build) => Boolean(StewardParticipation.standingForBuild(state, build.buildKey)))
      .sort((a, b) => (piecesOf(b) || 0) - (piecesOf(a) || 0) || a.buildKey.localeCompare(b.buildKey));
  }

  function tagLabel(id) {
    for (const group of Object.values(typeof KINSHIP_TAGS === 'undefined' ? {} : KINSHIP_TAGS)) {
      const hit = (group || []).find((pair) => pair && pair[0] === id);
      if (hit) return hit[1];
    }
    return id;
  }

  function tagChips(merged) {
    const wrap = kinNode('span', null, 'kin-tags');
    for (const id of merged?.confirmed || []) wrap.append(kinNode('span', tagLabel(id), 'chip kin-chip confirmed'));
    for (const id of merged?.pending || []) wrap.append(kinNode('span', tagLabel(id), 'chip kin-chip pending'));
    return wrap;
  }

  const mergedTags = (buildKey, contributorKey) => mergeKinshipTags(confirmedTags, state.kinshipTags, buildKey, contributorKey);

  /* ---- the tree ---- */

  // A co-builder's portrait opens the two of them together rather than dropping the
  // reader on a cold profile: the tree is a picture of pairings, so its nodes lead to
  // the pairing. The anchor keeps its own page.
  function renderTree() {
    treeHandle = drawKinshipTree(
      {svg: $('kin-tree-svg'), nodes: $('kin-nodes'), tip: $('kin-tip'), canvas: $('kin-tree')},
      layout, tree, {
        anchorKey: anchor,
        nameFor,
        isUnnamedKey: unnamedKey,
        portraits: portraitManifest,
        hrefFor: (key, isAnchor) => (isAnchor ? builderHref(key) : pairHref(key)),
        tipFor: (key, branch) => (branch ? branchTip(branch) : anchorTip()),
        anchorMeta: kinPlural(tree.coBuilderCount || 0, 'co-builder'),
        branchMeta: (branch) => `${kinCount(branch?.totalSharedPieces)} shared pieces`,
      });
    renderOverflowNote();
  }

  function renderOverflowNote() {
    const panel = $('kin-tree-panel');
    let note = $('kin-overflow-note');
    if (!note) {
      note = kinNode('p', null, 'muted');
      note.id = 'kin-overflow-note';
      panel.insertBefore(note, $('kin-legend'));
    }
    note.textContent = layout.overflow
      ? `The tree draws the ${layout.branches.length} closest branches. All ${kinCount(tree.coBuilderCount)} co-builders are listed in the Ledger, including the ${kinCount(layout.overflow)} not drawn here.`
      : `Every co-builder on this thread is drawn. The Ledger lists the same ${kinPlural(tree.coBuilderCount || 0, 'builder')} as a table.`;
  }

  /* ---- the tooltip ---- */

  function spanLine(span) {
    const build = resolveBuild((span.builds || [])[0]);
    const label = (span.builds || []).length > 1 ? kinPlural(span.builds.length, 'build') : (build?.label || 'shared build');
    const pieces = span.legacy ? 'shares unknown' : `${kinCount(span.sharedPieces)} shared pieces`;
    const li = kinNode('li', `Era ${span.era} · ${label} · ${pieces}`);
    if (build?.worldUrl) {
      li.append(' ');
      const open = kinLink('World viewer', build.worldUrl);
      open.className = 'kin-open';
      li.append(open);
    }
    return li;
  }

  function branchTip(branch) {
    const frag = document.createDocumentFragment();
    if (!branch) return frag;
    const heading = kinNode('p', null, 'kin-tip-name');
    heading.append(nameSpan(branch.builderKey), unnamedChip(branch.builderKey));
    frag.append(heading);
    const list = kinNode('ul', null, 'kin-tip-eras');
    for (const span of branch.spans || []) list.append(spanLine(span));
    frag.append(list);
    const page = kinLink('Open builder page', builderHref(branch.builderKey));
    page.className = 'kin-open';
    frag.append(page);
    return frag;
  }

  function anchorTip() {
    const frag = document.createDocumentFragment();
    frag.append(nameSpan(anchor, 'p', 'kin-tip-name'));
    const bounds = eraBounds(thread);
    frag.append(kinNode('p', `${kinPlural(tree.coBuilderCount || 0, 'co-builder')} · eras ${bounds.first}–${bounds.latest}`, 'muted'));
    const page = kinLink('Open builder page', builderHref(anchor));
    page.className = 'kin-open';
    frag.append(page);
    return frag;
  }

  /* ---- the ledger ---- */

  function branchBuilds(branch) {
    const builds = [];
    for (const span of branch.spans || []) {
      for (const entry of span.builds || []) {
        const album = resolveBuild(entry);
        if (album) builds.push(album);
      }
    }
    return builds;
  }

  function anchorShareRange(builds) {
    const shares = builds.map((album) => shareOf(album, anchor)).filter((s) => typeof s === 'number');
    if (!shares.length) return 'unknown';
    const low = kinPercent(Math.min(...shares));
    const high = kinPercent(Math.max(...shares));
    return low === high ? low : `${low}–${high}`;
  }

  function ledgerRow(branch) {
    const tr = document.createElement('tr');
    tr.dataset.builderKey = branch.builderKey;
    const builds = branchBuilds(branch);

    const who = kinNode('td', null, 'kin-ledger-who');
    who.append(kinPortrait(branch.builderKey), creditLink(branch.builderKey), unnamedChip(branch.builderKey));
    tr.append(who);

    const eras = kinNode('td');
    for (const span of branch.spans || []) eras.append(kinNode('span', `Era ${span.era}`, span.legacy ? 'chip kin-chip-legacy' : 'chip'));
    tr.append(eras);

    tr.append(kinNode('td', kinCount(branch.totalSharedAlbums)));

    const pieces = kinNode('td');
    pieces.append(kinNode('span', kinCount(branch.totalSharedPieces), 'counter'));
    tr.append(pieces);

    tr.append(kinNode('td', anchorShareRange(builds)));
    tr.append(kinNode('td', kinCount(builds.filter((album) => majorityOwner(album, anchor) !== null).length)));

    const tags = kinNode('td');
    tags.append(tagChips(branch.tags));
    tr.append(tags);

    const action = kinNode('td');
    const eligible = eligibleBuildsFor(branch.builderKey);
    action.append(tagButton(eligible[0] || null, branch.builderKey, 'Tag'));
    // The ledger row knows the pairing but not which of its builds to open on, so this
    // link names only the co-builder and lets the pair view pick.
    const pair = kinLink('Pair view', pairHref(branch.builderKey));
    pair.className = 'kin-open kin-pair-link';
    action.append(pair);
    tr.append(action);
    return tr;
  }

  function renderLedger() {
    const body = $('kin-ledger').tBodies[0];
    body.replaceChildren();
    const branches = tree.branches || [];
    for (const branch of branches.slice(0, ledgerShown)) body.append(ledgerRow(branch));
    const more = $('kin-ledger-more');
    const remaining = Math.max(0, branches.length - ledgerShown);
    more.hidden = remaining === 0;
    more.textContent = `Show ${kinCount(remaining)} more co-builders`;
    hydrateNames(body);
  }

  /* ---- builds the anchor holds ---- */

  function shareBar(build) {
    const bar = kinNode('div', null, 'kin-share-bar');
    const total = piecesOf(build);
    const rows = contributorsOf(build)
      .map((c) => ({key: c.builderKey, share: shareOf(build, c.builderKey) ?? 0}))
      .filter((row) => row.share > 0)
      .sort((a, b) => (a.key === anchor ? -1 : b.key === anchor ? 1 : b.share - a.share));
    for (const row of rows) {
      const seg = kinNode('span', null, row.key === anchor ? 'kin-share-seg is-anchor' : 'kin-share-seg');
      seg.style.width = `${row.share * 100}%`;
      seg.title = `${nameFor(row.key)} · ${kinPercent(row.share)}`;
      bar.append(seg);
    }
    if (!rows.length && total == null) bar.classList.add('is-unknown');
    return bar;
  }

  function buildLinks(build) {
    const album = albumFor(build);
    const row = kinNode('p', null, 'kin-build-links');
    const worldUrl = build.worldUrl || album?.worldUrl;
    const galleryUrl = build.galleryUrl || album?.galleryUrl;
    if (worldUrl) {
      const a = kinLink('World viewer', worldUrl);
      a.className = 'kin-open';
      row.append(a);
    }
    if (galleryUrl) {
      if (row.childNodes.length) row.append(' · ');
      const a = kinLink('Gallery', galleryUrl);
      a.className = 'kin-open';
      row.append(a);
    }
    return row.childNodes.length ? row : null;
  }

  function tagButton(build, contributorKey, label) {
    const btn = kinNode('button', label, 'kin-tag-btn');
    btn.type = 'button';
    if (!build || !canTag(build)) {
      // Never the disabled attribute: a disabled button swallows the tap that would
      // otherwise explain why it is off, which on a touch screen is simply nothing.
      const disavowed = build ? disavowalFor(build.buildKey) : null;
      btn.classList.add('inert');
      btn.setAttribute('aria-disabled', 'true');
      btn.title = disavowed ? 'You marked this build as not yours' : 'Claim this build first';
      btn.onclick = () => kinToast(disavowed
        ? 'You marked this build as not yours, so its co-builders are not yours to tag.'
        : 'Claim this build before tagging co-builders.');
      return btn;
    }
    btn.onclick = () => openTagDialog({build, contributorKey});
    return btn;
  }

  function cohabRow(build, contributorKey, share) {
    const row = kinNode('div', null, 'kin-cohab');
    row.append(kinPortrait(contributorKey));
    const main = kinNode('div', null, 'kin-cohab-main');
    const line = kinNode('span', null, 'kin-cohab-name');
    line.append(creditLink(contributorKey), unnamedChip(contributorKey));
    main.append(line);
    main.append(tagChips(mergedTags(build.buildKey, contributorKey)));
    row.append(main);
    const side = kinNode('div', null, 'kin-cohab-side');
    // Beside the share, not folded into it: the share is pieces over pieces and a bed adds
    // nothing to either side of that fraction. Nothing here auto-checks `basemate` -- that
    // tag is one builder saying so about another, and a bed is not their testimony.
    const beds = bedsOf(build, contributorKey);
    if (beds > 0) side.append(kinNode('span', kinPlural(beds, 'bed'), 'kin-cohab-beds'));
    side.append(kinNode('span', share == null ? 'share unknown' : kinPercent(share), 'kin-cohab-share'));
    const merged = mergedTags(build.buildKey, contributorKey);
    const label = (merged.confirmed.length || merged.pending.length) ? '+' : 'Tag';
    // A build this browser has disavowed carries no Tag control at all, not an inert one:
    // "claim this first" is the wrong nudge for a build you have just said is not yours.
    if (!disavowalFor(build.buildKey)) side.append(tagButton(build, contributorKey, label));
    // Unlike the ledger row, this one is already standing on one build -- so the pair
    // view opens on that build rather than on whichever the pairing leads with.
    const pair = kinLink('Pair view', pairHref(contributorKey, build.buildKey));
    pair.className = 'kin-open kin-pair-link';
    side.append(pair);
    row.append(side);
    return row;
  }

  function buildCard(build) {
    const card = kinNode('article', null, 'kin-build');
    card.dataset.buildKey = build.buildKey;
    card.append(kinNode('h3', labelOf(build)));

    const pieces = piecesOf(build);
    const ownership = build.ownership === 'majority' ? 'majority' : 'largest share';
    const photos = photoCountOf(build);
    const meta = [`Era ${build.era}`, pieces == null ? 'pieces unknown' : kinPlural(pieces, 'piece'), ownership];
    if (photos) meta.push(kinPlural(photos, 'photo'));
    card.append(kinNode('p', meta.join(' · '), 'muted'));

    card.append(shareBar(build));
    card.append(kinNode('p', 'shares are pieces ÷ build pieces; the gap is unattributed pieces', 'muted kin-share-note'));

    const links = buildLinks(build);
    if (links) card.append(links);

    const others = contributorsOf(build)
      .filter((c) => c && c.builderKey !== anchor)
      .map((c) => ({key: c.builderKey, share: shareOf(build, c.builderKey)}))
      .sort((a, b) => (b.share || 0) - (a.share || 0) || a.key.localeCompare(b.key));
    for (const other of others.slice(0, COHAB_ROWS_PER_BUILD)) card.append(cohabRow(build, other.key, other.share));
    if (others.length > COHAB_ROWS_PER_BUILD) {
      card.append(kinNode('p', `${kinCount(others.length - COHAB_ROWS_PER_BUILD)} more contributors on this build.`, 'muted'));
    }
    if (!others.length) card.append(kinNode('p', 'No other builder placed a saved piece here.', 'muted'));

    const claim = StewardParticipation.claimForBuild(state, build.buildKey);
    if (claim) {
      const verb = claim.kind === 'disavow' ? 'Disavowed' : 'Claimed';
      card.append(kinNode('span', `${verb} by ${claim.participant}`, 'chip claimed'));
    } else {
      // Both controls, side by side and unequal: a build the archive says you lead is
      // most often yours, but the only person who can say it is not is you. Without the
      // second control the page can only ever be told yes, and a wrong majority owner
      // has nowhere to put a correction.
      const row = kinNode('div', null, 'actions-row');
      row.append(claimButton(build, 'built'), claimButton(build, 'disavow'));
      card.append(row);
    }
    return card;
  }

  function renderBuilds() {
    const list = $('kin-build-list');
    list.replaceChildren();
    const builds = majorityBuilds();
    if (!builds.length) {
      list.append(kinNode('p', 'No build on this thread has you as its leading contributor under the current filter.', 'muted'));
    }
    for (const build of builds.slice(0, buildsShown)) list.append(buildCard(build));
    if (builds.length > buildsShown) {
      const more = kinNode('button', `Show ${kinCount(builds.length - buildsShown)} more builds`, 'kin-more-builds');
      more.type = 'button';
      more.onclick = () => {
        buildsShown += BUILD_PAGE;
        renderBuilds();
        hydrateNames(list);
      };
      list.append(more);
    }

    const rest = otherSharedBuilds();
    if (rest.length) {
      const section = kinNode('div', null, 'kin-other');
      section.append(kinNode('h3', 'Other shared builds'));
      section.append(kinNode('p', 'Only the majority owner of a build can tag its co-builders.', 'muted'));
      for (const album of rest.slice(0, OTHER_BUILD_LIMIT)) {
        const share = shareOf(album, anchor);
        const line = kinNode('p', null, 'kin-other-build');
        line.append(kinNode('span', labelOf(album), 'kin-other-label'));
        line.append(kinNode('span', `Era ${album.era} · ${share == null ? 'your share unknown' : `your share ${kinPercent(share)}`}`, 'muted'));
        section.append(line);
      }
      if (rest.length > OTHER_BUILD_LIMIT) {
        section.append(kinNode('p', `${kinCount(rest.length - OTHER_BUILD_LIMIT)} more shared builds are on the thread page.`, 'muted'));
      }
      list.append(section);
    }
    hydrateNames(list);
  }

  function renderCohabs() {
    const list = $('kin-cohab-list');
    list.replaceChildren();
    const tally = new Map();
    for (const build of majorityBuilds()) {
      for (const c of contributorsOf(build)) {
        if (!c || c.builderKey === anchor) continue;
        const entry = tally.get(c.builderKey) || {builderKey: c.builderKey, pieces: 0, builds: []};
        entry.pieces += c.pieces || 0;
        entry.builds.push(build);
        tally.set(c.builderKey, entry);
      }
    }
    const top = [...tally.values()]
      .sort((a, b) => b.pieces - a.pieces || b.builds.length - a.builds.length || a.builderKey.localeCompare(b.builderKey))
      .slice(0, COHAB_LIMIT);

    if (!top.length) {
      list.append(kinNode('p', 'Nobody else placed a saved piece on the builds you hold.', 'muted'));
      return;
    }

    for (const entry of top) {
      const row = kinNode('div', null, 'kin-cohab');
      row.append(kinPortrait(entry.builderKey));
      const main = kinNode('div', null, 'kin-cohab-main');
      const line = kinNode('span', null, 'kin-cohab-name');
      line.append(creditLink(entry.builderKey), unnamedChip(entry.builderKey));
      main.append(line);
      // The largest shared build is the one a tag is likeliest to be about, and it is
      // also the one whose claim the anchor most likely already holds. A build already
      // disavowed is the one build it certainly is not about.
      const eligible = entry.builds
        .slice()
        .sort((a, b) => (piecesOf(b) || 0) - (piecesOf(a) || 0) || a.buildKey.localeCompare(b.buildKey));
      const preferred = eligible.find((b) => canTag(b))
        || eligible.find((b) => !disavowalFor(b.buildKey))
        || eligible[0];
      main.append(tagChips(mergedTags(preferred.buildKey, entry.builderKey)));
      row.append(main);
      const side = kinNode('div', null, 'kin-cohab-side');
      side.append(kinNode('span', kinPlural(entry.builds.length, 'build'), 'kin-cohab-share'));
      const merged = mergedTags(preferred.buildKey, entry.builderKey);
      side.append(tagButton(preferred, entry.builderKey, (merged.confirmed.length || merged.pending.length) ? '+' : 'Tag'));
      row.append(side);
      list.append(row);
    }
    hydrateNames(list);
  }

  /* ---- claiming and tagging ---- */

  // One table for both directions so the control, the sheet's heading and its confirm
  // label cannot drift apart: the button that opened the sheet is the sentence it says.
  const CLAIM_KINDS = {
    built: {control: 'I built this', cls: 'primary', title: 'Claim build', confirm: 'I built this'},
    disavow: {control: 'Not mine', cls: 'claim-disavow', title: 'Not my build', confirm: "This isn't mine"},
  };

  function claimButton(build, kind) {
    const copy = CLAIM_KINDS[kind] || CLAIM_KINDS.built;
    const btn = kinNode('button', copy.control, copy.cls);
    btn.type = 'button';
    btn.dataset.claimKind = kind;
    btn.onclick = () => openClaimDialog(build, kind);
    return btn;
  }

  function openClaimDialog(build, kind = 'built') {
    const copy = CLAIM_KINDS[kind] || CLAIM_KINDS.built;
    const label = labelOf(build);
    // The sheet is shared, so every opening has to set both directions rather than only
    // the one that differs: a dialog opened once as a disavowal stays worded as one.
    claimModal.dataset.claimKind = kind;
    // The guidance paragraphs are kind-scoped in the markup (same dialog as index.html):
    // show the one for this kind, hide the other, every time the sheet opens.
    for (const block of claimModal.querySelectorAll('[data-claim-kind]')) {
      block.hidden = block.dataset.claimKind !== kind;
    }
    $('claim-title').textContent = copy.title;
    $('claim-confirm').textContent = copy.confirm;
    $('claim-build-label').textContent = `${label} · era ${build.era}`;
    $('claim-handle').value = state.participant || '';
    $('claim-note').value = '';
    $('claim-confirm').onclick = async () => {
      // normalizeHandle substitutes a placeholder, so the raw field is what decides
      // whether a handle was typed; `required` is inert outside a <form>.
      const typed = $('claim-handle').value.trim();
      if (!typed) return kinToast('Add a volunteer handle so the claim can be matched to you.');
      const participant = normalizeHandle(typed);
      const claim = {
        claimId: randomId('claim'),
        buildKey: build.buildKey,
        // One record per build either way, so saying "not mine" replaces an earlier
        // "I built this" and vice versa rather than leaving both on the ledger.
        kind,
        builderKey: anchor,
        participant,
        buildLabel: label,
        era: build.era,
        createdAt: nowISOString(),
        note: $('claim-note').value.trim(),
      };
      let deliveryStatus = 'queued';
      try {
        await submitPayload(endpoint, {schema: 'steward-creator-participation-event/v1', eventType: 'claim', claim});
        deliveryStatus = 'submitted';
      } catch {
        // keep local state regardless of endpoint availability
      }
      claim.deliveryStatus = deliveryStatus;
      state.participant = participant;
      StewardParticipation.putClaim(state, claim);
      StewardParticipation.save(state);
      kinCloseModal(claimModal);
      if (deliveryStatus === 'submitted') kinToast(kind === 'disavow' ? 'Disavowal sent.' : 'Claim sent.');
      else await kinCopyPayload(StewardParticipation.exportPayload(state, {kindFilter: 'claim', buildKey: build.buildKey}));
      renderBuilds();
      renderCohabs();
      renderLedger();
    };
    $('claim-cancel').onclick = () => kinCloseModal(claimModal);
    kinOpenModal(claimModal);
  }

  function openTagDialog({build, contributorKey}) {
    const select = $('kin-tag-build');
    const boxes = [...tagModal.querySelectorAll('input[name="kin-tag"]')];
    const options = eligibleBuildsFor(contributorKey);
    if (!options.some((b) => b.buildKey === build.buildKey)) options.unshift(build);
    const byKey = new Map(options.map((b) => [b.buildKey, b]));

    select.replaceChildren(...options.map((option) => {
      const el = kinNode('option', `${labelOf(option)} · era ${option.era}`);
      el.value = option.buildKey;
      return el;
    }));
    select.value = build.buildKey;
    $('kin-tag-contributor').textContent = `Tagging ${nameFor(contributorKey)} — a self-reported note about how you built together.`;
    $('kin-tag-inline').textContent = '';
    // The note is the only field on the page that can carry a name the saved world never
    // recorded, so for an unnamed contributor it asks for one -- and promises nothing
    // about publishing it, because nothing is published without a coordinator.
    $('kin-tag-note').placeholder = unnamedKey(contributorKey)
      ? 'Know who this is? Put the name here for the coordinator.'
      : TAG_NOTE_PLACEHOLDER;

    const syncToBuild = () => {
      const current = byKey.get(select.value) || build;
      $('kin-tag-build-label').textContent = `${labelOf(current)} · era ${current.era}`;
      // Context for the person choosing a tag, and only context: the dialog follows the
      // build select, so switching builds re-answers it. It never ticks a box -- `basemate`
      // is one builder's word about another, and a bed the world saved is not their word.
      const beds = bedsOf(current, contributorKey);
      $('kin-tag-beds').textContent = beds > 0 ? `slept here (${kinPlural(beds, 'bed')})` : '';
      const pending = StewardParticipation.tagFor(state, current.buildKey, contributorKey);
      const chosen = new Set(pending?.tags || []);
      for (const box of boxes) box.checked = chosen.has(box.value);
      $('kin-tag-note').value = pending?.note || '';
    };
    select.onchange = syncToBuild;
    syncToBuild();

    $('kin-tag-confirm').onclick = async () => {
      const current = byKey.get(select.value) || build;
      const claim = StewardParticipation.standingForBuild(state, current.buildKey);
      if (!claim) {
        $('kin-tag-inline').textContent = disavowalFor(current.buildKey)
          ? 'You marked this build as not yours, so its co-builders are not yours to tag.'
          : 'Claim this build before tagging co-builders.';
        return;
      }
      const tags = boxes.filter((box) => box.checked).map((box) => box.value);
      let record;
      try {
        record = kinshipTagRecord({
          buildKey: current.buildKey,
          era: current.era,
          builderKey: anchor,
          contributorKey,
          tags,
          note: $('kin-tag-note').value.trim(),
          participant: state.participant,
          claimId: claim.claimId,
        });
      } catch {
        $('kin-tag-inline').textContent = 'Choose at least one tag.';
        return;
      }
      let deliveryStatus = 'queued';
      try {
        await submitPayload(endpoint, {schema: 'steward-creator-participation-event/v1', eventType: 'kinshipTag', kinshipTag: record});
        deliveryStatus = 'submitted';
      } catch {
        // keep local state regardless of endpoint availability
      }
      record.deliveryStatus = deliveryStatus;
      StewardParticipation.putKinshipTag(state, record);
      StewardParticipation.save(state);
      kinCloseModal(tagModal);
      if (deliveryStatus === 'submitted') kinToast('Kinship tag sent.');
      else await kinCopyPayload(StewardParticipation.exportPayload(state, {kindFilter: 'kinship', buildKey: current.buildKey}));
      rebuild();
    };
    $('kin-tag-cancel').onclick = () => kinCloseModal(tagModal);
    kinOpenModal(tagModal);
  }

  /* ---- anchor bar, tabs, filters ---- */

  function renderAnchorPill() {
    const pill = $('kin-anchor-pill');
    if (!thread) { pill.hidden = true; return; }
    pill.hidden = false;
    const portrait = kinPortrait(anchor);
    portrait.id = 'kin-anchor-portrait';
    $('kin-anchor-portrait').replaceWith(portrait);
    const name = $('kin-anchor-name');
    name.textContent = thread.displayName || nameFor(anchor);
    name.href = builderHref(anchor);
    const bounds = eraBounds(thread);
    const span = bounds.first == null ? 'no recorded era' : `eras ${bounds.first}–${bounds.latest}`;
    $('kin-anchor-meta').textContent = `${kinPlural(tree?.coBuilderCount || 0, 'co-builder')} · ${span}`;
  }

  function renderStatus() {
    const total = tree?.coBuilderCount || 0;
    const eras = tree?.eras?.length || 0;
    const filterNote = activeFilter === 'majority' ? ' · builds you lead only'
      : activeFilter === 'photographed' ? ' · photographed builds only' : '';
    $('status').textContent = total
      ? `${thread.displayName} built beside ${kinPlural(total, 'builder')} across ${kinPlural(eras, 'era')}${filterNote}.`
      : `No other builder placed a saved piece on ${thread.displayName}'s builds${filterNote}.`;
  }

  function selectTab(mode) {
    const ledger = mode === 'ledger';
    $('kin-tab-tree').setAttribute('aria-selected', String(!ledger));
    $('kin-tab-ledger').setAttribute('aria-selected', String(ledger));
    $('kin-tree-panel').hidden = ledger;
    $('kin-ledger-panel').hidden = !ledger;
    const next = new URLSearchParams(location.search);
    if (ledger) next.set('mode', 'ledger');
    else next.delete('mode');
    const query = next.toString();
    history.replaceState(null, '', query ? `${location.pathname}?${query}` : location.pathname);
    if (!ledger && treeHandle) treeHandle.hideTip();
  }

  function wireTabs() {
    $('kin-tab-tree').onclick = () => selectTab('tree');
    $('kin-tab-ledger').onclick = () => selectTab('ledger');
    $('kin-ledger-more').onclick = () => {
      ledgerShown += LEDGER_PAGE;
      renderLedger();
    };
    for (const chip of document.querySelectorAll('[data-kin-filter]')) {
      chip.onclick = () => {
        activeFilter = chip.dataset.kinFilter;
        for (const other of document.querySelectorAll('[data-kin-filter]')) other.classList.toggle('active', other === chip);
        rebuild();
      };
    }
    $('kin-copy-invite').onclick = async () => {
      const invite = kinshipHref(anchor);
      if (!navigator.clipboard?.writeText) return kinShowPayloadFallback(invite, 'Copy the invite link from this box.');
      try {
        await navigator.clipboard.writeText(invite);
        kinToast('Invite link copied.');
      } catch {
        kinShowPayloadFallback(invite, 'Clipboard unavailable. Copy the invite link from this box.');
      }
    };
    $('activity-copy').onclick = async () => {
      const text = $('activity-payload').value;
      if (!navigator.clipboard?.writeText) return;
      try {
        await navigator.clipboard.writeText(text);
        kinToast('Payload copied.');
      } catch {
        kinToast('Clipboard unavailable. Copy the payload by hand.');
      }
    };
    $('activity-close').onclick = () => kinCloseModal(activityModal);
    for (const modal of [claimModal, tagModal, activityModal]) {
      modal.addEventListener('click', (event) => { if (event.target === modal) kinCloseModal(modal); });
    }
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      kinCloseAllModals();
      if (treeHandle) treeHandle.hideTip();
      closeSuggestions();
    });
  }

  // A rotate or a window drag fires resize by the dozen, and a rebuild is a full redraw of
  // the tree, the ledger and both aside cards. Debounce it, and then redraw only when the
  // answer actually changed: every resize inside one breakpoint costs nothing at all.
  function wireViewport() {
    addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!thread || kinBranchCap() === branchCap) return;
        rebuild();
      }, 150);
    });
  }

  /* ---- the anchor switcher ---- */

  function closeSuggestions() {
    suggestions = [];
    activeSuggestion = -1;
    const list = $('kin-suggestions');
    list.hidden = true;
    list.replaceChildren();
    $('kin-search').setAttribute('aria-expanded', 'false');
    $('kin-search').removeAttribute('aria-activedescendant');
  }

  function renderSuggestions() {
    const list = $('kin-suggestions');
    const typed = $('kin-search').value.trim();
    const q = typed.toLocaleLowerCase();
    if (!directory || typed.length < 2) return closeSuggestions();
    suggestions = filterBuilders(directory.builders, {query: typed})
      .sort((a, b) => compareBuilders(a, b, q))
      .slice(0, SUGGESTION_LIMIT);
    activeSuggestion = -1;
    if (!suggestions.length) return closeSuggestions();

    list.replaceChildren();
    suggestions.forEach((builder, index) => {
      const item = kinNode('li', null, 'suggestion');
      item.id = `kin-suggestion-${index}`;
      item.setAttribute('role', 'option');
      // A navigation, not a state swap: the address the switcher lands on is exactly
      // the invite link someone would paste to a co-builder.
      const a = kinLink('', kinshipHref(builder.builderKey));
      a.append(kinNode('span', builder.displayName, 'suggestion-name'));
      const alias = searchTerms(builder).find((t) => t !== builder.displayName && t.toLocaleLowerCase().includes(q));
      if (alias) a.append(kinNode('span', `also “${alias}”`, 'suggestion-alias'));
      a.append(kinNode('span', `${kinPlural(builder.albums, 'build')} · ${kinCount(builder.photos)} photos`, 'suggestion-counts'));
      item.append(a);
      list.append(item);
    });
    list.hidden = false;
    $('kin-search').setAttribute('aria-expanded', 'true');
  }

  function highlightSuggestion(delta) {
    if (!suggestions.length) return false;
    // One slot past the end returns to the raw typed text, the way the directory does.
    activeSuggestion = (activeSuggestion + delta + suggestions.length + 2) % (suggestions.length + 1) - 1;
    const list = $('kin-suggestions');
    [...list.children].forEach((li, i) => li.classList.toggle('active', i === activeSuggestion));
    if (activeSuggestion < 0) $('kin-search').removeAttribute('aria-activedescendant');
    else $('kin-search').setAttribute('aria-activedescendant', `kin-suggestion-${activeSuggestion}`);
    return true;
  }

  function wireSwitcher() {
    const search = $('kin-search');
    search.oninput = () => renderSuggestions();
    search.onkeydown = (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (highlightSuggestion(event.key === 'ArrowDown' ? 1 : -1)) event.preventDefault();
      } else if (event.key === 'Enter' && suggestions.length) {
        event.preventDefault();
        const pick = suggestions[activeSuggestion >= 0 ? activeSuggestion : 0];
        location.href = kinshipHref(pick.builderKey);
      } else if (event.key === 'Escape') {
        closeSuggestions();
      }
    };
    // A click on a suggestion is a mousedown-then-blur, so closing has to wait for the
    // anchor's own navigation to start.
    search.onblur = () => setTimeout(closeSuggestions, 180);
  }

  /* ---- assembly ---- */

  function filteredThread() {
    if (activeFilter === 'all') return thread;
    const keep = activeFilter === 'majority'
      ? (album) => majorityOwner(album, anchor) !== null
      : (album) => Boolean(album.photos && album.photos.length);
    const eras = (thread.eras || [])
      .map((era) => ({...era, albums: (era.albums || []).filter(keep)}))
      .filter((era) => era.albums.length);
    return {...thread, eras};
  }

  function rebuild() {
    const source = filteredThread();
    visibleAlbums = (source.eras || []).flatMap((era) => era.albums || []);
    tree = buildKinshipTree(source, {confirmedTags, localTags: state.kinshipTags});
    branchCap = kinBranchCap();
    // padBottom: room under the oldest band for the labels hanging off its nodes.
    layout = layoutKinshipTree(tree, {maxBranches: branchCap, padBottom: 104});
    ledgerShown = LEDGER_PAGE;
    buildsShown = BUILD_PAGE;
    renderTree();
    renderLedger();
    renderBuilds();
    renderCohabs();
    renderAnchorPill();
    renderStatus();
    hydrateNames();
  }

  function anchorBarOnly(message) {
    $('status').textContent = message;
    $('kin-tabs').hidden = true;
    $('kin-filters').hidden = true;
    document.querySelector('.kin-layout').hidden = true;
    $('kin-anchor-pill').hidden = true;
  }

  wireTabs();
  wireSwitcher();
  wireViewport();

  const directoryLoad = kinReadOptional('directory.json').then((doc) => {
    if (!doc) return;
    directory = doc;
    buildersByKey = new Map(doc.builders.map((b) => [b.builderKey, b]));
    if (typeof StewardPortraits === 'object') {
      const published = {};
      for (const b of doc.builders) if (b.portrait && b.portrait.tile) published[b.builderKey] = b.portrait;
      StewardPortraits.setPublished(published, {merge: true});
      if (portraitManifest) hydratePortraits();
    }
    hydrateNames();
    if (thread) renderAnchorPill();
  });

  if (!anchor || !KEY_PATTERN.test(anchor)) {
    anchorBarOnly('Pick a builder to draw their tree.');
    await directoryLoad;
    $('kin-search').focus({preventScroll: true});
    return;
  }

  try {
    thread = await kinRead(`threads/${anchor}.json`);
  } catch {
    anchorBarOnly('That builder has no thread in this archive. Pick another to draw their tree.');
    await directoryLoad;
    return;
  }

  indexAlbums(thread);
  rebuild();
  if (new URLSearchParams(location.search).get('mode') === 'ledger') selectTab('ledger');

  kinReadOptional('participation.json').then((doc) => {
    const tags = Array.isArray(doc?.confirmedTags) ? doc.confirmedTags : [];
    if (!tags.length) return;
    confirmedTags = tags;
    rebuild();
  });

  kinReadOptional('/chronicles/portraits.json').then((manifest) => {
    if (!manifest || !Array.isArray(manifest.tiles) || !manifest.tiles.length) return;
    portraitManifest = manifest;
    hydratePortraits();
  });
};

if (typeof document !== 'undefined' && document.documentElement.dataset.stewardPage === 'kinship') initKinshipPage();
