import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const targetUrl = process.argv[2] || 'http://127.0.0.1:8091/';
const output = path.resolve(process.argv[3] || 'data/browser-smoke.png');
const parsedOutput = path.parse(output);
const marqueeOutput = path.join(parsedOutput.dir, `${parsedOutput.name}-marquee${parsedOutput.ext || '.png'}`);
const exercise = process.argv.includes('--exercise');
const submitJob = process.argv.includes('--submit-job');
let marqueeState = null;
const profile = path.resolve('data/browser-smoke-profile');
await mkdir(profile, { recursive: true });

const browser = spawn(chrome, [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=0',
  '--window-size=1920,1080', `--user-data-dir=${profile}`, 'about:blank'
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
  await cdp('Runtime.evaluate', { expression: `
    document.querySelector('[data-lens="birch-trees"]')?.click();
    document.querySelector('[data-tool="pan"]')?.click();
  ` });
  await new Promise(resolve => setTimeout(resolve, 1200));
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
        const box = document.querySelector('.leaflet-zoom-box');
        if (!box) return { present:false };
        const style = getComputedStyle(box), rect = box.getBoundingClientRect();
        return { present:true, borderStyle:style.borderTopStyle, borderColor:style.borderTopColor,
          backgroundColor:style.backgroundColor, width:rect.width, height:rect.height,
          active:document.body.classList.contains('box-zoom-active') };
      })()`, returnByValue:true });
      marqueeState = captured.result.value;
      const marqueeShot = await cdp('Page.captureScreenshot', { format:'png', captureBeyondViewport:false });
      await writeFile(marqueeOutput, Buffer.from(marqueeShot.data, 'base64'));
    }
    await cdp('Input.dispatchMouseEvent', { type:'mouseReleased', x:x2, y:y2, button:'left', buttons:0, clickCount:1, modifiers });
  };
  await drag(r.x+r.w*.37, r.y+r.h*.3, r.x+r.w*.66, r.y+r.h*.72, true, true);
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
  await drag(r.x+r.w*.44, r.y+r.h*.42, r.x+r.w*.59, r.y+r.h*.62);
  await new Promise(resolve => setTimeout(resolve, 1800));
}

const evaluated = await cdp('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.querySelector('#story-title')?.textContent,
    status: document.querySelector('#map-status')?.textContent,
    scales: document.querySelector('#lens-availability')?.textContent,
    legendVisible: !document.querySelector('#legend')?.hidden,
    phaseCount: document.querySelectorAll('.phase').length,
    jobActivity: document.querySelector('#job-activity')?.textContent,
    runNavState: document.querySelector('#run-nav-state')?.textContent,
    jobSummary: document.querySelector('#job-summary')?.textContent,
    inspectorVisible: !document.querySelector('#inspector')?.hidden,
    exactState: document.querySelector('#exact-state')?.textContent,
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

console.log(JSON.stringify({ targetUrl, output, marqueeOutput:exercise ? marqueeOutput : null, state, marqueeState, errors }, null, 2));
await cdp('Browser.close').catch(() => {});
socket.close();
setTimeout(() => browser.kill(), 1000).unref();
if (errors.length || !state.legendVisible || /NO RASTER|Preparing/.test(`${state.status} ${state.title}`) ||
    (submitJob && !/RUNNING|QUEUED/.test(state.jobActivity || '')) ||
    (exercise && (!state.inspectorVisible || !/Birch trees/.test(state.status) || state.exactState === 'RASTER' ||
      !marqueeState?.present || marqueeState.borderStyle !== 'dashed' || !marqueeState.active))) process.exitCode = 1;
