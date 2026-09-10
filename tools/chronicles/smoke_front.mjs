// Front-door smoke: the name box is the primary interaction, so this proves it end to end
// over CDP against a live or local origin, the way shoot.mjs and browser-smoke.mjs do.
//
//   node tools/chronicles/smoke_front.mjs --base https://fx99.tail8e749c.ts.net/ --out E:\wt\smoke-front
//     [--name Tug --key 5897d38e2a065e36a6895e70a2194738 --portrait 46]
//
// Checks: typing shows ranked rows with a portrait tile, arrows move the active row,
// Escape closes, a nonsense name shows the "browse instead" row, Enter on a prefix match
// lands on the builder's page, the ?q= deep link pre-fills and opens, and the profile hero
// and path cards render there. Exit code 1 on any failed check; report.json lists them all.
import {spawn} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const out = {base: 'https://fx99.tail8e749c.ts.net/', out: 'smoke-front', name: 'Tug',
    key: '5897d38e2a065e36a6895e70a2194738', portrait: '46', multi: 'tu', width: 1440, height: 900};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {out[a.slice(2)] = argv[i + 1]; i++;}
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (!args.base.endsWith('/')) args.base += '/';
await mkdir(args.out, {recursive: true});
const WAIT_MS = 20000;
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = spawn(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--window-size=${args.width},${args.height}`, '--hide-scrollbars', 'about:blank'],
  {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
let stderr = '';
const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Chrome startup timeout')), 20000);
  browser.stderr.on('data', d => {
    stderr += d;
    const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
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
const exceptions = [];
socket.onmessage = event => {
  const m = JSON.parse(event.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    exceptions.push((d.exception && d.exception.description) || d.text);
  }
  if (!m.id) return;
  const w = pending.get(m.id);
  pending.delete(m.id);
  m.error ? w.reject(Error(m.error.message)) : w.resolve(m.result);
};
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++nextId, {resolve, reject});
  socket.send(JSON.stringify({id: nextId, method, params}));
});
const evaluate = async expression =>
  (await cdp('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true})).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(expression, label = expression) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    let v;
    try {v = await evaluate(expression);} catch {v = false;}
    if (v) return true;
    await sleep(150);
  }
  throw Error('timed out waiting for ' + label);
}
await cdp('Runtime.enable');
await cdp('Page.enable');
async function go(route) {
  const url = new URL(route.replace(/^\//, ''), args.base).href;
  await cdp('Page.navigate', {url});
  await until("document.readyState==='interactive'||document.readyState==='complete'", 'document ' + url);
  return url;
}
async function key(k, code, keyCode) {
  // Enter needs the '' text on the keyDown or Chrome never runs implicit form submission.
  const text = k === 'Enter' ? '' : undefined;
  await cdp('Input.dispatchKeyEvent', {type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode, text, unmodifiedText: text});
  await cdp('Input.dispatchKeyEvent', {type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode});
}
async function typeInto(selector, text) {
  const sel = JSON.stringify(selector);
  await evaluate(`(()=>{const e=document.querySelector(${sel});e.focus();e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await cdp('Input.insertText', {text});
  await evaluate(`document.querySelector(${sel}).dispatchEvent(new Event('input',{bubbles:true}))`);
}
async function shot(name) {
  const s = await cdp('Page.captureScreenshot', {format: 'png'});
  await writeFile(path.join(args.out, name + '.png'), Buffer.from(s.data, 'base64'));
}
class FrontOnly extends Error {}
const results = [];
async function check(label, fn) {
  try {
    const v = await fn();
    results.push({label, ok: v === true || (typeof v === 'number' && v > 0), value: v});
    console.log((results[results.length - 1].ok ? 'ok   ' : 'FAIL ') + label + (typeof v === 'string' ? ' -> ' + v : ''));
  } catch (e) {
    results.push({label, ok: false, error: String(e.message || e)});
    console.log('FAIL ' + label + ' -> ' + (e.message || e));
  }
}
const Q = "document.querySelector('#q')";
const ROWS = "document.querySelectorAll('#suggestions li.suggestion')";
const nameLit = JSON.stringify(args.name);
// tiles are 1-based ids (p01..p48); portraitIndex(key) % count picks tiles[index], i.e. p<index+1>
const tileId = 'p' + String(Number(args.portrait) + 1).padStart(2, '0');
try {
  await go('chronicles/');
  await check('front page has the combobox and the button',
    () => evaluate(`!!document.querySelector('#q[role=combobox]') && !!document.querySelector('a.button.forged[href="/valheim/"]')`));
  await check('front page has no figure cards, stats or manual',
    () => evaluate(`!document.querySelector('.path, .glance, .manual')`));
  await typeInto('#q', args.name);
  await until(`${ROWS}.length>0`, 'suggestion rows');
  await check('typing shows ranked rows', () => evaluate(`${ROWS}.length`));
  await check('first row starts with the expected name',
    () => evaluate(`${ROWS}[0].textContent.trim().startsWith(${nameLit})`));
  await until(`(()=>{const i=${ROWS}[0].querySelector('img.portrait');return !!(i&&i.complete&&i.naturalWidth>0)})()`, 'portrait tile loaded');
  await check('first row portrait tile comes from the expected slot',
    () => evaluate(`${ROWS}[0].querySelector('img.portrait').getAttribute('src').includes('/${tileId}.')`));
  await shot('front-suggestions');
  await typeInto('#q', args.multi);
  await until(`${ROWS}.length>1`, 'several rows for ' + args.multi);
  await key('ArrowDown', 'ArrowDown', 40);
  await key('ArrowDown', 'ArrowDown', 40);
  await check('ArrowDown twice activates the second row',
    () => evaluate(`${Q}.getAttribute('aria-activedescendant')==='suggestion-1' && ${ROWS}[1].classList.contains('active')`));
  await key('Escape', 'Escape', 27);
  await until(`document.querySelector('#suggestions').hidden`, 'list hidden after Escape');
  await check('Escape closes the list and keeps the text',
    () => evaluate(`document.querySelector('#suggestions').hidden && ${Q}.value===${JSON.stringify(args.multi)}`));
  await typeInto('#q', 'zzqxv');
  await until(`!!document.querySelector('#suggestions .suggestion-empty')`, 'empty row');
  await check('nonsense shows the browse-instead row linking the gallery',
    () => evaluate(`document.querySelector('#suggestions .suggestion-empty a').getAttribute('href')==='/valheim/'`));
  await typeInto('#q', args.name);
  await until(`${ROWS}.length>0 && ${ROWS}[0].textContent.trim().startsWith(${nameLit})`, 'rows for ' + args.name);
  await key('Enter', 'Enter', 13);
  await until(`location.pathname.startsWith('/valheim/creators/')`, 'navigation to a builder page');
  if (args['front-only']) throw new FrontOnly();
  await check('Enter on a prefix match lands on the profile',
    () => evaluate(`location.pathname===${JSON.stringify('/valheim/creators/' + args.key + '/')}`));
  await until(`!!document.querySelector('#builder-hero:not([hidden])')`, 'profile hero');
  await check('profile hero shows an avatar or its fallback',
    () => evaluate(`(()=>{const i=document.querySelector('#hero-avatar img');if(i)return !!(i.complete&&i.naturalWidth>0);return !!document.querySelector('#hero-avatar .hero-avatar-fallback')})()`));
  await check('profile hero shows an era fact', () => evaluate(`/Era \\d+/.test(document.querySelector('#hero-facts').textContent)`));
  await check('profile keeps its retro counters', () => evaluate(`document.querySelectorAll('#intro .counter').length>=3`));
  await check('path cards at the bottom link the five paths in order',
    () => evaluate(`[...document.querySelectorAll('#look-out a.path')].map(a=>a.getAttribute('href')).join(' ')==='/valheim/creators/ /valheim/ /valheim/era7/ /valheim/creators/#participation-details /valheim/creators/stats/'`));
  await shot('profile-hero');
  await go('chronicles/?q=' + encodeURIComponent(args.name));
  await until(`${ROWS}.length>0`, 'deep-link rows');
  await check('?q= deep link pre-fills and opens',
    () => evaluate(`${Q}.value===${nameLit} && !document.querySelector('#suggestions').hidden`));
  await check('no page exceptions', () => exceptions.length === 0 ? true : 'exceptions: ' + exceptions.slice(0, 3).join(' | '));
} catch (e) {
  if (!(e instanceof FrontOnly)) results.push({label: 'run aborted', ok: false, error: String(e.message || e)});
} finally {
  const failed = results.filter(r => !r.ok);
  await writeFile(path.join(args.out, 'report.json'), JSON.stringify({base: args.base, results, exceptions}, null, 2));
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  socket.close();
  browser.kill();
  process.exit(failed.length ? 1 : 0);
}
