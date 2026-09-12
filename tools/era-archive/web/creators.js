'use strict';

// "Builder 8014fa60" is what community.py writes when no single recorded name won.
// Those are real threads and stay searchable, they are just nobody's own name.
const PLACEHOLDER_NAME = /^Builder [0-9a-f]{8}$/;
// gallery.py's auto-generated album label when a build has no source-recorded title.
const AUTO_ALBUM_LABEL = /^Build [0-9a-f]{8}$/;

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

// New sort modes for the redesign. Each keeps the existing search-relevance priority (a
// live query still wins first, in every mode) and ends on the full 32-hex builderKey so
// two builders that tie on the visible metric still render in a fixed order instead of
// reshuffling between renders.
const SORT_MODES = {
  default: {label: 'Default', compare: compareBuilders},
  photos: {
    label: 'Most photos',
    compare(a, b, q) {
      if (q) {
        const byMatch = matchScore(a, q) - matchScore(b, q);
        if (byMatch) return byMatch;
      }
      if (b.photos !== a.photos) return b.photos - a.photos;
      return a.builderKey.localeCompare(b.builderKey);
    },
  },
  az: {
    label: 'A–Z',
    compare(a, b, q) {
      if (q) {
        const byMatch = matchScore(a, q) - matchScore(b, q);
        if (byMatch) return byMatch;
      }
      const byName = a.displayName.localeCompare(b.displayName, undefined, {sensitivity: 'base'});
      if (byName) return byName;
      return a.builderKey.localeCompare(b.builderKey);
    },
  },
  albums: {
    label: 'Most albums',
    compare(a, b, q) {
      if (q) {
        const byMatch = matchScore(a, q) - matchScore(b, q);
        if (byMatch) return byMatch;
      }
      if (b.albums !== a.albums) return b.albums - a.albums;
      return a.builderKey.localeCompare(b.builderKey);
    },
  },
};

// Pure filter composition: search + era + With Albums, in the order applyFilter() uses
// them. Exported so it can be exercised without a DOM.
function filterBuilders(builders, {era, query, withAlbums} = {}) {
  const q = (query || '').trim().toLocaleLowerCase();
  return builders
    .filter((b) => (!era || b.eras.includes(Number(era))))
    .filter((b) => !withAlbums || b.albums > 0)
    .filter((b) => !q || searchTerms(b).some((x) => x.toLocaleLowerCase().includes(q)));
}

// Archive-wide hero totals. `directory.photography.photos` (not a sum of each builder's
// own `photos` field) is authoritative because a shared album's photos would otherwise be
// counted once per credited contributor. Populated eras is the union of every builder's
// own `eras` list, since the top-level `eras[]` only covers terrain-analysed eras and
// omits the legacy photo-only eras (16, 17).
function computeHeroStats(directoryDoc) {
  const builders = directoryDoc.builders.length;
  const captures = directoryDoc.photography?.photos ?? 0;
  const buildersWithPhotos = directoryDoc.photography?.buildersWithPhotos ?? 0;
  const populatedEras = new Set(directoryDoc.builders.flatMap((b) => b.eras)).size;
  return {builders, captures, buildersWithPhotos, populatedEras};
}

// Only a build with a source-recorded title is worth surfacing as a "signature creation" --
// gallery.py's auto-generated "Build <hex8>" label says nothing a builder would recognise.
function pickSignatureAlbums(threadDoc, limit = 2) {
  if (!threadDoc) return [];
  const albums = threadDoc.eras.flatMap((e) => e.albums);
  return albums
    .filter((a) => a.label && !AUTO_ALBUM_LABEL.test(a.label))
    .sort((a, b) => (b.pieces || 0) - (a.pieces || 0) || a.buildKey.localeCompare(b.buildKey))
    .slice(0, limit);
}

// Who this builder actually built beside. For every album on the thread, each other
// credited contributor scores one shared album and min(my pieces, their pieces) shared
// pieces -- the min, because the overlap two people can claim on one structure is bounded
// by the smaller of the two contributions; summing or averaging would let a 40,000-piece
// megabuilder swamp the ranking of everyone who ever touched one of their walls.
// Legacy imports carry `pieces: null` (evidence: legacy-leading-contributor); those count
// toward shared albums and contribute zero shared pieces rather than being dropped.
function computeTopEight(threadDoc, limit = 8) {
  if (!threadDoc) return [];
  const self = threadDoc.builderKey;
  const tally = new Map();
  for (const era of threadDoc.eras || []) {
    for (const album of era.albums || []) {
      const contributors = album.contributors || [];
      const mine = contributors.find((c) => c && c.builderKey === self);
      const myPieces = mine?.pieces ?? 0;
      for (const c of contributors) {
        if (!c || c.builderKey === self) continue;
        let entry = tally.get(c.builderKey);
        if (!entry) {
          entry = {builderKey: c.builderKey, sharedAlbums: 0, sharedPieces: 0};
          tally.set(c.builderKey, entry);
        }
        entry.sharedAlbums += 1;
        entry.sharedPieces += Math.min(myPieces, c.pieces ?? 0);
      }
    }
  }
  // Ends on the full builderKey so a tie renders in a fixed order instead of reshuffling
  // between renders, matching how the directory sort modes break their own ties.
  return [...tally.values()]
    .sort((a, b) => b.sharedPieces - a.sharedPieces
      || b.sharedAlbums - a.sharedAlbums
      || a.builderKey.localeCompare(b.builderKey))
    .slice(0, limit);
}

// Which portrait tile a builder wears. The key is already a uniformly distributed hash,
// so its first 32 bits modulo the tile count is a stable, serverless assignment: the same
// builder gets the same face on every device, every render, with no state anywhere. The
// count comes from the manifest rather than a constant, so adding tiles is a data change.
function portraitIndex(builderKey, count = 48) {
  if (!count) return 0;
  const parsed = parseInt(String(builderKey || '').slice(0, 8), 16);
  if (!Number.isFinite(parsed)) return 0;
  return ((parsed % count) + count) % count;
}

// The span the hero card states as "First era / Latest era". Read from the thread's own
// era blocks rather than the directory record, because a thread page renders before
// directory.json lands -- and only the thread knows which eras survived album filtering.
function eraBounds(threadDoc) {
  const eras = (threadDoc?.eras || []).map((e) => e.era).filter((e) => Number.isFinite(e));
  if (!eras.length) return {first: null, latest: null};
  return {first: Math.min(...eras), latest: Math.max(...eras)};
}

// The other names this builder is searchable under. The display name is one of them and
// must not be listed as an alias of itself, and community.py keeps casing variants of the
// same name as separate aliases -- "Tugcow" and "tugcow" are one name to a reader.
function heroAliases(threadDoc, limit = 4) {
  if (!threadDoc) return {shown: [], more: 0};
  const seen = new Set([String(threadDoc.displayName || '').toLocaleLowerCase()]);
  const kept = [];
  for (const alias of threadDoc.aliases || []) {
    const name = String(alias || '').trim();
    if (!name) continue;
    const folded = name.toLocaleLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    kept.push(name);
  }
  return {shown: kept.slice(0, limit), more: Math.max(0, kept.length - limit)};
}

// The builder's photographed albums, the ones most theirs first: by the pieces this
// builder placed there, then by how many photographs there are, then by size. A
// 2,000-piece hall they laid one wall of is not their work to lead with. The first
// frame of every album is already the best one -- import_captures sorts each album by
// the aesthetic head's score before it is ever projected, and the og:image has leaned
// on that for weeks -- so this never has to rank frames itself.
function pickMosaicAlbums(threadDoc, limit = 8) {
  if (!threadDoc) return [];
  const self = threadDoc.builderKey;
  const mine = (album) => (album.contributors || []).find((c) => c && c.builderKey === self)?.pieces ?? 0;
  return threadDoc.eras.flatMap((e) => e.albums)
    .filter((a) => Array.isArray(a.photos) && a.photos.length)
    .sort((a, b) => mine(b) - mine(a)
      || b.photos.length - a.photos.length
      || (b.pieces || 0) - (a.pieces || 0)
      || a.buildKey.localeCompare(b.buildKey))
    .slice(0, limit);
}

// Every album carries its attribution sentence in the data, and forty cards saying the
// same sentence forty times was the loudest thing on the page. The distinct sentences,
// standard one first (legacy imports word theirs differently), said once at the top.
function distinctAttributions(threadDoc) {
  if (!threadDoc) return [];
  const seen = new Set();
  const out = [];
  for (const era of threadDoc.eras || []) {
    for (const album of era.albums || []) {
      const text = String(album.attribution || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
  }
  return out.sort((a, b) => (a.startsWith('Every saved') ? 0 : 1) - (b.startsWith('Every saved') ? 0 : 1));
}

// ---------------------------------------------------------------------------
// Local-first participation rails. Hoisted out of the page closure so the kinship
// page can reuse them and so the pure-logic suite can exercise them in Node with an
// injected storage object -- nothing below touches `localStorage` or `document` at
// load time, only when it is called.
// ---------------------------------------------------------------------------

function nowISOString() {
  return new Date().toISOString();
}

function randomId(prefix) {
  const token = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(16).slice(2);
  return `${prefix}-${token}`;
}

function normalizeHandle(value) {
  const text = String(value || '').trim();
  return text || 'Anonymous volunteer';
}

async function submitPayload(endpoint, payload) {
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

// ---------------------------------------------------------------------------
// Kinship: who a builder built beside, and what the majority owner of a build says
// about them. A tag is self-reported and never edits the credited contributors --
// those come from the saved construction pieces and nothing else moves them.
// ---------------------------------------------------------------------------

// The closed tag vocabulary. Two groups because the modal asks two questions, one flat
// id set because everything downstream -- the record, the export, gallery.py's public
// sanitiser -- only ever needs "is this a tag we know".
const KINSHIP_TAGS = {
  relationship: [['basemate', 'Basemate'], ['collab', 'Collabing'], ['helping-hand', 'Helping hand'], ['visitor', 'Visitor']],
  role: [['mason', 'Mason'], ['roof', 'Roof'], ['fields', 'Fields'], ['portal', 'Portal'], ['defense', 'Defense'], ['interior', 'Interior']],
};
const KINSHIP_TAG_IDS = new Set([...KINSHIP_TAGS.relationship, ...KINSHIP_TAGS.role].map(([id]) => id));

// Who may speak for a build. A share at or above half is unambiguous. Below that the
// single biggest known share still counts, but only from a quarter up -- that is what a
// four-way collaboration looks like, and under it nobody is the owner. A tie has no
// owner either, and a legacy import carries no share at all (evidence:
// legacy-leading-contributor), so it owns nothing: a percentage there would imply a
// precision the historical import never had.
function majorityOwner(album, builderKey) {
  const contributors = (album && album.contributors) || [];
  const mine = contributors.find((c) => c && c.builderKey === builderKey);
  if (!mine || mine.share == null) return null;
  if (mine.share >= 0.5) return 'majority';
  if (mine.share < 0.25) return null;
  for (const other of contributors) {
    if (!other || other.builderKey === builderKey || other.share == null) continue;
    if (other.share >= mine.share) return null;
  }
  return 'largest';
}

const emptyKinshipTree = () => ({anchor: null, eras: [], branches: [], majorityBuilds: [], coBuilderCount: 0});

// One pass over every album on the thread, and over each album's contributors: the
// richest thread here is 1,563 albums and 676 co-builders, so anything that re-walks the
// albums per co-builder is a page that never paints.
//
// Shared pieces use the same min() rule computeTopEight does -- the overlap two people
// can claim on one structure is bounded by the smaller of the two contributions, and
// summing would let a 40,000-piece megabuilder swamp everyone who touched one wall.
// Legacy contributors carry `pieces: null`: they still count an album and still draw a
// branch, they just add no pieces, and a span made only of those is drawn dashed.
function buildKinshipTree(thread, {confirmedTags = [], localTags = {}} = {}) {
  if (!thread) return emptyKinshipTree();
  const self = thread.builderKey;
  const seenEras = [];
  const branches = new Map();
  const majorityBuilds = [];

  for (const block of thread.eras || []) {
    const era = block.era;
    if (Number.isFinite(era)) seenEras.push(era);
    for (const album of block.albums || []) {
      const contributors = album.contributors || [];
      const mine = contributors.find((c) => c && c.builderKey === self);
      const myPieces = mine?.pieces ?? 0;
      const ownership = majorityOwner(album, self);
      if (ownership) {
        majorityBuilds.push({
          buildKey: album.buildKey,
          era: album.era ?? era,
          label: album.label,
          pieces: album.pieces ?? 0,
          ownership,
          worldUrl: album.worldUrl ?? null,
          photos: album.photos || [],
          contributors,
        });
      }
      for (const other of contributors) {
        if (!other || other.builderKey === self) continue;
        let branch = branches.get(other.builderKey);
        if (!branch) {
          branch = {
            builderKey: other.builderKey, firstEra: era, lastEra: era, spans: [],
            totalSharedAlbums: 0, totalSharedPieces: 0, legacyOnly: true,
            tags: {confirmed: [], pending: []},
          };
          branch.byEra = new Map();
          branches.set(other.builderKey, branch);
        }
        let span = branch.byEra.get(era);
        if (!span) {
          span = {era, sharedAlbums: 0, sharedPieces: 0, legacy: true, anchorMajority: false, builds: []};
          branch.byEra.set(era, span);
        }
        const shared = Math.min(myPieces, other.pieces ?? 0);
        span.sharedAlbums += 1;
        span.sharedPieces += shared;
        span.builds.push(album.buildKey);
        if (other.pieces != null) span.legacy = false;
        if (ownership) span.anchorMajority = true;
        branch.totalSharedAlbums += 1;
        branch.totalSharedPieces += shared;
      }
    }
  }

  const eras = [...new Set(seenEras)].sort((a, b) => a - b);
  const confirmedByContributor = indexTagsByContributor(confirmedTags, self);
  const localByContributor = indexTagsByContributor(Object.values(localTags || {}), self);

  const ranked = [...branches.values()].map((branch) => {
    const spans = [...branch.byEra.values()].sort((a, b) => a.era - b.era);
    delete branch.byEra;
    branch.spans = spans;
    branch.firstEra = spans.length ? spans[0].era : null;
    branch.lastEra = spans.length ? spans[spans.length - 1].era : null;
    branch.legacyOnly = spans.length > 0 && spans.every((s) => s.legacy);
    const confirmed = [...(confirmedByContributor.get(branch.builderKey) || [])].sort();
    const known = new Set(confirmed);
    const pending = [...(localByContributor.get(branch.builderKey) || [])]
      .filter((id) => !known.has(id)).sort();
    branch.tags = {confirmed, pending};
    return branch;
  }).sort((a, b) => b.totalSharedPieces - a.totalSharedPieces
    || b.totalSharedAlbums - a.totalSharedAlbums
    || a.builderKey.localeCompare(b.builderKey));

  majorityBuilds.sort((a, b) => (b.pieces || 0) - (a.pieces || 0) || a.buildKey.localeCompare(b.buildKey));

  return {
    anchor: {builderKey: self, displayName: thread.displayName, eras: [...eras]},
    eras,
    branches: ranked,
    majorityBuilds,
    coBuilderCount: ranked.length,
  };
}

// Tag records addressed to one anchor, collapsed to the tag ids each contributor wears.
function indexTagsByContributor(records, anchorKey) {
  const index = new Map();
  for (const record of records || []) {
    if (!record || record.builderKey !== anchorKey) continue;
    let bucket = index.get(record.contributorKey);
    if (!bucket) {
      bucket = new Set();
      index.set(record.contributorKey, bucket);
    }
    for (const id of record.tags || []) bucket.add(id);
  }
  return index;
}

// What one co-builder wears on one build: confirmed by a coordinator, or still sitting
// in this browser waiting to be sent. A pending id that has already been confirmed is
// not pending any more -- it is the same tag, arrived.
function mergeKinshipTags(confirmedTags, localTags, buildKey, contributorKey) {
  const matches = (record) => record && record.buildKey === buildKey && record.contributorKey === contributorKey;
  const confirmed = new Set();
  for (const record of confirmedTags || []) {
    if (!matches(record)) continue;
    for (const id of record.tags || []) confirmed.add(id);
  }
  const pending = new Set();
  for (const record of Object.values(localTags || {})) {
    if (!matches(record)) continue;
    for (const id of record.tags || []) if (!confirmed.has(id)) pending.add(id);
  }
  return {confirmed: [...confirmed].sort(), pending: [...pending].sort()};
}

// A tag as it is written down. Unknown ids are dropped rather than rejected: the modal
// is a closed vocabulary, so an unknown id is a stale page or a hand-edited ledger, and
// neither is worth losing the rest of the tag over. An empty tag list is different --
// there is nothing to record -- and that throws.
function kinshipTagRecord({buildKey, era, builderKey, contributorKey, tags, note, participant, claimId}, {id, now} = {}) {
  const known = [...new Set((tags || []).filter((tag) => KINSHIP_TAG_IDS.has(tag)))].sort();
  if (!known.length) throw new Error('kinship tag needs at least one tag');
  return {
    tagId: id ?? randomId('kintag'),
    buildKey,
    era,
    builderKey,
    contributorKey,
    tags: known,
    note: String(note || '').trim().slice(0, 200),
    participant: normalizeHandle(participant),
    claimId: claimId ?? null,
    createdAt: now ?? nowISOString(),
    deliveryStatus: 'queued',
  };
}

const PARTICIPATION_STORAGE_KEY = 'creators-participation-v1';
const PARTICIPATION_SCHEMA = 'steward-creator-participation-local/v1';

// The whole participation ledger, as a store rather than a closure: same schema string,
// same shape, plus `kinshipTags`. Storage is a parameter so Node can pass a plain object
// and the browser can pass nothing and get `localStorage`. Every entry point tolerates a
// storage that throws -- a private window with site data blocked, or a full quota --
// because persistence here is a convenience and the copied payload is the real handoff.
const StewardParticipation = {
  STORAGE_KEY: PARTICIPATION_STORAGE_KEY,
  SCHEMA: PARTICIPATION_SCHEMA,

  defaultState(now) {
    const stamp = now ?? nowISOString();
    return {
      schema: PARTICIPATION_SCHEMA,
      createdAt: stamp,
      updatedAt: stamp,
      participant: '',
      claims: {},       // buildKey -> claim
      requests: {},     // requestId -> request
      kinshipTags: {},  // `${buildKey}:${contributorKey}` -> tag record
      priorities: {},   // buildKey -> photo priority (first | next | skip)
      portraits: {},    // builderKey -> the portrait chosen for that profile on this device
    };
  },

  load(storage = globalThis.localStorage) {
    const next = StewardParticipation.defaultState();
    try {
      const raw = storage?.getItem(PARTICIPATION_STORAGE_KEY);
      if (!raw) return next;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.schema !== PARTICIPATION_SCHEMA) return StewardParticipation.defaultState();
      next.participant = String(parsed.participant || '').trim();
      next.claims = parsed.claims && typeof parsed.claims === 'object' ? parsed.claims : {};
      // A ledger written before "Not my build" existed is a ledger of built claims, not a
      // broken one -- the same courtesy kinshipTags gets below.
      for (const claim of Object.values(next.claims)) {
        if (claim && typeof claim === 'object' && claim.kind !== 'disavow') claim.kind = 'built';
      }
      next.requests = parsed.requests && typeof parsed.requests === 'object' ? parsed.requests : {};
      // A ledger written before kinship existed is not a broken ledger.
      next.kinshipTags = parsed.kinshipTags && typeof parsed.kinshipTags === 'object' ? parsed.kinshipTags : {};
      // A ledger written before the feedback column existed is not a broken ledger either.
      next.priorities = parsed.priorities && typeof parsed.priorities === 'object' ? parsed.priorities : {};
      next.portraits = parsed.portraits && typeof parsed.portraits === 'object' ? parsed.portraits : {};
      next.createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : next.createdAt;
      next.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowISOString();
      return next;
    } catch {
      return StewardParticipation.defaultState();
    }
  },

  save(state, storage = globalThis.localStorage) {
    state.updatedAt = nowISOString();
    state.participant = normalizeHandle(state.participant);
    try {
      storage.setItem(PARTICIPATION_STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  },

  forget(storage = globalThis.localStorage) {
    try {
      storage.removeItem(PARTICIPATION_STORAGE_KEY);
    } catch {
      // Nothing was persisted in the first place; clearing memory is enough.
    }
    return StewardParticipation.defaultState();
  },

  // Either kind: this is what the card reads to say "Claimed by" or "Disavowed by".
  claimForBuild(state, buildKey) {
    return state.claims?.[buildKey] || null;
  },

  // What a *built* claim confers, and a disavowal does not. Saying "this isn't mine" is
  // still participation and still a record -- it is a useful correction to publish a count
  // of -- but it cannot be the thing that unlocks requesting photographs of that build or
  // tagging the people who built it beside you. Every standing gate reads this, never
  // claimForBuild, because the two answers differ exactly where it matters.
  standingForBuild(state, buildKey) {
    const claim = StewardParticipation.claimForBuild(state, buildKey);
    return claim && claim.kind === 'built' ? claim : null;
  },

  requestsForBuild(state, buildKey) {
    return Object.values(state.requests || {}).filter((r) => r.buildKey === buildKey);
  },

  tagsForBuild(state, buildKey) {
    return Object.values(state.kinshipTags || {}).filter((t) => t.buildKey === buildKey);
  },

  tagFor(state, buildKey, contributorKey) {
    return state.kinshipTags?.[`${buildKey}:${contributorKey}`] || null;
  },

  // A re-claim must not discard the record that an earlier one was delivered. One record
  // per build whichever way it points: a disavowal replaces a claim and a claim replaces a
  // disavowal, because both are the same person saying the same kind of thing about the
  // same build, and two stores would let one browser hold both at once.
  putClaim(state, claim) {
    if (!state.claims) state.claims = {};
    if (claim.kind !== 'disavow') claim.kind = 'built';
    const prior = state.claims[claim.buildKey];
    if (prior && prior.deliveryStatus === 'submitted' && claim.deliveryStatus !== 'submitted') {
      claim.deliveryStatus = 'submitted';
      claim.resubmittedFrom = prior.claimId;
    }
    state.claims[claim.buildKey] = claim;
    return claim;
  },

  // One tag per (build, co-builder): re-tagging replaces, and the same rule as a re-claim
  // keeps a delivered tag delivered.
  putKinshipTag(state, record) {
    if (!state.kinshipTags) state.kinshipTags = {};
    const key = `${record.buildKey}:${record.contributorKey}`;
    const prior = state.kinshipTags[key];
    if (prior && prior.deliveryStatus === 'submitted' && record.deliveryStatus !== 'submitted') {
      record.deliveryStatus = 'submitted';
      record.resubmittedFrom = prior.tagId;
    }
    state.kinshipTags[key] = record;
    return record;
  },

  // The feedback column on the un-photographed builds: one of three marks per build,
  // or none. It is a self-reported preference about the NEXT capture campaign, recorded
  // on this device and carried in the copied payload exactly as a claim is -- never a
  // vote the archive tallies on its own. A repeat of the same mark clears it.
  PRIORITIES: ['first', 'next', 'skip'],

  priorityForBuild(state, buildKey) {
    return state.priorities?.[buildKey] || null;
  },

  setPriority(state, {buildKey, builderKey, buildLabel, value, participant}) {
    if (!state.priorities) state.priorities = {};
    const prior = state.priorities[buildKey];
    if (!value || (prior && prior.value === value)) {
      delete state.priorities[buildKey];
      return null;
    }
    if (!StewardParticipation.PRIORITIES.includes(value)) return prior || null;
    const record = {
      priorityId: prior?.priorityId || randomId('priority'),
      buildKey,
      builderKey,
      buildLabel,
      value,
      participant: normalizeHandle(participant || ''),
      createdAt: prior?.createdAt || nowISOString(),
      updatedAt: nowISOString(),
      deliveryStatus: 'local',
    };
    state.priorities[buildKey] = record;
    return record;
  },

  // Standing on a PROFILE rather than a build: a built claim on any of this builder's
  // builds. It is what lets a visitor choose the portrait the profile wears -- the same
  // bar as requesting photographs of a build, applied to the person the page is about.
  standingForBuilder(state, thread) {
    if (!thread || !thread.builderKey) return null;
    const keys = new Set();
    for (const era of thread.eras || []) for (const album of era.albums || []) keys.add(album.buildKey);
    for (const claim of Object.values(state.claims || {})) {
      if (claim.kind === 'built' && (claim.builderKey === thread.builderKey || keys.has(claim.buildKey))) return claim;
    }
    return null;
  },

  portraitForBuilder(state, builderKey) {
    return state.portraits?.[builderKey] || null;
  },

  // The portrait a builder chose for their profile, recorded on this device. A revert
  // (`tile: null`, "use the archive's pick") is written as a record too, never a deletion:
  // the coordinator has to be able to see that a choice was withdrawn, not merely find it
  // missing. Same record id across changes, so the ledger stays one line per profile.
  setPortrait(state, {builderKey, tile, take, sha, participant}) {
    if (!/^[a-f0-9]{32}$/.test(String(builderKey || ''))) return null;
    if (!state.portraits) state.portraits = {};
    const prior = state.portraits[builderKey];
    const record = {
      portraitId: prior?.portraitId || randomId('portrait'),
      builderKey,
      tile: tile ? String(tile) : null,
      take: tile && take ? String(take) : null,
      sha: tile && sha ? String(sha) : null,
      participant: normalizeHandle(participant || ''),
      createdAt: prior?.createdAt || nowISOString(),
      chosenAt: nowISOString(),
      deliveryStatus: 'local',
    };
    state.portraits[builderKey] = record;
    return record;
  },

  exportPayload(state, {kindFilter, buildKey} = {}) {
    const payload = {
      schema: 'steward-creator-participation-export/v1',
      createdAt: nowISOString(),
      participant: state.participant,
      claims: Object.values(state.claims || {}),
      requests: Object.values(state.requests || {}),
      kinshipTags: Object.values(state.kinshipTags || {}),
      priorities: Object.values(state.priorities || {}),
    };
    if (kindFilter === 'claim') payload.claims = payload.claims.filter((c) => c.buildKey === buildKey);
    if (kindFilter === 'request' && buildKey) payload.requests = payload.requests.filter((r) => r.buildKey === buildKey);
    if (kindFilter === 'kinship') {
      payload.kinshipTags = payload.kinshipTags.filter((t) => t.buildKey === buildKey);
      // The claim is what gives the tagger standing on this build, so it rides along --
      // and only a built claim is standing. A disavowal riding out with somebody else's
      // kinship tags would be a payload that argues with itself.
      const standing = StewardParticipation.standingForBuild(state, buildKey);
      payload.claims = standing ? [standing] : [];
    }
    return payload;
  },

  buildPayload(state, {builderKey, buildKey, buildLabel}) {
    return {
      schema: 'steward-creator-build-participation/v1',
      exportAt: nowISOString(),
      builderKey,
      buildKey,
      buildLabel,
      claim: StewardParticipation.claimForBuild(state, buildKey),
      requests: StewardParticipation.requestsForBuild(state, buildKey),
      kinshipTags: StewardParticipation.tagsForBuild(state, buildKey),
      priority: StewardParticipation.priorityForBuild(state, buildKey),
    };
  },
};

if (typeof module !== 'undefined') {
  module.exports = {
    PLACEHOLDER_NAME, AUTO_ALBUM_LABEL, searchTerms, matchScore, compareBuilders,
    SORT_MODES, filterBuilders, computeHeroStats, pickSignatureAlbums, computeTopEight,
    portraitIndex, eraBounds, heroAliases, pickMosaicAlbums, distinctAttributions,
    nowISOString, randomId, normalizeHandle, submitPayload,
    KINSHIP_TAGS, KINSHIP_TAG_IDS, majorityOwner, buildKinshipTree, mergeKinshipTags,
    kinshipTagRecord, StewardParticipation,
  };
}

const initCreatorsPage = async () => {
  const PAGE_SIZE_DIRECTORY = 80;
  const PAGE_SIZE_ALBUMS = 40;
  const SUGGESTION_LIMIT = 8;
  const FILTER_DEBOUNCE_MS = 140;
  // Long enough that a typed name lands as one access-log line rather than eight.
  const BEACON_DEBOUNCE_MS = 900;

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
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many || one + 's'}`;

  const segments = location.pathname.split('/').filter(Boolean);
  const builderKey = segments.find((s) => /^[a-f0-9]{32}$/.test(s));
  const isThread = Boolean(builderKey);
  const base = new URL(isThread ? '../' : './', location.href);

  // A shared pair link: ?kin=<co-builder>&build=<one of the builds they share>
  // Validated here, once, against the same hex shapes the rest of the page uses, so a
  // hand-edited or truncated key never reaches a selector or a fetch. Anything that does
  // not match is dropped rather than corrected -- a half-read link should open the plain
  // profile, not somebody else's pairing. pair.js owns the URL from mount onwards.
  const pairQuery = new URLSearchParams(location.search);
  const hexParam = (name, pattern) => {
    const value = String(pairQuery.get(name) || '');
    return pattern.test(value) ? value : null;
  };
  const initialPair = {
    kin: hexParam('kin', /^[a-f0-9]{32}$/),
    build: hexParam('build', /^[a-f0-9]{64}$/),
  };
  const endpoint = document.querySelector('meta[name="creator-participation-endpoint"]')?.content?.trim() || '';
  const state = StewardParticipation.load();
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
  const threadCache = new Map();

  const claimModal = $('claim-modal');
  const requestModal = $('request-modal');
  const activityModal = $('activity-modal');
  const photoViewerModal = $('photo-viewer-modal');
  let selectedAlbum = null;
  let lastFocusedBeforeViewer = null;

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

  // Set once the pair view has actually been mounted. A thread whose every album is solo
  // renders no ribbon and no host, and an arrival (names, tags, portraits) must not be
  // announced to a view that was never put on the page.
  let pairMounted = false;

  // The portrait manifest is wanted in three places on a thread page -- the hero avatar,
  // every Top 8 chip, and the pair view -- and it is one small optional file. One promise,
  // read once and shared, instead of ten fetches racing each other on a phone. The
  // resolved manifest is kept so a caller that arrives after the read (the pair context)
  // can have it synchronously.
  let portraitManifest = null;
  let portraitsPromise = null;
  function readPortraits() {
    if (!portraitsPromise) {
      portraitsPromise = readOptional('/chronicles/portraits.json').then((manifest) => {
        portraitManifest = manifest || null;
        // The choices recorded on this device reach the resolver before the first face is
        // painted, so a chosen portrait never flashes the slot tile first.
        if (typeof StewardPortraits === 'object') StewardPortraits.setChoices(state.portraits || {});
        return portraitManifest;
      });
    }
    return portraitsPromise;
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

  // setItem throws in a private window with site data blocked, and on quota exhaustion.
  // StewardParticipation.save() reports that as `false` rather than letting the throw
  // escape the click handler, which used to leave the modal open and the claim lost with
  // no explanation. Persistence is a convenience -- the payload is the real handoff.
  function saveState() {
    if (!StewardParticipation.save(state)) {
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
      const record = byBuilder.get(key) || {claims: 0, disavowals: 0, requests: 0, handles: new Set()};
      // "N claimed builds" must not quietly include the ones this browser said were not
      // its own; those are counted, and shown, as what they are.
      if (item.claimId && item.kind === 'disavow') record.disavowals += 1;
      else if (item.claimId) record.claims += 1;
      if (item.requestId) record.requests += 1;
      if (item.participant) record.handles.add(item.participant);
      byBuilder.set(key, record);
    }
    return byBuilder;
  }

  function countByBuilder(builderKeyValue) {
    const aggregate = toPartsByBuilder();
    return aggregate.get(builderKeyValue) || {claims: 0, disavowals: 0, requests: 0, handles: new Set()};
  }

  function claimForBuild(buildKey) {
    return StewardParticipation.claimForBuild(state, buildKey);
  }

  function standingForBuild(buildKey) {
    return StewardParticipation.standingForBuild(state, buildKey);
  }

  function requestsForBuild(buildKey) {
    return StewardParticipation.requestsForBuild(state, buildKey);
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
    if (photoViewerModal && photoViewerModal.classList.contains('open')) closePhotoViewer();
  }

  function exportPayload(kindFilter) {
    return StewardParticipation.exportPayload(state, {kindFilter, buildKey: selectedAlbum?.buildKey});
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
    const claimValues = Object.values(state.claims);
    const counts = {
      claims: claimValues.filter((c) => c.kind !== 'disavow').length,
      disavowals: claimValues.filter((c) => c.kind === 'disavow').length,
      requests: Object.keys(state.requests).length,
      submitted: [...claimValues, ...Object.values(state.requests)]
        .filter((x) => x.deliveryStatus === 'submitted').length,
    };
    const participants = new Set();
    for (const c of Object.values(state.claims)) participants.add(c.participant);
    for (const r of Object.values(state.requests)) participants.add(r.participant);

    const parts = [`${counts.claims} claimed builds`];
    // Only when there are some: a standing "0 disavowed" reads as an accusation waiting
    // for a name, and the first-time visitor has enough zeroes to look at already.
    if (counts.disavowals) parts.push(`${counts.disavowals} disavowed`);
    const prioritised = Object.keys(state.priorities || {}).length;
    if (prioritised) parts.push(`${prioritised} builds marked for photography`);
    const portraits = Object.values(state.portraits || {}).filter((p) => p.tile).length;
    if (portraits) parts.push(`${portraits} portrait${portraits === 1 ? '' : 's'} chosen`);
    parts.push(
      `${counts.requests} photo requests`,
      `${counts.submitted} already sent`,
      `${participants.size} local participants`,
    );
    $('participation-summary').textContent = parts.join(' · ');

    // The panel is a fold on the landing page -- nobody arriving for the first time
    // needs four zeroes above the search box. Open it once there is something in it.
    const details = $('participation-details');
    if (details && (counts.claims || counts.disavowals || counts.requests || state.participant || isThread)) details.open = true;

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
    if (agg.disavowals) chips.push(`${agg.disavowals} disavowed`);
    if (agg.requests) chips.push(`${agg.requests} request${agg.requests === 1 ? '' : 's'}`);
    return chips;
  }

  // Fetching every builder's thread just to render the directory would turn an 80-card
  // page into 80 extra requests. Instead each card's Signature Creations section is
  // populated lazily, only once the card actually scrolls near the viewport, and only
  // from that one builder's own thread file.
  const signatureObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          signatureObserver.unobserve(entry.target);
          hydrateSignatureCreations(entry.target);
        }
      }, {rootMargin: '200px'})
    : null;

  function fetchThreadForSignature(builderKeyValue) {
    if (!threadCache.has(builderKeyValue)) {
      threadCache.set(builderKeyValue, readOptional(`threads/${builderKeyValue}.json`));
    }
    return threadCache.get(builderKeyValue);
  }

  function hydrateSignatureCreations(card) {
    const key = card.dataset.builderKey;
    const container = card.querySelector('.signature-creations');
    if (!key || !container) return;
    fetchThreadForSignature(key).then((doc) => {
      const picks = pickSignatureAlbums(doc);
      if (!picks.length) { container.remove(); return; }
      const list = node('ul');
      for (const album of picks) {
        const li = node('li');
        li.append(link(album.label, new URL(`${key}/`, base)));
        list.append(li);
      }
      container.append(list);
      container.hidden = false;
    });
  }

  function appendBuilderCards() {
    const container = $('content');
    for (const b of filteredBuilders.slice(directoryOffset, directoryOffset + PAGE_SIZE_DIRECTORY)) {
      const card = node('article', null, 'builder');
      card.dataset.builderKey = b.builderKey;
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

      card.append(node('p', `Builder ID ${b.builderKey.slice(0, 8)}…`, 'builder-id'));

      const signature = node('div', null, 'signature-creations');
      signature.hidden = true;
      signature.append(node('span', 'Signature creations', 'signature-creations-label'));
      card.append(signature);
      if (signatureObserver) signatureObserver.observe(card);
      else hydrateSignatureCreations(card);

      const actions = node('div', null, 'card-actions');
      actions.append(link('Request photo', new URL(`${b.builderKey}/#request`, base)));
      card.append(actions);

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

  function builderSummary(b) {
    const parts = [plural(b.albums, 'build')];
    if (b.pieces != null) parts.push(`${b.pieces.toLocaleString()} pieces`);
    if (b.tier) parts.push(b.tier);
    parts.push(`${b.photos.toLocaleString()} photos`);
    const range = eraRange(b.eras);
    if (range) parts.push(range);
    return parts.join(' · ');
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

  function syncEraRibbon() {
    const ribbon = $('era-ribbon');
    if (!ribbon) return;
    const current = $('era').value;
    for (const chip of ribbon.children) {
      const active = chip.dataset.era === current;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', String(active));
    }
  }

  function buildEraRibbon(erasDescending) {
    const ribbon = $('era-ribbon');
    if (!ribbon || ribbon.children.length) return;
    const counts = new Map();
    for (const b of directory.builders) for (const e of b.eras) counts.set(e, (counts.get(e) || 0) + 1);
    const makeChip = (value, label, count) => {
      const chip = node('button', null, 'era-chip');
      chip.type = 'button';
      chip.dataset.era = value;
      chip.setAttribute('aria-pressed', 'false');
      chip.append(node('span', label));
      if (count != null) chip.append(document.createTextNode(' '), node('span', `(${count.toLocaleString()})`, 'era-chip-count'));
      chip.onclick = () => {
        $('era').value = value;
        applyFilter();
        syncEraRibbon();
      };
      return chip;
    };
    ribbon.append(makeChip('', 'All eras', directory.builders.length));
    for (const era of erasDescending) ribbon.append(makeChip(String(era), `Era ${era}`, counts.get(era) || 0));
    syncEraRibbon();
  }

  function applyFilter({suggest = true} = {}) {
    const typed = $('search').value.trim();
    const q = typed.toLocaleLowerCase();
    const era = $('era').value;
    const withAlbums = $('with-albums')?.checked || false;
    const sortMode = SORT_MODES[$('sort')?.value] || SORT_MODES.default;
    filteredBuilders = filterBuilders(directory.builders, {era, query: typed, withAlbums});
    filteredBuilders.sort((a, b) => sortMode.compare(a, b, q));

    directoryOffset = 0;
    $('content').replaceChildren();
    $('status').textContent = `${filteredBuilders.length.toLocaleString()} of ${directory.builders.length.toLocaleString()} builders · ${directory.unattributedAlbums.toLocaleString()} additional albums have no saved creator`;

    const empty = $('empty-state');
    if (!filteredBuilders.length) {
      empty.hidden = false;
      empty.textContent = q
        ? `No builder matches “${typed}”. Names come from the creator recorded on each saved construction piece, so anyone who never placed a piece in these worlds has no thread. Try a shorter fragment, or a name you built under earlier.`
        : (withAlbums ? 'No builder with albums is recorded for this era yet.' : 'No builder is recorded for this era yet.');
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

  function renderHeroStats() {
    const hero = computeHeroStats(directory);
    if ($('stat-builders')) $('stat-builders').textContent = hero.builders.toLocaleString();
    if ($('stat-captures')) $('stat-captures').textContent = hero.captures.toLocaleString();
    if ($('stat-captures-note')) {
      $('stat-captures-note').textContent = hero.captures
        ? `Across ${plural(hero.buildersWithPhotos, 'builder')}`
        : 'Photography has not started yet';
    }
    if ($('stat-eras')) $('stat-eras').textContent = hero.populatedEras.toLocaleString();
    if ($('stat-eras-note')) $('stat-eras-note').textContent = 'Chip ribbon below shows which';
  }

  function setSearchHotkeyLabel() {
    const hint = $('search-hotkey');
    if (!hint) return;
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    hint.textContent = /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘K' : 'Ctrl K';
  }

  function wireGlobalHotkey() {
    addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() !== 'k' || (!event.ctrlKey && !event.metaKey) || event.shiftKey || event.altKey) return;
      const search = $('search');
      const hero = $('search-hero');
      if (!search || !hero || hero.hidden) return;
      if ([claimModal, requestModal, activityModal, photoViewerModal].some((m) => m?.classList.contains('open'))) return;
      event.preventDefault();
      search.focus();
      search.select();
    });
  }

  function renderDirectory() {
    const buildersByEra = [...new Set(directory.builders.flatMap((b) => b.eras))]
      .sort((a, b) => b - a);
    // Pre-existing bug fixed here: the static markup already ships one <option> ("Every
    // era"), so the old `!$('era').children.length` guard was always false and this loop
    // never ran -- the native era select has never actually offered a specific era. Guard
    // on the option count instead, so this still only populates once.
    if ($('era').options.length <= 1) {
      for (const era of buildersByEra) $('era').add(new Option(`Era ${era}`, era));
    }
    buildEraRibbon(buildersByEra);
    renderHeroStats();

    const unresolved = directory.legacyImports.reduce((n, e) => n + e.unresolvedImages, 0);
    const unresolvedNote = $('footer-unresolved-note');
    if (unresolved > 0 && unresolvedNote) {
      unresolvedNote.textContent = `${unresolved.toLocaleString()} historical photographs remain in their original galleries while creator attribution is unresolved.`;
      unresolvedNote.hidden = false;
    }

    $('capture-note').textContent = captureNoteForDirectory();
    $('content').className = 'directory';

    $('search').oninput = () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => applyFilter(), FILTER_DEBOUNCE_MS);
    };
    $('era').onchange = () => { applyFilter(); syncEraRibbon(); };
    if ($('sort')) $('sort').onchange = () => applyFilter();
    if ($('with-albums')) $('with-albums').onchange = () => applyFilter();
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
      // Legacy contributors carry no `share` (evidence: legacy-leading-contributor) --
      // showing a percentage there would imply a precision the historical import never had.
      if (c.share != null) credits.append(` (${(100 * c.share).toFixed(1)}%)`);
    });
    // Bed residency, after the contributors and visibly not one of them. Evidence that
    // somebody slept here, which is not a claim on a single piece of the roof over them --
    // the archive derives no credit from a nearby structure and this line must not read as
    // though it did.
    //
    // class `resident`, deliberately NOT `credit`: renderConfirmedTagChips() selects
    // `.credits a.credit[data-builder-key]` and would otherwise park a kinship chip -- a
    // tag one builder wrote about another's work on this build -- beside a name that is
    // here only because of a bed.
    if (Array.isArray(album.residents) && album.residents.length) {
      credits.append(' · slept here: ');
      album.residents.forEach((r, i) => {
        if (i) credits.append(' · ');
        // Often "Recorded builder" and staying that way: a sleeper with no saved pieces has
        // no thread and no directory record, so there is no public name to fill in. Showing
        // one the archive has never published would be a worse answer than none.
        const anchor = link(buildersByKey.get(r.builderKey)?.displayName || 'Recorded builder',
          new URL(`${r.builderKey}/`, base));
        anchor.className = 'resident';
        anchor.dataset.builderKey = r.builderKey;
        credits.append(anchor);
        if (r.beds > 1) credits.append(` (${r.beds} beds)`);
      });
    }
    return credits;
  }

  // Coordinator-confirmed kinship tags ride in the public participation.json and are
  // read-only here. The chips go NEXT to the credit anchor rather than inside it:
  // hydrateCredits() rewrites that anchor's textContent when directory.json lands, and
  // anything parked inside would be wiped by a race nobody would ever reproduce.
  // Keys are checked against their own hex shape before they reach a selector.
  //
  // Called from both ends of a race -- participation.json and the thread itself land in
  // whichever order the network hands them over, and whichever arrives second is the one
  // that can actually draw. Clearing first makes the second call a redraw, not a
  // duplicate, and makes a re-rendered thread (forget-participation) safe too.
  //
  // The sweep is scoped to the album cards this function actually draws into. It used to
  // clear every `.kin-chip` on the page, which was harmless while the album cards were
  // the only thing wearing one -- and destructive the moment the pair view started
  // drawing laurel chips of its own, because participation.json lands after the mount.
  function renderConfirmedTagChips(doc) {
    for (const stale of document.querySelectorAll('article.album .kin-chip')) stale.remove();
    const tags = doc?.confirmedTags;
    if (!Array.isArray(tags) || !tags.length) return;
    const labels = new Map([...KINSHIP_TAGS.relationship, ...KINSHIP_TAGS.role]);
    for (const tag of tags) {
      if (!tag || !/^[0-9a-f]{64}$/.test(String(tag.buildKey))) continue;
      if (!/^[0-9a-f]{32}$/.test(String(tag.contributorKey))) continue;
      const album = document.querySelector(`article.album[data-build-key="${tag.buildKey}"]`);
      if (!album) continue;
      const credit = album.querySelector(`.credits a.credit[data-builder-key="${tag.contributorKey}"]`);
      if (!credit) continue;
      const chips = [];
      for (const id of tag.tags || []) {
        if (!labels.has(id)) continue;
        chips.push(node('span', labels.get(id), 'chip kin-chip confirmed'));
      }
      if (chips.length) credit.after(...chips);
    }
  }

  // Every hook is `[data-builder-key]` and every one holds a name: the album credit anchors,
  // the resident anchors ("slept here"), and the Top 8 chips' name spans (a chip is a
  // <button>, so its name cannot be an <a>). Residents ride the same hook for the same
  // reason -- the thread paints before 818 KB of directory.json lands -- even though most of
  // them never find a name: a sleeper with no saved pieces has no directory record.
  function hydrateCredits() {
    for (const anchor of document.querySelectorAll('a.credit[data-builder-key], a.resident[data-builder-key], .top8-chip .top8-name[data-builder-key], .kin-tree .kin-node-name[data-builder-key]')) {
      const name = buildersByKey.get(anchor.dataset.builderKey)?.displayName;
      if (name) anchor.textContent = name;
    }
  }

  // Same shape community.py gives a builder with no single recorded name, so the
  // placeholder a Top 8 card shows before directory.json lands is the same string
  // hydrateCredits() will settle on for an unnamed co-builder.
  function placeholderName(key) {
    return `Builder ${key.slice(0, 8)}`;
  }

  // Tier I is the shield-wall pair either side of you, Tier II the rest of the front rank,
  // Tier III the ones behind it. Three bands rather than eight ranks because "rank 6" and
  // "rank 7" is a distinction nobody reads; the exact rank stays in the tier's title.
  function tierFor(rank) {
    if (rank <= 2) return 'Tier I';
    if (rank <= 5) return 'Tier II';
    return 'Tier III';
  }

  // One tile in the ribbon. It starts on the archive's own emblem and swaps to this
  // builder's face if the portrait manifest names one -- the same rule, and the same
  // slot, the hero avatar uses.
  function ribbonPortrait(key) {
    const holder = node('span', null, 'top8-portrait');
    holder.dataset.pairPortraitKey = key;
    holder.setAttribute('aria-hidden', 'true');
    holder.append(emblemSpan());
    readPortraits().then((manifest) => paintPortrait(holder, key, manifest, {
      sizes: '64px',
      fallback: emblemSpan,
    }));
    return holder;
  }

  // A ribbon entry is a button, not a link: clicking it opens the pair view in place
  // rather than navigating away, so the name inside is a <span> (an <a> inside a
  // <button> is not a thing) carrying the same data-builder-key hydrateCredits() reads.
  // `rank` is null for the ninth chip a deep link can add, which has no rank to state.
  function top8Chip(entry, rank) {
    const chip = node('button', null, rank == null ? 'top8-chip is-extra' : 'top8-chip');
    chip.type = 'button';
    chip.dataset.builderKey = entry.builderKey;
    if (rank != null) chip.dataset.rank = String(rank);
    chip.setAttribute('aria-pressed', 'false');
    chip.title = `${entry.sharedAlbums.toLocaleString()} shared albums · ${entry.sharedPieces.toLocaleString()} shared pieces`;
    chip.append(ribbonPortrait(entry.builderKey));
    const name = node('span',
      buildersByKey.get(entry.builderKey)?.displayName || placeholderName(entry.builderKey),
      'top8-name');
    name.dataset.builderKey = entry.builderKey;
    chip.append(name);
    if (rank != null) {
      const tier = node('span', tierFor(rank), 'top8-tier');
      tier.title = `Rank ${rank} of this builder's Top 8`;
      chip.append(tier);
    }
    chip.onclick = () => {
      if (typeof StewardPair === 'undefined') return;
      const active = StewardPair.select(entry.builderKey);
      // The pressed state is never set here: it is drawn from the `pair:change` the view
      // announces, so a select that lands somewhere else cannot leave the ribbon lying.
      // The panel sits below the ribbon and is off-screen on a phone, so bring it up.
      if (active && $('pair-view')) $('pair-view').scrollIntoView({block: 'nearest'});
    };
    return chip;
  }

  // The panel every profile page has had since 2005, now the caption under the tree and
  // the selector for the pair view below it. Names ride the same `data-builder-key` hook
  // the album credit lines use, so hydrateCredits() fills them in when directory.json
  // arrives -- no second fetch for this. `coBuilders` is the count the tree knows, so the
  // note can say "Top 8 of 34"; `drawn` is how many branches the tree could fit.
  function renderTopEight({coBuilders = 0, drawn = 0} = {}) {
    const ranked = computeTopEight(thread);
    if (!ranked.length) return null;
    const panel = node('div', null, 'top8');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Top 8 co-builders');
    const grid = node('div', null, 'top8-grid');
    ranked.forEach((entry, index) => grid.append(top8Chip(entry, index + 1)));
    // A shared link can name a co-builder who is real but outside the first eight -- the
    // kinship ledger lists every one of them. Rather than open on a selection the ribbon
    // cannot show, that builder gets a ninth chip of their own, ranked nowhere.
    if (initialPair.kin && !ranked.some((entry) => entry.builderKey === initialPair.kin)) {
      const extra = computeTopEight(thread, Infinity).find((entry) => entry.builderKey === initialPair.kin);
      if (extra) grid.append(top8Chip(extra, null));
    }
    panel.append(grid);
    // Top 8 is the first eight names; the kinship page is all of them, with the ledger
    // and the tagging.
    const note = node('p', null, 'top8-note muted');
    const total = Math.max(coBuilders, ranked.length);
    note.append(`Top ${Math.min(8, ranked.length)} of ${plural(total, 'co-builder')}`);
    if (drawn && total > drawn) note.append(` · the tree draws the ${drawn} closest`);
    note.append(' · ');
    const kinshipLink = link('Open the kinship tree', new URL(`kinship/?builder=${thread.builderKey}`, base));
    kinshipLink.id = 'top8-kinship-link';
    kinshipLink.className = 'kin-open';
    note.append(kinshipLink, ' for the ledger and tagging');
    panel.append(note);
    return panel;
  }

  // Who they built beside: the kinship tree, drawn on the page, with the Top 8 as its
  // caption. The tree is the same one the kinship page draws (kin-tree.js) over the
  // same model (buildKinshipTree); a click on a branch selects that pairing exactly as a
  // chip does, and the `pair:change` the view announces sets both. Without kin-tree.js
  // the section degrades to the ribbon alone -- the same posture the pair view takes.
  let kinHandle = null;
  let kinTree = null;
  let kinTarget = null;
  let kinCap = 0;
  let kinResizeTimer = 0;

  function drawKinshipEmbed() {
    if (!kinTree || !kinTarget) return null;
    kinCap = kinBranchCap();
    // Long threads get shorter bands so seven eras still fit in one screen.
    // padBottom leaves room under the oldest band for the labels that hang off its nodes
    // (an alternate-row label reaches 90px below the portrait); the scroller clips.
    const options = {maxBranches: kinCap, padBottom: 104};
    if (kinTree.eras.length > 6) options.bandHeight = 52;
    const layout = layoutKinshipTree(kinTree, options);
    kinHandle = drawKinshipTree(kinTarget, layout, kinTree, {
      anchorKey: thread.builderKey,
      nameFor: (key) => buildersByKey.get(key)?.displayName || placeholderName(key),
      isUnnamedKey: (key) => isUnnamed(buildersByKey.get(key) || null, PLACEHOLDER_NAME),
      portraits: portraitManifest,
      hrefFor: () => null,
      onPick: (key) => {
        if (typeof StewardPair === 'undefined') return;
        const active = StewardPair.select(key);
        if (active && $('pair-view')) $('pair-view').scrollIntoView({block: 'nearest'});
      },
      anchorMeta: plural(kinTree.coBuilderCount || 0, 'co-builder'),
      branchMeta: (branch) => `${(branch?.totalSharedPieces || 0).toLocaleString()} shared pieces`,
    });
    const pressed = document.querySelector('.top8-chip[aria-pressed="true"]');
    kinHandle.setActive(pressed ? pressed.dataset.builderKey : null);
    if (!portraitManifest) readPortraits().then((manifest) => { if (manifest && kinHandle) kinHandle.redrawPortraits(manifest); });
    return layout;
  }

  function renderKinshipEmbed() {
    kinHandle = null;
    kinTree = null;
    kinTarget = null;
    const canDraw = typeof drawKinshipTree === 'function' && typeof layoutKinshipTree === 'function';
    const tree = canDraw
      ? buildKinshipTree(thread, {confirmedTags: externalParticipation?.confirmedTags || [], localTags: state.kinshipTags})
      : null;
    const section = node('section', null, 'kin-beside');
    section.id = 'kin-beside';
    section.setAttribute('aria-labelledby', 'kin-beside-h2');
    const heading = node('h2', 'Who they built beside');
    heading.id = 'kin-beside-h2';
    section.append(heading);
    let drawn = 0;
    if (tree && tree.branches.length) {
      kinTree = tree;
      section.append(node('p',
        `${plural(tree.coBuilderCount || tree.branches.length, 'builder')} placed pieces on the same builds, across ${plural(tree.eras.length, 'era')}. Pick one to see the pair.`,
        'kin-beside-sub muted'));
      const scroll = node('div', null, 'kin-scroll kin-tree');
      const canvas = node('div', null, 'kin-canvas');
      canvas.id = 'kin-embed';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'kin-tree-svg');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'Kinship tree');
      const nodes = node('div', null, 'kin-nodes');
      const tip = node('div', null, 'kin-tip');
      tip.setAttribute('role', 'tooltip');
      tip.hidden = true;
      canvas.append(svg, nodes, tip);
      scroll.append(canvas);
      section.append(scroll);
      kinTarget = {svg, nodes, tip, canvas};
      const layout = drawKinshipEmbed();
      drawn = layout ? layout.branches.length : 0;
      // The trunk is the middle of a 960-unit drawing; on a phone the scroller shows
      // about two thirds of it, and it should open on the anchor, not on the left edge.
      requestAnimationFrame(() => { scroll.scrollLeft = Math.max(0, (canvas.scrollWidth - scroll.clientWidth) / 2); });
    }
    const ribbon = renderTopEight({coBuilders: tree ? tree.coBuilderCount : 0, drawn});
    if (!ribbon) return null;
    section.append(ribbon);
    return section;
  }

  function redrawKinshipEmbedIfNeeded() {
    if (!thread || !kinTree || kinBranchCap() === kinCap) return;
    drawKinshipEmbed();
  }

  // The three lines that used to sit under the hero as orphans, and the manifest link,
  // together at the foot of the page. #status and #thread-actions are MOVED, not copied:
  // their ids, role and rendered strings travel with them.
  function renderThreadNotes() {
    const notes = $('thread-notes');
    if (!notes) return;
    let line = $('thread-participation-line');
    if (!line) {
      line = node('p', null, 'muted');
      line.id = 'thread-participation-line';
    }
    let capture = $('thread-capture-note');
    if (!capture) {
      capture = node('p', null, 'muted');
      capture.id = 'thread-capture-note';
    }
    const note = captureNoteForThread();
    capture.textContent = note;
    capture.hidden = !note;
    notes.replaceChildren(...[$('status'), line, capture, $('thread-actions')].filter(Boolean));
    notes.hidden = false;
    refreshThreadParticipationLine();
  }

  // The thread's headline figures get the same recessed hit-counter cell the directory's
  // stat tiles wear. Split on the leading number only, and keep the rendered text
  // byte-identical to the single string this line used to set.
  function threadIntroLine(parts) {
    const fragment = document.createDocumentFragment();
    parts.forEach((part, index) => {
      if (index) fragment.append(' · ');
      const match = /^([\d,.]+)(.*)$/.exec(part);
      if (!match) { fragment.append(part); return; }
      fragment.append(node('span', match[1], 'counter'));
      if (match[2]) fragment.append(match[2]);
    });
    return fragment;
  }

  function closePhotoViewer() {
    closeModal(photoViewerModal);
    const img = $('photo-viewer-image');
    if (img) {
      // Clear the handler before the src, otherwise clearing the src can itself fire a
      // spurious error event that the still-attached handler reacts to after the viewer
      // is already closed.
      img.onerror = null;
      img.src = '';
    }
    if (lastFocusedBeforeViewer && document.contains(lastFocusedBeforeViewer)) lastFocusedBeforeViewer.focus();
    lastFocusedBeforeViewer = null;
  }

  // Basic in-page viewer over the existing thumb/large URLs -- not a masterpiece viewer,
  // just a bigger look with no navigation away from the thread. Falls back from `large`
  // to `thumb` on a load failure, and to a plain message if both fail.
  function openPhotoViewer(photo) {
    if (!photoViewerModal) return;
    lastFocusedBeforeViewer = document.activeElement;
    const img = $('photo-viewer-image');
    const err = $('photo-viewer-error');
    const candidates = [photo.large, photo.thumb].filter(Boolean);
    let attempt = 0;
    err.hidden = true;
    img.alt = photo.label || 'Photograph';
    img.onerror = () => {
      attempt += 1;
      if (attempt < candidates.length) { img.src = candidates[attempt]; return; }
      img.hidden = true;
      err.hidden = false;
    };
    if (candidates.length) {
      img.hidden = false;
      img.src = candidates[0];
    } else {
      img.hidden = true;
      err.hidden = false;
    }
    $('photo-viewer-title').textContent = photo.label || 'Photograph';
    const originalLink = $('photo-viewer-original');
    if (photo.href) { originalLink.href = photo.href; originalLink.hidden = false; }
    else { originalLink.hidden = true; }
    openModal(photoViewerModal);
    $('photo-viewer-close').focus();
  }

  // A build that WAS photographed and had every frame withheld is a different fact from
  // "not shot yet", and only that album can state it; it does so inside its row.
  const WITHHELD_NOTE = 'Photographed, but none of the frames were worth showing — fog, a blocked camera, or a near-identical shot of a neighbouring build. This one is queued for another attempt.';

  function photoThumb(p, cls = 'photo-thumb') {
    const btn = node('button', null, cls);
    btn.type = 'button';
    const img = document.createElement('img');
    img.src = p.thumb;
    img.alt = p.label + (p.shot ? ` (${p.shot})` : '');
    img.loading = 'lazy';
    img.decoding = 'async';
    btn.append(img);
    btn.setAttribute('aria-label', `View image: ${p.label}`);
    btn.onclick = () => openPhotoViewer(p);
    return btn;
  }

  // A slice of an album's photographs as thumbnails, or null when the slice is empty. The
  // row shows the first four; the rest wait in the expanded body.
  function renderAlbumPhotos(album, {from = 0, limit = Infinity, cls = 'photos'} = {}) {
    const slice = (album.photos || []).slice(from, from + limit);
    if (!slice.length) return null;
    const photos = node('div', null, cls);
    for (const p of slice) photos.append(photoThumb(p));
    return photos;
  }

  // The work: one carousel of the photographed builds. A big viewport with a thick
  // banner across its top (the era and the basic facts), the build's details laid out
  // plainly underneath -- credits, links, the claim controls -- and a rail of every
  // photographed build beneath as the selector. Nothing here folds. Until pass 3 the
  // photographs were the fourth thing inside each album card, a screen and a half down.
  let workAlbums = [];
  let workIndex = 0;
  let workPhoto = 0;

  function workShareText(album) {
    const share = shareFor(album, thread.builderKey);
    if (share == null) return null;
    const pct = 100 * share;
    return `${pct > 0 && pct < 1 ? pct.toFixed(1) : Math.round(pct)} % yours`;
  }

  function workStepBuild(delta) {
    if (!workAlbums.length) return;
    workIndex = (workIndex + delta + workAlbums.length) % workAlbums.length;
    workPhoto = 0;
    paintWorkStage();
  }

  function workStepPhoto(delta) {
    const album = workAlbums[workIndex];
    if (!album) return;
    workPhoto = (workPhoto + delta + album.photos.length) % album.photos.length;
    paintWorkStage();
  }

  function arrowButton(cls, label, glyph, onClick) {
    const button = node('button', glyph, cls);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.onclick = onClick;
    return button;
  }

  // Paint the stage for the current build and photograph. Re-run on every step and on
  // every claim (refreshAlbumCard routes here): the details article is a real
  // `article.album[data-build-key]`, so the confirmed-tag sweep and the claim refresh
  // find it the same way they find a row.
  function paintWorkStage() {
    const stage = $('work-stage');
    if (!stage || !workAlbums.length) return;
    const album = workAlbums[workIndex];
    const photo = album.photos[workPhoto] || album.photos[0];

    const viewport = node('div', null, 'work-viewport');
    const picture = photoThumb(photo, 'photo-thumb work-photo');
    const img = picture.querySelector('img');
    img.loading = 'eager';
    img.src = photo.large || photo.thumb;
    img.onerror = () => { if (img.src !== photo.thumb) img.src = photo.thumb; };
    viewport.append(picture);

    const banner = node('div', null, 'work-banner');
    const facts = node('div', null, 'work-facts');
    facts.append(node('span', `Era ${album.era}`, 'work-era'));
    facts.append(node('b', album.label, 'work-name'));
    facts.append(node('span', `${album.pieces.toLocaleString()} pieces`));
    const share = workShareText(album);
    if (share) facts.append(node('span', share));
    facts.append(node('span', plural(album.photos.length, 'photograph')));
    banner.append(facts);
    if (album.photos.length > 1) {
      const stepper = node('div', null, 'work-photo-step');
      stepper.append(
        arrowButton('work-step', 'Previous photograph', '‹', () => workStepPhoto(-1)),
        node('span', `${workPhoto + 1} / ${album.photos.length}`, 'work-step-count'),
        arrowButton('work-step', 'Next photograph', '›', () => workStepPhoto(1)),
      );
      banner.append(stepper);
    }
    viewport.append(banner);
    if (workAlbums.length > 1) {
      viewport.append(
        arrowButton('work-arrow work-arrow-prev', 'Previous build', '‹', () => workStepBuild(-1)),
        arrowButton('work-arrow work-arrow-next', 'Next build', '›', () => workStepBuild(1)),
      );
    }

    const details = node('article', null, 'album work-details');
    details.dataset.buildKey = album.buildKey;
    const text = node('div', null, 'work-text');
    text.append(buildCreditLine(album));
    const links = node('div', null, 'links');
    if (album.galleryUrl) links.append(link('Open original gallery', album.galleryUrl));
    if (album.worldUrl) links.append(link('Open in world viewer', album.worldUrl));
    if (links.childElementCount) text.append(links);
    const requestHistory = requestsForBuild(album.buildKey);
    if (requestHistory.length) {
      const sent = requestHistory.filter((r) => r.deliveryStatus === 'submitted').length;
      text.append(node('p', `${plural(requestHistory.length, 'request')} for this build ( ${sent} sent )`, 'muted'));
    }
    details.append(text, renderAlbumActions(album, thread.builderKey));

    stage.replaceChildren(viewport, details);
    for (const tile of document.querySelectorAll('#work .work-tile')) {
      tile.setAttribute('aria-pressed', String(tile.dataset.buildKey === album.buildKey));
    }
    renderConfirmedTagChips(externalParticipation);
  }

  function renderWorkCarousel() {
    workAlbums = pickMosaicAlbums(thread, Infinity);
    if (!workAlbums.length) return null;
    workIndex = Math.min(workIndex, workAlbums.length - 1);
    workPhoto = 0;
    const section = node('section', null, 'work');
    section.id = 'work';
    section.setAttribute('aria-labelledby', 'work-h2');
    const heading = node('h2', 'The work');
    heading.id = 'work-h2';
    section.append(heading);
    // The attribution sentence, once for the page: every credit line below reads under it.
    const attributions = distinctAttributions(thread);
    if (attributions.length) section.append(node('p', attributions.join(' '), 'albums-note muted'));
    const stage = node('div', null, 'work-stage');
    stage.id = 'work-stage';
    section.append(stage);
    const rail = node('div', null, 'photos work-rail');
    rail.setAttribute('role', 'group');
    rail.setAttribute('aria-label', 'Photographed builds');
    workAlbums.forEach((album, index) => {
      const tile = photoThumb(album.photos[0], 'photo-thumb work-tile');
      tile.dataset.buildKey = album.buildKey;
      tile.setAttribute('aria-pressed', 'false');
      tile.setAttribute('aria-label', `${album.label} · era ${album.era}`);
      tile.append(node('span', `Era ${album.era}`, 'mosaic-era'));
      tile.onclick = () => { workIndex = index; workPhoto = 0; paintWorkStage(); };
      rail.append(tile);
    });
    section.append(rail);
    const shot = workAlbums.length;
    section.append(node('p', `${plural(thread.photos || 0, 'photograph')} across ${plural(shot, 'build')}`, 'mosaic-foot muted'));
    return section;
  }

  // This builder's share of an album's pieces, or null where the import never recorded
  // one (legacy albums carry no shares at all).
  function shareFor(album, targetBuilderKey) {
    const mine = (album.contributors || []).find((c) => c && c.builderKey === targetBuilderKey);
    return mine && mine.share != null ? mine.share : null;
  }

  function setAlbumExpanded(card, on) {
    card.dataset.expanded = on ? 'true' : 'false';
    const toggle = card.querySelector('.album-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(on));
    const more = card.querySelector('.album-more');
    if (more) more.hidden = !on;
  }

  // The freeform overview a row's Details drops down: the pieces per builder against the
  // total, the ones nobody is recorded on, and who slept here. Names are credit links so
  // the confirmed-tag sweep and the directory's late names find them as they do elsewhere.
  function restOverview(album) {
    const p = node('p', null, 'credits rest-text');
    const total = album.pieces || 0;
    p.append(`${total.toLocaleString()} construction pieces. `);
    const contributors = (album.contributors || []).slice().sort((a, b) => (b.pieces ?? 0) - (a.pieces ?? 0));
    const known = contributors.filter((c) => c.pieces != null);
    if (!known.length) {
      p.append('Historical import: shares were never recorded. Leading contributor ');
      contributors.forEach((c, i) => {
        if (i) p.append(', ');
        const a = link(buildersByKey.get(c.builderKey)?.displayName || 'Recorded builder', new URL(`${c.builderKey}/`, base));
        a.className = 'credit';
        a.dataset.builderKey = c.builderKey;
        p.append(a);
      });
      p.append('.');
    } else {
      let attributed = 0;
      known.forEach((c, i) => {
        if (i) p.append(', ');
        const a = link(buildersByKey.get(c.builderKey)?.displayName || 'Recorded builder', new URL(`${c.builderKey}/`, base));
        a.className = 'credit';
        a.dataset.builderKey = c.builderKey;
        p.append(a);
        p.append(` placed ${c.pieces.toLocaleString()}${c.share != null ? ` (${(100 * c.share).toFixed(1)} %)` : ''}`);
        attributed += c.pieces;
      });
      const rest = Math.max(0, total - attributed);
      if (rest) p.append(`; ${rest.toLocaleString()} (${total ? (100 * rest / total).toFixed(1) : '0.0'} %) carry no saved creator`);
      p.append('.');
    }
    if (Array.isArray(album.residents) && album.residents.length) {
      p.append(' Slept here: ');
      album.residents.forEach((r, i) => {
        if (i) p.append(', ');
        const a = link(buildersByKey.get(r.builderKey)?.displayName || 'Recorded builder', new URL(`${r.builderKey}/`, base));
        a.className = 'resident';
        a.dataset.builderKey = r.builderKey;
        p.append(a);
        if (r.beds > 1) p.append(` (${r.beds} beds)`);
      });
      p.append('.');
    }
    return p;
  }

  // The three marks of the feedback column. Hollow until chosen; the chosen one fills.
  const PRIORITY_MARKS = [
    ['first', 'Photograph this first', 'M8 1.8l1.9 4 4.4.6-3.2 3.1.8 4.4L8 11.8l-3.9 2.1.8-4.4L1.7 6.4l4.4-.6z'],
    ['next', 'Photograph this in the next batch', 'M3 3h10v10H3z'],
    ['skip', 'Not worth a photograph', 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z'],
  ];

  function priorityIcon(value) {
    const mark = PRIORITY_MARKS.find(([v]) => v === value);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'fb-icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('class', 'fill');
    shape.setAttribute('d', mark[2]);
    svg.append(shape);
    if (value === 'skip') {
      const cross = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      cross.setAttribute('class', 'cross');
      cross.setAttribute('d', 'M5.5 5.5l5 5M10.5 5.5l-5 5');
      svg.append(cross);
    }
    return svg;
  }

  function renderPriorityGroup(album, targetBuilderKey) {
    const group = node('div', null, 'rest-feedback');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', `Photograph ${album.label}?`);
    const current = StewardParticipation.priorityForBuild(state, album.buildKey);
    for (const [value, title] of PRIORITY_MARKS) {
      const button = node('button', null, `fb fb-${value}`);
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(current?.value === value));
      button.setAttribute('aria-label', title);
      // A drawn tooltip (data-tip + CSS), not the native title: the native one waits a
      // second, never shows on keyboard focus, and an icon-only control needs its name.
      button.dataset.tip = title;
      button.append(priorityIcon(value));
      button.onclick = () => {
        StewardParticipation.setPriority(state, {
          buildKey: album.buildKey, builderKey: targetBuilderKey, buildLabel: album.label, value, participant: state.participant,
        });
        saveState();
        const chosen = StewardParticipation.priorityForBuild(state, album.buildKey);
        for (const other of group.querySelectorAll('.fb')) {
          other.setAttribute('aria-checked', String(Boolean(chosen) && other.classList.contains(`fb-${chosen.value}`)));
        }
      };
      group.append(button);
    }
    return group;
  }

  function restLedgerHead() {
    const head = node('div', null, 'rest-head');
    head.setAttribute('aria-hidden', 'true');
    head.append(node('span', 'Era'), node('span', 'Build'), node('span', '3D'), node('span', 'Details'), node('span', 'Feedback'));
    return head;
  }

  function renderAlbumActions(album, targetBuilderKey) {
    const row = node('div', null, 'actions-row');
    const current = claimForBuild(album.buildKey);
    const standing = standingForBuild(album.buildKey);
    if (current) {
      // Was a <button> with no handler, which looks pressable and does nothing.
      const verb = current.kind === 'disavow' ? 'Disavowed' : 'Claimed';
      row.append(node('span', `${verb} by ${normalizeHandle(current.participant)}`, 'chip claimed'));
    } else {
      // Two ways to answer "is this yours", because a photographed build with the wrong
      // name on it has no other way to say so: the credits come from the saved pieces and
      // a visitor cannot edit those. Saying "not mine" is the only correction on offer.
      const claim = node('button', 'I built this', 'primary');
      claim.dataset.claimKind = 'built';
      claim.onclick = () => {
        selectedAlbum = album;
        openClaimDialog(album, targetBuilderKey, {kind: 'built'});
      };
      row.append(claim);
      const disavow = node('button', 'Not mine', 'claim-disavow');
      disavow.dataset.claimKind = 'disavow';
      disavow.onclick = () => {
        selectedAlbum = album;
        openClaimDialog(album, targetBuilderKey, {kind: 'disavow'});
      };
      row.append(disavow);
    }

    // A build this browser has just said is not its own offers no photo request. Gating
    // the control would be worse than removing it: an inert button says "you could ask
    // for photographs of this if you claimed it", which is the opposite of the answer
    // just given.
    if (!current || current.kind !== 'disavow') {
      const requests = requestsForBuild(album.buildKey);
      const label = requests.length
        ? `Photo requests (${requests.length})`
        : (album.photos?.length ? 'Request additional photographs' : 'Request photographs');
      const reqBtn = node('button', label);
      if (!standing) {
        // `disabled` swallows the tap, so the explanation lived only in a title tooltip --
        // invisible on a phone, which is where the Discord links land.
        reqBtn.classList.add('inert');
        reqBtn.setAttribute('aria-disabled', 'true');
        reqBtn.title = 'Claim this build before requesting photographs';
      }
      reqBtn.onclick = () => {
        if (!standing) return showToast('Claim this build before requesting photographs.');
        selectedAlbum = album;
        openRequestDialog(album, targetBuilderKey, standing.claimId);
      };
      row.append(reqBtn);
    }

    const exportBtn = node('button', 'Copy this build payload');
    exportBtn.onclick = async () => {
      await copyActivityPayload(StewardParticipation.buildPayload(state, {
        builderKey: targetBuilderKey,
        buildKey: album.buildKey,
        buildLabel: album.label,
      }));
    };
    row.append(exportBtn);
    return row;
  }

  // One row of the rest: the era, the build, the world-viewer link, a Details drop-down
  // of freeform text, and the feedback marks. The article keeps class `album` and its
  // data-build-key: the confirmed-tag sweep, the claim refresh and the release smoke all
  // find it by those. The claim controls live under Details, where the pieces are.
  function buildAlbumCard(album, targetBuilderKey, {expanded = false} = {}) {
    const card = node('article', null, 'album rest-row');
    card.dataset.buildKey = album.buildKey;
    const moreId = `album-more-${album.buildKey.slice(0, 12)}`;

    const line = node('div', null, 'rest-line');
    line.append(node('span', `Era ${album.era}`, 'rest-era'));
    const name = node('h3', album.label, 'rest-name');
    line.append(name);
    const url = album.worldUrl || album.galleryUrl;
    if (url) {
      const open = link('link', url);
      open.className = 'rest-link';
      open.setAttribute('aria-label', `${album.worldUrl ? 'Open' : 'Open the gallery for'} ${album.label}${album.worldUrl ? ' in the world viewer' : ''}`);
      if (album.worldUrl) { open.target = '_blank'; open.rel = 'noopener'; }
      line.append(open);
    } else {
      line.append(node('span', '—', 'rest-link muted'));
    }
    const toggle = node('button', 'Details', 'album-toggle rest-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', moreId);
    toggle.onclick = () => setAlbumExpanded(card, card.dataset.expanded !== 'true');
    line.append(toggle);
    line.append(renderPriorityGroup(album, targetBuilderKey));

    const more = node('div', null, 'album-more rest-more');
    more.id = moreId;
    if (album.photoStatus === 'rejected') more.append(node('p', WITHHELD_NOTE, 'muted'));
    more.append(restOverview(album));
    more.append(renderAlbumActions(album, targetBuilderKey));

    card.append(line, more);
    setAlbumExpanded(card, expanded);
    return card;
  }

  // A claim changes one card. Re-rendering the whole page threw away every "show more"
  // the visitor had clicked and jumped them back to the top of a 340-album thread. The
  // row stays open across the swap: the visitor just pressed a button inside it.
  function refreshAlbumCard(album, targetBuilderKey) {
    const existing = document.querySelector('article.album[data-build-key="' + album.buildKey + '"]');
    if (!existing) return;
    // A photographed build lives on the carousel stage; repaint the stage in place.
    if (existing.classList.contains('work-details')) { paintWorkStage(); return; }
    existing.replaceWith(buildAlbumCard(album, targetBuilderKey, {expanded: existing.dataset.expanded === 'true'}));
  }

  function renderManifestAction() {
    const holder = $('thread-actions');
    if (!holder) return;
    holder.replaceChildren();
    const manifest = link('Download builder manifest (JSON)', new URL(`threads/${thread.builderKey}.json`, base));
    manifest.setAttribute('download', `${thread.builderKey}.json`);
    manifest.id = 'manifest-download';
    holder.append(manifest);
    holder.hidden = false;
  }

  // A card's Request Photo shortcut links here with #request. There is no builder-level
  // request in this data model -- a request is always against one album -- so the
  // shortcut opens the request dialog for the builder's largest album if it is already
  // claimed, and otherwise surfaces the same "claim first" rule a direct click would.
  function openRequestShortcutIfLinked() {
    if (location.hash !== '#request') return;
    const albums = thread.eras.flatMap((e) => e.albums);
    if (!albums.length) return;
    const top = albums.slice().sort((a, b) => (b.pieces || 0) - (a.pieces || 0))[0];
    const standing = standingForBuild(top.buildKey);
    if (standing) openRequestDialog(top, thread.builderKey, standing.claimId);
    else showToast('Claim this build before requesting photographs.');
  }

  // The emblem the header already carries, standing in for a portrait. Used before the
  // manifest answers, when it names no tiles, and when a named tile fails to load -- an
  // empty square and a broken-image glyph are both worse than the archive's own mark.
  function emblemFallback() {
    const holder = node('div', null, 'hero-avatar-fallback');
    const emblem = document.querySelector('.brand-emblem');
    if (emblem) {
      const copy = emblem.cloneNode(true);
      copy.removeAttribute('class');
      copy.removeAttribute('width');
      copy.removeAttribute('height');
      holder.append(copy);
    }
    return holder;
  }

  // The emblem again, as phrasing content. The hero's fallback is a <div>, which cannot
  // be nested inside the Top 8 chip's <span> tile; the drawing is identical.
  function emblemSpan() {
    const holder = node('span', null, 'top8-emblem');
    const emblem = document.querySelector('.brand-emblem');
    if (emblem) {
      const copy = emblem.cloneNode(true);
      copy.removeAttribute('class');
      copy.removeAttribute('width');
      copy.removeAttribute('height');
      holder.append(copy);
    }
    return holder;
  }

  // Which face a builder wears, from the one resolver every surface uses (web/portraits.js):
  // the hero, the ribbon, the tree and the pair card agree by construction, and a portrait
  // chosen on this device shows in all four. A slate tile serves its 512 with the 128 as
  // the small candidate, as it always did; a painted portrait serves its bust cuts -- the
  // avatar is a 160-px square, and a waist-up frame shrunk into it would be all mantle.
  function portraitSources(manifest, key) {
    if (typeof StewardPortraits !== 'object') return null;
    const face = StewardPortraits.portraitFor(key, manifest);
    if (!face) return null;
    const slate = face.library === 'slate48';
    const large = face.url(slate ? 'bust512' : 'bust256');
    const small = face.url('bust128');
    if (!large) return null;
    return {
      src: large,
      srcset: small && small !== large ? `${small} 128w, ${large} ${slate ? 512 : 256}w` : '',
    };
  }

  // Swap on load, not on assignment: a manifest that names a tile this server does not
  // hold would otherwise replace the emblem with a broken-image glyph. `fallback` redraws
  // whatever the holder was showing before the attempt.
  function paintPortrait(holder, key, manifest, {sizes, fallback}) {
    const sources = portraitSources(manifest, key);
    if (!sources) return;
    const img = document.createElement('img');
    img.alt = '';
    img.width = 512;
    img.height = 512;
    img.decoding = 'async';
    if (sizes) img.sizes = sizes;
    if (sources.srcset) img.srcset = sources.srcset;
    img.onload = () => holder.replaceChildren(img);
    img.onerror = () => holder.replaceChildren(fallback());
    img.src = sources.src;
  }

  function renderHeroAvatar() {
    const holder = $('hero-avatar');
    if (!holder) return;
    holder.replaceChildren(emblemFallback());
    // Optional read: the portrait lane deploys separately, and a builder page must open
    // whether or not it has. Same semantics the directory's optional data already uses.
    readPortraits().then((manifest) => paintPortrait(holder, thread.builderKey, manifest, {
      sizes: '(max-width:680px) 96px, 160px',
      fallback: emblemFallback,
    }));
  }

  function renderHeroAliases() {
    const holder = $('hero-aliases');
    if (!holder) return;
    const {shown, more} = heroAliases(thread);
    if (!shown.length) {
      holder.textContent = '';
      holder.hidden = true;
      return;
    }
    const quoted = shown.map((name) => `“${name}”`);
    // The ambiguous-name sentence is #status's job and stays there verbatim; this line
    // only names the other spellings the search box will answer to.
    const tail = more ? `${more} more` : quoted.pop();
    const lead = quoted.join(', ');
    holder.textContent = `also known as ${lead ? `${lead} and ${tail}` : tail}`;
    holder.hidden = false;
  }

  // Moving the existing nodes rather than rebuilding them is the whole trick: #title and
  // #intro keep their ids, their listeners and their rendered strings, and appending the
  // three children in a fixed order makes a second call (forget-participation re-renders
  // the thread) a no-op instead of a duplicated card. The hero is the name and one line:
  // the tier, the eras and the counters read without a label each, the tree that used to
  // be a link here is drawn on the page below, and the manifest link sits in the notes.
  // The picker's entry on the hero card: shown only to a visitor with standing on this
  // profile (a built claim on one of its builds, recorded in this browser) and only when
  // the manifest carries libraries to choose from -- a profile served against the v1
  // manifest shows no control at all. Preview mode: the choice lives on this device.
  let pickerMounted = false;
  function renderPortraitPick() {
    const hero = $('builder-hero');
    const avatar = $('hero-avatar');
    if (!hero || !avatar || !thread) return;
    let actions = $('hero-portrait-actions');
    const standing = StewardParticipation.standingForBuilder(state, thread);
    readPortraits().then((manifest) => {
      const libraries = !!(manifest && manifest.libraries && typeof manifest.libraries === 'object');
      const ready = standing && libraries && typeof StewardPortraitPicker === 'object';
      if (!ready) {
        if (actions) actions.hidden = true;
        return;
      }
      if (!actions) {
        actions = node('div', null, 'hero-portrait-actions');
        actions.id = 'hero-portrait-actions';
        const pick = node('button', 'Choose a portrait', 'kin-open hero-portrait-pick');
        pick.id = 'hero-portrait-pick';
        pick.type = 'button';
        pick.onclick = () => StewardPortraitPicker.open();
        const note = node('p', '', 'muted hero-portrait-note');
        note.id = 'hero-portrait-note';
        actions.append(pick, note);
        avatar.insertAdjacentElement('afterend', actions);
      }
      actions.hidden = false;
      renderPortraitNote();
      if (!pickerMounted) {
        const host = node('div');
        host.id = 'portrait-picker-host';
        document.body.append(host);
        pickerMounted = StewardPortraitPicker.mount(host, {
          manifest,
          builderKey: thread.builderKey,
          choice: StewardParticipation.portraitForBuilder(state, thread.builderKey),
          onChoose: onPortraitChosen,
          returnFocus: () => $('hero-portrait-pick'),
        });
      }
    });
  }

  function renderPortraitNote() {
    const note = $('hero-portrait-note');
    if (!note || !thread) return;
    const choice = StewardParticipation.portraitForBuilder(state, thread.builderKey);
    const chosen = !!(choice && choice.tile);
    note.textContent = chosen ? 'Portrait recorded on this device' : '';
    note.hidden = !chosen;
  }

  function onPortraitChosen(choice) {
    if (!thread) return;
    StewardParticipation.setPortrait(state, {
      builderKey: thread.builderKey,
      tile: choice ? choice.tile : null,
      take: choice ? choice.take : null,
      sha: choice ? choice.sha : null,
      participant: state.participant,
    });
    saveState();
    if (typeof StewardPortraits === 'object') StewardPortraits.setChoices(state.portraits || {});
    if (typeof StewardPortraitPicker === 'object') {
      StewardPortraitPicker.update({choice: StewardParticipation.portraitForBuilder(state, thread.builderKey)});
    }
    repaintPortraits();
    updateParticipantSnapshot();
    showToast(choice ? 'Portrait recorded on this device.' : "Back to the archive's pick.");
  }

  // Every face on the page, through the one resolver, after a choice on this device: the
  // hero, the ribbon chips, the tree nodes and the pair card.
  function repaintPortraits() {
    const manifest = portraitManifest;
    if (!manifest) return;
    renderHeroAvatar();
    renderPortraitNote();
    for (const holder of document.querySelectorAll('.top8-portrait[data-pair-portrait-key]')) {
      paintPortrait(holder, holder.dataset.pairPortraitKey, manifest, {sizes: '64px', fallback: emblemSpan});
    }
    if (kinHandle) kinHandle.redrawPortraits(manifest);
    if (pairMounted) StewardPair.update({portraits: manifest});
  }

  function renderHeroCard() {
    const hero = $('builder-hero');
    const text = hero?.querySelector('.hero-text');
    if (!hero || !text) return;
    renderHeroAliases();
    renderHeroAvatar();
    renderPortraitPick();
    // The brand lockup in the header already says whose community this is.
    const eyebrow = document.querySelector('main .eyebrow');
    if (eyebrow) eyebrow.hidden = true;
    const ordered = [$('title'), $('hero-aliases'), $('intro')].filter(Boolean);
    text.append(...ordered);
    hero.hidden = false;
    if ($('look-out')) $('look-out').hidden = false;
  }

  // Where the pair view sends a visitor who picks one of the builds a pairing shares.
  // The card may be several "Show more albums" pages down inside its era, so open that
  // era and page until it exists. The loop is capped and stops the moment there is no
  // more paging to do: a buildKey that belongs to no album on this thread must not spin.
  // `scroll: false` turns the carousel without moving the visitor -- the pair view uses it
  // when a ledger row is picked, so the photograph is waiting when they scroll back up.
  // A jump to the rest table always scrolls: the row is nowhere the visitor can see.
  function revealAlbum(buildKey, {scroll = true} = {}) {
    if (!/^[a-f0-9]{64}$/.test(String(buildKey || ''))) return null;
    // A photographed build is on the carousel: turn the stage to it.
    const shot = workAlbums.findIndex((a) => a.buildKey === buildKey);
    if (shot >= 0) {
      workIndex = shot;
      workPhoto = 0;
      paintWorkStage();
      const stage = $('work-stage');
      if (stage && scroll) stage.scrollIntoView({block: 'start'});
      return stage ? stage.querySelector('article.album') : null;
    }
    const find = () => document.querySelector(`article.album[data-build-key="${buildKey}"]`);
    let card = find();
    if (!card) {
      const more = $('rest')?.querySelector('button.more-albums');
      // One page per click. The cap is generous enough for the richest thread in the
      // archive (1,563 albums, forty to a page) and finite either way.
      for (let guard = 0; guard < 200 && !find(); guard += 1) {
        if (!more || more.hidden) break;
        more.click();
      }
      card = find();
    }
    if (!card) return null;
    // The row arrives open: the visitor was sent here for its pieces and its buttons.
    setAlbumExpanded(card, true);
    card.scrollIntoView({block: 'start'});
    const toggle = card.querySelector('.album-toggle');
    if (toggle) toggle.focus({preventScroll: true});
    return card;
  }

  // Everything pair.js is allowed to know, and nothing it would have to reach into the
  // page for. `builderFor` is a function rather than the Map itself because buildersByKey
  // is REPLACED when directory.json lands -- a Map captured at mount time would stay
  // empty for the life of the page.
  function pairContext() {
    return {
      thread,
      builderFor: (key) => buildersByKey.get(key) || null,
      participation: state,
      confirmedTags: externalParticipation?.confirmedTags || [],
      portraits: portraitManifest,
      initial: {kin: initialPair.kin, build: initialPair.build},
      revealAlbum,
      base,
      kinshipHref: (key) => new URL(`kinship/?builder=${key}`, base),
    };
  }

  function renderThread() {
    $('filters').hidden = true;
    if ($('search-hero')) $('search-hero').hidden = true;
    if ($('hero-stats')) $('hero-stats').hidden = true;
    const eraCount = thread.eras.reduce((sum, e) => sum + e.albums.length, 0);
    $('title').textContent = thread.displayName;
    // One line, no labels: the tier and the eras first because they are words, then the
    // three figures in their counter cells. It replaces the TIER / FIRST ERA / LATEST ERA
    // row the hero used to carry beneath the name.
    const introParts = [];
    if (thread.tier) introParts.push(thread.tier);
    const bounds = eraBounds(thread);
    if (bounds.first != null) introParts.push(bounds.first === bounds.latest ? `era ${bounds.first}` : `eras ${bounds.first}–${bounds.latest}`);
    introParts.push(plural(eraCount, 'build album'));
    if (thread.pieces != null) introParts.push(`${thread.pieces.toLocaleString()} construction pieces`);
    introParts.push(`${thread.photos.toLocaleString()} photographs`);
    $('intro').replaceChildren(threadIntroLine(introParts));
    $('status').textContent = thread.nameStatus === 'ambiguous'
      ? 'Several recorded names need review. Searchable aliases are retained.'
      : 'No unresolved name conflicts for this builder.';
    renderManifestAction();
    renderHeroCard();

    // A second render (forget-participation redraws the thread) wipes #content, and with
    // it the node the pair view drew into. Say so before the node disappears, rather than
    // leaving a mounted view holding an element that is no longer on the page.
    if (pairMounted) {
      StewardPair.unmount();
      pairMounted = false;
    }
    $('content').className = '';
    $('content').replaceChildren();

    // The order is the story: the work, then who they built beside, then the rest.
    const work = renderWorkCarousel();
    if (work) {
      $('content').append(work);
      paintWorkStage();
    }

    const beside = renderKinshipEmbed();
    if (beside) {
      $('content').append(beside);
      // The pair view's canvas. This page owns where it sits and what context it gets;
      // everything inside it is pair.js's, which is why nothing here ever writes to it.
      // It only exists where the ribbon does -- with no co-builder there is no pair.
      const host = node('section');
      host.id = 'pair-view';
      host.className = 'pair-view';
      host.hidden = true;
      $('content').append(host);
      if (typeof StewardPair !== 'undefined') {
        StewardPair.mount(host, pairContext());
        pairMounted = true;
        // Both optional reads usually land after the thread -- directory.json is 818 KB
        // against a few KB -- but not always, and an arrival that beat the mount would
        // otherwise never be announced at all.
        if (directory) StewardPair.update({names: true});
        if (externalParticipation) StewardPair.update({confirmedTags: externalParticipation.confirmedTags || []});
        // The manifest is an optional file that usually lands after the mount.
        readPortraits().then((manifest) => {
          if (manifest && pairMounted) StewardPair.update({portraits: manifest});
        });
      }
    }

    // The rest: every build not photographed yet, newest era first, largest first --
    // for anyone who wants to dig, and for the feedback that steers the next campaign.
    const rest = thread.eras.flatMap((e) => e.albums).filter((a) => !(a.photos && a.photos.length))
      .sort((a, b) => b.era - a.era || (b.pieces || 0) - (a.pieces || 0) || a.buildKey.localeCompare(b.buildKey));
    if (rest.length) {
      const block = node('section', null, 'rest');
      block.id = 'rest';
      block.setAttribute('aria-labelledby', 'rest-h2');
      const restHeading = node('h2', 'The rest');
      restHeading.id = 'rest-h2';
      block.append(restHeading);
      block.append(node('p',
        `${plural(rest.length, 'build')} not photographed yet. The link opens each one as it stands in the saved world; the marks say what should be shot next.`,
        'rest-sub muted'));
      if (!workAlbums.length) {
        const attributions = distinctAttributions(thread);
        if (attributions.length) block.append(node('p', attributions.join(' '), 'albums-note muted'));
      }
      const table = node('div', null, 'rest-table');
      table.append(restLedgerHead());
      let shown = 0;
      const more = node('button', 'Show more builds', 'more-albums');
      const appendRows = () => {
        for (const album of rest.slice(shown, shown + PAGE_SIZE_ALBUMS)) {
          table.insertBefore(buildAlbumCard(album, thread.builderKey), more);
        }
        shown += PAGE_SIZE_ALBUMS;
        more.hidden = shown >= rest.length;
      };
      table.append(more);
      more.onclick = () => { appendRows(); renderConfirmedTagChips(externalParticipation); };
      appendRows();
      block.append(table);
      $('content').append(block);
    }
    renderThreadNotes();
    // If participation.json already landed there are albums to hang its chips on now.
    renderConfirmedTagChips(externalParticipation);
    openRequestShortcutIfLinked();
    // A shared pair link lands under the work and the tree now; bring the pair up unless
    // a #hash has already claimed the scroll.
    if (initialPair.kin && pairMounted && !location.hash) {
      requestAnimationFrame(() => { if ($('pair-view')) $('pair-view').scrollIntoView({block: 'start'}); });
    }
  }

  function refreshThreadParticipationLine() {
    const line = $('thread-participation-line');
    if (!line || !thread) return;
    const mine = countByBuilder(thread.builderKey);
    line.textContent = `You have ${mine.claims} claimed build${mine.claims === 1 ? '' : 's'} and ${mine.requests} request${mine.requests === 1 ? '' : 's'} on this page.`;
  }

  // One dialog, two kinds. The fields are identical -- a handle, an optional note -- and
  // so is what happens to them, so a second modal would have been a second copy of the
  // clipboard fallback, the handle validation and the delivery wording to keep honest.
  function openClaimDialog(album, targetBuilderKey, {kind = 'built'} = {}) {
    const disavowing = kind === 'disavow';
    selectedAlbum = album;
    // The shell carries both kinds' guidance copy; the mode picks which one is shown.
    claimModal.dataset.claimKind = disavowing ? 'disavow' : 'built';
    for (const block of claimModal.querySelectorAll('[data-claim-kind]')) {
      block.hidden = block.dataset.claimKind !== claimModal.dataset.claimKind;
    }
    $('claim-title').textContent = disavowing ? 'Not my build' : 'Claim build';
    $('claim-confirm').textContent = disavowing ? "This isn't mine" : 'I built this';
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
        kind: disavowing ? 'disavow' : 'built',
        participant,
        buildLabel: album.label,
        era: album.era,
        createdAt: nowISOString(),
        note: $('claim-note').value.trim(),
      };
      let deliveryStatus = 'queued';
      try {
        await submitPayload(endpoint, {
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
      StewardParticipation.putClaim(state, claim);
      saveState();
      closeModal(claimModal);
      // Without an ingestion endpoint a claim reaches nobody on its own, so the claim
      // is not finished until the volunteer sends the payload. Say that, and hand them
      // the payload the same way the photo-request path already does.
      if (deliveryStatus === 'submitted') {
        showToast(disavowing ? 'Disavowal sent.' : 'Build claim sent.');
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
        await submitPayload(endpoint, {
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
    if ($('photo-viewer-close')) $('photo-viewer-close').onclick = closePhotoViewer;
    // The contact field invites a Discord handle or e-mail and persists indefinitely.
    // Offer a way out that does not require clearing site data by hand.
    if ($('forget-participation')) {
      $('forget-participation').onclick = () => {
        if (!confirm('Forget every claim, request, portrait choice and handle stored in this browser?')) return;
        // Retention control: kinship tags name a second person, so they are the first
        // thing this has to clear, not an afterthought bolted on beside the claims.
        const fresh = StewardParticipation.forget();
        state.participant = fresh.participant;
        state.claims = fresh.claims;
        state.requests = fresh.requests;
        state.kinshipTags = fresh.kinshipTags;
        state.priorities = fresh.priorities;
        state.portraits = fresh.portraits;
        if (typeof StewardPortraits === 'object') StewardPortraits.setChoices(state.portraits);
        updateParticipantSnapshot();
        showToast('Local participation cleared.');
        if (isThread && thread) renderThread();
      };
    }
    for (const modal of [claimModal, requestModal, activityModal, photoViewerModal]) {
      modal?.addEventListener('click', (event) => {
        if (event.target !== modal) return;
        if (modal === photoViewerModal) closePhotoViewer();
        else closeModal(modal);
      });
    }
    addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAllModals();
    });
    // The nav link and the footer both point at #participation-details, which is a
    // collapsed <details>: the jump landed on a closed summary and looked broken.
    const openParticipationIfLinked = () => {
      if (location.hash !== '#participation-details') return;
      const block = $('participation-details');
      if (block) block.open = true;
    };
    openParticipationIfLinked();
    addEventListener('hashchange', openParticipationIfLinked);
    // The pair view announces which co-builder it settled on -- from a ribbon click, from
    // its own internal navigation, or from the deep link it resolved at mount. The ribbon
    // reads its pressed state from that announcement and never from the click that caused
    // it, so the two cannot disagree. Delegated on #content, which outlives every render.
    if ($('content')) {
      $('content').addEventListener('pair:change', (event) => {
        const chosen = event.detail?.ally;
        const ally = typeof chosen === 'string' ? chosen : (chosen?.builderKey || null);
        for (const chip of document.querySelectorAll('.top8-chip')) {
          chip.setAttribute('aria-pressed', String(Boolean(ally) && chip.dataset.builderKey === ally));
        }
        if (kinHandle) kinHandle.setActive(ally || null);
      });
    }
    // A rotate fires resize by the dozen; the tree only cares when the branch cap flips.
    if (isThread) {
      addEventListener('resize', () => {
        clearTimeout(kinResizeTimer);
        kinResizeTimer = setTimeout(redrawKinshipEmbedIfNeeded, 150);
      });
    }
    setSearchHotkeyLabel();
    wireGlobalHotkey();
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
        // Same arrival, second surface: the pair view holds names of its own and reads
        // them through ctx.builderFor, which now answers.
        if (pairMounted) StewardPair.update({names: true});
      });
      readOptional('participation.json').then((doc) => {
        externalParticipation = doc;
        updateParticipantSnapshot();
        renderConfirmedTagChips(doc);
        if (pairMounted) StewardPair.update({confirmedTags: doc?.confirmedTags || []});
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
};

// Guarded so `require()`-ing this file for the pure-logic unit tests (creators.logic.test.js)
// doesn't try to run the page bootstrap against Node's missing `document`/`location`.
// The kinship page loads this file for its top-level model and store only -- it has no
// #copy-activity, no #participant-handle and no directory to render, so booting the
// directory/thread page there would throw on the first missing node. kinship.js is the
// page script there, and it runs against the same globals.
if (typeof document !== 'undefined' && document.documentElement.dataset.stewardPage !== 'kinship') initCreatorsPage();
