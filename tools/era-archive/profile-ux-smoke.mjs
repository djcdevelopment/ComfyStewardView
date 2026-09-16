// Local creator-profile smoke against an existing public projection. The HTTP server
// serves the current source shell/assets with the projection's immutable JSON, so a
// worktree UI change can be checked without rebuilding or changing archive data.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile, mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const fixture = path.resolve(process.argv[2] || '');
const pictures = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (!process.argv[2]) throw Error('Usage: node profile-ux-smoke.mjs <public-projection> [screenshot-directory] [chronicles-cutouts-directory]');
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'web');
const cutouts = process.argv[4] ? path.resolve(process.argv[4]) : null;
const assets = new Set(['creators.js', 'creators.css', 'pair.js', 'kin-tree.js', 'portraits.js']);
const threadShell = (await readFile(path.join(web, 'index.html'), 'utf8'))
  .replaceAll('"./creators.', '"../creators.')
  .replaceAll('"./pair.js', '"../pair.js')
  .replaceAll('"./kin-tree.js', '"../kin-tree.js')
  .replaceAll('"./portraits.js', '"../portraits.js');
const directory = JSON.parse(await readFile(path.join(fixture, 'directory.json'), 'utf8'));
const ibocainKey = '1dd405b7d09e57419b20fc4df6f18716';
const ibocain = JSON.parse(await readFile(path.join(fixture, 'threads', `${ibocainKey}.json`), 'utf8'));

const server = createServer(async (request, response) => {
  const route = new URL(request.url, 'http://local.invalid').pathname;
  let body, type = 'text/plain';
  try {
    if (/^\/valheim\/creators\/[a-f0-9]{32}\/?$/.test(route)) { body = threadShell; type = 'text/html'; }
    else if (route === '/valheim/creators/' || route === '/valheim/creators/index.html') {
      body = await readFile(path.join(web, 'index.html')); type = 'text/html';
    } else if (route === '/valheim/creators/directory.json') {
      body = await readFile(path.join(fixture, 'directory.json')); type = 'application/json';
    } else if (/^\/valheim\/creators\/threads\/[a-f0-9]{32}\.json$/.test(route)) {
      body = await readFile(path.join(fixture, 'threads', path.basename(route))); type = 'application/json';
    } else if (route.startsWith('/valheim/creators/') && assets.has(path.basename(route))) {
      const name = path.basename(route);
      body = await readFile(path.join(web, name)); type = name.endsWith('.css') ? 'text/css' : 'text/javascript';
    } else if (cutouts && /^\/chronicles\/img\/cutouts\/(find|study|walk|request|data)(\.256)?\.webp$/.test(route)) {
      body = await readFile(path.join(cutouts, path.basename(route))); type = 'image/webp';
    } else { response.writeHead(404); response.end(); return; }
    response.writeHead(200, {'content-type': type.startsWith('image/') ? type : `${type}; charset=utf-8`, 'cache-control': 'no-store'});
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/valheim/creators/`;
const profile = await mkdtemp(path.join(os.tmpdir(), 'steward-profile-ux-'));
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = spawn(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
  '--window-size=1440,1000', `--user-data-dir=${profile}`, 'about:blank'],
{stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
let socket;
try {
  let startup = '';
  const ws = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Chrome startup timeout')), 10000);
    browser.stderr.on('data', (chunk) => {
      startup += chunk;
      const match = startup.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    browser.once('exit', () => reject(Error('Chrome exited before DevTools opened')));
  });
  const http = ws.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*$/, '');
  const target = await fetch(`${http}/json/new?about:blank`, {method: 'PUT'}).then((r) => r.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => { socket.onopen = resolve; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      message.error ? call.reject(Error(message.error.message)) : call.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, {resolve, reject});
    socket.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async (expression) => {
    const result = (await cdp('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}));
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let index = 0; index < 100; index++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error(`Timed out: ${expression}`);
  };
  const shot = async (name) => {
    if (!pictures) return;
    await mkdir(pictures, {recursive: true});
    const image = await cdp('Page.captureScreenshot', {format: 'png'});
    await writeFile(path.join(pictures, `${name}.png`), Buffer.from(image.data, 'base64'));
  };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.navigate', {url: `${url}${ibocainKey}/`});
  await wait("!!document.querySelector('#work .work-photo img') && !!document.querySelector('.build-shortlist-pick')");
  await wait("[...document.querySelectorAll('.kin-profile-card h3')].some((name)=>name.textContent==='Tanagor')");
  const initial = await evaluate("({carousel:document.querySelectorAll('#work .work-tile').length,photos:document.querySelectorAll('.build-shortlist-preview img').length,records:document.querySelectorAll('.build-shortlist-record').length,folded:!document.querySelector('.era-overview-detail').open,sort:document.getElementById('build-sort').value,hero:document.querySelectorAll('.hero-journey a').length,eras:document.querySelectorAll('.era-overview-pick').length,toolbarBorder:getComputedStyle(document.getElementById('build-browse')).borderTopWidth,desktopEra:getComputedStyle(document.querySelector('.build-browse-mobile-era')).display})");
  assert.equal(initial.sort, 'guided'); assert.equal(initial.folded, true);
  assert.equal(initial.photos, 3); assert.equal(initial.records, 3);
  assert.ok(initial.carousel > 0 && initial.hero === 3 && initial.eras > 1);
  assert.equal(initial.toolbarBorder, '0px'); assert.equal(initial.desktopEra, 'none');
  const originalPhoto = await evaluate("document.querySelector('#work .work-photo img').src");
  const actualThumbs = new Set(ibocain.eras.flatMap((era) => era.albums).flatMap((album) => album.photos || []).map((photo) => photo.thumb));
  const previewUrls = await evaluate("[...document.querySelectorAll('.build-shortlist-preview img')].map((img)=>img.src)");
  assert.ok(previewUrls.every((src) => actualThumbs.has(src)));
  await shot('profile-top');
  await evaluate("document.getElementById('build-explorer').scrollIntoView({block:'start'})");
  await shot('profile-builds');
  await evaluate("document.querySelector('.build-shortlist-preview img').src='/missing-profile-preview.webp'");
  await wait("!!document.querySelector('.build-shortlist-preview.is-unavailable')");
  assert.equal(await evaluate("document.querySelector('.build-shortlist-preview.is-unavailable').textContent"), 'Photograph unavailable');
  await evaluate("document.getElementById('kin-beside').scrollIntoView({block:'start'})");
  await shot('profile-kin');
  await evaluate("document.querySelector('.era-overview-pick[data-era=\"11\"]').click()");
  await wait("document.getElementById('build-era').value==='11' && !!document.querySelector('.build-filter-chip')");
  const era = await evaluate("({era:document.getElementById('build-era').value,active:[...document.querySelectorAll('.build-filter-chip')].map((x)=>x.textContent),count:document.querySelectorAll('.build-shortlist-pick').length,carousel:document.querySelectorAll('#work .work-tile').length,photo:document.querySelector('#work .work-photo img').src})");
  assert.equal(era.era, '11'); assert.ok(era.active.some((text) => text.includes('Era 11')));
  assert.ok(era.count <= 10); assert.equal(era.carousel, initial.carousel); assert.equal(era.photo, originalPhoto);
  await shot('profile-era');
  await evaluate("document.querySelector('.era-overview-detail > summary').click()");
  await evaluate("document.querySelector('.build-matrix-cell[data-era=\"11\"]').click()");
  await wait("[...document.querySelectorAll('.build-filter-chip')].some((x)=>x.textContent.includes('your pieces'))");
  await evaluate("document.querySelector('.build-filter-clear').click()");
  await wait("document.getElementById('build-era').value==='all' && !document.querySelector('.build-filter-chip')");
  await evaluate("document.getElementById('build-sort').value='mine';document.getElementById('build-sort').dispatchEvent(new Event('change'))");
  const strict = await evaluate("document.querySelector('.build-shortlist-pick').dataset.buildKey");
  const {profileBrowseRows} = await import('./web/creators.js');
  assert.equal(strict, profileBrowseRows(ibocain)[0].buildKey);
  await evaluate("document.querySelector('#build-explorer > button.secondary').click()");
  await wait("document.querySelectorAll('#build-explorer tbody tr').length===50");
  await evaluate("document.querySelector('#build-explorer > button.secondary').click()");
  await wait("document.querySelectorAll('#build-explorer tbody tr').length===0");
  const older = ibocain.eras.flatMap((era) => era.albums).find((album) => album.era <= 6 && !album.photos?.length && album.pieces >= 1000);
  assert.ok(older);
  await evaluate(`document.getElementById('build-search').value='${older.buildKey.slice(-12)}';document.getElementById('build-search').dispatchEvent(new Event('input'))`);
  await wait("document.querySelectorAll('.build-shortlist-pick').length===1 && [...document.querySelectorAll('.build-filter-chip')].some((x)=>x.textContent.includes('Find:'))");
  await cdp('Page.navigate', {url: `${url}${ibocainKey}/?build=${older.buildKey}`});
  await wait(`document.querySelector('#build-focus-host article.album')?.dataset.buildKey==='${older.buildKey}'`);
  assert.equal(await evaluate("document.querySelector('#work .work-photo img')?.src!==undefined"), true);
  await cdp('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  const mobile = await evaluate("({width:document.documentElement.scrollWidth,viewport:innerWidth,era:getComputedStyle(document.querySelector('.build-browse-mobile-era')).display})");
  assert.ok(mobile.width <= mobile.viewport + 2, JSON.stringify(mobile));
  assert.notEqual(mobile.era, 'none');
  await shot('profile-mobile');
  await cdp('Emulation.clearDeviceMetricsOverride');
  const tanagor = directory.builders.find((builder) => builder.displayName === 'Tanagor');
  assert.ok(tanagor);
  await cdp('Page.navigate', {url: `${url}${ibocainKey}/?kin=${tanagor.builderKey}`});
  await wait("!!document.querySelector('.legacy-kin-notice') && !!document.querySelector('#work .work-photo img')");
  assert.equal(await evaluate("document.querySelectorAll('.kin-profile-linked').length"), 1);
  let small = null;
  for (const builder of directory.builders.filter((entry) => entry.albums > 0 && entry.albums <= 5 && entry.eras.length === 1)) {
    try { await readFile(path.join(fixture, 'threads', `${builder.builderKey}.json`)); small = builder; break; }
    catch { /* Not every historical smoke projection retained every thread file. */ }
  }
  if (small) {
    await cdp('Page.navigate', {url: `${url}${small.builderKey}/`});
    await wait("!!document.querySelector('#era-overview')");
    assert.equal(await evaluate("document.querySelectorAll('.era-overview-pick').length"), 2);
    assert.equal(await evaluate("document.querySelectorAll('#build-explorer tbody tr').length"), 0);
  }
  let empty = null;
  for (const builder of directory.builders.filter((entry) => entry.albums === 0)) {
    try { await readFile(path.join(fixture, 'threads', `${builder.builderKey}.json`)); empty = builder; break; }
    catch { /* Older smoke projections may list empty identities without thread JSON. */ }
  }
  if (empty) {
    await cdp('Page.navigate', {url: `${url}${empty.builderKey}/`});
    await wait("!!document.querySelector('#build-browse-summary')");
    assert.equal(await evaluate("!!document.querySelector('#work')"), false);
    assert.equal(await evaluate("!!document.querySelector('#era-overview')"), false);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({initial, era, mobile, small: Boolean(small), empty: Boolean(empty), runtimeErrors: errors.length}, null, 2));
} finally {
  socket?.close();
  browser.kill();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => {
    if (browser.exitCode != null) resolve();
    else { browser.once('exit', resolve); setTimeout(resolve, 1500); }
  });
  const safe = path.resolve(profile).startsWith(path.resolve(os.tmpdir(), 'steward-profile-ux-'));
  if (safe) {
    try { await rm(profile, {recursive: true, force: true}); }
    catch (error) { console.warn(`Temporary Chrome profile could not be removed: ${error.message}`); }
  }
}
