'use strict';

// Kinship page: the branching tree of who a builder built beside, era by era, and the
// tagging that a build's majority owner may add on top. Pure layout helpers live at top
// level so Node can test them; the page code runs only when a document exists and only
// when a creators.js new enough to carry the participation store has loaded first.

const KIN_LAYOUT = {width: 960, bandHeight: 72, laneGap: 64, maxBranches: 12, padTop: 64, padBottom: 40, padX: 24};

function strokeWidthFor(sharedPieces) {
  return Math.min(8, Math.max(2, 2 * Math.log10((sharedPieces || 0) + 1)));
}

function layoutKinshipTree(tree, options = {}) {
  // Placeholder: Builder A replaces this with the deterministic layout from the plan.
  const o = {...KIN_LAYOUT, ...options};
  return {width: o.width, height: o.padTop + o.padBottom, bands: [], trunk: null, anchorNode: null, branches: [], overflow: 0, tree};
}

if (typeof module !== 'undefined') {
  module.exports = {KIN_LAYOUT, strokeWidthFor, layoutKinshipTree};
}

const initKinshipPage = async () => {
  // Placeholder: Builder A implements the page.
};

if (typeof document !== 'undefined' && document.documentElement.dataset.stewardPage === 'kinship') initKinshipPage();
