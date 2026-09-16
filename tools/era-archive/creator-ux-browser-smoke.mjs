import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const [creatorsBase, output, builderKey = '1dd405b7d09e57419b20fc4df6f18716'] = process.argv.slice(2);
if (!creatorsBase || !output) throw Error('Usage: creator-ux-browser-smoke.mjs <creators-base-url> <output-dir> [builder-key]');
const base = new URL(creatorsBase.endsWith('/') ? creatorsBase : `${creatorsBase}/`);
const allyKey = '1202c8a31d2e55fa8cc3183fea14c8b7';
await mkdir(output, {recursive: true});
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = await mkdtemp(path.join(os.tmpdir(), 'steward-ux-chrome-'));
const browser = spawn(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', '--window-size=1440,1000', `--user-data-dir=${profile}`, 'about:blank'],
{stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
let stderr = '';
const ws = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Chrome startup timeout')), 10000);
  browser.stderr.on('data', (chunk) => {
    stderr += chunk;
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  });
  browser.once('exit', () => reject(Error('Chrome exited')));
});
const http = ws.replace('ws://', 'http://').replace(/\/devtools\/browser\/.*$/, '');
const target = await fetch(`${http}/json/new?about:blank`, {method: 'PUT'}).then((response) => response.json());
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => { socket.onopen = resolve; });
let id = 0;
const pending = new Map();
const errors = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const promise = pending.get(message.id);
    pending.delete(message.id);
    message.error ? promise.reject(Error(message.error.message)) : promise.resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
};
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++id, {resolve, reject});
  socket.send(JSON.stringify({id, method, params}));
});
const evaluate = async (expression) => (await cdp('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true})).result.value;
const waitFor = async (expression) => {
  for (let i = 0; i < 100; i += 1) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error(`Timed out: ${expression}`);
};
const screenshot = async (name) => {
  const shot = await cdp('Page.captureScreenshot', {format: 'png'});
  await writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
};
const results = {};
try {
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.navigate', {url: new URL(`${builderKey}/`, base).href});
  await waitFor("document.querySelectorAll('#build-matrix .build-matrix-cell').length>0");
  results.profile = await evaluate("({heading:document.querySelector('#title').textContent,matrixCount:[...document.querySelectorAll('.build-matrix-cell strong')].reduce((n,e)=>n+Number(e.textContent.replace(/,/g,'')),0),shortlist:document.querySelectorAll('.build-shortlist li').length,ledgerRows:document.querySelectorAll('#build-explorer tbody tr').length})");
  if (results.profile.matrixCount !== 547 || results.profile.shortlist > 5 || results.profile.ledgerRows !== 0) throw Error(`Default inventory is still unwieldy: ${JSON.stringify(results.profile)}`);
  await screenshot('profile-default');
  await evaluate("document.querySelector('#build-matrix').scrollIntoView({block:'start'})");
  await screenshot('profile-matrix');
  await evaluate("document.querySelector('.build-matrix-cell[data-era=\"16\"][data-band=\"500-999\"]').click()");
  results.cell = await evaluate("({count:document.querySelector('#build-explorer').textContent.match(/165 builds/)?.[0]||null,shortlist:document.querySelectorAll('.build-shortlist li').length})");
  if (!results.cell.count || results.cell.shortlist > 10) throw Error(`Crowded cell did not produce a shortlist: ${JSON.stringify(results.cell)}`);
  await screenshot('profile-cell');
  await evaluate("[...document.querySelectorAll('#build-explorer button')].find(b=>b.textContent.includes('View complete ledger')).click()");
  results.ledger = await evaluate("({rows:document.querySelectorAll('#build-explorer tbody tr').length,pages:document.querySelector('.build-page-jump input')?.max})");
  if (results.ledger.rows > 50 || results.ledger.pages !== '4') throw Error(`Complete ledger lacks bounded paging: ${JSON.stringify(results.ledger)}`);
  await cdp('Page.navigate', {url: new URL(`${builderKey}/?kin=${allyKey}`, base).href});
  await waitFor("!!document.querySelector('#work .work-stage') && !!document.querySelector('.legacy-kin-notice')");
  results.legacyPair = await evaluate("({path:location.pathname,photos:document.querySelectorAll('#work .work-tile').length,notice:!!document.querySelector('.legacy-kin-notice a[href*=kinship]'),linked:document.querySelector('.kin-profile-linked td')?.dataset.builderKey})");
  if (!results.legacyPair.path.includes(builderKey) || results.legacyPair.photos === 0 || !results.legacyPair.notice || results.legacyPair.linked !== allyKey) throw Error(`Legacy profile pairing lost the carousel: ${JSON.stringify(results.legacyPair)}`);
  const profileDoc = await fetch(new URL(`threads/${builderKey}.json`, base)).then((response) => response.json());
  const photographedBuild = profileDoc.eras.flatMap((era) => era.albums).find((album) => album.photos?.length);
  await cdp('Page.navigate', {url: new URL(`${builderKey}/?build=${photographedBuild.buildKey}`, base).href});
  await waitFor("!!document.querySelector('#work .work-details') && document.querySelector('#work .work-details')?.dataset.buildKey === '" + photographedBuild.buildKey + "'");
  results.photoDeepLink = await evaluate("({workTop:Math.round(document.getElementById('work').getBoundingClientRect().top),viewport:innerHeight,photoCount:document.querySelectorAll('#work .work-tile').length})");
  if (results.photoDeepLink.workTop < -20 || results.photoDeepLink.workTop > results.photoDeepLink.viewport || !results.photoDeepLink.photoCount) throw Error(`Photographed build link did not open on the carousel: ${JSON.stringify(results.photoDeepLink)}`);
  await cdp('Page.navigate', {url: new URL(`kinship/?builder=${builderKey}&kin=${allyKey}&era=4`, base).href});
  await waitFor("document.querySelector('#kin-map-table tbody tr') && document.querySelector('#kin-ledger tbody tr')");
  results.kinship = await evaluate("({mapRows:document.querySelectorAll('#kin-map-table tbody tr').length,metrics:document.querySelectorAll('[data-kin-metric]').length,pairVisible:!document.querySelector('#kin-pair-panel').hidden,pairEra:document.querySelector('.kin-pair-era select')?.value,pairOptions:[...document.querySelectorAll('.kin-pair-era select option')].map(o=>o.value),coRows:document.querySelectorAll('#kin-ledger tbody tr').length})");
  if (results.kinship.mapRows < 1 || results.kinship.metrics !== 3 || !results.kinship.pairVisible || results.kinship.pairEra !== 'all' || results.kinship.pairOptions.includes('4') || results.kinship.coRows > 50) throw Error(`Kinship path is invalid: ${JSON.stringify(results.kinship)}`);
  await screenshot('kinship-pair');
  await evaluate("[...document.querySelectorAll('#kin-pair-panel button')].find(b=>b.textContent.includes('View all 35 shared builds')).click()");
  results.pairLedger = await evaluate("({rows:document.querySelectorAll('.kin-pair-table tbody tr').length,search:!!document.querySelector('#kin-pair-search')})");
  if (results.pairLedger.rows !== 35 || !results.pairLedger.search) throw Error(`Pair ledger did not open on request: ${JSON.stringify(results.pairLedger)}`);
  await evaluate("document.querySelector('#kin-pair-search').value='029cca63';document.querySelector('#kin-pair-search').dispatchEvent(new Event('input'))");
  if (!(await evaluate("document.querySelectorAll('.kin-pair-table tbody tr').length===1"))) throw Error('Pair ledger search did not find the exact build');
  await evaluate("document.querySelector('[data-kin-metric=\"pieces\"]').click()");
  if (!(await evaluate("document.querySelector('[data-kin-metric=\"pieces\"]').getAttribute('aria-pressed')==='true'"))) throw Error('Shared pieces metric did not activate');
  await evaluate("document.querySelector('[data-kin-metric=\"photos\"]').click()");
  if (!(await evaluate("document.querySelector('[data-kin-metric=\"photos\"]').getAttribute('aria-pressed')==='true'"))) throw Error('Photographed builds metric did not activate');
  await cdp('Emulation.setDeviceMetricsOverride', {width: 375, height: 850, deviceScaleFactor: 1, mobile: false});
  await cdp('Page.navigate', {url: new URL(`kinship/?builder=${builderKey}&kin=${allyKey}`, base).href});
  await waitFor("document.querySelector('#kin-map-table tbody tr')");
  results.mobile = await evaluate("({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,selectorVisible:getComputedStyle(document.querySelector('#kin-mobile-pick-label')).display!=='none'})");
  if (!results.mobile.selectorVisible || results.mobile.scrollWidth > results.mobile.viewport + 2) throw Error(`Mobile kinship overflows: ${JSON.stringify(results.mobile)}`);
  await evaluate("document.querySelector('#kin-map-section').scrollIntoView({block:'start'})");
  await screenshot('kinship-mobile');
  if (errors.length) throw Error(`Browser exceptions: ${errors.join('; ')}`);
  results.ok = true;
} catch (error) {
  results.ok = false;
  results.error = String(error);
  results.exceptions = errors;
  throw error;
} finally {
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  socket.close();
  browser.kill();
  await new Promise((resolve) => {
    if (browser.exitCode != null) return resolve();
    browser.once('exit', resolve);
    setTimeout(resolve, 3000);
  });
  if (profile.startsWith(os.tmpdir() + path.sep)) await rm(profile, {recursive: true, force: true}).catch(() => {});
}
