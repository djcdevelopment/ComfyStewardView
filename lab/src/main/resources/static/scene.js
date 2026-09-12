const PAGE_STARTED = performance.now();
const APP_BASE = new URL('.', location.href);
const params = new URLSearchParams(location.search);
const returnMap = new URL(APP_BASE);
for (const key of ['era','build']) if (params.has(key)) returnMap.searchParams.set(key,params.get(key));
for (const link of document.querySelectorAll('[data-return-map]')) link.href = returnMap.href;
const statusNode = document.getElementById('scene-status');
const blockedNode = document.getElementById('scene-blocked');
const errors = [];
let deviceLost = false;
let receipt = {
  schema:'steward-scene-browser/v3', status:'loading', pieces:0,
  validationErrors:errors, deviceLost:false
};

function publish(patch = {}) {
  receipt = { ...receipt, ...patch, validationErrors:[...errors], deviceLost };
  window.__stewardSceneReceipt = receipt;
}
publish();

function fail(error) {
  const message = error?.message || String(error);
  console.error(error);
  statusNode.textContent = `BLOCKED · ${message}`;
  document.getElementById('blocked-title').textContent = message.includes('WebGPU')
    ? 'This browser could not start WebGPU' : 'This exact scene could not open';
  document.getElementById('blocked-copy').textContent = message;
  blockedNode.hidden = false;
  document.documentElement.dataset.sceneReady = 'error';
  publish({ status:'error', error:message });
}

const fmt = value => Number(value || 0).toLocaleString();
const fmtBytes = value => value < 1024 * 1024
  ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(2)} MiB`;
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const MOVEMENT_KEYS = new Set(['w','a','s','d','q','e','shift']);
const percentile = (values, p) => {
  const sorted = [...values].sort((a,b) => a-b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
};

function requiredNumber(name) {
  const raw = params.get(name);
  if (raw == null || raw.trim() === '') throw new Error(`The shared scene URL is missing ${name}.`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`The shared scene URL is missing ${name}.`);
  return value;
}

function queryVector(name) {
  const values = (params.get(name) || '').split(',').map(Number);
  return values.length === 3 && values.every(Number.isFinite) ? values : null;
}

function sceneRequestUrl() {
  const snapshot = requiredNumber('snapshot');
  const minX = requiredNumber('minX'), maxX = requiredNumber('maxX');
  const minZ = requiredNumber('minZ'), maxZ = requiredNumber('maxZ');
  if (snapshot <= 0 || minX >= maxX || minZ >= maxZ) throw new Error('The shared scene bounds are invalid.');
  const query = new URLSearchParams({
    snapshot:String(snapshot), lens:params.get('lens') || 'build-density',
    minX:String(minX), maxX:String(maxX), minZ:String(minZ), maxZ:String(maxZ), format:'3'
  });
  if (params.get('biomes')) query.set('biomes', params.get('biomes'));
  for (const key of ['era','build']) if (params.get(key)) query.set(key, params.get(key));
  if (params.get('override') === 'true' || params.get('override') === '1') query.set('override', 'true');
  // An exact camera (a photograph's receipt) needs the selection origin to be placed. These
  // are end-of-era worlds the community released, so the server hands it over on request.
  if ((queryVector('cameraLens') && queryVector('cameraAim')) || (params.get('era') && params.get('build'))) query.set('camera', 'true');
  if (params.get('rnd') === '1') {
    query.set('rnd', 'true');
    query.set('presentation', params.get('presentation') === 'baseline' ? 'baseline' : 'candidate');
  }
  const url = new URL('api/scene', APP_BASE);
  url.search = query.toString();
  return url;
}

// A gallery link knows the era and the build, not the snapshot or the bounds: resolve them
// here so scene.html?era=&build=&cameraLens=&cameraAim= opens without lab.js in the middle.
async function resolveSharedBounds() {
  if (params.has('snapshot') && params.has('minX') && params.has('maxX') && params.has('minZ') && params.has('maxZ')) return;
  const era = params.get('era'), build = params.get('build');
  if (!era || !build) return;
  const eras = await (await fetch(new URL('api/eras', APP_BASE), { headers:{ Accept:'application/json' } })).json();
  const entry = (eras.eras || []).find(candidate => candidate.slug === era);
  if (!entry) throw new Error(`The era "${era}" is not published here.`);
  const bounds = new URL('api/build', APP_BASE);
  bounds.search = new URLSearchParams({ era, build, snapshot:String(entry.snapshotId) }).toString();
  const box = await (await fetch(bounds, { headers:{ Accept:'application/json' } })).json();
  if (!Number.isFinite(box.minX) || !(box.pieces > 0)) throw new Error('The build has no published pieces.');
  const pad = 8;
  params.set('snapshot', String(entry.snapshotId));
  params.set('minX', String(box.minX - pad)); params.set('maxX', String(box.maxX + pad));
  params.set('minZ', String(box.minZ - pad)); params.set('maxZ', String(box.maxZ + pad));
  if (!params.get('lens')) params.set('lens', 'build-density');
}

async function fetchScene() {
  const response = await fetch(sceneRequestUrl(), { headers:{ Accept:'application/vnd.comfysteward.scene' } });
  const buffer = await response.arrayBuffer();
  if (!response.ok) {
    let message = `Scene request failed (${response.status})`;
    try { message = JSON.parse(new TextDecoder().decode(buffer)).error || message; } catch (_) {}
    throw new Error(message);
  }
  if (buffer.byteLength < 16) throw new Error('The scene package is incomplete.');
  const header = new DataView(buffer, 0, 16);
  const magic = new TextDecoder('ascii').decode(new Uint8Array(buffer, 0, 4));
  const version = header.getUint32(4, true);
  const manifestLength = header.getUint32(8, true);
  const instanceOffset = header.getUint32(12, true);
  if (magic !== 'SV3D' || (version !== 2 && version !== 3)) throw new Error('The scene package format is not supported.');
  if (instanceOffset % 4 || instanceOffset < 16 + manifestLength || instanceOffset > buffer.byteLength) {
    throw new Error('The scene package offsets are invalid.');
  }
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 16, manifestLength)));
  } catch (_) {
    throw new Error('The scene manifest could not be decoded.');
  }
  if (manifest.schema !== `steward-zdo-scene/v${version}` || manifest.instanceStride !== 80 ||
      manifest.instanceBytes !== manifest.renderInstances * manifest.instanceStride) {
    throw new Error('The scene manifest does not match its exact instance payload.');
  }
  const sections = version === 3 ? manifest.sections : null;
  const instanceSection = sections?.instances || { offset:0, bytes:manifest.instanceBytes };
  if (instanceSection.offset !== 0 || instanceSection.bytes !== manifest.instanceBytes) {
    throw new Error('The instance section is invalid.');
  }
  const payloadBytes = buffer.byteLength - instanceOffset;
  if (version === 2 && payloadBytes !== manifest.instanceBytes) {
    throw new Error('The v2 package contains an unexpected trailing section.');
  }
  let expectedStart = 0;
  let representedPieces = 0;
  for (const group of manifest.drawGroups || []) {
    if (group.start !== expectedStart || group.count < 1 || group.pieces < 1 ||
        typeof group.defaultVisible !== 'boolean') throw new Error('The scene draw ranges are invalid.');
    expectedStart += group.count;
    representedPieces += group.pieces;
  }
  if (expectedStart !== manifest.renderInstances || (version === 2 && representedPieces !== manifest.pieces)) {
    throw new Error('The draw ranges do not preserve exact piece membership.');
  }
  const bytes = new Uint8Array(buffer, instanceOffset, manifest.instanceBytes);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
  if (digest !== manifest.instanceSha256) throw new Error('The exact scene payload failed its checksum.');
  let terrainData = null;
  if (version === 3) {
    const ordinal = sections?.pieceOrdinals, terrain = sections?.terrainVertices;
    if (!ordinal || ordinal.offset !== manifest.instanceBytes ||
        ordinal.bytes !== manifest.pieceOrdinalBytes || ordinal.bytes !== manifest.renderInstances * 4 ||
        !terrain || terrain.offset !== ordinal.offset + ordinal.bytes ||
        terrain.bytes !== manifest.terrain.vertexBytes || terrain.offset + terrain.bytes !== payloadBytes) {
      throw new Error('The v3 section directory is invalid.');
    }
    const ordinalBytes = new Uint8Array(buffer, instanceOffset + ordinal.offset, ordinal.bytes);
    const ordinalDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', ordinalBytes))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    if (ordinalDigest !== manifest.pieceOrdinalSha256) throw new Error('The piece membership channel failed its checksum.');
    const ordinals = new Uint32Array(ordinalBytes.buffer, ordinalBytes.byteOffset, ordinalBytes.byteLength / 4);
    const represented = new Uint8Array(manifest.pieces);
    for (const ordinalValue of ordinals) {
      if (ordinalValue >= manifest.pieces) throw new Error('A render instance has an invalid local piece ordinal.');
      represented[ordinalValue] = 1;
    }
    if (represented.some(value => value !== 1)) throw new Error('The scene does not represent every selected piece.');
    const rawTerrain = new Uint8Array(buffer, instanceOffset + terrain.offset, terrain.bytes);
    if (rawTerrain.byteLength) {
      const terrainDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', rawTerrain))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      if (terrainDigest !== manifest.terrain.payloadSha256) throw new Error('The terrain crop failed its checksum.');
      terrainData = new Float32Array(rawTerrain.buffer, rawTerrain.byteOffset, rawTerrain.byteLength / 4);
    }
  }
  return { manifest, bytes, terrainData, version };
}

function multiply4(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
    out[column * 4 + row] = sum;
  }
  return out;
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), out = new Float32Array(16);
  out[0] = f / aspect; out[5] = f;
  out[10] = far / (near - far); out[11] = -1;
  out[14] = far * near / (near - far);
  return out;
}

function orthographic(left,right,bottom,top,near,far) {
  const out=new Float32Array(16);
  out[0]=2/(right-left);out[5]=2/(top-bottom);out[10]=1/(near-far);out[15]=1;
  out[12]=(left+right)/(left-right);out[13]=(top+bottom)/(bottom-top);out[14]=near/(near-far);
  return out;
}

const add = (a,b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const sub = (a,b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const scale = (a,n) => [a[0]*n, a[1]*n, a[2]*n];
const dot = (a,b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const norm = a => { const length = Math.hypot(...a) || 1; return scale(a, 1 / length); };

function lookAt(eye, target, up) {
  const z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
  return new Float32Array([
    x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
    -dot(x,eye),-dot(y,eye),-dot(z,eye),1
  ]);
}

function adapterRecord(info) {
  const out = {};
  for (const key of ['vendor','architecture','device','description','type','backend','d3dShaderModel']) {
    try { if (info?.[key] !== undefined && info[key] !== '') out[key] = info[key]; } catch (_) {}
  }
  return out;
}

function classifyAdapter(info) {
  const text = Object.values(info).join(' ').toLowerCase();
  if (/swiftshader|software|llvmpipe|warp|fallback|cpu/.test(text)) return 'software';
  if (/discrete gpu|integrated gpu|intel|nvidia|amd|radeon|arc|geforce|apple/.test(text)) return 'hardware';
  return 'unknown';
}

function gpuBuffer(device, data, usage, label) {
  const buffer = device.createBuffer({ label, size:(data.byteLength + 3) & ~3, usage, mappedAtCreation:true });
  new data.constructor(buffer.getMappedRange()).set(data);
  buffer.unmap();
  return buffer;
}

function niceGridStep(span) {
  const target = Math.max(span / 20, .25);
  const base = 10 ** Math.floor(Math.log10(target));
  for (const multiple of [1,2,5,10]) if (base * multiple >= target) return base * multiple;
  return base * 10;
}

function gridVertices(manifest, home) {
  const [width,,depth] = manifest.dimensionsM;
  const span = Math.max(width, depth);
  const focusSpan = Math.min(span, Math.max(1, Number(home?.radiusM) || 1) * 2);
  const step = niceGridStep(Math.max(focusSpan, span / 12));
  const halfX = Math.ceil(Math.max(width / 2, step) / step) * step;
  const halfZ = Math.ceil(Math.max(depth / 2, step) / step) * step;
  const y = Number(home?.floorY ?? manifest.floorY) - .006;
  const values = [];
  const line = (a,b,color) => values.push(...a,...color,...b,...color);
  const minor = [.24,.31,.36,.42], major = [.39,.49,.55,.66];
  for (let x = -halfX, i = 0; x <= halfX + step * .1; x += step, i++) {
    line([x,y,-halfZ],[x,y,halfZ], i % 5 === 0 ? major : minor);
  }
  for (let z = -halfZ, i = 0; z <= halfZ + step * .1; z += step, i++) {
    line([-halfX,y,z],[halfX,y,z], i % 5 === 0 ? major : minor);
  }
  line([-halfX,y,0],[halfX,y,0],[.55,.25,.24,.9]);
  line([0,y,-halfZ],[0,y,halfZ],[.25,.47,.66,.9]);
  return { values:new Float32Array(values), step };
}

function titleCase(value) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function proceduralMesh(kind) {
  const vertices = [], triangles = [], lines = [];
  const vertex = (point, normal) => { vertices.push(...point,...normal); return vertices.length / 6 - 1; };
  const quad = (a,b,c,d) => {
    const normal = norm(cross(sub(b,a),sub(c,a))), start = vertices.length / 6;
    [a,b,c,d].forEach(point => vertex(point,normal));
    triangles.push(start,start+1,start+2,start,start+2,start+3);
    lines.push(start,start+1,start+1,start+2,start+2,start+3,start+3,start);
  };
  const tri = (a,b,c) => {
    const normal = norm(cross(sub(b,a),sub(c,a))), start = vertices.length / 6;
    [a,b,c].forEach(point => vertex(point,normal));
    triangles.push(start,start+1,start+2); lines.push(start,start+1,start+1,start+2,start+2,start);
  };
  const box = (low=[-.5,-.5,-.5],high=[.5,.5,.5]) => {
    const [x0,y0,z0]=low,[x1,y1,z1]=high;
    quad([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]);
    quad([x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0]);
    quad([x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1]);
    quad([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0]);
    quad([x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0]);
    quad([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]);
  };
  // Valheim's straight roof snap points put the high edge at local -Z and the low edge at
  // local +Z. The instance extents already encode 26 vs 45 degree rise, so both pitches use
  // this same normalized thin slab; using a solid wedge invents the sawtooth walls it replaced.
  const slopedPanel = () => {
    const highTop=.5,highBottom=.4,lowTop=-.4,lowBottom=-.5;
    const a=[-.5,highTop,-.5],b=[.5,highTop,-.5],c=[.5,lowTop,.5],d=[-.5,lowTop,.5];
    const e=[-.5,highBottom,-.5],f=[.5,highBottom,-.5],g=[.5,lowBottom,.5],h=[-.5,lowBottom,.5];
    quad(a,b,c,d); quad(h,g,f,e); quad(e,f,b,a); quad(d,c,g,h); quad(b,f,g,c); quad(e,a,d,h);
  };
  // A placed stair climbs toward prefab-local -Z. The old proxy climbed across +X, making
  // connected flights turn sideways even though their saved Euler transforms were correct.
  const solidStair = () => {
    for(let i=0;i<5;i++){
      const z1=.5-i*.2,z0=z1-.2;
      box([-.5,-.5,z0],[.5,-.3+i*.2,z1]);
    }
  };
  const openStair = () => {
    for(let i=0;i<5;i++){
      const z1=.5-i*.2,z0=z1-.2,y=-.3+i*.2;
      box([-.5,y-.08,z0],[.5,y,z1]);
    }
    const stringer = (x0,x1) => {
      const lowY=-.43,highY=.37,half=.055,zLow=.5,zHigh=-.5;
      const a=[x0,lowY-half,zLow],b=[x1,lowY-half,zLow],c=[x1,lowY+half,zLow],d=[x0,lowY+half,zLow];
      const e=[x0,highY-half,zHigh],f=[x1,highY-half,zHigh],g=[x1,highY+half,zHigh],h=[x0,highY+half,zHigh];
      quad(a,b,c,d);quad(f,e,h,g);quad(e,a,d,h);quad(b,f,g,c);quad(d,c,g,h);quad(e,f,b,a);
    };
    stringer(-.43,-.33);stringer(.33,.43);
  };
  const triangularPrism = () => {
    const p0=[-.5,-.5],p1=[.5,-.5],p2=[.5,.5];
    tri([p0[0],p0[1],.5],[p1[0],p1[1],.5],[p2[0],p2[1],.5]);
    tri([p2[0],p2[1],-.5],[p1[0],p1[1],-.5],[p0[0],p0[1],-.5]);
    quad([p0[0],p0[1],-.5],[p1[0],p1[1],-.5],[p1[0],p1[1],.5],[p0[0],p0[1],.5]);
    quad([p1[0],p1[1],-.5],[p2[0],p2[1],-.5],[p2[0],p2[1],.5],[p1[0],p1[1],.5]);
    quad([p2[0],p2[1],-.5],[p0[0],p0[1],-.5],[p0[0],p0[1],.5],[p2[0],p2[1],.5]);
  };
  const cylinder = () => {
    const sides=12;
    for(let i=0;i<sides;i++){
      const a=i*Math.PI*2/sides,b=(i+1)*Math.PI*2/sides;
      const p0=[Math.cos(a)*.5,-.5,Math.sin(a)*.5],p1=[Math.cos(b)*.5,-.5,Math.sin(b)*.5];
      const p2=[p1[0],.5,p1[2]],p3=[p0[0],.5,p0[2]];
      quad(p1,p0,p3,p2); tri([0,.5,0],p2,p3); tri([0,-.5,0],p0,p1);
    }
  };
  const frustum = (y0,y1,x0,z0,x1,z1,c0=[0,0],c1=[0,0]) => {
    const sides=8, phase=Math.PI/8, lower=[], upper=[];
    for(let i=0;i<sides;i++){
      const angle=phase+i*Math.PI*2/sides;
      lower.push([c0[0]+Math.cos(angle)*x0,y0,c0[1]+Math.sin(angle)*z0]);
      upper.push([c1[0]+Math.cos(angle)*x1,y1,c1[1]+Math.sin(angle)*z1]);
    }
    for(let i=0;i<sides;i++){
      const next=(i+1)%sides;
      quad(lower[next],lower[i],upper[i],upper[next]);
      tri([c1[0],y1,c1[1]],upper[next],upper[i]);
      tri([c0[0],y0,c0[1]],lower[i],lower[next]);
    }
  };
  // A Wisp Fountain is a tall carved stone spire, not a lamp post. Three offset octagonal
  // tiers preserve the measured envelope while giving its broad foot, tapered body and lean.
  const wispFountain = () => {
    frustum(-.5,-.18,.50,.50,.38,.37,[-.02,0],[0,0]);
    frustum(-.18,.20,.38,.37,.25,.27,[0,0],[.04,-.02]);
    frustum(.20,.50,.25,.27,.15,.17,[.04,-.02],[.13,.05]);
  };
  const standingBrazier = () => {
    frustum(-.5,-.30,.12,.12,.12,.12);
    frustum(-.30,.30,.14,.14,.48,.48);
    frustum(.30,.50,.50,.50,.44,.44);
  };
  const wispGlow = () => {
    // One deterministic representative of the runtime wisps: a narrow curling tail ending
    // in a faceted blue mote just above the stone tip. Saved orbit phase is unavailable.
    frustum(.42,.53,.025,.025,.065,.055,[.13,.03],[.20,.05]);
    const center=[.23,.57,.06],rx=.10,ry=.08,rz=.085,sides=8,equator=[];
    for(let i=0;i<sides;i++){
      const angle=Math.PI/8+i*Math.PI*2/sides;
      equator.push([center[0]+Math.cos(angle)*rx,center[1],center[2]+Math.sin(angle)*rz]);
    }
    const top=[center[0],center[1]+ry,center[2]],bottom=[center[0],center[1]-ry,center[2]];
    for(let i=0;i<sides;i++){
      const next=(i+1)%sides;
      tri(top,equator[next],equator[i]);
      tri(bottom,equator[i],equator[next]);
    }
  };
  const ring = (arch=false) => {
    const sides=arch?12:16, start=arch?0:-Math.PI, span=arch?Math.PI:Math.PI*2;
    for(let i=0;i<sides;i++){
      const a=start+i*span/sides,b=start+(i+1)*span/sides;
      const point=(angle,r,z)=>[Math.cos(angle)*r,Math.sin(angle)*r,z];
      const ao=point(a,.5,.12),bo=point(b,.5,.12),ai=point(a,.31,.12),bi=point(b,.31,.12);
      const aob=point(a,.5,-.12),bob=point(b,.5,-.12),aib=point(a,.31,-.12),bib=point(b,.31,-.12);
      quad(ao,bo,bi,ai); quad(bob,aob,aib,bib); quad(aob,bob,bo,ao); quad(bib,aib,ai,bi);
    }
  };
  if (kind === 'sloped-panel-26' || kind === 'sloped-panel-45') slopedPanel();
  else if (kind === 'triangular-prism') triangularPrism();
  else if (kind === 'cylinder-12') cylinder();
  else if (kind === 'wisp-fountain') wispFountain();
  else if (kind === 'standing-brazier') standingBrazier();
  else if (kind === 'wisp-glow') wispGlow();
  else if (kind === 'ring-12') ring(false);
  else if (kind === 'arch-12') ring(true);
  else if (kind === 'open-stepped-stair') openStair();
  else if (kind === 'solid-stepped-stair' || kind === 'stepped-stair') solidStair();
  else if (kind === 'plane-double-sided') { quad([-.5,0,-.5],[.5,0,-.5],[.5,0,.5],[-.5,0,.5]); quad([-.5,0,.5],[.5,0,.5],[.5,0,-.5],[-.5,0,-.5]); }
  else box();
  return { vertices:new Float32Array(vertices), triangles:new Uint16Array(triangles), lines:new Uint16Array(lines) };
}

async function main() {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use a current hardware-accelerated browser.');
  await resolveSharedBounds();
  const { manifest, bytes:instanceData, terrainData, version:sceneVersion } = await fetchScene();
  const radius = Math.max(Number(manifest.radiusM) || 1, 1);
  const homeTarget = Array.isArray(manifest.home?.target) && manifest.home.target.length === 3 &&
      manifest.home.target.every(Number.isFinite) ? [...manifest.home.target] : [0,0,0];
  const homeRadius = Math.max(Number(manifest.home?.radiusM) || radius, 1);
  const clusteredHome = manifest.home?.strategy === 'densest-cluster';
  if (!clusteredHome) {
    document.getElementById('frame-home').hidden = true;
    document.getElementById('frame-scene').textContent = 'Reset';
  }
  publish({ pieces:manifest.pieces, instanceBytes:manifest.instanceBytes, instanceSha256:manifest.instanceSha256 });
  statusNode.textContent = 'REQUESTING HARDWARE ADAPTER…';
  const adapter = await navigator.gpu.requestAdapter({ powerPreference:'high-performance' });
  if (!adapter) throw new Error('WebGPU could not provide an adapter. Check browser hardware acceleration.');
  const adapterInfo = adapterRecord(adapter.info);
  const adapterClass = classifyAdapter(adapterInfo);
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', event => {
    errors.push(String(event.error?.message || event.error));
    publish();
  });
  device.lost.then(info => {
    deviceLost = true;
    errors.push(`device lost: ${info.reason} ${info.message}`);
    publish({ status:'device-lost' });
  });

  const canvas = document.getElementById('gpu'), stage = document.getElementById('stage');
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('The browser has WebGPU but could not create a canvas context.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  const sampleCount = manifest.lod?.msaaSamples === 4 ? 4 : 1;
  let depthTexture, multisampleTexture;
  function resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(stage.clientWidth * ratio));
    const height = Math.max(1, Math.floor(stage.clientHeight * ratio));
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width; canvas.height = height;
    context.configure({ device, format, alphaMode:'opaque' });
    depthTexture?.destroy(); multisampleTexture?.destroy();
    depthTexture = device.createTexture({ size:[width,height], sampleCount, format:'depth24plus', usage:GPUTextureUsage.RENDER_ATTACHMENT });
    multisampleTexture = sampleCount > 1 ? device.createTexture({ size:[width,height], sampleCount,
      format, usage:GPUTextureUsage.RENDER_ATTACHMENT }) : null;
    return true;
  }

  const grid = gridVertices(manifest, manifest.home);
  const gridVB = gpuBuffer(device, grid.values, GPUBufferUsage.VERTEX, 'selection-local grid');
  const instanceBuffer = gpuBuffer(device, instanceData, GPUBufferUsage.VERTEX, 'exact ZDO instances');
  const meshBuffers = new Map();
  for (const kind of new Set((manifest.drawGroups || []).map(group => group.primitiveKind || 'box'))) {
    const mesh = proceduralMesh(kind);
    meshBuffers.set(kind, { ...mesh,
      vertexBuffer:gpuBuffer(device,mesh.vertices,GPUBufferUsage.VERTEX,`${kind} vertices`),
      triangleBuffer:gpuBuffer(device,mesh.triangles,GPUBufferUsage.INDEX,`${kind} triangles`),
      lineBuffer:gpuBuffer(device,mesh.lines,GPUBufferUsage.INDEX,`${kind} CAD edges`) });
  }
  let terrainVB=null, terrainIB=null, terrainIndexCount=0, waterVB=null, waterIB=null;
  if (terrainData && manifest.terrain?.available) {
    const terrainValues = new Float32Array(terrainData.length / 3 * 10);
    const sea = Number(manifest.terrain.seaLevelLocalY);
    for(let source=0,target=0;source<terrainData.length;source+=3,target+=10){
      const x=terrainData[source],y=terrainData[source+1],z=terrainData[source+2];
      const water=y<sea, contour=Math.abs(y/10-Math.round(y/10))<.045;
      const color=water?[.12,.25,.34,1]:contour?[.31,.34,.32,1]:[.43,.45,.41,1];
      terrainValues.set([x,y,z,0,1,0,...color],target);
    }
    const columns=manifest.terrain.columns,rows=manifest.terrain.rows, indices=[];
    const terrainPosition=(row,column) => {
      const offset=(row*columns+column)*10;
      return [terrainValues[offset],terrainValues[offset+1],terrainValues[offset+2]];
    };
    for(let row=0;row<rows;row++) for(let column=0;column<columns;column++){
      const left=Math.max(0,column-1),right=Math.min(columns-1,column+1);
      const above=Math.max(0,row-1),below=Math.min(rows-1,row+1);
      const across=sub(terrainPosition(row,right),terrainPosition(row,left));
      const down=sub(terrainPosition(below,column),terrainPosition(above,column));
      let normal=norm(cross(across,down));
      if(normal[1]<0) normal=scale(normal,-1);
      terrainValues.set(normal,(row*columns+column)*10+3);
    }
    for(let row=0;row<rows-1;row++) for(let column=0;column<columns-1;column++){
      const a=row*columns+column,b=a+1,c=a+columns,d=c+1;
      indices.push(a,c,b,b,c,d);
    }
    const terrainIndices=new Uint32Array(indices); terrainIndexCount=terrainIndices.length;
    terrainVB=gpuBuffer(device,terrainValues,GPUBufferUsage.VERTEX,'cropped terrain vertices');
    terrainIB=gpuBuffer(device,terrainIndices,GPUBufferUsage.INDEX,'cropped terrain indices');
    const halfX=manifest.dimensionsM[0]/2,halfZ=manifest.dimensionsM[2]/2;
    const waterValues=new Float32Array([
      -halfX,sea,-halfZ,.10,.29,.42,.42, halfX,sea,-halfZ,.10,.29,.42,.42,
      halfX,sea,halfZ,.10,.29,.42,.42, -halfX,sea,halfZ,.10,.29,.42,.42]);
    waterVB=gpuBuffer(device,waterValues,GPUBufferUsage.VERTEX,'water plane');
    waterIB=gpuBuffer(device,new Uint16Array([0,1,2,0,2,3]),GPUBufferUsage.INDEX,'water indices');
  }
  const shadowMapSize = Number(manifest.lod?.shadowMapSize) || 0;
  const shadowTexture = device.createTexture({ size:[Math.max(1,shadowMapSize),Math.max(1,shadowMapSize)],
    format:'depth32float', usage:GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  const shadowSampler = device.createSampler({ compare:'less', magFilter:'linear', minFilter:'linear' });
  const cameraBuffer = device.createBuffer({ size:128, usage:GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const lightRadius=Math.max(radius,homeRadius)*1.08;
  const lightViewProjection=multiply4(
    orthographic(-lightRadius,lightRadius,-lightRadius,lightRadius,.1,lightRadius*5),
    lookAt([lightRadius*1.4,lightRadius*2.2,lightRadius], [0,0,0], [0,1,0]));

  const shader = device.createShaderModule({ code:`
    struct Camera { viewProjection:mat4x4<f32>, lightViewProjection:mat4x4<f32> }
    @group(0) @binding(0) var<uniform> camera:Camera;
    @group(0) @binding(1) var shadowTexture:texture_depth_2d;
    @group(0) @binding(2) var shadowSampler:sampler_comparison;
    struct SolidIn {
      @location(0) position:vec3f, @location(1) normal:vec3f,
      @location(2) m0:vec4f, @location(3) m1:vec4f,
      @location(4) m2:vec4f, @location(5) m3:vec4f, @location(6) color:vec4f
    }
    struct SolidOut { @builtin(position) position:vec4f, @location(0) color:vec4f,
      @location(1) lightPosition:vec4f, @location(2) emissive:f32 }
    fn linearToSrgb(value:vec3f)->vec3f { return pow(max(value,vec3f(0)),vec3f(1.0/2.2)); }
    @vertex fn solidVS(input:SolidIn)->SolidOut {
      let world=input.m0*input.position.x+input.m1*input.position.y+input.m2*input.position.z+input.m3;
      let direction=input.m0.xyz*input.normal.x+input.m1.xyz*input.normal.y+input.m2.xyz*input.normal.z;
      let normal=normalize(direction);
      let diffuse=0.28+0.72*max(dot(normal,vec3f(-.4629,.8230,.3292)),0);
      let horizon=0.9+0.1*max(normal.y,0);
      let emissive=select(0.0,1.0,input.color.a>1.5);
      var out:SolidOut; out.position=camera.viewProjection*world;
      let linearColor=pow(input.color.rgb,vec3f(2.2));
      out.color=vec4f(linearToSrgb(linearColor*mix(diffuse*horizon,1.0,emissive)),1);
      out.lightPosition=camera.lightViewProjection*world; out.emissive=emissive; return out;
    }
    @fragment fn solidFS(input:SolidOut)->@location(0) vec4f {
      let projected=input.lightPosition.xyz/input.lightPosition.w;
      let uv=vec2f(projected.x*.5+.5,projected.y*-.5+.5);
      let inMap=all(uv>=vec2f(0))&&all(uv<=vec2f(1))&&projected.z>=0&&projected.z<=1;
      let shadowValue=textureSampleCompare(shadowTexture,shadowSampler,uv,projected.z-.0015);
      let shadedVisibility=${shadowMapSize > 0 ? 'select(1.0,0.58,inMap && shadowValue<.5)' : '1.0'};
      let visibility=mix(shadedVisibility,1.0,input.emissive);
      return vec4f(input.color.rgb*visibility,input.color.a);
    }
    struct ShadowIn { @location(0) position:vec3f,
      @location(2) m0:vec4f, @location(3) m1:vec4f,
      @location(4) m2:vec4f, @location(5) m3:vec4f }
    @vertex fn shadowVS(input:ShadowIn)->@builtin(position) vec4f {
      let world=input.m0*input.position.x+input.m1*input.position.y+input.m2*input.position.z+input.m3;
      return camera.lightViewProjection*world;
    }
    struct LineIn { @location(0) position:vec3f,
      @location(2) m0:vec4f, @location(3) m1:vec4f,
      @location(4) m2:vec4f, @location(5) m3:vec4f, @location(6) color:vec4f }
    struct LineOut { @builtin(position) position:vec4f, @location(0) color:vec4f }
    @vertex fn lineVS(input:LineIn)->LineOut {
      let world=input.m0*input.position.x+input.m1*input.position.y+input.m2*input.position.z+input.m3;
      var out:LineOut; out.position=camera.viewProjection*world;
      out.color=vec4f(min(input.color.rgb*1.25,vec3f(1)),1); return out;
    }
    @fragment fn lineFS(input:LineOut)->@location(0) vec4f { return input.color; }
    struct GridIn { @location(0) position:vec3f, @location(1) color:vec4f }
    struct GridOut { @builtin(position) position:vec4f, @location(0) color:vec4f }
    @vertex fn gridVS(input:GridIn)->GridOut {
      var out:GridOut; out.position=camera.viewProjection*vec4f(input.position,1);
      out.color=input.color; return out;
    }
    @fragment fn gridFS(input:GridOut)->@location(0) vec4f { return input.color; }
    struct TerrainIn { @location(0) position:vec3f, @location(1) normal:vec3f, @location(7) color:vec4f }
    struct TerrainOut { @builtin(position) position:vec4f, @location(0) color:vec4f }
    @vertex fn terrainVS(input:TerrainIn)->TerrainOut {
      let diffuse=0.34+0.66*max(dot(normalize(input.normal),vec3f(-.4629,.8230,.3292)),0);
      let linearColor=pow(input.color.rgb,vec3f(2.2));
      var out:TerrainOut; out.position=camera.viewProjection*vec4f(input.position,1);
      out.color=vec4f(linearToSrgb(linearColor*diffuse),input.color.a); return out;
    }
    @fragment fn terrainFS(input:TerrainOut)->@location(0) vec4f { return vec4f(input.color.rgb,1); }
    @fragment fn terrainGhostFS(input:TerrainOut)->@location(0) vec4f { return vec4f(input.color.rgb,.28); }
  `});
  const instanceLayout = { arrayStride:80, stepMode:'instance', attributes:[
    {shaderLocation:2,offset:0,format:'float32x4'}, {shaderLocation:3,offset:16,format:'float32x4'},
    {shaderLocation:4,offset:32,format:'float32x4'}, {shaderLocation:5,offset:48,format:'float32x4'},
    {shaderLocation:6,offset:64,format:'float32x4'}
  ]};
  const bindLayout = device.createBindGroupLayout({ entries:[
    {binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'uniform'}},
    {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'depth'}},
    {binding:2,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'comparison'}}
  ]});
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts:[bindLayout] });
  const shadowBindLayout = device.createBindGroupLayout({entries:[
    {binding:0,visibility:GPUShaderStage.VERTEX,buffer:{type:'uniform'}}]});
  const shadowPipelineLayout = device.createPipelineLayout({bindGroupLayouts:[shadowBindLayout]});
  const depthStencil = { format:'depth24plus', depthWriteEnabled:true, depthCompare:'less' };
  const solidPipeline = device.createRenderPipeline({ layout:pipelineLayout,
    vertex:{ module:shader, entryPoint:'solidVS', buffers:[{arrayStride:24,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'}, {shaderLocation:1,offset:12,format:'float32x3'}
    ]},instanceLayout]}, fragment:{module:shader,entryPoint:'solidFS',targets:[{format}]},
    primitive:{topology:'triangle-list',cullMode:'back'}, depthStencil, multisample:{count:sampleCount} });
  const linePipeline = device.createRenderPipeline({ layout:pipelineLayout,
    vertex:{ module:shader, entryPoint:'lineVS', buffers:[{arrayStride:24,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'}
    ]},instanceLayout]}, fragment:{module:shader,entryPoint:'lineFS',targets:[{format}]},
    primitive:{topology:'line-list'},
    depthStencil:{format:'depth24plus',depthWriteEnabled:false,depthCompare:'less-equal'},
    multisample:{count:sampleCount} });
  const shadowPipeline = shadowMapSize ? device.createRenderPipeline({ layout:shadowPipelineLayout,
    vertex:{module:shader,entryPoint:'shadowVS',buffers:[{arrayStride:24,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'}]},instanceLayout]},
    primitive:{topology:'triangle-list',cullMode:'back'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:2}
  }) : null;
  const gridPipeline = device.createRenderPipeline({ layout:pipelineLayout,
    vertex:{ module:shader, entryPoint:'gridVS', buffers:[{arrayStride:28,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'}, {shaderLocation:1,offset:12,format:'float32x4'}
    ]}]}, fragment:{module:shader,entryPoint:'gridFS',targets:[{format,blend:{
      color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},
      alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}
    }}]}, primitive:{topology:'line-list'},
    depthStencil:{format:'depth24plus',depthWriteEnabled:false,depthCompare:'less-equal'},
    multisample:{count:sampleCount} });
  const terrainPipeline = device.createRenderPipeline({ layout:pipelineLayout,
    vertex:{module:shader,entryPoint:'terrainVS',buffers:[{arrayStride:40,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
      {shaderLocation:7,offset:24,format:'float32x4'}]}]},
    fragment:{module:shader,entryPoint:'terrainFS',targets:[{format}]}, primitive:{topology:'triangle-list'},
    depthStencil, multisample:{count:sampleCount} });
  const terrainGhostPipeline = device.createRenderPipeline({ layout:pipelineLayout,
    vertex:{module:shader,entryPoint:'terrainVS',buffers:[{arrayStride:40,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
      {shaderLocation:7,offset:24,format:'float32x4'}]}]},
    fragment:{module:shader,entryPoint:'terrainGhostFS',targets:[{format,blend:{
      color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},
      alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]},
    primitive:{topology:'triangle-list'},
    depthStencil:{format:'depth24plus',depthWriteEnabled:false,depthCompare:'less-equal'},
    multisample:{count:sampleCount} });
  const waterPipeline = device.createRenderPipeline({ layout:pipelineLayout,
    vertex:{module:shader,entryPoint:'gridVS',buffers:[{arrayStride:28,attributes:[
      {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x4'}]}]},
    fragment:{module:shader,entryPoint:'gridFS',targets:[{format,blend:{
      color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},
      alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]},
    primitive:{topology:'triangle-list'},
    depthStencil:{format:'depth24plus',depthWriteEnabled:false,depthCompare:'less-equal'},
    multisample:{count:sampleCount} });
  const bindGroup = device.createBindGroup({ layout:bindLayout, entries:[
    {binding:0,resource:{buffer:cameraBuffer}},
    {binding:1,resource:shadowTexture.createView()},
    {binding:2,resource:shadowSampler}
  ]});
  const shadowBindGroup = device.createBindGroup({layout:shadowBindLayout,
    entries:[{binding:0,resource:{buffer:cameraBuffer}}]});
  device.queue.writeBuffer(cameraBuffer,64,lightViewProjection);

  let surface = 'shaded', cameraMode = 'orbit';
  let terrainMode = terrainVB
    ? (['ghost','solid','off'].includes(params.get('terrain')) ? params.get('terrain') : 'ghost')
    : 'off';
  let orbitYaw = -35 * Math.PI / 180, orbitPitch = -28 * Math.PI / 180;
  let orbitDistance = homeRadius * 2.45, orbitTarget = [...homeTarget];
  let flyPosition = add(homeTarget,[0,0,homeRadius * 2.45]), flyYaw = Math.PI, flyPitch = 0;
  let flySpeed = Math.max(5, homeRadius * .35), cameraScale = homeRadius, cameraFrame = 'home';
  let cameraFov = 42;
  const visible = new Set(manifest.drawGroups.map((group, index) => group.defaultVisible ? index : -1)
    .filter(index => index >= 0));
  const keys = new Set();
  let lastViewProjection = new Float32Array(16);
  let lastDrawCalls = 0;

  function forwardVector() {
    return [Math.sin(flyYaw)*Math.cos(flyPitch), Math.sin(flyPitch), Math.cos(flyYaw)*Math.cos(flyPitch)];
  }
  function orbitEye() {
    return add(orbitTarget, [
      Math.sin(orbitYaw)*Math.cos(orbitPitch)*orbitDistance,
      Math.sin(orbitPitch)*orbitDistance,
      Math.cos(orbitYaw)*Math.cos(orbitPitch)*orbitDistance
    ]);
  }
  function cameraMatrix() {
    const eye = cameraMode === 'fly' ? flyPosition : orbitEye();
    const target = cameraMode === 'fly' ? add(flyPosition, forwardVector()) : orbitTarget;
    const near = Math.max(.02, cameraScale * .0003);
    const far = Math.max(radius * 20, orbitDistance * 4, 100);
    return multiply4(perspective(cameraFov*Math.PI/180, canvas.width/canvas.height, near, far), lookAt(eye,target,[0,1,0]));
  }
  function render() {
    resize();
    lastViewProjection = cameraMatrix();
    device.queue.writeBuffer(cameraBuffer, 0, lastViewProjection);
    const encoder = device.createCommandEncoder();
    if(shadowPipeline){
      const shadowPass=encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{
        view:shadowTexture.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
      shadowPass.setPipeline(shadowPipeline);shadowPass.setBindGroup(0,shadowBindGroup);
      shadowPass.setVertexBuffer(1,instanceBuffer);
      for(let index=0;index<manifest.drawGroups.length;index++) if(visible.has(index)){
        const group=manifest.drawGroups[index],mesh=meshBuffers.get(group.primitiveKind || 'box');
        shadowPass.setVertexBuffer(0,mesh.vertexBuffer);shadowPass.setIndexBuffer(mesh.triangleBuffer,'uint16');
        shadowPass.drawIndexed(mesh.triangles.length,group.count,0,0,group.start);
      }
      shadowPass.end();
    }
    const swapView = context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({ colorAttachments:[{
      view:multisampleTexture?.createView() || swapView,
      resolveTarget:multisampleTexture ? swapView : undefined,
      clearValue:{r:.028,g:.04,b:.052,a:1},
      loadOp:'clear', storeOp:'store'
    }], depthStencilAttachment:{view:depthTexture.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'} });
    pass.setBindGroup(0,bindGroup);
    let draws=0;
    if(terrainVB && terrainMode!=='off'){
      pass.setPipeline(terrainMode==='solid' ? terrainPipeline : terrainGhostPipeline);
      pass.setVertexBuffer(0,terrainVB);pass.setIndexBuffer(terrainIB,'uint32');
      pass.drawIndexed(terrainIndexCount);draws++;
      if(terrainMode==='solid'){
        pass.setPipeline(waterPipeline);pass.setVertexBuffer(0,waterVB);pass.setIndexBuffer(waterIB,'uint16');
        pass.drawIndexed(6);draws++;
      }
    }else{
      pass.setPipeline(gridPipeline);pass.setVertexBuffer(0,gridVB);pass.draw(grid.values.length / 7);draws++;
    }
    const wire = surface === 'wire';
    pass.setVertexBuffer(1,instanceBuffer);
    for(let index=0;index<manifest.drawGroups.length;index++) if(visible.has(index)){
      const group=manifest.drawGroups[index],mesh=meshBuffers.get(group.primitiveKind || 'box');
      if(!wire){
        pass.setPipeline(solidPipeline);pass.setVertexBuffer(0,mesh.vertexBuffer);
        pass.setIndexBuffer(mesh.triangleBuffer,'uint16');
        pass.drawIndexed(mesh.triangles.length,group.count,0,0,group.start);draws++;
      }
      if(wire || manifest.lod?.cadEdges !== false){
        pass.setPipeline(linePipeline);pass.setVertexBuffer(0,mesh.vertexBuffer);
        pass.setIndexBuffer(mesh.lineBuffer,'uint16');
        pass.drawIndexed(mesh.lines.length,group.count,0,0,group.start);draws++;
      }
    }
    pass.end(); device.queue.submit([encoder.finish()]);
    lastDrawCalls = draws;
  }

  async function captureImage() {
    render();
    await device.queue.onSubmittedWorkDone();
    await frame();
    const blob = await new Promise((resolve,reject) => canvas.toBlob(value =>
      value ? resolve(value) : reject(new Error('The GPU canvas could not be encoded as PNG.')), 'image/png'));
    return blob;
  }

  let savingImage = false;
  async function saveImage() {
    if (savingImage) return null;
    const button = document.getElementById('save-image');
    savingImage = true; button.disabled = true; button.textContent = 'Rendering...';
    try {
      const blob = await captureImage();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `steward-build-${manifest.snapshotId}-${manifest.pieces}-${surface}-${terrainMode}.png`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      document.getElementById('image-help').textContent =
        `${fmtBytes(blob.size)} PNG | current ${surface}, ${terrainMode} terrain view saved`;
      statusNode.textContent = `PNG READY | ${fmt(manifest.pieces)} PIECES | ${canvas.width} x ${canvas.height}`;
      publish({ imageBytes:blob.size, imageType:blob.type, imageCanvas:[canvas.width,canvas.height] });
      return { bytes:blob.size, type:blob.type, width:canvas.width, height:canvas.height };
    } finally {
      savingImage = false; button.disabled = false; button.textContent = 'Save PNG';
    }
  }

  function setSurface(value) {
    surface = value === 'wire' ? 'wire' : 'shaded';
    document.querySelectorAll('[data-surface]').forEach(button =>
      button.setAttribute('aria-pressed', String(button.dataset.surface === surface)));
    render(); publish({ surface, drawCalls:lastDrawCalls, visibleGroups:visible.size });
  }
  function setTerrainMode(value) {
    terrainMode = terrainVB && ['ghost','solid','off'].includes(value) ? value : 'off';
    document.querySelectorAll('[data-terrain]').forEach(button => {
      button.disabled = !terrainVB;
      button.setAttribute('aria-pressed',String(button.dataset.terrain === terrainMode));
    });
    document.getElementById('terrain-controls-section').hidden = !terrainVB;
    document.getElementById('metric-terrain').textContent = terrainVB
      ? `${manifest.terrain.spacingM.toFixed(1)} m · ${titleCase(manifest.terrain.provenance)} · ${titleCase(terrainMode)}`
      : 'Grid fallback';
    render(); publish({ terrainMode, drawCalls:lastDrawCalls, visibleGroups:visible.size });
    return terrainMode;
  }
  function setCameraMode(value, requestLock = false) {
    value = value === 'fly' ? 'fly' : 'orbit';
    if (value === cameraMode) {
      if (value === 'fly' && requestLock) canvas.requestPointerLock?.();
      return;
    }
    if (value === 'fly') {
      flyPosition = orbitEye();
      const direction = norm(sub(orbitTarget, flyPosition));
      flyYaw = Math.atan2(direction[0], direction[2]);
      flyPitch = Math.asin(Math.max(-1,Math.min(1,direction[1])));
    } else {
      const direction = forwardVector();
      orbitDistance = Math.max(radius * .3, Math.min(radius * 5, orbitDistance));
      orbitTarget = add(flyPosition, scale(direction, orbitDistance));
      orbitYaw = Math.atan2(-direction[0], -direction[2]);
      orbitPitch = Math.asin(Math.max(-1,Math.min(1,-direction[1])));
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
    cameraMode = value;
    keys.clear();
    document.querySelectorAll('[data-camera]').forEach(button =>
      button.setAttribute('aria-pressed', String(button.dataset.camera === cameraMode)));
    updateCameraHelp(); render(); publish({ cameraMode });
    if (cameraMode === 'fly' && requestLock) canvas.requestPointerLock?.();
  }
  function frameCamera(target, frameRadius, frameName) {
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    cameraMode = 'orbit'; orbitYaw = -35*Math.PI/180; orbitPitch = -28*Math.PI/180;
    keys.clear();
    cameraScale = Math.max(frameRadius, 1); cameraFrame = frameName; cameraFov = 42;
    orbitDistance = cameraScale * 2.45; orbitTarget = [...target];
    flySpeed = Math.max(5, cameraScale * .35);
    document.querySelectorAll('[data-camera]').forEach(button =>
      button.setAttribute('aria-pressed', String(button.dataset.camera === 'orbit')));
    updateCameraHelp(); render(); publish({ cameraMode, cameraFrame });
  }
  function resetCamera() { frameCamera(homeTarget,homeRadius,'home'); }
  function frameAll() { frameCamera([0,0,0],radius,'all'); }
  function setExactCamera(lens, aim, fov = 65) {
    const origin = manifest.rndCameraOrigin;
    if (!Array.isArray(origin) || origin.length !== 3) return false;
    const local = value => [-(value[0]-origin[0]),value[1]-origin[1],value[2]-origin[2]];
    flyPosition = local(lens);
    const direction = norm(sub(local(aim),flyPosition));
    flyYaw = Math.atan2(direction[0],direction[2]);
    flyPitch = Math.asin(Math.max(-1,Math.min(1,direction[1])));
    cameraMode = 'fly'; cameraFrame = 'gallery-exact'; cameraFov = Math.max(20,Math.min(100,Number(fov) || 65));
    cameraScale = Math.max(homeRadius,1); flySpeed = Math.max(5,homeRadius*.35); keys.clear();
    document.querySelectorAll('[data-camera]').forEach(button =>
      button.setAttribute('aria-pressed', String(button.dataset.camera === 'fly')));
    updateCameraHelp(); render(); publish({ cameraMode, cameraFrame, cameraFov }); return true;
  }
  function updateCameraHelp() {
    const locked = document.pointerLockElement === canvas;
    document.getElementById('camera-help').textContent = cameraMode === 'orbit'
      ? `Left-drag orbit · right-drag pan · WASD move · Q/E elevation${clusteredHome ? ` · Home restores a dense ${fmt(manifest.home.pieces)}-piece cluster` : ''}`
      : locked ? 'Mouse look · WASD move · Q/E down/up · Shift boost · Escape releases mouse'
      : 'Click the view to capture the mouse · WASD + Q/E · Shift boost';
    document.getElementById('stage-hint').textContent = cameraMode === 'orbit'
      ? 'Left-drag orbit · right-drag pan · WASD move · Q/E elevation'
      : locked ? 'WASD + Q/E · Shift boost · Escape releases mouse' : 'Click to enter free-camera fly mode';
  }

  document.querySelectorAll('[data-surface]').forEach(button =>
    button.addEventListener('click', () => setSurface(button.dataset.surface)));
  document.querySelectorAll('[data-terrain]').forEach(button =>
    button.addEventListener('click', () => setTerrainMode(button.dataset.terrain)));
  document.querySelectorAll('[data-camera]').forEach(button =>
    button.addEventListener('click', () => setCameraMode(button.dataset.camera, button.dataset.camera === 'fly')));
  document.getElementById('frame-home').addEventListener('click', resetCamera);
  document.getElementById('frame-scene').addEventListener('click', frameAll);
  document.getElementById('save-image').addEventListener('click', () => saveImage().catch(error => {
    document.getElementById('image-help').textContent = error.message;
    statusNode.textContent = `PNG FAILED | ${error.message}`;
  }));

  // A picked camera becomes a shotplan row. The page sends the selection origin it was given
  // and the camera in scene-local terms; the server undoes the mirror, validates the pose
  // against the build's pieces, and appends the row to a ledger an operator shoots from.
  const requestSection = document.getElementById('request-section');
  const requestButton = document.getElementById('request-shot');
  const requestHelp = document.getElementById('request-help');
  const requestable = Array.isArray(manifest.rndCameraOrigin) && manifest.rndCameraOrigin.length === 3
    && params.get('era') && params.get('build');
  if (requestable) {
    requestSection.hidden = false; requestButton.disabled = false;
    requestButton.addEventListener('click', async () => {
      requestButton.disabled = true;
      try {
        const eye = cameraMode === 'fly' ? [...flyPosition] : orbitEye();
        const forward = cameraMode === 'fly' ? forwardVector() : norm(sub(orbitTarget, orbitEye()));
        const body = { era:params.get('era'), build:params.get('build'), snapshot:Number(params.get('snapshot')),
          origin:manifest.rndCameraOrigin, eye, forward, fov:cameraFov,
          note:document.getElementById('request-note').value, identify:false, website:'' };
        const response = await fetch(new URL('api/shot-request', APP_BASE), { method:'POST',
          headers:{ 'Content-Type':'application/json', Accept:'application/json' }, body:JSON.stringify(body) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || result.error || `Request failed (${response.status})`);
        requestHelp.textContent = `Requested as ${result.requestId}: lens ${result.lens.map(v => v.toFixed(1)).join(', ')} · `
          + `yaw ${result.yaw} · pitch ${result.pitch}. It will be shot in the next requests session.`;
        publish({ shotRequest:result.requestId });
      } catch (error) {
        requestHelp.textContent = error.message;
      } finally {
        requestButton.disabled = false;
      }
    });
  }
  document.getElementById('families-all').addEventListener('click', () => {
    manifest.drawGroups.forEach((_,index) => visible.add(index));
    document.querySelectorAll('#families input').forEach(input => { input.checked = true; });
    render(); publish({ drawCalls:lastDrawCalls, visibleGroups:visible.size });
  });

  const familyBox = document.getElementById('families');
  manifest.drawGroups.forEach((family,index) => {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.checked = family.defaultVisible;
    input.addEventListener('change', () => {
      input.checked ? visible.add(index) : visible.delete(index);
      render(); publish({ drawCalls:lastDrawCalls, visibleGroups:visible.size });
    });
    const swatch = document.createElement('i'); swatch.style.setProperty('--swatch',family.color);
    const name = document.createElement('span');
    name.textContent = family.confidence ? `${titleCase(family.name)} · ${titleCase(family.confidence)}` : titleCase(family.name);
    const count = document.createElement('small');
    count.textContent = family.count === family.pieces
      ? fmt(family.pieces) : `${fmt(family.pieces)} / ${fmt(family.count)}`;
    label.append(input,swatch,name,count); familyBox.appendChild(label);
  });

  let dragging = false, panning = false, lastX = 0, lastY = 0;
  stage.addEventListener('contextmenu', event => event.preventDefault());
  stage.addEventListener('pointerdown', event => {
    if (cameraMode === 'fly') {
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
      return;
    }
    dragging = true; panning = event.shiftKey || event.button === 1 || event.button === 2;
    lastX = event.clientX; lastY = event.clientY; stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (!dragging || cameraMode !== 'orbit') return;
    const dx = event.clientX - lastX, dy = event.clientY - lastY;
    lastX = event.clientX; lastY = event.clientY;
    if (panning) {
      const eye = orbitEye(), forward = norm(sub(orbitTarget,eye));
      const right = norm(cross(forward,[0,1,0])), up = norm(cross(right,forward));
      const amount = orbitDistance * .0015;
      orbitTarget = add(orbitTarget, add(scale(right,-dx*amount),scale(up,dy*amount)));
    } else {
      orbitYaw += dx * .006; orbitPitch += dy * .005;
      orbitPitch = Math.max(-Math.PI*.495,Math.min(Math.PI*.495,orbitPitch));
    }
    render();
  });
  const stopDrag = () => { dragging = false; };
  stage.addEventListener('pointerup', stopDrag); stage.addEventListener('pointercancel', stopDrag);
  stage.addEventListener('wheel', event => {
    event.preventDefault();
    if (cameraMode === 'orbit') {
      orbitDistance *= Math.exp(event.deltaY * .001);
      orbitDistance = Math.max(cameraScale * .03,Math.min(radius * 20,orbitDistance));
    } else {
      flyPosition = add(flyPosition,scale(forwardVector(),-event.deltaY * flySpeed * .002));
    }
    render();
  },{passive:false});
  document.addEventListener('mousemove', event => {
    if (cameraMode !== 'fly' || document.pointerLockElement !== canvas) return;
    flyYaw += event.movementX * .0022; flyPitch -= event.movementY * .0022;
    flyPitch = Math.max(-Math.PI*.495,Math.min(Math.PI*.495,flyPitch));
  });
  document.addEventListener('pointerlockchange', () => { updateCameraHelp(); publish({ pointerLocked:document.pointerLockElement === canvas }); });
  document.addEventListener('keydown', event => {
    if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    const key = event.key.toLowerCase();
    if (!MOVEMENT_KEYS.has(key)) return;
    keys.add(key); event.preventDefault();
  });
  document.addEventListener('keyup', event => keys.delete(event.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());
  new ResizeObserver(render).observe(stage);

  let previousFrame = performance.now();
  function animate(now) {
    const delta = Math.min(.05,(now - previousFrame) / 1000); previousFrame = now;
    if (keys.size) {
      const forward = cameraMode === 'fly'
        ? forwardVector()
        : norm([-Math.sin(orbitYaw),0,-Math.cos(orbitYaw)]);
      const right = norm(cross(forward,[0,1,0]));
      let move = [0,0,0];
      if (keys.has('w')) move = add(move,forward); if (keys.has('s')) move = sub(move,forward);
      if (keys.has('d')) move = add(move,right); if (keys.has('a')) move = sub(move,right);
      if (keys.has('e')) move[1] += 1; if (keys.has('q')) move[1] -= 1;
      if (Math.hypot(...move)) {
        const boost = keys.has('shift') ? 4 : 1;
        const speed = cameraMode === 'fly' ? flySpeed : Math.max(2,cameraScale*.25);
        const offset = scale(norm(move),speed*boost*delta);
        if (cameraMode === 'fly') flyPosition = add(flyPosition,offset);
        else orbitTarget = add(orbitTarget,offset);
        render();
      }
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  const worldwideBiome = params.get('scope') === 'world-biome' && manifest.scope.biomes.length > 0;
  document.getElementById('scene-title').textContent = worldwideBiome ? 'Worldwide biome build in 3D' : 'Build density in 3D';
  const biomeCopy = manifest.scope.biomes.length ? ` · ${manifest.scope.biomes.map(titleCase).join(' + ')}` : '';
  document.getElementById('scene-subtitle').textContent =
    `Snapshot #${manifest.snapshotId} · ${worldwideBiome ? 'worldwide biome scope' : 'exact selection'}${biomeCopy} · selection-local coordinates`;
  document.getElementById('metric-pieces').textContent = fmt(manifest.pieces);
  document.getElementById('metric-instances').textContent = fmt(manifest.renderInstances);
  document.getElementById('metric-dimensions').textContent = manifest.dimensionsM.map(value => `${fmt(value)} m`).join(' × ');
  document.getElementById('metric-bytes').textContent = fmtBytes(manifest.instanceBytes);
  document.getElementById('metric-lod').textContent = `${titleCase(manifest.lod?.name || 'legacy')} · ${sampleCount}× MSAA`;
  document.getElementById('metric-terrain').textContent = manifest.terrain?.available
    ? `${manifest.terrain.spacingM.toFixed(1)} m · ${titleCase(manifest.terrain.provenance)}` : 'Grid fallback';
  document.getElementById('metric-adapter').textContent = adapterInfo.description || adapterInfo.device || adapterInfo.vendor || adapterClass;
  const coverage = manifest.representationQuality;
  document.getElementById('quality-copy').textContent =
    `${fmt(coverage.measuredEnvelope)} measured envelope · ${fmt(coverage.runtimeCompoundProxy)} runtime compound proxy · ` +
    `${fmt(coverage.estimatedEnvelope)} estimated envelope · ${fmt(coverage.pivotMarker)} pivot marker${coverage.pivotMarker === 1 ? '' : 's'}. ` +
    `${fmt(coverage.hiddenContextPieces)} context piece${coverage.hiddenContextPieces === 1 ? '' : 's'} hidden by default.`;
  updateCameraHelp(); setSurface(params.get('surface') === 'wire' ? 'wire' : 'shaded');
  setTerrainMode(terrainMode); resetCamera();
  const exactLens = queryVector('cameraLens'), exactAim = queryVector('cameraAim');
  if (exactLens && exactAim) setExactCamera(exactLens, exactAim, Number(params.get('cameraFov')) || 65);
  await device.queue.onSubmittedWorkDone(); await frame(); await frame();
  const startup = performance.now() - PAGE_STARTED;
  const viewHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', lastViewProjection.buffer))]
    .map(value => value.toString(16).padStart(2,'0')).join('');
  document.documentElement.dataset.sceneReady = 'true';
  document.getElementById('save-image').disabled = false;
  statusNode.textContent = `${adapterClass.toUpperCase()} · ${startup.toFixed(1)} MS START · ${(manifest.lod?.name || 'legacy').toUpperCase()}`;
  publish({
    status:'ready', schema:'steward-scene-browser/v3', packageVersion:sceneVersion, pieces:manifest.pieces,
    renderInstances:manifest.renderInstances,
    triangles:manifest.triangles, exact:manifest.exact, forced:manifest.forced,
    presentationVariant:manifest.presentationVariant, rndCandidate:manifest.rndCandidate === true,
    instanceBytes:manifest.instanceBytes, instanceStride:manifest.instanceStride,
    instanceSha256:manifest.instanceSha256, adapter:adapterInfo,
    adapterClassification:adapterClass, features:[...adapter.features].sort(),
    canvas:[canvas.width,canvas.height], startupMs:+startup.toFixed(2),
    drawCalls:lastDrawCalls, visibleGroups:visible.size, surface, terrainMode, cameraMode, pointerLocked:false,
    cameraFrame, fullRadiusM:radius, home:manifest.home,
    viewMatrixSha256:viewHash, representationQuality:coverage, lod:manifest.lod, terrain:manifest.terrain,
    drawGroups:manifest.drawGroups.map(group => ({name:group.name, pieces:group.pieces,
      instances:group.count, defaultVisible:group.defaultVisible, primitiveKind:group.primitiveKind,
      confidence:group.confidence, surfaceClass:group.surfaceClass})),
    scopeKind:worldwideBiome ? 'world-biome' : 'area'
  });

  async function benchmark(frameCount = manifest.benchmarkFrames || 300) {
    const intervals = [], submits = [];
    let previous = performance.now();
    for (let i = 0; i < (manifest.warmupFrames || 30); i++) {
      if (cameraMode === 'orbit') orbitYaw += .006; render(); await frame(); previous = performance.now();
    }
    for (let i = 0; i < frameCount; i++) {
      const submitted = performance.now();
      if (cameraMode === 'orbit') orbitYaw += .006;
      render(); submits.push(performance.now() - submitted);
      await frame(); const now = performance.now(); intervals.push(now - previous); previous = now;
    }
    await device.queue.onSubmittedWorkDone();
    const metrics = {
      status:'ok', samples:intervals.length,
      frameP50Ms:+percentile(intervals,.5).toFixed(2),
      frameP95Ms:+percentile(intervals,.95).toFixed(2),
      frameMaxMs:+Math.max(...intervals).toFixed(2),
      submitP95Ms:+percentile(submits,.95).toFixed(3)
    };
    statusNode.textContent = `${adapterClass.toUpperCase()} · ${metrics.frameP95Ms.toFixed(2)} MS P95 · ${fmt(manifest.pieces)} PIECES`;
    publish(metrics); return window.__stewardSceneReceipt;
  }
  function cameraState() {
    return {
      mode:cameraMode, frame:cameraFrame, target:[...orbitTarget], eye:[...orbitEye()],
      flyPosition:[...flyPosition], yaw:cameraMode === 'fly' ? flyYaw : orbitYaw,
      pitch:cameraMode === 'fly' ? flyPitch : orbitPitch
    };
  }
  function setGroupVisible(name, shown) {
    const index = manifest.drawGroups.findIndex(group => group.name === name);
    if (index < 0) return false;
    shown ? visible.add(index) : visible.delete(index);
    const input = document.querySelectorAll('#families input')[index];
    if (input) input.checked = shown;
    render(); publish({ drawCalls:lastDrawCalls, visibleGroups:visible.size }); return true;
  }
  function setOnlyGroup(name) {
    const index = manifest.drawGroups.findIndex(group => group.name === name);
    if (index < 0) return false;
    visible.clear(); visible.add(index);
    document.querySelectorAll('#families input').forEach((input,item) => { input.checked = item === index; });
    render(); publish({ drawCalls:lastDrawCalls, visibleGroups:visible.size }); return true;
  }
  function restoreDefaultGroups() {
    visible.clear();
    manifest.drawGroups.forEach((group,index) => { if (group.defaultVisible) visible.add(index); });
    document.querySelectorAll('#families input').forEach((input,index) => {
      input.checked = manifest.drawGroups[index].defaultVisible;
    });
    render(); publish({ drawCalls:lastDrawCalls, visibleGroups:visible.size });
  }
  window.__stewardSceneControls = { render, benchmark, setSurface, setTerrainMode, setCameraMode, resetCamera,
    frameAll, captureImage, saveImage, cameraState, setGroupVisible, setOnlyGroup,
    restoreDefaultGroups, setExactCamera };
  if (params.get('benchmark') === '1') benchmark().catch(fail);
  else if (params.get('capture') === '1') saveImage().catch(error => {
    document.getElementById('image-help').textContent = error.message;
    statusNode.textContent = `PNG FAILED | ${error.message}`;
  });
}

main().catch(fail);
