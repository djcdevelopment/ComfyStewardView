import {mountCreatorScene} from './creator-scene.js';
import {LENSES,FRAMES,dimensions,validateCamera,sceneCamera,corners,target,aimAt,moveCamera,toLocal,toWorld,project,add,sub,scale,dot,normalize,cross} from './camera-model.js';

export const CAPTURE_COMPOSER = 'comfy-steward-capture-composer/v1';
const svgNS='http://www.w3.org/2000/svg';
const icons={gallery:'▧',position:'✥',aim:'◎',lens:'◉',frame:'▣',size:'↗',view:'◈',coverage:'△',reset:'↶',download:'↓'};

// Both hosts mount this exact artifact. The host supplies only the catalog API base.
export async function mountCaptureComposer(root,{apiBase='api/captures',photoId=null,fetcher=fetch}={}) {
  root.classList.add('capture-composer');
  root.innerHTML=`<header class="capture-heading"><div><span class="capture-eyebrow">ARCHIVE PHOTOGRAPHY</span><h2>Compose a photograph</h2></div><img class="capture-reference" alt="Reference photograph" hidden></header>
    <div class="capture-bar" role="toolbar" aria-label="Capture controls"></div>
    <div class="capture-gallery" hidden><label>Archived build<select data-build></select></label><label>Reference photograph<select data-photo></select></label></div>
    <div class="capture-position" hidden><fieldset><legend>Lens position · world metres</legend><label>X<input data-coordinate="0" type="number" step=".1"></label><label>Elevation<input data-coordinate="1" type="number" step=".1"></label><label>Z<input data-coordinate="2" type="number" step=".1"></label></fieldset><button data-place title="Pick the player's standing point on scene geometry">Pick position</button><button data-aim title="Pick the lens target on scene geometry">Pick aim</button><span>Drag the yellow position or aim handle in Outside view.</span></div>
    <div class="capture-stage"><div class="capture-frame"><canvas class="capture-main" tabindex="0" aria-label="Composition viewport"></canvas><svg class="capture-guides" aria-label="Estimated camera coverage"></svg></div><div class="capture-preview" hidden><span>Live lens</span><canvas aria-label="Live lens preview"></canvas></div></div>
    <p class="capture-help">Lens: drag to look · WASD move · Q/E down/up · Shift faster. Outside: drag to orbit · wheel to zoom.</p>
    <p class="capture-status" role="status" aria-live="polite"></p><p class="capture-estimate">Coverage is an estimate from archived scene geometry. The reference gives visual context; your local game renders the finished photograph.</p>`;
  const q=s=>root.querySelector(s),bar=q('.capture-bar'),events=new AbortController();
  const status=text=>{q('.capture-status').textContent=text;};
  let catalog,photo,camera,reference,view='lens',coverage=true,main,preview,origin=[0,0,0],disposed=false,loadSequence=0,pickMode=null,healthy=false;
  const buildIdentity=p=>`${p.source.world.era||p.source.world.id}:${p.source.buildKey}`;
  const api=apiBase.replace(/\/$/,'');
  const listen=(node,event,fn,extra={})=>node.addEventListener(event,fn,{...extra,signal:events.signal});
  function button(key,label,title,action) {
    const b=document.createElement('button');b.type='button';b.dataset.control=key;b.title=title;
    b.innerHTML=`<span aria-hidden="true">${icons[key]}</span> <span>${label}</span>`;
    listen(b,'click',()=>Promise.resolve(action()).catch(e=>status(e.message)));bar.append(b);return b;
  }
  function select(key,label,title,options,change) {
    const l=document.createElement('label');l.title=title;l.innerHTML=`<span aria-hidden="true">${icons[key]}</span> ${label}`;
    const s=document.createElement('select');s.setAttribute('aria-label',label);s.dataset.control=key;
    for(const [text,value] of options){const o=new Option(text,value);s.add(o);}l.append(s);bar.append(l);
    listen(s,'change',()=>{try{change(s.value);}catch(e){status(e.message);sync();}});return s;
  }
  button('gallery','Gallery','Choose an archived build and reference photograph',()=>q('.capture-gallery').hidden=!q('.capture-gallery').hidden);
  button('position','Position / Aim','Edit lens coordinates or pick position and aim on geometry',()=>q('.capture-position').hidden=!q('.capture-position').hidden);
  const lens=select('lens','Lens','Vertical field of view',Object.entries(LENSES),v=>update({...camera,verticalFov:Number(v)}));
  const frame=select('frame','Frame','Output frame shape',Object.keys(FRAMES).map(v=>[v,v]),v=>{const [width,height]=dimensions(FRAMES[v],Number(size.value));update({...camera,width,height});});
  const size=select('size','Size','Pixels on the longest edge',[['1,920','1920'],['3,840','3840']],v=>{const [width,height]=dimensions(FRAMES[frame.value],Number(v));update({...camera,width,height});});
  const switcher=button('view','Outside','Switch between the lens and an independent observer (V)',()=>setView(view==='lens'?'outside':'lens'));
  const coverageButton=button('coverage','Coverage','Toggle yellow projection and framing guides (C)',()=>{coverage=!coverage;coverageButton.setAttribute('aria-pressed',String(coverage));drawGuides();});
  coverageButton.setAttribute('aria-pressed','true');
  button('reset','Reset','Restore the reference composition (R)',()=>{if(reference)update(structuredClone(reference));});
  const download=button('download','Download','Download one local Windows/Linux capture',async()=>{
    if(!camera||!photo?.availability?.replay) return;
    const response=await fetcher(`${api}/${encodeURIComponent(photo.id)}/export`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({camera})});
    if(!response.ok){const e=await response.json().catch(()=>({}));throw Error(e.error||e.message||`Download unavailable (${response.status})`);}
    const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');
    a.href=url;a.download=`capture-${photo.id}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  async function read(url) {const r=await fetcher(url);if(!r.ok)throw Error(`Photography data is unavailable (${r.status})`);return r.json();}
  function sync() {
    for(const element of bar.querySelectorAll('button,select')) element.disabled=!camera&&!['gallery'].includes(element.dataset.control);
    for(const element of q('.capture-position').querySelectorAll('input,button'))element.disabled=!camera;
    q('.capture-preview').hidden=view!=='outside'||!preview;
    download.disabled=!camera||!photo?.availability?.replay||!catalog?.downloadsEnabled||!healthy;
    download.title=!catalog?.downloadsEnabled?'Downloads await Windows and Linux capture verification':photo?.availability?.reason||'Download one local capture';
    if(!camera)return;
    lens.querySelector('option[data-recorded]')?.remove();
    if(!Object.values(LENSES).includes(camera.verticalFov)){const o=new Option(`Recorded ${camera.verticalFov}°`,String(camera.verticalFov));o.dataset.recorded='true';lens.add(o);}
    lens.value=String(camera.verticalFov);
    frame.value=Object.keys(FRAMES).find(k=>Math.abs(FRAMES[k][0]/FRAMES[k][1]-camera.width/camera.height)<1e-6);
    size.value=String(Math.max(camera.width,camera.height));
    for(const input of root.querySelectorAll('[data-coordinate]'))input.value=String(camera.lens[Number(input.dataset.coordinate)]);
    const box=q('.capture-frame'),stage=q('.capture-stage');
    if(view==='lens'){
      const ratio=camera.width/camera.height,w=Math.min(stage.clientWidth,stage.clientHeight*ratio);
      box.style.width=`${w}px`;box.style.height=`${w/ratio}px`;
    }else{box.style.width='100%';box.style.height='100%';}
    q('.capture-preview').style.aspectRatio=String(camera.width/camera.height);
    if(main){main.setInteractive(view==='outside');main.setCamera(view==='lens'?sceneCamera(camera,origin):null);}
    if(preview)preview.setCamera(sceneCamera(camera,origin));
    drawGuides();
  }
  function update(value) {camera=validateCamera(value);sync();
    if(main)status(photo.availability.replay?`${photo.label||photo.id} · ${camera.width} × ${camera.height} · ${camera.verticalFov}° vertical`:photo.availability.reason);
    root.dispatchEvent(new CustomEvent('capturechange',{detail:structuredClone(camera)}));}
  function setView(value) {
    view=value;switcher.querySelector('span:last-child').textContent=view==='lens'?'Outside':'Lens';switcher.setAttribute('aria-pressed',String(view==='outside'));
    q('.capture-preview').hidden=view!=='outside'||!preview;sync();
  }
  function drawGuides() {
    const svg=q('.capture-guides');svg.replaceChildren();
    if(!camera||!main)return;
    const canvas=q('.capture-main'),w=canvas.clientWidth,h=canvas.clientHeight;svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
    const line=(a,b)=>{if(!a||!b)return;const el=document.createElementNS(svgNS,'line');for(const [k,v] of Object.entries({x1:a[0],y1:a[1],x2:b[0],y2:b[1]}))el.setAttribute(k,v);svg.append(el);};
    if(view==='lens') {if(coverage){for(const f of [1/3,2/3]){line([w*f,0],[w*f,h]);line([0,h*f],[w,h*f]);}}return;}
    const matrix=main.view().matrix;if(!matrix)return;
    const p=world=>project(matrix,toLocal(world,origin),w,h),lensPoint=p(camera.lens),aimPoint=p(target(camera));
    if(coverage){const points=corners(camera).map(p);points.forEach((v,i)=>{line(lensPoint,v);line(v,points[(i+1)%4]);});}
    // A 1.7 m person marker anchors the distinction between standing point and lens.
    const feet=[camera.lens[0],camera.lens[1]-1.7,camera.lens[2]];
    line(p(feet),lensPoint);line(p(add(feet,[-.3,0,0])),p(add(feet,[.3,0,0])));
    for(const [kind,point,label] of [['position',lensPoint,'Camera'],['aim',aimPoint,'Aim']]) {
      if(!point)continue;const handle=document.createElementNS(svgNS,'circle');handle.setAttribute('cx',point[0]);handle.setAttribute('cy',point[1]);handle.setAttribute('r','8');handle.dataset.handle=kind;handle.setAttribute('aria-label',label+' handle');svg.append(handle);
      const text=document.createElementNS(svgNS,'text');text.setAttribute('x',point[0]+12);text.setAttribute('y',point[1]-10);text.textContent=kind==='position'?'▣ Camera':'◎ Aim';svg.append(text);
    }
  }
  const observer=new ResizeObserver(sync);observer.observe(q('.capture-stage'));
  function selected(selection) {
    if(selection.error){healthy=false;status('The scene renderer failed: '+selection.error);download.disabled=true;return;}
    if(!pickMode||!selection.position||!camera)return;
    const point=toWorld(selection.position,origin);
    update(pickMode==='aim'?aimAt(camera,point):{...camera,lens:add(point,[0,1.7,0])});pickMode=null;status('Composition updated.');
  }
  listen(q('[data-place]'),'click',()=>{pickMode='position';setView('outside');status('Click a standing point on scene geometry.');});
  listen(q('[data-aim]'),'click',()=>{pickMode='aim';setView('outside');status('Click a target on scene geometry.');});
  for(const input of root.querySelectorAll('[data-coordinate]'))listen(input,'change',()=>{try{const next=[...camera.lens];next[Number(input.dataset.coordinate)]=input.valueAsNumber;update({...camera,lens:next});}catch(e){status(e.message);sync();}});
  const canvas=q('.capture-main');let drag=null,handleDrag=null;
  listen(canvas,'pointerdown',e=>{canvas.focus();if(view==='lens'&&camera){drag=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId);}});
  listen(canvas,'pointermove',e=>{if(!drag||view!=='lens'||!camera)return;const dx=e.clientX-drag[0],dy=e.clientY-drag[1];drag=[e.clientX,e.clientY];update({...camera,yaw:((camera.yaw+dx*.2+540)%360)-180,pitch:Math.max(-89.9,Math.min(89.9,camera.pitch+dy*.2))});});
  listen(canvas,'pointerup',()=>drag=null);listen(canvas,'pointercancel',()=>drag=null);
  listen(canvas,'keydown',e=>{
    if(!camera)return;const k=e.key.toLowerCase();
    if(k==='v'){e.preventDefault();setView(view==='lens'?'outside':'lens');return;}
    if(k==='r'){e.preventDefault();update(structuredClone(reference));return;}
    if(k==='c'){e.preventDefault();coverageButton.click();return;}
    if(view!=='lens'||!['w','a','s','d','q','e'].includes(k))return;
    e.preventDefault();update(moveCamera(camera,Number(k==='w')-Number(k==='s'),Number(k==='d')-Number(k==='a'),Number(k==='e')-Number(k==='q'),e.shiftKey?2:.3));
  });
  const guides=q('.capture-guides');
  listen(guides,'pointerdown',e=>{const kind=e.target.dataset.handle;if(!kind)return;e.stopPropagation();const v=main.view().camera;handleDrag={kind,point:kind==='aim'?target(camera):[...camera.lens],view:structuredClone(v)};guides.setPointerCapture(e.pointerId);});
  listen(guides,'pointermove',e=>{
    if(!handleDrag)return;const b=canvas.getBoundingClientRect(),v=handleDrag.view;
    const f=normalize(sub(v.target,v.eye)),r=normalize(cross(f,v.up)),u=cross(r,f),h=Math.tan(v.verticalFov*Math.PI/360);
    const ray=normalize(add(f,add(scale(r,((e.clientX-b.left)/b.width*2-1)*h*v.aspect),scale(u,(1-(e.clientY-b.top)/b.height*2)*h))));
    const denominator=dot(ray,f);if(Math.abs(denominator)<1e-6)return;
    const d=dot(sub(toLocal(handleDrag.point,origin),v.eye),f)/denominator;
    const point=toWorld(add(v.eye,scale(ray,d)),origin);
    try{update(handleDrag.kind==='aim'?aimAt(camera,point):{...camera,lens:point});}catch(e){status(e.message);}
  });
  listen(guides,'pointerup',()=>handleDrag=null);listen(guides,'pointercancel',()=>handleDrag=null);
  function fillPhotos() {
    const select=q('[data-photo]');select.replaceChildren();
    for(const item of catalog.photos.filter(p=>buildIdentity(p)===q('[data-build]').value))select.add(new Option(item.label||item.id,item.id));
  }
  async function loadPhoto(id) {
    const sequence=++loadSequence;camera=null;reference=null;healthy=false;pickMode=null;main?.dispose();preview?.dispose();main=preview=null;sync();
    const loaded=await read(`${api}/${encodeURIComponent(id)}`);if(disposed||sequence!==loadSequence)return;photo=loaded;
    q('.capture-reference').src=photo.images.thumbnail;q('.capture-reference').hidden=false;
    q('[data-build]').value=buildIdentity(photo);fillPhotos();q('[data-photo]').value=photo.id;
    if(!photo.availability.compose){status(photo.availability.reason);return;}
    reference=validateCamera(photo.camera);camera=structuredClone(reference);sync();status('Loading the matching archived scene…');
    try{
      const response=await fetcher(`${api}/${encodeURIComponent(photo.id)}/scene`);if(!response.ok)throw Error(`Archived scene unavailable (${response.status})`);
      const bytes=await response.arrayBuffer();if(disposed||sequence!==loadSequence)return;
      const mounted=await mountCreatorScene(canvas,bytes,selected,{capture:true,onView:drawGuides});
      if(disposed||sequence!==loadSequence){mounted.dispose();return;}main=mounted;origin=main.scene.manifest.absoluteOrigin;
      const small=await mountCreatorScene(q('.capture-preview canvas'),bytes,selection=>{if(selection.error)selected(selection);}, {capture:true});
      if(disposed||sequence!==loadSequence){small.dispose();return;}preview=small;healthy=true;preview.setInteractive(false);setView(view);
      status(photo.availability.replay?`${photo.label||photo.id} · ${camera.width} × ${camera.height}`:photo.availability.reason);
    }catch(e){if(disposed||sequence!==loadSequence)return;healthy=false;status(`Composition preview unavailable: ${e.message}. The reference remains browsable.`);download.disabled=true;}
  }
  listen(q('[data-build]'),'change',()=>{fillPhotos();loadPhoto(q('[data-photo]').value).catch(e=>status(e.message));});
  listen(q('[data-photo]'),'change',()=>loadPhoto(q('[data-photo]').value).catch(e=>status(e.message)));
  sync();
  try{
    catalog=await read(api);if(catalog.schema!=='steward-capture-catalog/v1')throw Error('Unsupported capture catalog');
    const builds=new Map(catalog.photos.map(p=>[buildIdentity(p),p.buildLabel||p.source.buildKey.slice(0,12)]));
    for(const [key,label] of builds)q('[data-build]').add(new Option(label,key));
    if(catalog.photos.length)await loadPhoto(photoId||catalog.photos[0].id);else status('No archived photographs are available yet.');
  }catch(e){status(e.message);}
  return {getCamera:()=>camera?structuredClone(camera):null,setCamera:update,setView,loadPhoto,
    dispose(){disposed=true;loadSequence++;events.abort();observer.disconnect();main?.dispose();preview?.dispose();root.replaceChildren();}};
}
