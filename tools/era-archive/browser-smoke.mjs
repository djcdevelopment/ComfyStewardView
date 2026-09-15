import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const [gallery,world,output,worldFlag]=process.argv.slice(2);
// The world view deploys on its own lane and is not always up; the creator lane has to
// be verifiable on its own before a release goes out. Pass an empty world URL to skip it,
// and note that a world leg that fails is reported, not fatal: this run gates the creator
// release, and a spatial lane that is down must not be able to hold that release hostage.
// Pass --strict-world (or SMOKE_STRICT_WORLD=1) when the world lane is what is being
// gated, and the whole run exits non-zero on a spatial failure again.
if(!gallery||!output)throw Error('Usage: browser-smoke.mjs <creator-base-url> <world-base-url-or-empty> <output-dir> [--strict-world]');
const strictWorld=worldFlag==='--strict-world'||process.env.SMOKE_STRICT_WORLD==='1';
// `new URL('api/eras', 'https://host/world')` resolves to https://host/api/eras -- the
// path segment is a file, not a directory, until it ends in a slash.
const worldBase=world&&world!=='-'?new URL(world.endsWith('/')?world:world+'/'):null;
await mkdir(output,{recursive:true});
const chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// A Chrome profile is a cache, not a receipt: it lives in the temp dir and is removed with
// the browser. Nineteen of them (~7k files) had accumulated under receipt folders.
const profile=await mkdtemp(path.join(os.tmpdir(),'steward-smoke-'));
const browser=spawn(chrome,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--window-size=1440,1000',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
let stderr='';const ws=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),10000);browser.stderr.on('data',b=>{stderr+=b;const m=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});browser.once('exit',()=>reject(Error('Chrome exited')));});
const http=ws.replace('ws://','http://').replace(/\/devtools\/browser\/.*$/,'');
const target=await fetch(http+'/json/new?about:blank',{method:'PUT'}).then(r=>r.json());
const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>socket.onopen=r);
let id=0;const pending=new Map(),errors=[];
socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};
const cdp=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>(await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
const waitFor=async(expression,attempts,intervalMs)=>{for(let i=0;i<attempts;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,intervalMs));}throw Error('Timed out: '+expression);};
// 20 s for the creator pages, which are static files off FX99. The world viewer builds
// its rasters on demand on AM4 and a cold first tile can take most of a minute, so its
// own leg gets the 60 s budget world-browser-smoke.mjs already uses.
const wait=expression=>waitFor(expression,100,200);
const waitWorld=expression=>waitFor(expression,240,250);
const screenshot=async name=>{const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,name+'.png'),Buffer.from(shot.data,'base64'));};
const results={};
// One tail, written on every path. The two copies this replaced meant a failed run wrote
// no receipt at all -- the one case where a receipt is most worth having.
let receiptWritten=false;
const finish=async()=>{receiptWritten=true;await writeFile(path.join(output,'receipt.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));};
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
  await wait("[...document.querySelectorAll('.photos img')].filter(i=>{const r=i.getBoundingClientRect();return i.loading!=='lazy'||(r.width>0&&r.top<innerHeight)}).every(i=>i.complete&&i.naturalWidth>0)");await screenshot('creator-thread');
  // The hero card is as tall as its words: the profile line sits in the text column under
  // the facts, not under the portrait in its own column, so nothing but the name, the
  // aliases and the facts sets the card's height (the padding is 18 px a side).
  await wait("!document.getElementById('hero-portrait-actions')?.hidden");
  results.hero=await evaluate("(()=>{const h=document.getElementById('builder-hero').getBoundingClientRect(),t=document.querySelector('#builder-hero .hero-text').getBoundingClientRect();return {height:Math.round(h.height),text:Math.round(t.height),lineInText:!!document.querySelector('#builder-hero .hero-text > #hero-portrait-actions'),contentTop:Math.round(document.getElementById('content').getBoundingClientRect().top+scrollY)};})()");
  if(!results.hero.lineInText)throw Error('The profile line is not the last line of the hero text column');
  if(results.hero.height-results.hero.text>40)throw Error('The hero card is taller than its words again: '+results.hero.height+'px for '+results.hero.text+'px of text');
  // The one-story page (pass 3): the carousel of photographed builds sits under the hero
  // with its banner and its details article, the attribution sentence is said once, every
  // Details drop-down in the rest table starts folded, and the notes strip renders.
  results.story=await evaluate("({stage:document.querySelectorAll('#work .work-banner').length,rail:document.querySelectorAll('#work .work-tile').length,details:document.querySelectorAll('#work article.album.work-details button.primary').length,notes:document.querySelectorAll('.albums-note').length,matrix:document.querySelectorAll('.build-matrix-cell').length,shortlist:document.querySelectorAll('.build-shortlist li').length,buildRows:document.querySelectorAll('#build-explorer tbody tr').length,tree:document.querySelectorAll('#kin-beside .kin-branch').length,notesStrip:!document.getElementById('thread-notes')?.hidden})");
  if(results.story.stage!==1||results.story.rail<1)throw Error('Builder page drew no work carousel for a photographed thread');
  if(results.story.details!==1)throw Error('The carousel details lost the claim control');
  if(results.story.notes!==1)throw Error('Attribution sentence is not said exactly once');
  if(!results.story.matrix||results.story.shortlist>5||results.story.buildRows||results.story.tree)throw Error('Profile matrix is missing, default explorer is unbounded, or the full tree is still embedded');
  if(!results.story.notesStrip)throw Error('The notes strip at the foot did not render');
  // The check that would have caught a modal whose sheet was display:none inside a
  // visible overlay: every participation dialog opened as an empty black screen.
  await evaluate("document.querySelector('.album button.primary').click()");
  await wait("document.getElementById('claim-modal').classList.contains('open')");
  results.modal=await evaluate("(()=>{const s=document.querySelector('#claim-modal .sheet');const r=s.getBoundingClientRect();return{display:getComputedStyle(s).display,height:Math.round(r.height),width:Math.round(r.width)};})()");
  if(results.modal.display==='none'||results.modal.height<40||results.modal.width<40)throw Error('Claim modal opened an empty overlay');
  await screenshot('claim-modal');
  await evaluate("document.getElementById('claim-cancel').click()");
  await wait("!document.getElementById('claim-modal').classList.contains('open')");
  // Tag another basemate, from the card -- never a dead click. On a build this builder
  // leads with somebody else credited, the control is live before any claim: the click
  // opens the claim dialog (which says tagging follows), the claim made there opens the
  // tag dialog at once, the dialog lists this build's other contributors with basemate
  // ticked, Record tag hands over one payload carrying the claim and the tag, and a dashed
  // "recorded" chip appears beside the tagged credit. A cancelled tag after a chained claim
  // still hands the claim over. When the build is not this builder's to tag, the control
  // is inert and the reason stands under the row. The ledger is cleared at the end.
  results.tag=await evaluate("(()=>{const b=document.querySelector('#work .work-details button.album-tag-btn');if(!b)return null;const credits=document.querySelectorAll('#work .work-details .credits a.credit[data-builder-key]').length;return {label:b.textContent,inert:b.classList.contains('inert'),aria:b.getAttribute('aria-disabled'),credits,note:document.querySelector('#work .work-details .actions-note')?.textContent||null};})()");
  if(!results.tag)throw Error('The stage card carries no Tag another basemate control');
  if(results.tag.label!=='Tag another basemate')throw Error('The tag control is not labelled Tag another basemate: '+results.tag.label);
  if(await evaluate("[...document.querySelectorAll('#work .work-details .actions-row button')].some(b=>/payload/i.test(b.textContent))"))throw Error('The card still offers a payload copy');
  if(results.tag.inert!==!!results.tag.note)throw Error('An inert tag control must carry its reason under the row, and a live one none: '+JSON.stringify(results.tag));
  if(results.tag.inert){
    results.tag.skipped='the stage build is not this builder\'s to tag: '+results.tag.note;
  }else{
    const claimThenTag=async()=>{
      await evaluate("document.querySelector('#work .work-details button.album-tag-btn').click()");
      await wait("document.getElementById('claim-modal').classList.contains('open')");
      if(!/tagging opens the moment it is recorded/.test(await evaluate("document.getElementById('claim-build-label').textContent")))throw Error('The claim dialog opened from the tag control does not say tagging follows');
      await evaluate("document.getElementById('claim-handle').value='smoke';document.getElementById('claim-confirm').click()");
      await wait("!document.getElementById('claim-modal').classList.contains('open')&&document.getElementById('kin-tag-modal').classList.contains('open')");
      if(await evaluate("document.getElementById('activity-modal').classList.contains('open')"))throw Error('The claim handed its payload over on its own although the tag dialog follows');
    };
    await claimThenTag();
    results.tag.dialog=await evaluate("({options:document.querySelectorAll('#kin-tag-with option').length,ticked:[...document.querySelectorAll('#kin-tag-modal input[name=kin-tag]:checked')].map(i=>i.value),label:document.getElementById('kin-tag-build-label').textContent,with:document.getElementById('kin-tag-with').value,banned:/character|archetype|seed|gender|submitted/i.test(document.getElementById('kin-tag-modal').innerText)})");
    if(results.tag.dialog.options!==results.tag.credits-1)throw Error('The dialog does not list this build\'s other contributors: '+results.tag.dialog.options+' of '+(results.tag.credits-1));
    if(results.tag.dialog.ticked.join()!=='basemate')throw Error('basemate is not the one ticked box on opening: '+results.tag.dialog.ticked.join());
    if(results.tag.dialog.banned)throw Error('The tag dialog says a banned word');
    await screenshot('build-tag-dialog');
    await evaluate("document.getElementById('kin-tag-confirm').click()");
    await wait("!document.getElementById('kin-tag-modal').classList.contains('open')&&document.getElementById('activity-modal').classList.contains('open')");
    results.tag.payload=await evaluate("(()=>{try{const d=JSON.parse(document.getElementById('activity-payload').value);return {schema:d.schema,tags:(d.kinshipTags||[]).map(t=>t.tags.join('+')),claims:(d.claims||[]).map(c=>c.kind)};}catch(e){return {error:String(e)};}})()");
    if(results.tag.payload.tags.join()!=='basemate'||results.tag.payload.claims.join()!=='built')throw Error('The handed-over payload does not carry the built claim and the one basemate tag: '+JSON.stringify(results.tag.payload));
    await evaluate("document.getElementById('activity-close').click()");
    await wait("!!document.querySelector('#work .work-details .credits .kin-chip.pending')");
    results.tag.chip=await evaluate("document.querySelector('#work .work-details .credits .kin-chip.pending').textContent");
    results.tag.ledger=await evaluate("(()=>{const s=JSON.parse(localStorage.getItem('creators-participation-v1')||'{}');return Object.values(s.kinshipTags||{}).map(t=>({tags:t.tags,contributor:t.contributorKey}));})()");
    if(results.tag.ledger.length!==1||results.tag.ledger[0].contributor!==results.tag.dialog.with)throw Error('The ledger does not hold the one tag for the picked contributor: '+JSON.stringify(results.tag.ledger));
    await evaluate("document.querySelector('#work .work-details').scrollIntoView({block:'center'})");
    await screenshot('build-tag');
    // The other way out: a fresh ledger, claim through the tag control, then cancel the tag
    // -- the claim still goes out.
    await evaluate("localStorage.removeItem('creators-participation-v1')");
    await cdp('Page.navigate',{url:new URL(photographed.builderKey+'/',gallery).href});
    await wait("document.querySelectorAll('.photos img').length>0&&!!document.querySelector('#work .work-details button.album-tag-btn:not(.inert)')");
    await claimThenTag();
    await evaluate("document.getElementById('kin-tag-cancel').click()");
    await wait("!document.getElementById('kin-tag-modal').classList.contains('open')&&document.getElementById('activity-modal').classList.contains('open')");
    results.tag.cancelled=await evaluate("(()=>{try{const d=JSON.parse(document.getElementById('activity-payload').value);return {claims:(d.claims||[]).map(c=>c.kind),tags:(d.kinshipTags||[]).length};}catch(e){return {error:String(e)};}})()");
    if(results.tag.cancelled.claims.join()!=='built'||results.tag.cancelled.tags!==0)throw Error('A cancelled tag did not hand the chained claim over: '+JSON.stringify(results.tag.cancelled));
    await evaluate("document.getElementById('activity-close').click()");
    await evaluate("localStorage.removeItem('creators-participation-v1')");
    await cdp('Page.navigate',{url:new URL(photographed.builderKey+'/',gallery).href});
    await wait("document.querySelectorAll('.photos img').length>0");
  }
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
  // Profiles show a short co-builder summary; the detailed relationship lives on Kinship.
  results.pair=await evaluate("({summary:document.querySelectorAll('#kin-beside .kin-profile-summary tbody tr').length,links:document.querySelectorAll('#kin-beside a').length,panel:!!document.getElementById('pair-view')})");
  if(results.pair.panel)throw Error('Old inline pair ledger is still mounted on the profile');
  if(results.pair.summary&&!results.pair.links)throw Error('Co-builder summary has no path to Kinship');

  const hasCoBuilder=doc=>(doc?.eras||[]).some(e=>(e.albums||[]).some(a=>(a.contributors||[]).some(c=>c&&c.builderKey!==doc.builderKey)));
  let kinshipKey=null;
  for(const candidate of [photographed,...directory.builders.slice().sort((a,b)=>b.albums-a.albums)].slice(0,10)){
    const doc=await fetch(new URL('threads/'+candidate.builderKey+'.json',gallery)).then(r=>r.ok?r.json():null).catch(()=>null);
    if(hasCoBuilder(doc)){kinshipKey=candidate.builderKey;break;}
  }
  if(!kinshipKey)throw Error('No builder in the archive shares a build with anyone');
  await cdp('Page.navigate',{url:new URL('kinship/?builder='+kinshipKey,gallery).href});
  await wait("document.querySelectorAll('#kin-map-table tbody tr').length>0&&document.querySelectorAll('#kin-ledger tbody tr').length>0");
  results.kinship=await evaluate("({eras:document.querySelectorAll('#kin-map-table tbody tr').length,metrics:document.querySelectorAll('[data-kin-metric]').length,coBuilders:document.querySelectorAll('#kin-ledger tbody tr').length,tree:document.querySelectorAll('#kin-nodes .kin-node').length})");
  if(!results.kinship.eras||results.kinship.metrics!==3||!results.kinship.coBuilders||results.kinship.coBuilders>50||results.kinship.tree)throw Error('Kinship is missing its bounded map or searchable ledger');
  await screenshot('kinship-map');
  await evaluate("document.querySelector('[data-kin-metric=pieces]').click()");
  if(await evaluate("document.querySelector('[data-kin-metric=pieces]').getAttribute('aria-pressed')!=='true'"))throw Error('Kinship shared-piece metric did not activate');
  await evaluate("document.querySelector('#kin-ledger tbody tr button.kin-pair-link').click()");
  await wait("!document.getElementById('kin-pair-panel').hidden");
  results.kinship.pair=await evaluate("({shortlist:document.querySelectorAll('.kin-pair-shortlist li').length,eraOptions:document.querySelectorAll('.kin-pair-era select option').length,fullRows:document.querySelectorAll('.kin-pair-table tbody tr').length})");
  if(results.kinship.pair.shortlist>5||!results.kinship.pair.eraOptions||results.kinship.pair.fullRows)throw Error('Pair detail is unbounded by default or has no era path');
  await screenshot('kinship-pair');

  // The largest available profile is a scale fixture, without pinning its archive count.
  const prolific=directory.builders.slice().sort((a,b)=>b.albums-a.albums)[0];
  const largestThread=await fetch(new URL('threads/'+prolific.builderKey+'.json',gallery)).then(r=>r.json());
  await cdp('Page.navigate',{url:new URL(prolific.builderKey+'/',gallery).href});
  await wait("!!document.querySelector('#build-matrix .build-matrix-cell')");
  results.explorer=await evaluate("({sort:document.getElementById('build-sort').value,work:document.querySelectorAll('#work .work-tile').length,matrixCount:[...document.querySelectorAll('.build-matrix-cell strong')].reduce((n,e)=>n+Number(e.textContent.replaceAll(',','')),0),shortlist:document.querySelectorAll('.build-shortlist li').length,fullRows:document.querySelectorAll('#build-explorer tbody tr').length})");
  if(results.explorer.sort!=='mine'||results.explorer.work>40||results.explorer.matrixCount!==largestThread.albums||results.explorer.shortlist>5||results.explorer.fullRows)throw Error('Largest profile is unbounded or loses builds from its inventory');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  results.explorer.mobile=await evaluate("({width:document.documentElement.scrollWidth,viewport:innerWidth})");
  if(results.explorer.mobile.width>results.explorer.mobile.viewport+2)throw Error('Mobile profile has horizontal overflow');
  await screenshot('creator-build-matrix-mobile');
  await cdp('Emulation.clearDeviceMetricsOverride');

  const oldBuilder='1dd405b7d09e57419b20fc4df6f18716';
  const oldThread=await fetch(new URL('threads/'+oldBuilder+'.json',gallery)).then(r=>r.json());
  const older=oldThread.eras.flatMap(e=>e.albums).find(a=>a.era<=6&&!a.photos.length&&a.pieces>=1000);
  if(!older)throw Error('No older large Ibocain build survived the cutoff');
  await cdp('Page.navigate',{url:new URL(oldBuilder+'/',gallery).href});
  await wait("!!document.querySelector('#build-matrix .build-matrix-cell')");
  results.explorer.ibocain=await evaluate("({count:[...document.querySelectorAll('.build-matrix-cell strong')].reduce((n,e)=>n+Number(e.textContent.replaceAll(',','')),0),shortlist:document.querySelectorAll('.build-shortlist li').length})");
  if(results.explorer.ibocain.count!==oldThread.albums||results.explorer.ibocain.shortlist>5)throw Error('Ibocain inventory is incomplete or default shortlist is large');
  await screenshot('creator-build-matrix-ibocain');
  await cdp('Page.navigate',{url:new URL(oldBuilder+'/?build='+older.buildKey,gallery).href});
  await wait("!!document.querySelector('#build-focus-host article.album[data-build-key=\""+older.buildKey+"\"]')");
  results.explorer.directLink=await evaluate("({era:document.getElementById('build-era').value,detail:document.querySelector('#build-focus-host article.album')?.dataset.buildKey,url:location.search})");
  if(results.explorer.directLink.era!==String(older.era)||results.explorer.directLink.detail!==older.buildKey||!results.explorer.directLink.url.includes('build='+older.buildKey))throw Error('Build deep link failed');

  const oneEra=directory.builders.find(b=>b.albums>0&&b.eras.length===1);
  if(!oneEra)throw Error('No single-era builder exists for matrix edge case');
  await cdp('Page.navigate',{url:new URL(oneEra.builderKey+'/',gallery).href});
  await wait("!!document.getElementById('build-matrix')");
  results.explorer.oneEra=await evaluate("({rows:document.querySelectorAll('#build-matrix tbody tr').length,fullRows:document.querySelectorAll('#build-explorer tbody tr').length})");
  if(results.explorer.oneEra.rows!==1||results.explorer.oneEra.fullRows)throw Error('Single-era profile drew a large default ledger');
  const empty=directory.builders.find(b=>b.albums===0);
  if(!empty)throw Error('The agreed searchable empty profiles disappeared');
  await cdp('Page.navigate',{url:new URL(empty.builderKey+'/',gallery).href});
  await wait("!!document.getElementById('build-browse-summary')");
  results.explorer.empty=await evaluate("({message:document.getElementById('build-browse-summary').textContent,albums:document.querySelectorAll('article.album').length})");
  if(!/No substantial build albums/.test(results.explorer.empty.message)||results.explorer.empty.albums)throw Error('Retained identity has no clear empty state');
  await screenshot('creator-explorer-empty-profile');
  // The builder's own page and the portrait picker on it. Every builder wears a painted
  // face by the archive's pick; the avatar on the builder page is the door to the profile
  // page, where anyone may try another: 96 portraits, Trade=Carpenter leaves four, +red
  // hair leaves one, 24 trades stay in the menu with the empty ones dimmed, Choose dresses
  // the page and the builder page and notes the choice by a beacon the front door logs, the
  // archive's pick undresses. An opt-out level writes the message to paste to @Tugcow.
  // PICKER=1 runs it (any host whose portraits.json carries libraries); without it the leg
  // records why it stood down.
  if(process.env.PICKER==='1'){
    const threadUrl=new URL(photographed.builderKey+'/',gallery).href;
    await cdp('Page.navigate',{url:threadUrl});
    await wait("!!document.querySelector('article.album')&&!!document.querySelector('#hero-avatar img')");
    const libraries=await evaluate("fetch('/chronicles/portraits.json').then(r=>r.ok?r.json():null).then(m=>!!(m&&m.libraries)).catch(()=>false)");
    if(!libraries){
      results.picker={status:'skipped',reason:'portraits.json carries no libraries on this host'};
    }else{
      const door=await evaluate("({href:document.getElementById('hero-avatar').getAttribute('href')||'',tag:document.getElementById('hero-avatar').tagName,face:document.querySelector('#hero-avatar img').getAttribute('src'),disclosure:document.getElementById('hero-portrait-disclosure')?.textContent||''})");
      if(door.tag!=='A'||!door.href.includes('profile/?builder='+photographed.builderKey))throw Error('The avatar is not the door to the profile page');
      if(!/painted by the archive/.test(door.disclosure))throw Error('The builder page carries no portrait disclosure line');
      if(!/\/img\/portraits\/viking96\//.test(door.face))throw Error('The builder page hero does not wear a painted portrait by default: '+door.face);
      const assigned=door.face;
      const profileUrl=new URL('profile/?builder='+photographed.builderKey,gallery).href;
      await cdp('Page.navigate',{url:profileUrl});
      await wait("!document.getElementById('profile-portrait').hidden&&!!document.querySelector('#portrait-current img')&&!document.getElementById('portrait-pick').disabled");
      results.profile=await evaluate("({title:document.getElementById('title').textContent,sections:['profile-portrait','profile-optout','profile-about'].filter(id=>!document.getElementById(id).hidden).length,levels:[...document.querySelectorAll('input[name=optout-level]')].map(i=>i.value),messageHidden:document.getElementById('optout-message-wrap').hidden,current:document.querySelector('#portrait-current img').getAttribute('src'),archive:document.querySelector('#portrait-archive img')?.getAttribute('src')||null,back:document.getElementById('profile-back-link').getAttribute('href')})");
      if(results.profile.sections!==3)throw Error('The profile page is missing a section');
      if(results.profile.levels.join()!=='none,name,erase')throw Error('Opt-out levels are not none, name, erase: '+results.profile.levels.join());
      if(!results.profile.messageHidden)throw Error('The opt-out message shows before a level is picked');
      if(results.profile.current!==assigned||results.profile.archive!==assigned)throw Error('The profile page does not show the archive pick the builder page wears');
      if(await evaluate("/character|archetype|seed|gender|submitted/i.test(document.getElementById('profile').innerText)"))throw Error('The profile page says a banned word');
      // A level writes the message to paste, names the coordinator, and notes itself by beacon.
      await evaluate("document.querySelector('input[name=optout-level][value=name]').click()");
      await wait("!document.getElementById('optout-message-wrap').hidden&&document.getElementById('optout-message').value.length>0");
      results.profile.message=await evaluate("document.getElementById('optout-message').value");
      if(!/^@Tugcow /.test(results.profile.message)||!/Keep the pictures, drop my name/.test(results.profile.message)||!/Receipt: r-\d{8}-[0-9a-f]{8}/.test(results.profile.message))throw Error('The opt-out message is not the one to paste: '+results.profile.message);
      if(!results.profile.message.includes(photographed.builderKey))throw Error('The opt-out message does not name the builder key');
      // The beacon shows in resource timing once its response is in; wait for it.
      await wait("performance.getEntriesByType('resource').some(e=>/portrait-beacon\.txt\?.*action=optout/.test(e.name))");
      const beacons=await evaluate("performance.getEntriesByType('resource').map(e=>e.name).filter(n=>n.includes('portrait-beacon.txt'))");
      if(!beacons.some(n=>/action=optout/.test(n)&&/level=name/.test(n)&&n.includes('builder='+photographed.builderKey)))throw Error('No opt-out beacon was requested: '+JSON.stringify(beacons));
      await screenshot('profile-optout');
      // Anyone may try a portrait: no claim, no sign-in.
      await evaluate("document.getElementById('portrait-pick').click()");
      await wait("!!document.querySelector('#portrait-picker:not([hidden]) .pp-tile')");
      results.picker=await evaluate("({count:document.getElementById('pp-count').textContent,dialog:document.getElementById('portrait-picker').getAttribute('aria-modal')})");
      if(results.picker.count!=='96 portraits')throw Error('Picker did not open on 96 portraits: '+results.picker.count);
      // The grid's faces are real files, not a pattern with {take} left in it: the first
      // twelve tiles are on screen and must decode.
      await wait("[...document.querySelectorAll('#portrait-picker .pp-tile img')].slice(0,12).every(i=>i.complete)");
      results.picker.gridBroken=await evaluate("[...document.querySelectorAll('#portrait-picker .pp-tile img')].slice(0,12).filter(i=>!i.naturalWidth).map(i=>i.getAttribute('src'))");
      if(results.picker.gridBroken.length)throw Error('Picker grid tiles do not load: '+JSON.stringify(results.picker.gridBroken));
      await screenshot('picker-grid');
      if(results.picker.dialog!=='true')throw Error('Picker drawer is not a modal dialog');
      if(await evaluate("/character|archetype|seed|gender/i.test(document.getElementById('portrait-picker').innerText)"))throw Error('The picker says a banned word');
      await evaluate("[...document.querySelectorAll('#portrait-picker .ck')].find(b=>b.dataset.k==='role'&&b.dataset.v==='carpenter').click()");
      await wait("document.getElementById('pp-count').textContent==='4 portraits'");
      await evaluate("[...document.querySelectorAll('#portrait-picker .ck')].find(b=>b.dataset.k==='hair'&&b.dataset.v==='red').click()");
      await wait("document.getElementById('pp-count').textContent==='1 portrait'");
      results.picker.dimmed=await evaluate("document.querySelectorAll('#portrait-picker .ck.zero').length");
      results.picker.trades=await evaluate("document.querySelectorAll('#portrait-picker .grp[data-k=role] .ck').length");
      if(!results.picker.dimmed)throw Error('No zero-count option dimmed after narrowing');
      if(results.picker.trades!==24)throw Error('The Trade menu is not the 24 painted trades: '+results.picker.trades);
      await evaluate("document.querySelector('#portrait-picker .pp-tile').click()");
      await wait("!!document.querySelector('#portrait-picker .pp-preview-wide')&&document.querySelectorAll('#portrait-picker .pp-take').length>=2");
      await screenshot('picker-preview');
      await evaluate("document.getElementById('pp-choose').click()");
      await wait("document.getElementById('portrait-picker').hidden&&/carpenter_f_artisan/.test(document.querySelector('#portrait-current img')?.src||'')");
      await wait("performance.getEntriesByType('resource').some(e=>/portrait-beacon\.txt\?.*action=choose/.test(e.name))");
      results.picker.chosen=await evaluate("({current:document.querySelector('#portrait-current img').getAttribute('src'),note:document.getElementById('portrait-note').textContent,focus:document.activeElement.id,url:location.search,beacons:performance.getEntriesByType('resource').map(e=>e.name).filter(n=>n.includes('portrait-beacon.txt')&&/action=choose/.test(n))})");
      if(results.picker.chosen.focus!=='portrait-pick')throw Error('Focus did not return to the picker control');
      if(!/noted to the archive · receipt r-/.test(results.picker.chosen.note))throw Error('The page does not say the choice was noted: '+results.picker.chosen.note);
      if(!/portrait=viking96%2Fcarpenter_f_artisan/.test(results.picker.chosen.url))throw Error('The address bar does not carry the choice: '+results.picker.chosen.url);
      if(!results.picker.chosen.beacons.some(n=>/tile=viking96%2Fcarpenter_f_artisan/.test(n)&&/take=s\d+/.test(n)&&/receipt=r-/.test(n)))throw Error('No choose beacon was requested: '+JSON.stringify(results.picker.chosen.beacons));
      await screenshot('profile-chosen');
      // The builder page wears it too, on this device.
      await cdp('Page.navigate',{url:threadUrl});
      await wait("/carpenter_f_artisan/.test(document.querySelector('#hero-avatar img')?.src||'')");
      results.picker.hero=await evaluate("document.querySelector('#hero-avatar img').getAttribute('src')");
      // Back on the profile page, the archive's pick undresses it.
      await cdp('Page.navigate',{url:profileUrl});
      await wait("!document.getElementById('profile-portrait').hidden&&!document.getElementById('portrait-archive-pick').disabled");
      await evaluate("document.getElementById('portrait-archive-pick').click()");
      await wait(`document.querySelector('#portrait-current img')?.getAttribute('src')===${JSON.stringify(assigned)}`);
      results.picker.reverted=true;
      await evaluate("localStorage.removeItem('creators-participation-v1')");
    }
  }
  // Page exceptions raised by the creator lane itself are this run's business and still
  // fail it. Anything the world viewer throws after this point belongs to the world leg
  // and is folded into its own verdict.
  if(errors.length)throw Error(errors.join('\n'));
  const errorsBeforeWorld=errors.length;
  let spatialFailure=null;
  if(!worldBase){
    results.spatial={status:'skipped',reason:'no world base URL'};
    results.status='passed';
  }else{
    try{
      // Which eras exist, which are ready and which carry terrain is archive state, not a
      // constant: era 7 gained a context on 2026-09-10 and the old `.analysis-raster` wait
      // became unreachable, because a terrain-bearing era opens in terrain view and draws
      // no analysis raster at all. Ask the catalog which layer this era draws, the same way
      // world-browser-smoke.mjs does, instead of naming one.
      const response=await fetch(new URL('api/eras',worldBase));
      if(!response.ok)throw Error(`api/eras answered ${response.status}`);
      const catalog=await response.json();
      const ready=(catalog.eras||[]).filter(era=>era.status==='ready');
      if(!ready.length)throw Error('World viewer lists no ready era');
      const opening=ready.find(era=>era.slug==='era7')||ready[0];
      await cdp('Page.navigate',{url:new URL('?era='+opening.slug,worldBase).href});
      const layer=opening.terrainAvailable?'.context-raster':'.analysis-raster';
      await waitWorld(`[...document.querySelectorAll('${layer}')].some(i=>i.complete&&i.naturalWidth>0)`);
      results.spatial={status:'passed',era:opening.slug,terrain:Boolean(opening.terrainAvailable),layer,
        terrainStatus:await evaluate("document.getElementById('terrain-status').textContent")};
      await screenshot('construction-era');
      // Era 17 is the switch this has always exercised; fall back to any other ready era
      // rather than hanging on a slug the archive no longer publishes.
      const target=ready.find(era=>era.slug==='era17')||ready.find(era=>era.slug!==opening.slug);
      if(!target)throw Error('Only one ready era: nothing to switch to');
      await evaluate(`document.getElementById('era-select').value=${JSON.stringify(target.slug)};document.getElementById('era-select').dispatchEvent(new Event('change'))`);
      await waitWorld("[...document.querySelectorAll('.context-raster')].some(i=>i.complete&&i.naturalWidth>0)");
      if(await evaluate("new URLSearchParams(location.search).has('build')"))throw Error('Era switch retained previous build');
      results.switch=await evaluate("({era:document.getElementById('era-select').value,context:document.querySelector('.context-raster').src,world:document.getElementById('public-world-name').textContent})");
      if(results.switch.era!==target.slug)throw Error('Era select did not settle on the switched era');
      if(!new URL(results.switch.context).searchParams.get('era'))throw Error('Terrain request lost era scope');
      await screenshot(target.slug);
      const late=errors.slice(errorsBeforeWorld);
      if(late.length)throw Error(late.join('\n'));
      results.status='passed';
    }catch(error){
      results.spatial={status:'failed',error:String(error?.message||error)};
      results.status='passed-with-spatial-failure';
      if(strictWorld)spatialFailure=error;
    }
  }
  await finish();
  // --strict-world still gets the receipt first: the verdict is the artifact, and an
  // exit code alone cannot say which wait timed out.
  if(spatialFailure)throw spatialFailure;
}catch(error){
  if(!receiptWritten){
    results.status='failed';
    results.error=String(error?.message||error);
    await finish();
  }
  throw error;
}finally{socket.close();browser.kill();await new Promise(r=>setTimeout(r,500));await rm(profile,{recursive:true,force:true}).catch(()=>{});}
