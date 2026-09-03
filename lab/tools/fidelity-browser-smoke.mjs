import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const base = new URL(process.argv[2] || 'http://127.0.0.1:8091/');
const outputDir = path.resolve(process.argv[3] || 'data/fidelity-browser-smoke');

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url); this.id = 1; this.pending = new Map(); this.events = [];
  }
  async open() {
    await new Promise((resolve,reject) => { this.socket.onopen=resolve; this.socket.onerror=reject; });
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const item=this.pending.get(message.id); this.pending.delete(message.id);
        message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
      } else if (message.method) this.events.push(message);
    };
    return this;
  }
  call(method,params={}) {
    const id=this.id++; this.socket.send(JSON.stringify({id,method,params}));
    return new Promise((resolve,reject) => this.pending.set(id,{resolve,reject}));
  }
  close() { this.socket.close(); }
}

const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
async function value(page, expression) {
  const result = await page.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function wait(page, expression, timeout=60000) {
  const deadline=Date.now()+timeout;
  while (Date.now()<deadline) { if (await value(page,expression)) return; await delay(100); }
  throw new Error(`Timed out waiting for ${expression}`);
}

await mkdir(outputDir,{recursive:true});
const profile = await mkdtemp(path.join(os.tmpdir(),'steward-fidelity-smoke-'));
const browser = spawn(chrome,[
  '--headless=new','--no-first-run','--disable-default-apps','--disable-extensions',
  '--disable-background-networking','--disable-component-update','--disable-sync','--mute-audio',
  '--enable-features=WebGPUDeveloperFeatures','--remote-debugging-port=0','--remote-allow-origins=*',
  '--window-size=1800,1100',`--user-data-dir=${profile}`,'about:blank'
],{stdio:['ignore','ignore','pipe'],windowsHide:true});
let stderr='';
try {
  const browserWs = await new Promise((resolve,reject) => {
    const timer=setTimeout(() => reject(new Error(`Chrome did not expose DevTools: ${stderr}`)),12000);
    browser.stderr.on('data',chunk => {
      stderr += chunk.toString(); const found=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (found) { clearTimeout(timer); resolve(found[1]); }
    });
    browser.once('exit',code => reject(new Error(`Chrome exited early (${code}): ${stderr}`)));
  });
  const debuggerBase=browserWs.replace('ws://','http://').replace(/\/devtools\/browser\/.*$/,'');
  const url=new URL('rnd/fidelity',base);
  const target=await fetch(`${debuggerBase}/json/new?${encodeURIComponent(url.href)}`,{method:'PUT'}).then(r=>r.json());
  const page=await new Cdp(target.webSocketDebuggerUrl).open();
  await page.call('Page.enable'); await page.call('Runtime.enable');
  await wait(page,`(() => {
    const frame=document.querySelector('#render');
    return document.querySelector('#promotion')?.textContent.includes('REJECTED') &&
      frame?.contentWindow?.__stewardSceneReceipt?.status === 'ready';
  })()`,90000);

  const initial=await value(page,`(() => {
    const frame=document.querySelector('#render'), receipt=frame.contentWindow.__stewardSceneReceipt;
    const frameRect=frame.getBoundingClientRect(), sourceRect=document.querySelector('#source').getBoundingClientRect();
    return {promotion:document.querySelector('#promotion').textContent,source:document.querySelector('#source').currentSrc,
      pieces:receipt.pieces,instances:receipt.renderInstances,compounds:receipt.representationQuality.runtimeCompoundProxy,
      presentation:receipt.presentationVariant,rndCandidate:receipt.rndCandidate,cameraFrame:receipt.cameraFrame,
      cameraFov:receipt.cameraFov,drawCalls:receipt.drawCalls,frameAspect:frameRect.width/frameRect.height,
      sourceAspect:sourceRect.width/sourceRect.height};
  })()`);
  if (!initial.promotion.includes('REJECTED') || initial.pieces!==864 || initial.instances!==867 ||
      initial.compounds!==1 || initial.presentation!=='candidate' || initial.rndCandidate!==true ||
      initial.cameraFrame!=='gallery-exact' || initial.cameraFov!==65 ||
      Math.abs(initial.frameAspect-16/9)>.01 || Math.abs(initial.sourceAspect-16/9)>.01) {
    throw new Error(`candidate/exact-camera contract failed: ${JSON.stringify(initial)}`);
  }

  const compare=await value(page,`(() => {
    document.querySelector('input[name=mode][value=wipe]').click();
    const slider=document.querySelector('#blend'); slider.value='25'; slider.dispatchEvent(new Event('input'));
    const wipe={mode:document.querySelector('#comparison').dataset.mode,clip:document.querySelector('.render').style.clipPath};
    document.querySelector('input[name=mode][value=overlay]').click();
    return {...wipe,overlayMode:document.querySelector('#comparison').dataset.mode,
      opacity:document.querySelector('.render').style.opacity};
  })()`);
  if (compare.mode!=='wipe' || !compare.clip.includes('75%') || compare.overlayMode!=='overlay' || compare.opacity!=='0.25') {
    throw new Error(`wipe/overlay controls failed: ${JSON.stringify(compare)}`);
  }

  await value(page,"document.querySelector('input[name=representation][value=baseline]').click(); true");
  await wait(page,"document.querySelector('#render')?.contentWindow?.__stewardSceneReceipt?.presentationVariant === 'baseline'");
  const baseline=await value(page,`(() => { const r=document.querySelector('#render').contentWindow.__stewardSceneReceipt;
    return {pieces:r.pieces,instances:r.renderInstances,compounds:r.representationQuality.runtimeCompoundProxy,
      presentation:r.presentationVariant}; })()`);
  if (baseline.pieces!==864 || baseline.instances!==864 || baseline.compounds!==0 || baseline.presentation!=='baseline') {
    throw new Error(`baseline contract failed: ${JSON.stringify(baseline)}`);
  }

  await value(page,"document.querySelector('input[name=representation][value=candidate]').click(); true");
  await wait(page,"document.querySelector('#render')?.contentWindow?.__stewardSceneReceipt?.presentationVariant === 'candidate'");
  await value(page,`(() => { const box=document.querySelector('#isolate'); box.checked=true;
    box.dispatchEvent(new Event('change')); return true; })()`);
  await wait(page,"document.querySelector('#render')?.contentWindow?.__stewardSceneReceipt?.drawCalls === 2");
  const isolated=await value(page,"document.querySelector('#render').contentWindow.__stewardSceneReceipt.drawCalls");
  const errors=page.events.filter(event => event.method==='Runtime.exceptionThrown' ||
    event.method==='Runtime.consoleAPICalled' && event.params.type==='error');
  if (errors.length) throw new Error(`browser errors: ${JSON.stringify(errors)}`);

  const screenshot=await page.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile(path.join(outputDir,'workbench.png'),Buffer.from(screenshot.data,'base64'));
  const receipt={schema:'steward-fidelity-browser-smoke/v1',generatedAt:new Date().toISOString(),
    baseUrl:base.href,initial,compare,baseline,isolated,status:'ok'};
  await writeFile(path.join(outputDir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt,null,2));
  page.close();
} finally {
  browser.kill(); await delay(300); await rm(profile,{recursive:true,force:true});
}
