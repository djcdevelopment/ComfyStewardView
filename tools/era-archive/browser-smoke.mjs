import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const [gallery,world,output]=process.argv.slice(2);
// The world view deploys on its own lane and is not always up; the creator lane has to
// be verifiable on its own before a release goes out. Pass an empty world URL to skip it.
if(!gallery||!output)throw Error('Usage: browser-smoke.mjs <creator-base-url> <world-base-url-or-empty> <output-dir>');
await mkdir(output,{recursive:true});
const chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser=spawn(chrome,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--window-size=1440,1000',`--user-data-dir=${path.resolve(output,'profile')}`,'about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
let stderr='';const ws=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),10000);browser.stderr.on('data',b=>{stderr+=b;const m=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});browser.once('exit',()=>reject(Error('Chrome exited')));});
const http=ws.replace('ws://','http://').replace(/\/devtools\/browser\/.*$/,'');
const target=await fetch(http+'/json/new?about:blank',{method:'PUT'}).then(r=>r.json());
const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>socket.onopen=r);
let id=0;const pending=new Map(),errors=[];
socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};
const cdp=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>(await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
const wait=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,200));}throw Error('Timed out: '+expression);};
const screenshot=async name=>{const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,name+'.png'),Buffer.from(shot.data,'base64'));};
const results={};
try{
  await cdp('Page.enable');await cdp('Runtime.enable');
  await cdp('Page.navigate',{url:gallery});await wait("document.querySelectorAll('.builder').length>0");
  results.directory=await evaluate("({title:document.title,cards:document.querySelectorAll('.builder').length,status:document.getElementById('status').textContent,note:document.getElementById('capture-note').textContent})");await screenshot('creators');
  if(!results.directory.note)throw Error('Landing page never said which eras are photographed');
  // Parse the number, do not pattern-match the tail of the string. The previous check
  // was `.endsWith('0 photos')`, which is true of "270 photos" -- it passed for months
  // only because no lead card's count happened to end in a zero, then failed on a
  // thread with 270 photographs, which is the opposite of what it claims to detect.
  // Positional selectors are avoided too: this card markup has been redesigned once.
  const leadPhotos=await evaluate("(()=>{const m=document.querySelector('.builder').innerText.match(/([0-9,]+) photos/);return m?Number(m[1].replace(/,/g,'')):null;})()");
  if(leadPhotos===null)throw Error('Could not read a photo count from the first builder card');
  if(leadPhotos===0)throw Error('Directory still opens on a thread with no photographs');
  results.directory.leadPhotos=leadPhotos;
  const directory=await fetch(new URL('directory.json',gallery)).then(r=>r.json());
  // Chronicler Archive redesign: hero stat mosaic, era ribbon, sort modes, card shortcut, Ctrl+K.
  results.heroStats=await evaluate("({builders:document.getElementById('stat-builders').textContent,captures:document.getElementById('stat-captures').textContent,eras:document.getElementById('stat-eras').textContent})");
  if([results.heroStats.builders,results.heroStats.captures,results.heroStats.eras].some(v=>!v||v==='—'))throw Error('Hero stats did not populate');
  if(Number(results.heroStats.builders.replace(/,/g,''))!==directory.builders.length)throw Error('Hero builder count does not match directory.json');
  if(await evaluate("document.querySelectorAll('.era-chip').length")<2)throw Error('Era ribbon did not render');
  await evaluate("[...document.querySelectorAll('.era-chip')].find(c=>/Era \\d/.test(c.textContent)).click()");
  await wait("document.querySelector('.era-chip.active') && !document.querySelector('.era-chip.active').textContent.startsWith('All eras')");
  if(await evaluate("document.getElementById('status').textContent")===results.directory.status)throw Error('Era ribbon click did not change the result count');
  await evaluate("document.querySelector('.era-chip').click()");
  await wait("document.querySelector('.era-chip.active').textContent.startsWith('All eras')");
  const mostPhotos=directory.builders.slice().sort((a,b)=>b.photos-a.photos)[0].photos;
  await evaluate("document.getElementById('sort').value='photos';document.getElementById('sort').dispatchEvent(new Event('change'))");
  await wait("document.querySelectorAll('.builder').length>0");
  if(!(await evaluate("document.querySelector('.builder p:nth-of-type(2)').textContent")).includes(String(mostPhotos)))throw Error('Most-photos sort did not surface the highest photo count first');
  await evaluate("document.getElementById('sort').value='default';document.getElementById('sort').dispatchEvent(new Event('change'))");
  await wait("document.querySelectorAll('.builder').length>0");
  results.requestShortcut=await evaluate("document.querySelector('.card-actions a')?.getAttribute('href')");
  if(!/#request$/.test(results.requestShortcut||''))throw Error('Card Request Photo shortcut is missing or malformed');
  await evaluate("document.activeElement.blur();document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))");
  if(await evaluate("document.activeElement!==document.getElementById('search')"))throw Error('Ctrl+K did not focus search');
  await evaluate("document.getElementById('search').blur()");
  await screenshot('creators-hero-and-ribbon');
  const photographed=directory.builders.filter(b=>b.photos>0&&b.eras.length>1).sort((a,b)=>b.photos-a.photos)[0];
  if(!photographed)throw Error('No cross-era photographed builder');
  const named=directory.builders.filter(b=>b.photos>0&&!/^Builder [0-9a-f]{8}$/.test(b.displayName)&&b.displayName.trim().length>2).sort((a,b)=>b.photos-a.photos)[0];
  if(!named)throw Error('No named photographed builder to search for');
  const term=named.displayName.slice(0,5).trim();
  await evaluate(`document.getElementById('search').value=${JSON.stringify(term)};document.getElementById('search').dispatchEvent(new Event('input'))`);
  await wait("document.querySelectorAll('#suggestions li').length>0");
  results.autocomplete=await evaluate("({reflected:new URLSearchParams(location.search).get('q'),suggestions:[...document.querySelectorAll('#suggestions li')].map(li=>li.textContent)})");
  if(results.autocomplete.reflected!==term)throw Error('Search was not reflected into ?q=');
  if(!results.autocomplete.suggestions.some(t=>t.includes('photos')))throw Error('Suggestions carry no build counts');
  await evaluate("document.getElementById('search').value='__no_such_builder_928478__';document.getElementById('search').dispatchEvent(new Event('input'))");
  await wait("document.querySelectorAll('.builder').length===0");
  if(await evaluate("document.getElementById('empty-state').hidden"))throw Error('Search with no matches showed a blank void');
  await cdp('Page.navigate',{url:new URL(photographed.builderKey+'/',gallery).href});
  await wait("document.querySelectorAll('.photos img').length>0");
  results.thread=await evaluate("({title:document.title,heading:document.getElementById('title').textContent,eras:document.querySelectorAll('#content details').length,photos:document.querySelectorAll('.photos img').length,description:document.querySelector('meta[name=\"description\"]')?.content||'',image:document.querySelector('meta[property=\"og:image\"]')?.content||''})");
  if(!results.thread.title.startsWith(results.thread.heading))throw Error('Thread page still carries the shared directory title');
  if(!results.thread.image||!results.thread.description)throw Error('Thread page would unfurl bare in Discord');
  await wait("[...document.querySelectorAll('.photos img')].filter(i=>i.loading!=='lazy'||i.getBoundingClientRect().top<innerHeight).every(i=>i.complete&&i.naturalWidth>0)");await screenshot('creator-thread');
  // The check that would have caught a modal whose sheet was display:none inside a
  // visible overlay: every participation dialog opened as an empty black screen.
  await evaluate("document.querySelector('.album button.primary').click()");
  await wait("document.getElementById('claim-modal').classList.contains('open')");
  results.modal=await evaluate("(()=>{const s=document.querySelector('#claim-modal .sheet');const r=s.getBoundingClientRect();return{display:getComputedStyle(s).display,height:Math.round(r.height),width:Math.round(r.width)};})()");
  if(results.modal.display==='none'||results.modal.height<40||results.modal.width<40)throw Error('Claim modal opened an empty overlay');
  await screenshot('claim-modal');
  await evaluate("document.getElementById('claim-cancel').click()");
  await wait("!document.getElementById('claim-modal').classList.contains('open')");
  // Manifest download must target this exact builder's own thread file, not a shared one.
  results.manifest=await evaluate("document.getElementById('manifest-download')?.getAttribute('href')");
  if(!results.manifest||!results.manifest.endsWith(photographed.builderKey+'.json'))throw Error('Manifest download link missing or targets the wrong builder');
  // Basic photo lightbox: opens over the real large/thumb URLs, moves focus to its own
  // close control, and returns focus to the exact thumbnail that opened it.
  const triggerId='__smoke_photo_trigger__';
  await evaluate(`document.querySelector('.photo-thumb').id=${JSON.stringify(triggerId)}`);
  // .focus() first: a synthetic .click() alone does not reliably move browser focus the
  // way a real pointer click does, and this check is specifically about focus return.
  await evaluate(`document.getElementById(${JSON.stringify(triggerId)}).focus();document.getElementById(${JSON.stringify(triggerId)}).click()`);
  await wait("document.getElementById('photo-viewer-modal').classList.contains('open')");
  results.lightbox=await evaluate("(()=>{const s=document.querySelector('#photo-viewer-modal .sheet');const r=s.getBoundingClientRect();return{display:getComputedStyle(s).display,height:Math.round(r.height),focused:document.activeElement.id};})()");
  if(results.lightbox.display==='none'||results.lightbox.height<40)throw Error('Photo viewer opened an empty overlay');
  if(results.lightbox.focused!=='photo-viewer-close')throw Error('Photo viewer did not move focus to its close control');
  await screenshot('photo-viewer');
  await evaluate("document.getElementById('photo-viewer-close').click()");
  await wait("!document.getElementById('photo-viewer-modal').classList.contains('open')");
  if(await evaluate(`document.activeElement.id!==${JSON.stringify(triggerId)}`))throw Error('Closing the photo viewer did not return focus to the trigger thumbnail');
  // Kinship: the branching tree of who a builder built beside. It needs an anchor who
  // shares a build with somebody -- a thread whose every album is solo draws a trunk and
  // nothing else, and this step would then be asserting against an empty canvas. The
  // lead photographed builder is tried first, then the busiest threads, capped at ten
  // fetches so a pathological archive cannot turn one smoke step into 2,682 requests.
  const hasCoBuilder=doc=>(doc?.eras||[]).some(e=>(e.albums||[]).some(a=>(a.contributors||[]).some(c=>c&&c.builderKey!==doc.builderKey)));
  let kinshipKey=null;
  for(const candidate of [photographed,...directory.builders.slice().sort((a,b)=>b.albums-a.albums)].slice(0,10)){
    const doc=await fetch(new URL(`threads/${candidate.builderKey}.json`,gallery)).then(r=>r.ok?r.json():null).catch(()=>null);
    if(hasCoBuilder(doc)){kinshipKey=candidate.builderKey;break;}
  }
  if(!kinshipKey)throw Error('No builder in the archive shares a build with anyone');
  await cdp('Page.navigate',{url:new URL('kinship/?builder='+kinshipKey,gallery).href});
  await wait("document.querySelectorAll('.kin-branch').length>0");
  results.kinship=await evaluate("({branches:document.querySelectorAll('.kin-branch').length,segs:document.querySelectorAll('.kin-seg').length,nodes:document.querySelectorAll('#kin-nodes a.kin-node').length})");
  if(!results.kinship.segs)throw Error('Kinship tree drew bands but no branch strokes');
  if(!results.kinship.nodes)throw Error('Kinship tree drew no builder portraits');
  await screenshot('kinship-tree');
  await evaluate("document.getElementById('kin-tab-ledger').click()");
  await wait("document.querySelectorAll('#kin-ledger tbody tr').length>0");
  results.kinship.ledgerRows=await evaluate("document.querySelectorAll('#kin-ledger tbody tr').length");
  // A fresh profile holds no claim, so every tag control must be gated -- and gated by
  // class and aria, never by the disabled attribute, which swallows the very tap that
  // would explain why it is off.
  const tagGate=await evaluate("(()=>{const b=document.querySelector('button.kin-tag-btn');return b?{inert:b.classList.contains('inert'),aria:b.getAttribute('aria-disabled'),disabled:b.disabled}:null;})()");
  if(!tagGate)throw Error('Kinship ledger offered no tag control');
  if(!tagGate.inert||tagGate.aria!=='true'||tagGate.disabled)throw Error('Tag control is not gated on a build this browser has never claimed');
  await evaluate("document.querySelector('button.kin-tag-btn').click()");
  await wait("document.getElementById('toast').classList.contains('show')");
  results.kinship.gated=true;
  if(!world){
    results.spatial='skipped: no world base URL';
    if(errors.length)throw Error(errors.join('\n'));
  results.status='passed';await writeFile(path.join(output,'receipt.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
  }else{
  await cdp('Page.navigate',{url:new URL('?era=era7',world).href});
  await wait("[...document.querySelectorAll('.analysis-raster')].some(i=>i.complete&&i.naturalWidth>0)");
  if(await evaluate("document.querySelectorAll('.context-raster').length")!==0)throw Error('Construction map displayed another era terrain');
  results.spatial=await evaluate("document.getElementById('terrain-status').textContent");await screenshot('construction-era');
  await evaluate("document.getElementById('era-select').value='era17';document.getElementById('era-select').dispatchEvent(new Event('change'))");
  await wait("[...document.querySelectorAll('.context-raster')].some(i=>i.complete&&i.naturalWidth>0)");
  if(await evaluate("new URLSearchParams(location.search).has('build')"))throw Error('Era switch retained previous build');
  results.switch=await evaluate("({era:document.getElementById('era-select').value,context:document.querySelector('.context-raster').src,world:document.getElementById('public-world-name').textContent})");
  if(!new URL(results.switch.context).searchParams.get('era'))throw Error('Terrain request lost era scope');
  await screenshot('era17');
  if(errors.length)throw Error(errors.join('\n'));
  results.status='passed';await writeFile(path.join(output,'receipt.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
  }
}finally{socket.close();browser.kill();}
