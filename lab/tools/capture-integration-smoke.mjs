import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import crypto from 'node:crypto';
const option=name=>process.argv[process.argv.indexOf(name)+1];
const {chromium}=await import(pathToFileURL(path.resolve(option('--playwright'))));
const out=path.resolve(option('--out'));fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-unsafe-webgpu']});
const proof=[];
try{
  let expected,exported;
  for(const host of ['gallery','studio']) {
    const page=await browser.newPage({viewport:{width:1500,height:1150}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(option('--'+host));
    if(host==='studio'){
      await page.waitForFunction(()=>typeof document.querySelector('#library-toggle').onclick==='function');
      if(await page.locator('#library-toggle').getAttribute('aria-expanded')==='true')await page.locator('#library-toggle').click();
      await page.waitForFunction(()=>!document.querySelector('#library-panel').classList.contains('open'));
      await page.locator('#creator-capture-mode').click();
    }
    const key=host==='studio'?'studioCaptureComposer':'captureComposer';
    await page.waitForFunction(k=>window[k]?.getCamera()!=null,key);
    const initial=await page.evaluate(k=>window[k].getCamera(),key);
    if(expected)assert.deepEqual(initial,expected);else expected=initial;
    assert.doesNotMatch(await page.locator('.capture-status').innerText(),/unavailable|mismatch|failed/i);
    await page.locator('[data-control=view]').click();
    await page.locator('.capture-composer').screenshot({path:path.join(out,host+'-outside.png')});
    assert.equal(await page.locator('.capture-guides circle').count(),2);
    await page.locator('[data-control=frame]').selectOption('Square');await page.locator('[data-control=lens]').selectOption('90');
    const edited=await page.evaluate(k=>window[k].getCamera(),key);assert.equal(edited.width,edited.height);assert.equal(edited.verticalFov,90);
    await page.locator('[data-control=reset]').click();assert.deepEqual(await page.evaluate(k=>window[k].getCamera(),key),initial);
    if(host==='studio'){
      await page.locator('#creator-gameplay-mode').click();await page.locator('#creator-capture-mode').click();
      assert.deepEqual(await page.evaluate(k=>window[k].getCamera(),key),initial);
    }
    await page.waitForFunction(()=>!document.querySelector('[data-control=download]').disabled);
    const pending=page.waitForEvent('download');await page.locator('[data-control=download]').click();const download=await pending;
    const downloadPath=path.join(out,host+'-capture.zip');await download.saveAs(downloadPath);const bytes=fs.readFileSync(downloadPath);
    if(exported)assert.deepEqual(bytes,exported);else exported=bytes;
    const base=new URL(option('--'+host)).origin;
    if(host==='studio')assert.equal((await page.request.get(base+'/api/v2/quest-studio/captures')).status(),403);
    assert.deepEqual(errors,[]);
    proof.push({host,status:'passed',initial,downloadsEnabled:true,download:{bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}});
    await page.close();
  }
  fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify({status:'passed',proof:'archived build rendered in both host applications',hosts:proof},null,2));
}finally{await browser.close();}
