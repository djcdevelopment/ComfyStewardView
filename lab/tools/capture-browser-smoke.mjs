import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import crypto from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const option=name=>process.argv[process.argv.indexOf(name)+1];
const {chromium}=await import(pathToFileURL(path.resolve(option('--playwright'))));
const output=path.resolve(option('--out'));fs.mkdirSync(output,{recursive:true});
const staticRoot=path.join(root,'lab/src/main/resources/static');
const instance=new Float32Array(20);instance[0]=instance[5]=instance[10]=6;instance[15]=1;instance[16]=.55;instance[17]=.7;instance[18]=.8;instance[19]=1;
const bytes=Buffer.from(instance.buffer);
const manifest={schema:'steward-zdo-scene/v2',snapshotId:7,snapshotHash:'a'.repeat(64),renderInstances:1,instanceStride:80,instanceBytes:80,
  instanceSha256:crypto.createHash('sha256').update(bytes).digest('hex'),rndCameraOrigin:[100,20,300],home:{target:[0,0,0],radiusM:5}};
const json=Buffer.from(JSON.stringify(manifest)),offset=Math.ceil((16+json.length)/4)*4,scene=Buffer.alloc(offset+80);
scene.write('SV3D');scene.writeUInt32LE(2,4);scene.writeUInt32LE(json.length,8);scene.writeUInt32LE(offset,12);json.copy(scene,16);bytes.copy(scene,offset);
const camera={lens:[100,22,285],yaw:0,pitch:5,roll:0,verticalFov:72,width:1920,height:1080,targetDistance:15};
const photo={id:'fixture',label:'Archived timber house',buildLabel:'Era 11 · timber house',source:{photoId:'fixture',buildKey:'a'.repeat(64),world:{id:'ComfyEra11'}},images:{thumbnail:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="116" height="72"><rect width="116" height="72" fill="%23576d6d"/></svg>'},camera,availability:{compose:true,replay:true,reason:''}};
const unavailable={...photo,id:'unavailable',label:'Photograph with missing pose',availability:{compose:false,replay:false,reason:'Recorded lens position is unavailable.'}};
let exported;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/gallery/'){res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(path.join(root,'tools/selfie-stick/gallery/index.html')));return;}
  if(url.pathname==='/gallery/index.json'){
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({world:'Archive fixture',era:'era11',worldUrl:`http://127.0.0.1:${server.address().port}`,n:1,runs:1,
      environments:['Clear'],variants:['detail'],perspectives:['orbit'],kinds:[],regions:[],areas:[],flashes:[],
      images:[{id:photo.id,cluster_id:'fixture',label:photo.label,variant:'detail',perspective:'orbit',published:true,source:'orbit',pieces:1}]}));return;
  }
  if(['/gallery/eras.json','/gallery/depth.json','/gallery/judge.json'].includes(url.pathname)){res.setHeader('Content-Type','application/json');res.end('{}');return;}
  if(url.pathname==='/api/captures'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({schema:'steward-capture-catalog/v1',downloadsEnabled:true,photos:[photo,unavailable]}));return;}
  if(url.pathname==='/api/captures/fixture'||url.pathname==='/api/captures/unavailable'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(url.pathname.endsWith('/fixture')?photo:unavailable));return;}
  if(url.pathname==='/api/captures/fixture/scene'){res.end(scene);return;}
  if(url.pathname.endsWith('/export')){let body='';for await(const part of req)body+=part;exported=JSON.parse(body);res.setHeader('Content-Type','application/zip');res.end(Buffer.from('capture-fixture'));return;}
  const name=path.basename(url.pathname),file=path.join(staticRoot,name||'capture.html');
  if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-unsafe-webgpu']});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>{errors.push(error.message);console.error('PAGE',error.message);});
  page.on('console',message=>{if(message.type()==='error')console.error('CONSOLE',message.text());});
  await page.goto(`http://127.0.0.1:${server.address().port}/gallery/`);
  await page.locator('.cell').first().click();await page.getByRole('link',{name:'Compose photograph'}).click();
  await page.waitForFunction(()=>window.captureComposer?.getCamera()!=null).catch(async error=>{console.error(await page.locator('.capture-status').innerText());throw error;});
  await page.locator('[data-control=download]').waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('[data-control=download]').disabled).catch(async error=>{console.error(await page.locator('.capture-status').innerText());throw error;});
  assert.deepEqual(await page.evaluate(()=>window.captureComposer.getCamera()),camera);
  assert.equal(await page.locator('[data-control=lens]').inputValue(),'72');
  await page.screenshot({path:path.join(output,'lens.png')});
  for(let i=0;i<12;i++){await page.locator('[data-control=view]').click();}
  await page.setViewportSize({width:1000,height:900});
  assert.deepEqual(await page.evaluate(()=>window.captureComposer.getCamera()),camera);
  await page.locator('[data-control=frame]').selectOption('Portrait');
  await page.locator('[data-control=lens]').selectOption('35');
  await page.locator('[data-control=size]').selectOption('3840');
  const edited=await page.evaluate(()=>window.captureComposer.getCamera());assert.equal(edited.width,2160);assert.equal(edited.height,3840);assert.equal(edited.verticalFov,35);
  await page.locator('[data-control=view]').click();await page.screenshot({path:path.join(output,'outside.png')});
  const beforeOrbit=await page.evaluate(()=>window.captureComposer.getCamera());
  const box=await page.locator('.capture-main').boundingBox();await page.mouse.move(box.x+100,box.y+100);await page.mouse.down();await page.mouse.move(box.x+170,box.y+140);await page.mouse.up();
  assert.deepEqual(await page.evaluate(()=>window.captureComposer.getCamera()),beforeOrbit);
  await page.locator('[data-control=position]').click();
  await page.locator('[data-coordinate="1"]').fill('25.2');await page.locator('[data-coordinate="1"]').press('Tab');
  assert.equal((await page.evaluate(()=>window.captureComposer.getCamera())).lens[1],25.2);
  await page.locator('[data-control=reset]').click();assert.deepEqual(await page.evaluate(()=>window.captureComposer.getCamera()),camera);
  await page.locator('[data-aim]').click();
  const sceneBox=await page.locator('.capture-main').boundingBox();
  await page.mouse.click(sceneBox.x+sceneBox.width/2,sceneBox.y+sceneBox.height/2);
  await page.waitForFunction(()=>window.captureComposer.getCamera().pitch!==5);
  const picked=await page.evaluate(()=>window.captureComposer.getCamera());
  assert.deepEqual(picked.lens,camera.lens);assert.notEqual(picked.pitch,camera.pitch);
  const handle=await page.locator('[data-handle=position]').boundingBox();
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();
  await page.mouse.move(handle.x+handle.width/2+20,handle.y+handle.height/2+10);await page.mouse.up();
  const dragged=await page.evaluate(()=>window.captureComposer.getCamera());assert.notDeepEqual(dragged.lens,picked.lens);assert.equal(dragged.yaw,picked.yaw);
  await page.locator('[data-control=coverage]').click();assert.deepEqual(await page.evaluate(()=>window.captureComposer.getCamera()),dragged);
  await page.locator('[data-control=reset]').click();
  await page.locator('[data-control=view]').click();await page.locator('.capture-main').focus();await page.keyboard.press('w');
  assert.notDeepEqual((await page.evaluate(()=>window.captureComposer.getCamera())).lens,camera.lens);
  const download=page.waitForEvent('download');await page.locator('[data-control=download]').click();await download;
  assert.deepEqual(exported.camera,await page.evaluate(()=>window.captureComposer.getCamera()));
  await page.evaluate(()=>window.captureComposer.loadPhoto('unavailable'));
  assert.match(await page.locator('.capture-status').innerText(),/Recorded lens position/);assert.equal(await page.locator('[data-control=download]').isDisabled(),true);
  assert.equal(await page.locator('[data-coordinate="1"]').isDisabled(),true);assert.equal(await page.locator('[data-aim]').isDisabled(),true);
  assert.equal(await page.locator('.capture-preview').isHidden(),true);
  const noGpu=await browser.newPage();await noGpu.addInitScript(()=>Object.defineProperty(navigator,'gpu',{value:undefined}));await noGpu.goto(`http://127.0.0.1:${server.address().port}/capture.html`);
  await noGpu.waitForFunction(()=>document.querySelector('.capture-status').textContent.includes('webgpu_unavailable'));
  assert.equal(await noGpu.locator('[data-control=download]').isDisabled(),true);
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'receipt.json'),JSON.stringify({status:'passed',proof:'real WebGPU fixture interaction',checks:['gallery lightbox entry','reference','presets','12 view switches','resize','observer independence','position edit','aim geometry picking','position handle drag','coverage preserves camera','reset','keyboard','export','missing pose','WebGPU unavailable']},null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
