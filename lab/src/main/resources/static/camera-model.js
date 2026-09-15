// Shared selfiestick-capture/v1 camera model. Unity world coordinates, vertical FOV.
export const CAMERA_SCHEMA = 'selfiestick-camera/v1';
export const LENSES = { Wide: 90, Normal: 65, Telephoto: 35 };
export const FRAMES = { Landscape: [16, 9], Square: [1, 1], Portrait: [9, 16] };
export const add = (a,b) => a.map((v,i) => v+b[i]);
export const sub = (a,b) => a.map((v,i) => v-b[i]);
export const scale = (a,n) => a.map(v => v*n);
export const dot = (a,b) => a.reduce((n,v,i) => n+v*b[i],0);
export const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const normalize = a => scale(a,1/(Math.hypot(...a)||1));
export const toLocal = (world,origin) => [origin[0]-world[0],world[1]-origin[1],world[2]-origin[2]];
export const toWorld = (local,origin) => [origin[0]-local[0],local[1]+origin[1],local[2]+origin[2]];
export const dimensions = (frame,longest=1920) => frame.map(v => Math.round(longest*v/Math.max(...frame)));
const radians = degrees => degrees*Math.PI/180;
export function validateCamera(input) {
  const c=structuredClone(input);
  if (!Array.isArray(c.lens)||c.lens.length!==3||!c.lens.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e6)) throw Error('Lens position is unavailable');
  for (const [key,low,high] of [['yaw',-360,360],['pitch',-89.9,89.9],['roll',-180,180],['verticalFov',1,179],['targetDistance',.1,10000]]) {
    c[key] ??= key==='roll'?0:key==='targetDistance'?40:undefined;
    if (!Number.isFinite(c[key])||c[key]<low||c[key]>high) throw Error(`Invalid ${key}`);
  }
  if (!Object.values(FRAMES).some(f=>[1920,3840].some(s=>dimensions(f,s).every((v,i)=>v===[c.width,c.height][i])))) throw Error('Unsupported frame size');
  return c;
}
export function basis(c) {
  const y=radians(c.yaw),p=radians(c.pitch),r=radians(c.roll||0);
  const forward=[Math.sin(y)*Math.cos(p),-Math.sin(p),Math.cos(y)*Math.cos(p)];
  const right=[Math.cos(y),0,-Math.sin(y)],up=cross(forward,right);
  return {forward,right:add(scale(right,Math.cos(r)),scale(up,Math.sin(r))),up:add(scale(up,Math.cos(r)),scale(right,-Math.sin(r)))};
}
export function target(c) { return add(c.lens,scale(basis(c).forward,c.targetDistance??40)); }
export function aimAt(c,point) {
  const d=sub(point,c.lens),distance=Math.hypot(...d);
  if (distance<.1) throw Error('Aim must be at least 10 cm from the lens');
  return validateCamera({...c,yaw:Math.atan2(d[0],d[2])*180/Math.PI,
    pitch:Math.max(-89.9,Math.min(89.9,-Math.asin(d[1]/distance)*180/Math.PI)),targetDistance:distance});
}
export function corners(c) {
  const {right,up}=basis(c),center=target(c),h=(c.targetDistance??40)*Math.tan(radians(c.verticalFov)/2),w=h*c.width/c.height;
  return [[-1,1],[1,1],[1,-1],[-1,-1]].map(([x,y])=>add(center,add(scale(right,w*x),scale(up,h*y))));
}
export function sceneCamera(c,origin) {
  const up=basis(c).up;
  return {eye:toLocal(c.lens,origin),target:toLocal(target(c),origin),up:[-up[0],up[1],up[2]],verticalFov:c.verticalFov,aspect:c.width/c.height};
}
export function moveCamera(c,forward,right,up,meters) {
  const b=basis(c),delta=add(add(scale(b.forward,forward*meters),scale(b.right,right*meters)),[0,up*meters,0]);
  return validateCamera({...c,lens:add(c.lens,delta)});
}
export function project(matrix,point,width,height) {
  const p=[...point,1],out=[0,0,0,0];
  for(let row=0;row<4;row++) for(let col=0;col<4;col++) out[row]+=matrix[col*4+row]*p[col];
  return out[3]<=0?null:[(out[0]/out[3]+1)*width/2,(1-out[1]/out[3])*height/2];
}
