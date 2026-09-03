import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const base = new URL(process.argv[2] || 'http://127.0.0.1:8091/');
const outputDir = path.resolve(process.argv[3] || 'data/scene-browser-smoke');
const pilotOnly = process.argv.includes('--pilot-only');
const includeLarge = process.argv.includes('--large');
const startupLimit = Number(process.env.SCENE_STARTUP_LIMIT_MS || 2000);
const largeStartupLimit = Number(process.env.SCENE_LARGE_STARTUP_LIMIT_MS || 10000);
const p95Limit = Number(process.env.SCENE_FRAME_P95_LIMIT_MS || 20);
const largeP95Limit = Number(process.env.SCENE_LARGE_FRAME_P95_LIMIT_MS || 50);
const cases = [
  { name:'pilot-862', pieces:862, families:13, coverage:{real:862,estimated:0,unknown:0,proxyOutliers:0},
    query:{snapshot:107,lens:'build-density',minX:467.8,maxX:511.6,minZ:5501.4,maxZ:5535.9} },
  ...(!pilotOnly ? [{ name:'stress-22387', pieces:22387, families:13,
    coverage:{real:22197,estimated:0,unknown:190,proxyOutliers:2},
    query:{snapshot:107,lens:'build-density',minX:2021.7,maxX:2101.9,minZ:-4851.3,maxZ:-4751.8,override:true} }] : []),
  ...(includeLarge ? [{ name:'meadows-193008', pieces:193008, minimumFamilies:10,
    query:{snapshot:107,lens:'build-density',minX:-26500,maxX:26500,minZ:-20500,maxZ:27500,
      biomes:'meadows',override:true} }] : [])
];

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.waiting = new Map();
    this.events = [];
  }
  async open() {
    await new Promise((resolve,reject) => { this.socket.onopen=resolve; this.socket.onerror=reject; });
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.waiting.has(message.id)) {
        const pending = this.waiting.get(message.id); this.waiting.delete(message.id);
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      } else if (message.method) this.events.push(message);
    };
    return this;
  }
  call(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({id,method,params}));
    return new Promise((resolve,reject) => this.waiting.set(id,{resolve,reject}));
  }
  close() { this.socket.close(); }
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));
async function waitFor(client, expression, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if (result.result?.value === true) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

function hardwareReceipt(system) {
  const gpu = system?.gpu || {};
  const text = JSON.stringify({devices:gpu.devices || [],aux:gpu.auxAttributes || {},features:gpu.featureStatus || {}}).toLowerCase();
  const software = /swiftshader|llvmpipe|software only|warp/.test(text);
  const identified = /nvidia|amd|radeon|intel|arc|geforce|apple/.test(text);
  return {
    classification:software ? 'software' : identified ? 'hardware' : 'unknown',
    devices:gpu.devices || [],
    featureStatus:gpu.featureStatus || {},
    auxAttributes:gpu.auxAttributes || {}
  };
}

await mkdir(outputDir,{recursive:true});
const profile = await mkdtemp(path.join(os.tmpdir(),'steward-scene-smoke-'));
if (!path.resolve(profile).startsWith(path.resolve(os.tmpdir()))) throw new Error('Unsafe browser profile path');
const browser = spawn(chrome,[
  '--headless=new','--no-first-run','--disable-default-apps','--disable-extensions',
  '--disable-background-networking','--disable-component-update','--disable-sync',
  '--metrics-recording-only','--mute-audio','--hide-scrollbars',
  '--run-all-compositor-stages-before-draw','--disable-renderer-backgrounding',
  '--disable-background-timer-throttling','--enable-features=WebGPUDeveloperFeatures',
  '--remote-debugging-port=0','--remote-allow-origins=*','--window-size=1600,1000',
  `--user-data-dir=${profile}`,'about:blank'
],{stdio:['ignore','ignore','pipe'],windowsHide:true});

let stderr = '';
try {
  const browserWs = await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome did not expose DevTools: ${stderr}`)),12000);
    browser.stderr.on('data',chunk => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    browser.once('exit',code => reject(new Error(`Chrome exited early (${code}): ${stderr}`)));
  });
  const browserClient = await new CdpClient(browserWs).open();
  const system = await browserClient.call('SystemInfo.getInfo');
  const hardware = hardwareReceipt(system);
  const receipts = [];

  for (const sceneCase of cases) {
    const pageUrl = new URL('scene.html',base);
    for (const [key,value] of Object.entries(sceneCase.query)) pageUrl.searchParams.set(key,String(value));
    pageUrl.searchParams.set('benchmark','1');
    const debuggerBase = browserWs.replace('ws://','http://').replace(/\/devtools\/browser\/.*$/,'');
    const target = await fetch(`${debuggerBase}/json/new?${encodeURIComponent(pageUrl.href)}`,{method:'PUT'}).then(response => response.json());
    const page = await new CdpClient(target.webSocketDebuggerUrl).open();
    await page.call('Page.enable'); await page.call('Runtime.enable');
    await waitFor(page,"['ok','error','device-lost'].includes(window.__stewardSceneReceipt?.status)",90000);
    const evaluated = await page.call('Runtime.evaluate',{
      expression:'JSON.stringify(window.__stewardSceneReceipt)',returnByValue:true
    });
    const receipt = JSON.parse(evaluated.result.value);
    const exceptions = page.events.filter(event => event.method === 'Runtime.exceptionThrown')
      .map(event => event.params.exceptionDetails?.exception?.description || event.params.exceptionDetails?.text);
    const consoleErrors = page.events.filter(event => event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
      .map(event => event.params.args.map(arg => arg.value || arg.description).join(' '));
    receipt.systemGpu = hardware;
    receipt.browserErrors = [...exceptions,...consoleErrors];

    const shaded = await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(path.join(outputDir,`${sceneCase.name}-shaded.png`),Buffer.from(shaded.data,'base64'));
    await page.call('Runtime.evaluate',{expression:"window.__stewardSceneControls.setSurface('wire')"});
    await delay(250);
    const wire = await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(path.join(outputDir,`${sceneCase.name}-wire.png`),Buffer.from(wire.data,'base64'));
    const controlResult = await page.call('Runtime.evaluate',{
      expression:`(() => {
        const surface=window.__stewardSceneReceipt.surface;
        const before=window.__stewardSceneReceipt.drawCalls;
        const first=document.querySelector('#families input'); first?.click();
        const hidden=window.__stewardSceneReceipt.drawCalls;
        document.querySelector('#families-all')?.click();
        const restored=window.__stewardSceneReceipt.drawCalls;
        window.__stewardSceneControls.setCameraMode('fly',false);
        window.__stewardSceneControls.render();
        const fly=window.__stewardSceneReceipt.cameraMode;
        window.__stewardSceneControls.frameAll();
        const all=window.__stewardSceneReceipt.cameraFrame;
        window.__stewardSceneControls.resetCamera();
        return {surface,before,hidden,restored,fly,all,
          reset:window.__stewardSceneReceipt.cameraMode,
          home:window.__stewardSceneReceipt.cameraFrame};
      })()`,
      returnByValue:true
    });
    receipt.controlExercise = controlResult.result.value;
    const imageResult = await page.call('Runtime.evaluate',{
      expression:`(async () => {
        const blob = await window.__stewardSceneControls.captureImage();
        const bitmap = await createImageBitmap(blob);
        const result = {bytes:blob.size,type:blob.type,width:bitmap.width,height:bitmap.height};
        bitmap.close();
        return result;
      })()`,
      returnByValue:true, awaitPromise:true
    });
    receipt.imageExercise = imageResult.result.value;
    receipts.push({case:sceneCase.name,url:pageUrl.href,receipt});
    page.close();

    const failures = [];
    if (receipt.status !== 'ok') failures.push(`status ${receipt.status}`);
    if (receipt.pieces !== sceneCase.pieces) failures.push(`pieces ${receipt.pieces} != ${sceneCase.pieces}`);
    if (receipt.exact !== true) failures.push('scene is not exact');
    if (receipt.forced !== Boolean(sceneCase.query.override)) failures.push(`forced receipt ${receipt.forced}`);
    if (receipt.instanceBytes !== sceneCase.pieces * 80) failures.push('instance byte count mismatch');
    if (!/^[0-9a-f]{64}$/.test(receipt.instanceSha256 || '')) failures.push('instance checksum is missing');
    if (sceneCase.families != null && receipt.families?.length !== sceneCase.families) failures.push(`families ${receipt.families?.length} != ${sceneCase.families}`);
    if (sceneCase.minimumFamilies != null && receipt.families?.length < sceneCase.minimumFamilies) failures.push(`families ${receipt.families?.length} < ${sceneCase.minimumFamilies}`);
    for (const [quality,expected] of Object.entries(sceneCase.coverage || {})) {
      if (receipt.geometryCoverage?.[quality] !== expected) {
        failures.push(`${quality} geometry ${receipt.geometryCoverage?.[quality]} != ${expected}`);
      }
    }
    const coverageTotal = ['real','estimated','unknown']
      .reduce((sum,key) => sum + Number(receipt.geometryCoverage?.[key] || 0),0);
    if (coverageTotal !== receipt.pieces) failures.push(`geometry coverage ${coverageTotal} != ${receipt.pieces}`);
    if (sceneCase.name.startsWith('meadows-') && !(receipt.geometryCoverage?.proxyOutliers > 0)) {
      failures.push('large scene did not report reduced proxy outliers');
    }
    if (receipt.deviceLost) failures.push('device lost');
    if (receipt.validationErrors?.length) failures.push(`validation errors: ${receipt.validationErrors.join('; ')}`);
    if (receipt.browserErrors?.length) failures.push(`browser errors: ${receipt.browserErrors.join('; ')}`);
    const caseStartupLimit = sceneCase.name.startsWith('meadows-') ? largeStartupLimit : startupLimit;
    if (receipt.startupMs > caseStartupLimit) failures.push(`startup ${receipt.startupMs}ms > ${caseStartupLimit}ms`);
    const caseP95Limit = sceneCase.name.startsWith('meadows-') ? largeP95Limit : p95Limit;
    if (receipt.frameP95Ms > caseP95Limit) failures.push(`p95 ${receipt.frameP95Ms}ms > ${caseP95Limit}ms`);
    if (hardware.classification !== 'hardware') failures.push(`GPU classified ${hardware.classification}`);
    const exercise = receipt.controlExercise;
    if (exercise?.surface !== 'wire') failures.push('wireframe switch failed');
    if (!(exercise?.hidden === exercise?.before - 1 && exercise?.restored === exercise?.before)) failures.push('family visibility exercise failed');
    if (exercise?.fly !== 'fly' || exercise?.reset !== 'orbit') failures.push('camera exercise failed');
    if (exercise?.all !== 'all' || exercise?.home !== 'home') failures.push('home/frame-all camera exercise failed');
    if (sceneCase.name.startsWith('meadows-') &&
        (receipt.home?.strategy !== 'densest-cluster' || !(receipt.home?.pieces < receipt.pieces) ||
         !(receipt.home?.radiusM < receipt.fullRadiusM * .5))) {
      failures.push('large scene did not start on a bounded dense home cluster');
    }
    const captured = receipt.imageExercise;
    if (captured?.type !== 'image/png' || captured?.bytes < 1_000) failures.push('WebGPU PNG capture failed');
    if (captured?.width !== receipt.canvas?.[0] || captured?.height !== receipt.canvas?.[1]) failures.push('PNG dimensions do not match the WebGPU canvas');
    if (failures.length) throw new Error(`${sceneCase.name}: ${failures.join(' | ')}`);
  }

  const result = {
    schema:'steward-scene-browser-smoke/v1', generatedAt:new Date().toISOString(),
    baseUrl:base.href, limits:{startupMs:startupLimit,largeStartupMs:largeStartupLimit,
      frameP95Ms:p95Limit,largeFrameP95Ms:largeP95Limit}, receipts
  };
  await writeFile(path.join(outputDir,'receipt.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
  browserClient.close();
} finally {
  browser.kill();
  await delay(300);
  await rm(profile,{recursive:true,force:true});
}
