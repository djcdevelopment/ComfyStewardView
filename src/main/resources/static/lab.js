(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const APP_BASE = new URL('.', location.href);
  const API = new URL('api', APP_BASE).pathname.replace(/\/$/, '');
  const REQUESTED_LAB_MODE = new URLSearchParams(location.search).get('lab') === '1';
  let PUBLIC_MODE = true;
  document.body.classList.toggle('public-experience', PUBLIC_MODE);
  document.body.classList.toggle('lab-experience', !PUBLIC_MODE);
  document.title = PUBLIC_MODE ? 'Steward — World View' : 'Steward Spatial Lab';
  const ANALYSIS_TONE_EXPONENT = 1.18;
  const ANALYSIS_OVERVIEW_TONE_EXPONENT = 1.75;
  const ANALYSIS_TONE_PERCENTILE = .995;
  const ANALYSIS_TONE_LABEL = 'P99.5';
  const ANALYSIS_DISPLAY_SCALE = 2;
  const ANALYSIS_SETTLEMENT_DISPLAY_SCALE = 3;
  const ANALYSIS_DISPLAY_SCALE_MAX_PIXELS = 1_000_000;
  const ANALYSIS_SETTLEMENT_OPACITY_CAP = .92;
  const BIOME_CONTEXT_OPACITY = 1;
  const BIOME_HIGHLIGHT_EDGE_START = .18;
  const BIOME_HIGHLIGHT_EDGE_END = .84;
  const BIOME_HIGHLIGHT_FILL_ALPHA = 72;
  const WORLD_GLOBE_RADIUS_METERS = 10_500;
  const EXACT_POINT_LIMIT = 5_000;
  const QUICK_START_DISMISSAL_KEY = 'steward-world-quick-start-terrain-v1';
  const palettes = {
    ember: [[0,[10,20,36]],[.36,[40,76,124]],[.67,[172,178,142]],[.88,[249,125,91]],[1,[255,224,166]]],
    moss: [[0,[10,30,23]],[.36,[31,92,62]],[.72,[103,176,116]],[1,[238,245,203]]],
    viridis: [[0,[35,15,68]],[.35,[48,79,150]],[.68,[32,164,139]],[1,[220,236,62]]],
    context: [[0,[24,38,55]],[.42,[54,76,94]],[1,[137,156,165]]],
    navigator: [[0,[51,76,66]],[.42,[92,125,91]],[1,[201,197,136]]]
  };

  const state = {
    bootstrap: null,
    manifest: null,
    lenses: [],
    lensById: new Map(),
    snapshotId: 0,
    lensId: 'build-density',
    resolution: 'auto',
    rasterStyle: 'smooth',
    palette: 'ember',
    analysisOpacity: .82,
    contextOpacity: .42,
    contextEnabled: true,
    exactEnabled: true,
    biomeAutoPointsSuppressed: false,
    viewMode: 'terrain',
    biomeCatalog: [],
    selectedBiomes: new Set(),
    biomeMask: null,
    biomeLoadPromise: null,
    biomeLayer: null,
    miniBiomeLayer: null,
    tool: 'pan',
    rightPanel: 'jobs',
    map: null,
    minimap: null,
    worldBounds: null,
    overlay: null,
    detailOverlay: null,
    detailObjectUrl: null,
    detailResolution: null,
    contextOverlay: null,
    miniContextOverlay: null,
    contextVariantId: null,
    miniContextVariantId: null,
    exactLayer: null,
    exactScope: null,
    exactRenderer: null,
    selectionRenderer: null,
    selectionRect: null,
    miniSelectionRect: null,
    miniViewport: null,
    drawRect: null,
    drawStart: null,
    drawMode: null,
    drawing: false,
    boxGestureActive: false,
    panGestureActive: false,
    ignoreClickUntil: 0,
    storyAction: null,
    currentEntry: null,
    currentToneCap: 1,
    currentToneFocus: 0,
    currentToneExponent: ANALYSIS_TONE_EXPONENT,
    currentSelectionBounds: null,
    currentScopeBounds: null,
    currentSelectionPositionCount: null,
    selectionItemsLoading: false,
    itemPageCursors: [null],
    itemPageIndex: 0,
    itemNextCursor: null,
    itemToken: 0,
    discordIdentity: null,
    feedbackSubmitting: false,
    rawImages: new Map(),
    coloredImages: new Map(),
    rasterToken: 0,
    contextToken: 0,
    exactToken: 0,
    inspectToken: 0,
    lastJob: null,
    lastCompletedJobId: null,
    submittingJob: false,
    pollTimer: null,
    exactTimer: null,
    toastTimer: null,
    metrics: { manifest: null, fetch: null, decode: null, swap: null, bytes: null, exact: null, detail: null }
  };

  const worldToLatLng = (x, z) => L.latLng(z, x);
  const latLngToWorld = ll => ({ x: ll.lng, z: ll.lat });
  const fmt = n => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: Number(n) < 10 ? 2 : 0 });
  const fmtBytes = n => {
    n = Number(n || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
    if (n < 1024*1024*1024) return `${(n/1024/1024).toFixed(1)} MB`;
    return `${(n/1024/1024/1024).toFixed(2)} GB`;
  };
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    let body = null;
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(body?.error || `${response.status} ${response.statusText}`);
    return body;
  }

  async function preloadImage(url) {
    const image = new Image();
    image.src = url;
    if (image.decode) await image.decode();
    else await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(`Could not decode ${url}`));
    });
  }

  async function bootstrap() {
    try {
      state.bootstrap = await fetchJson(`${API}/bootstrap`);
      PUBLIC_MODE = state.bootstrap.publicMode === true || !REQUESTED_LAB_MODE;
      document.body.classList.toggle('public-experience', PUBLIC_MODE);
      document.body.classList.toggle('lab-experience', !PUBLIC_MODE);
      state.viewMode = PUBLIC_MODE ? 'terrain' : 'heatmap';
      document.body.classList.toggle('terrain-mode', state.viewMode === 'terrain');
      state.lenses = state.bootstrap.lenses || [];
      state.lensById = new Map(state.lenses.map(lens => [lens.id, lens]));
      state.biomeCatalog = (state.bootstrap.context?.biomes?.catalog || []).map(biome => {
        if (biome.id === 'space') return { ...biome, label:'Ocean' };
        if (biome.id === 'other') return { ...biome, label:'Mountains + Forest' };
        return biome;
      });
      const biomeButton = document.querySelector('[data-view-mode="biomes"]');
      if (biomeButton) {
        biomeButton.disabled = state.biomeCatalog.length === 0;
        biomeButton.title = biomeButton.disabled
          ? 'Biome territories are not available for this world'
          : 'Explore and combine biome territories';
      }
      renderBootstrap();
      initMap();
      await loadManifest();
      bindEvents();
      if (PUBLIC_MODE) await initializePublicExperience();
      if (!PUBLIC_MODE) {
        state.pollTimer = setInterval(pollJobs, 500);
        pollJobs();
      }
    } catch (error) {
      setStory('error', PUBLIC_MODE ? 'This world view could not open' : 'Lab could not start',
        PUBLIC_MODE ? 'Please refresh and try again.' : error.message);
      console.error(error);
    }
  }

  function renderBootstrap() {
    const terrainContext = state.bootstrap.context;
    if (terrainContext?.available) {
      state.contextOpacity = Number(terrainContext.defaultOpacity ?? .62);
      $('context-opacity').value = String(state.contextOpacity);
      $('context-opacity-value').textContent = `${Math.round(state.contextOpacity*100)}%`;
    }
    const cacheChip = $('cache-chip');
    if (state.bootstrap.cacheAvailable) {
      const cacheWorlds = [...new Set((state.bootstrap.snapshots || [])
        .filter(snapshot => snapshot.source !== 'synthetic')
        .map(snapshot => String(snapshot.worldId || snapshot.worldName || '').replace(/\.db$/i, ''))
        .filter(Boolean))];
      const cacheScope = cacheWorlds.length === 1 ? `${cacheWorlds[0]} ONLY` : `${cacheWorlds.length} WORLDS`;
      const modified = state.bootstrap.cacheModifiedAt
        ? new Date(state.bootstrap.cacheModifiedAt).toLocaleString() : 'unknown date';
      cacheChip.textContent = `CACHE · ${cacheScope} · READ ONLY`;
      cacheChip.title = `${state.bootstrap.cachePath}\n${fmtBytes(state.bootstrap.cacheBytes)} · last written ${modified}`;
      cacheChip.className = 'header-chip ok';
    } else {
      cacheChip.textContent = 'CACHE · MISSING';
      cacheChip.title = state.bootstrap.cachePath;
      cacheChip.className = 'header-chip bad';
    }

    const select = $('snapshot-select');
    select.innerHTML = '';
    for (const snapshot of state.bootstrap.snapshots || []) {
      const option = document.createElement('option');
      option.value = snapshot.snapshotId;
      option.textContent = `#${snapshot.snapshotId} · ${snapshot.worldName || snapshot.worldId} · ${snapshot.source}`;
      select.appendChild(option);
    }
    const preferred = (state.bootstrap.snapshots || []).find(s => s.source !== 'synthetic') || state.bootstrap.snapshots?.[0];
    state.snapshotId = preferred?.snapshotId || 0;
    select.value = String(state.snapshotId);
    updateSnapshotHeader();

    const list = $('lens-list');
    list.innerHTML = '';
    for (const lens of state.lenses) {
      const button = document.createElement('button');
      button.className = `lens-button${lens.id === state.lensId ? ' active' : ''}`;
      button.dataset.lens = lens.id;
      button.innerHTML = `<span>${escapeHtml(lens.label)}</span><i class="available"></i>`;
      button.title = `${lens.question}\n${lens.payoff}`;
      list.appendChild(button);
    }
    updateLensCopy();
    $('context-provenance').textContent = terrainContext?.provenance ||
      (state.bootstrap.contextAuthoritative ? 'AUTHORITATIVE' : 'INFERRED');
    $('context-copy').textContent = terrainContext?.available
      ? `${terrainContext.label} combines Valheim terrain, water, and save-matched player ground edits.`
      : state.bootstrap.contextAuthoritative
      ? `${state.bootstrap.contextLabel} is supplied as the cartographic underlay.`
      : 'The surface ZDO field is an inferred coastline, not a terrain heightmap.';
    renderBiomeControls();
    setRasterStyle(state.rasterStyle);
  }

  function renderBiomeControls() {
    const list = $('biome-chip-list');
    const controls = $('map-view-controls');
    const group = $('biome-filter-group');
    const available = state.biomeCatalog.length > 0;
    controls.hidden = false;
    group.disabled = !available || state.viewMode !== 'biomes';
    group.setAttribute('aria-disabled', String(group.disabled));
    if (!available) return;
    const chips = [{ id:'none', label:'None', color:'#738096', itemCount:0 }, ...state.biomeCatalog];
    list.innerHTML = chips.map(biome => {
      const active = biome.id === 'none' ? state.selectedBiomes.size === 0 : state.selectedBiomes.has(biome.id);
      const title = biome.id === 'none' ? 'Clear all biome highlights' : `${biome.label} · ${fmt(biome.itemCount)} objects`;
      return `<button type="button" class="biome-chip${active ? ' active' : ''}" data-biome="${escapeHtml(biome.id)}" style="--biome-color:${escapeHtml(biome.color)}" aria-pressed="${active}" aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}"><i></i><span>${escapeHtml(biome.label)}</span></button>`;
    }).join('');
    const selected = selectedBiomeCatalog();
    $('biome-view-results').disabled = selected.length === 0;
    $('biome-view-results').title = selected.length
      ? `Inspect every object in ${selectedBiomeSummary()}`
      : 'Select one or more biome territories to inspect';
  }

  function selectedBiomeCatalog() {
    return state.biomeCatalog.filter(biome => state.selectedBiomes.has(biome.id));
  }

  function selectedBiomeSummary() {
    const selected = selectedBiomeCatalog();
    if (!selected.length) return 'all biomes';
    if (selected.length === 1) return selected[0].label;
    if (selected.length === 2) return `${selected[0].label} + ${selected[1].label}`;
    return `${selected.length} selected biomes`;
  }

  function biomeQueryValue() {
    return state.viewMode === 'biomes' && state.selectedBiomes.size
      ? selectedBiomeCatalog().map(biome => biome.id).join(',') : '';
  }

  function scopedQuery(bounds, extras = {}) {
    const query = new URLSearchParams({
      minX:bounds.getWest(), maxX:bounds.getEast(), minZ:bounds.getSouth(), maxZ:bounds.getNorth(), ...extras
    });
    const biomes = biomeQueryValue();
    if (biomes) query.set('biomes', biomes);
    return query.toString();
  }

  function setBiomeFilter(id) {
    if (id === 'none') state.selectedBiomes.clear();
    else if (state.selectedBiomes.has(id)) state.selectedBiomes.delete(id);
    else {
      if (state.selectedBiomes.size === 0) state.selectedBiomes.add(id);
      else state.selectedBiomes.add(id);
    }
    renderBiomeControls();
    redrawBiomeLayers();
    if (state.viewMode !== 'biomes') return;
    state.biomeAutoPointsSuppressed = false;
    if (state.exactScope === 'biome-selection' || state.exactScope === 'biome-viewport') removeExactMarkers();
    const bounds = state.currentSelectionBounds || state.worldBounds;
    if (!$('inspect-content').hidden && !state.selectedBiomes.size && !state.currentSelectionBounds) closeInspector();
    else if (!$('inspect-content').hidden) inspectBounds(bounds, { draw:Boolean(state.currentSelectionBounds), preserveView:true });
    else {
      showBiomeOutlineStory();
      scheduleExactPoints();
    }
  }

  function showBiomeOutlineStory(prefix = '') {
    const selected = selectedBiomeCatalog();
    const title = prefix || (selected.length ? `${selectedBiomeSummary()} highlighted` : 'Biome territories');
    const copy = selected.length
      ? `${selectedBiomeSummary()} is highlighted. Click another territory to switch, combine filters above, or inspect an area for its objects.`
      : 'The terrain stays clear until you click a territory or choose a biome above. Smaller islands resolve as you zoom closer.';
    $('exact-state').textContent = 'OUTLINES';
    setStory('ready', title, copy, { type:'inspect', label:'Inspect an area' });
  }

  function showTerrainStory() {
    const close = state.map && state.map.getZoom() >= Number(state.bootstrap?.context?.detailZoom ?? -2.25);
    $('exact-state').textContent = 'TERRAIN';
    $('map-status').textContent = close
      ? `Terrain · detailed contours · snapshot #${state.snapshotId}`
      : `Terrain · world contours · snapshot #${state.snapshotId}`;
    setStory('ready', close ? 'Read the terrain in detail' : 'Follow the shape of the world',
      close
        ? 'Enhanced contour lines reveal slopes, ridges, shorelines, and player-shaped ground. Inspect an area to see what was built there.'
        : 'Construction is hidden so the terrain can lead. Zoom closer for stronger elevation detail, or inspect an area for its objects.',
      { type:'inspect', label:'Inspect an area' });
  }

  function hasEnhancedTerrain() {
    const variants = state.bootstrap?.context?.variants || [];
    return ['topographic-overview','topographic-detail']
      .every(id => variants.some(variant => variant.id === id));
  }

  function isInsideGlobe(latlng) {
    return Boolean(latlng) && Math.hypot(latlng.lng, latlng.lat) <= WORLD_GLOBE_RADIUS_METERS;
  }

  function biomeAtLatLng(latlng) {
    const mask = state.biomeMask;
    if (!mask || !latlng) return null;
    if (!isInsideGlobe(latlng)) return null;
    const bounds = mask.bounds;
    const raw = (worldX, worldZ, source = mask.indices) => {
      if (worldX < bounds.minX || worldX >= bounds.maxX || worldZ < bounds.minZ || worldZ >= bounds.maxZ) return mask.spaceIndex;
      const x = Math.max(0, Math.min(mask.width - 1,
        Math.floor((worldX - bounds.minX) / (bounds.maxX - bounds.minX) * mask.width)));
      const z = Math.max(0, Math.min(mask.height - 1,
        Math.floor((bounds.maxZ - worldZ) / (bounds.maxZ - bounds.minZ) * mask.height)));
      return source[z * mask.width + x];
    };
    const source = mask.displayIndices;
    const index = raw(latlng.lng, latlng.lat, source);
    return mask.byIndex.get(index) || null;
  }

  function selectBiomeAt(latlng) {
    if (state.viewMode !== 'biomes') return false;
    const biome = biomeAtLatLng(latlng);
    if (!biome) return false;
    state.selectedBiomes.clear();
    state.selectedBiomes.add(biome.id);
    state.biomeAutoPointsSuppressed = false;
    if (state.exactScope === 'biome-selection' || state.exactScope === 'biome-viewport') removeExactMarkers();
    renderBiomeControls();
    redrawBiomeLayers();
    if (!$('inspect-content').hidden) {
      inspectBounds(state.currentSelectionBounds || state.worldBounds,
        { draw:Boolean(state.currentSelectionBounds), preserveView:true });
    } else {
      showBiomeOutlineStory(`${biome.label} highlighted`);
      scheduleExactPoints();
    }
    toast(`${biome.label} territory highlighted`);
    return true;
  }

  async function setViewMode(mode) {
    mode = mode === 'biomes' && state.biomeCatalog.length ? 'biomes'
      : mode === 'heatmap' ? 'heatmap' : 'terrain';
    if (state.viewMode === mode) {
      if (mode === 'terrain') return;
      mode = 'terrain';
    }
    state.viewMode = mode;
    document.body.classList.toggle('biome-mode', mode === 'biomes');
    document.body.classList.toggle('terrain-mode', mode === 'terrain');
    document.querySelectorAll('[data-view-mode]').forEach(button => {
      const active = button.dataset.viewMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    renderBiomeControls();
    if (mode === 'biomes') {
      state.biomeAutoPointsSuppressed = false;
      clearExactPoints();
      try {
        await applyContext();
        await ensureBiomeLayers();
        syncCompositeOpacity();
        $('legend').hidden = true;
        showBiomeOutlineStory();
        scheduleExactPoints();
      } catch (error) {
        state.viewMode = 'terrain';
        document.body.classList.remove('biome-mode');
        document.body.classList.add('terrain-mode');
        document.querySelectorAll('[data-view-mode]').forEach(button => {
          button.classList.remove('active');
          button.setAttribute('aria-pressed', 'false');
        });
        renderBiomeControls();
        setStory('error', 'Biome view could not load', error.message);
        await applyRaster();
      }
    } else {
      removeBiomeLayers();
      if (state.exactScope === 'biome-selection' || state.exactScope === 'biome-viewport') {
        removeExactMarkers();
        $('exact-state').textContent = mode === 'terrain' ? 'TERRAIN' : 'RASTER';
      }
      if (mode === 'terrain') removeExactMarkers();
      renderBiomeControls();
      await applyContext();
      await applyRaster();
      if (mode === 'terrain') showTerrainStory();
      else scheduleExactPoints();
    }
  }

  async function ensureBiomeLayers() {
    await ensureBiomeMask();
    if (!state.biomeLayer) state.biomeLayer = createBiomeLayer(false).addTo(state.map);
    if (!state.miniBiomeLayer) state.miniBiomeLayer = createBiomeLayer(true).addTo(state.minimap);
  }

  async function ensureBiomeMask() {
    if (state.biomeMask) return state.biomeMask;
    if (state.biomeLoadPromise) return state.biomeLoadPromise;
    state.biomeLoadPromise = (async () => {
      const terrain = state.bootstrap.context;
      const colorIndices = new Map(state.biomeCatalog.map(biome => {
        const color = biome.color.slice(1);
        return [parseInt(color, 16), Number(biome.index)];
      }));
      const decode = async variant => {
        const response = await fetch(`${API}/context/${encodeURIComponent(variant.id)}?v=${encodeURIComponent(variant.version)}`);
        if (!response.ok) throw new Error(`Biome mask request failed (${response.status})`);
        const bitmap = await createImageBitmap(await response.blob());
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d', { willReadFrequently:true });
        context.drawImage(bitmap, 0, 0);
        const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const indices = new Uint8Array(bitmap.width * bitmap.height);
        for (let offset = 0, pixel = 0; pixel < indices.length; offset += 4, pixel++) {
          const key = (rgba[offset] << 16) | (rgba[offset + 1] << 8) | rgba[offset + 2];
          const index = colorIndices.get(key);
          if (index == null) throw new Error('Biome mask contains an unknown territory color.');
          indices[pixel] = index;
        }
        const decoded = { width:bitmap.width, height:bitmap.height, indices };
        bitmap.close?.();
        return decoded;
      };
      const maskId = terrain?.biomes?.maskVariant;
      const displayMaskId = terrain?.biomes?.displayMaskVariant || maskId;
      const variant = terrain?.variants?.find(item => item.id === maskId);
      const displayVariant = terrain?.variants?.find(item => item.id === displayMaskId);
      if (!terrain?.available || !variant || !displayVariant) throw new Error('The biome masks are not part of this release.');
      const [exactMask, displayMask] = await Promise.all([decode(variant), decode(displayVariant)]);
      if (exactMask.width !== displayMask.width || exactMask.height !== displayMask.height) {
        throw new Error('The biome display mask does not match the authoritative mask.');
      }
      state.biomeMask = {
        width:exactMask.width, height:exactMask.height, indices:exactMask.indices,
        displayIndices:displayMask.indices, bounds:terrain.bounds,
        spaceIndex:Number(state.biomeCatalog.find(item => item.id === 'space')?.index || 1),
        byIndex:new Map(state.biomeCatalog.map(item => [Number(item.index), item]))
      };
      return state.biomeMask;
    })();
    try { return await state.biomeLoadPromise; }
    finally { state.biomeLoadPromise = null; }
  }

  function createBiomeLayer(mini) {
    const BiomeGrid = L.GridLayer.extend({
      createTile(coords) {
        const canvas = document.createElement('canvas');
        const size = this.getTileSize();
        const renderScale = mini ? 1 : 2;
        const width = size.x * renderScale;
        const height = size.y * renderScale;
        canvas.width = width; canvas.height = height;
        canvas.style.width = `${size.x}px`; canvas.style.height = `${size.y}px`;
        canvas.className = 'biome-tile';
        canvas.setAttribute('aria-hidden', 'true');
        const context = canvas.getContext('2d');
        const image = context.createImageData(width, height);
        const edgeImage = mini ? null : context.createImageData(width, height);
        const map = this._map;
        const northWest = map.unproject(L.point(coords.x * size.x, coords.y * size.y), coords.z);
        const southEast = map.unproject(L.point((coords.x + 1) * size.x, (coords.y + 1) * size.y), coords.z);
        const dx = (southEast.lng - northWest.lng) / width;
        const dz = (northWest.lat - southEast.lat) / height;
        const mask = state.biomeMask;
        const source = mask.displayIndices;
        const selected = new Set([...state.selectedBiomes].map(id => Number(state.biomeCatalog.find(item => item.id === id)?.index)));
        const showNone = selected.size === 0;
        if (showNone) return canvas;
        const sampleRaw = (worldX, worldZ) => {
          const b = mask.bounds;
          if (worldX < b.minX || worldX >= b.maxX || worldZ < b.minZ || worldZ >= b.maxZ) return mask.spaceIndex;
          const x = Math.max(0, Math.min(mask.width - 1, Math.floor((worldX - b.minX) / (b.maxX - b.minX) * mask.width)));
          const z = Math.max(0, Math.min(mask.height - 1, Math.floor((b.maxZ - worldZ) / (b.maxZ - b.minZ) * mask.height)));
          return source[z * mask.width + x];
        };
        const selectedAt = (x, y) => {
          if (x < 0 || x >= mask.width || y < 0 || y >= mask.height) return selected.has(mask.spaceIndex) ? 1 : 0;
          return selected.has(source[y * mask.width + x]) ? 1 : 0;
        };
        const sampleSelectedCoverage = (worldX, worldZ) => {
          const b = mask.bounds;
          const column = (worldX - b.minX) / (b.maxX - b.minX) * mask.width - .5;
          const row = (b.maxZ - worldZ) / (b.maxZ - b.minZ) * mask.height - .5;
          const x0 = Math.floor(column), y0 = Math.floor(row);
          const tx = column - x0, ty = row - y0;
          const top = selectedAt(x0, y0) * (1 - tx) + selectedAt(x0 + 1, y0) * tx;
          const bottom = selectedAt(x0, y0 + 1) * (1 - tx) + selectedAt(x0 + 1, y0 + 1) * tx;
          return top * (1 - ty) + bottom * ty;
        };
        const fallbackIndex = selected.values().next().value;
        for (let y = 0; y < height; y++) {
          const worldZ = northWest.lat - (y + .5) * dz;
          for (let x = 0; x < width; x++) {
            const worldX = northWest.lng + (x + .5) * dx;
            const coverage = sampleSelectedCoverage(worldX, worldZ);
            if (coverage < BIOME_HIGHLIGHT_EDGE_START) continue;
            let biomeIndex = sampleRaw(worldX, worldZ);
            if (!selected.has(biomeIndex)) biomeIndex = fallbackIndex;
            const biome = mask.byIndex.get(biomeIndex);
            if (!biome) continue;
            const color = parseInt(biome.color.slice(1), 16);
            const offset = (y * width + x) * 4;
            const edge = coverage < BIOME_HIGHLIGHT_EDGE_END;
            const edgeStrength = edge
              ? Math.min(1, (coverage - BIOME_HIGHLIGHT_EDGE_START) /
                (BIOME_HIGHLIGHT_EDGE_END - BIOME_HIGHLIGHT_EDGE_START))
              : 0;
            const lift = edge ? .24 : 0;
            image.data[offset] = Math.round((color >> 16) * (1 - lift) + 255 * lift);
            image.data[offset + 1] = Math.round(((color >> 8) & 255) * (1 - lift) + 255 * lift);
            image.data[offset + 2] = Math.round((color & 255) * (1 - lift) + 255 * lift);
            image.data[offset + 3] = edge
              ? Math.round(132 + edgeStrength * 123)
              : BIOME_HIGHLIGHT_FILL_ALPHA;
            if (edgeImage && edge) {
              edgeImage.data[offset] = image.data[offset];
              edgeImage.data[offset + 1] = image.data[offset + 1];
              edgeImage.data[offset + 2] = image.data[offset + 2];
              edgeImage.data[offset + 3] = image.data[offset + 3];
            }
          }
        }
        context.putImageData(image, 0, 0);
        if (edgeImage) {
          const edgeCanvas = document.createElement('canvas');
          edgeCanvas.width = width; edgeCanvas.height = height;
          edgeCanvas.getContext('2d').putImageData(edgeImage, 0, 0);
          context.save();
          context.globalCompositeOperation = 'destination-over';
          context.globalAlpha = .45;
          for (const [offsetX, offsetY] of [[-3,0],[3,0],[0,-3],[0,3],[-2,-2],[2,-2],[-2,2],[2,2]]) {
            context.drawImage(edgeCanvas, offsetX, offsetY);
          }
          context.restore();
        }
        return canvas;
      }
    });
    return new BiomeGrid({
      pane:mini ? 'overlayPane' : 'biomePane', tileSize:256, opacity:mini ? .82 : 1,
      minZoom:-10, maxZoom:4, updateWhenZooming:false, keepBuffer:mini ? 0 : 2
    });
  }

  function redrawBiomeLayers() {
    state.biomeLayer?.redraw();
    state.miniBiomeLayer?.redraw();
  }

  function removeBiomeLayers() {
    if (state.biomeLayer && state.map) state.map.removeLayer(state.biomeLayer);
    if (state.miniBiomeLayer && state.minimap) state.minimap.removeLayer(state.miniBiomeLayer);
    state.biomeLayer = state.miniBiomeLayer = null;
  }

  async function loadBiomeSample(bounds) {
    if (state.viewMode !== 'biomes' || !bounds) return;
    clearTimeout(state.exactTimer);
    state.biomeAutoPointsSuppressed = false;
    const token = ++state.exactToken;
    state.selectionItemsLoading = true;
    syncSelectionAction();
    try {
      const query = scopedQuery(bounds, { sample:'true' });
      const result = await fetchJson(`${API}/points?snapshot=${state.snapshotId}&lens=${encodeURIComponent(state.lensId)}&limit=${EXACT_POINT_LIMIT}&${query}`);
      if (token !== state.exactToken || state.viewMode !== 'biomes') return;
      installPointMarkers(result.points, state.lensById.get(state.lensId), 'biome-selection');
      $('exact-state').textContent = result.truncated
        ? `${fmt(result.points.length)} OF ${fmt(result.total)} SAMPLE`
        : `${fmt(result.points.length)} BIOME POINTS`;
      setStory('ready', `${fmt(result.total)} objects · ${selectedBiomeSummary()}`,
        result.truncated
          ? `A stable ${fmt(result.points.length)}-object sample is shown. The inspector pages through the complete list.`
          : 'Every object in this biome scope is shown. Draw a green area to narrow it further.',
        { type:'inspect', label:'Inspect an area' });
    } catch (error) {
      if (token === state.exactToken) toast(`Could not load biome sample · ${error.message}`);
    } finally {
      if (token === state.exactToken) {
        state.selectionItemsLoading = false;
        syncSelectionAction();
      }
    }
  }

  async function loadBiomeViewportPoints() {
    if (state.viewMode !== 'biomes' || !state.map || state.exactScope === 'biome-selection') return;
    const threshold = Number($('threshold-exact').value);
    if (!state.exactEnabled || !state.selectedBiomes.size || state.biomeAutoPointsSuppressed || state.map.getZoom() < threshold) {
      if (state.exactScope === 'biome-viewport') removeExactMarkers();
      showBiomeOutlineStory();
      return;
    }
    const bounds = clampToWorld(state.map.getBounds());
    if (!bounds) return;
    const token = ++state.exactToken;
    try {
      const result = await fetchJson(`${API}/points?snapshot=${state.snapshotId}&lens=${encodeURIComponent(state.lensId)}&limit=${EXACT_POINT_LIMIT}&${scopedQuery(bounds)}`);
      if (token !== state.exactToken || state.viewMode !== 'biomes') return;
      if (result.truncated) {
        removeExactMarkers();
        $('exact-state').textContent = `> ${fmt(result.limit)} · OUTLINES`;
        setStory('warn', `Too many objects to reveal · ${selectedBiomeSummary()}`,
          'The territory map stays clear here. Scroll closer or inspect a green area for its complete object list.',
          { type:'inspect', label:'Inspect an area' });
        return;
      }
      installPointMarkers(result.points, state.lensById.get(state.lensId), 'biome-viewport');
      $('exact-state').textContent = `${fmt(result.points.length)} BIOME POINTS`;
      setStory(result.points.length ? 'ready' : '',
        result.points.length ? `${fmt(result.points.length)} objects in view · ${selectedBiomeSummary()}` : `No objects in view · ${selectedBiomeSummary()}`,
        'Close detail is active. Pan onward, click a territory to switch the highlight, or inspect an area for the complete list.',
        { type:'inspect', label:'Inspect an area' });
    } catch (error) {
      if (token === state.exactToken) $('exact-state').textContent = 'QUERY FAILED';
    }
  }

  function setRasterStyle(style) {
    state.rasterStyle = style === 'cells' ? 'cells' : 'smooth';
    document.body.classList.toggle('raster-cells', state.rasterStyle === 'cells');
    document.querySelectorAll('#raster-style-buttons [data-raster-style]').forEach(button => {
      const active = button.dataset.rasterStyle === state.rasterStyle;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function updateSnapshotHeader() {
    const snapshot = state.bootstrap?.snapshots?.find(s => Number(s.snapshotId) === Number(state.snapshotId));
    $('zdo-count').textContent = snapshot ? fmt(snapshot.zdoCount) : '—';
    $('job-target').textContent = snapshot ? `#${snapshot.snapshotId}` : '—';
    const worldName = snapshot?.worldName || snapshot?.worldId || 'World';
    $('public-world-name').textContent = worldName;
    if (PUBLIC_MODE) document.title = `Steward — ${worldName}`;
  }

  function updateLensCopy() {
    const lens = state.lensById.get(state.lensId);
    $('header-lens').textContent = lens?.label || '—';
    $('lens-question').textContent = lens?.question || 'Choose a lens';
    $('lens-payoff').textContent = lens?.payoff || '';
    if ($('job-scope')) $('job-scope').textContent = `Creates full-world ${lens?.label || 'active lens'} rasters. A zoom window changes your view, not the job scope.`;
    document.querySelectorAll('.lens-button').forEach(button => button.classList.toggle('active', button.dataset.lens === state.lensId));
  }

  function initMap() {
    const b = state.bootstrap.worldBounds;
    state.worldBounds = L.latLngBounds([b.minZ, b.minX], [b.maxZ, b.maxX]);
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    state.map = L.map('map', {
      crs: L.CRS.Simple,
      minZoom: -7,
      maxZoom: 4,
      zoomSnap: .25,
      preferCanvas: true,
      boxZoom: false,
      zoomAnimation: !reducedMotion,
      fadeAnimation: !reducedMotion,
      markerZoomAnimation: !reducedMotion
    });
    state.map.createPane('contextPane').style.zIndex = 180;
    state.map.createPane('gridPane').style.zIndex = 220;
    state.map.createPane('analysisPane').style.zIndex = 280;
    state.map.createPane('detailPane').style.zIndex = 320;
    state.map.createPane('biomePane').style.zIndex = 340;
    state.map.createPane('exactPane').style.zIndex = 360;
    state.map.createPane('selectionPane').style.zIndex = 430;
    state.exactRenderer = L.canvas({ pane:'exactPane', padding:.25 });
    state.selectionRenderer = L.svg({ pane:'selectionPane', padding:.1 });
    state.map.fitBounds(state.worldBounds.pad(.03), { animate: false });
    drawGrid();

    state.minimap = L.map('minimap', {
      crs: L.CRS.Simple,
      minZoom: -10,
      maxZoom: 0,
      zoomSnap: .25,
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false
    });
    state.minimap.fitBounds(state.worldBounds, { animate: false, padding: [3,3] });
    L.circleMarker(worldToLatLng(0,0), { radius: 3, color: '#f4d267', fillColor: '#f4d267', fillOpacity: 1, weight: 1 }).addTo(state.minimap).bindTooltip('Spawn');
    state.minimap.on('click', event => state.map.panTo(event.latlng));
    updateMiniViewport();

    state.map.getContainer().addEventListener('mousedown', event => {
      if (event.button === 0 && event.shiftKey && state.tool === 'pan') state.map.dragging.disable();
    }, true);
    state.map.on('mousemove', event => {
      const world = latLngToWorld(event.latlng);
      $('coords').textContent = state.panGestureActive
        ? 'PAN · release to place the map'
        : state.boxGestureActive
        ? 'BOX ZOOM · release to fit the gold window'
        : `X ${Math.round(world.x).toLocaleString()} · Z ${Math.round(world.z).toLocaleString()} · ${state.tool.toUpperCase()} · Shift+drag zoom`;
      if (state.drawing && state.drawRect) state.drawRect.setBounds([state.drawStart, event.latlng]);
    });
    state.map.on('mousedown', startDrawing);
    state.map.on('mouseup', finishDrawing);
    state.map.on('click', event => {
      if (state.tool !== 'pan' || state.drawing || performance.now() < state.ignoreClickUntil) return;
      if (!isInsideGlobe(event.latlng)) return;
      if (state.viewMode === 'biomes') {
        selectBiomeAt(event.latlng);
        return;
      }
      inspectCell(event.latlng);
    });
    state.map.on('movestart zoomstart', pauseExactPoints);
    state.map.on('dragstart', () => {
      state.panGestureActive = true;
      document.body.classList.add('map-pan-active');
      $('coords').textContent = 'PAN · release to place the map';
    });
    state.map.on('dragend', () => {
      state.panGestureActive = false;
      document.body.classList.remove('map-pan-active');
      $('coords').textContent = 'PAN · hold and drag to move · Shift+drag zoom';
    });
    state.map.on('zoomend', () => {
      const before = state.currentEntry?.cellSize;
      applyContext();
      applyRaster().then(() => {
        const after = state.currentEntry?.cellSize;
        if (before && after && before !== after) toast(PUBLIC_MODE
          ? scaleMoment(after)
          : `${before} m aggregate → ${after} m detail`);
      });
      document.body.classList.remove('map-view-moving');
      updateMiniViewport();
      scheduleExactPoints();
    });
    state.map.on('moveend', () => {
      document.body.classList.remove('map-view-moving');
      updateMiniViewport();
      scheduleExactPoints();
    });
    setTool(state.tool);
  }

  function scaleMoment(cellSize) {
    const size = Number(cellSize);
    if (size >= 1000) return 'World overview';
    if (size >= 320) return 'Settlement regions';
    if (size > 64) return 'District detail';
    if (size >= 64) return 'Neighborhood detail';
    return 'Close detail';
  }

  function drawGrid() {
    const b = state.bootstrap.worldBounds;
    const style = { pane:'gridPane', color:'#29364a', weight:1, opacity:.45, dashArray:'4,5', interactive:false };
    for (let x = -25000; x <= 25000; x += 5000) L.polyline([[b.minZ,x],[b.maxZ,x]], style).addTo(state.map);
    for (let z = -20000; z <= 25000; z += 5000) L.polyline([[z,b.minX],[z,b.maxX]], style).addTo(state.map);
  }

  async function loadManifest() {
    const started = performance.now();
    try {
      state.manifest = await fetchJson(`${API}/manifest?snapshot=${state.snapshotId}`);
      state.metrics.manifest = performance.now() - started;
    } catch (error) {
      state.metrics.manifest = performance.now() - started;
      state.manifest = { snapshotId: state.snapshotId, layers: [] };
      setStory('', PUBLIC_MODE ? 'This view is not ready yet' : 'No raster ladder yet',
        PUBLIC_MODE ? 'Please try again shortly.' : 'Render a lens to begin the overview → zoom → explain loop.',
        PUBLIC_MODE ? null : true);
    }
    updateAvailability();
    updateMetrics();
    await applyContext();
    await applyRaster();
  }

  function updateAvailability() {
    const layers = state.manifest?.layers || [];
    document.querySelectorAll('.lens-button').forEach(button => {
      const count = new Set(layers.filter(layer => layer.lensId === button.dataset.lens).map(layer => layer.cellSize)).size;
      const dot = button.querySelector('.available');
      dot.className = `available ${count >= 3 ? 'full' : count ? 'some' : ''}`;
      dot.title = `${count} rendered resolution${count === 1 ? '' : 's'}`;
    });
    const count = new Set(layers.filter(layer => layer.lensId === state.lensId).map(layer => layer.cellSize)).size;
    $('lens-availability').textContent = count ? `${count} WORLD + 2 LOCAL` : '0 SCALES';
  }

  function desiredResolution() {
    if (state.resolution !== 'auto') return Number(state.resolution);
    const zoom = state.map?.getZoom() ?? -5;
    const threshold160 = Number($('threshold-160').value);
    const threshold80 = Number($('threshold-80').value);
    const threshold64 = Number($('threshold-64').value);
    const threshold16 = Number($('threshold-16').value);
    if (zoom >= threshold16) return 16;
    if (zoom >= threshold64) return 64;
    if (zoom >= threshold80) return 80;
    if (zoom >= threshold160) return 160;
    if (zoom < -5.4) return 1000;
    return 320;
  }

  function analysisScaleFocus(cellSize) {
    const size = Math.max(1, Number(cellSize || 64));
    const coarse = 320;
    const detail = 64;
    return Math.max(0, Math.min(1, Math.log(coarse/size) / Math.log(coarse/detail)));
  }

  function analysisToneExponent(cellSize) {
    const size = Math.max(320, Number(cellSize || 320));
    const overviewProgress = Math.max(0, Math.min(1, Math.log(size/320) / Math.log(1000/320)));
    return ANALYSIS_TONE_EXPONENT
      +(ANALYSIS_OVERVIEW_TONE_EXPONENT-ANALYSIS_TONE_EXPONENT)*overviewProgress;
  }

  function effectiveAnalysisOpacity(entry = state.currentEntry) {
    const detailZoom = Number($('opacity-detail-zoom')?.value ?? -4);
    const base = state.map && state.map.getZoom() < detailZoom ? 1 : state.analysisOpacity;
    return Number(entry?.cellSize) === 320 ? Math.min(base, ANALYSIS_SETTLEMENT_OPACITY_CAP) : base;
  }

  function layerFor(lensId, resolution, allowFallback = true) {
    const candidates = (state.manifest?.layers || []).filter(layer => layer.lensId === lensId);
    const exact = candidates.find(layer => Number(layer.cellSize) === Number(resolution));
    if (exact || !allowFallback || !candidates.length) return exact || null;
    return [...candidates].sort((a,b) => Math.abs(Math.log(a.cellSize/resolution)) - Math.abs(Math.log(b.cellSize/resolution)))[0];
  }

  async function applyRaster() {
    if (!state.map || !state.manifest) return;
    if (state.viewMode !== 'heatmap') {
      ++state.rasterToken;
      syncCompositeOpacity();
      $('legend').hidden = true;
      if (state.viewMode === 'terrain') showTerrainStory();
      return;
    }
    const requested = desiredResolution();
    const entry = layerFor(state.lensId, requested);
    const holdingLocalDetail = Boolean(state.detailOverlay);
    if (!holdingLocalDetail) $('scale-state').textContent = state.resolution === 'auto'
      ? `AUTO → ${entry?.cellSize || requested} M` : `${requested} M`;
    updateAvailability();
    if (!entry) {
      state.currentEntry = null;
      if (state.overlay) { state.map.removeLayer(state.overlay); state.overlay = null; }
      $('legend').hidden = true;
      $('map-status').textContent = `${state.lensById.get(state.lensId)?.label || state.lensId} · NOT RENDERED`;
      setStory('', PUBLIC_MODE ? 'This view is not ready yet' : `${state.lensById.get(state.lensId)?.label} is ready to test`,
        PUBLIC_MODE ? 'Please try again shortly.' : 'Create the selected resolution ladder, then zoom into the signal.',
        PUBLIC_MODE ? null : true);
      clearExactPoints();
      return;
    }

    const token = ++state.rasterToken;
    const lens = state.lensById.get(state.lensId);
    if (!holdingLocalDetail) setStory('', PUBLIC_MODE ? 'Opening community construction…' : `Loading ${lens.label} at ${entry.cellSize} m…`,
      PUBLIC_MODE ? 'Finding where the world is most active.' : 'Fetching gray8 evidence and applying the selected color ramp.');
    try {
      const image = await coloredImage(artifactUrl(entry), state.palette, entry);
      if (token !== state.rasterToken) return;
      const swapStarted = performance.now();
      const overlay = L.imageOverlay(image.url, leafletBounds(entry.bounds), {
        pane: 'analysisPane', opacity: 0, interactive: false, className: 'analysis-raster'
      }).addTo(state.map);
      overlay.getElement().dataset.displayScale = String(image.displayScale);
      const previousOverlay = state.overlay;
      if (!holdingLocalDetail) await crossfade(previousOverlay, overlay, effectiveAnalysisOpacity(entry));
      if (token !== state.rasterToken) { state.map.removeLayer(overlay); return; }
      if (holdingLocalDetail && previousOverlay) state.map.removeLayer(previousOverlay);
      state.overlay = overlay;
      state.currentEntry = entry;
      state.currentToneCap = image.toneCap;
      state.currentToneFocus = image.toneFocus;
      state.currentToneExponent = image.toneExponent;
      syncCompositeOpacity();
      state.metrics.fetch = image.fetchMs;
      state.metrics.decode = image.colorMs;
      state.metrics.swap = performance.now() - swapStarted;
      state.metrics.bytes = image.bytes;
      updateDetailLadder();
      if (!state.detailOverlay) {
        updateLegend(entry, lens, image.toneCap, image.toneFocus, image.toneExponent);
        $('map-status').textContent = `${lens.label} · ${entry.cellSize} m cells · snapshot #${state.snapshotId} · ${state.palette}`;
        const fallback = Number(entry.cellSize) !== Number(requested) ? ` Nearest available scale: ${entry.cellSize} m.` : '';
        const guidance = rasterGuidance(entry, lens, fallback);
        setStory('ready', guidance.title, guidance.copy, guidance.action);
      }
      updateMetrics();
      scheduleExactPoints();
    } catch (error) {
      if (token !== state.rasterToken) return;
      setStory('error', PUBLIC_MODE ? 'This view could not load' : 'Raster load failed',
        PUBLIC_MODE ? 'Please refresh and try again.' : error.message,
        PUBLIC_MODE ? null : true);
    }
  }

  async function applyContext() {
    if (!state.map || (!state.contextEnabled && state.viewMode === 'heatmap')) {
      removeContext();
      return;
    }
    const token = ++state.contextToken;
    try {
      let imageUrl;
      let miniImageUrl;
      let variantId = 'inferred';
      let miniVariantId = 'inferred-navigator';
      let bounds = state.bootstrap.worldBounds;
      let miniBounds = bounds;
      const terrain = state.bootstrap.context;
      if (terrain?.available && Array.isArray(terrain.variants)) {
        const enhanced = state.viewMode !== 'heatmap' && hasEnhancedTerrain();
        const overviewId = enhanced ? 'topographic-overview' : 'overview';
        const detailId = enhanced ? 'topographic-detail' : 'detail';
        const overview = terrain.variants.find(variant => variant.id === overviewId);
        const detail = terrain.variants.find(variant => variant.id === detailId);
        if (!overview || !detail) throw new Error('Terrain context variants are incomplete');
        const selected = state.map.getZoom() >= Number(terrain.detailZoom ?? -2.25) ? detail : overview;
        variantId = selected.id;
        miniVariantId = overview.id;
        imageUrl = `${API}/context/${encodeURIComponent(selected.id)}?v=${encodeURIComponent(selected.version)}`;
        miniImageUrl = `${API}/context/${encodeURIComponent(overview.id)}?v=${encodeURIComponent(overview.version)}`;
        bounds = miniBounds = terrain.bounds;
        if (state.contextOverlay && state.contextVariantId === variantId &&
            state.miniContextOverlay && state.miniContextVariantId === miniVariantId) {
          syncCompositeOpacity();
          return;
        }
        await Promise.all([preloadImage(imageUrl), imageUrl === miniImageUrl ? Promise.resolve() : preloadImage(miniImageUrl)]);
        if (token !== state.contextToken) return;
      } else if (state.bootstrap.contextAuthoritative) {
        variantId = miniVariantId = 'supplied';
        imageUrl = miniImageUrl = `${API}/context`;
      } else {
        const contextEntry = layerFor('all-zdos', desiredResolution());
        const navigatorEntry = layerFor('all-zdos', 320);
        if (!contextEntry || !navigatorEntry) { removeContext(); return; }
        const context = await coloredImage(artifactUrl(contextEntry), 'context', contextEntry);
        const navigator = await coloredImage(artifactUrl(navigatorEntry), 'navigator', navigatorEntry);
        if (token !== state.contextToken) return;
        imageUrl = context.url;
        miniImageUrl = navigator.url;
        bounds = contextEntry.bounds;
        miniBounds = navigatorEntry.bounds;
      }
      const overlay = L.imageOverlay(imageUrl, leafletBounds(bounds), { pane:'contextPane', opacity:state.contextOpacity, interactive:false, className:'context-raster' }).addTo(state.map);
      if (state.contextOverlay) state.map.removeLayer(state.contextOverlay);
      state.contextOverlay = overlay;
      state.contextVariantId = variantId;
      syncCompositeOpacity();
      const mini = L.imageOverlay(miniImageUrl, leafletBounds(miniBounds), { opacity:1, interactive:false, className:'context-raster' }).addTo(state.minimap);
      if (state.miniContextOverlay) state.minimap.removeLayer(state.miniContextOverlay);
      state.miniContextOverlay = mini;
      state.miniContextVariantId = miniVariantId;
      updateMiniViewport();
    } catch (error) {
      console.warn('Context load failed', error);
      removeContext();
    }
  }

  function removeContext() {
    ++state.contextToken;
    if (state.contextOverlay) state.map.removeLayer(state.contextOverlay);
    if (state.miniContextOverlay) state.minimap.removeLayer(state.miniContextOverlay);
    state.contextOverlay = state.miniContextOverlay = null;
    state.contextVariantId = state.miniContextVariantId = null;
  }

  function artifactUrl(entry) {
    return `${API}/artifacts/${state.snapshotId}/${encodeURIComponent(entry.file)}`;
  }

  function leafletBounds(bounds) {
    return L.latLngBounds([bounds.minZ, bounds.minX], [bounds.maxZ, bounds.maxX]);
  }

  async function coloredImage(url, paletteName, layer = null) {
    const cacheKey = `${url}|${paletteName}`;
    if (state.coloredImages.has(cacheKey)) return state.coloredImages.get(cacheKey);
    let raw = state.rawImages.get(url);
    if (!raw) {
      const fetchStarted = performance.now();
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Image request failed (${response.status})`);
      const blob = await response.blob();
      const fetchedAt = performance.now();
      const bitmap = await createImageBitmap(blob);
      raw = { bitmap, bytes: blob.size, fetchMs: fetchedAt - fetchStarted };
      state.rawImages.set(url, raw);
    }
    const colorStarted = performance.now();
    const canvas = document.createElement('canvas');
    canvas.width = raw.bitmap.width;
    canvas.height = raw.bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(raw.bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const ramp = palettes[paletteName] || palettes.ember;
    const focused = paletteName !== 'context' && paletteName !== 'navigator';
    const toneFocus = focused ? analysisScaleFocus(layer?.cellSize) : 0;
    const toneExponent = focused ? analysisToneExponent(layer?.cellSize) : 1;
    const robustToneCap = focused ? occupiedToneCap(pixels.data) : 1;
    const toneCap = 1-(1-robustToneCap)*toneFocus;
    for (let i = 0; i < pixels.data.length; i += 4) {
      if (pixels.data[i+3] === 0) continue;
      const encoded = pixels.data[i] / 255;
      const tone = focused ? analysisTone(encoded, toneCap, toneExponent) : encoded;
      const [r,g,b] = rampColor(ramp, tone);
      pixels.data[i] = r; pixels.data[i+1] = g; pixels.data[i+2] = b; pixels.data[i+3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const displayScale = focused && canvas.width*canvas.height <= ANALYSIS_DISPLAY_SCALE_MAX_PIXELS
      ? (Number(layer?.cellSize) === 320 ? ANALYSIS_SETTLEMENT_DISPLAY_SCALE : ANALYSIS_DISPLAY_SCALE)
      : 1;
    let outputCanvas = canvas;
    if (displayScale > 1) {
      outputCanvas = document.createElement('canvas');
      outputCanvas.width = canvas.width*displayScale;
      outputCanvas.height = canvas.height*displayScale;
      const outputContext = outputCanvas.getContext('2d');
      outputContext.imageSmoothingEnabled = false;
      outputContext.drawImage(canvas, 0, 0, outputCanvas.width, outputCanvas.height);
    }
    const blob = await new Promise(resolve => outputCanvas.toBlob(resolve, 'image/png'));
    const result = { url: URL.createObjectURL(blob), bytes: raw.bytes, fetchMs: raw.fetchMs,
      colorMs: performance.now() - colorStarted, toneCap, toneFocus, toneExponent, displayScale,
      sourceWidth: canvas.width, sourceHeight: canvas.height };
    state.coloredImages.set(cacheKey, result);
    return result;
  }

  function rampColor(ramp, t) {
    let right = ramp.findIndex(stop => t <= stop[0]);
    if (right <= 0) return ramp[0][1];
    if (right < 0) return ramp[ramp.length - 1][1];
    const [aT,a] = ramp[right-1], [bT,b] = ramp[right];
    const u = (t-aT) / Math.max(.0001, bT-aT);
    return a.map((value,index) => Math.round(value + (b[index]-value)*u));
  }

  function occupiedToneCap(data) {
    const histogram = new Uint32Array(256);
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i+3] === 0) continue;
      histogram[data[i]]++;
      total++;
    }
    return toneCapFromHistogram(histogram,total);
  }

  function toneCapFromHistogram(histogram,total) {
    if (!total) return 1;
    const target = Math.max(1,Math.floor((total-1)*ANALYSIS_TONE_PERCENTILE)+1);
    let seen = 0;
    for (let value = 0; value < histogram.length; value++) {
      seen += histogram[value];
      if (seen >= target) return Math.max(.25,value/255);
    }
    return 1;
  }

  function analysisTone(t, cap = 1, exponent = ANALYSIS_TONE_EXPONENT) {
    return Math.pow(Math.max(0, Math.min(1, t/Math.max(.01,cap))), exponent);
  }

  async function crossfade(oldOverlay, newOverlay, targetOpacity) {
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : Math.max(0, Number($('crossfade-ms').value));
    if (!duration) {
      newOverlay.setOpacity(targetOpacity);
      if (oldOverlay) state.map.removeLayer(oldOverlay);
      return;
    }
    const oldOpacity = oldOverlay ? Number(oldOverlay.options.opacity ?? state.analysisOpacity) : 0;
    const started = performance.now();
    await new Promise(resolve => {
      const frame = now => {
        const t = Math.min(1, (now-started)/duration);
        newOverlay.setOpacity(targetOpacity*t);
        if (oldOverlay) oldOverlay.setOpacity(oldOpacity*(1-t));
        if (t < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
    if (oldOverlay) state.map.removeLayer(oldOverlay);
  }

  function updateLegend(entry, lens, toneCap = 1, toneFocus = 1,
      toneExponent = analysisToneExponent(entry?.cellSize)) {
    $('legend').hidden = false;
    $('legend-title').textContent = PUBLIC_MODE ? 'Construction intensity' : `${lens.label} per ${entry.cellSize} m cell`;
    $('legend-gradient').className = `legend-gradient ${state.palette}`;
    const capped = Number(toneCap) < .9999;
    const fullyFocused = Number(toneFocus) >= .9999;
    const overviewTone = Number(toneExponent) > ANALYSIS_TONE_EXPONENT+.001;
    const legendMode = $('legend').querySelector('.legend-heading span');
    legendMode.textContent = overviewTone ? 'OVERVIEW LOG'
      : !capped ? 'MAX LOG' : fullyFocused ? `${ANALYSIS_TONE_LABEL} LOG` : 'SCALE LOG';
    legendMode.title = overviewTone
      ? 'This coarse overview uses a quieter contrast curve so large cells identify regions without flooding them with hotspot color.'
      : !capped
      ? 'This overview is anchored to the absolute layer maximum so large cells do not overstate hotspot area.'
      : fullyFocused
      ? 'The brightest color begins at the occupied-cell 99.5th percentile; higher outliers share the capped color.'
      : 'Scale-locked focus gradually introduces the P99.5 detail cap as cell size decreases.';
    $('legend').dataset.toneCap = Number(toneCap).toFixed(4);
    $('legend').dataset.toneExponent = Number(toneExponent).toFixed(4);
    if (PUBLIC_MODE) {
      $('legend-ticks').innerHTML = '<span>Quiet</span><span>Busy</span>';
      return;
    }
    const stops = [0,.25,.5,.75,1];
    const ticks = stops.map(stop => Math.round(Math.expm1(Number(entry.maxLog || 1)*Number(toneCap)*Math.pow(stop,1/toneExponent))));
    $('legend-ticks').innerHTML = ticks.map((tick,index) =>
      `<span>${fmt(tick)}${capped && index === ticks.length-1 ? '+' : ''}</span>`).join('');
  }

  function rasterGuidance(entry, lens, fallback) {
    const size = Number(entry.cellSize);
    const finerSizes = [...new Set((state.manifest?.layers || [])
      .filter(layer => layer.lensId === entry.lensId && Number(layer.cellSize) < size)
      .map(layer => Number(layer.cellSize)))].sort((a,b) => b-a);
    const nextSize = finerSizes[0];
    const hottest = `Hottest ${size} m cell: ${fmt(entry.maxRaw)}.`;
    if (PUBLIC_MODE) {
      if (size >= 1000) return {
        title: 'Find where the community has built',
        copy: 'Brighter areas show stronger concentrations of construction. Scroll toward a settlement, or inspect any area.',
        action: { type:'inspect', label:'Inspect an area' }
      };
      if (size >= 320) return {
        title: 'Settlement regions are taking shape',
        copy: 'Scroll closer to see their structure, or inspect an area to learn what is there.',
        action: { type:'inspect', label:'Inspect an area' }
      };
      if (size > 64) return {
        title: 'Districts are coming into view',
        copy: 'Follow a bright cluster closer, or inspect an area to see what makes it stand out.',
        action: { type:'inspect', label:'Inspect an area' }
      };
      if (size >= 64) return {
        title: 'Neighborhood patterns are visible',
        copy: 'Inspect any area to count and explain what the community built there.',
        action: { type:'inspect', label:'Inspect an area' }
      };
      return {
        title: 'Explore individual neighborhoods',
        copy: 'Inspect an area to understand what is here, or keep scrolling to reveal individual objects.',
        action: { type:'inspect', label:'Inspect an area' }
      };
    }
    if (size >= 1000) return {
      title: `World overview · ${lens.label}`,
      copy: `Bright cells are the strongest concentrations. Scroll toward one for ${nextSize || 320} m structure, or inspect any region now. ${hottest}${fallback}`,
      action: { type:'inspect', label:'Inspect an area' }
    };
    if (size >= 320) return {
      title: `Continental pattern · ${lens.label}`,
      copy: `Compare the large settlement regions. Scroll toward a bright cluster for ${nextSize || 64} m districts, or inspect one now. ${hottest}${fallback}`,
      action: { type:'inspect', label:'Inspect an area' }
    };
    if (size > 64) return {
      title: `District pattern · ${lens.label}`,
      copy: `Large blocks are resolving into neighborhoods. Scroll toward a bright cluster for ${nextSize || 64} m structure, or inspect one now. ${hottest}${fallback}`,
      action: { type:'inspect', label:'Inspect an area' }
    };
    if (size >= 64) return {
      title: `Regional pattern · ${lens.label}`,
      copy: `Settlement shape is visible now. Draw a green area to count and explain it, or zoom farther for ${nextSize || 16} m detail. ${hottest}${fallback}`,
      action: { type:'inspect', label:'Inspect an area' }
    };
    return {
      title: `Neighborhood pattern · ${lens.label}`,
      copy: `These ${size} m cells are queryable now. Draw a green area to count and explain it; zoom closer only when you want every position. ${hottest}${fallback}`,
      action: { type:'inspect', label:'Inspect an area' }
    };
  }

  function setStory(kind, title, copy, action = null) {
    const config = action === true ? { type:'render', label:'Render this lens' } : action;
    state.storyAction = config || null;
    $('map-story').className = `map-story ${kind || ''}`;
    $('story-title').textContent = title;
    $('story-copy').textContent = copy;
    $('story-action').hidden = !config;
    syncStoryAction();
  }

  function syncStoryAction() {
    const button = $('story-action');
    const action = state.storyAction;
    if (!action) { syncSelectionAction(); return; }
    const active = action.type === state.tool && (action.type === 'box' || action.type === 'inspect');
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.textContent = active ? (action.type === 'box' ? 'Drag on map…' : 'Drag an area…') : action.label;
    syncSelectionAction();
  }

  function syncSelectionAction() {
    const button = $('story-selection-action');
    const hasSelection = Boolean(state.currentScopeBounds) && !$('inspect-content').hidden;
    button.hidden = !hasSelection;
    if (!hasSelection) return;
    const showing = state.exactScope === 'selection' || state.exactScope === 'biome-selection';
    button.disabled = state.selectionItemsLoading || state.currentSelectionPositionCount == null;
    button.classList.toggle('active',showing);
    button.setAttribute('aria-pressed', String(showing));
    button.textContent = state.selectionItemsLoading ? 'Loading items…' : showing ? 'Hide items' : 'Show items';
    button.title = state.currentSelectionPositionCount == null
      ? 'Waiting for the selection count.'
      : state.currentSelectionPositionCount > EXACT_POINT_LIMIT
      ? state.viewMode === 'biomes'
        ? `${fmt(state.currentSelectionPositionCount)} item positions match; show a representative ${fmt(EXACT_POINT_LIMIT)} on the map.`
        : `${fmt(state.currentSelectionPositionCount)} item positions are selected; tighten the green area below ${fmt(EXACT_POINT_LIMIT)} to draw them.`
      : `Draw the ${fmt(state.currentSelectionPositionCount)} selected item position${state.currentSelectionPositionCount === 1 ? '' : 's'} on the map.`;
  }

  function updateMiniViewport() {
    if (!state.map || !state.minimap) return;
    const bounds = state.map.getBounds();
    const world = state.bootstrap.worldBounds;
    const visible = L.latLngBounds(
      [Math.max(world.minZ,bounds.getSouth()), Math.max(world.minX,bounds.getWest())],
      [Math.min(world.maxZ,bounds.getNorth()), Math.min(world.maxX,bounds.getEast())]
    );
    if (state.miniViewport) state.miniViewport.setBounds(visible);
    else state.miniViewport = L.rectangle(visible, { className:'mini-viewport', color:'#e8c15e', weight:2, fillOpacity:.06, interactive:false }).addTo(state.minimap);
    const visibleArea = Math.max(0, visible.getEast()-visible.getWest()) * Math.max(0, visible.getNorth()-visible.getSouth());
    const worldArea = (world.maxX-world.minX)*(world.maxZ-world.minZ);
    const viewportPct = Math.min(100, visibleArea/worldArea*100);
    const viewportText = viewportPct > 0 && viewportPct < .1 ? '<0.1%' : `${viewportPct.toFixed(1)}%`;
    $('viewport-label').textContent = `${viewportText} · z${state.map.getZoom().toFixed(2)}`;
  }

  function setTool(tool) {
    cancelDrawing();
    state.tool = tool;
    if (tool === 'pan') state.map.dragging.enable(); else state.map.dragging.disable();
    state.map.getContainer().classList.toggle('map-pan-ready', tool === 'pan');
    state.panGestureActive = false;
    document.body.classList.remove('map-pan-active');
    document.querySelectorAll('#tool-buttons button').forEach(button => button.classList.toggle('active', button.dataset.tool === tool));
    $('tool-state').textContent = tool.toUpperCase();
    $('coords').textContent = `${tool.toUpperCase()} · move for coordinates · Shift+drag box zoom`;
    syncStoryAction();
    if (tool === 'inspect' && !PUBLIC_MODE) showRightPanel('inspect');
  }

  function startDrawing(event) {
    const original = event.originalEvent;
    const mode = original.shiftKey ? 'box' : state.tool;
    if (original.button !== 0 || mode === 'pan') return;
    state.drawing = true;
    state.drawStart = event.latlng;
    state.drawMode = mode;
    if (state.drawRect) state.map.removeLayer(state.drawRect);
    const isBox = mode === 'box';
    state.boxGestureActive = isBox;
    if (isBox) {
      document.body.classList.add('box-zoom-active');
      $('coords').textContent = 'BOX ZOOM · release to fit the gold window';
    }
    state.drawRect = L.rectangle([event.latlng,event.latlng], {
      pane:'selectionPane', className:isBox ? 'box-zoom-rectangle' : 'selection-rectangle',
      renderer:state.selectionRenderer, interactive:false,
      color:isBox ? '#f3cf69' : '#70d29a', fillColor:isBox ? '#f3cf69' : '#70d29a',
      dashArray:isBox ? '7,5' : null, weight:isBox ? 2 : 1, fillOpacity:isBox ? .1 : .12
    }).addTo(state.map);
    L.DomEvent.preventDefault(original);
  }

  function finishDrawing(event) {
    if (!state.drawing || !state.drawRect) return;
    const mode = state.drawMode;
    const bounds = state.drawRect.getBounds();
    const width = Math.abs(bounds.getEast()-bounds.getWest());
    const height = Math.abs(bounds.getNorth()-bounds.getSouth());
    const startPoint = state.map.latLngToContainerPoint(state.drawStart);
    const endPoint = state.map.latLngToContainerPoint(event.latlng);
    const isClick = Math.abs(endPoint.x-startPoint.x) < 8 || Math.abs(endPoint.y-startPoint.y) < 8;
    state.ignoreClickUntil = performance.now() + 250;
    if (isClick) {
      cancelDrawing();
      if (mode === 'inspect') inspectCell(event.latlng);
      else toast('Drag a larger gold window to zoom');
      return;
    }
    if (mode === 'box') {
      state.map.fitBounds(bounds, { padding:[24,24], animate:!matchMedia('(prefers-reduced-motion: reduce)').matches });
      cancelDrawing();
      toast(`Box zoom · ${fmt(width)} × ${fmt(height)} m`);
    } else {
      inspectBounds(bounds);
      cancelDrawing();
    }
  }

  function cancelDrawing() {
    state.drawing = false;
    state.drawStart = null;
    state.drawMode = null;
    state.boxGestureActive = false;
    document.body.classList.remove('box-zoom-active');
    if (state.drawRect && state.map) state.map.removeLayer(state.drawRect);
    state.drawRect = null;
    if (state.map && state.tool === 'pan') state.map.dragging.enable();
  }

  function inspectCell(latlng) {
    if (!state.currentEntry || !isInsideGlobe(latlng)) return;
    const b = state.bootstrap.worldBounds;
    const size = Number(state.currentEntry.cellSize);
    const cx = Math.floor((latlng.lng-b.minX)/size);
    const cz = Math.floor((latlng.lat-b.minZ)/size);
    const minX = b.minX + cx*size, minZ = b.minZ + cz*size;
    inspectBounds(L.latLngBounds([minZ,minX],[Math.min(b.maxZ,minZ+size),Math.min(b.maxX,minX+size)]));
  }

  async function inspectBounds(bounds, options = {}) {
    bounds = clampToWorld(bounds);
    if (!bounds) {
      toast('Choose an area inside the published world');
      return;
    }
    const token = ++state.inspectToken;
    const drawArea = options.draw !== false;
    const returnToPan = state.tool === 'inspect';
    if (state.exactScope === 'selection' || state.exactScope === 'biome-selection' || state.exactScope === 'biome-viewport') removeExactMarkers();
    state.currentSelectionBounds = drawArea ? bounds : null;
    state.currentScopeBounds = bounds;
    state.currentSelectionPositionCount = null;
    state.selectionItemsLoading = false;
    state.itemPageCursors = [null];
    state.itemPageIndex = 0;
    state.itemNextCursor = null;
    ++state.itemToken;
    syncSelectionAction();
    if (state.selectionRect) state.map.removeLayer(state.selectionRect);
    state.selectionRect = drawArea
      ? L.rectangle(bounds, { pane:'selectionPane', renderer:state.selectionRenderer, className:'selection-rectangle', color:'#70d29a', weight:2, fillOpacity:.1 }).addTo(state.map)
      : null;
    if (state.miniSelectionRect) state.minimap.removeLayer(state.miniSelectionRect);
    state.miniSelectionRect = drawArea
      ? L.rectangle(bounds, { color:'#70d29a', weight:1, fillOpacity:.08, interactive:false }).addTo(state.minimap)
      : null;
    $('inspect-empty').hidden = true;
    $('inspect-content').hidden = false;
    $('inspect-tab-state').textContent = 'QUERYING';
    showRightPanel('inspect');
    $('inspector').scrollTop = 0;
    if (returnToPan) {
      setTool('pan');
      toast('Inspection pinned · drag to pan');
    }
    const query = scopedQuery(bounds);
    $('inspect-bounds').textContent = drawArea ? boundsLabel(bounds) : `Territories · ${selectedBiomeSummary()}`;
    $('inspect-title').textContent = PUBLIC_MODE
      ? drawArea ? 'What was built here?' : `What was built in ${selectedBiomeSummary()}?`
      : `Explaining ${state.lensById.get(state.lensId)?.label || state.lensId}`;
    $('inspect-zoom').hidden = !drawArea;
    $('inspect-clear-area').hidden = !drawArea || state.viewMode !== 'biomes';
    $('inspect-total').textContent = $('inspect-share').textContent = $('inspect-density').textContent = '…';
    $('inspect-point-warning').hidden = true;
    $('inspect-ranked-label').textContent = 'WHAT MAKES IT BRIGHT · TOP TYPES';
    $('inspect-show-all').hidden = true;
    $('inspect-top').innerHTML = '<div class="rank-row"><span>Scanning selected bounds…</span></div>';
    $('inspect-items-range').textContent = 'LOADING';
    $('inspect-items-list').innerHTML = '<div class="inspect-item-empty">Loading individual objects…</div>';
    $('inspect-items-prev').disabled = $('inspect-items-next').disabled = true;
    const started = performance.now();
    try {
      const result = await fetchJson(`${API}/selection?snapshot=${state.snapshotId}&lens=${encodeURIComponent(state.lensId)}&topN=10&${query}`);
      if (token !== state.inspectToken) return;
      const elapsed = performance.now()-started;
      $('inspect-query-time').textContent = `${elapsed.toFixed(0)} ms`;
      $('inspect-total').textContent = fmt(result.total);
      $('inspect-units').textContent = result.units;
      $('inspect-share').textContent = `${Number(result.worldSharePct).toFixed(result.worldSharePct < 1 ? 2 : 1)}%`;
      $('inspect-density').textContent = fmt(result.densityPerSquareKm);
      $('inspect-tab-state').textContent = `${fmt(result.total)} ${result.units}`.toUpperCase();
      state.currentSelectionPositionCount = Number(result.positionCount ?? result.total);
      syncSelectionAction();
      const pointWarning = $('inspect-point-warning');
      pointWarning.hidden = state.currentSelectionPositionCount <= EXACT_POINT_LIMIT;
      const positionSubject = state.currentSelectionPositionCount === Number(result.total)
        ? `${fmt(result.total)} ${result.units}`
        : `${fmt(state.currentSelectionPositionCount)} item positions representing ${fmt(result.total)} ${result.units}`;
      pointWarning.textContent = pointWarning.hidden ? '' : PUBLIC_MODE
        ? state.viewMode === 'biomes'
          ? `${positionSubject} match this biome scope. The map shows a representative ${fmt(EXACT_POINT_LIMIT)}; page through every object below.`
          : `${positionSubject} are inside this area. Page through every object below, or inspect a smaller area to draw every item on the map.`
        : `${positionSubject} are inside this area. This summary is complete; exact dots stay hidden above ${fmt(EXACT_POINT_LIMIT)} positions.`;
      renderInspectionRanks(result,false);
      loadItemPage(null, true);
      if (state.viewMode === 'biomes') loadBiomeSample(bounds);
    } catch (error) {
      if (token !== state.inspectToken) return;
      $('inspect-tab-state').textContent = 'QUERY FAILED';
      $('inspect-point-warning').hidden = true;
      $('inspect-top').innerHTML = `<div class="rank-row"><span>${escapeHtml(error.message)}</span></div>`;
      $('inspect-items-range').textContent = 'UNAVAILABLE';
      $('inspect-items-list').innerHTML = '<div class="inspect-item-empty">The object list could not be loaded.</div>';
    }
  }

  function renderInspectionRanks(result, expanded) {
    const items = result.top || [];
    const categoryCount = Number(result.categoryCount ?? items.length);
    const max = Math.max(1,...items.map(item => item.value));
    $('inspect-ranked-label').textContent = categoryCount
      ? `WHAT MAKES IT BRIGHT · ${expanded || result.completeCategories ? 'ALL' : `TOP ${items.length} OF`} ${fmt(categoryCount)} TYPES`
      : 'WHAT MAKES IT BRIGHT · NO TYPES';
    $('inspect-top').innerHTML = items.length ? items.map(item =>
      `<div class="rank-row"><span>${escapeHtml(item.label)}</span><span>${fmt(item.value)}</span><div class="rank-bar"><i style="width:${item.value/max*100}%"></i></div></div>`).join('')
      : '<div class="rank-row"><span>No objects from this lens are inside the selection.</span></div>';
    const showAll = $('inspect-show-all');
    showAll.hidden = expanded || Boolean(result.completeCategories) || categoryCount <= items.length;
    showAll.disabled = false;
    showAll.textContent = `Show all ${fmt(categoryCount)} types in selection`;
  }

  async function loadItemPage(cursor, reset = false) {
    const bounds = state.currentScopeBounds;
    if (!bounds) return;
    if (reset) {
      state.itemPageCursors = [null];
      state.itemPageIndex = 0;
      state.itemNextCursor = null;
    }
    const token = ++state.itemToken;
    const pageSize = 100;
    $('inspect-items-range').textContent = 'LOADING';
    $('inspect-items-list').innerHTML = '<div class="inspect-item-empty">Loading individual objects…</div>';
    $('inspect-items-prev').disabled = $('inspect-items-next').disabled = true;
    try {
      const extras = { limit:String(pageSize) };
      if (cursor) extras.cursor = cursor;
      const result = await fetchJson(`${API}/items?snapshot=${state.snapshotId}&lens=${encodeURIComponent(state.lensId)}&${scopedQuery(bounds, extras)}`);
      if (token !== state.itemToken) return;
      const items = result.items || [];
      state.itemNextCursor = result.nextCursor || null;
      const start = items.length ? state.itemPageIndex * pageSize + 1 : 0;
      const end = items.length ? start + items.length - 1 : 0;
      $('inspect-items-range').textContent = items.length
        ? `${fmt(start)}–${fmt(end)} OF ${fmt(result.total)}` : `0 OF ${fmt(result.total)}`;
      $('inspect-items-list').innerHTML = items.length ? items.map(item => {
        const biome = state.biomeCatalog.find(candidate => candidate.id === item.biome);
        return `<button type="button" class="inspect-item" data-item-x="${Number(item.x)}" data-item-z="${Number(item.z)}" style="--biome-color:${escapeHtml(biome?.color || '#b3bac5')}"><strong>${escapeHtml(item.label)}</strong><span class="inspect-item-biome">${escapeHtml(biome?.label || item.biome || 'Mountains + Forest')}</span><span class="inspect-item-coords">X ${Math.round(item.x).toLocaleString()} · Z ${Math.round(item.z).toLocaleString()}</span></button>`;
      }).join('') : '<div class="inspect-item-empty">No objects match this biome and area scope.</div>';
      $('inspect-items-prev').disabled = state.itemPageIndex === 0;
      $('inspect-items-next').disabled = !result.hasMore;
    } catch (error) {
      if (token !== state.itemToken) return;
      $('inspect-items-range').textContent = 'UNAVAILABLE';
      $('inspect-items-list').innerHTML = `<div class="inspect-item-empty">${escapeHtml(error.message)}</div>`;
      $('inspect-items-prev').disabled = state.itemPageIndex === 0;
    }
  }

  function nextItemPage() {
    if (!state.itemNextCursor) return;
    state.itemPageIndex += 1;
    state.itemPageCursors[state.itemPageIndex] = state.itemNextCursor;
    loadItemPage(state.itemNextCursor);
  }

  function previousItemPage() {
    if (state.itemPageIndex === 0) return;
    state.itemPageIndex -= 1;
    loadItemPage(state.itemPageCursors[state.itemPageIndex] || null);
  }

  function focusItem(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const destination = worldToLatLng(x, z);
    state.map.setView(destination, Math.max(state.map.getZoom(), -.25), { animate:true });
    const marker = L.circleMarker(destination, {
      pane:'selectionPane', renderer:state.selectionRenderer, radius:9, color:'#ffe08a', weight:3,
      fillColor:'#ffe08a', fillOpacity:.16, interactive:false
    }).addTo(state.map);
    setTimeout(() => state.map?.removeLayer(marker), 2400);
  }

  async function loadAllSelectionCategories() {
    const bounds = state.currentScopeBounds;
    if (!bounds) return;
    const token = ++state.inspectToken;
    const button = $('inspect-show-all');
    button.disabled = true;
    button.textContent = 'Loading every type…';
    const started = performance.now();
    try {
      const result = await fetchJson(`${API}/selection?snapshot=${state.snapshotId}&lens=${encodeURIComponent(state.lensId)}&topN=0&${scopedQuery(bounds)}`);
      if (token !== state.inspectToken) return;
      $('inspect-query-time').textContent = `${(performance.now()-started).toFixed(0)} ms`;
      renderInspectionRanks(result,true);
      toast(`${fmt(result.categoryCount)} item types in this selection`);
    } catch (error) {
      if (token !== state.inspectToken) return;
      button.disabled = false;
      button.textContent = 'Show all in selection';
      toast(`Could not load every type · ${error.message}`);
    }
  }

  function boundsQuery(bounds) {
    return scopedQuery(bounds);
  }

  function clampToWorld(bounds) {
    const west = Math.max(bounds.getWest(), state.worldBounds.getWest());
    const east = Math.min(bounds.getEast(), state.worldBounds.getEast());
    const south = Math.max(bounds.getSouth(), state.worldBounds.getSouth());
    const north = Math.min(bounds.getNorth(), state.worldBounds.getNorth());
    return west < east && south < north ? L.latLngBounds([south, west], [north, east]) : null;
  }

  function boundsLabel(bounds) {
    return `X ${Math.round(bounds.getWest())} → ${Math.round(bounds.getEast())} · Z ${Math.round(bounds.getSouth())} → ${Math.round(bounds.getNorth())}`;
  }

  async function toggleSelectionItems() {
    const bounds = state.currentScopeBounds;
    if (!bounds) return;
    if (state.exactScope === 'selection' || state.exactScope === 'biome-selection') {
      removeExactMarkers();
      if (state.viewMode === 'biomes') {
        state.biomeAutoPointsSuppressed = true;
        $('exact-state').textContent = 'OUTLINES';
      } else $('exact-state').textContent = 'RASTER';
      syncCompositeOpacity();
      updateDetailLadder();
      if (state.viewMode !== 'biomes') scheduleExactPoints();
      toast('Selected items hidden');
      return;
    }
    if (state.viewMode === 'biomes') {
      await loadBiomeSample(bounds);
      return;
    }
    clearTimeout(state.exactTimer);
    const token = ++state.exactToken;
    state.exactEnabled = true;
    $('exact-toggle').checked = true;
    state.selectionItemsLoading = true;
    syncSelectionAction();
    const started = performance.now();
    try {
      const result = await fetchJson(`${API}/points?snapshot=${state.snapshotId}&lens=${encodeURIComponent(state.lensId)}&limit=${EXACT_POINT_LIMIT}&${boundsQuery(bounds)}`);
      if (token !== state.exactToken) return;
      state.metrics.exact = performance.now()-started;
      const lens = state.lensById.get(state.lensId);
      if (result.truncated) {
        removeExactMarkers();
        const positionCount = state.currentSelectionPositionCount || result.minimumCount;
        $('exact-state').textContent = `> ${fmt(result.limit)} SELECTED · RASTER`;
        const warning = $('inspect-point-warning');
        warning.hidden = false;
        warning.textContent = PUBLIC_MODE
          ? `${fmt(positionCount)} items are inside this area. Zoom closer or inspect a smaller area to show them all.`
          : `${fmt(positionCount)} item positions are inside this area. The selection summary is complete; tighten the green area below ${fmt(result.limit)} to draw every item.`;
        toast(PUBLIC_MODE
          ? `${fmt(positionCount)} items · choose a smaller area to show them`
          : `${fmt(positionCount)} positions · tighten the green area to show items`);
        return;
      }
      installPointMarkers(result.points,lens,'selection');
      $('exact-state').textContent = `${fmt(result.points.length)} SELECTED POINTS`;
      toast(`${fmt(result.points.length)} selected item position${result.points.length === 1 ? '' : 's'} shown`);
      updateMetrics();
    } catch (error) {
      if (token !== state.exactToken) return;
      toast(`Could not show selected items · ${error.message}`);
    } finally {
      if (token === state.exactToken) {
        state.selectionItemsLoading = false;
        syncSelectionAction();
      }
    }
  }

  function scheduleExactPoints() {
    clearTimeout(state.exactTimer);
    if (state.viewMode === 'terrain') return;
    if (state.viewMode === 'biomes' && state.exactScope === 'biome-selection') return;
    state.exactTimer = setTimeout(state.viewMode === 'biomes' ? loadBiomeViewportPoints : loadExactPoints, 220);
  }

  function pauseExactPoints() {
    clearTimeout(state.exactTimer);
    if (state.viewMode === 'biomes') {
      if (state.exactScope === 'biome-viewport') {
        ++state.exactToken;
        removeExactMarkers();
        $('exact-state').textContent = 'OUTLINES';
      }
      document.body.classList.add('map-view-moving');
      return;
    }
    const hadCloseDetail = Boolean(state.exactLayer || state.detailOverlay);
    ++state.exactToken;
    removeExactMarkers();
    syncCompositeOpacity();
    updateDetailLadder();
    document.body.classList.add('map-view-moving');
    if (hadCloseDetail) $('exact-state').textContent = state.detailResolution
      ? `MOVING · ${state.detailResolution} M HELD` : 'MOVING';
  }

  function desiredLocalDetailResolution() {
    return state.map.getZoom() >= Number($('threshold-detail4').value) ? 4 : 8;
  }

  function localDetailBounds(bounds, cellSize) {
    const world = state.bootstrap.worldBounds;
    const west = Math.max(world.minX, world.minX + Math.floor((bounds.getWest()-world.minX)/cellSize)*cellSize);
    const east = Math.min(world.maxX, world.minX + Math.ceil((bounds.getEast()-world.minX)/cellSize)*cellSize);
    const south = Math.max(world.minZ, world.minZ + Math.floor((bounds.getSouth()-world.minZ)/cellSize)*cellSize);
    const north = Math.min(world.maxZ, world.minZ + Math.ceil((bounds.getNorth()-world.minZ)/cellSize)*cellSize);
    return L.latLngBounds([south,west],[north,east]);
  }

  async function createLocalDetail(points, bounds, cellSize) {
    const width = Math.max(1, Math.ceil((bounds.getEast()-bounds.getWest())/cellSize));
    const height = Math.max(1, Math.ceil((bounds.getNorth()-bounds.getSouth())/cellSize));
    if (width*height > 1_500_000) throw new Error(`Local detail window is too large (${width}x${height})`);
    const cells = new Float64Array(width*height);
    let maxRaw = 0;
    for (const point of points) {
      const x = Math.floor((Number(point.x)-bounds.getWest())/cellSize);
      const z = Math.floor((Number(point.z)-bounds.getSouth())/cellSize);
      if (x < 0 || x >= width || z < 0 || z >= height) continue;
      const index = (height-1-z)*width+x;
      cells[index] += Math.max(0, Number(point.value ?? 1));
      maxRaw = Math.max(maxRaw, cells[index]);
    }
    const maxLog = Math.max(1, Math.log1p(maxRaw));
    const histogram = new Uint32Array(256);
    let occupied = 0;
    for (let index = 0; index < cells.length; index++) {
      if (cells[index] <= 0) continue;
      const encoded = Math.max(1,Math.min(255,Math.round(Math.log1p(cells[index])/maxLog*255)));
      histogram[encoded]++;
      occupied++;
    }
    const toneCap = toneCapFromHistogram(histogram,occupied);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(width,height);
    const ramp = palettes[state.palette] || palettes.ember;
    for (let index = 0; index < cells.length; index++) {
      if (cells[index] <= 0) continue;
      const [r,g,b] = rampColor(ramp, analysisTone(Math.log1p(cells[index])/maxLog,toneCap));
      const offset = index*4;
      image.data[offset] = r; image.data[offset+1] = g; image.data[offset+2] = b; image.data[offset+3] = 255;
    }
    context.putImageData(image,0,0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
    if (!blob) throw new Error('Could not encode local detail surface');
    return { url:URL.createObjectURL(blob), bytes:blob.size, bounds, cellSize, width, height, maxRaw, maxLog, toneCap };
  }

  async function installLocalDetail(detail, lens, token) {
    const candidate = L.imageOverlay(detail.url, detail.bounds, {
      pane:'detailPane', opacity:0, interactive:false, className:'local-detail-raster'
    });
    const loaded = new Promise(resolve => {
      const timer = setTimeout(() => resolve(false),1500);
      candidate.once('load', () => { clearTimeout(timer); resolve(true); });
      candidate.once('error', () => { clearTimeout(timer); resolve(false); });
    });
    candidate.addTo(state.map);
    const ready = await loaded;
    if (!ready || token !== state.exactToken) {
      state.map.removeLayer(candidate);
      URL.revokeObjectURL(detail.url);
      return false;
    }
    const previousOverlay = state.detailOverlay;
    const previousUrl = state.detailObjectUrl;
    if (previousOverlay) previousOverlay.setOpacity(0);
    state.detailOverlay = candidate;
    state.detailObjectUrl = detail.url;
    state.detailResolution = detail.cellSize;
    syncCompositeOpacity();
    if (previousOverlay) state.map.removeLayer(previousOverlay);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    updateLegend(detail,lens,detail.toneCap,1);
    $('scale-state').textContent = `AUTO \u2192 ${detail.cellSize} M LOCAL`;
    $('map-status').textContent = `${lens.label} \u00b7 ${detail.cellSize} m local cells + exact objects \u00b7 snapshot #${state.snapshotId} \u00b7 ${state.palette}`;
    return true;
  }

  function removeLocalDetail() {
    if (state.detailOverlay && state.map) state.map.removeLayer(state.detailOverlay);
    if (state.detailObjectUrl) URL.revokeObjectURL(state.detailObjectUrl);
    state.detailOverlay = null;
    state.detailObjectUrl = null;
    state.detailResolution = null;
  }

  function updateDetailLadder() {
    const currentDetail = state.detailResolution ||
      (Number(state.currentEntry?.cellSize) === 16 ? 16 : null);
    document.querySelectorAll('#detail-ladder [data-detail]').forEach(step => {
      const detail = step.dataset.detail;
      const active = detail === 'points' ? Boolean(state.exactLayer)
        : currentDetail != null && Number(detail) === Number(currentDetail);
      step.classList.toggle('active',active);
    });
  }

  function syncCompositeOpacity() {
    const hasLocalDetail = Boolean(state.detailOverlay);
    const effectiveAnalysis = effectiveAnalysisOpacity();
    const showingHeatmap = state.viewMode === 'heatmap';
    const closeContextFactor = Number(state.bootstrap?.context?.closeDetailFactor ??
      (state.bootstrap?.contextAuthoritative ? .55 : .18));
    if (state.overlay) state.overlay.setOpacity(!showingHeatmap ? 0 : hasLocalDetail
      ? 0 : state.exactLayer ? effectiveAnalysis*.38 : effectiveAnalysis);
    if (state.detailOverlay) state.detailOverlay.setOpacity(showingHeatmap ? state.analysisOpacity : 0);
    const shownContextOpacity = !showingHeatmap ? BIOME_CONTEXT_OPACITY
      : hasLocalDetail ? state.contextOpacity*closeContextFactor : state.contextOpacity;
    if (state.contextOverlay) state.contextOverlay.setOpacity(shownContextOpacity);
    const requestedContext = Math.round(state.contextOpacity*100);
    const effectiveContext = Math.round(shownContextOpacity*100);
    const contextReceded = hasLocalDetail && effectiveContext < requestedContext;
    const contextPromoted = !showingHeatmap && effectiveContext > requestedContext;
    $('context-opacity-value').textContent = contextReceded || contextPromoted
      ? `${requestedContext}% → ${effectiveContext}%` : `${requestedContext}%`;
    $('context-opacity-value').title = contextPromoted
      ? 'Terrain and Biomes bring the map fully forward while the Heatmap is hidden.'
      : contextReceded
      ? 'Close detail is active; context has receded automatically. Hold peek to restore it.'
      : hasLocalDetail ? 'Terrain remains at the chosen opacity through close detail.' : '';
    const requestedAnalysis = Math.round(state.analysisOpacity*100);
    const shownAnalysis = Math.round((hasLocalDetail ? state.analysisOpacity : effectiveAnalysis)*100);
    $('analysis-opacity-value').textContent = requestedAnalysis === shownAnalysis
      ? `${shownAnalysis}%` : `${requestedAnalysis}% → ${shownAnalysis}%`;
    $('analysis-opacity-value').title = requestedAnalysis === shownAnalysis
      ? 'Analysis opacity at this zoom.'
      : `Overview presentation is ${shownAnalysis}% at this scale; the slider sets closer-detail opacity.`;
  }

  function restoreWorldRasterPresentation() {
    const entry = state.currentEntry;
    if (!entry || entry.lensId !== state.lensId) return;
    const lens = state.lensById.get(state.lensId);
    updateLegend(entry,lens,state.currentToneCap,state.currentToneFocus,state.currentToneExponent);
    $('scale-state').textContent = state.resolution === 'auto' ? `AUTO \u2192 ${entry.cellSize} M` : `${entry.cellSize} M`;
    $('map-status').textContent = `${lens.label} \u00b7 ${entry.cellSize} m cells \u00b7 snapshot #${state.snapshotId} \u00b7 ${state.palette}`;
  }

  async function loadExactPoints() {
    if (state.viewMode !== 'heatmap') return;
    const threshold = Number($('threshold-exact').value);
    if (!state.exactEnabled || !state.map || state.map.getZoom() < threshold || !state.currentEntry) {
      clearExactPoints(); return;
    }
    const token = ++state.exactToken;
    const detailResolution = desiredLocalDetailResolution();
    const bounds = localDetailBounds(state.map.getBounds(),detailResolution);
    const started = performance.now();
    try {
      const result = await fetchJson(`${API}/points?snapshot=${state.snapshotId}&lens=${encodeURIComponent(state.lensId)}&limit=${EXACT_POINT_LIMIT}&${boundsQuery(bounds)}`);
      if (token !== state.exactToken) return;
      const lens = state.lensById.get(state.lensId);
      state.metrics.exact = performance.now()-started;
      if (result.truncated) {
        clearExactPoints(false);
        restoreWorldRasterPresentation();
        $('exact-state').textContent = `> ${fmt(result.limit)} · RASTER`;
        setStory('warn', PUBLIC_MODE ? 'Zoom closer to reveal individual objects' : `At least ${fmt(result.minimumCount)} ${lens.units} in this viewport`,
          PUBLIC_MODE
            ? 'There is more here than can be shown clearly at once. Inspect any area now, or scroll closer.'
            : `The raster is complete. Draw a green area for its full count and explanation; zoom closer only when you want every position.`,
          { type:'inspect', label:'Inspect an area' });
        updateMetrics();
        return;
      }
      let detail = null;
      const detailStarted = performance.now();
      if (result.points.length) {
        try { detail = await createLocalDetail(result.points,bounds,detailResolution); }
        catch (error) { console.warn('Local detail surface failed',error); }
      }
      if (token !== state.exactToken) {
        if (detail?.url) URL.revokeObjectURL(detail.url);
        return;
      }
      if (detail) {
        const installed = await installLocalDetail(detail,lens,token);
        if (token !== state.exactToken) return;
        if (!installed) {
          detail = null;
          removeLocalDetail();
        }
      } else {
        removeLocalDetail();
      }
      state.metrics.detail = performance.now()-detailStarted;
      installPointMarkers(result.points,lens,'viewport');
      $('exact-state').textContent = `${result.points.length} POINTS \u00b7 ${detail ? `${detail.cellSize} M` : 'RASTER'}`;
      const exactTitle = PUBLIC_MODE
        ? result.points.length ? `${fmt(result.points.length)} objects in view` : 'No objects in view'
        : result.points.length ? `${fmt(result.points.length)} exact ${lens.units} in this viewport` : `No exact ${lens.units} in this viewport`;
      const exactCopy = PUBLIC_MODE
        ? 'Inspect a cluster to learn what it contains, or drag the map to keep exploring.'
        : detail
          ? `The ${detail.cellSize} m local density surface and these positions come from the same complete bounded query. Inspect a cluster or pan onward.`
          : `The ${state.currentEntry.cellSize} m raster has yielded to queryable object positions. Inspect a cluster or pan onward.`;
      setStory(result.points.length ? 'ready' : '', exactTitle, exactCopy,
        { type:'inspect', label:'Inspect an area' });
      updateMetrics();
    } catch (error) {
      if (token !== state.exactToken) return;
      $('exact-state').textContent = 'QUERY FAILED';
    }
  }

  function clearExactPoints(increment = true) {
    if (increment) ++state.exactToken;
    removeExactMarkers();
    removeLocalDetail();
    state.metrics.detail = null;
    syncCompositeOpacity();
    updateDetailLadder();
    restoreWorldRasterPresentation();
    $('exact-state').textContent = 'RASTER';
  }

  function installPointMarkers(points, lens, scope) {
    removeExactMarkers();
    if (!points.length) return;
    const group = L.layerGroup([], { pane:'exactPane' });
    for (const point of points) {
      L.circleMarker(worldToLatLng(point.x,point.z), {
        pane:'exactPane', renderer:state.exactRenderer, radius:4.2, weight:1.3, color:'#f5f7fb',
        fillColor:lens.accent, fillOpacity:1, opacity:.96
      }).bindTooltip(`${escapeHtml(point.label)} · ${fmt(point.value)}`).addTo(group);
    }
    state.exactLayer = group.addTo(state.map);
    state.exactScope = scope;
    syncCompositeOpacity();
    updateDetailLadder();
    syncSelectionAction();
  }

  function removeExactMarkers() {
    if (state.exactLayer && state.map) state.map.removeLayer(state.exactLayer);
    state.exactLayer = null;
    state.exactScope = null;
    syncSelectionAction();
  }

  async function submitRender(allLenses) {
    const resolutions = [...document.querySelectorAll('#job-resolutions input:checked')].map(input => Number(input.value));
    if (!resolutions.length) return toast('Choose at least one output resolution');
    const request = {
      snapshotId: Number(state.snapshotId),
      lensIds: allLenses ? state.lenses.map(lens => lens.id) : [state.lensId],
      resolutions,
      force: $('job-force').checked,
      simulatedDelayMs: Number($('job-delay').value),
      failAfterLayers: Number($('job-failure').value)
    };
    const layerCount = request.lensIds.length * request.resolutions.length;
    const lensLabel = allLenses ? 'all lenses' : state.lensById.get(state.lensId)?.label || state.lensId;
    const selectedButton = $('render-selected');
    const allButton = $('render-all');
    state.submittingJob = true;
    selectedButton.disabled = allButton.disabled = true;
    (allLenses ? allButton : selectedButton).textContent = 'Queueing…';
    state.lastJob = {
      id:`submitting-${Date.now()}`, status:'queued', elapsedMs:0,
      completedUnits:0, totalUnits:layerCount, phases:[], metrics:{},
      currentPhase:`Submitting ${lensLabel} · ${request.resolutions.join(' → ')} m`,
      logs:[`Submitting ${layerCount} full-world raster layer(s)`]
    };
    renderJob(state.lastJob);
    setStory('working', `Queueing ${lensLabel} raster job…`, `${layerCount} full-world layer${layerCount === 1 ? '' : 's'}. Live phases and timings are in the Job bench.`);
    focusJobActivity(false);
    try {
      state.lastJob = await fetchJson(`${API}/jobs/render`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(request) });
      renderJob(state.lastJob);
      setStory('working', `${lensLabel} job queued`, `${layerCount} full-world layer${layerCount === 1 ? '' : 's'} · job ${state.lastJob.id.slice(0,8)}. Watch the live phases at right.`);
      toast(`Job queued · ${lensLabel} · ${layerCount} layer${layerCount === 1 ? '' : 's'}`);
    } catch (error) {
      renderJob({ ...state.lastJob, status:'failed', error:error.message, currentPhase:null });
      setStory('error', 'Raster job was rejected', error.message);
      toast(`Job rejected: ${error.message}`);
    } finally {
      state.submittingJob = false;
      selectedButton.disabled = allButton.disabled = false;
      selectedButton.textContent = 'Render active lens';
      allButton.textContent = 'All lenses';
    }
  }

  async function pollJobs() {
    if (state.submittingJob) return;
    try {
      const jobs = await fetchJson(`${API}/jobs`);
      if (jobs.length) {
        const latest = jobs[0];
        const previousStatus = state.lastJob?.id === latest.id ? state.lastJob.status : null;
        state.lastJob = latest;
        renderJob(latest);
        if (latest.status === 'complete' && previousStatus !== 'complete' && state.lastCompletedJobId !== latest.id) {
          state.lastCompletedJobId = latest.id;
          await loadManifest();
          const outcome = jobOutcome(latest);
          toast(outcome.createdLayers
            ? `${outcome.createdLayers} new raster${outcome.createdLayers === 1 ? '' : 's'} created${outcome.cacheHits ? ` · ${outcome.cacheHits} cached` : ''}`
            : `${outcome.cacheHits} cached raster${outcome.cacheHits === 1 ? '' : 's'} reused · no generation needed`);
        }
        const activeJobs = jobs.filter(job => ['queued','running'].includes(job.status));
        if (activeJobs.length) setJobActivity(activeJobs.some(job => job.status === 'running') ? 'running' : 'queued', activeJobs.length);
      } else {
        setJobActivity('idle');
      }
    } catch (_) {}
  }

  function jobOutcome(job) {
    const phaseHits = (job.phases || []).filter(phase => /artifact hit/i.test(phase.name || '')).length;
    const cacheHits = Number(job.metrics?.cacheHits ?? phaseHits);
    const createdLayers = Number(job.metrics?.createdLayers ?? Math.max(0, Number(job.completedUnits || 0)-cacheHits));
    return { cacheHits, createdLayers };
  }

  function setJobActivity(status, count = 0) {
    const activity = $('job-activity');
    const navState = $('run-nav-state');
    const busy = ['queued','running'].includes(status);
    const failed = status === 'failed';
    const label = busy ? `${status.toUpperCase()}${count > 1 ? ` ${count}` : ''}` : failed ? 'FAILED' : 'IDLE';
    activity.textContent = `● ${label}`;
    activity.classList.toggle('busy', busy);
    activity.classList.toggle('failed', failed);
    navState.textContent = label.toLowerCase();
    navState.classList.toggle('busy', busy);
    navState.classList.toggle('failed', failed);
  }

  function focusJobActivity(log = false) {
    showRightPanel('jobs');
    const panel = $('job-bench-pane');
    const target = log ? $('job-log-card') : document.querySelector('.job-current');
    panel.scrollTo({ top:Math.max(0, target.offsetTop-34), behavior:'smooth' });
    target.classList.add('attention');
    setTimeout(() => target.classList.remove('attention'), 1200);
  }

  function showRightPanel(panel) {
    state.rightPanel = panel;
    const jobs = panel === 'jobs';
    $('job-bench-pane').hidden = !jobs;
    $('inspector').hidden = jobs;
    $('job-bench-tab').classList.toggle('active', jobs);
    $('inspect-panel-tab').classList.toggle('active', !jobs);
    $('job-bench-tab').setAttribute('aria-selected', String(jobs));
    $('inspect-panel-tab').setAttribute('aria-selected', String(!jobs));
    document.body.classList.toggle('inspection-open', PUBLIC_MODE && !jobs);
    requestAnimationFrame(() => state.map?.invalidateSize({ pan:false }));
  }

  function renderJob(job) {
    const status = String(job.status || 'idle').toUpperCase();
    const outcome = jobOutcome(job);
    const cachedOnly = job.status === 'complete' && outcome.cacheHits > 0 && outcome.createdLayers === 0;
    $('job-status').textContent = cachedOnly ? 'COMPLETE · CACHED' : status;
    $('job-status').style.color = job.status === 'complete' ? 'var(--green)' : job.status === 'failed' ? 'var(--red)' : job.status === 'running' ? 'var(--amber)' : '';
    $('job-clock').textContent = (Number(job.elapsedMs || 0)/1000).toFixed(3);
    const progress = job.totalUnits ? job.completedUnits/job.totalUnits*100 : 0;
    $('job-progress').style.width = `${progress}%`;
    const completeSummary = cachedOnly
      ? `${outcome.cacheHits} of ${job.totalUnits || outcome.cacheHits} ready · all cached · no raster generation`
      : job.status === 'complete'
        ? `${outcome.createdLayers} created${outcome.cacheHits ? ` · ${outcome.cacheHits} cached` : ''} · ${job.totalUnits || job.completedUnits || 0} ready`
        : null;
    const latestPhase = (job.phases || []).at(-1);
    const betweenPhaseSummary = ['queued','running'].includes(job.status) && latestPhase
      ? `After ${latestPhase.name} · waiting for next phase`
      : null;
    $('job-summary').textContent = job.error || job.currentPhase || betweenPhaseSummary || completeSummary || `${job.completedUnits || 0} of ${job.totalUnits || 0} layers · ${status.toLowerCase()}`;
    const jobCard = document.querySelector('.job-current');
    jobCard.classList.toggle('active', ['queued','running'].includes(job.status));
    jobCard.classList.toggle('cached', cachedOnly);
    jobCard.classList.toggle('failed', job.status === 'failed');
    setJobActivity(job.status, ['queued','running'].includes(job.status) ? 1 : 0);
    $('cancel-job').disabled = !['queued','running'].includes(job.status);
    $('phase-list').innerHTML = (job.phases || []).slice().reverse().map(phase => {
      const icon = phase.status === 'complete' ? '✓' : phase.status === 'failed' ? '×' : '●';
      return `<div class="phase ${escapeHtml(phase.status)}"><span class="phase-icon">${icon}</span><span class="phase-name" title="${escapeHtml(phase.name)}">${escapeHtml(phase.name)}</span><span class="phase-time">${Number(phase.elapsedMs || 0).toLocaleString()} ms</span></div>`;
    }).join('');
    const jobLog = $('job-log');
    jobLog.textContent = (job.logs || []).slice(-80).join('\n') || 'Waiting for log output.';
    if (['queued','running'].includes(job.status)) jobLog.scrollTop = jobLog.scrollHeight;
    $('log-count').textContent = `${job.logs?.length || 0} lines`;
  }

  function updateMetrics() {
    $('metric-manifest').textContent = state.metrics.manifest == null ? '—' : `${state.metrics.manifest.toFixed(1)} ms`;
    $('metric-fetch').textContent = state.metrics.fetch == null ? '—' : `${state.metrics.fetch.toFixed(1)} ms`;
    $('metric-decode').textContent = state.metrics.decode == null ? '—' : `${state.metrics.decode.toFixed(1)} ms`;
    $('metric-swap').textContent = state.metrics.swap == null ? '—' : `${state.metrics.swap.toFixed(1)} ms`;
    $('metric-bytes').textContent = state.metrics.bytes == null ? '—' : fmtBytes(state.metrics.bytes);
    $('metric-exact').textContent = state.metrics.exact == null ? '—' : `${state.metrics.exact.toFixed(1)} ms`;
    $('metric-detail').textContent = state.metrics.detail == null ? '\u2014' : `${state.metrics.detail.toFixed(1)} ms`;
  }

  function clearClientCache() {
    clearExactPoints();
    for (const image of state.coloredImages.values()) URL.revokeObjectURL(image.url);
    for (const raw of state.rawImages.values()) raw.bitmap.close?.();
    state.coloredImages.clear(); state.rawImages.clear();
    toast('Browser image/decode cache cleared');
    applyContext(); applyRaster();
  }

  function toast(message) {
    clearTimeout(state.toastTimer);
    $('transition-toast').textContent = message;
    $('transition-toast').classList.add('show');
    state.toastTimer = setTimeout(() => $('transition-toast').classList.remove('show'), 2200);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
    catch (_) { toast('Clipboard permission was denied'); }
  }

  async function initializePublicExperience() {
    const feedbackButton = $('feedback-open');
    const enabled = state.bootstrap.feedbackEnabled === true;
    feedbackButton.disabled = !enabled;
    feedbackButton.title = enabled ? 'Send an anonymous or Discord-identified note' : 'Feedback is being connected';
    if (enabled) {
      try { state.discordIdentity = await fetchJson(`${API}/auth/session`); }
      catch (_) { state.discordIdentity = { connected:false }; }
    }
    renderIdentityState();

    const params = new URLSearchParams(location.search);
    const discordResult = params.get('discord');
    if (discordResult) {
      const draft = sessionStorage.getItem('steward-feedback-draft');
      if (draft) {
        try {
          const saved = JSON.parse(draft);
          $('feedback-message').value = saved.message || '';
          $('feedback-identify').checked = true;
        } catch (_) {}
      }
      if (discordResult === 'connected') {
        try { state.discordIdentity = await fetchJson(`${API}/auth/session`); } catch (_) {}
      } else {
        showFeedbackError('Discord did not connect. You can try again or send anonymously.');
      }
      renderIdentityState();
      updateFeedbackCount();
      openFeedbackDialog(discordResult !== 'error');
      history.replaceState({}, '', APP_BASE.pathname);
    }
    if (!discordResult && !quickStartDismissed()) openDialog($('quick-start-dialog'));
  }

  function quickStartDismissed() {
    try { return localStorage.getItem(QUICK_START_DISMISSAL_KEY) === 'dismissed'; }
    catch (_) { return false; }
  }

  function dismissQuickStart() {
    try { localStorage.setItem(QUICK_START_DISMISSAL_KEY, 'dismissed'); }
    catch (_) {}
  }

  function openDialog(dialog) {
    if (!dialog.open) dialog.showModal();
  }

  function closeDialog(dialog) {
    if (dialog.open) {
      if (dialog.id === 'quick-start-dialog') dismissQuickStart();
      dialog.close();
    }
  }

  function openFeedbackDialog(clearError = true) {
    $('feedback-success').hidden = true;
    $('feedback-fields').hidden = false;
    $('feedback-submit').hidden = false;
    $('feedback-cancel').textContent = 'Cancel';
    if (clearError) hideFeedbackError();
    renderIdentityState();
    updateFeedbackCount();
    openDialog($('feedback-dialog'));
    setTimeout(() => $('feedback-message').focus(), 0);
  }

  function updateFeedbackCount() {
    $('feedback-count').textContent = String($('feedback-message').value.length);
  }

  function renderIdentityState() {
    if (!$('feedback-identify')) return;
    const available = state.bootstrap?.discordIdentityEnabled === true;
    const identify = $('feedback-identify');
    identify.disabled = !available;
    if (!available) identify.checked = false;
    const row = $('feedback-identity-state');
    row.hidden = !identify.checked;
    const connected = state.discordIdentity?.connected === true;
    row.classList.toggle('connected', connected);
    $('feedback-identity-copy').textContent = connected
      ? `Connected as ${state.discordIdentity.displayName}` : 'Connect to include your verified Discord name';
    $('feedback-discord-connect').hidden = connected;
    $('feedback-discord-logout').hidden = !connected;
    $('feedback-submit').disabled = state.feedbackSubmitting || (identify.checked && !connected);
  }

  function showFeedbackError(message) {
    const error = $('feedback-error');
    error.textContent = message;
    error.hidden = false;
  }

  function hideFeedbackError() {
    $('feedback-error').hidden = true;
    $('feedback-error').textContent = '';
  }

  function saveFeedbackDraft() {
    sessionStorage.setItem('steward-feedback-draft', JSON.stringify({
      message: $('feedback-message').value,
      identify: $('feedback-identify').checked
    }));
  }

  function feedbackContext() {
    const snapshot = state.bootstrap?.snapshots?.find(item => Number(item.snapshotId) === Number(state.snapshotId));
    const lens = state.lensById.get(state.lensId);
    const entry = state.currentEntry;
    const zoom = state.map ? state.map.getZoom() : null;
    const bounds = state.map?.getBounds();
    const viewport = bounds ? boundsLabel(bounds) : 'Whole world';
    const scale = entry?.cellSize ? `${entry.cellSize} m cells` : 'world overview';
    const viewLabel = state.viewMode === 'biomes' ? `Biomes · ${selectedBiomeSummary()}`
      : state.viewMode === 'terrain' ? 'Terrain'
      : lens?.label || 'Build density';
    return {
      world: `${snapshot?.worldName || 'Comfy Era 17'} · snapshot #${state.snapshotId}`,
      view: `${viewLabel} · ${scale} · zoom ${zoom == null ? '—' : Number(zoom).toFixed(2)} · ${viewport}`,
      selection: state.currentSelectionBounds ? boundsLabel(state.currentSelectionBounds)
        : state.currentScopeBounds ? `Whole biome scope · ${selectedBiomeSummary()}` : 'No inspection area selected',
      release: state.bootstrap?.releaseVersion || 'dev'
    };
  }

  async function submitFeedback(event) {
    event.preventDefault();
    if (state.feedbackSubmitting) return;
    hideFeedbackError();
    const message = $('feedback-message').value.trim();
    if (!message) {
      showFeedbackError('Tell us what you noticed first.');
      $('feedback-message').focus();
      return;
    }
    const identify = $('feedback-identify').checked;
    if (identify && !state.discordIdentity?.connected) {
      showFeedbackError('Connect Discord first, or turn identification off to send anonymously.');
      return;
    }
    state.feedbackSubmitting = true;
    $('feedback-submit').textContent = 'Sending…';
    renderIdentityState();
    try {
      await fetchJson(`${API}/feedback`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          message,
          identify,
          website:$('feedback-website').value,
          context:feedbackContext()
        })
      });
      sessionStorage.removeItem('steward-feedback-draft');
      $('feedback-fields').hidden = true;
      $('feedback-success').hidden = false;
      $('feedback-submit').hidden = true;
      $('feedback-cancel').textContent = 'Close';
      $('feedback-message').value = '';
      updateFeedbackCount();
    } catch (error) {
      showFeedbackError(`${error.message}. Your note is still here—please try again.`);
    } finally {
      state.feedbackSubmitting = false;
      $('feedback-submit').textContent = 'Send feedback';
      renderIdentityState();
    }
  }

  function bindEvents() {
    $('map-view-controls').addEventListener('click', event => {
      const mode = event.target.closest('[data-view-mode]');
      if (mode) setViewMode(mode.dataset.viewMode);
    });
    $('biome-chip-list').addEventListener('click', event => {
      const button = event.target.closest('[data-biome]');
      if (button) setBiomeFilter(button.dataset.biome);
    });
    $('biome-view-results').addEventListener('click', () => {
      inspectBounds(state.worldBounds, { draw:false });
    });
    $('snapshot-select').addEventListener('change', async event => {
      state.snapshotId = Number(event.target.value);
      updateSnapshotHeader();
      closeInspector();
      clearExactPoints();
      await loadManifest();
      state.map.fitBounds(state.worldBounds.pad(.03));
    });
    $('lens-list').addEventListener('click', event => {
      const button = event.target.closest('[data-lens]');
      if (!button) return;
      state.lensId = button.dataset.lens;
      updateLensCopy(); updateAvailability(); closeInspector(); clearExactPoints(); applyRaster();
    });
    $('resolution-buttons').addEventListener('click', event => {
      const button = event.target.closest('[data-resolution]');
      if (!button) return;
      state.resolution = button.dataset.resolution;
      document.querySelectorAll('#resolution-buttons button').forEach(b => b.classList.toggle('active', b === button));
      applyContext(); applyRaster();
    });
    $('raster-style-buttons').addEventListener('click', event => {
      const button = event.target.closest('[data-raster-style]');
      if (button) setRasterStyle(button.dataset.rasterStyle);
    });
    document.querySelectorAll('.palette').forEach(button => button.addEventListener('click', () => {
      state.palette = button.dataset.palette;
      document.querySelectorAll('.palette').forEach(p => { p.classList.toggle('active',p===button); p.querySelector('b').textContent = p===button ? '✓' : ''; });
      applyRaster(); scheduleExactPoints();
    }));
    $('analysis-opacity').addEventListener('input', event => {
      state.analysisOpacity = Number(event.target.value);
      syncCompositeOpacity();
    });
    $('context-opacity').addEventListener('input', event => {
      state.contextOpacity = Number(event.target.value);
      syncCompositeOpacity();
    });
    $('context-on').addEventListener('click', () => { state.contextEnabled=true; $('context-on').classList.add('active'); $('context-off').classList.remove('active'); applyContext(); });
    $('context-off').addEventListener('click', () => { state.contextEnabled=false; $('context-off').classList.add('active'); $('context-on').classList.remove('active'); removeContext(); });
    const peek = $('peek-context');
    const peekOn = () => {
      if (state.overlay) state.overlay.setOpacity(.03);
      if (state.detailOverlay) state.detailOverlay.setOpacity(.03);
      if (state.contextOverlay) state.contextOverlay.setOpacity(state.contextOpacity);
    };
    const peekOff = syncCompositeOpacity;
    peek.addEventListener('pointerdown', peekOn); peek.addEventListener('pointerup', peekOff); peek.addEventListener('pointerleave', peekOff);
    $('tool-buttons').addEventListener('click', event => { const button=event.target.closest('[data-tool]'); if(button) setTool(button.dataset.tool); });
    $('exact-toggle').addEventListener('change', event => { state.exactEnabled=event.target.checked; scheduleExactPoints(); });
    $('fit-world').addEventListener('click', () => state.map.fitBounds(state.worldBounds.pad(.03)));
    $('go-world').addEventListener('click', () => state.map.fitBounds(state.worldBounds.pad(.03)));
    $('go-spawn').addEventListener('click', () => state.map.setView(worldToLatLng(0,0), -1.5));
    $('story-action').addEventListener('click', () => {
      const action = state.storyAction;
      if (!action) return;
      if (action.type === 'render') return submitRender(false);
      if (action.type === 'inspect') {
        setTool('inspect');
        toast('Drag a green area to explain it');
        return;
      }
      setTool('box');
      toast('Drag a gold window around a bright cluster');
    });
    $('story-selection-action').addEventListener('click', toggleSelectionItems);
    $('render-selected').addEventListener('click', () => submitRender(false));
    $('render-all').addEventListener('click', () => submitRender(true));
    $('runs-nav').addEventListener('click', () => focusJobActivity(false));
    $('job-bench-tab').addEventListener('click', () => showRightPanel('jobs'));
    $('inspect-panel-tab').addEventListener('click', () => showRightPanel('inspect'));
    $('inspect-nav').addEventListener('click', () => { setTool('inspect'); toast('Drag a green area to explain it'); });
    $('inspect-start').addEventListener('click', () => { setTool('inspect'); toast('Drag a green area to explain it'); });
    $('view-job-log').addEventListener('click', () => focusJobActivity(true));
    $('cancel-job').addEventListener('click', async () => { if(state.lastJob) await fetchJson(`${API}/jobs/${state.lastJob.id}/cancel`,{method:'POST'}); });
    $('reload-manifest').addEventListener('click', loadManifest);
    $('clear-client-cache').addEventListener('click', clearClientCache);
    $('copy-command').addEventListener('click', () => {
      const resolutions = [...document.querySelectorAll('#job-resolutions input:checked')].map(input=>input.value).join(',');
      const command = `.\\lab.ps1 render -Snapshot ${state.snapshotId} -Lens '${state.lensId}' -Resolutions '${resolutions}'${$('job-force').checked ? ' -Force' : ''}`;
      copyText(command);
    });
    $('copy-monitor-command').addEventListener('click', () => copyText('.\\lab.ps1 watch-jobs -IntervalSeconds 15'));
    $('inspect-close').addEventListener('click', () => showRightPanel('jobs'));
    $('inspect-zoom').addEventListener('click', () => state.currentSelectionBounds && state.map.fitBounds(state.currentSelectionBounds,{padding:[30,30]}));
    $('inspect-copy').addEventListener('click', () => state.currentScopeBounds && copyText(boundsLabel(state.currentScopeBounds)));
    $('inspect-clear-area').addEventListener('click', () => inspectBounds(state.worldBounds, { draw:false }));
    $('inspect-show-all').addEventListener('click', loadAllSelectionCategories);
    $('inspect-items-prev').addEventListener('click', previousItemPage);
    $('inspect-items-next').addEventListener('click', nextItemPage);
    $('inspect-items-list').addEventListener('click', event => {
      const item = event.target.closest('[data-item-x]');
      if (item) focusItem(Number(item.dataset.itemX), Number(item.dataset.itemZ));
    });
    ['threshold-160','threshold-80','threshold-64','threshold-16','threshold-exact','threshold-detail4'].forEach(id => $(id).addEventListener('change', () => { applyRaster(); scheduleExactPoints(); }));
    $('opacity-detail-zoom').addEventListener('change', syncCompositeOpacity);
    $('quick-start-open').addEventListener('click', () => openDialog($('quick-start-dialog')));
    $('quick-start-close').addEventListener('click', () => closeDialog($('quick-start-dialog')));
    $('quick-start-done').addEventListener('click', () => closeDialog($('quick-start-dialog')));
    $('quick-start-dialog').addEventListener('cancel', dismissQuickStart);
    $('quick-start-dialog').addEventListener('close', dismissQuickStart);
    $('feedback-open').addEventListener('click', () => openFeedbackDialog());
    $('feedback-close').addEventListener('click', () => closeDialog($('feedback-dialog')));
    $('feedback-cancel').addEventListener('click', () => closeDialog($('feedback-dialog')));
    $('feedback-message').addEventListener('input', updateFeedbackCount);
    $('feedback-identify').addEventListener('change', () => { hideFeedbackError(); renderIdentityState(); });
    $('feedback-form').addEventListener('submit', submitFeedback);
    $('feedback-discord-connect').addEventListener('click', () => {
      saveFeedbackDraft();
      location.assign(`${API}/auth/discord/start`);
    });
    $('feedback-discord-logout').addEventListener('click', async () => {
      try {
        await fetchJson(`${API}/auth/logout`, { method:'POST' });
        state.discordIdentity = { connected:false };
        renderIdentityState();
      } catch (error) {
        showFeedbackError(error.message);
      }
    });
    [$('quick-start-dialog'), $('feedback-dialog')].forEach(dialog => dialog.addEventListener('click', event => {
      if (event.target === dialog) closeDialog(dialog);
    }));
    document.addEventListener('keydown', event => {
      if ($('quick-start-dialog').open || $('feedback-dialog').open) return;
      if (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
      if (event.key === 'Shift' && state.tool === 'pan' && !state.drawing) state.map.dragging.disable();
      if (event.key.toLowerCase()==='p') setTool('pan');
      if (event.key.toLowerCase()==='z') setTool('box');
      if (event.key.toLowerCase()==='i') setTool('inspect');
      if (event.key==='Escape') {
        cancelDrawing();
        setTool('pan'); closeInspector();
      }
    });
    document.addEventListener('keyup', event => {
      if (event.key === 'Shift' && state.tool === 'pan' && !state.drawing) state.map.dragging.enable();
    });
    window.addEventListener('blur', () => {
      state.panGestureActive = false;
      document.body.classList.remove('map-pan-active');
      if (state.drawing) cancelDrawing();
      else if (state.tool === 'pan') state.map.dragging.enable();
    });
  }

  function closeInspector() {
    ++state.inspectToken;
    ++state.itemToken;
    const hadSelectionItems = state.exactScope === 'selection' || state.exactScope === 'biome-selection';
    if (hadSelectionItems) removeExactMarkers();
    state.currentSelectionBounds = null;
    state.currentScopeBounds = null;
    state.currentSelectionPositionCount = null;
    state.selectionItemsLoading = false;
    if (state.selectionRect && state.map) state.map.removeLayer(state.selectionRect);
    if (state.miniSelectionRect && state.minimap) state.minimap.removeLayer(state.miniSelectionRect);
    state.selectionRect = state.miniSelectionRect = null;
    $('inspect-content').hidden = true;
    $('inspect-empty').hidden = false;
    $('inspect-point-warning').hidden = true;
    $('inspect-show-all').hidden = true;
    $('inspect-clear-area').hidden = true;
    $('inspect-items-range').textContent = '—';
    $('inspect-items-list').innerHTML = '<div class="inspect-item-empty">Select an area to list its objects.</div>';
    $('inspect-items-prev').disabled = $('inspect-items-next').disabled = true;
    $('inspect-ranked-label').textContent = 'WHAT MAKES IT BRIGHT \u00b7 TOP TYPES';
    $('inspect-tab-state').textContent = 'NO AREA';
    syncSelectionAction();
    showRightPanel('jobs');
    if (state.viewMode === 'biomes') {
      state.biomeAutoPointsSuppressed = false;
      showBiomeOutlineStory();
      scheduleExactPoints();
    }
    else if (state.viewMode === 'terrain') showTerrainStory();
    else if (hadSelectionItems) scheduleExactPoints();
  }

  bootstrap();
})();
