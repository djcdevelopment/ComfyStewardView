import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const targetUrl = process.argv[2] || 'http://127.0.0.1:8091/';
const output = path.resolve(process.argv[3] || 'data/browser-smoke.png');
const parsedOutput = path.parse(output);
const marqueeOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-marquee${parsedOutput.ext || '.png'}`);
const denseOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-dense${parsedOutput.ext || '.png'}`);
const earlyInspectOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-early-inspect${parsedOutput.ext || '.png'}`);
const detailOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-detail-4m${parsedOutput.ext || '.png'}`);
const scale320Output = path.join(parsedOutput.dir, `${parsedOutput.name}-320m${parsedOutput.ext || '.png'}`);
const scale160Output = path.join(parsedOutput.dir, `${parsedOutput.name}-160m${parsedOutput.ext || '.png'}`);
const scale80Output = path.join(parsedOutput.dir, `${parsedOutput.name}-80m${parsedOutput.ext || '.png'}`);
const scale64Output = path.join(parsedOutput.dir, `${parsedOutput.name}-64m${parsedOutput.ext || '.png'}`);
const publicInspectOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-inspect${parsedOutput.ext || '.png'}`);
const exercise = process.argv.includes('--exercise');
const scalePreviews = process.argv.includes('--scale-previews');
const marqueeOnly = process.argv.includes('--marquee-only');
const useStoryAction = process.argv.includes('--story-action');
const submitJob = process.argv.includes('--submit-job');
const publicInspect = process.argv.includes('--public-inspect');
const publicExperience = new URL(targetUrl).searchParams.get('lab') !== '1';
let marqueeState = null;
let inspectorTabState = null;
let panGestureState = null;
let postInspectPanState = null;
let storyActionState = null;
let densePointState = null;
let denseUiState = null;
let earlyInspectState = null;
let earlySelectionItemsState = null;
let expandedInspectState = null;
let selectedItemsState = null;
let localDetail8State = null;
let localDetail4State = null;
let bufferedHandoffState = null;
let rasterStyleState = null;
let scalePreviewState = null;
let publicInspectState = null;
let publicClosedState = null;
const profile = path.resolve('data/browser-smoke-profile');
await mkdir(profile, { recursive: true });

const browser = spawn(chrome, [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=0',
  `--window-size=${process.env.SMOKE_WINDOW_SIZE || '1920,1080'}`, `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

let stderr = '';
const browserWs = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Chrome did not expose DevTools: ${stderr}`)), 10000);
  browser.stderr.on('data', chunk => {
    stderr += chunk.toString();
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
  browser.once('exit', code => reject(new Error(`Chrome exited early (${code}): ${stderr}`)));
});

const httpBase = browserWs.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*$/, '');
const target = await fetch(`${httpBase}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' }).then(r => r.json());
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

let nextId = 1;
const waiting = new Map();
const errors = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && waiting.has(message.id)) {
    const { resolve, reject } = waiting.get(message.id);
    waiting.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || 'Runtime exception');
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    errors.push(message.params.args.map(arg => arg.value || arg.description).join(' '));
  }
};

function cdp(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Page.navigate', { url: targetUrl });
await new Promise(resolve => setTimeout(resolve, 6000));

const rasterStyleResult = await cdp('Runtime.evaluate', { expression: `(() => {
  const capture = () => ({
    mode: document.body.classList.contains('raster-cells') ? 'cells' : 'smooth',
    world: getComputedStyle(document.querySelector('.analysis-raster')).imageRendering,
    context: getComputedStyle(document.querySelector('.context-raster')).imageRendering,
    worldOpacity: Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity),
    contextOpacity: Number(getComputedStyle(document.querySelector('.context-raster')).opacity),
    opacityLabel: document.querySelector('#analysis-opacity-value')?.textContent,
    toneCap: Number(document.querySelector('#legend')?.dataset.toneCap),
    toneExponent: Number(document.querySelector('#legend')?.dataset.toneExponent),
    legendMode: document.querySelector('#legend .legend-heading span')?.textContent,
    legendLastTick: document.querySelector('#legend-ticks span:last-child')?.textContent,
    smoothActive: document.querySelector('[data-raster-style="smooth"]')?.classList.contains('active'),
    cellsActive: document.querySelector('[data-raster-style="cells"]')?.classList.contains('active')
  });
  const initial = capture();
  document.querySelector('[data-raster-style="cells"]')?.click();
  const cells = capture();
  document.querySelector('[data-raster-style="smooth"]')?.click();
  return { initial, cells, restored:capture() };
})()`, returnByValue:true });
rasterStyleState = rasterStyleResult.result.value;

if (publicInspect) {
  const mapRectResult = await cdp('Runtime.evaluate', {
    expression: `(() => { const r=document.querySelector('#map').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()`,
    returnByValue:true
  });
  const mapRect = mapRectResult.result.value;
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#story-action')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 120));
  await cdp('Runtime.evaluate', { expression: `
    document.querySelectorAll('.map-story,.navigator-shell,.map-status,.legend,.leaflet-control-container')
      .forEach(element => element.style.pointerEvents='none');
  ` });
  await cdp('Input.dispatchMouseEvent', {
    type:'mousePressed', x:mapRect.x+mapRect.w*.43, y:mapRect.y+mapRect.h*.43,
    button:'left', buttons:1, clickCount:1
  });
  await cdp('Input.dispatchMouseEvent', {
    type:'mouseMoved', x:mapRect.x+mapRect.w*.59, y:mapRect.y+mapRect.h*.62,
    button:'left', buttons:1
  });
  await cdp('Input.dispatchMouseEvent', {
    type:'mouseReleased', x:mapRect.x+mapRect.w*.59, y:mapRect.y+mapRect.h*.62,
    button:'left', buttons:0, clickCount:1
  });
  await cdp('Runtime.evaluate', { expression: `
    document.querySelectorAll('.map-story,.navigator-shell,.map-status,.legend,.leaflet-control-container')
      .forEach(element => element.style.pointerEvents='');
  ` });
  await new Promise(resolve => setTimeout(resolve, 2200));
  const publicInspectResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    inspectionOpen:document.body.classList.contains('inspection-open'),
    jobsPanelDisplay:getComputedStyle(document.querySelector('.jobs-panel')).display,
    inspectorVisible:!document.querySelector('#inspector')?.hidden,
    jobBenchDisplay:getComputedStyle(document.querySelector('#job-bench-pane')).display,
    selectionPresent:Boolean(document.querySelector('.selection-rectangle')),
    selectionAction:document.querySelector('#story-selection-action')?.textContent,
    selectionActionVisible:!document.querySelector('#story-selection-action')?.hidden,
    inspectTitle:document.querySelector('#inspect-title')?.textContent,
    inspectTotal:document.querySelector('#inspect-total')?.textContent,
    rankRows:document.querySelectorAll('#inspect-top .rank-row').length,
    mapWidth:document.querySelector('#map').getBoundingClientRect().width
  }))()`, returnByValue:true });
  publicInspectState = publicInspectResult.result.value;
  const publicInspectShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  await writeFile(publicInspectOutput, Buffer.from(publicInspectShot.data, 'base64'));
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#inspect-close')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 350));
  const publicClosedResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    inspectionOpen:document.body.classList.contains('inspection-open'),
    jobsPanelDisplay:getComputedStyle(document.querySelector('.jobs-panel')).display,
    selectionPresent:Boolean(document.querySelector('.selection-rectangle')),
    selectionActionVisible:!document.querySelector('#story-selection-action')?.hidden,
    mapWidth:document.querySelector('#map').getBoundingClientRect().width
  }))()`, returnByValue:true });
  publicClosedState = publicClosedResult.result.value;
}

if (scalePreviews) {
  const captureScale = async outputPath => {
    await cdp('Runtime.evaluate', { expression: `document.querySelector('.leaflet-control-zoom-in')?.click()` });
    await new Promise(resolve => setTimeout(resolve, 1400));
    const result = await cdp('Runtime.evaluate', { expression: `(() => ({
      status:document.querySelector('#map-status')?.textContent,
      toneCap:Number(document.querySelector('#legend')?.dataset.toneCap),
      toneExponent:Number(document.querySelector('#legend')?.dataset.toneExponent),
      legendMode:document.querySelector('#legend .legend-heading span')?.textContent,
      legendLastTick:document.querySelector('#legend-ticks span:last-child')?.textContent,
      displayScale:Number(document.querySelector('.analysis-raster')?.dataset.displayScale),
      naturalWidth:document.querySelector('.analysis-raster')?.naturalWidth,
      naturalHeight:document.querySelector('.analysis-raster')?.naturalHeight,
      opacity:Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity),
      opacityLabel:document.querySelector('#analysis-opacity-value')?.textContent,
      storyAction:document.querySelector('#story-action')?.textContent,
      viewport:document.querySelector('#viewport-label')?.textContent
    }))()`, returnByValue:true });
    const shot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
    await writeFile(outputPath, Buffer.from(shot.data, 'base64'));
    return result.result.value;
  };
  const scale320 = await captureScale(scale320Output);
  const scale160 = await captureScale(scale160Output);
  const scale80 = await captureScale(scale80Output);
  const scale64 = await captureScale(scale64Output);
  scalePreviewState = { scale320, scale160, scale80, scale64 };
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#go-world')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 1200));
}

if (submitJob) {
  await cdp('Runtime.evaluate', { expression: `
    document.querySelectorAll('#job-resolutions input').forEach(input => input.checked = input.value === '1000');
    document.querySelector('#job-force').checked = true;
    document.querySelector('#job-delay').value = '2500';
    document.querySelector('#render-selected').click();
  ` });
  await new Promise(resolve => setTimeout(resolve, 1400));
}

if (exercise) {
  const bootstrap = await fetch(new URL('/api/bootstrap', targetUrl)).then(response => response.json());
  const denseSnapshot = (bootstrap.snapshots || []).find(snapshot => snapshot.source !== 'synthetic') || bootstrap.snapshots?.[0];
  const denseUrl = new URL('/api/points', targetUrl);
  denseUrl.search = new URLSearchParams({
    snapshot:denseSnapshot.snapshotId, lens:'all-zdos', limit:'50',
    minX:bootstrap.worldBounds.minX, maxX:bootstrap.worldBounds.maxX,
    minZ:bootstrap.worldBounds.minZ, maxZ:bootstrap.worldBounds.maxZ
  });
  const denseResult = await fetch(denseUrl).then(response => response.json());
  densePointState = {
    truncated:denseResult.truncated,
    presented:denseResult.points?.length,
    minimumCount:denseResult.minimumCount,
    limit:denseResult.limit
  };

  await cdp('Runtime.evaluate', { expression: `document.querySelector('[data-lens="all-zdos"]')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 900));
  for (let step = 0; step < 6; step++) {
    await cdp('Runtime.evaluate', { expression: `document.querySelector('.leaflet-control-zoom-in')?.click()` });
    await new Promise(resolve => setTimeout(resolve, 360));
  }
  await new Promise(resolve => setTimeout(resolve, 1200));
  const denseUiResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    title:document.querySelector('#story-title')?.textContent,
    copy:document.querySelector('#story-copy')?.textContent,
    exactState:document.querySelector('#exact-state')?.textContent,
    action:document.querySelector('#story-action')?.textContent,
    exactPointCanvases:document.querySelectorAll('.leaflet-exact-pane canvas').length,
    localDetailRasters:document.querySelectorAll('.local-detail-raster').length
  }))()`, returnByValue:true });
  denseUiState = denseUiResult.result.value;
  const denseShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  await writeFile(denseOutput, Buffer.from(denseShot.data, 'base64'));
  const earlyInspectRect = await cdp('Runtime.evaluate', {
    expression: `(() => { const r=document.querySelector('#map').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()`,
    returnByValue:true
  });
  const denseMap = earlyInspectRect.result.value;
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#story-action')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 120));
  await cdp('Runtime.evaluate', { expression: `
    document.querySelectorAll('.map-story,.navigator-shell,.map-status,.legend,.leaflet-control-container')
      .forEach(element => element.style.pointerEvents='none');
  ` });
  await cdp('Input.dispatchMouseEvent', {
    type:'mousePressed', x:denseMap.x+denseMap.w*.01, y:denseMap.y+denseMap.h*.01,
    button:'left', buttons:1, clickCount:1
  });
  await cdp('Input.dispatchMouseEvent', {
    type:'mouseMoved', x:denseMap.x+denseMap.w*.5, y:denseMap.y+denseMap.h*.5,
    button:'left', buttons:1
  });
  await cdp('Input.dispatchMouseEvent', {
    type:'mouseMoved', x:denseMap.x+denseMap.w*.99, y:denseMap.y+denseMap.h*.99,
    button:'left', buttons:1
  });
  await cdp('Input.dispatchMouseEvent', {
    type:'mouseReleased', x:denseMap.x+denseMap.w*.99, y:denseMap.y+denseMap.h*.99,
    button:'left', buttons:0, clickCount:1
  });
  await cdp('Runtime.evaluate', { expression: `
    document.querySelectorAll('.map-story,.navigator-shell,.map-status,.legend,.leaflet-control-container')
      .forEach(element => element.style.pointerEvents='');
  ` });
  await new Promise(resolve => setTimeout(resolve, 1800));
  const earlyInspectResult = await cdp('Runtime.evaluate', { expression: `(() => {
    const warning=document.querySelector('#inspect-point-warning');
    const selectionAction=document.querySelector('#story-selection-action');
    const showAll=document.querySelector('#inspect-show-all');
    return {
      tool:document.querySelector('#tool-state')?.textContent,
      selectionPresent:Boolean(document.querySelector('.selection-rectangle')),
      inspectorVisible:!document.querySelector('#inspector')?.hidden,
      total:Number((document.querySelector('#inspect-total')?.textContent || '').replace(/[^0-9]/g,'')),
      tabState:document.querySelector('#inspect-tab-state')?.textContent,
      warningVisible:Boolean(warning && !warning.hidden),
      warning:warning?.textContent,
      exactPointCanvases:document.querySelectorAll('.leaflet-exact-pane canvas').length,
      selectionActionVisible:Boolean(selectionAction && !selectionAction.hidden),
      selectionActionText:selectionAction?.textContent,
      rankedLabel:document.querySelector('#inspect-ranked-label')?.textContent,
      rankRows:document.querySelectorAll('#inspect-top .rank-row').length,
      showAllVisible:Boolean(showAll && !showAll.hidden),
      showAllText:showAll?.textContent
    };
  })()`, returnByValue:true });
  earlyInspectState = earlyInspectResult.result.value;
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#story-selection-action')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 1300));
  const earlySelectionItemsResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    actionText:document.querySelector('#story-selection-action')?.textContent,
    actionDisabled:document.querySelector('#story-selection-action')?.disabled,
    exactState:document.querySelector('#exact-state')?.textContent,
    warning:document.querySelector('#inspect-point-warning')?.textContent,
    exactPointCanvases:document.querySelectorAll('.leaflet-exact-pane canvas').length
  }))()`, returnByValue:true });
  earlySelectionItemsState = earlySelectionItemsResult.result.value;
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#inspect-show-all')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 2600));
  const expandedInspectResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    rankedLabel:document.querySelector('#inspect-ranked-label')?.textContent,
    rankRows:document.querySelectorAll('#inspect-top .rank-row').length,
    showAllHidden:document.querySelector('#inspect-show-all')?.hidden,
    queryTime:document.querySelector('#inspect-query-time')?.textContent
  }))()`, returnByValue:true });
  expandedInspectState = expandedInspectResult.result.value;
  const earlyInspectShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  await writeFile(earlyInspectOutput, Buffer.from(earlyInspectShot.data, 'base64'));
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#inspect-close')?.click()` });
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#go-world')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 1100));

  await cdp('Runtime.evaluate', { expression: `
    document.querySelector('[data-lens="birch-trees"]')?.click();
    document.querySelector('[data-tool="pan"]')?.click();
  ` });
  await new Promise(resolve => setTimeout(resolve, 1200));
  if (useStoryAction) {
    await cdp('Runtime.evaluate', { expression: `document.querySelector('#story-action')?.click()` });
    await new Promise(resolve => setTimeout(resolve, 150));
    const storyActionResult = await cdp('Runtime.evaluate', { expression: `(() => ({
      active:document.querySelector('#story-action')?.classList.contains('active'),
      tool:document.querySelector('#tool-state')?.textContent
    }))()`, returnByValue:true });
    storyActionState = storyActionResult.result.value;
    await cdp('Runtime.evaluate', { expression: `document.querySelector('[data-tool="pan"]')?.click()` });
  }
  const rectResult = await cdp('Runtime.evaluate', {
    expression: `(() => { const r=document.querySelector('#map').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()`,
    returnByValue: true
  });
  const r = rectResult.result.value;
  const drag = async (x1,y1,x2,y2, shift=false, captureMarquee=false) => {
    const modifiers = shift ? 8 : 0;
    await cdp('Input.dispatchMouseEvent', { type:'mousePressed', x:x1, y:y1, button:'left', buttons:1, clickCount:1, modifiers });
    await cdp('Input.dispatchMouseEvent', { type:'mouseMoved', x:x2, y:y2, button:'left', buttons:1, modifiers });
    if (captureMarquee) {
      await new Promise(resolve => setTimeout(resolve, 180));
      const captured = await cdp('Runtime.evaluate', { expression: `(() => {
        const box = document.querySelector('.box-zoom-rectangle');
        if (!box) return { present:false };
        const style = getComputedStyle(box), rect = box.getBoundingClientRect();
        const map = document.querySelector('#map');
        const svg = box.ownerSVGElement;
        const mapStyle = getComputedStyle(map);
        const pane = box.closest('.leaflet-pane');
        const paneStyle = getComputedStyle(pane);
        const paneRect = pane.getBoundingClientRect();
        const mapPane = pane.closest('.leaflet-map-pane'), mapPaneStyle = getComputedStyle(mapPane);
        const mapPaneRect = mapPane.getBoundingClientRect();
        const svgStyle = getComputedStyle(svg);
        const mapRect = map.getBoundingClientRect(), svgRect = svg.getBoundingClientRect();
        return { present:true, borderStyle:style.strokeDasharray === 'none' ? 'solid' : 'dashed',
          borderColor:style.stroke, backgroundColor:style.fill, strokeOpacity:style.strokeOpacity,
          fillOpacity:style.fillOpacity, opacity:style.opacity, display:style.display, visibility:style.visibility,
          left:rect.left, top:rect.top, width:rect.width, height:rect.height, path:box.getAttribute('d'),
          paneZIndex:paneStyle.zIndex, active:document.body.classList.contains('box-zoom-active'),
          paneRect:{left:paneRect.left,top:paneRect.top,width:paneRect.width,height:paneRect.height},
          paneTransform:paneStyle.transform, panePosition:paneStyle.position, paneTop:paneStyle.top, paneLeft:paneStyle.left,
          mapPaneRect:{left:mapPaneRect.left,top:mapPaneRect.top,width:mapPaneRect.width,height:mapPaneRect.height},
          mapPaneTransform:mapPaneStyle.transform,
          mapOutline:mapStyle.outlineStyle, mapBoxShadow:mapStyle.boxShadow,
          mapRect:{left:mapRect.left,top:mapRect.top,width:mapRect.width,height:mapRect.height},
          svgRect:{left:svgRect.left,top:svgRect.top,width:svgRect.width,height:svgRect.height},
          svgTransform:svgStyle.transform, svgViewBox:svg.getAttribute('viewBox') };
      })()`, returnByValue:true });
      marqueeState = captured.result.value;
      const marqueeShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
      await writeFile(marqueeOutput, Buffer.from(marqueeShot.data, 'base64'));
    }
    await cdp('Input.dispatchMouseEvent', { type:'mouseReleased', x:x2, y:y2, button:'left', buttons:0, clickCount:1, modifiers });
  };

  const panBeforeResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    cursor:getComputedStyle(document.querySelector('#map')).cursor,
    mapPaneTransform:document.querySelector('#map .leaflet-map-pane')?.style.transform || ''
  }))()`, returnByValue:true });
  const panStartX = r.x+r.w*.53, panStartY = r.y+r.h*.52;
  const panEndX = r.x+r.w*.61, panEndY = r.y+r.h*.60;
  await cdp('Input.dispatchMouseEvent', { type:'mousePressed', x:panStartX, y:panStartY, button:'left', buttons:1, clickCount:1 });
  await cdp('Input.dispatchMouseEvent', { type:'mouseMoved', x:panEndX, y:panEndY, button:'left', buttons:1 });
  await new Promise(resolve => setTimeout(resolve, 180));
  const panActiveResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    cursor:getComputedStyle(document.querySelector('#map')).cursor,
    active:document.body.classList.contains('map-pan-active'),
    mapPaneTransform:document.querySelector('#map .leaflet-map-pane')?.style.transform || ''
  }))()`, returnByValue:true });
  await cdp('Input.dispatchMouseEvent', { type:'mouseReleased', x:panEndX, y:panEndY, button:'left', buttons:0, clickCount:1 });
  await new Promise(resolve => setTimeout(resolve, 700));
  const panAfterResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    active:document.body.classList.contains('map-pan-active')
  }))()`, returnByValue:true });
  panGestureState = {
    readyCursor:panBeforeResult.result.value.cursor,
    activeCursor:panActiveResult.result.value.cursor,
    activeWhileHeld:panActiveResult.result.value.active,
    released:!panAfterResult.result.value.active,
    viewportMoved:panBeforeResult.result.value.mapPaneTransform !== panActiveResult.result.value.mapPaneTransform
  };
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#go-world')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 900));
  await drag(r.x+r.w*.37, r.y+r.h*.3, r.x+r.w*.66, r.y+r.h*.72, true, true);
  if (!marqueeOnly) {
    await new Promise(resolve => setTimeout(resolve, 1800));
    await drag(r.x+r.w*.38, r.y+r.h*.32, r.x+r.w*.68, r.y+r.h*.72, true);
    await new Promise(resolve => setTimeout(resolve, 2200));
    await drag(r.x+r.w*.38, r.y+r.h*.32, r.x+r.w*.68, r.y+r.h*.72, true);
    await new Promise(resolve => setTimeout(resolve, 2200));
    await drag(r.x+r.w*.34, r.y+r.h*.28, r.x+r.w*.72, r.y+r.h*.76, true);
    await new Promise(resolve => setTimeout(resolve, 2800));
    await drag(r.x+r.w*.34, r.y+r.h*.28, r.x+r.w*.72, r.y+r.h*.76, true);
    await new Promise(resolve => setTimeout(resolve, 3200));
    await drag(r.x+r.w*.3, r.y+r.h*.24, r.x+r.w*.76, r.y+r.h*.8, true);
    await new Promise(resolve => setTimeout(resolve, 3200));
    await drag(r.x+r.w*.3, r.y+r.h*.24, r.x+r.w*.76, r.y+r.h*.8, true);
    await new Promise(resolve => setTimeout(resolve, 3200));
    await cdp('Runtime.evaluate', { expression: `document.querySelector('[data-tool="inspect"]')?.click()` });
    await drag(r.x+r.w*.60, r.y+r.h*.68, r.x+r.w*.72, r.y+r.h*.90);
    await new Promise(resolve => setTimeout(resolve, 1800));
    await cdp('Runtime.evaluate', { expression: `document.querySelector('#story-selection-action')?.click()` });
    await new Promise(resolve => setTimeout(resolve, 1300));
    const selectedItemsResult = await cdp('Runtime.evaluate', { expression: `(() => ({
      actionText:document.querySelector('#story-selection-action')?.textContent,
      actionActive:document.querySelector('#story-selection-action')?.classList.contains('active'),
      exactState:document.querySelector('#exact-state')?.textContent,
      exactPointCanvases:document.querySelectorAll('.leaflet-exact-pane canvas').length,
      selectionPresent:document.querySelector('.selection-rectangle')?.isConnected === true
    }))()`, returnByValue:true });
    selectedItemsState = selectedItemsResult.result.value;
    const tabResult = await cdp('Runtime.evaluate', { expression: `(() => {
      const selection = document.querySelector('.selection-rectangle');
      document.querySelector('#job-bench-tab').click();
      const jobsVisible = !document.querySelector('#job-bench-pane').hidden;
      document.querySelector('#inspect-panel-tab').click();
      return { jobsVisible, inspectVisible:!document.querySelector('#inspector').hidden,
        selectionPreserved:selection?.isConnected === true,
        inspectTabActive:document.querySelector('#inspect-panel-tab').classList.contains('active') };
    })()`, returnByValue:true });
    inspectorTabState = tabResult.result.value;

    const postInspectBefore = await cdp('Runtime.evaluate', { expression: `(() => ({
      cursor:getComputedStyle(document.querySelector('#map')).cursor,
      tool:document.querySelector('#tool-state')?.textContent,
      selection:document.querySelector('.selection-rectangle')?.isConnected === true,
      mapPaneTransform:document.querySelector('#map .leaflet-map-pane')?.style.transform || ''
    }))()`, returnByValue:true });
    const inspectPanStartX = r.x+r.w*.48, inspectPanStartY = r.y+r.h*.48;
    const inspectPanEndX = r.x+r.w*.55, inspectPanEndY = r.y+r.h*.55;
    await cdp('Input.dispatchMouseEvent', { type:'mousePressed', x:inspectPanStartX, y:inspectPanStartY, button:'left', buttons:1, clickCount:1 });
    await cdp('Input.dispatchMouseEvent', { type:'mouseMoved', x:inspectPanEndX, y:inspectPanEndY, button:'left', buttons:1 });
    await new Promise(resolve => setTimeout(resolve, 180));
    const postInspectActive = await cdp('Runtime.evaluate', { expression: `(() => ({
      cursor:getComputedStyle(document.querySelector('#map')).cursor,
      active:document.body.classList.contains('map-pan-active'),
      mapPaneTransform:document.querySelector('#map .leaflet-map-pane')?.style.transform || ''
    }))()`, returnByValue:true });
    await cdp('Input.dispatchMouseEvent', { type:'mouseReleased', x:inspectPanEndX, y:inspectPanEndY, button:'left', buttons:0, clickCount:1 });
    await new Promise(resolve => setTimeout(resolve, 700));
    const postInspectAfter = await cdp('Runtime.evaluate', { expression: `(() => ({
      active:document.body.classList.contains('map-pan-active'),
      tool:document.querySelector('#tool-state')?.textContent,
      selection:document.querySelector('.selection-rectangle')?.isConnected === true
    }))()`, returnByValue:true });
    postInspectPanState = {
      readyCursor:postInspectBefore.result.value.cursor,
      activeCursor:postInspectActive.result.value.cursor,
      activeWhileHeld:postInspectActive.result.value.active,
      released:!postInspectAfter.result.value.active,
      viewportMoved:postInspectBefore.result.value.mapPaneTransform !== postInspectActive.result.value.mapPaneTransform,
      toolBefore:postInspectBefore.result.value.tool,
      toolAfter:postInspectAfter.result.value.tool,
      selectionPreserved:postInspectBefore.result.value.selection && postInspectAfter.result.value.selection
    };
    await cdp('Runtime.evaluate', { expression: `document.querySelector('#inspect-zoom')?.click()` });
    await new Promise(resolve => setTimeout(resolve, 900));

    const captureLocalDetail = async threshold => {
      await cdp('Runtime.evaluate', { expression: `(() => {
        const input = document.querySelector('#threshold-detail4');
        input.value = '${threshold}';
        input.dispatchEvent(new Event('change', { bubbles:true }));
      })()` });
      await new Promise(resolve => setTimeout(resolve, 2200));
      const result = await cdp('Runtime.evaluate', { expression: `(() => {
        const local = document.querySelector('.local-detail-raster');
        const world = document.querySelector('.analysis-raster');
        const context = document.querySelector('.leaflet-context-pane .context-raster');
        const detailState = {
          scale:document.querySelector('#scale-state')?.textContent,
          status:document.querySelector('#map-status')?.textContent,
          exactState:document.querySelector('#exact-state')?.textContent,
          detailMetric:document.querySelector('#metric-detail')?.textContent,
          localCount:document.querySelectorAll('.local-detail-raster').length,
          localCellSize:Number((document.querySelector('#scale-state')?.textContent.match(/(4|8) M LOCAL/) || [])[1]),
          localImageRendering:local ? getComputedStyle(local).imageRendering : null,
          localOpacity:local ? Number(getComputedStyle(local).opacity) : null,
          localNaturalSize:local ? { width:local.naturalWidth, height:local.naturalHeight } : null,
          worldOpacity:world ? Number(getComputedStyle(world).opacity) : null,
          contextOpacity:context ? Number(getComputedStyle(context).opacity) : null,
          contextOpacityLabel:document.querySelector('#context-opacity-value')?.textContent,
          activeSteps:[...document.querySelectorAll('#detail-ladder .active')].map(step => step.dataset.detail),
          exactPointCanvases:document.querySelectorAll('.leaflet-exact-pane canvas').length
        };
        const peek = document.querySelector('#peek-context');
        peek.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true }));
        detailState.peekContextOpacity = context ? Number(getComputedStyle(context).opacity) : null;
        detailState.peekLocalOpacity = local ? Number(getComputedStyle(local).opacity) : null;
        peek.dispatchEvent(new PointerEvent('pointerup', { bubbles:true }));
        detailState.restoredContextOpacity = context ? Number(getComputedStyle(context).opacity) : null;
        return detailState;
      })()`, returnByValue:true });
      return result.result.value;
    };
    localDetail8State = await captureLocalDetail(99);
    const handoffBefore = await cdp('Runtime.evaluate', { expression: `(() => {
      const local = document.querySelector('.local-detail-raster');
      return { src:local?.getAttribute('src'), scale:document.querySelector('#scale-state')?.textContent };
    })()`, returnByValue:true });
    await cdp('Runtime.evaluate', { expression: `(() => {
      window.__labOriginalFetch = window.fetch;
      window.fetch = async (...args) => {
        if (String(args[0]).includes('/api/points')) await new Promise(resolve => setTimeout(resolve,650));
        return window.__labOriginalFetch(...args);
      };
      document.querySelector('#threshold-detail4').value = '-99';
      document.querySelector('.leaflet-control-zoom-in')?.click();
    })()` });
    await new Promise(resolve => setTimeout(resolve,420));
    const handoffHeld = await cdp('Runtime.evaluate', { expression: `(() => {
      const local = document.querySelector('.local-detail-raster');
      const world = document.querySelector('.analysis-raster');
      return {
        src:local?.getAttribute('src'), localCount:document.querySelectorAll('.local-detail-raster').length,
        localOpacity:local ? Number(getComputedStyle(local).opacity) : null,
        worldOpacity:world ? Number(getComputedStyle(world).opacity) : null,
        scale:document.querySelector('#scale-state')?.textContent,
        exactState:document.querySelector('#exact-state')?.textContent,
        story:document.querySelector('#story-title')?.textContent
      };
    })()`, returnByValue:true });
    await new Promise(resolve => setTimeout(resolve,1500));
    const handoffAfter = await cdp('Runtime.evaluate', { expression: `(() => {
      const local = document.querySelector('.local-detail-raster');
      window.fetch = window.__labOriginalFetch;
      delete window.__labOriginalFetch;
      return {
        src:local?.getAttribute('src'), localCount:document.querySelectorAll('.local-detail-raster').length,
        localOpacity:local ? Number(getComputedStyle(local).opacity) : null,
        scale:document.querySelector('#scale-state')?.textContent,
        exactState:document.querySelector('#exact-state')?.textContent
      };
    })()`, returnByValue:true });
    bufferedHandoffState = {
      before:handoffBefore.result.value,
      held:handoffHeld.result.value,
      after:handoffAfter.result.value
    };
    localDetail4State = await captureLocalDetail(-99);
    const detailShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
    await writeFile(detailOutput, Buffer.from(detailShot.data, 'base64'));
  }
}

const evaluated = await cdp('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.querySelector('#story-title')?.textContent,
    status: document.querySelector('#map-status')?.textContent,
    cacheChip: document.querySelector('#cache-chip')?.textContent,
    scales: document.querySelector('#lens-availability')?.textContent,
    legendVisible: !document.querySelector('#legend')?.hidden,
    phaseCount: document.querySelectorAll('.phase').length,
    jobActivity: document.querySelector('#job-activity')?.textContent,
    runNavState: document.querySelector('#run-nav-state')?.textContent,
    jobSummary: document.querySelector('#job-summary')?.textContent,
    inspectorVisible: !document.querySelector('#inspector')?.hidden,
    inspectorParent: document.querySelector('#inspector')?.parentElement?.className,
    inspectorPosition: getComputedStyle(document.querySelector('#inspector')).position,
    inspectTotal: document.querySelector('#inspect-total')?.textContent,
    inspectRankRows: document.querySelectorAll('#inspect-top .rank-row').length,
    exactState: document.querySelector('#exact-state')?.textContent,
    toolState: document.querySelector('#tool-state')?.textContent,
    storyAction: document.querySelector('#story-action')?.textContent,
    storyActionActive: document.querySelector('#story-action')?.classList.contains('active'),
    leafletPanePosition: getComputedStyle(document.querySelector('#map .leaflet-pane')).position,
    leafletZoomButtonSize: (() => { const r=document.querySelector('.leaflet-control-zoom-in').getBoundingClientRect(); return {width:r.width,height:r.height}; })(),
    exactCanvases: [...document.querySelectorAll('.leaflet-exact-pane canvas')].map(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let alphaPixels = 0, minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) {
        const pixel = (i - 3) / 4, x = pixel % canvas.width, y = Math.floor(pixel / canvas.width);
        alphaPixels++; minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      return { width: canvas.width, height: canvas.height, alphaPixels, alphaBounds:{minX,minY,maxX,maxY},
        opacity: getComputedStyle(canvas).opacity, display: getComputedStyle(canvas).display,
        transform: canvas.style.transform };
    }),
    exactSvgPaths: document.querySelectorAll('.leaflet-exact-pane path').length,
    viewport: document.querySelector('#viewport-label')?.textContent,
    publicExperience: document.body.classList.contains('public-experience'),
    publicWorld: document.querySelector('#public-world-name')?.textContent,
    primaryNavDisplay: getComputedStyle(document.querySelector('.primary-nav')).display,
    controlsDisplay: getComputedStyle(document.querySelector('.controls-panel')).display,
    jobsPanelDisplay: getComputedStyle(document.querySelector('.jobs-panel')).display,
    mapWidth: document.querySelector('#map').getBoundingClientRect().width,
    minimapImages: [...document.querySelectorAll('#minimap img.leaflet-image-layer')].map(img => ({
      src: img.getAttribute('src'), opacity: getComputedStyle(img).opacity,
      width: img.naturalWidth, height: img.naturalHeight,
      transform: img.style.transform
    }))
  })`,
  returnByValue: true
});
const state = JSON.parse(evaluated.result.value);
const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, Buffer.from(shot.data, 'base64'));

console.log(JSON.stringify({ targetUrl, output, marqueeOutput:exercise ? marqueeOutput : null,
  denseOutput:exercise ? denseOutput : null, earlyInspectOutput:exercise ? earlyInspectOutput : null,
  detailOutput:exercise ? detailOutput : null,
  scale320Output:scalePreviews ? scale320Output : null, scale160Output:scalePreviews ? scale160Output : null,
  scale80Output:scalePreviews ? scale80Output : null, scale64Output:scalePreviews ? scale64Output : null,
  publicInspectOutput:publicInspect ? publicInspectOutput : null,
  state, marqueeState, inspectorTabState, panGestureState, densePointState, denseUiState, earlyInspectState,
  earlySelectionItemsState, expandedInspectState, selectedItemsState, postInspectPanState, storyActionState,
  localDetail8State, localDetail4State, bufferedHandoffState,
  rasterStyleState, scalePreviewState, publicInspectState, publicClosedState, errors }, null, 2));
await cdp('Browser.close').catch(() => {});
socket.close();
setTimeout(() => browser.kill(), 1000).unref();
if (errors.length || !state.legendVisible || /NO RASTER|Preparing/.test(`${state.status} ${state.title}`) ||
    (publicExperience && (!state.publicExperience || !/Comfy Era 17/.test(state.publicWorld || '') ||
      state.primaryNavDisplay !== 'none' || state.controlsDisplay !== 'none' ||
      (!publicInspect && state.jobsPanelDisplay !== 'none'))) ||
    (!publicExperience && (state.publicExperience || state.primaryNavDisplay === 'none' ||
      state.controlsDisplay === 'none' || state.jobsPanelDisplay === 'none')) ||
    (publicInspect && (!publicExperience || !publicInspectState?.inspectionOpen ||
      publicInspectState?.jobsPanelDisplay !== 'flex' || !publicInspectState?.inspectorVisible ||
      publicInspectState?.jobBenchDisplay !== 'none' || !publicInspectState?.selectionPresent ||
      !publicInspectState?.selectionActionVisible || publicInspectState?.selectionAction !== 'Show items' ||
      publicInspectState?.inspectTitle !== 'What was built here?' || publicInspectState?.rankRows < 1 ||
      publicClosedState?.inspectionOpen || publicClosedState?.jobsPanelDisplay !== 'none' ||
      !publicClosedState?.selectionPresent || !publicClosedState?.selectionActionVisible ||
      publicClosedState?.mapWidth <= publicInspectState?.mapWidth)) ||
    rasterStyleState?.initial?.mode !== 'smooth' || rasterStyleState?.initial?.world !== 'auto' ||
    rasterStyleState?.initial?.context !== 'auto' || rasterStyleState?.initial?.worldOpacity !== 1 ||
    rasterStyleState?.initial?.contextOpacity !== .42 || !rasterStyleState?.initial?.smoothActive ||
    !/82%.*100%/.test(rasterStyleState?.initial?.opacityLabel || '') ||
    rasterStyleState?.initial?.toneCap !== 1 || rasterStyleState?.initial?.toneExponent !== 1.75 ||
    rasterStyleState?.initial?.legendMode !== 'OVERVIEW LOG' ||
    /\+$/.test(rasterStyleState?.initial?.legendLastTick || '') ||
    rasterStyleState?.cells?.mode !== 'cells' || !['pixelated','crisp-edges'].includes(rasterStyleState?.cells?.world) ||
    !['pixelated','crisp-edges'].includes(rasterStyleState?.cells?.context) || !rasterStyleState?.cells?.cellsActive ||
    rasterStyleState?.restored?.mode !== 'smooth' || rasterStyleState?.restored?.world !== 'auto' ||
    rasterStyleState?.restored?.context !== 'auto' || !rasterStyleState?.restored?.smoothActive ||
    (scalePreviews && (!/320 m cells/.test(scalePreviewState?.scale320?.status || '') ||
      !/160 m cells/.test(scalePreviewState?.scale160?.status || '') ||
      !/80 m cells/.test(scalePreviewState?.scale80?.status || '') ||
      !/64 m cells/.test(scalePreviewState?.scale64?.status || '') ||
      scalePreviewState?.scale320?.toneCap !== 1 ||
      scalePreviewState?.scale320?.toneExponent !== 1.18 ||
      !(scalePreviewState?.scale320?.toneCap > scalePreviewState?.scale160?.toneCap &&
        scalePreviewState?.scale160?.toneCap > scalePreviewState?.scale80?.toneCap &&
        scalePreviewState?.scale80?.toneCap > scalePreviewState?.scale64?.toneCap) ||
      scalePreviewState?.scale320?.legendMode !== 'MAX LOG' || scalePreviewState?.scale160?.legendMode !== 'SCALE LOG' ||
      scalePreviewState?.scale80?.legendMode !== 'SCALE LOG' || scalePreviewState?.scale64?.legendMode !== 'P99.5 LOG' ||
      scalePreviewState?.scale320?.displayScale !== 2 || scalePreviewState?.scale160?.displayScale !== 2 ||
      scalePreviewState?.scale80?.displayScale !== 2 || scalePreviewState?.scale64?.displayScale !== 2 ||
      scalePreviewState?.scale320?.naturalWidth !== 332 || scalePreviewState?.scale160?.naturalWidth !== 664 ||
      scalePreviewState?.scale80?.naturalWidth !== 1326 || scalePreviewState?.scale64?.naturalWidth !== 1658 ||
      scalePreviewState?.scale320?.opacity !== 1 || !/z-5\.00/.test(scalePreviewState?.scale320?.viewport || '') ||
      scalePreviewState?.scale160?.opacity !== .82 || !/z-4\.00/.test(scalePreviewState?.scale160?.viewport || '') ||
      scalePreviewState?.scale80?.opacity !== .82 || !/z-3\.00/.test(scalePreviewState?.scale80?.viewport || '') ||
      scalePreviewState?.scale64?.opacity !== .82 || !/z-2\.00/.test(scalePreviewState?.scale64?.viewport || '') ||
      !/Inspect an area/.test(scalePreviewState?.scale320?.storyAction || '') ||
      !/Inspect an area/.test(scalePreviewState?.scale160?.storyAction || '') ||
      !/Inspect an area/.test(scalePreviewState?.scale80?.storyAction || '') ||
      !/Inspect an area/.test(scalePreviewState?.scale64?.storyAction || '') ||
      /\+$/.test(scalePreviewState?.scale320?.legendLastTick || '') || !/\+$/.test(scalePreviewState?.scale160?.legendLastTick || '') ||
      !/\+$/.test(scalePreviewState?.scale80?.legendLastTick || '') || !/\+$/.test(scalePreviewState?.scale64?.legendLastTick || ''))) ||
    (submitJob && !/RUNNING|QUEUED/.test(state.jobActivity || '')) ||
    (exercise && (!marqueeState?.present || marqueeState.borderStyle !== 'dashed' || !marqueeState.active ||
      marqueeState.left < marqueeState.mapRect.left || marqueeState.top < marqueeState.mapRect.top ||
      marqueeState.left + marqueeState.width > marqueeState.mapRect.left + marqueeState.mapRect.width ||
      marqueeState.top + marqueeState.height > marqueeState.mapRect.top + marqueeState.mapRect.height ||
      state.leafletPanePosition !== 'absolute' || state.leafletZoomButtonSize.width < 24 || state.leafletZoomButtonSize.height < 24 ||
      !/ONLY/.test(state.cacheChip || '') || !densePointState?.truncated || densePointState.presented !== 0 ||
      densePointState.minimumCount !== densePointState.limit + 1 || panGestureState?.readyCursor !== 'grab' ||
      panGestureState?.activeCursor !== 'grabbing' || !panGestureState?.activeWhileHeld || !panGestureState?.released ||
      !panGestureState?.viewportMoved || !/At least/.test(denseUiState?.title || '') ||
      !/complete/.test(denseUiState?.copy || '') || !/RASTER/.test(denseUiState?.exactState || '') ||
      !/Inspect an area/.test(denseUiState?.action || '') ||
      denseUiState?.exactPointCanvases !== 0 || denseUiState?.localDetailRasters !== 0 ||
      earlyInspectState?.tool !== 'PAN' || !earlyInspectState?.selectionPresent ||
      !earlyInspectState?.inspectorVisible || earlyInspectState?.total <= 5000 ||
      !earlyInspectState?.warningVisible || !/summary is complete/.test(earlyInspectState?.warning || '') ||
      !/5,000/.test(earlyInspectState?.warning || '') || earlyInspectState?.exactPointCanvases !== 0 ||
      !earlyInspectState?.selectionActionVisible || earlyInspectState?.selectionActionText !== 'Show items' ||
      earlyInspectState?.rankRows !== 10 || !/TOP 10 OF/.test(earlyInspectState?.rankedLabel || '') ||
      !earlyInspectState?.showAllVisible || !/Show all/.test(earlyInspectState?.showAllText || '') ||
      earlySelectionItemsState?.actionText !== 'Show items' || !/SELECTED.*RASTER/.test(earlySelectionItemsState?.exactState || '') ||
      !/tighten the green area/.test(earlySelectionItemsState?.warning || '') || earlySelectionItemsState?.exactPointCanvases !== 0 ||
      !expandedInspectState?.showAllHidden || expandedInspectState?.rankRows <= earlyInspectState?.rankRows ||
      !/ALL/.test(expandedInspectState?.rankedLabel || '') ||
      (useStoryAction && (!storyActionState?.active || storyActionState?.tool !== 'INSPECT')) ||
      (!marqueeOnly && (!state.inspectorVisible || !/jobs-panel/.test(state.inspectorParent || '') || state.inspectorPosition === 'absolute' ||
        state.inspectRankRows < 1 || !inspectorTabState?.jobsVisible || !inspectorTabState?.inspectVisible ||
        !inspectorTabState?.selectionPreserved || !inspectorTabState?.inspectTabActive ||
        selectedItemsState?.actionText !== 'Hide items' || !selectedItemsState?.actionActive ||
        !/SELECTED POINTS/.test(selectedItemsState?.exactState || '') || selectedItemsState?.exactPointCanvases < 1 ||
        !selectedItemsState?.selectionPresent ||
        postInspectPanState?.readyCursor !== 'grab' || postInspectPanState?.activeCursor !== 'grabbing' ||
        !postInspectPanState?.activeWhileHeld || !postInspectPanState?.released || !postInspectPanState?.viewportMoved ||
        postInspectPanState?.toolBefore !== 'PAN' || postInspectPanState?.toolAfter !== 'PAN' ||
        !postInspectPanState?.selectionPreserved ||
        !/Birch trees/.test(state.status) || state.exactState === 'RASTER' ||
        localDetail8State?.localCount !== 1 || localDetail8State?.localCellSize !== 8 ||
        localDetail8State?.localImageRendering !== 'auto' || !localDetail8State?.activeSteps?.includes('8') ||
        !localDetail8State?.activeSteps?.includes('points') || localDetail8State?.exactPointCanvases < 1 ||
        localDetail4State?.localCount !== 1 || localDetail4State?.localCellSize !== 4 ||
        localDetail4State?.localImageRendering !== 'auto' || !localDetail4State?.activeSteps?.includes('4') ||
        !localDetail4State?.activeSteps?.includes('points') || localDetail4State?.exactPointCanvases < 1 ||
        localDetail8State?.worldOpacity !== 0 || localDetail8State?.contextOpacity >= .2 ||
        localDetail8State?.contextOpacity >= localDetail8State?.localOpacity ||
        !/→/.test(localDetail8State?.contextOpacityLabel || '') ||
        localDetail8State?.peekContextOpacity < .4 || localDetail8State?.peekLocalOpacity !== .03 ||
        localDetail8State?.restoredContextOpacity !== localDetail8State?.contextOpacity ||
        bufferedHandoffState?.held?.src !== bufferedHandoffState?.before?.src ||
        bufferedHandoffState?.held?.localCount !== 1 || bufferedHandoffState?.held?.localOpacity <= 0 ||
        bufferedHandoffState?.held?.worldOpacity !== 0 || !/8 M LOCAL/.test(bufferedHandoffState?.held?.scale || '') ||
        !/HELD/.test(bufferedHandoffState?.held?.exactState || '') || /Loading/.test(bufferedHandoffState?.held?.story || '') ||
        bufferedHandoffState?.after?.src === bufferedHandoffState?.before?.src ||
        bufferedHandoffState?.after?.localCount !== 1 || !/4 M LOCAL/.test(bufferedHandoffState?.after?.scale || '') ||
        !/4 M/.test(bufferedHandoffState?.after?.exactState || '') ||
        localDetail4State?.worldOpacity !== 0 || localDetail4State?.contextOpacity >= .2 ||
        localDetail4State?.contextOpacity >= localDetail4State?.localOpacity ||
        !/→/.test(localDetail4State?.contextOpacityLabel || '') ||
        localDetail4State?.peekContextOpacity < .4 || localDetail4State?.peekLocalOpacity !== .03 ||
        localDetail4State?.restoredContextOpacity !== localDetail4State?.contextOpacity))))) process.exitCode = 1;
