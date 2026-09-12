import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
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
const worldBase=world?new URL(world.endsWith('/')?world:world+'/'):null;
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
  // The one-story page (pass 3): the carousel of photographed builds sits under the hero
  // with its banner and its details article, the attribution sentence is said once, every
  // Details drop-down in the rest table starts folded, and the notes strip renders.
  results.story=await evaluate("({stage:document.querySelectorAll('#work .work-banner').length,rail:document.querySelectorAll('#work .work-tile').length,details:document.querySelectorAll('#work article.album.work-details button.primary').length,notes:document.querySelectorAll('.albums-note').length,restRows:document.querySelectorAll('article.album.rest-row').length,feedback:document.querySelectorAll('.rest-feedback [role=radio]').length,folded:[...document.querySelectorAll('article.album .album-more')].every(m=>m.hidden),notesStrip:!document.getElementById('thread-notes')?.hidden})");
  if(results.story.stage!==1||results.story.rail<1)throw Error('Builder page drew no work carousel for a photographed thread');
  if(results.story.details!==1)throw Error('The carousel details lost the claim control');
  if(results.story.notes!==1)throw Error('Attribution sentence is not said exactly once');
  if(results.story.restRows&&results.story.feedback!==results.story.restRows*3)throw Error('The rest table lost its feedback marks');
  if(!results.story.folded)throw Error('A Details drop-down did not start folded');
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
  // The pair view: the Top 8 ribbon picks one co-builder and the panel below it draws that
  // pairing. A thread whose every album is solo draws no ribbon at all and is perfectly
  // legal, so the whole leg sits inside the "there is a ribbon" branch rather than
  // failing a builder for having worked alone.
  if(await evaluate("!!document.querySelector('.top8')")){
    await wait("!!document.querySelector('.top8 button.top8-chip[aria-pressed=\"true\"]')");
    results.pair=await evaluate("({chips:document.querySelectorAll('.top8-chip').length,hidden:document.getElementById('pair-view')?.hidden,ledgerRows:document.querySelectorAll('#pair-ledger tbody tr').length})");
    if(results.pair.hidden!==false)throw Error('Pair view stayed hidden with a co-builder selected');
    if(!results.pair.ledgerRows)throw Error('Pair view drew no shared builds for the selected pairing');
    // The tree is drawn on the profile beside the ribbon, the pair's detail starts folded,
    // and the branch of the selected pairing is the one lit.
    results.tree=await evaluate("({branches:document.querySelectorAll('#kin-beside .kin-branch').length,active:document.querySelector('#kin-beside .kin-branch.is-active')?.dataset.builderKey||null,pressed:document.querySelector('.top8-chip[aria-pressed=\"true\"]')?.dataset.builderKey||null,moreOpen:document.getElementById('pair-more')?.open})");
    if(!results.tree.branches)throw Error('Builder page drew no kinship tree beside the ribbon');
    if(results.tree.active!==results.tree.pressed)throw Error('The lit branch and the pressed chip disagree');
    if(results.tree.moreOpen!==false)throw Error('Pair view detail did not start folded');
    await screenshot('pair-view');
    // Slim pair (pass 3b): no tab strip and no second photograph -- the standing chip sits
    // in the head row, the ally and the reverse link share a row, the ledger runs full
    // width. Picking a photographed row turns the work carousel to that build without
    // moving the page; the Details fold stays put.
    results.pair.slim=await evaluate("({modes:!!document.getElementById('pair-modes'),photos:!!document.getElementById('pair-photos'),standing:!!document.querySelector('#pair-view #pair-head #pair-standing'),who:!!document.querySelector('#pair-view #pair-who #pair-ally')&&!!document.querySelector('#pair-view #pair-who #pair-reverse')})");
    if(results.pair.slim.modes||results.pair.slim.photos)throw Error('Pair view still draws the tab strip or the photograph panel');
    if(!results.pair.slim.standing||!results.pair.slim.who)throw Error('Pair view lost its head row or its who row');
    const pickable=await evaluate("(()=>{const rows=[...document.querySelectorAll('#pair-ledger tbody tr')];const tiles=new Set([...document.querySelectorAll('#work .work-tile')].map(t=>t.dataset.buildKey));const row=rows.find(r=>r.getAttribute('aria-selected')!=='true'&&tiles.has(r.dataset.buildKey));return row?row.dataset.buildKey:null})()");
    if(pickable){
      // "Did not move" is measured where the visitor is looking: the pair view's place in
      // the viewport, with the view scrolled into it as a visitor would have. scrollY itself
      // may shift, because the carousel above changes height when it turns and the
      // browser's scroll anchoring keeps the pair view where it was.
      const before=await evaluate("(()=>{const v=document.getElementById('pair-view');v.scrollIntoView({block:'start'});scrollBy(0,-40);return Math.round(v.getBoundingClientRect().top)})()");
      await evaluate(`document.querySelector('#pair-ledger tr[data-build-key="${pickable}"] .pair-ledger-pick').click()`);
      results.pair.pick=await evaluate(`({selected:document.querySelector('#pair-ledger tr[aria-selected="true"]')?.dataset.buildKey,tile:document.querySelector('#work .work-tile[aria-pressed="true"]')?.dataset.buildKey,top:Math.round(document.getElementById('pair-view').getBoundingClientRect().top),before:${before},url:location.search})`);
      if(results.pair.pick.selected!==pickable)throw Error('Ledger pick did not select the row');
      if(results.pair.pick.tile!==pickable)throw Error('Ledger pick did not turn the carousel to the build');
      if(Math.abs(results.pair.pick.top-results.pair.pick.before)>2)throw Error('Ledger pick moved the pair view in the viewport');
      if(/[?&]view=/.test(results.pair.pick.url))throw Error('Pair view still writes ?view=');
    }else results.pair.pick='skipped: no photographed shared build besides the open one';
    // A shared ?kin= link must open on that pairing, not on whichever one leads the
    // ribbon -- the second chip proves it, because the first is what an unlinked page
    // would have selected anyway.
    const chipKeys=await evaluate("[...document.querySelectorAll('.top8-chip')].map(c=>c.dataset.builderKey)");
    const deepKey=chipKeys[1]||chipKeys[0];
    await cdp('Page.navigate',{url:new URL(photographed.builderKey+'/?kin='+deepKey,gallery).href});
    await wait(`!!document.querySelector('.top8-chip[data-builder-key="${deepKey}"][aria-pressed="true"]')`);
    results.pair.deepLink=true;
  }else{
    results.pair={status:'skipped',reason:'this thread shares no build with anybody'};
  }
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
  // The portrait picker (S2, preview mode). It exists only where portraits.json carries
  // libraries -- the live v1 manifest shows no control at all -- and only for a browser
  // holding a built claim on the profile, so this leg seeds that claim the way the claim
  // dialog would, reloads, and walks the drawer: 144 portraits, Trade=Carpenter leaves
  // eight, choosing the painted one dresses the hero and the tree's anchor on this device,
  // focus comes back to the control, the archive's pick undresses them again. PICKER=1
  // runs it (a dev host); without it the leg records why it stood down.
  if(process.env.PICKER==='1'){
    const profile=new URL(photographed.builderKey+'/',gallery).href;
    await cdp('Page.navigate',{url:profile});
    await wait("!!document.querySelector('article.album')");
    const libraries=await evaluate("fetch('/chronicles/portraits.json').then(r=>r.ok?r.json():null).then(m=>!!(m&&m.libraries)).catch(()=>false)");
    if(!libraries){
      results.picker={status:'skipped',reason:'portraits.json carries no libraries on this host'};
    }else{
      if(await evaluate("!!document.getElementById('hero-portrait-pick')"))throw Error('Picker control shown to a visitor with no claim on the profile');
      await evaluate(`(()=>{const now=new Date().toISOString();const buildKey=document.querySelector('article.album[data-build-key]').dataset.buildKey;const state={schema:'steward-creator-participation-local/v1',createdAt:now,updatedAt:now,participant:'smoke',claims:{[buildKey]:{claimId:'claim_smoke',buildKey,builderKey:'${photographed.builderKey}',buildLabel:'smoke',kind:'built',participant:'smoke',createdAt:now,deliveryStatus:'local'}},requests:{},kinshipTags:{},priorities:{},portraits:{}};localStorage.setItem('creators-participation-v1',JSON.stringify(state));return buildKey;})()`);
      await cdp('Page.reload',{});
      await wait("!!document.getElementById('hero-portrait-pick')");
      await evaluate("document.getElementById('hero-portrait-pick').click()");
      await wait("!!document.querySelector('#portrait-picker:not([hidden]) .pp-tile')");
      results.picker=await evaluate("({count:document.getElementById('pp-count').textContent,tiles:document.querySelectorAll('#portrait-picker .pp-tile').length,groups:document.querySelectorAll('#portrait-picker .grp').length,dialog:document.getElementById('portrait-picker').getAttribute('aria-modal')})");
      if(results.picker.count!=='144 portraits')throw Error('Picker did not open on 144 portraits: '+results.picker.count);
      if(results.picker.dialog!=='true')throw Error('Picker drawer is not a modal dialog');
      const banned=await evaluate("/character|archetype|seed|gender/i.test(document.getElementById('portrait-picker').innerText)");
      if(banned)throw Error('The picker says a banned word');
      await evaluate("[...document.querySelectorAll('#portrait-picker .ck')].find(b=>b.dataset.k==='role'&&b.dataset.v==='carpenter').click()");
      await wait("document.getElementById('pp-count').textContent==='8 portraits'");
      results.picker.carpenters=await evaluate("document.querySelectorAll('#portrait-picker .pp-tile').length");
      if(results.picker.carpenters!==8)throw Error('Trade=Carpenter did not leave eight portraits');
      // Hair is a painted-only facet: red leaves the one painted carpenter with red hair
      // and the four slate joiners (which have no hair tag and so still match), and the
      // trades no red-haired portrait wears dim to 40 % without leaving the menu.
      await evaluate("[...document.querySelectorAll('#portrait-picker .ck')].find(b=>b.dataset.k==='hair'&&b.dataset.v==='red').click()");
      await wait("document.getElementById('pp-count').textContent==='5 portraits'");
      results.picker.dimmed=await evaluate("document.querySelectorAll('#portrait-picker .ck.zero').length");
      results.picker.trades=await evaluate("document.querySelectorAll('#portrait-picker .grp[data-k=role] .ck').length");
      if(!results.picker.dimmed)throw Error('No zero-count option dimmed after narrowing');
      if(results.picker.trades!==30)throw Error('A zero-count trade left the menu instead of dimming');
      await evaluate("[...document.querySelectorAll('#portrait-picker .pp-tile')].find(b=>b.dataset.tile.startsWith('viking96/')).click()");
      await wait("!!document.querySelector('#portrait-picker .pp-preview-wide')&&document.querySelectorAll('#portrait-picker .pp-take').length>=2");
      await screenshot('picker-preview');
      await evaluate("document.getElementById('pp-choose').click()");
      await wait(`document.getElementById('portrait-picker').hidden&&/viking96\\//.test(document.querySelector('#hero-avatar img')?.src||'')&&[...document.querySelectorAll('#kin-beside img[data-portrait-key="${photographed.builderKey}"]')].some(i=>/viking96\\//.test(i.src))`);
      results.picker.hero=await evaluate("document.querySelector('#hero-avatar img').getAttribute('src')");
      results.picker.note=await evaluate("document.getElementById('hero-portrait-note').textContent");
      results.picker.focus=await evaluate("document.activeElement.id");
      if(results.picker.focus!=='hero-portrait-pick')throw Error('Focus did not return to the picker control');
      if(!results.picker.note.includes('recorded on this device'))throw Error('The hero does not say the portrait is recorded on this device');
      await screenshot('picker-chosen');
      await evaluate("document.getElementById('hero-portrait-pick').click()");
      await wait("!document.getElementById('portrait-picker').hidden&&!document.getElementById('pp-archive').disabled");
      await evaluate("document.getElementById('pp-archive').click()");
      await wait("document.getElementById('portrait-picker').hidden&&!/viking96\\//.test(document.querySelector('#hero-avatar img')?.src||'')");
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
  if(!world){
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
}finally{socket.close();browser.kill();}
