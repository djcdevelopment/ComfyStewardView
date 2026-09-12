'use strict';

// The kinship tree: the layout (pure, DOM-free, tested in Node) and the drawing of it,
// shared by the kinship page and the builder profile. Until pass 3 the drawing lived
// inside initKinshipPage as closures over that page's ids; the profile wanted the same
// tree under its hero, so the drawing now takes its targets and its callbacks as
// arguments and neither page owns it. Classic script: every top-level name here is
// global to the page, so kinship.js must not declare them again.

const KIN_LAYOUT = {width: 960, bandHeight: 72, laneGap: 64, maxBranches: 12, padTop: 64, padBottom: 40, padX: 24};

function strokeWidthFor(sharedPieces) {
  return Math.min(8, Math.max(2, 2 * Math.log10((sharedPieces || 0) + 1)));
}

// Two decimals, and back through Number so "480" never renders as "480.00". The layout
// is asserted string-for-string in the node test, so every coordinate that reaches a
// path has to round the same way on every machine rather than trailing float dust.
function kinRound(value) {
  return Math.round(value * 100) / 100;
}

// The tree is drawn oldest-at-the-bottom, the way a tree grows: band 0 is the earliest
// era and sits on the floor, the trunk climbs to the latest era, and each co-builder
// leaves the trunk at the era they first appear beside the anchor. Deterministic and
// DOM-free -- given the same tree it returns the same numbers and the same path strings.
function layoutKinshipTree(tree, options = {}) {
  const o = {...KIN_LAYOUT, ...options};
  const eras = Array.isArray(tree && tree.eras) ? tree.eras : [];
  const allBranches = Array.isArray(tree && tree.branches) ? tree.branches : [];
  if (!eras.length) {
    return {width: o.width, height: o.padTop + o.padBottom, bands: [], trunk: null, anchorNode: null, branches: [], overflow: allBranches.length};
  }

  // Half a band of headroom above the newest era so the anchor portrait has somewhere to
  // sit, and the same half band below the oldest so a branch curve has room to leave.
  const height = o.padTop + (eras.length - 1) * o.bandHeight + o.bandHeight / 2 + o.padBottom;
  const y = (index) => kinRound(height - o.padBottom - index * o.bandHeight);
  const bands = eras.map((era, index) => ({era, y: y(index), label: `Era ${era}`}));
  const trunkX = kinRound(o.width / 2);
  const lastIndex = eras.length - 1;
  const trunk = {x: trunkX, y0: y(0), y1: y(lastIndex)};
  const anchorNode = {x: trunkX, y: kinRound(y(lastIndex) - 30)};
  const indexOfEra = new Map(eras.map((era, index) => [era, index]));

  const branches = allBranches.slice(0, o.maxBranches).map((branch, rank) => {
    const side = rank % 2 ? 'left' : 'right';
    const lane = Math.floor(rank / 2);
    // padX is a guard rail, not a layout term: at the default twelve lanes nothing comes
    // near it, but a caller that widens laneGap or maxBranches would otherwise push
    // portraits off the canvas where they cannot be clicked at all.
    const rawLaneX = trunkX + (side === 'left' ? -1 : 1) * o.laneGap * (lane + 1);
    const laneX = kinRound(Math.min(o.width - o.padX, Math.max(o.padX, rawLaneX)));

    const spans = Array.isArray(branch.spans) ? branch.spans : [];
    const spanByEra = new Map(spans.map((span) => [span.era, span]));
    const firstIndex = indexOfEra.has(branch.firstEra) ? indexOfEra.get(branch.firstEra) : 0;
    const branchLast = indexOfEra.has(branch.lastEra) ? indexOfEra.get(branch.lastEra) : firstIndex;
    const yFirst = y(firstIndex);
    const foot = kinRound(yFirst + o.bandHeight / 2);
    const firstSpan = spanByEra.get(eras[firstIndex]);

    const curve = {
      d: `M ${trunkX},${foot} C ${trunkX},${yFirst} ${laneX},${foot} ${laneX},${yFirst}`,
      width: strokeWidthFor(firstSpan ? firstSpan.sharedPieces : 0),
      kind: firstSpan && firstSpan.legacy ? 'legacy' : 'shared',
    };

    const segments = [];
    for (let index = firstIndex + 1; index <= branchLast; index += 1) {
      const era = eras[index];
      const span = spanByEra.get(era);
      segments.push({
        era,
        y0: y(index - 1),
        y1: y(index),
        // An era with no span is not the end of the branch: the hairline carries it
        // across so a builder who returns two eras later rejoins the same lane instead
        // of appearing as a second, unrelated branch.
        kind: span ? (span.legacy ? 'legacy' : 'shared') : 'memory',
        width: span ? strokeWidthFor(span.sharedPieces) : 1,
      });
    }

    return {
      builderKey: branch.builderKey,
      rank,
      side,
      laneX,
      curve,
      segments,
      node: {x: laneX, y: kinRound(y(branchLast) - 22)},
      spans,
    };
  });

  return {
    width: o.width,
    height: kinRound(height),
    bands,
    trunk,
    anchorNode,
    branches,
    overflow: Math.max(0, allBranches.length - o.maxBranches),
  };
}

// Twelve lanes need about 720px of canvas before neighbouring portraits start printing
// over each other's labels. A phone shows roughly half that through the scroller, so a
// narrow viewport draws the eight closest branches instead and the page says in words
// how many were left out. matchMedia is a parameter so the choice can be tested without
// a browser; Window operations survive being called unbound, so the default is safe to
// invoke as-is.
function kinBranchCap(mm = globalThis.matchMedia) {
  return mm && mm('(max-width: 720px)').matches ? 8 : 12;
}

// "unresolved" and "ambiguous" are what community.py records when no single recorded name
// won; "Builder 8014fa60" is the stand-in it then publishes as the display name.
const KIN_UNNAMED_STATUSES = new Set(['unresolved', 'ambiguous']);

// Deliberately false for a missing record: before directory.json lands, every builder on
// the page is nameless in exactly the same way, and marking them all "unnamed" for that
// half-second would be the page reporting its own load state as a fact about a person.
function isUnnamed(record, placeholder) {
  if (!record) return false;
  if (KIN_UNNAMED_STATUSES.has(record.nameStatus)) return true;
  return Boolean(placeholder && placeholder.test(String(record.displayName || '')));
}

/* ---- drawing (browser only from here down) ---- */

const KIN_SVG_NS = 'http://www.w3.org/2000/svg';

function kinSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(KIN_SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

function kinTextEl(tag, text, cls) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

// The brand emblem in the page header doubles as the portrait fallback, so a page that
// draws a tree has to carry that SVG -- both shells do.
function kinEmblemEl(key, cls) {
  const holder = kinTextEl('span', null, cls);
  holder.dataset.portraitKey = key;
  holder.setAttribute('aria-hidden', 'true');
  const emblem = document.querySelector('.brand-emblem');
  if (emblem) {
    const clone = emblem.cloneNode(true);
    clone.removeAttribute('class');
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    holder.append(clone);
  }
  return holder;
}

// One resolver for every face on the archive (web/portraits.js). The guard is for a page
// served with a stale or missing portraits.js -- and for the Node test, which requires
// this file bare: the emblem is the answer there, never a throw.
function kinPortraitSrc(key, manifest) {
  if (typeof StewardPortraits !== 'object' || !manifest) return null;
  const face = StewardPortraits.portraitFor(key, manifest);
  return face ? face.url('bust128') : null;
}

function kinPortraitEl(key, manifest, cls = 'kin-portrait') {
  const src = kinPortraitSrc(key, manifest);
  if (!src) return kinEmblemEl(key, cls);
  const img = document.createElement('img');
  img.className = cls;
  img.alt = '';
  img.width = 32;
  img.height = 32;
  img.decoding = 'async';
  img.loading = 'lazy';
  img.dataset.portraitKey = key;
  // Swap to the emblem on error rather than leaving a broken-image glyph: the portrait
  // lane deploys separately and may be a manifest ahead of the files on this server.
  img.onerror = () => img.replaceWith(kinEmblemEl(key, cls));
  img.src = src;
  return img;
}

// Every placeholder under `root` becomes a portrait once the manifest has landed. The
// placeholders keep their class and id, so a styled slot stays styled.
function repaintKinPortraits(root, manifest) {
  if (!root || !manifest) return;
  for (const el of [...root.querySelectorAll('[data-portrait-key]')]) {
    const next = kinPortraitEl(el.dataset.portraitKey, manifest, el.getAttribute('class') || 'kin-portrait');
    if (el.id) next.id = el.id;
    el.replaceWith(next);
  }
}

// Names arrive with directory.json, usually after the first draw. Every name span carries
// the key it stands for, so a later pass can fill it in without redrawing anything.
function hydrateKinNames(root, nameFor, isUnnamedKey) {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-kin-name-key]')) {
    const key = el.dataset.kinNameKey;
    el.textContent = nameFor(key);
    if (isUnnamedKey && isUnnamedKey(key)) el.dataset.kinUnnamed = '1';
    else delete el.dataset.kinUnnamed;
  }
  for (const chip of root.querySelectorAll('[data-kin-unnamed-for]')) {
    chip.hidden = !(isUnnamedKey && isUnnamedKey(chip.dataset.kinUnnamedFor));
  }
}

function kinCountText(n) {
  return Number(n || 0).toLocaleString();
}

// The tooltip a page gets when it does not build its own: the name, the total, and one
// line per era. The kinship page replaces it with a richer one that resolves builds.
function kinDefaultTip(key, branch, ctx) {
  const frag = document.createDocumentFragment();
  const heading = kinTextEl('p', ctx.nameFor(key), 'kin-tip-name');
  heading.dataset.kinNameKey = key;
  frag.append(heading);
  if (!branch) {
    frag.append(kinTextEl('p', ctx.anchorMeta || '', 'muted'));
    return frag;
  }
  const list = kinTextEl('ul', null, 'kin-tip-eras');
  for (const span of branch.spans || []) {
    const builds = (span.builds || []).length;
    const pieces = span.legacy ? 'shares unknown' : `${kinCountText(span.sharedPieces)} shared pieces`;
    list.append(kinTextEl('li', `Era ${span.era} · ${builds} ${builds === 1 ? 'build' : 'builds'} · ${pieces}`));
  }
  frag.append(list);
  return frag;
}

// Draw `layout` (from layoutKinshipTree) into target.svg and the HTML overlay target.nodes.
//   target: {svg, nodes, tip, canvas}   -- the <svg>, the node overlay, the tooltip, the
//           positioned box that contains all three (tooltip coordinates are relative to it)
//   ctx:    anchorKey, nameFor(key), isUnnamedKey(key), portraits (manifest or null),
//           hrefFor(key, isAnchor) -> url or null, onPick(key, event), tipFor(key, branch|null),
//           anchorMeta (text under the anchor), branchMeta(branch) -> text under a node
// A node is a link when hrefFor gives it somewhere to go, a button when onPick wants the
// click, and plain text otherwise -- the anchor on its own profile is the third case.
// Returns {hideTip, setActive(key), redrawPortraits(manifest), nodeFor(key)}.
function drawKinshipTree(target, layout, tree, ctx) {
  const svg = target.svg;
  const holder = target.nodes;
  const tip = target.tip;
  const canvas = target.canvas || holder.parentElement;
  const gradientId = ctx.gradientId || 'kin-ember';
  let portraits = ctx.portraits || null;

  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);

  const defs = kinSvgEl('defs');
  // userSpaceOnUse, not the objectBoundingBox default: a vertical stroke has zero
  // bounding-box width, and an objectBoundingBox gradient over it renders nothing at
  // all -- the branches simply disappear.
  const gradient = kinSvgEl('linearGradient', {id: gradientId, gradientUnits: 'userSpaceOnUse', x1: 0, y1: layout.height, x2: 0, y2: 0});
  gradient.append(
    kinSvgEl('stop', {offset: '0', 'stop-color': '#f59e0b'}),
    kinSvgEl('stop', {offset: '1', 'stop-color': '#d97707'}),
  );
  defs.append(gradient);
  svg.append(defs);

  for (const band of layout.bands) {
    svg.append(kinSvgEl('line', {class: 'kin-band-line', x1: KIN_LAYOUT.padX, y1: band.y, x2: layout.width - KIN_LAYOUT.padX, y2: band.y}));
    const label = kinSvgEl('text', {class: 'kin-band-label', x: KIN_LAYOUT.padX, y: band.y - 7});
    label.textContent = band.label;
    svg.append(label);
  }

  if (layout.trunk) {
    svg.append(kinSvgEl('line', {class: 'kin-trunk', x1: layout.trunk.x, y1: layout.trunk.y0, x2: layout.trunk.x, y2: layout.trunk.y1}));
  }

  const groups = new Map();
  for (const branch of layout.branches) {
    const group = kinSvgEl('g', {class: 'kin-branch'});
    group.dataset.builderKey = branch.builderKey;
    group.append(kinSvgEl('path', {class: `kin-seg kin-seg-${branch.curve.kind}`, d: branch.curve.d, 'stroke-width': branch.curve.width}));
    for (const segment of branch.segments) {
      group.append(kinSvgEl('path', {
        class: `kin-seg kin-seg-${segment.kind}`,
        d: `M ${branch.laneX},${segment.y0} L ${branch.laneX},${segment.y1}`,
        'stroke-width': segment.width,
      }));
    }
    svg.append(group);
    groups.set(branch.builderKey, group);
  }

  /* nodes */

  function hideTip() {
    if (!tip) return;
    tip.hidden = true;
    tip.replaceChildren();
  }

  function showTip(el, key, branch) {
    if (!tip) return;
    const build = ctx.tipFor || ((k, b) => kinDefaultTip(k, b, ctx));
    tip.replaceChildren(build(key, branch));
    hydrateKinNames(tip, ctx.nameFor, ctx.isUnnamedKey);
    tip.hidden = false;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const left = Math.min(Math.max(8, el.offsetLeft + 26), Math.max(8, width - tip.offsetWidth - 8));
    const top = Math.min(Math.max(8, el.offsetTop - tip.offsetHeight - 8), Math.max(8, height - tip.offsetHeight - 8));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function wireTip(el, key, branch) {
    // Focus as well as hover: a keyboard reader tabs through the nodes and would
    // otherwise get a portrait and a name with none of the era detail.
    el.addEventListener('mouseenter', () => showTip(el, key, branch));
    el.addEventListener('focus', () => showTip(el, key, branch));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('blur', hideTip);
  }

  function nodeElement(key, {isAnchor = false, meta = '', rank = 0} = {}) {
    const href = ctx.hrefFor ? ctx.hrefFor(key, isAnchor) : null;
    let el;
    if (href) {
      el = document.createElement('a');
      el.href = href;
    } else if (!isAnchor && ctx.onPick) {
      el = document.createElement('button');
      el.type = 'button';
      el.setAttribute('aria-pressed', 'false');
      el.addEventListener('click', (event) => ctx.onPick(key, event));
    } else {
      el = document.createElement('span');
    }
    // Every second lane on a side carries its label a row lower: at twelve lanes the
    // neighbours are close enough that two labels at the same height overprint.
    const alt = !isAnchor && Math.floor(rank / 2) % 2 === 1;
    el.className = `kin-node${isAnchor ? ' kin-anchor-node' : ''}${alt ? ' kin-node-alt' : ''}`;
    el.dataset.builderKey = key;
    const name = kinTextEl('span', ctx.nameFor(key), 'kin-node-name');
    name.dataset.kinNameKey = key;
    name.dataset.builderKey = key;
    if (ctx.isUnnamedKey && ctx.isUnnamedKey(key)) name.dataset.kinUnnamed = '1';
    el.append(kinPortraitEl(key, portraits), name, kinTextEl('span', meta, 'kin-node-meta'));
    return el;
  }

  const nodes = new Map();
  holder.replaceChildren();
  if (layout.anchorNode) {
    const place = (el, point) => {
      // Percentages, not pixels: the SVG is width:100% inside a scroller, so it renders
      // at whatever the column is wide and the nodes have to track that scaling.
      el.style.left = `${(point.x / layout.width) * 100}%`;
      el.style.top = `${(point.y / layout.height) * 100}%`;
    };
    const anchorEl = nodeElement(ctx.anchorKey, {isAnchor: true, meta: ctx.anchorMeta || ''});
    place(anchorEl, layout.anchorNode);
    wireTip(anchorEl, ctx.anchorKey, null);
    holder.append(anchorEl);

    const branchByKey = new Map((tree.branches || []).map((b) => [b.builderKey, b]));
    for (const laid of layout.branches) {
      const branch = branchByKey.get(laid.builderKey);
      const meta = ctx.branchMeta ? ctx.branchMeta(branch) : `${kinCountText(branch?.totalSharedPieces)} shared pieces`;
      const el = nodeElement(laid.builderKey, {meta, rank: laid.rank});
      place(el, laid.node);
      wireTip(el, laid.builderKey, branch);
      holder.append(el);
      nodes.set(laid.builderKey, el);
    }
  }

  function setActive(key) {
    for (const [k, el] of nodes) {
      const on = k === key;
      if (el.tagName === 'BUTTON') el.setAttribute('aria-pressed', String(on));
      el.classList.toggle('is-active', on);
      const group = groups.get(k);
      if (group) group.classList.toggle('is-active', on);
    }
  }

  function redrawPortraits(manifest) {
    if (!manifest) return;
    portraits = manifest;
    repaintKinPortraits(holder, manifest);
  }

  return {hideTip, setActive, redrawPortraits, nodeFor: (key) => nodes.get(key) || null};
}

if (typeof module !== 'undefined') {
  module.exports = {KIN_LAYOUT, strokeWidthFor, kinRound, layoutKinshipTree, kinBranchCap, KIN_UNNAMED_STATUSES, isUnnamed};
}
