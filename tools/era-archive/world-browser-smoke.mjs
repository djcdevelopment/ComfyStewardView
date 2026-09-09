import {spawn} from 'node:child_process';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const [baseArg,casesFile,outputArg]=process.argv.slice(2);
if(!baseArg||!casesFile||!outputArg)throw Error('Usage: world-browser-smoke.mjs <world-url> <build-cases.json> <output-dir>');
const base=new URL(baseArg),output=path.resolve(outputArg),cases=JSON.parse((await readFile(casesFile,'utf8')).replace(/^\uFEFF/,''));
const url=(route,query={})=>{const u=new URL(route,base);for(const [k,v] of Object.entries(query))u.searchParams.set(k,String(v));return u;};
const json=async u=>{const r=await fetch(u);if(!r.ok)throw Error(`${r.status} ${u}`);return r.json();};
const results={eras:[],builds:[]};
const catalog=await json(url('api/eras'));
for(const era of catalog.eras){
  if(era.status!=='ready')throw Error(`${era.slug} is not spatially ready`);
  const boot=await json(url('api/bootstrap',{era:era.slug}));
  if(boot.snapshots.length!==1||boot.snapshots[0].snapshotId!==era.snapshotId)throw Error('Era snapshot isolation failed');
  if(boot.terrainAvailable!==era.terrainAvailable||!boot.sceneAvailable)throw Error('Capability mismatch');
  const manifest=await json(url('api/manifest',{era:era.slug,snapshot:era.snapshotId}));
  if(![320,160,80,64,16].every(size=>manifest.layers.some(layer=>layer.cellSize===size)))throw Error('Incomplete zoom ladder');
  results.eras.push({era:era.slug,snapshot:era.snapshotId,terrain:boot.terrainAvailable,generation:boot.context?.generationMode||null});
}
if((await fetch(url('api/manifest',{era:'era7',snapshot:107}))).status!==400)throw Error('Cross-snapshot query admitted');
if((await fetch(url('api/items',{era:'era7',snapshot:1001,lens:'build-density',minX:-100,maxX:100,minZ:-100,maxZ:100,biomes:'meadows'}))).status!==400)throw Error('Terrain-free era admitted biome query');
await mkdir(output,{recursive:true});await mkdir(path.join(output,'downloads'),{recursive:true});
const chrome=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser=spawn(chrome,['--headless=new','--no-first-run','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-sync','--mute-audio','--enable-features=WebGPUDeveloperFeatures','--remote-debugging-port=0','--remote-allow-origins=*','--window-size=1600,1000',`--user-data-dir=${path.join(output,'profile')}`,'about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
let socket,stderr='';
try{
  const ws=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),15000);browser.stderr.on('data',b=>{stderr+=b;const m=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});browser.once('exit',()=>reject(Error('Chrome exited')));});
  const http=ws.replace('ws://','http://').replace(/\/devtools\/browser\/.*$/,'');
  const target=await fetch(http+'/json/new?about:blank',{method:'PUT'}).then(r=>r.json());
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>socket.onopen=r);
  let id=0;const pending=new Map(),errors=[];
  socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
  const wait=async expression=>{for(let i=0;i<240;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,250));}throw Error('Timed out: '+expression);};
  const screenshot=async name=>{const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,name+'.png'),Buffer.from(shot.data,'base64'));};
  await cdp('Page.enable');await cdp('Runtime.enable');
  await cdp('Page.setDownloadBehavior',{behavior:'allow',downloadPath:path.join(output,'downloads')});
  await cdp('Page.navigate',{url:url('',{era:'era7'}).href});
  await wait("[...document.querySelectorAll('.analysis-raster')].some(i=>i.complete&&i.naturalWidth>0)");
  await new Promise(r=>setTimeout(r,400));
  await evaluate("document.getElementById('quick-start-close').click()");
  if(await evaluate("document.querySelectorAll('.context-raster').length")!==0)throw Error('Terrain-free era rendered a context image');
  if(!await evaluate("document.querySelector('[data-view-mode=biomes]').disabled"))throw Error('Unavailable biome button enabled');
  await screenshot('era7-overview');
  for(const item of cases){
    await cdp('Page.navigate',{url:url('',{era:item.era,build:item.buildKey}).href});
    await wait("document.querySelectorAll('.inspect-item').length>0");
    await evaluate("{const confirm=document.getElementById('inspect-scene-confirm');if(!confirm.hidden&&!confirm.disabled)confirm.click();}");
    await wait("Boolean(document.getElementById('inspect-3d').getAttribute('href'))");
    const inspect=await evaluate("({selected:Number(document.getElementById('inspect-total').textContent.replaceAll(',','')),items:document.querySelectorAll('.inspect-item').length,scene:document.getElementById('inspect-3d').href,note:document.getElementById('terrain-status').textContent})");
    if(inspect.selected!==item.pieces)throw Error(`Exact build count mismatch ${inspect.selected} != ${item.pieces}`);
    if(new URL(inspect.scene).searchParams.get('era')!==item.era||new URL(inspect.scene).searchParams.get('build')!==item.buildKey)throw Error('Scene link lost scope');
    await screenshot(item.era+'-inspection');
    await cdp('Page.navigate',{url:inspect.scene});
    await wait("['ready','ok','error','device-lost'].includes(window.__stewardSceneReceipt?.status)");
    const scene=await evaluate('window.__stewardSceneReceipt');
    const back=new URL(await evaluate("document.querySelector('[data-return-map]').href"));
    if(back.searchParams.get('era')!==item.era||back.searchParams.get('build')!==item.buildKey)throw Error('Return from scene lost era/build scope');
    if(!['ready','ok'].includes(scene.status)||scene.pieces!==item.pieces||scene.validationErrors.length)throw Error('Scene validation failed: '+JSON.stringify(scene));
    await screenshot(item.era+'-scene');
    await evaluate("document.getElementById('save-image').click()");
    let exported=false;
    for(let attempt=0;attempt<80;attempt++){
      const files=(await readdir(path.join(output,'downloads'))).filter(f=>f.endsWith('.png'));
      if(files.length>results.builds.length){
        const bytes=await readFile(path.join(output,'downloads',files.at(-1)));
        if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){exported=true;break;}
      }
      await new Promise(r=>setTimeout(r,125));
    }
    if(!exported)throw Error('PNG export did not finish before leaving the scene');
    results.builds.push({era:item.era,buildKey:item.buildKey,inspect,scene});
  }
  await cdp('Page.navigate',{url:url('',{era:'era14'}).href});
  await wait("[...document.querySelectorAll('.context-raster')].some(i=>i.complete&&i.naturalWidth>0)");
  if(!await evaluate("document.getElementById('terrain-status').textContent.includes('current game')"))throw Error('Regenerated terrain lacks its disclosure');
  await screenshot('era14-overview');
  await evaluate("document.getElementById('era-select').value='era7';document.getElementById('era-select').dispatchEvent(new Event('change'))");
  await wait("document.body.classList.contains('construction-only')&&[...document.querySelectorAll('.analysis-raster')].some(i=>i.complete&&i.naturalWidth>0)");
  if(await evaluate("document.querySelectorAll('.context-raster').length")!==0)throw Error('Terrain leaked across eras');
  if(await evaluate("new URLSearchParams(location.search).has('build')"))throw Error('Build scope survived era switch');
  await evaluate("document.getElementById('era-select').value='era17';document.getElementById('era-select').dispatchEvent(new Event('change'))");
  await wait("[...document.querySelectorAll('.context-raster')].some(i=>i.complete&&i.naturalWidth>0)");
  await screenshot('era17-regression');
  results.downloads=(await readdir(path.join(output,'downloads'))).filter(f=>f.endsWith('.png'));
  if(results.downloads.length!==cases.length)throw Error('PNG export did not complete');
  if(errors.length)throw Error(errors.join('\n'));
  results.status='passed';await writeFile(path.join(output,'receipt.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({status:results.status,eras:results.eras,builds:results.builds.map(b=>({era:b.era,pieces:b.scene.pieces})),exports:results.downloads.length}));
}finally{socket?.close();browser.kill();}
