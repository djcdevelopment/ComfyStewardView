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
const quickStartOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-quick-start${parsedOutput.ext || '.png'}`);
const feedbackOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-feedback${parsedOutput.ext || '.png'}`);
const terrainCloseOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-terrain-close${parsedOutput.ext || '.png'}`);
const biomeOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-biomes${parsedOutput.ext || '.png'}`);
const biomeOverviewOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-biomes-overview${parsedOutput.ext || '.png'}`);
const biomeLassoOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-biomes-lasso${parsedOutput.ext || '.png'}`);
const topographicOverviewOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-topographic-overview${parsedOutput.ext || '.png'}`);
const topographicDetailOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-topographic-detail${parsedOutput.ext || '.png'}`);
const exercise = process.argv.includes('--exercise');
const scalePreviews = process.argv.includes('--scale-previews');
const marqueeOnly = process.argv.includes('--marquee-only');
const useStoryAction = process.argv.includes('--story-action');
const submitJob = process.argv.includes('--submit-job');
const publicInspect = process.argv.includes('--public-inspect');
const terrainClose = process.argv.includes('--terrain-close');
const biomes = process.argv.includes('--biomes');
const terrain = process.argv.includes('--terrain') || process.argv.includes('--topographic');
let publicExperience = new URL(targetUrl).searchParams.get('lab') !== '1';
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
let publicShellState = null;
let terrainCloseState = null;
let biomeState = null;
let terrainState = null;
let initialTerrainState = null;
let modeTransitionState = null;
const profile = path.resolve(`data/browser-smoke-profile-${process.pid}`);
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

async function waitForExpression(expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue:true });
    if (result.result.value === true) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Browser condition did not become ready: ${expression}\n${errors.join('\n')}`);
}

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Page.navigate', { url: targetUrl });
await waitForExpression(`(() => {
  const analysis=document.querySelector('.analysis-raster');
  const context=document.querySelector('.leaflet-context-pane .context-raster');
  const publicExperience=document.body.classList.contains('public-experience');
  const publicReady=!publicExperience || Boolean(document.querySelector('#feedback-open')?.title);
  const analysisReady=publicExperience || (analysis?.complete === true && analysis.naturalWidth > 0);
  return publicReady && analysisReady &&
    context?.complete === true && context.naturalWidth > 0 &&
    !/Preparing|Loading/.test(document.querySelector('#map-status')?.textContent || '');
})()`, 45000);
await new Promise(resolve => setTimeout(resolve, 250));

const renderedMode = await cdp('Runtime.evaluate', {
  expression: `document.body.classList.contains('public-experience')`, returnByValue:true
});
publicExperience = renderedMode.result.value === true;

if (publicExperience) {
  const initialResult = await cdp('Runtime.evaluate', { expression: `(() => {
    const context=document.querySelector('.leaflet-context-pane .context-raster');
    const analysis=document.querySelector('.analysis-raster');
    return {
      terrainMode:document.body.classList.contains('terrain-mode'),
      activeButtons:[...document.querySelectorAll('[data-view-mode].active')].map(button => button.dataset.viewMode),
      pressedButtons:[...document.querySelectorAll('[data-view-mode][aria-pressed="true"]')].map(button => button.dataset.viewMode),
      buttonLabels:[...document.querySelectorAll('[data-view-mode]')].map(button => button.textContent.trim()),
      topographicButtonPresent:Boolean(document.querySelector('[data-view-mode="topographic"]')),
      contextSrc:context?.getAttribute('src'),
      contextOpacity:Number(getComputedStyle(context).opacity),
      analysisCount:document.querySelectorAll('.analysis-raster,.local-detail-raster').length,
      analysisOpacity:analysis ? Number(getComputedStyle(analysis).opacity) : 0,
      biomeTiles:document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile').length,
      legendVisible:!document.querySelector('#legend')?.hidden,
      exactState:document.querySelector('#exact-state')?.textContent,
      exactAlpha:[...document.querySelectorAll('.leaflet-exact-pane canvas')].reduce((sum,canvas) => {
        const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        for(let i=3;i<pixels.length;i+=4) if(pixels[i]) sum++;
        return sum;
      },0),
      story:document.querySelector('#story-title')?.textContent
    };
  })()`, returnByValue:true });
  initialTerrainState = initialResult.result.value;

  const guideResult = await cdp('Runtime.evaluate', { expression: `(() => {
    const guideButton = document.querySelector('#quick-start-open');
    const feedbackButton = document.querySelector('#feedback-open');
    const guide = document.querySelector('#quick-start-dialog');
    return {
      guideButtonVisible:getComputedStyle(guideButton).display !== 'none',
      feedbackButtonVisible:getComputedStyle(feedbackButton).display !== 'none',
      feedbackEnabled:feedbackButton?.disabled === false,
      open:guide?.open === true,
      title:document.querySelector('#quick-start-title')?.textContent,
      cta:document.querySelector('#quick-start-done')?.textContent,
      steps:[...document.querySelectorAll('.guide-steps strong')].map(node => node.textContent.trim()),
      copy:[...document.querySelectorAll('.guide-steps p')].map(node => node.textContent.trim())
    };
  })()`, returnByValue:true });
  const quickStartShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  await writeFile(quickStartOutput, Buffer.from(quickStartShot.data, 'base64'));

  const dismissalKey = 'steward-world-quick-start-terrain-v1';
  const dismissWithClick = async selector => {
    const result = await cdp('Runtime.evaluate', { expression: `(() => {
      localStorage.removeItem(${JSON.stringify(dismissalKey)});
      if (!document.querySelector('#quick-start-dialog')?.open) document.querySelector('#quick-start-open')?.click();
      document.querySelector(${JSON.stringify(selector)})?.click();
      return {
        closed:document.querySelector('#quick-start-dialog')?.open === false,
        stored:localStorage.getItem(${JSON.stringify(dismissalKey)}) === 'dismissed'
      };
    })()`, returnByValue:true });
    return result.result.value;
  };
  const closeButtonDismissal = await dismissWithClick('#quick-start-close');
  const ctaDismissal = await dismissWithClick('#quick-start-done');
  await cdp('Runtime.evaluate', { expression: `(() => {
    localStorage.removeItem(${JSON.stringify(dismissalKey)});
    document.querySelector('#quick-start-open')?.click();
  })()` });
  await cdp('Input.dispatchKeyEvent', { type:'rawKeyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await cdp('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await waitForExpression(`document.querySelector('#quick-start-dialog')?.open === false`);
  const escapeDismissal = (await cdp('Runtime.evaluate', { expression: `localStorage.getItem(${JSON.stringify(dismissalKey)}) === 'dismissed'`, returnByValue:true })).result.value;
  const backdropDismissalResult = await cdp('Runtime.evaluate', { expression: `(() => {
    localStorage.removeItem(${JSON.stringify(dismissalKey)});
    document.querySelector('#quick-start-open')?.click();
    document.querySelector('#quick-start-dialog')?.click();
    return {
      closed:document.querySelector('#quick-start-dialog')?.open === false,
      stored:localStorage.getItem(${JSON.stringify(dismissalKey)}) === 'dismissed'
    };
  })()`, returnByValue:true });
  const backdropDismissal = backdropDismissalResult.result.value;

  await cdp('Page.reload', { ignoreCache:true });
  await new Promise(resolve => setTimeout(resolve, 500));
  await waitForExpression(`(() => {
    const context=document.querySelector('.leaflet-context-pane .context-raster');
    return Boolean(document.querySelector('#feedback-open')?.title) && context?.complete === true &&
      context.naturalWidth > 0 && document.querySelector('#quick-start-dialog')?.open === false;
  })()`, 45000);
  const persistenceResult = await cdp('Runtime.evaluate', { expression: `(() => {
    const before=document.querySelector('#quick-start-dialog')?.open === false;
    document.querySelector('#quick-start-open')?.click();
    const manual=document.querySelector('#quick-start-dialog')?.open === true;
    document.querySelector('#quick-start-done')?.click();
    return { before, manual };
  })()`, returnByValue:true });

  await cdp('Runtime.evaluate', { expression: `localStorage.removeItem(${JSON.stringify(dismissalKey)})` });
  const discordReturnUrl = new URL(targetUrl);
  discordReturnUrl.searchParams.set('discord', 'error');
  await cdp('Page.navigate', { url:discordReturnUrl.href });
  await new Promise(resolve => setTimeout(resolve, 500));
  await waitForExpression(`(() => {
    const context=document.querySelector('.leaflet-context-pane .context-raster');
    return context?.complete === true && context.naturalWidth > 0 && document.querySelector('#feedback-dialog')?.open === true;
  })()`, 45000);
  const feedbackResult = await cdp('Runtime.evaluate', { expression: `(() => {
    const feedback = document.querySelector('#feedback-dialog');
    return {
      open:feedback?.open === true,
      quickStartSuppressed:document.querySelector('#quick-start-dialog')?.open === false,
      title:document.querySelector('#feedback-title')?.textContent,
      anonymousDefault:document.querySelector('#feedback-identify')?.checked === false,
      identityAvailable:document.querySelector('#feedback-identify')?.disabled === false,
      contextCopy:document.querySelector('.feedback-context')?.textContent,
      submitText:document.querySelector('#feedback-submit')?.textContent
    };
  })()`, returnByValue:true });
  const feedbackShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  await writeFile(feedbackOutput, Buffer.from(feedbackShot.data, 'base64'));
  const closedResult = await cdp('Runtime.evaluate', { expression: `(() => {
    document.querySelector('#feedback-cancel')?.click();
    document.querySelector('#quick-start-open')?.click();
    const manualAfterDiscord=document.querySelector('#quick-start-dialog')?.open === true;
    document.querySelector('#quick-start-done')?.click();
    return {
      manualAfterDiscord,
      dialogsClosed:document.querySelector('#quick-start-dialog')?.open === false &&
        document.querySelector('#feedback-dialog')?.open === false
    };
  })()`, returnByValue:true });
  publicShellState = {
    guideButtonVisible:guideResult.result.value.guideButtonVisible,
    feedbackButtonVisible:guideResult.result.value.feedbackButtonVisible,
    feedbackEnabled:guideResult.result.value.feedbackEnabled,
    guide:{
      open:guideResult.result.value.open,
      title:guideResult.result.value.title,
      cta:guideResult.result.value.cta,
      steps:guideResult.result.value.steps,
      copy:guideResult.result.value.copy
    },
    dismissals:{
      closeButton:closeButtonDismissal,
      cta:ctaDismissal,
      escape:escapeDismissal,
      backdrop:backdropDismissal
    },
    persistence:persistenceResult.result.value,
    feedback:feedbackResult.result.value,
    manualAfterDiscord:closedResult.result.value.manualAfterDiscord,
    dialogsClosed:closedResult.result.value.dialogsClosed
  };

  const clickMode = async (mode, readyExpression) => {
    await cdp('Runtime.evaluate', { expression: `document.querySelector('[data-view-mode=${JSON.stringify(mode)}]')?.click()` });
    await waitForExpression(readyExpression, 45000);
  };
  const captureMode = async () => (await cdp('Runtime.evaluate', { expression: `(() => ({
    terrainMode:document.body.classList.contains('terrain-mode'),
    biomeMode:document.body.classList.contains('biome-mode'),
    active:[...document.querySelectorAll('[data-view-mode].active')].map(button => button.dataset.viewMode),
    pressed:[...document.querySelectorAll('[data-view-mode][aria-pressed="true"]')].map(button => button.dataset.viewMode),
    contextSrc:document.querySelector('.leaflet-context-pane .context-raster')?.getAttribute('src'),
    contextOpacity:Number(getComputedStyle(document.querySelector('.leaflet-context-pane .context-raster')).opacity),
    heatOpacity:document.querySelector('.analysis-raster') ? Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity) : 0,
    legendVisible:!document.querySelector('#legend')?.hidden,
    biomeTiles:document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile').length,
    biomeAlpha:[...document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile')].reduce((sum,canvas) => {
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      for(let i=3;i<pixels.length;i+=4) if(pixels[i]) sum++;
      return sum;
    },0),
    meadowsActive:document.querySelector('[data-biome="meadows"]')?.classList.contains('active'),
    noneActive:document.querySelector('[data-biome="none"]')?.classList.contains('active'),
    biomeControlsDisabled:document.querySelector('#biome-filter-group')?.disabled
  }))()`, returnByValue:true })).result.value;

  await clickMode('heatmap', `Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity) > 0 && !document.querySelector('#legend')?.hidden`);
  const heatActivated = await captureMode();
  const offGlobePoint = (await cdp('Runtime.evaluate', { expression: `(() => {
    const bounds=document.querySelector('#map').getBoundingClientRect();
    return { x:bounds.left + bounds.width*.03, y:bounds.top + bounds.height*.75 };
  })()`, returnByValue:true })).result.value;
  const clickOffGlobe = async () => {
    await cdp('Input.dispatchMouseEvent', { type:'mousePressed', x:offGlobePoint.x, y:offGlobePoint.y, button:'left', clickCount:1 });
    await cdp('Input.dispatchMouseEvent', { type:'mouseReleased', x:offGlobePoint.x, y:offGlobePoint.y, button:'left', clickCount:1 });
    await new Promise(resolve => setTimeout(resolve, 250));
    return (await cdp('Runtime.evaluate', { expression: `(() => ({
      inspectionOpen:document.body.classList.contains('inspection-open'),
      selectionPresent:Boolean(document.querySelector('.selection-rectangle'))
    }))()`, returnByValue:true })).result.value;
  };
  const offGlobeHeat = await clickOffGlobe();
  await clickMode('heatmap', `document.body.classList.contains('terrain-mode') && document.querySelectorAll('[data-view-mode].active').length === 0 && (document.querySelector('.leaflet-context-pane .context-raster')?.getAttribute('src') || '').includes('/api/context/topographic-overview')`);
  const heatDeactivated = await captureMode();
  const offGlobeTerrain = await clickOffGlobe();
  await clickMode('biomes', `document.body.classList.contains('biome-mode') && document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile').length > 0`);
  await clickMode('heatmap', `document.querySelector('[data-view-mode="heatmap"]')?.classList.contains('active') && document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile').length === 0 && Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity) > 0 && !document.querySelector('#legend')?.hidden`);
  const directToHeat = await captureMode();
  await clickMode('biomes', `document.querySelector('[data-view-mode="biomes"]')?.classList.contains('active') && document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile').length > 0 && document.querySelector('#legend')?.hidden`);
  await cdp('Runtime.evaluate', { expression: `document.querySelector('[data-biome="meadows"]')?.click()` });
  await waitForExpression(`document.querySelector('[data-biome="meadows"]')?.classList.contains('active') === true`);
  const directToBiomes = await captureMode();
  await clickMode('biomes', `document.body.classList.contains('terrain-mode') && document.querySelectorAll('[data-view-mode].active').length === 0 && document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile').length === 0`);
  const biomesDeactivated = await captureMode();
  await clickMode('biomes', `document.body.classList.contains('biome-mode') && document.querySelector('[data-biome="meadows"]')?.classList.contains('active') === true && document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile').length > 0`);
  const biomesRestored = await captureMode();
  await cdp('Runtime.evaluate', { expression: `document.querySelector('[data-biome="none"]')?.click()` });
  await waitForExpression(`[...document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile')].every(canvas => {
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    for(let i=3;i<pixels.length;i+=4) if(pixels[i]) return false;
    return true;
  })`);
  const biomesNone = await captureMode();
  await clickMode('biomes', `document.body.classList.contains('terrain-mode') && document.querySelectorAll('[data-view-mode].active').length === 0`);
  const biomesSecondClick = await captureMode();
  modeTransitionState = { heatActivated, heatDeactivated, offGlobeHeat, offGlobeTerrain,
    directToHeat, directToBiomes, biomesDeactivated, biomesRestored, biomesNone, biomesSecondClick };
  await clickMode('heatmap', `Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity) > 0 && !document.querySelector('#legend')?.hidden`);
}

const rasterStyleResult = await cdp('Runtime.evaluate', { expression: `(() => {
  const capture = () => ({
    mode: document.body.classList.contains('raster-cells') ? 'cells' : 'smooth',
    world: getComputedStyle(document.querySelector('.analysis-raster')).imageRendering,
    context: getComputedStyle(document.querySelector('.context-raster')).imageRendering,
    worldOpacity: Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity),
    contextOpacity: Number(getComputedStyle(document.querySelector('.context-raster')).opacity),
    requestedContextOpacity: Number(document.querySelector('#context-opacity')?.value),
    contextSrc: document.querySelector('.leaflet-context-pane .context-raster')?.getAttribute('src'),
    contextNaturalWidth: document.querySelector('.leaflet-context-pane .context-raster')?.naturalWidth,
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

if (terrainClose) {
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#go-spawn')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 900));
  for (let step = 0; step < 3; step++) {
    await cdp('Runtime.evaluate', { expression: `document.querySelector('.leaflet-control-zoom-in')?.click()` });
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await waitForExpression(`(() => {
    const context=document.querySelector('.leaflet-context-pane .context-raster');
    const local=document.querySelector('.local-detail-raster');
    return context?.naturalWidth === 4096 && local?.complete === true && local.naturalWidth > 0 &&
      !/Loading|Preparing/.test(document.querySelector('#map-status')?.textContent || '');
  })()`, 45000);
  const closeResult = await cdp('Runtime.evaluate', { expression: `(() => {
    const context=document.querySelector('.leaflet-context-pane .context-raster');
    return {
      viewport:document.querySelector('#viewport-label')?.textContent,
      contextSrc:context?.getAttribute('src'),
      contextNaturalWidth:context?.naturalWidth,
      contextOpacity:Number(getComputedStyle(context).opacity),
      requestedContextOpacity:Number(document.querySelector('#context-opacity')?.value),
      contextOpacityLabel:document.querySelector('#context-opacity-value')?.textContent,
      localDetailCount:document.querySelectorAll('.local-detail-raster').length,
      exactState:document.querySelector('#exact-state')?.textContent
    };
  })()`, returnByValue:true });
  terrainCloseState = closeResult.result.value;
  const closeShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  await writeFile(terrainCloseOutput, Buffer.from(closeShot.data, 'base64'));
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#go-world')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 1400));
}

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

if (terrain) {
  await cdp('Input.dispatchKeyEvent', { type:'rawKeyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await cdp('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await new Promise(resolve => setTimeout(resolve, 250));
  await cdp('Runtime.evaluate', { expression: `document.querySelector('[data-view-mode="heatmap"]')?.click()` });
  await waitForExpression(`(document.querySelector('.leaflet-context-pane .context-raster')?.getAttribute('src') || '').includes('/api/context/topographic-overview') && Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity) === 0`, 45000);
  const overviewResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    mode:document.body.classList.contains('terrain-mode'),
    noButtonActive:document.querySelectorAll('[data-view-mode].active').length === 0,
    topographicButtonAbsent:!document.querySelector('[data-view-mode="topographic"]'),
    contextSrc:document.querySelector('.leaflet-context-pane .context-raster')?.getAttribute('src'),
    contextOpacity:Number(getComputedStyle(document.querySelector('.leaflet-context-pane .context-raster')).opacity),
    heatOpacity:Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity),
    legendVisible:!document.querySelector('#legend')?.hidden,
    exactState:document.querySelector('#exact-state')?.textContent,
    exactAlpha:[...document.querySelectorAll('.leaflet-exact-pane canvas')].reduce((sum,canvas) => {
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      for(let i=3;i<pixels.length;i+=4) if(pixels[i]) sum++;
      return sum;
    },0)
  }))()`, returnByValue:true });
  const overviewShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  await writeFile(topographicOverviewOutput, Buffer.from(overviewShot.data, 'base64'));
  for (let step = 0; step < 8; step++) {
    await cdp('Runtime.evaluate', { expression: `document.querySelector('.leaflet-control-zoom-in')?.click()` });
    await new Promise(resolve => setTimeout(resolve, 550));
  }
  await waitForExpression(`(document.querySelector('.leaflet-context-pane .context-raster')?.getAttribute('src') || '').includes('/api/context/topographic-detail')`, 45000);
  const detailResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    contextSrc:document.querySelector('.leaflet-context-pane .context-raster')?.getAttribute('src'),
    naturalWidth:document.querySelector('.leaflet-context-pane .context-raster')?.naturalWidth,
    heatOpacity:Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity),
    story:document.querySelector('#story-title')?.textContent,
    exactState:document.querySelector('#exact-state')?.textContent
  }))()`, returnByValue:true });
  const detailShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  await writeFile(topographicDetailOutput, Buffer.from(detailShot.data, 'base64'));
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#go-world')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 1200));
  await cdp('Runtime.evaluate', { expression: `document.querySelector('[data-view-mode="heatmap"]')?.click()` });
  await waitForExpression(`Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity) > 0 && !document.body.classList.contains('terrain-mode') && !document.querySelector('#legend')?.hidden`, 30000);
  terrainState = { overview:overviewResult.result.value, detail:detailResult.result.value };
}

if (biomes) {
  await cdp('Input.dispatchKeyEvent', { type:'rawKeyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await cdp('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await new Promise(resolve => setTimeout(resolve, 250));
  await cdp('Runtime.evaluate', { expression: `document.querySelector('[data-view-mode="biomes"]')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 1200));
  await waitForExpression(`document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile').length > 0 && /OUTLINES/.test(document.querySelector('#exact-state')?.textContent || '')`, 45000);
  const overviewResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    mode:document.body.classList.contains('biome-mode'),
    filterDisabled:document.querySelector('#biome-filter-group')?.disabled,
    tiles:document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile').length,
    heatOpacity:Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity),
    contextOpacity:Number(getComputedStyle(document.querySelector('.leaflet-context-pane .context-raster')).opacity),
    exactState:document.querySelector('#exact-state')?.textContent,
    story:document.querySelector('#story-title')?.textContent,
    noneActive:document.querySelector('[data-biome="none"]')?.classList.contains('active'),
    oceanLabel:document.querySelector('[data-biome="space"] span')?.textContent,
    otherLabel:document.querySelector('[data-biome="other"] span')?.textContent,
    inspectDisabled:document.querySelector('#biome-view-results')?.disabled,
    biomeAlpha:[...document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile')].reduce((sum,canvas) => {
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      for(let i=3;i<pixels.length;i+=4) if(pixels[i]) sum++;
      return sum;
    },0),
    exactAlpha:[...document.querySelectorAll('.leaflet-exact-pane canvas')].reduce((sum,canvas) => {
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      for(let i=3;i<pixels.length;i+=4) if(pixels[i]) sum++;
      return sum;
    },0)
  }))()`, returnByValue:true });
  const biomeOverviewShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  await writeFile(biomeOverviewOutput, Buffer.from(biomeOverviewShot.data, 'base64'));
  const offGlobePointResult = await cdp('Runtime.evaluate', { expression: `(() => {
    const bounds=document.querySelector('#map').getBoundingClientRect();
    return { x:bounds.left + bounds.width*.03, y:bounds.top + bounds.height*.75 };
  })()`, returnByValue:true });
  const offGlobePoint = offGlobePointResult.result.value;
  await cdp('Input.dispatchMouseEvent', { type:'mousePressed', x:offGlobePoint.x, y:offGlobePoint.y, button:'left', clickCount:1 });
  await cdp('Input.dispatchMouseEvent', { type:'mouseReleased', x:offGlobePoint.x, y:offGlobePoint.y, button:'left', clickCount:1 });
  await new Promise(resolve => setTimeout(resolve, 250));
  const offGlobeResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    noneActive:document.querySelector('[data-biome="none"]')?.classList.contains('active'),
    selectedCount:document.querySelectorAll('#biome-chip-list .biome-chip.active:not([data-biome="none"])').length,
    inspectDisabled:document.querySelector('#biome-view-results')?.disabled
  }))()`, returnByValue:true });
  const mapPointResult = await cdp('Runtime.evaluate', { expression: `(() => {
    const bounds=document.querySelector('#map').getBoundingClientRect();
    return { x:bounds.left + bounds.width*.50, y:bounds.top + bounds.height*.52 };
  })()`, returnByValue:true });
  const mapPoint = mapPointResult.result.value;
  await cdp('Input.dispatchMouseEvent', { type:'mousePressed', x:mapPoint.x, y:mapPoint.y, button:'left', clickCount:1 });
  await cdp('Input.dispatchMouseEvent', { type:'mouseReleased', x:mapPoint.x, y:mapPoint.y, button:'left', clickCount:1 });
  await waitForExpression(`document.querySelectorAll('#biome-chip-list .biome-chip.active:not([data-biome="none"])').length === 1`, 30000);
  const mapClickResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    active:document.querySelector('#biome-chip-list .biome-chip.active:not([data-biome="none"])')?.dataset.biome,
    story:document.querySelector('#story-title')?.textContent,
    noneActive:document.querySelector('[data-biome="none"]')?.classList.contains('active'),
    inspectDisabled:document.querySelector('#biome-view-results')?.disabled
  }))()`, returnByValue:true });
  await cdp('Runtime.evaluate', { expression: `(() => {
    document.querySelector('[data-biome="none"]')?.click();
    document.querySelector('[data-biome="meadows"]')?.click();
  })()` });
  await waitForExpression(`/Meadows/.test(document.querySelector('#story-title')?.textContent || '') &&
    [...document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile')].some(canvas => {
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      for(let i=3;i<pixels.length;i+=4) if(pixels[i]) return true;
      return false;
    })`, 45000);
  for (let step = 0; step < 5; step++) {
    await cdp('Runtime.evaluate', { expression: `document.querySelector('.leaflet-control-zoom-in')?.click()` });
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  const lassoResult = await cdp('Runtime.evaluate', { expression: `(() => {
    const tiles=[...document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile')];
    return {
      zoom:document.querySelector('#viewport-label')?.textContent,
      backingScale:tiles[0] ? tiles[0].width / tiles[0].getBoundingClientRect().width : 0,
      alphaPixels:tiles.reduce((sum,canvas) => {
        const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        for(let i=3;i<pixels.length;i+=4) if(pixels[i]) sum++;
        return sum;
      },0)
    };
  })()`, returnByValue:true });
  const biomeLassoShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  await writeFile(biomeLassoOutput, Buffer.from(biomeLassoShot.data, 'base64'));
  for (let step = 0; step < 5; step++) {
    await cdp('Runtime.evaluate', { expression: `document.querySelector('.leaflet-control-zoom-out')?.click()` });
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const beforeInspectResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    exactState:document.querySelector('#exact-state')?.textContent,
    exactAlpha:[...document.querySelectorAll('.leaflet-exact-pane canvas')].reduce((sum,canvas) => {
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      for(let i=3;i<pixels.length;i+=4) if(pixels[i]) sum++;
      return sum;
    },0)
  }))()`, returnByValue:true });
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#biome-view-results')?.click()` });
  await waitForExpression(`document.body.classList.contains('inspection-open') && document.querySelectorAll('#inspect-items-list .inspect-item').length > 0 && /SAMPLE|BIOME POINTS/.test(document.querySelector('#exact-state')?.textContent || '')`, 45000);
  const selectedResult = await cdp('Runtime.evaluate', { expression: `(() => {
    const alphaPixels = [...document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile')].reduce((sum,canvas) => {
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      for(let i=3;i<pixels.length;i+=4) if(pixels[i]) sum++;
      return sum;
    },0);
    return {
      meadowsActive:document.querySelector('[data-biome="meadows"]')?.classList.contains('active'),
      noneActive:document.querySelector('[data-biome="none"]')?.classList.contains('active'),
      inspectTitle:document.querySelector('#inspect-title')?.textContent,
      inspectTotal:document.querySelector('#inspect-total')?.textContent,
      itemRows:document.querySelectorAll('#inspect-items-list .inspect-item').length,
      itemRange:document.querySelector('#inspect-items-range')?.textContent,
      nextEnabled:document.querySelector('#inspect-items-next')?.disabled === false,
      selectionPresent:Boolean(document.querySelector('.selection-rectangle')),
      alphaPixels
    };
  })()`, returnByValue:true });
  const firstRange = selectedResult.result.value.itemRange;
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#inspect-items-next')?.click()` });
  await waitForExpression(`document.querySelector('#inspect-items-range')?.textContent !== ${JSON.stringify(firstRange)}`, 30000);
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#inspect-close')?.click()` });
  for (let step = 0; step < 3; step++) {
    await cdp('Runtime.evaluate', { expression: `document.querySelector('.leaflet-control-zoom-in')?.click()` });
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  const closeResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    zoom:document.querySelector('#viewport-label')?.textContent,
    tiles:document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile').length,
    alphaPixels:[...document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile')].reduce((sum,canvas) => {
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      for(let i=3;i<pixels.length;i+=4) if(pixels[i]) sum++;
      return sum;
    },0)
  }))()`, returnByValue:true });
  const biomeShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
  await writeFile(biomeOutput, Buffer.from(biomeShot.data, 'base64'));
  await cdp('Runtime.evaluate', { expression: `document.querySelector('[data-view-mode="heatmap"]')?.click()` });
  await waitForExpression(`Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity) > 0 && document.querySelectorAll('.leaflet-biome-pane canvas.biome-tile').length === 0 && !document.querySelector('#legend')?.hidden && !/Opening|Loading/.test(document.querySelector('#story-title')?.textContent || '')`, 30000);
  const restoredResult = await cdp('Runtime.evaluate', { expression: `(() => ({
    mode:document.body.classList.contains('biome-mode'),
    heatOpacity:Number(getComputedStyle(document.querySelector('.analysis-raster')).opacity),
    legendVisible:!document.querySelector('#legend')?.hidden
  }))()`, returnByValue:true });
  biomeState = {
    overview:overviewResult.result.value,
    offGlobe:offGlobeResult.result.value,
    mapClick:mapClickResult.result.value,
    lasso:lassoResult.result.value,
    beforeInspect:beforeInspectResult.result.value,
    selected:selectedResult.result.value,
    nextRange:(await cdp('Runtime.evaluate', { expression:`document.querySelector('#inspect-items-range')?.textContent`, returnByValue:true })).result.value,
    close:closeResult.result.value,
    restored:restoredResult.result.value
  };
  await cdp('Input.dispatchKeyEvent', { type:'rawKeyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await cdp('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await new Promise(resolve => setTimeout(resolve, 250));
}

if (scalePreviews) {
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#go-world')?.click()` });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const terrainContext = /\/api\/context\/overview/.test(rasterStyleState?.initial?.contextSrc || '');
  const captureScale = async (outputPath, expectedContextWidth) => {
    await cdp('Runtime.evaluate', { expression: `document.querySelector('.leaflet-control-zoom-in')?.click()` });
    await new Promise(resolve => setTimeout(resolve, 1400));
    if (expectedContextWidth) {
      await waitForExpression(`document.querySelector('.leaflet-context-pane .context-raster')?.naturalWidth === ${expectedContextWidth}`, 30000);
    }
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
      contextSrc:document.querySelector('.leaflet-context-pane .context-raster')?.getAttribute('src'),
      contextNaturalWidth:document.querySelector('.leaflet-context-pane .context-raster')?.naturalWidth,
      storyAction:document.querySelector('#story-action')?.textContent,
      viewport:document.querySelector('#viewport-label')?.textContent
    }))()`, returnByValue:true });
    const shot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
    await writeFile(outputPath, Buffer.from(shot.data, 'base64'));
    return result.result.value;
  };
  const scale320 = await captureScale(scale320Output, terrainContext ? 2048 : null);
  const scale160 = await captureScale(scale160Output, terrainContext ? 2048 : null);
  const scale80 = await captureScale(scale80Output, terrainContext ? 2048 : null);
  const scale64 = await captureScale(scale64Output, terrainContext ? 4096 : null);
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
          requestedContextOpacity:Number(document.querySelector('#context-opacity')?.value),
          contextSrc:context?.getAttribute('src'),
          contextNaturalWidth:context?.naturalWidth,
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
const contextPresentationValid = detail => {
  const terrain = /\/api\/context\/detail/.test(detail?.contextSrc || '');
  if (terrain) {
    return detail.contextNaturalWidth === 4096 &&
      Math.abs(detail.contextOpacity - detail.requestedContextOpacity) < .01 &&
      !/→/.test(detail.contextOpacityLabel || '');
  }
  return detail?.contextOpacity < .2 && /→/.test(detail?.contextOpacityLabel || '');
};
const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, Buffer.from(shot.data, 'base64'));

console.log(JSON.stringify({ targetUrl, output, marqueeOutput:exercise ? marqueeOutput : null,
  denseOutput:exercise ? denseOutput : null, earlyInspectOutput:exercise ? earlyInspectOutput : null,
  detailOutput:exercise ? detailOutput : null,
  scale320Output:scalePreviews ? scale320Output : null, scale160Output:scalePreviews ? scale160Output : null,
  scale80Output:scalePreviews ? scale80Output : null, scale64Output:scalePreviews ? scale64Output : null,
  publicInspectOutput:publicInspect ? publicInspectOutput : null,
  quickStartOutput:publicExperience ? quickStartOutput : null,
  feedbackOutput:publicExperience ? feedbackOutput : null,
  terrainCloseOutput:terrainClose ? terrainCloseOutput : null,
  biomeOutput:biomes ? biomeOutput : null,
  biomeOverviewOutput:biomes ? biomeOverviewOutput : null,
  biomeLassoOutput:biomes ? biomeLassoOutput : null,
  topographicOverviewOutput:terrain ? topographicOverviewOutput : null,
  topographicDetailOutput:terrain ? topographicDetailOutput : null,
  state, marqueeState, inspectorTabState, panGestureState, densePointState, denseUiState, earlyInspectState,
  earlySelectionItemsState, expandedInspectState, selectedItemsState, postInspectPanState, storyActionState,
  localDetail8State, localDetail4State, bufferedHandoffState,
  rasterStyleState, scalePreviewState, publicInspectState, publicClosedState, publicShellState,
  terrainCloseState, biomeState, terrainState, initialTerrainState, modeTransitionState, errors }, null, 2));
await cdp('Browser.close').catch(() => {});
socket.close();
setTimeout(() => browser.kill(), 1000).unref();
if (errors.length || !state.legendVisible || /NO RASTER|Preparing/.test(`${state.status} ${state.title}`) ||
    (publicExperience && (!state.publicExperience || !/Comfy Era 17/.test(state.publicWorld || '') ||
      state.primaryNavDisplay !== 'none' || state.controlsDisplay !== 'none' ||
      (!publicInspect && state.jobsPanelDisplay !== 'none') ||
      !publicShellState?.guideButtonVisible || !publicShellState?.feedbackButtonVisible ||
      !publicShellState?.feedbackEnabled || !publicShellState?.guide?.open ||
      publicShellState?.guide?.title !== 'Start with the world. Add the question you want to ask.' ||
      publicShellState?.guide?.cta !== 'Explore the terrain' ||
      publicShellState?.guide?.steps?.length !== 5 ||
      publicShellState?.guide?.steps?.join('|') !== 'Read the terrain|Move|Reveal activity|Explore territories|Inspect' ||
      !publicShellState?.guide?.copy?.[3]?.includes('None leaves the map unmarked') ||
      !publicShellState?.dismissals?.closeButton?.closed || !publicShellState?.dismissals?.closeButton?.stored ||
      !publicShellState?.dismissals?.cta?.closed || !publicShellState?.dismissals?.cta?.stored ||
      !publicShellState?.dismissals?.escape || !publicShellState?.dismissals?.backdrop?.closed ||
      !publicShellState?.dismissals?.backdrop?.stored || !publicShellState?.persistence?.before ||
      !publicShellState?.persistence?.manual || !publicShellState?.feedback?.quickStartSuppressed ||
      !publicShellState?.feedback?.open || !publicShellState?.feedback?.anonymousDefault ||
      !publicShellState?.feedback?.identityAvailable ||
      !/world data and IP address will not be included/i.test(publicShellState?.feedback?.contextCopy || '') ||
      publicShellState?.feedback?.submitText !== 'Send feedback' || !publicShellState?.manualAfterDiscord ||
      !publicShellState?.dialogsClosed || !initialTerrainState?.terrainMode ||
      initialTerrainState?.activeButtons?.length !== 0 || initialTerrainState?.pressedButtons?.length !== 0 ||
      initialTerrainState?.buttonLabels?.join('|') !== 'Heatmap|Biomes' || initialTerrainState?.topographicButtonPresent ||
      !/\/api\/context\/topographic-overview/.test(initialTerrainState?.contextSrc || '') ||
      initialTerrainState?.contextOpacity !== 1 || initialTerrainState?.analysisCount !== 0 ||
      initialTerrainState?.analysisOpacity !== 0 || initialTerrainState?.biomeTiles !== 0 ||
      initialTerrainState?.legendVisible || initialTerrainState?.exactAlpha !== 0 ||
      initialTerrainState?.exactState !== 'TERRAIN' || initialTerrainState?.story !== 'Follow the shape of the world' ||
      modeTransitionState?.heatActivated?.active?.join('|') !== 'heatmap' ||
      modeTransitionState?.heatActivated?.heatOpacity <= 0 || !modeTransitionState?.heatActivated?.legendVisible ||
      !modeTransitionState?.heatDeactivated?.terrainMode || modeTransitionState?.heatDeactivated?.active?.length !== 0 ||
      modeTransitionState?.heatDeactivated?.heatOpacity !== 0 || modeTransitionState?.heatDeactivated?.legendVisible ||
      modeTransitionState?.offGlobeHeat?.inspectionOpen || modeTransitionState?.offGlobeHeat?.selectionPresent ||
      modeTransitionState?.offGlobeTerrain?.inspectionOpen || modeTransitionState?.offGlobeTerrain?.selectionPresent ||
      modeTransitionState?.directToHeat?.active?.join('|') !== 'heatmap' || modeTransitionState?.directToHeat?.biomeTiles !== 0 ||
      modeTransitionState?.directToBiomes?.active?.join('|') !== 'biomes' || !modeTransitionState?.directToBiomes?.meadowsActive ||
      !modeTransitionState?.biomesDeactivated?.terrainMode || !modeTransitionState?.biomesDeactivated?.meadowsActive ||
      !modeTransitionState?.biomesDeactivated?.biomeControlsDisabled || modeTransitionState?.biomesDeactivated?.biomeTiles !== 0 ||
      !modeTransitionState?.biomesRestored?.biomeMode || !modeTransitionState?.biomesRestored?.meadowsActive ||
      !modeTransitionState?.biomesNone?.biomeMode || !modeTransitionState?.biomesNone?.noneActive ||
      modeTransitionState?.biomesNone?.biomeAlpha !== 0 || modeTransitionState?.biomesNone?.heatOpacity !== 0 ||
      modeTransitionState?.biomesNone?.legendVisible || modeTransitionState?.biomesNone?.contextSrc !== initialTerrainState?.contextSrc ||
      modeTransitionState?.biomesNone?.contextOpacity !== initialTerrainState?.contextOpacity ||
      !modeTransitionState?.biomesSecondClick?.terrainMode || modeTransitionState?.biomesSecondClick?.active?.length !== 0)) ||
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
    rasterStyleState?.initial?.contextOpacity !== rasterStyleState?.initial?.requestedContextOpacity ||
    !rasterStyleState?.initial?.contextSrc || rasterStyleState?.initial?.contextNaturalWidth < 1 ||
    !rasterStyleState?.initial?.smoothActive ||
    !/82%.*100%/.test(rasterStyleState?.initial?.opacityLabel || '') ||
    rasterStyleState?.initial?.toneCap !== 1 || rasterStyleState?.initial?.toneExponent !== 1.75 ||
    rasterStyleState?.initial?.legendMode !== 'OVERVIEW LOG' ||
    /\+$/.test(rasterStyleState?.initial?.legendLastTick || '') ||
    rasterStyleState?.cells?.mode !== 'cells' || !['pixelated','crisp-edges'].includes(rasterStyleState?.cells?.world) ||
    !['pixelated','crisp-edges'].includes(rasterStyleState?.cells?.context) || !rasterStyleState?.cells?.cellsActive ||
    rasterStyleState?.restored?.mode !== 'smooth' || rasterStyleState?.restored?.world !== 'auto' ||
    rasterStyleState?.restored?.context !== 'auto' || !rasterStyleState?.restored?.smoothActive ||
    (terrainClose && (!/\/api\/context\/detail/.test(terrainCloseState?.contextSrc || '') ||
      terrainCloseState?.contextNaturalWidth !== 4096 || terrainCloseState?.localDetailCount !== 1 ||
      Math.abs(terrainCloseState?.contextOpacity - terrainCloseState?.requestedContextOpacity) >= .01 ||
      /→/.test(terrainCloseState?.contextOpacityLabel || ''))) ||
    (terrain && (!terrainState?.overview?.mode || !terrainState?.overview?.noButtonActive ||
      !terrainState?.overview?.topographicButtonAbsent ||
      !/\/api\/context\/topographic-overview/.test(terrainState?.overview?.contextSrc || '') ||
      terrainState?.overview?.contextOpacity !== 1 || terrainState?.overview?.heatOpacity !== 0 ||
      terrainState?.overview?.legendVisible || terrainState?.overview?.exactState !== 'TERRAIN' ||
      terrainState?.overview?.exactAlpha !== 0 ||
      !/\/api\/context\/topographic-detail/.test(terrainState?.detail?.contextSrc || '') ||
      terrainState?.detail?.naturalWidth !== 4096 || terrainState?.detail?.heatOpacity !== 0 ||
      terrainState?.detail?.exactState !== 'TERRAIN' || !/terrain/i.test(terrainState?.detail?.story || ''))) ||
    (biomes && (!biomeState?.overview?.mode || biomeState?.overview?.filterDisabled ||
      biomeState?.overview?.tiles < 1 || biomeState?.overview?.heatOpacity !== 0 || biomeState?.overview?.contextOpacity !== 1 ||
      biomeState?.overview?.oceanLabel !== 'Ocean' || biomeState?.overview?.otherLabel !== 'Mountains + Forest' ||
      !/OUTLINES/.test(biomeState?.overview?.exactState || '') || biomeState?.overview?.exactAlpha !== 0 ||
      !biomeState?.overview?.noneActive || !biomeState?.overview?.inspectDisabled || biomeState?.overview?.biomeAlpha !== 0 ||
      !biomeState?.offGlobe?.noneActive || biomeState?.offGlobe?.selectedCount !== 0 || !biomeState?.offGlobe?.inspectDisabled ||
      !biomeState?.mapClick?.active || !/highlighted/i.test(biomeState?.mapClick?.story || '') ||
      biomeState?.mapClick?.noneActive || biomeState?.mapClick?.inspectDisabled ||
      biomeState?.lasso?.backingScale < 1.9 || biomeState?.lasso?.alphaPixels < 1 ||
      !/OUTLINES/.test(biomeState?.beforeInspect?.exactState || '') || biomeState?.beforeInspect?.exactAlpha !== 0 ||
      !biomeState?.selected?.meadowsActive || biomeState?.selected?.noneActive ||
      !/Meadows/.test(biomeState?.selected?.inspectTitle || '') ||
      biomeState?.selected?.itemRows !== 100 || !biomeState?.selected?.nextEnabled ||
      biomeState?.selected?.selectionPresent || biomeState?.selected?.alphaPixels < 1 ||
      biomeState?.nextRange === biomeState?.selected?.itemRange || biomeState?.close?.tiles < 1 ||
      biomeState?.close?.alphaPixels < 1 || biomeState?.restored?.mode ||
      biomeState?.restored?.heatOpacity <= 0 || !biomeState?.restored?.legendVisible)) ||
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
      scalePreviewState?.scale320?.displayScale !== 3 || scalePreviewState?.scale160?.displayScale !== 2 ||
      scalePreviewState?.scale80?.displayScale !== 2 || scalePreviewState?.scale64?.displayScale !== 2 ||
      scalePreviewState?.scale320?.naturalWidth !== 498 || scalePreviewState?.scale160?.naturalWidth !== 664 ||
      scalePreviewState?.scale80?.naturalWidth !== 1326 || scalePreviewState?.scale64?.naturalWidth !== 1658 ||
      (/\/api\/context\/overview/.test(rasterStyleState?.initial?.contextSrc || '') &&
        (!/\/api\/context\/overview/.test(scalePreviewState?.scale80?.contextSrc || '') ||
          scalePreviewState?.scale80?.contextNaturalWidth !== 2048 ||
          !/\/api\/context\/detail/.test(scalePreviewState?.scale64?.contextSrc || '') ||
          scalePreviewState?.scale64?.contextNaturalWidth !== 4096)) ||
      scalePreviewState?.scale320?.opacity !== .92 || !/z-5\.00/.test(scalePreviewState?.scale320?.viewport || '') ||
      scalePreviewState?.scale160?.opacity !== .82 || !/z-4\.00/.test(scalePreviewState?.scale160?.viewport || '') ||
      scalePreviewState?.scale80?.opacity !== .82 || !/z-3\.00/.test(scalePreviewState?.scale80?.viewport || '') ||
      scalePreviewState?.scale64?.opacity !== .82 || !/z-2\.00/.test(scalePreviewState?.scale64?.viewport || '') ||
      !/Inspect an area/.test(scalePreviewState?.scale320?.storyAction || '') ||
      !/Inspect an area/.test(scalePreviewState?.scale160?.storyAction || '') ||
      !/Inspect an area/.test(scalePreviewState?.scale80?.storyAction || '') ||
      !/Inspect an area/.test(scalePreviewState?.scale64?.storyAction || '') ||
      (publicExperience
        ? [scalePreviewState?.scale320, scalePreviewState?.scale160, scalePreviewState?.scale80, scalePreviewState?.scale64]
          .some(scale => /\+$/.test(scale?.legendLastTick || ''))
        : /\+$/.test(scalePreviewState?.scale320?.legendLastTick || '') || !/\+$/.test(scalePreviewState?.scale160?.legendLastTick || '') ||
          !/\+$/.test(scalePreviewState?.scale80?.legendLastTick || '') || !/\+$/.test(scalePreviewState?.scale64?.legendLastTick || '')))) ||
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
        localDetail8State?.worldOpacity !== 0 || !contextPresentationValid(localDetail8State) ||
        localDetail8State?.contextOpacity >= localDetail8State?.localOpacity ||
        localDetail8State?.peekContextOpacity < .4 || localDetail8State?.peekLocalOpacity !== .03 ||
        localDetail8State?.restoredContextOpacity !== localDetail8State?.contextOpacity ||
        bufferedHandoffState?.held?.src !== bufferedHandoffState?.before?.src ||
        bufferedHandoffState?.held?.localCount !== 1 || bufferedHandoffState?.held?.localOpacity <= 0 ||
        bufferedHandoffState?.held?.worldOpacity !== 0 || !/8 M LOCAL/.test(bufferedHandoffState?.held?.scale || '') ||
        !/HELD/.test(bufferedHandoffState?.held?.exactState || '') || /Loading/.test(bufferedHandoffState?.held?.story || '') ||
        bufferedHandoffState?.after?.src === bufferedHandoffState?.before?.src ||
        bufferedHandoffState?.after?.localCount !== 1 || !/4 M LOCAL/.test(bufferedHandoffState?.after?.scale || '') ||
        !/4 M/.test(bufferedHandoffState?.after?.exactState || '') ||
        localDetail4State?.worldOpacity !== 0 || !contextPresentationValid(localDetail4State) ||
        localDetail4State?.contextOpacity >= localDetail4State?.localOpacity ||
        localDetail4State?.peekContextOpacity < .4 || localDetail4State?.peekLocalOpacity !== .03 ||
        localDetail4State?.restoredContextOpacity !== localDetail4State?.contextOpacity))))) process.exitCode = 1;
