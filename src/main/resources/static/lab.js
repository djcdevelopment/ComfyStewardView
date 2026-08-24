(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const API = '/api';
  const palettes = {
    ember: [[0,[14,25,43]],[.34,[43,79,126]],[.7,[176,171,139]],[1,[242,126,108]]],
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
    palette: 'ember',
    analysisOpacity: .72,
    contextOpacity: .62,
    contextEnabled: true,
    exactEnabled: true,
    tool: 'pan',
    map: null,
    minimap: null,
    worldBounds: null,
    overlay: null,
    contextOverlay: null,
    miniContextOverlay: null,
    exactLayer: null,
    exactRenderer: null,
    selectionRect: null,
    miniSelectionRect: null,
    miniViewport: null,
    drawRect: null,
    drawStart: null,
    drawing: false,
    currentEntry: null,
    currentSelectionBounds: null,
    rawImages: new Map(),
    coloredImages: new Map(),
    rasterToken: 0,
    contextToken: 0,
    exactToken: 0,
    lastJob: null,
    lastCompletedJobId: null,
    pollTimer: null,
    exactTimer: null,
    toastTimer: null,
    metrics: { manifest: null, fetch: null, decode: null, swap: null, bytes: null, exact: null }
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
      cacheChip.textContent = `CACHE · ${fmtBytes(state.bootstrap.cacheBytes)} · READ ONLY`;
      cacheChip.title = state.bootstrap.cachePath;
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
      zoomAnimation: !reducedMotion,
      fadeAnimation: !reducedMotion,
      markerZoomAnimation: !reducedMotion
    });
    state.map.createPane('contextPane').style.zIndex = 180;
    state.map.createPane('gridPane').style.zIndex = 220;
    state.map.createPane('analysisPane').style.zIndex = 280;
    state.map.createPane('exactPane').style.zIndex = 360;
    state.map.createPane('selectionPane').style.zIndex = 430;
    state.exactRenderer = L.canvas({ pane:'exactPane', padding:.25 });
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

    state.map.on('mousemove', event => {
      const world = latLngToWorld(event.latlng);
      $('coords').textContent = `X ${Math.round(world.x).toLocaleString()} · Z ${Math.round(world.z).toLocaleString()} · ${state.tool.toUpperCase()}`;
      if (state.drawing && state.drawRect) state.drawRect.setBounds([state.drawStart, event.latlng]);
    });
    state.map.on('mousedown', startDrawing);
    state.map.on('mouseup', finishDrawing);
    state.map.on('click', event => {
      if (state.tool !== 'pan' || state.drawing) return;
      inspectCell(event.latlng);
    });
    state.map.on('zoomend', () => {
      const before = state.currentEntry?.cellSize;
      applyContext();
      applyRaster().then(() => {
        const after = state.currentEntry?.cellSize;
        if (before && after && before !== after) toast(`${before} m aggregate → ${after} m detail`);
      });
      updateMiniViewport();
      scheduleExactPoints();
    });
    state.map.on('moveend', () => {
      updateMiniViewport();
      scheduleExactPoints();
    });
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
    $('lens-availability').textContent = `${count} SCALE${count === 1 ? '' : 'S'}`;
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
    $('scale-state').textContent = state.resolution === 'auto' ? `AUTO → ${entry?.cellSize || requested} M` : `${requested} M`;
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
    setStory('', `Loading ${lens.label} at ${entry.cellSize} m…`, 'Fetching gray8 evidence and applying the selected color ramp.');
    try {
      const image = await coloredImage(artifactUrl(entry), state.palette);
      if (token !== state.rasterToken) return;
      const swapStarted = performance.now();
      const overlay = L.imageOverlay(image.url, leafletBounds(entry.bounds), {
        pane: 'analysisPane', opacity: 0, interactive: false, className: 'analysis-raster'
      }).addTo(state.map);
      await crossfade(state.overlay, overlay, state.analysisOpacity);
      if (token !== state.rasterToken) { state.map.removeLayer(overlay); return; }
      state.overlay = overlay;
      state.currentEntry = entry;
      state.metrics.fetch = image.fetchMs;
      state.metrics.decode = image.colorMs;
      state.metrics.swap = performance.now() - swapStarted;
      state.metrics.bytes = image.bytes;
      updateLegend(entry, lens);
      $('map-status').textContent = `${lens.label} · ${entry.cellSize} m cells · snapshot #${state.snapshotId} · ${state.palette}`;
      const fallback = Number(entry.cellSize) !== Number(requested) ? ` Nearest available scale: ${entry.cellSize} m.` : '';
      setStory('ready', `${lens.label}: ${fmt(entry.totalValue)} ${lens.units}`, `${lens.payoff} Hottest cell: ${fmt(entry.maxRaw)}.${fallback}`);
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
    for (let i = 0; i < pixels.data.length; i += 4) {
      if (pixels.data[i+3] === 0) continue;
      const [r,g,b] = rampColor(ramp, pixels.data[i] / 255);
      pixels.data[i] = r; pixels.data[i+1] = g; pixels.data[i+2] = b; pixels.data[i+3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const result = { url: URL.createObjectURL(blob), bytes: raw.bytes, fetchMs: raw.fetchMs, colorMs: performance.now() - colorStarted };
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

  async function crossfade(oldOverlay, newOverlay, targetOpacity) {
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : Math.max(0, Number($('crossfade-ms').value));
    if (!duration) {
      newOverlay.setOpacity(targetOpacity);
      if (oldOverlay) state.map.removeLayer(oldOverlay);
      return;
    }
    const started = performance.now();
    await new Promise(resolve => {
      const frame = now => {
        const t = Math.min(1, (now-started)/duration);
        newOverlay.setOpacity(targetOpacity*t);
        if (oldOverlay) oldOverlay.setOpacity(state.analysisOpacity*(1-t));
        if (t < 1) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
    if (oldOverlay) state.map.removeLayer(oldOverlay);
  }

  function updateLegend(entry, lens) {
    $('legend').hidden = false;
    $('legend-title').textContent = `${lens.label} per ${entry.cellSize} m cell`;
    $('legend-gradient').className = `legend-gradient ${state.palette}`;
    const ticks = [0,.25,.5,.75,1].map(t => Math.round(Math.expm1(Number(entry.maxLog || 1)*t)));
    $('legend-ticks').innerHTML = ticks.map(tick => `<span>${fmt(tick)}</span>`).join('');
  }

  function setStory(kind, title, copy, action = false) {
    $('map-story').className = `map-story ${kind || ''}`;
    $('story-title').textContent = title;
    $('story-copy').textContent = copy;
    $('story-action').hidden = !action;
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
    state.tool = tool;
    state.drawing = false;
    if (state.drawRect) { state.map.removeLayer(state.drawRect); state.drawRect = null; }
    if (tool === 'pan') state.map.dragging.enable(); else state.map.dragging.disable();
    document.querySelectorAll('#tool-buttons button').forEach(button => button.classList.toggle('active', button.dataset.tool === tool));
    $('tool-state').textContent = tool.toUpperCase();
    $('coords').textContent = `${tool.toUpperCase()} · move over map for coordinates`;
  }

  function startDrawing(event) {
    if (state.tool === 'pan' || event.originalEvent.button !== 0) return;
    state.drawing = true;
    state.drawStart = event.latlng;
    if (state.drawRect) state.map.removeLayer(state.drawRect);
    state.drawRect = L.rectangle([event.latlng,event.latlng], { pane:'selectionPane', color:state.tool === 'box' ? '#e5be58' : '#70d29a', weight:1, fillOpacity:.12 }).addTo(state.map);
    L.DomEvent.preventDefault(event.originalEvent);
  }

  function finishDrawing(event) {
    if (!state.drawing || !state.drawRect) return;
    state.drawing = false;
    const bounds = state.drawRect.getBounds();
    const width = Math.abs(bounds.getEast()-bounds.getWest());
    const height = Math.abs(bounds.getNorth()-bounds.getSouth());
    if (width < 5 || height < 5) {
      state.map.removeLayer(state.drawRect); state.drawRect = null;
      inspectCell(event.latlng);
      return;
    }
    if (state.tool === 'box') {
      state.map.fitBounds(bounds, { padding:[24,24], animate:!matchMedia('(prefers-reduced-motion: reduce)').matches });
      state.map.removeLayer(state.drawRect); state.drawRect = null;
      toast(`Box zoom · ${fmt(width)} × ${fmt(height)} m`);
    } else {
      inspectBounds(bounds);
      state.map.removeLayer(state.drawRect); state.drawRect = null;
    }
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
    state.currentSelectionBounds = bounds;
    if (state.selectionRect) state.map.removeLayer(state.selectionRect);
    state.selectionRect = L.rectangle(bounds, { pane:'selectionPane', className:'selection-rectangle', color:'#70d29a', weight:2, fillOpacity:.1 }).addTo(state.map);
    if (state.miniSelectionRect) state.minimap.removeLayer(state.miniSelectionRect);
    state.miniSelectionRect = L.rectangle(bounds, { color:'#70d29a', weight:1, fillOpacity:.08, interactive:false }).addTo(state.minimap);
    $('inspector').hidden = false;
    const query = boundsQuery(bounds);
    $('inspect-bounds').textContent = boundsLabel(bounds);
    $('inspect-title').textContent = `Explaining ${state.lensById.get(state.lensId)?.label || state.lensId}`;
    $('inspect-total').textContent = $('inspect-share').textContent = $('inspect-density').textContent = '…';
    $('inspect-top').innerHTML = '<div class="rank-row"><span>Scanning selected bounds…</span></div>';
    const started = performance.now();
    try {
      const result = await fetchJson(`${API}/selection?snapshot=${state.snapshotId}&lens=${encodeURIComponent(state.lensId)}&topN=10&${query}`);
      const elapsed = performance.now()-started;
      $('inspect-query-time').textContent = `${elapsed.toFixed(0)} ms`;
      $('inspect-total').textContent = fmt(result.total);
      $('inspect-units').textContent = result.units;
      $('inspect-share').textContent = `${Number(result.worldSharePct).toFixed(result.worldSharePct < 1 ? 2 : 1)}%`;
      $('inspect-density').textContent = fmt(result.densityPerSquareKm);
      const max = Math.max(1,...result.top.map(item => item.value));
      $('inspect-top').innerHTML = result.top.length ? result.top.map(item =>
        `<div class="rank-row"><span>${escapeHtml(item.label)}</span><span>${fmt(item.value)}</span><div class="rank-bar"><i style="width:${item.value/max*100}%"></i></div></div>`).join('')
        : '<div class="rank-row"><span>No objects from this lens are inside the selection.</span></div>';
    } catch (error) {
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

  async function loadExactPoints() {
    const threshold = Number($('threshold-exact').value);
    if (!state.exactEnabled || !state.map || state.map.getZoom() < threshold || !state.currentEntry) {
      clearExactPoints(); return;
    }
    const token = ++state.exactToken;
    const bounds = state.map.getBounds();
    const started = performance.now();
    try {
      const result = await fetchJson(`${API}/points?snapshot=${state.snapshotId}&lens=${encodeURIComponent(state.lensId)}&limit=5000&${boundsQuery(bounds)}`);
      if (token !== state.exactToken) return;
      clearExactPoints(false);
      const lens = state.lensById.get(state.lensId);
      const group = L.layerGroup([], { pane:'exactPane' }).addTo(state.map);
      for (const point of result.points) {
        L.circleMarker(worldToLatLng(point.x,point.z), {
          pane:'exactPane', renderer:state.exactRenderer, radius:4.2, weight:1.3, color:'#f5f7fb',
          fillColor:lens.accent, fillOpacity:1, opacity:.96
        }).bindTooltip(`${escapeHtml(point.label)} · ${fmt(point.value)}`).addTo(group);
      }
      state.exactLayer = group;
      if (state.overlay) state.overlay.setOpacity(state.analysisOpacity*.38);
      state.metrics.exact = performance.now()-started;
      $('exact-state').textContent = `${result.points.length}${result.truncated ? '+' : ''} POINTS`;
      const exactTitle = result.points.length
        ? `${fmt(result.points.length)} exact ${lens.units} in this viewport`
        : `No exact ${lens.units} in this viewport`;
      const exactCopy = result.truncated
        ? `Showing the first ${fmt(result.points.length)} objects. Tighten the viewport to resolve the full cluster.`
        : `The ${state.currentEntry.cellSize} m raster has yielded to queryable object positions. Inspect a cluster or pan onward.`;
      setStory(result.points.length ? 'ready' : '', exactTitle, exactCopy);
      updateMetrics();
    } catch (error) {
      if (token !== state.exactToken) return;
      $('exact-state').textContent = 'QUERY FAILED';
    }
  }

  function clearExactPoints(increment = true) {
    if (increment) ++state.exactToken;
    if (state.exactLayer && state.map) state.map.removeLayer(state.exactLayer);
    state.exactLayer = null;
    if (state.overlay) state.overlay.setOpacity(state.analysisOpacity);
    $('exact-state').textContent = 'RASTER';
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
    try {
      state.lastJob = await fetchJson(`${API}/jobs/render`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(request) });
      renderJob(state.lastJob);
      toast(`Queued ${request.lensIds.length*request.resolutions.length} raster layer(s)`);
    } catch (error) {
      toast(`Job rejected: ${error.message}`);
    }
  }

  async function pollJobs() {
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
          toast('New raster artifacts loaded');
        }
      }
    } catch (_) {}
  }

  function renderJob(job) {
    const status = String(job.status || 'idle').toUpperCase();
    $('job-status').textContent = status;
    $('job-status').style.color = job.status === 'complete' ? 'var(--green)' : job.status === 'failed' ? 'var(--red)' : job.status === 'running' ? 'var(--amber)' : '';
    $('job-clock').textContent = (Number(job.elapsedMs || 0)/1000).toFixed(3);
    const progress = job.totalUnits ? job.completedUnits/job.totalUnits*100 : 0;
    $('job-progress').style.width = `${progress}%`;
    $('job-summary').textContent = job.error || job.currentPhase || `${job.completedUnits || 0} of ${job.totalUnits || 0} layers · ${status.toLowerCase()}`;
    $('cancel-job').disabled = !['queued','running'].includes(job.status);
    $('phase-list').innerHTML = (job.phases || []).slice().reverse().map(phase => {
      const icon = phase.status === 'complete' ? '✓' : phase.status === 'failed' ? '×' : '●';
      return `<div class="phase ${escapeHtml(phase.status)}"><span class="phase-icon">${icon}</span><span class="phase-name" title="${escapeHtml(phase.name)}">${escapeHtml(phase.name)}</span><span class="phase-time">${Number(phase.elapsedMs || 0).toLocaleString()} ms</span></div>`;
    }).join('');
    $('job-log').textContent = (job.logs || []).slice(-80).join('\n') || 'Waiting for log output.';
    $('log-count').textContent = `${job.logs?.length || 0} lines`;
  }

  function updateMetrics() {
    $('metric-manifest').textContent = state.metrics.manifest == null ? '—' : `${state.metrics.manifest.toFixed(1)} ms`;
    $('metric-fetch').textContent = state.metrics.fetch == null ? '—' : `${state.metrics.fetch.toFixed(1)} ms`;
    $('metric-decode').textContent = state.metrics.decode == null ? '—' : `${state.metrics.decode.toFixed(1)} ms`;
    $('metric-swap').textContent = state.metrics.swap == null ? '—' : `${state.metrics.swap.toFixed(1)} ms`;
    $('metric-bytes').textContent = state.metrics.bytes == null ? '—' : fmtBytes(state.metrics.bytes);
    $('metric-exact').textContent = state.metrics.exact == null ? '—' : `${state.metrics.exact.toFixed(1)} ms`;
  }

  function clearClientCache() {
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
    document.querySelectorAll('.palette').forEach(button => button.addEventListener('click', () => {
      state.palette = button.dataset.palette;
      document.querySelectorAll('.palette').forEach(p => { p.classList.toggle('active',p===button); p.querySelector('b').textContent = p===button ? '✓' : ''; });
      applyRaster();
    }));
    $('analysis-opacity').addEventListener('input', event => {
      state.analysisOpacity = Number(event.target.value);
      $('analysis-opacity-value').textContent = `${Math.round(state.analysisOpacity*100)}%`;
      if (state.overlay) state.overlay.setOpacity(state.exactLayer ? state.analysisOpacity*.38 : state.analysisOpacity);
    });
    $('context-opacity').addEventListener('input', event => {
      state.contextOpacity = Number(event.target.value);
      $('context-opacity-value').textContent = `${Math.round(state.contextOpacity*100)}%`;
      if (state.contextOverlay) state.contextOverlay.setOpacity(state.contextOpacity);
    });
    $('context-on').addEventListener('click', () => { state.contextEnabled=true; $('context-on').classList.add('active'); $('context-off').classList.remove('active'); applyContext(); });
    $('context-off').addEventListener('click', () => { state.contextEnabled=false; $('context-off').classList.add('active'); $('context-on').classList.remove('active'); removeContext(); });
    const peek = $('peek-context');
    const peekOn = () => { if(state.overlay) state.overlay.setOpacity(.05); };
    const peekOff = () => { if(state.overlay) state.overlay.setOpacity(state.exactLayer ? state.analysisOpacity*.38 : state.analysisOpacity); };
    peek.addEventListener('pointerdown', peekOn); peek.addEventListener('pointerup', peekOff); peek.addEventListener('pointerleave', peekOff);
    $('tool-buttons').addEventListener('click', event => { const button=event.target.closest('[data-tool]'); if(button) setTool(button.dataset.tool); });
    $('exact-toggle').addEventListener('change', event => { state.exactEnabled=event.target.checked; scheduleExactPoints(); });
    $('fit-world').addEventListener('click', () => state.map.fitBounds(state.worldBounds.pad(.03)));
    $('go-world').addEventListener('click', () => state.map.fitBounds(state.worldBounds.pad(.03)));
    $('go-spawn').addEventListener('click', () => state.map.setView(worldToLatLng(0,0), -1.5));
    $('story-action').addEventListener('click', () => submitRender(false));
    $('render-selected').addEventListener('click', () => submitRender(false));
    $('render-all').addEventListener('click', () => submitRender(true));
    $('cancel-job').addEventListener('click', async () => { if(state.lastJob) await fetchJson(`${API}/jobs/${state.lastJob.id}/cancel`,{method:'POST'}); });
    $('reload-manifest').addEventListener('click', loadManifest);
    $('clear-client-cache').addEventListener('click', clearClientCache);
    $('copy-command').addEventListener('click', () => {
      const resolutions = [...document.querySelectorAll('#job-resolutions input:checked')].map(input=>input.value).join(',');
      const command = `.\\lab.ps1 render -Snapshot ${state.snapshotId} -Lens '${state.lensId}' -Resolutions '${resolutions}'${$('job-force').checked ? ' -Force' : ''}`;
      copyText(command);
    });
    $('inspect-close').addEventListener('click', closeInspector);
    $('inspect-zoom').addEventListener('click', () => state.currentSelectionBounds && state.map.fitBounds(state.currentSelectionBounds,{padding:[30,30]}));
    $('inspect-copy').addEventListener('click', () => state.currentSelectionBounds && copyText(boundsLabel(state.currentSelectionBounds)));
    ['threshold-64','threshold-16','threshold-exact'].forEach(id => $(id).addEventListener('change', () => { applyRaster(); scheduleExactPoints(); }));
    document.addEventListener('keydown', event => {
      if (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
      if (event.key.toLowerCase()==='p') setTool('pan');
      if (event.key.toLowerCase()==='z') setTool('box');
      if (event.key.toLowerCase()==='i') setTool('inspect');
      if (event.key==='Escape') { setTool('pan'); closeInspector(); }
    });
  }

  function closeInspector() {
    $('inspector').hidden = true;
    state.currentSelectionBounds = null;
    if (state.selectionRect && state.map) state.map.removeLayer(state.selectionRect);
    if (state.miniSelectionRect && state.minimap) state.minimap.removeLayer(state.miniSelectionRect);
    state.selectionRect = state.miniSelectionRect = null;
  }

  bootstrap();
})();
