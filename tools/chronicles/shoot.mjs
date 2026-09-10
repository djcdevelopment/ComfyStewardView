// Screenshots of the live archive, for the Chronicles pages that show what the archive is.
//
// The pages this photographs are the ones a reader is being told about -- find a builder,
// study a build, walk an era, ask for a photograph, read the numbers -- so the pictures
// have to come from the deployed site rather than from a mock. It drives headless Chrome
// over CDP, the same way tools/era-archive/browser-smoke.mjs does.
//
// Every step is allowed to fail. A page that has not shipped yet, a search that finds
// nobody, a dialog that moved: each of those logs a skip and the run continues, because a
// screenshot set that is missing one frame is far more useful than one that threw.
//
// Usage:
//   node tools/chronicles/shoot.mjs --base https://fx99.tail8e749c.ts.net --out shots/
//        [--width 1440] [--height 900] [--crop] [--python python]
//
// --crop also writes <name>.crop.webp, a 720x450 window onto the part of the page the
// step was actually about, cut by tools/chronicles/crop.py (Pillow).
import {spawn} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WAIT_MS = 15000;

function parseArgs(argv) {
  const out = {width: 1440, height: 900, crop: false, python: process.env.PYTHON || 'python'};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--crop') out.crop = true;
    else if (flag.startsWith('--')) out[flag.slice(2)] = argv[++i];
  }
  out.width = Number(out.width); out.height = Number(out.height);
  if (!out.base || !out.out) throw Error('Usage: shoot.mjs --base <url> --out <dir> [--width 1440] [--height 900] [--crop]');
  if (!out.base.endsWith('/')) out.base += '/';
  return out;
}

const args = parseArgs(process.argv.slice(2));
await mkdir(args.out, {recursive: true});

const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = spawn(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--remote-debugging-port=0', `--window-size=${args.width},${args.height}`,
  `--user-data-dir=${path.resolve(args.out, '.chrome-profile')}`, 'about:blank'],
  {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});

let stderr = '';
const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Chrome startup timeout')), 20000);
  browser.stderr.on('data', chunk => {
    stderr += chunk;
    const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) {clearTimeout(timer); resolve(m[1]);}
  });
  browser.once('exit', () => reject(Error('Chrome exited: ' + stderr.slice(-400))));
});
const httpBase = wsUrl.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*$/, '');
const tab = await fetch(httpBase + '/json/new?about:blank', {method: 'PUT'}).then(r => r.json());
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => socket.onopen = r);

let nextId = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const waiter = pending.get(message.id);
  pending.delete(message.id);
  message.error ? waiter.reject(Error(message.error.message)) : waiter.resolve(message.result);
};
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++nextId, {resolve, reject});
  socket.send(JSON.stringify({id: nextId, method, params}));
});
const evaluate = async expression =>
  (await cdp('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true})).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Poll rather than listen for a load event. Everything interesting on these pages arrives
// after a fetch, so "the document loaded" is the wrong question; "is the thing I am about
// to photograph on screen" is the right one.
async function until(expression, label = expression) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    let value;
    try {value = await evaluate(expression);} catch {value = false;}
    if (value) return true;
    await sleep(200);
  }
  throw Error('timed out waiting for ' + label);
}
const present = selector => until(`!!document.querySelector(${JSON.stringify(selector)})`, selector);

async function go(route) {
  const url = new URL(route.replace(/^\//, ''), args.base).href;
  await cdp('Page.navigate', {url});
  await until("document.readyState==='interactive'||document.readyState==='complete'", 'document ' + url);
  const status = await evaluate("document.title+'|'+document.body.innerText.slice(0,60)");
  if (/^(404|Error response)/.test(status)) throw Error('server returned an error page for ' + url);
  return url;
}

async function click(selector) {
  const clicked = await evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true;})()`);
  if (!clicked) throw Error('no element matching ' + selector);
}

// A full-page shot: ask the page how tall it really is and capture past the viewport.
async function capture(name, focusSelector) {
  await sleep(500);
  const metrics = await cdp('Page.getLayoutMetrics');
  const size = metrics.cssContentSize || metrics.contentSize;
  const width = Math.min(Math.ceil(size.width), 4000);
  const height = Math.min(Math.ceil(size.height), 12000);
  const shot = await cdp('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: {x: 0, y: 0, width, height, scale: 1},
  });
  const file = path.join(args.out, name + '.png');
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  const record = {name, file, width, height};
  if (args.crop) record.crop = await cropTo(file, name, focusSelector, width, height);
  return record;
}

// The crop window is 720x450 anchored just above and left of whatever the step was about,
// clamped so it never runs off the page. A frame of the whole 6000px page tells a reader
// nothing; this tells them where to look.
async function cropTo(source, name, selector, pageWidth, pageHeight) {
  const box = await evaluate(`(()=>{
    const e=document.querySelector(${JSON.stringify(selector || 'body')});
    if(!e)return null;
    const r=e.getBoundingClientRect();
    return {x:Math.round(r.left+scrollX),y:Math.round(r.top+scrollY),w:Math.round(r.width),h:Math.round(r.height)};
  })()`);
  const W = 720, H = 450;
  const anchorX = box ? box.x - 24 : 0;
  const anchorY = box ? box.y - 24 : 0;
  const x = Math.max(0, Math.min(anchorX, Math.max(0, pageWidth - W)));
  const y = Math.max(0, Math.min(anchorY, Math.max(0, pageHeight - H)));
  const destination = path.join(args.out, name + '.crop.webp');
  const result = spawn(args.python, [path.join(HERE, 'crop.py'), '--src', source, '--dst', destination,
    '--box', `${x},${y},${W},${H}`], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  let text = '';
  result.stdout.on('data', d => text += d);
  result.stderr.on('data', d => text += d);
  const code = await new Promise(r => result.once('close', r));
  if (code !== 0) {console.log(`  crop skipped (${text.trim().split('\n').pop()})`); return null;}
  return destination;
}

// name -> what to do, returning the selector the crop should centre on.
const steps = [
  ['find-search', async () => {
    await go('/valheim/creators/');
    await present('#search');
    await evaluate(`(()=>{const s=document.getElementById('search');s.value='Ibocain';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await present('#suggestions li');
    return '#suggestions';
  }],
  ['find-thread', async ctx => {
    const href = await evaluate(`(()=>{const li=document.querySelector('#suggestions li');if(!li)return null;
      const a=li.matches('a')?li:li.querySelector('a');
      if(a)return a.href;
      li.click();return location.href;})()`);
    if (!href) throw Error('no suggestion to open');
    if (href !== await evaluate('location.href')) await cdp('Page.navigate', {url: href});
    await until("document.querySelectorAll('.photos img, .album, #content details').length>0", 'thread content');
    ctx.thread = await evaluate('location.href');
    return '#title, h1';
  }],
  ['study-filters', async () => {
    await go('/valheim/');
    await until("document.querySelectorAll('.cell').length>0", 'the photo grid');
    await click('#expbtn');
    await present('.ck');
    return '.panel';
  }],
  ['study-lightbox', async () => {
    await click('#expbtn');                       // put the filter panel away first
    await click('.cell');
    await until("document.getElementById('lb')?.classList.contains('show')", '#lb.show');
    await sleep(700);
    return '#lb .info';
  }],
  ['walk-eras', async () => {
    await evaluate("typeof closeLb==='function'&&closeLb()");
    await go('/valheim/era7/');
    await until("document.querySelectorAll('.cell').length>0", 'the era7 grid');
    await click('#expbtn');
    await present('.ck');
    return '.panel';
  }],
  ['request-dialog', async ctx => {
    if (!ctx.thread) throw Error('no thread page was reached earlier');
    await cdp('Page.navigate', {url: ctx.thread});
    await until("document.querySelectorAll('.photos img, .album, #content details').length>0", 'thread content');
    const opened = await evaluate(`(()=>{
      for(const sel of ['.card-actions a','[href$="#request"]','#request-photo','.album button.primary','button.primary']){
        const e=document.querySelector(sel);
        if(e){e.click();return sel;}
      }
      return null;})()`);
    if (!opened) throw Error('found no request-photo control');
    await present('.modal.open .sheet, .open .sheet, dialog[open]');
    return '.modal.open .sheet, .open .sheet, dialog[open]';
  }],
  ['data-stats', async () => {
    await go('/valheim/creators/stats/');
    await until("document.body.innerText.trim().length>40", 'stats content');
    return 'main, body';
  }],
];

const summary = {base: args.base, out: path.resolve(args.out), captured: [], skipped: []};
const context = {};
try {
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride',
    {width: args.width, height: args.height, deviceScaleFactor: 1, mobile: false});
  for (const [name, run] of steps) {
    try {
      const focus = await run(context);
      const record = await capture(name, focus);
      summary.captured.push(record);
      console.log(`captured ${name} (${record.width}x${record.height})` + (record.crop ? ' + crop' : ''));
    } catch (failure) {
      summary.skipped.push({name, reason: String(failure.message || failure)});
      console.log(`skipped  ${name}: ${failure.message || failure}`);
    }
  }
  await writeFile(path.join(args.out, 'shoot.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`${summary.captured.length} captured, ${summary.skipped.length} skipped -> ${summary.out}`);
} finally {
  socket.close();
  browser.kill();
}
