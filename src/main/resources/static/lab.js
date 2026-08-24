(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const API = '/api';
  const ANALYSIS_TONE_EXPONENT = 1.18;
  const ANALYSIS_TONE_PERCENTILE = .995;
  const ANALYSIS_TONE_LABEL = 'P99.5';
  const ANALYSIS_DISPLAY_SCALE = 2;
  const ANALYSIS_DISPLAY_SCALE_MAX_PIXELS = 1_000_000;
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
    exactLayer: null,
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
    currentSelectionBounds: null,
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

  async function bootstrap() {
    try {
      state.bootstrap = await fetchJson(`${API}/bootstrap`);
      state.lenses = state.bootstrap.lenses || [];
      state.lensById = new Map(state.lenses.map(lens => [lens.id, lens]));
      renderBootstrap();
      initMap();
      await loadManifest();
      bindEvents();
      state.pollTimer = setInterval(pollJobs, 500);
      pollJobs();
    } catch (error) {
      setStory('error', 'Lab could not start', error.message);
      console.error(error);
    }
  }

  function renderBootstrap() {
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
    $('context-provenance').textContent = state.bootstrap.contextAuthoritative ? 'AUTHORITATIVE' : 'INFERRED';
    $('context-copy').textContent = state.bootstrap.contextAuthoritative
      ? `${state.bootstrap.contextLabel} is supplied as the cartographic underlay.`
      : 'The surface ZDO field is an inferred coastline, not a terrain heightmap.';
    setRasterStyle(state.rasterStyle);
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
        if (before && after && before !== after) toast(`${before} m aggregate → ${after} m detail`);
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
      setStory('', 'No raster ladder yet', 'Render a lens to begin the overview → zoom → explain loop.', true);
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
    const threshold64 = Number($('threshold-64').value);
    const threshold16 = Number($('threshold-16').value);
    if (zoom >= threshold16) return 16;
    if (zoom >= threshold64) return 64;
    if (zoom < -5.4) return 1000;
    return 320;
  }

  function effectiveAnalysisOpacity() {
    const detailZoom = Number($('opacity-detail-zoom')?.value ?? -4);
    return state.map && state.map.getZoom() < detailZoom ? 1 : state.analysisOpacity;
  }

  function layerFor(lensId, resolution, allowFallback = true) {
    const candidates = (state.manifest?.layers || []).filter(layer => layer.lensId === lensId);
    const exact = candidates.find(layer => Number(layer.cellSize) === Number(resolution));
    if (exact || !allowFallback || !candidates.length) return exact || null;
    return [...candidates].sort((a,b) => Math.abs(Math.log(a.cellSize/resolution)) - Math.abs(Math.log(b.cellSize/resolution)))[0];
  }

  async function applyRaster() {
    if (!state.map || !state.manifest) return;
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
      setStory('', `${state.lensById.get(state.lensId)?.label} is ready to test`, 'Create the selected resolution ladder, then zoom into the signal.', true);
      clearExactPoints();
      return;
    }

    const token = ++state.rasterToken;
    const lens = state.lensById.get(state.lensId);
    if (!holdingLocalDetail) setStory('', `Loading ${lens.label} at ${entry.cellSize} m…`, 'Fetching gray8 evidence and applying the selected color ramp.');
    try {
      const image = await coloredImage(artifactUrl(entry), state.palette);
      if (token !== state.rasterToken) return;
      const swapStarted = performance.now();
      const overlay = L.imageOverlay(image.url, leafletBounds(entry.bounds), {
        pane: 'analysisPane', opacity: 0, interactive: false, className: 'analysis-raster'
      }).addTo(state.map);
      overlay.getElement().dataset.displayScale = String(image.displayScale);
      const previousOverlay = state.overlay;
      if (!holdingLocalDetail) await crossfade(previousOverlay, overlay, effectiveAnalysisOpacity());
      if (token !== state.rasterToken) { state.map.removeLayer(overlay); return; }
      if (holdingLocalDetail && previousOverlay) state.map.removeLayer(previousOverlay);
      state.overlay = overlay;
      state.currentEntry = entry;
      state.currentToneCap = image.toneCap;
      syncCompositeOpacity();
      state.metrics.fetch = image.fetchMs;
      state.metrics.decode = image.colorMs;
      state.metrics.swap = performance.now() - swapStarted;
      state.metrics.bytes = image.bytes;
      updateDetailLadder();
      if (!state.detailOverlay) {
        updateLegend(entry, lens, image.toneCap);
        $('map-status').textContent = `${lens.label} · ${entry.cellSize} m cells · snapshot #${state.snapshotId} · ${state.palette}`;
        const fallback = Number(entry.cellSize) !== Number(requested) ? ` Nearest available scale: ${entry.cellSize} m.` : '';
        const guidance = rasterGuidance(entry, lens, fallback);
        setStory('ready', guidance.title, guidance.copy, guidance.action);
      }
      updateMetrics();
      scheduleExactPoints();
    } catch (error) {
      if (token !== state.rasterToken) return;
      setStory('error', 'Raster load failed', error.message, true);
    }
  }

  async function applyContext() {
    if (!state.map || !state.contextEnabled) {
      removeContext();
      return;
    }
    const token = ++state.contextToken;
    try {
      let imageUrl;
      let miniImageUrl;
      let bounds = state.bootstrap.worldBounds;
      let miniBounds = bounds;
      if (state.bootstrap.contextAuthoritative) {
        imageUrl = miniImageUrl = `${API}/context`;
      } else {
        const contextEntry = layerFor('all-zdos', desiredResolution());
        const navigatorEntry = layerFor('all-zdos', 320);
        if (!contextEntry || !navigatorEntry) { removeContext(); return; }
        const context = await coloredImage(artifactUrl(contextEntry), 'context');
        const navigator = await coloredImage(artifactUrl(navigatorEntry), 'navigator');
        if (token !== state.contextToken) return;
        imageUrl = context.url;
        miniImageUrl = navigator.url;
        bounds = contextEntry.bounds;
        miniBounds = navigatorEntry.bounds;
      }
      const overlay = L.imageOverlay(imageUrl, leafletBounds(bounds), { pane:'contextPane', opacity:state.contextOpacity, interactive:false, className:'context-raster' }).addTo(state.map);
      if (state.contextOverlay) state.map.removeLayer(state.contextOverlay);
      state.contextOverlay = overlay;
      syncCompositeOpacity();
      const mini = L.imageOverlay(miniImageUrl, leafletBounds(miniBounds), { opacity:1, interactive:false, className:'context-raster' }).addTo(state.minimap);
      if (state.miniContextOverlay) state.minimap.removeLayer(state.miniContextOverlay);
      state.miniContextOverlay = mini;
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
  }

  function artifactUrl(entry) {
    return `${API}/artifacts/${state.snapshotId}/${encodeURIComponent(entry.file)}`;
  }

  function leafletBounds(bounds) {
    return L.latLngBounds([bounds.minZ, bounds.minX], [bounds.maxZ, bounds.maxX]);
  }

  async function coloredImage(url, paletteName) {
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
    const toneCap = focused ? occupiedToneCap(pixels.data) : 1;
    for (let i = 0; i < pixels.data.length; i += 4) {
      if (pixels.data[i+3] === 0) continue;
      const encoded = pixels.data[i] / 255;
      const tone = focused ? analysisTone(encoded, toneCap) : encoded;
      const [r,g,b] = rampColor(ramp, tone);
      pixels.data[i] = r; pixels.data[i+1] = g; pixels.data[i+2] = b; pixels.data[i+3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const displayScale = focused && canvas.width*canvas.height <= ANALYSIS_DISPLAY_SCALE_MAX_PIXELS
      ? ANALYSIS_DISPLAY_SCALE : 1;
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
      colorMs: performance.now() - colorStarted, toneCap, displayScale,
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

  function analysisTone(t, cap = 1) {
    return Math.pow(Math.max(0, Math.min(1, t/Math.max(.01,cap))), ANALYSIS_TONE_EXPONENT);
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

  function updateLegend(entry, lens, toneCap = 1) {
    $('legend').hidden = false;
    $('legend-title').textContent = `${lens.label} per ${entry.cellSize} m cell`;
    $('legend-gradient').className = `legend-gradient ${state.palette}`;
    const focused = Number(toneCap) < .9999;
    const legendMode = $('legend').querySelector('.legend-heading span');
    legendMode.textContent = focused ? `${ANALYSIS_TONE_LABEL} LOG` : 'LOG';
    legendMode.title = focused
      ? 'The brightest color begins at the occupied-cell 99.5th percentile; higher outliers share the capped color.'
      : 'Logarithmic value scale';
    $('legend').dataset.toneCap = Number(toneCap).toFixed(4);
    const stops = [0,.25,.5,.75,1];
    const ticks = stops.map(stop => Math.round(Math.expm1(Number(entry.maxLog || 1)*Number(toneCap)*Math.pow(stop,1/ANALYSIS_TONE_EXPONENT))));
    $('legend-ticks').innerHTML = ticks.map((tick,index) =>
      `<span>${fmt(tick)}${focused && index === ticks.length-1 ? '+' : ''}</span>`).join('');
  }

  function rasterGuidance(entry, lens, fallback) {
    const size = Number(entry.cellSize);
    const hottest = `Hottest ${size} m cell: ${fmt(entry.maxRaw)}.`;
    if (size >= 1000) return {
      title: `World overview · ${lens.label}`,
      copy: `Bright cells are the strongest concentrations. Box one to trade this 1 km summary for 320 m structure. ${hottest}${fallback}`,
      action: { type:'box', label:'Box a hotspot' }
    };
    if (size >= 320) return {
      title: `Continental pattern · ${lens.label}`,
      copy: `Compare the large settlement regions, then box a bright cluster to reveal 64 m neighborhoods. ${hottest}${fallback}`,
      action: { type:'box', label:'Draw zoom window' }
    };
    if (size >= 64) return {
      title: `Regional pattern · ${lens.label}`,
      copy: `Settlement shape is visible now. Box a bright cluster for 16 m detail; tighten once more for individual objects. ${hottest}${fallback}`,
      action: { type:'box', label:'Draw zoom window' }
    };
    return {
      title: `Neighborhood pattern · ${lens.label}`,
      copy: `These are ${size} m cells. Box a small hotspot once more and they yield to queryable individual objects. ${hottest}${fallback}`,
      action: { type:'box', label:'Reveal objects' }
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
    if (!action) return;
    const active = action.type === state.tool && (action.type === 'box' || action.type === 'inspect');
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.textContent = active ? (action.type === 'box' ? 'Drag on map…' : 'Drag an area…') : action.label;
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
    if (tool === 'inspect') showRightPanel('inspect');
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
    if (!state.currentEntry) return;
    const b = state.bootstrap.worldBounds;
    const size = Number(state.currentEntry.cellSize);
    const cx = Math.floor((latlng.lng-b.minX)/size);
    const cz = Math.floor((latlng.lat-b.minZ)/size);
    const minX = b.minX + cx*size, minZ = b.minZ + cz*size;
    inspectBounds(L.latLngBounds([minZ,minX],[Math.min(b.maxZ,minZ+size),Math.min(b.maxX,minX+size)]));
  }

  async function inspectBounds(bounds) {
    const token = ++state.inspectToken;
    const returnToPan = state.tool === 'inspect';
    state.currentSelectionBounds = bounds;
    if (state.selectionRect) state.map.removeLayer(state.selectionRect);
    state.selectionRect = L.rectangle(bounds, { pane:'selectionPane', renderer:state.selectionRenderer, className:'selection-rectangle', color:'#70d29a', weight:2, fillOpacity:.1 }).addTo(state.map);
    if (state.miniSelectionRect) state.minimap.removeLayer(state.miniSelectionRect);
    state.miniSelectionRect = L.rectangle(bounds, { color:'#70d29a', weight:1, fillOpacity:.08, interactive:false }).addTo(state.minimap);
    $('inspect-empty').hidden = true;
    $('inspect-content').hidden = false;
    $('inspect-tab-state').textContent = 'QUERYING';
    showRightPanel('inspect');
    $('inspector').scrollTop = 0;
    if (returnToPan) {
      setTool('pan');
      toast('Inspection pinned · drag to pan');
    }
    const query = boundsQuery(bounds);
    $('inspect-bounds').textContent = boundsLabel(bounds);
    $('inspect-title').textContent = `Explaining ${state.lensById.get(state.lensId)?.label || state.lensId}`;
    $('inspect-total').textContent = $('inspect-share').textContent = $('inspect-density').textContent = '…';
    $('inspect-top').innerHTML = '<div class="rank-row"><span>Scanning selected bounds…</span></div>';
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
      const max = Math.max(1,...result.top.map(item => item.value));
      $('inspect-top').innerHTML = result.top.length ? result.top.map(item =>
        `<div class="rank-row"><span>${escapeHtml(item.label)}</span><span>${fmt(item.value)}</span><div class="rank-bar"><i style="width:${item.value/max*100}%"></i></div></div>`).join('')
        : '<div class="rank-row"><span>No objects from this lens are inside the selection.</span></div>';
    } catch (error) {
      if (token !== state.inspectToken) return;
      $('inspect-tab-state').textContent = 'QUERY FAILED';
      $('inspect-top').innerHTML = `<div class="rank-row"><span>${escapeHtml(error.message)}</span></div>`;
    }
  }

  function boundsQuery(bounds) {
    return new URLSearchParams({ minX:bounds.getWest(), maxX:bounds.getEast(), minZ:bounds.getSouth(), maxZ:bounds.getNorth() }).toString();
  }

  function boundsLabel(bounds) {
    return `X ${Math.round(bounds.getWest())} → ${Math.round(bounds.getEast())} · Z ${Math.round(bounds.getSouth())} → ${Math.round(bounds.getNorth())}`;
  }

  function scheduleExactPoints() {
    clearTimeout(state.exactTimer);
    state.exactTimer = setTimeout(loadExactPoints, 220);
  }

  function pauseExactPoints() {
    clearTimeout(state.exactTimer);
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
    updateLegend(detail,lens,detail.toneCap);
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
    if (state.overlay) state.overlay.setOpacity(hasLocalDetail
      ? 0 : state.exactLayer ? effectiveAnalysis*.38 : effectiveAnalysis);
    if (state.detailOverlay) state.detailOverlay.setOpacity(state.analysisOpacity);
    if (state.contextOverlay) {
      const closeContextFactor = state.bootstrap?.contextAuthoritative ? .55 : .18;
      state.contextOverlay.setOpacity(hasLocalDetail
        ? state.contextOpacity*closeContextFactor : state.contextOpacity);
    }
    const requestedContext = Math.round(state.contextOpacity*100);
    const effectiveContext = Math.round(state.contextOpacity*
      (hasLocalDetail ? (state.bootstrap?.contextAuthoritative ? .55 : .18) : 1)*100);
    $('context-opacity-value').textContent = hasLocalDetail
      ? `${requestedContext}% → ${effectiveContext}%` : `${requestedContext}%`;
    $('context-opacity-value').title = hasLocalDetail
      ? 'Close detail is active; context has receded automatically. Hold peek to restore it.' : '';
    const requestedAnalysis = Math.round(state.analysisOpacity*100);
    const shownAnalysis = Math.round((hasLocalDetail ? state.analysisOpacity : effectiveAnalysis)*100);
    $('analysis-opacity-value').textContent = requestedAnalysis === shownAnalysis
      ? `${shownAnalysis}%` : `${requestedAnalysis}% → ${shownAnalysis}%`;
    $('analysis-opacity-value').title = requestedAnalysis === shownAnalysis
      ? 'Analysis opacity at this zoom.'
      : `World overview is pinned to 100% below zoom ${Number($('opacity-detail-zoom')?.value ?? -4).toFixed(2)}; the slider sets closer-detail opacity.`;
  }

  function restoreWorldRasterPresentation() {
    const entry = state.currentEntry;
    if (!entry || entry.lensId !== state.lensId) return;
    const lens = state.lensById.get(state.lensId);
    updateLegend(entry,lens,state.currentToneCap);
    $('scale-state').textContent = state.resolution === 'auto' ? `AUTO \u2192 ${entry.cellSize} M` : `${entry.cellSize} M`;
    $('map-status').textContent = `${lens.label} \u00b7 ${entry.cellSize} m cells \u00b7 snapshot #${state.snapshotId} \u00b7 ${state.palette}`;
  }

  async function loadExactPoints() {
    const threshold = Number($('threshold-exact').value);
    if (!state.exactEnabled || !state.map || state.map.getZoom() < threshold || !state.currentEntry) {
      clearExactPoints(); return;
    }
    const token = ++state.exactToken;
    const detailResolution = desiredLocalDetailResolution();
    const bounds = localDetailBounds(state.map.getBounds(),detailResolution);
    const started = performance.now();
    try {
      const result = await fetchJson(`${API}/points?snapshot=${state.snapshotId}&lens=${encodeURIComponent(state.lensId)}&limit=5000&${boundsQuery(bounds)}`);
      if (token !== state.exactToken) return;
      const lens = state.lensById.get(state.lensId);
      state.metrics.exact = performance.now()-started;
      if (result.truncated) {
        clearExactPoints(false);
        restoreWorldRasterPresentation();
        $('exact-state').textContent = `> ${fmt(result.limit)} · RASTER`;
        setStory('', `Zoom closer to reveal exact ${lens.units}`,
          `At least ${fmt(result.minimumCount)} ${lens.units} are inside this viewport. The raster remains complete; tighten the view to reveal every position together.`,
          { type:'box', label:'Tighten viewport' });
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
      removeExactMarkers();
      const group = L.layerGroup([], { pane:'exactPane' });
      for (const point of result.points) {
        L.circleMarker(worldToLatLng(point.x,point.z), {
          pane:'exactPane', renderer:state.exactRenderer, radius:4.2, weight:1.3, color:'#f5f7fb',
          fillColor:lens.accent, fillOpacity:1, opacity:.96
        }).bindTooltip(`${escapeHtml(point.label)} · ${fmt(point.value)}`).addTo(group);
      }
      state.exactLayer = group.addTo(state.map);
      syncCompositeOpacity();
      updateDetailLadder();
      $('exact-state').textContent = `${result.points.length} POINTS \u00b7 ${detail ? `${detail.cellSize} M` : 'RASTER'}`;
      const exactTitle = result.points.length
        ? `${fmt(result.points.length)} exact ${lens.units} in this viewport`
        : `No exact ${lens.units} in this viewport`;
      const exactCopy = detail
        ? `The ${detail.cellSize} m local density surface and these positions come from the same complete bounded query. Inspect a cluster or pan onward.`
        : `The ${state.currentEntry.cellSize} m raster has yielded to queryable object positions. Inspect a cluster or pan onward.`;
      setStory(result.points.length ? 'ready' : '', exactTitle, exactCopy,
        result.points.length ? { type:'inspect', label:'Inspect an area' } : { type:'box', label:'Try nearby' });
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

  function removeExactMarkers() {
    if (state.exactLayer && state.map) state.map.removeLayer(state.exactLayer);
    state.exactLayer = null;
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

  function bindEvents() {
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
    $('inspect-copy').addEventListener('click', () => state.currentSelectionBounds && copyText(boundsLabel(state.currentSelectionBounds)));
    ['threshold-64','threshold-16','threshold-exact','threshold-detail4'].forEach(id => $(id).addEventListener('change', () => { applyRaster(); scheduleExactPoints(); }));
    $('opacity-detail-zoom').addEventListener('change', syncCompositeOpacity);
    document.addEventListener('keydown', event => {
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
    state.currentSelectionBounds = null;
    if (state.selectionRect && state.map) state.map.removeLayer(state.selectionRect);
    if (state.miniSelectionRect && state.minimap) state.minimap.removeLayer(state.miniSelectionRect);
    state.selectionRect = state.miniSelectionRect = null;
    $('inspect-content').hidden = true;
    $('inspect-empty').hidden = false;
    $('inspect-tab-state').textContent = 'NO AREA';
    showRightPanel('jobs');
  }

  bootstrap();
})();
