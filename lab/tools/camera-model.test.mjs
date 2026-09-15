import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {FRAMES,dimensions,toLocal,toWorld,validateCamera,basis,corners,target,aimAt,sceneCamera,moveCamera} from '../src/main/resources/static/camera-model.js';
const specimen=()=>({lens:[123,45,-876],yaw:71,pitch:23,roll:0,verticalFov:65,width:1920,height:1080,targetDistance:40});
const close=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const shared=JSON.parse(fs.readFileSync(new URL('../src/main/resources/static/camera-fixtures.json',import.meta.url)));

test('published shared fixtures agree with coordinates, dimensions and projection',()=>{
  assert.deepEqual(toLocal(shared.camera.lens,shared.origin),shared.localLens);
  for(const p of shared.projections){
    assert.deepEqual(dimensions(p.frame,p.longestEdge),[p.width,p.height]);
    const c={...shared.camera,...p,targetDistance:p.distance},b=basis(c);
    for(const corner of corners(c)){const v=corner.map((n,i)=>n-c.lens[i]);close(Math.abs(dot(v,b.right)),p.halfWidth);close(Math.abs(dot(v,b.up)),p.halfHeight);}
  }
});
test('absolute mirrored scene conversion round trips without eye-height adjustments',()=>{
  const origin=[100,10,-900],world=[123,45,-876];assert.deepEqual(toLocal(world,origin),[-23,35,24]);assert.deepEqual(toWorld(toLocal(world,origin),origin),world);
});
test('all lens/frame/size projection corners exactly match normalized lens preview',()=>{
  for(const fov of [90,65,35])for(const frame of Object.values(FRAMES))for(const size of [1920,3840])for(const roll of [0,12]){
    const [width,height]=dimensions(frame,size),c=validateCamera({...specimen(),verticalFov:fov,width,height,roll});
    const b=basis(c),h=Math.tan(fov*Math.PI/360),expected=[[-1,1],[1,1],[1,-1],[-1,-1]];
    corners(c).forEach((p,i)=>{const d=p.map((v,j)=>v-c.lens[j]),z=dot(d,b.forward);close(dot(d,b.right)/(z*h*width/height),expected[i][0]);close(dot(d,b.up)/(z*h),expected[i][1]);});
  }
});
test('aim uses the lens and preserves recorded lens and frame',()=>{
  const c=specimen(),aimed=aimAt(c,target(c));close(aimed.yaw,c.yaw);close(aimed.pitch,c.pitch);assert.deepEqual(aimed.lens,c.lens);assert.equal(aimed.width,c.width);
});
test('observer and viewport operations do not mutate exported camera',()=>{
  const c=specimen(),before=JSON.stringify(c);for(let i=0;i<50;i++)sceneCamera(c,[100,0,100]);assert.equal(JSON.stringify(c),before);
  const moved=moveCamera(c,1,0,0,2);close(Math.hypot(...moved.lens.map((v,i)=>v-c.lens[i])),2);assert.equal(JSON.stringify(c),before);
});
test('invalid metadata and unsupported sizes fail',()=>{
  for(const change of [{lens:[0,NaN,0]},{verticalFov:Infinity},{width:1280},{pitch:90}])assert.throws(()=>validateCamera({...specimen(),...change}));
});
